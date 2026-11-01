// ---------- codex app-server 的 JSON-RPC 客户端 ----------
// 建在 JsonlProcess 上（进程、严格 LF 分帧、退出说明都在那里），这里只管 JSON-RPC 的配对：
// 我们发的请求按 id 等应答（带超时）；codex 发来的请求交给 onRequest，按返回值 / 抛错回 result / error；通知交给 onNotification。
// app-server 的消息不带 "jsonrpc" 字段，我们发出的也不带（与它自己的写法一致）。

import { JsonlProcess } from '../jsonl-process.js'
import type { ClientRequestMethod, ClientRequests, RequestId } from './protocol.js'

/** 普通请求的应答上限：app-server 的请求都是立刻应答的（回合本身靠通知收尾），挂这么久就是卡死了 */
export const REQUEST_TIMEOUT_MS = 60_000

/** codex 回的 error（或我们回给它的）：code 遵循 JSON-RPC */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

export class RpcTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`codex 的 ${method} 请求 ${Math.round(ms / 1000)} 秒没有应答`)
    this.name = 'RpcTimeoutError'
  }
}

/** codex 发来的请求。signal 在它撤回这条请求（serverRequest/resolved）或进程退出时 abort，之后的返回值不再发出 */
export type ServerRequestHandler = (method: string, params: unknown, signal: AbortSignal) => unknown

export type CodexRpcOptions = {
  /** agent id（只用于退出说明） */
  id: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  onRequest: ServerRequestHandler
  onNotification: (msg: { method: string; params: unknown }) => void
  /** 进程结束（stdio 全关之后；在飞请求此时已全部以 reason 失败）。crashed = 不是我们 kill 的 */
  onExit?: (info: { reason: string; crashed: boolean }) => void
}

type Waiting = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const isId = (v: unknown): v is RequestId => typeof v === 'string' || typeof v === 'number'
/** 请求 id 可能是数字也可能是字符串，Map 的键统一成带类型前缀的串，免得 1 与 "1" 撞在一起 */
const keyOf = (id: RequestId): string => `${typeof id}:${id}`

export class CodexRpc {
  private readonly proc: JsonlProcess
  private nextId = 1
  private readonly waiting = new Map<number, Waiting>()
  /** codex 发来、还没应答的请求 → 撤回用的 abort */
  private readonly serving = new Map<string, AbortController>()
  private exitReason: string | null = null
  /** 进程结束（stdio 关闭）时 resolve */
  readonly done: Promise<void>

  constructor(private readonly opts: CodexRpcOptions) {
    this.proc = new JsonlProcess({
      id: opts.id,
      kind: 'codex app-server',
      command: opts.command,
      args: opts.args,
      env: opts.env,
      cwd: opts.cwd,
      onMessage: (msg) => this.onMessage(msg),
      onExit: ({ crashed, reason }) => this.onExit(reason, crashed),
    })
    this.done = this.proc.done
  }

  /** 进程还在、没被 kill */
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

  /** 发一个请求等应答。codex 回 error → RpcError；超时 → RpcTimeoutError（迟到的应答丢掉）；进程没了 → 带退出说明的 Error */
  request<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequests[M]['params'],
    opts: { timeoutMs?: number } = {},
  ): Promise<ClientRequests[M]['result']> {
    return this.call(method, params, opts.timeoutMs) as Promise<ClientRequests[M]['result']>
  }

  /** 不带类型的请求（协议里没裁进来的方法） */
  call(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.exitReason !== null) return Promise.reject(new Error(this.exitReason))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new RpcTimeoutError(method, timeoutMs))
      }, timeoutMs)
      this.waiting.set(id, { resolve, reject, timer })
      if (!this.proc.send({ id, method, params })) {
        clearTimeout(timer)
        this.waiting.delete(id)
        reject(new Error(this.proc.describeExit()))
      }
    })
  }

  /** 发一个通知（不等应答）。进程没了返回 false */
  notify(method: string, params?: unknown): boolean {
    return this.proc.send(params === undefined ? { method } : { method, params })
  }

  /** 主动结束：之后的退出不算崩溃 */
  kill(): void {
    this.proc.kill()
  }

  private onMessage(msg: unknown): void {
    if (!isRec(msg)) return
    const { id, method } = msg
    if (typeof method === 'string') {
      if (isId(id)) return void this.serve(id, method, msg.params)
      if (method === 'serverRequest/resolved' && isRec(msg.params) && isId(msg.params.requestId)) {
        this.withdraw(msg.params.requestId)
      }
      return this.opts.onNotification({ method, params: msg.params })
    }
    // 应答：只认我们发出的数字 id
    if (typeof id !== 'number') return
    const w = this.waiting.get(id)
    if (!w) return
    this.waiting.delete(id)
    clearTimeout(w.timer)
    if (isRec(msg.error)) {
      const e = msg.error
      w.reject(new RpcError(typeof e.code === 'number' ? e.code : -32603, typeof e.message === 'string' ? e.message : 'codex 返回了错误', e.data))
    } else {
      w.resolve(msg.result)
    }
  }

  private serve(id: RequestId, method: string, params: unknown): void {
    const key = keyOf(id)
    const ac = new AbortController()
    this.serving.set(key, ac)
    const answer = (body: { result: unknown } | { error: { code: number; message: string; data?: unknown } }): void => {
      // 撤回 / 进程退出之后才算出来的结果不再发：codex 已经不等它了
      if (this.serving.get(key) !== ac) return
      this.serving.delete(key)
      this.proc.send({ id, ...body })
    }
    Promise.resolve()
      .then(() => this.opts.onRequest(method, params, ac.signal))
      .then(
        (result) => answer({ result: result ?? null }),
        (err: unknown) => {
          const e = err instanceof RpcError ? err : null
          const message = err instanceof Error ? err.message : String(err)
          answer({ error: { code: e?.code ?? -32603, message, ...(e?.data !== undefined ? { data: e.data } : {}) } })
        },
      )
  }

  /** codex 撤回了一条它发来的请求（或我们答过之后的确认）：处理函数的 signal 置 abort，之后的返回值不发 */
  private withdraw(id: RequestId): void {
    const key = keyOf(id)
    const ac = this.serving.get(key)
    if (!ac) return
    this.serving.delete(key)
    ac.abort()
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
    this.opts.onExit?.({ reason, crashed })
  }
}
