// ---------- pi / omp 的 RPC 客户端（`--mode rpc` / `--mode rpc-ui`） ----------
// 建在 JsonlProcess 上（进程、严格 LF 分帧、退出说明都在那里），这里只管 pi 系的帧：
//   - 命令按我们生成的 id 等应答（带超时）；应答可能乱序，只认 id。
//   - 扩展 UI 的对话框请求交给 onUiDialog，按返回值回 extension_ui_response；展示类请求交给 onUiNotice。
//   - omp：启动先等 ready 帧；协商 v2 后超大帧走 rpc_chunk，在这里拼回一条再分派；宿主工具调用交给 onHostTool。
//   - 其余一律是会话事件，交给 onEvent。
// 这不是 JSON-RPC：没有 jsonrpc / method / params，命令是 {id, type, …参数}。

import { JsonlProcess } from '../jsonl-process.js'
import type {
  ChunkFrame,
  HostToolCall,
  HostToolResult,
  PiCommands,
  PiCommandType,
  PiDialect,
  PiEvent,
  ReadyFrame,
  UiAnswer,
  UiDialogRequest,
  UiNoticeRequest,
} from './protocol.js'
import { UI_DIALOG_METHODS } from './protocol.js'

/** 普通命令的应答上限：除了 abort（要等会话停下来）都是当场应答的，挂这么久就是卡死了 */
export const COMMAND_TIMEOUT_MS = 60_000
/** omp 冷启动到发出 ready 帧的上限（实测约 2.5s，bun 首次加载原生模块会更久） */
export const READY_TIMEOUT_MS = 60_000
/** ready 帧没说时的分块重组上限（omp 文档的缺省值） */
const DEFAULT_REASSEMBLED_BYTES = 64 * 1024 * 1024

/** CLI 回了 success:false：message 是它的 error 原文，code 是 omp 的机器可读码（session_busy 等） */
export class PiRpcError extends Error {
  constructor(
    readonly command: string,
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'PiRpcError'
  }
}

export class PiRpcTimeoutError extends Error {
  constructor(command: string, ms: number) {
    super(`${command} 命令 ${Math.round(ms / 1000)} 秒没有应答`)
    this.name = 'PiRpcTimeoutError'
  }
}

/** 对话框请求。返回 null = 关掉（回 cancelled）。signal 在 CLI 撤回它（omp 的 cancel、pi 的 timeout 到期）或进程退出时 abort，
 *  之后的返回值不再发出 */
export type UiDialogHandler = (req: UiDialogRequest, signal: AbortSignal) => UiAnswer | null | Promise<UiAnswer | null>

/** omp 的宿主工具调用。抛错 = 工具失败（错误文字作为结果，isError）；progress 发中间结果。signal 在 host_tool_cancel / 进程退出时 abort */
export type HostToolHandler = (call: HostToolCall, signal: AbortSignal, progress: (partial: HostToolResult) => void) => Promise<HostToolResult>

export type PiRpcOptions = {
  /** agent id（只用于退出说明） */
  id: string
  dialect: PiDialect
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  onEvent: (ev: PiEvent) => void
  onUiDialog: UiDialogHandler
  onUiNotice?: (req: UiNoticeRequest) => void
  onHostTool?: HostToolHandler
  /** 协议层面的异常（没有 id 的失败应答、分块帧不合规、宿主工具没人接）。只用于日志，不影响进程 */
  onProtocolError?: (message: string) => void
  /** 进程结束（stdio 全关之后；在飞命令此时已全部以 reason 失败）。crashed = 不是我们 kill 的 */
  onExit?: (info: { reason: string; crashed: boolean }) => void
}

type Waiting = { command: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
type Chunking = { chunkId: string; count: number; byteLength: number; next: number; size: number; parts: Buffer[] }

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const utf8 = new TextDecoder('utf-8', { fatal: true })

export class PiRpc {
  private readonly proc: JsonlProcess
  private nextId = 1
  private readonly waiting = new Map<string, Waiting>()
  /** CLI 发来、还没应答的对话框 / 宿主工具调用 → 撤回用的 abort */
  private readonly serving = new Map<string, AbortController>()
  private exitReason: string | null = null
  private readyFrame: ReadyFrame | null = null
  private readonly readyWaiters: Array<{ resolve: (f: ReadyFrame) => void; reject: (e: Error) => void }> = []
  private chunking: Chunking | null = null
  private v2 = false
  /** 进程结束（stdio 关闭）时 resolve */
  readonly done: Promise<void>

  constructor(private readonly opts: PiRpcOptions) {
    this.proc = new JsonlProcess({
      id: opts.id,
      kind: `${opts.dialect} rpc`,
      command: opts.command,
      args: opts.args,
      env: opts.env,
      cwd: opts.cwd,
      onMessage: (msg) => this.onFrame(msg),
      onExit: ({ crashed, reason }) => this.onExit(reason, crashed),
    })
    this.done = this.proc.done
  }

  get alive(): boolean {
    return this.proc.alive
  }

  get pid(): number | undefined {
    return this.proc.pid
  }

  /** 进程没了的原因（还活着时是 null） */
  get exited(): string | null {
    return this.exitReason
  }

  /** 已协商到 v2 分块帧 */
  get chunked(): boolean {
    return this.v2
  }

  /** omp：等启动的 ready 帧（超时 / 进程退出 → reject）；pi 没有 ready 帧，直接给 null，就绪与否由调用方发 get_state 判断 */
  ready(timeoutMs = READY_TIMEOUT_MS): Promise<ReadyFrame | null> {
    if (this.opts.dialect === 'pi') return Promise.resolve(null)
    if (this.readyFrame) return Promise.resolve(this.readyFrame)
    if (this.exitReason !== null) return Promise.reject(new Error(this.exitReason))
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (f: ReadyFrame) => {
          clearTimeout(timer)
          resolve(f)
        },
        reject: (e: Error) => {
          clearTimeout(timer)
          reject(e)
        },
      }
      const timer = setTimeout(() => {
        const i = this.readyWaiters.indexOf(waiter)
        if (i >= 0) this.readyWaiters.splice(i, 1)
        reject(new Error(`${this.opts.id} ${Math.round(timeoutMs / 1000)} 秒内没有发出 ready 帧`))
      }, timeoutMs)
      this.readyWaiters.push(waiter)
    })
  }

  /** omp：ready 帧声明支持 v2 就协商（之后超大帧不再被截断）。不支持 / 协商失败返回 false，照 v1 继续 */
  async negotiate(): Promise<boolean> {
    const frame = await this.ready()
    if (!frame?.supportedProtocolVersions?.includes(2)) return false
    try {
      const r = await this.request('negotiate_protocol', { protocolVersion: 2 })
      this.v2 = r.protocolVersion === 2
    } catch {
      this.v2 = false
    }
    return this.v2
  }

  /** 发一条命令等应答。success:false → PiRpcError；超时 → PiRpcTimeoutError（迟到的应答丢掉）；进程没了 → 带退出说明的 Error */
  request<C extends PiCommandType>(type: C, params: PiCommands[C]['params'], opts: { timeoutMs?: number } = {}): Promise<PiCommands[C]['data']> {
    return this.call(type, params, opts.timeoutMs) as Promise<PiCommands[C]['data']>
  }

  /** 不带类型的命令（协议里没裁进来的） */
  call(type: string, params: object = {}, timeoutMs = COMMAND_TIMEOUT_MS): Promise<unknown> {
    if (this.exitReason !== null) return Promise.reject(new Error(this.exitReason))
    const id = `r${this.nextId++}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new PiRpcTimeoutError(type, timeoutMs))
      }, timeoutMs)
      this.waiting.set(id, { command: type, resolve, reject, timer })
      if (!this.proc.send({ ...params, id, type })) {
        clearTimeout(timer)
        this.waiting.delete(id)
        reject(new Error(this.proc.describeExit()))
      }
    })
  }

  /** 写一条原样的帧（不等应答）。进程没了返回 false */
  send(frame: object): boolean {
    return this.proc.send(frame)
  }

  /** 主动结束：之后的退出不算崩溃 */
  kill(): void {
    this.proc.kill()
  }

  // ---------- 收 ----------

  private onFrame(msg: unknown): void {
    if (!isRec(msg)) return
    if (msg.type === 'rpc_chunk') return this.onChunk(msg as unknown as ChunkFrame)
    if (this.chunking) {
      // 分块序列必须连续：中间插进别的帧说明序列断了，丢掉已收的部分
      this.protocolError(`分块帧 ${this.chunking.chunkId} 被打断（收到 ${String(msg.type)}）`)
      this.chunking = null
    }
    this.dispatch(msg)
  }

  private dispatch(msg: Rec): void {
    switch (msg.type) {
      case 'ready':
        return this.onReady(msg as unknown as ReadyFrame)
      case 'response':
        return this.onResponse(msg)
      case 'extension_ui_request':
        return this.onUiRequest(msg)
      case 'host_tool_call':
        return this.onHostToolCall(msg as unknown as HostToolCall)
      case 'host_tool_cancel':
        return this.withdraw(typeof msg.targetId === 'string' ? `host:${msg.targetId}` : '')
      default:
        if (typeof msg.type === 'string') this.opts.onEvent(msg as unknown as PiEvent)
    }
  }

  private onReady(frame: ReadyFrame): void {
    if (this.readyFrame) return
    this.readyFrame = frame
    for (const w of this.readyWaiters.splice(0)) w.resolve(frame)
  }

  private onResponse(msg: Rec): void {
    const id = typeof msg.id === 'string' ? msg.id : undefined
    const w = id === undefined ? undefined : this.waiting.get(id)
    if (!w || id === undefined) {
      // 没有 id 的失败（parse 错误等）或迟到 / 重复的应答：命令方已经不等了，只留日志
      if (msg.success === false) this.protocolError(`${String(msg.command)}: ${String(msg.error)}`)
      return
    }
    this.waiting.delete(id)
    clearTimeout(w.timer)
    if (msg.success === true) return w.resolve(msg.data)
    const message = typeof msg.error === 'string' && msg.error ? msg.error : `${w.command} 失败`
    w.reject(new PiRpcError(w.command, message, typeof msg.code === 'string' ? msg.code : undefined))
  }

  private onUiRequest(msg: Rec): void {
    const id = typeof msg.id === 'string' ? msg.id : ''
    const method = typeof msg.method === 'string' ? msg.method : ''
    if (method === 'cancel') return this.withdraw(typeof msg.targetId === 'string' ? `ui:${msg.targetId}` : '')
    if (!UI_DIALOG_METHODS.has(method)) return this.opts.onUiNotice?.(msg as unknown as UiNoticeRequest)
    if (!id) return
    const req = msg as unknown as UiDialogRequest
    const key = `ui:${id}`
    const ac = this.track(key)
    // pi 的对话框到期由它自己按默认值了结，但不通知我们：照它给的时长自己撤回，免得审批卡一直挂着
    const timeout = 'timeout' in req && typeof req.timeout === 'number' && req.timeout > 0 ? req.timeout : undefined
    const timer = this.opts.dialect === 'pi' && timeout !== undefined ? setTimeout(() => this.withdraw(key), timeout) : undefined
    Promise.resolve()
      .then(() => this.opts.onUiDialog(req, ac.signal))
      .catch((err: unknown) => {
        this.protocolError(`扩展 UI 请求 ${method} 处理失败：${err instanceof Error ? err.message : String(err)}`)
        return null
      })
      .then((answer) => {
        if (timer) clearTimeout(timer)
        if (!this.settle(key, ac)) return
        this.proc.send({ type: 'extension_ui_response', id, ...(answer ?? { cancelled: true }) })
      })
  }

  private onHostToolCall(call: HostToolCall): void {
    const key = `host:${call.id}`
    const ac = this.track(key)
    const handler = this.opts.onHostTool
    const progress = (partialResult: HostToolResult): void => {
      if (this.serving.get(key) === ac) this.proc.send({ type: 'host_tool_update', id: call.id, partialResult })
    }
    Promise.resolve()
      .then(() => {
        if (!handler) throw new Error(`没有宿主工具 ${call.toolName}`)
        return handler(call, ac.signal, progress)
      })
      .then(
        (result) => ({ result, isError: false }),
        (err: unknown) => ({ result: { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }] }, isError: true }),
      )
      .then(({ result, isError }) => {
        if (!this.settle(key, ac)) return
        this.proc.send({ type: 'host_tool_result', id: call.id, result, ...(isError ? { isError: true } : {}) })
      })
  }

  private onChunk(c: ChunkFrame): void {
    const valid =
      typeof c.chunkId === 'string' && Number.isInteger(c.index) && Number.isInteger(c.count) && c.count > 0 && Number.isInteger(c.byteLength) && typeof c.data === 'string'
    if (!valid) return this.dropChunks('分块帧字段不合规')
    let cur = this.chunking
    if (!cur) {
      if (c.index !== 0) return this.dropChunks(`分块帧 ${c.chunkId} 不是从第 0 块开始`)
      const limit = this.readyFrame?.maxReassembledFrameBytes ?? DEFAULT_REASSEMBLED_BYTES
      if (c.byteLength > limit) return this.dropChunks(`分块帧 ${c.chunkId} 声明 ${c.byteLength} 字节，超过上限 ${limit}`)
      cur = { chunkId: c.chunkId, count: c.count, byteLength: c.byteLength, next: 0, size: 0, parts: [] }
      this.chunking = cur
    } else if (c.chunkId !== cur.chunkId || c.index !== cur.next || c.count !== cur.count || c.byteLength !== cur.byteLength) {
      return this.dropChunks(`分块帧 ${cur.chunkId} 被打断或乱序`)
    }
    const part = Buffer.from(c.data, 'base64')
    cur.size += part.length
    if (cur.size > cur.byteLength) return this.dropChunks(`分块帧 ${cur.chunkId} 超出声明的长度`)
    cur.parts.push(part)
    cur.next += 1
    if (cur.next < cur.count) return
    this.chunking = null
    if (cur.size !== cur.byteLength) return this.protocolError(`分块帧 ${cur.chunkId} 长度不符（${cur.size} / ${cur.byteLength}）`)
    let msg: unknown
    try {
      msg = JSON.parse(utf8.decode(Buffer.concat(cur.parts)))
    } catch (err) {
      return this.protocolError(`分块帧 ${cur.chunkId} 解不开：${err instanceof Error ? err.message : String(err)}`)
    }
    if (isRec(msg)) this.dispatch(msg)
  }

  private dropChunks(why: string): void {
    this.chunking = null
    this.protocolError(why)
  }

  // ---------- 对话框 / 宿主工具的在办表 ----------

  private track(key: string): AbortController {
    // 同一个 id 重复到达（不该发生）：旧的那个按撤回处理，免得两份答案
    this.withdraw(key)
    const ac = new AbortController()
    this.serving.set(key, ac)
    return ac
  }

  /** 还在办就摘掉并返回 true（可以应答）；已被撤回 / 进程没了返回 false */
  private settle(key: string, ac: AbortController): boolean {
    if (this.serving.get(key) !== ac) return false
    this.serving.delete(key)
    return true
  }

  private withdraw(key: string): void {
    const ac = this.serving.get(key)
    if (!ac) return
    this.serving.delete(key)
    ac.abort()
  }

  private protocolError(message: string): void {
    this.opts.onProtocolError?.(message)
  }

  private onExit(reason: string, crashed: boolean): void {
    this.exitReason = reason
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer)
      w.reject(new Error(reason))
    }
    this.waiting.clear()
    for (const ac of this.serving.values()) ac.abort()
    this.serving.clear()
    for (const w of this.readyWaiters.splice(0)) w.reject(new Error(reason))
    this.chunking = null
    this.opts.onExit?.({ reason, crashed })
  }
}
