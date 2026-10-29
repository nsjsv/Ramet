// ---------- ACP 客户端适配器 ----------
// 用官方 @agentclientprotocol/sdk 的 client() app：spawn 子进程、initialize、session/new|load、prompt、cancel。
// 不用已废弃的 ClientSideConnection：它不把请求级 signal 交给处理函数，agent 用 $/cancel_request
// 撤回审批 / 提问时客户端既不知道也不应答，卡片永远挂着、进程永远 busy。
// 三类要人点头的请求都映射成 permission 事件：
//   - session/request_permission（claude 等主动请求）
//   - fs/write_text_file（omp 把客户端当权限闸门：不应答 = 挂起，拒绝 = 抛错）
//   - elicitation/create（form 模式的提问，带 form；见 ask-form.ts）
// available_commands_update → commands 事件。
// 坑：claude 的错误先推文本 chunk 再回 JSON-RPC error，错误文案去重由 Manager 做，这里不攒文本；
// 冷启动 20-50s，initialize 超时给足 120s。

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import {
  client,
  PROTOCOL_VERSION,
  ndJsonStream,
  RequestError,
  type ClientApp,
  type ClientConnection,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type LoadSessionRequest,
  type NewSessionRequest,
  type PromptRequest,
  type ReadTextFileRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type Stream,
  type ToolCallContent,
  type Usage,
  type WriteTextFileRequest,
} from '@agentclientprotocol/sdk'
import { AcpTerminals, TerminalError } from './acp-terminals.js'
import { ASK_OPTIONS, normalizeAskForm } from './ask-form.js'
import { chunkParent, toolFace } from './tool-attribution.js'
import { pageToolServer, type AcpMcpServer, type PageTool } from '../page-read.js'
import type {
  AgentAdapter,
  AgentCommand,
  AskContent,
  AgentEvent,
  AgentConfig,
  ConfigOption,
  ConfigOptionValue,
  PermissionEvent,
  PermissionOption,
  PromptBlock,
  PromptResult,
  SessionState,
  StepKind,
  StepStatus,
  TurnUsage,
} from './types.js'
import { normalizePlan, type RunInfo } from '@ramet/shared/run-model'

const INITIALIZE_TIMEOUT_MS = 120_000
/** 受限会话（随手 AI）里 agent 向客户端要读写文件 / 开终端时回的话 */
const RESTRICTED_MESSAGE = '这是随手 AI 的单次改写，不允许读写文件或运行命令'
/** 子进程 stderr 只留尾巴：stdout 是 NDJSON，不能混进去；整段也不该进红条 */
const STDERR_TAIL = 2_000
const EXIT_WAIT_MS = 300

export type AgentExit = { code: number | null; signal: NodeJS.Signals | null }

/** stdout 结束时 SDK 只抛这句。真正的原因是进程没了，退出码和 stderr 在适配器这边。 */
export function isAcpStreamClosed(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message === 'ACP connection closed' || message === 'ACP connection is closed'
}

export function describeAgentExit(id: string, exit: AgentExit | null, stderr: string): string {
  const why = !exit ? 'stdio 已关闭' : exit.signal ? `信号 ${exit.signal}` : `退出码 ${exit.code}`
  const tail = stderr.trim().split('\n').map((line) => line.trim()).filter(Boolean).slice(-6).join(' | ')
  const clipped = tail.length > 500 ? `…${tail.slice(-500)}` : tail
  return clipped ? `${id} 的 ACP 进程断了（${why}）：${clipped}` : `${id} 的 ACP 进程断了（${why}）`
}

/** SDK 的 RequestError 把 JSON-RPC 的 `data` 挂在 `.data` 上，真正的原因（omp 起 MCP 工具进程失败、
 *  脚本路径不存在等）就在那里。只回 `message`（对端往往就一句 "Internal error"）会让红条没有信息，
 *  所以两者拼成一句。connector 写日志也用它。 */
export function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  if (!('data' in err)) return err.message
  const data: unknown = err.data
  if (data === undefined) return err.message
  const detail = typeof data === 'string' ? data : JSON.stringify(data)
  return detail ? `${err.message}：${detail}` : err.message
}

/** 过程步骤 detail 上限：只收首个 location 路径，截断（完整路径入档页，长度上限由这里守） */
const STEP_DETAIL_MAX = 200
const STEP_KINDS: ReadonlySet<string> = new Set([
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other',
])
const STEP_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed', 'failed'])

/** ACP 字面量 → 窄化枚举：协议外的值落 'other' / 'pending'（SDK 类型只是编译期约束，
 * 运行时对端可能给任何字符串，前端不该因为一个未知 kind 渲染出空白） */
function stepKind(raw: string): StepKind {
  return (STEP_KINDS.has(raw) ? raw : 'other') as StepKind
}

function stepStatus(raw: string): StepStatus {
  return (STEP_STATUSES.has(raw) ? raw : 'pending') as StepStatus
}

function firstPath(locations: ReadonlyArray<{ path: string }> | null | undefined): string | undefined {
  const path = locations?.[0]?.path
  if (!path) return undefined
  return path.length > STEP_DETAIL_MAX ? path.slice(0, STEP_DETAIL_MAX) : path
}

/** 失败工具的一行摘要：输出里第一行非空文字 */
const STEP_NOTE_MAX = 120
function firstLine(content: ReadonlyArray<ToolCallContent> | null | undefined): string | undefined {
  for (const item of content ?? []) {
    if (item.type !== 'content' || item.content.type !== 'text') continue
    const line = item.content.text.split('\n').find((l) => l.trim())?.trim()
    if (line) return line.length > STEP_NOTE_MAX ? `${line.slice(0, STEP_NOTE_MAX)}…` : line
  }
  return undefined
}

/** PromptResponse.usage（UNSTABLE）→ TurnUsage；缺项不补 0（显式 0 保留） */
function turnUsage(raw: Usage | null | undefined): TurnUsage | undefined {
  if (!raw) return undefined
  return {
    total: raw.totalTokens,
    input: raw.inputTokens,
    output: raw.outputTokens,
    ...(raw.cachedReadTokens != null ? { cacheRead: raw.cachedReadTokens } : {}),
    ...(raw.cachedWriteTokens != null ? { cacheWrite: raw.cachedWriteTokens } : {}),
    ...(raw.thoughtTokens != null ? { thought: raw.thoughtTokens } : {}),
  }
}

/** 单个 acp 载荷 / 子代理正文的体积上限：超过就换成可见标记，绝不静默裁。
 *  输入是 ACP 解析后的 JSON（无环），序列化一次算长度、留预览 */
const ACP_VALUE_MAX = 1_000_000
const ACP_PREVIEW = 2_000

/** 原始工具载荷：去掉 sessionUpdate/toolCallId（id/type 已表达），其余字段（含 _meta/未知字段）原样 */
function rawAcp(update: Record<string, unknown>): Record<string, unknown> {
  const { sessionUpdate: _s, toolCallId: _t, ...rest } = update
  return rest
}

/** 超过上限就把值换成可见的截断标记（保留预览），返回该键是否被截断 */
function clipValue(value: unknown): { value: unknown; clipped: boolean } {
  const json = JSON.stringify(value)
  if (json === undefined || json.length <= ACP_VALUE_MAX) return { value, clipped: false }
  return { value: { truncated: true, chars: json.length, preview: json.slice(0, ACP_PREVIEW) }, clipped: true }
}

/** 逐键限长，只标记，不求漂亮 */
function clipAcp(acp: Record<string, unknown>): { acp: Record<string, unknown>; truncated: boolean } {
  let truncated = false
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(acp)) {
    const { value, clipped } = clipValue(v)
    out[k] = value
    if (clipped) truncated = true
  }
  return { acp: out, truncated }
}

/** 其他 session update → info.acp[key]（key = sessionUpdate）。
 *  文本 chunk 只去掉正文 body 与冗余 type（正文已进 output/thought，不重复）；其余字段原样保留 ——
 *  包括 messageId/_meta/annotations、任意 rest 字段以及未来的未知字段，不做白名单过滤。
 *  非文本内容块（图片/音频/资源/resource_link）整块保留，且每块用独立 key（blockKey 分配），
 *  免得后到的更新覆盖已收到的那块。 */
function updateToInfo(update: SessionNotification['update'], blockKey: (base: string) => string): RunInfo {
  const base = update.sessionUpdate
  const { sessionUpdate: _s, ...rest } = update as Record<string, unknown>
  let key: string = base
  if (base === 'agent_message_chunk' || base === 'agent_thought_chunk' || base === 'user_message_chunk') {
    // 文本正文已进 output/thought：从 content 里剔掉 text 与 type，只留 annotations/_meta/非文本内容
    const content = rest.content
    if (content && typeof content === 'object' && !Array.isArray(content)) {
      const block = content as Record<string, unknown>
      if (block.type === 'text' && typeof block.text === 'string') {
        const { text: _t, type: _ty, ...meta } = block
        if (Object.keys(meta).length > 0) rest.content = meta
        else delete rest.content
      } else {
        // 非文本内容块：整块保留，用独立 key 记下每一块
        key = blockKey(base)
      }
    }
    // 纯正文、无任何附加字段 → 不发（否则每个 token 都发一条 info 并逼一次 flush）
    if (Object.keys(rest).length === 0) return {}
  }
  if (Object.keys(rest).length === 0) return {}
  const { acp, truncated } = clipAcp({ [key]: rest })
  return { acp, ...(truncated ? { truncated: true } : {}) }
}

/** 终端方法的出错口径：TerminalError 是 agent 的请求本身有问题 → JSON-RPC invalid params（带人话 message） */
async function termCall<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof TerminalError) throw RequestError.invalidParams(undefined, err.message)
    throw err
  }
}

function costOf(raw: unknown): { amount: number; currency: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const c = raw as { amount?: unknown; currency?: unknown }
  if (typeof c.amount !== 'number' || typeof c.currency !== 'string') return undefined
  return { amount: c.amount, currency: c.currency }
}

/** tool_call / tool_call_update → step.acp 增量：原始字段平铺（rawInput/rawOutput/content/locations/_meta
 *  等；sessionUpdate/toolCallId 由 id/type 表达）。平铺才能让缺省字段保持 —— 后到的 status-only
 *  更新不会把已到的 content/rawOutput 整块顶掉 */
function toolAcp(update: SessionNotification['update']): { acp: Record<string, unknown>; truncated: boolean } {
  return clipAcp(rawAcp(update as Record<string, unknown>))
}

/** 原始 PromptResponse 折成一条 info（connector 重放也保留；usage._meta 一并可查） */
function promptResponseInfo(res: {
  stopReason: string
  usage?: Usage | null
  _meta?: { [key: string]: unknown } | null
}): RunInfo {
  const { acp, truncated } = clipAcp({
    promptResponse: {
      stopReason: res.stopReason,
      ...(res.usage != null ? { usage: res.usage } : {}),
      ...(res._meta != null ? { _meta: res._meta } : {}),
    },
  })
  const usage = turnUsage(res.usage)
  return {
    ...(usage ? { usage } : {}),
    stopReason: res.stopReason,
    acp,
    ...(truncated ? { truncated: true } : {}),
  }
}

type PendingPermission = {
  /** 按选项结束这条请求（null = 取消）：协议应答 / fs 写闸门的落盘或拒绝 / 提问的答案都在这里。
   *  只在 resolvePending 里调用，别处不许直接碰 */
  settle: (optionId: string | null, content?: AskContent) => void
  event: PermissionEvent
  /** 提问到达时这个会话有在飞的 prompt：那一轮结束时还没答就按取消结束（提问不比所在的一轮活得久；
   *  omp 超时后不通知客户端，不收掉就永远挂着）。普通审批没有这个标记：后台审批本来就可以比一轮活得久 */
  turnOf?: string
}

/** 提问的应答：accept 带答案；跳过 = decline；null（停止该会话 / 换会话 / 进程退出 / agent 撤回）= cancel */
function askResponse(optionId: string | null, content: AskContent | undefined): CreateElicitationResponse {
  if (optionId === 'accept') return { action: 'accept', content: content ?? {} }
  return optionId === 'decline' ? { action: 'decline' } : { action: 'cancel' }
}

export class AcpAgent implements AgentAdapter {
  private proc: ChildProcess | null = null
  private conn: ClientConnection | null = null
  private emitter = new EventEmitter()
  private pending = new Map<string, PendingPermission>()
  private nextRequestId = 0
  /** 非文本内容块的 info.acp key 计数器（与审批 requestId 分开，语义不同） */
  private nextInfoKey = 0
  private dead = false
  /** sessionId → 当前 config options（set_config_option / config_option_update 后更新） */
  private sessionConfigs = new Map<string, ConfigOption[]>()
  /** sessionId → 原生斜杠命令（available_commands_update）。不论有没有监听者都缓存：命令在会话建立后
   *  才推，那时监听者（轮次 / 中心镜像）往往还没绑上，之后的 bind 用 sessionState() 补齐 */
  private sessionCommands = new Map<string, AgentCommand[]>()
  /** sessionId → 会话工作区（newSession / loadSession 的 cwd）：ACP 终端的 cwd 必须在它之内 */
  private sessionCwds = new Map<string, string>()
  /** agent 用 ACP 终端（terminal/*）跑的命令：跑在这个适配器所在的机器上，输出实时进这一轮的过程 */
  private terms = new AcpTerminals({
    emit: (ev) => this.emitter.emit('event', ev),
    sessionCwd: (sessionId) => this.sessionCwds.get(sessionId) ?? this.spawnCwd,
  })
  /** 随手 AI 的受限会话（newRestrictedSession）：agent 经 ACP 向我们要读文件 / 写文件 / 开终端一律拒绝，审批自动拒绝
   *  （不进 pending、不发事件）。会话级事件也不对外：knownSessions 不含它们，connector 的常驻监听据 isRestricted 跳过 */
  private restricted = new Set<string>()
  /** 在飞 prompt 的会话数（同一进程可承载多个会话）：闲置回收的唯一"忙"判据（见 types.AgentAdapter.busy） */
  private inFlight = 0
  /** agent 在 initialize 里声明能收图片（promptCapabilities.image）：不能收的，prompt 里的图片块在这里丢掉 */
  private promptImages = false
  /** sessionId → 该会话在飞的 prompt 数（提问的 turnOf 据此判定、归零时收掉） */
  private sessionPrompts = new Map<string, number>()
  /** 主动 kill 的不算崩溃 */
  private stopped = false
  private stderrTail = ''
  private exit: AgentExit | null = null
  private noteExit: (() => void) | null = null
  private exitWait: Promise<void> = new Promise((resolve) => {
    this.noteExit = resolve
  })
  /** 子进程是否还活着(死进程要重建,已 load 的 session 全部失效) */
  get alive(): boolean {
    return !this.dead && this.proc != null && this.conn != null
  }

  /** 有在飞 prompt 或有待批审批：审批期间进程不许被闲置回收（回收 = 审批永远答不到） */
  get busy(): boolean {
    return this.inFlight > 0 || this.pending.size > 0
  }

  /** spawnCwd = 子进程的工作目录。中心本机直 spawn 时用它的进程 cwd；
   * connector 侧必须显式传本机默认目录（否则继承 connector 进程 cwd，与上报的 defaultCwd 不符） */
  constructor(
    private cfg: AgentConfig,
    private spawnCwd?: string,
  ) {
    this.emitter.setMaxListeners(0)
  }

  /** 刚建出来、还没起过进程也没死过：第一次 ready() 才会 spawn。适配器池里这种对象不是僵尸，不能当成死的杀掉重建
   *  （并行的两个调用方先后 ensureAdapter、各自再去 newSession 之前有 await：第二个把第一个杀了，第一个就收到「agent 已停止」） */
  get pristine(): boolean {
    return !this.dead && this.proc == null
  }

  /** 正在握手的那一次：并行的第二个 ready() 要等同一次握手完成，而不是看到 conn 已经建出来就往下走（initialize 还没回） */
  private handshake: Promise<void> | null = null

  ready(): Promise<void> {
    if (this.conn && !this.handshake) return Promise.resolve()
    return (this.handshake ??= this.start().finally(() => {
      this.handshake = null
    }))
  }

  private async start(): Promise<void> {
    if (this.dead) throw new Error(`agent ${this.cfg.id} 已停止`)
    const proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      env: { ...process.env, ...this.cfg.env },
      cwd: this.spawnCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows：connector 作为后台服务跑时没有控制台，不藏的话每起一个 agent 弹一个黑窗（它的子孙继承这个隐藏控制台）
      windowsHide: true,
    })
    proc.on('exit', (code, signal) => {
      this.exit = { code, signal }
      this.noteExit?.()
      this.dead = true
      for (const requestId of [...this.pending.keys()]) this.resolvePending(requestId, null)
      this.terms.killAll() // agent 进程没了，它起的命令不该留着
      this.conn = null
      if (!this.stopped) console.error(`[acp] ${describeAgentExit(this.cfg.id, this.exit, this.stderrTail)}`)
    })
    this.proc = proc
    // stderr 不进 stdout（NDJSON 怕污染），但要留尾巴：进程一死，SDK 只说 ACP connection closed
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL)
    })

    const stream: Stream = ndJsonStream(
      Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
    )
    this.conn = this.clientApp().connect(stream)
    const init = this.conn.agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      // terminal: true = agent 的命令交给客户端跑（实时输出 + 可停止）。claude 适配器走自己的 _meta 通道，不受影响。
      // elicitation.form = 客户端能弹表单让人作答：claude 据此启用 AskUserQuestion，codex 的 request_user_input、
      // opencode 的 question、omp 的 ask / 计划审批 / 工具审批都走它（不声明时它们分别禁用 / 拿空答案 / 自动拒绝或放行）
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, elicitation: { form: {} } },
    })
    try {
      const res = await Promise.race([
        init,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`initialize 超时(${this.cfg.command})`)), INITIALIZE_TIMEOUT_MS),
        ),
      ])
      this.promptImages = res.agentCapabilities?.promptCapabilities?.image === true
    } catch (err) {
      // 握不上手说明这个适配器进程没用了：留着会变成 alive 的僵尸，后续每个请求都挂在同一个死的 initialize 上，
      // 直到 10 分钟闲置回收（一次超时后 claude 会一直没有模型 / 思考，即便进程后来已经准备好）。
      // 清干净让下一次 ready() 重新 spawn。先解释再 kill：kill 会改退出码，把「自己崩的」盖成「主动杀掉的」。
      const explained = await this.explain(err)
      this.kill()
      throw explained
    }
  }

  /** 管道断开时等退出事件落定，用退出码和 stderr 换掉 SDK 的空话。别的错误带上 JSON-RPC data。 */
  private async explain(err: unknown): Promise<Error> {
    const error = err instanceof Error ? err : new Error(String(err))
    if (!isAcpStreamClosed(error) && !this.exit) return new Error(errorText(error))
    if (!this.exit) {
      await Promise.race([this.exitWait, new Promise((resolve) => setTimeout(resolve, EXIT_WAIT_MS))])
    }
    return new Error(describeAgentExit(this.cfg.id, this.exit, this.stderrTail))
  }

  /** 把 ACP 会话更新折成一条 info 事件（文本 chunk 只留元数据，正文由 output/thought 承载）。
   *  非文本内容块用独立计数 key，避免后到的更新把已收到的块覆盖掉 */
  private emitInfo(update: SessionNotification['update'], sessionId: string): void {
    const info = updateToInfo(update, (base) => `${base}:${this.nextInfoKey++}`)
    if (!info.acp) return
    this.emitter.emit('event', { type: 'info', info, sessionId } satisfies AgentEvent)
  }

  /** 处理函数一律经 ctx 拿参数；要人点头的请求（审批 / 写文件闸门 / 提问）还要 ctx.signal：agent 撤回时按取消结束 */
  private clientApp(): ClientApp {
    return client()
      .onNotification('session/update', (ctx) => this.onUpdate(ctx.params))
      .onRequest('session/request_permission', (ctx) => this.onPermission(ctx.params, ctx.signal))
      .onRequest('elicitation/create', (ctx) => this.onElicitation(ctx.params, ctx.signal))
      .onRequest('fs/write_text_file', (ctx) => this.onWriteFile(ctx.params, ctx.signal))
      .onRequest('fs/read_text_file', (ctx) => this.onReadFile(ctx.params))
      // ACP 终端：agent 要跑命令。参数 / 越界问题回成 invalid params（message 是人话），其余照常抛
      .onRequest('terminal/create', (ctx) => {
        if (this.restricted.has(ctx.params.sessionId)) return Promise.reject(RequestError.invalidRequest(undefined, RESTRICTED_MESSAGE))
        return termCall(() => this.terms.create(ctx.params))
      })
      .onRequest('terminal/output', (ctx) => termCall(() => this.terms.output(ctx.params)))
      .onRequest('terminal/wait_for_exit', (ctx) => termCall(() => this.terms.waitForExit(ctx.params)))
      // 应答体必须是 {}：client() 原样回 null，有的 agent 按对象解析
      .onRequest('terminal/kill', (ctx) => termCall(() => (this.terms.kill(ctx.params), {})))
      .onRequest('terminal/release', (ctx) => termCall(() => (this.terms.release(ctx.params), {})))
  }

  private onUpdate(notif: SessionNotification): void {
    const u = notif.update
    if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') {
      const parentId = chunkParent(u)
      this.emitter.emit('event', {
        type: 'text',
        delta: u.content.text,
        sessionId: notif.sessionId,
        ...(parentId ? { parentId } : {}),
      } satisfies AgentEvent)
      this.emitInfo(u, notif.sessionId)
    } else if (u.sessionUpdate === 'agent_thought_chunk' && u.content.type === 'text') {
      const parentId = chunkParent(u)
      this.emitter.emit('event', {
        type: 'thought',
        delta: u.content.text,
        sessionId: notif.sessionId,
        ...(parentId ? { parentId } : {}),
      } satisfies AgentEvent)
      this.emitInfo(u, notif.sessionId)
    } else if (u.sessionUpdate === 'usage_update') {
      const cost = costOf(u.cost)
      this.emitter.emit('event', {
        type: 'usage',
        used: u.used,
        size: u.size,
        ...(cost ? { cost } : {}),
        ...(u._meta != null ? { _meta: u._meta } : {}),
        sessionId: notif.sessionId,
      } satisfies AgentEvent)
      // 原始 usage_update（cost/_meta 等）也进 info.acp，重放/归档时可查
      this.emitInfo(u, notif.sessionId)
    } else if (u.sessionUpdate === 'available_commands_update') {
      // input.hint = 命令带参数时的提示文案（ACP AvailableCommandInput）；有它前端才知道该命令要补参数
      const list = u.availableCommands.map((c) => ({ name: c.name, description: c.description, ...(c.input?.hint ? { input: c.input.hint } : {}) }))
      this.sessionCommands.set(notif.sessionId, list)
      this.emitter.emit('event', { type: 'commands', list, sessionId: notif.sessionId } satisfies AgentEvent)
      this.emitInfo(u, notif.sessionId)
    } else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      // 工具调用过程：进度可见项 + 原始载荷（rawInput/rawOutput/content/diff/locations/_meta，增量合并）。
      // 正文/整段 raw 都保留在 step.acp，前端按需展开。
      const status = u.status == null ? undefined : stepStatus(u.status)
      const face = toolFace(u)
      const acpInfo = toolAcp(u)
      this.emitter.emit('event', {
        type: 'tool',
        id: u.toolCallId,
        kind: u.kind == null ? undefined : stepKind(u.kind),
        title: u.title ?? undefined,
        status,
        detail: firstPath(u.locations),
        note: status === 'failed' ? firstLine(u.content) : undefined,
        acp: acpInfo.acp,
        ...(acpInfo.truncated ? { truncated: true } : {}),
        ...(face.parentId ? { parentId: face.parentId } : {}),
        ...(face.activity ? { activity: face.activity } : {}),
        sessionId: notif.sessionId,
      } satisfies AgentEvent)
      // 内容里嵌了 ACP 终端：把它对上这一步（先发了 tool 事件，步骤已存在，攒着的输出才有地方贴）
      for (const item of u.content ?? []) {
        if (item.type === 'terminal') this.terms.bind(notif.sessionId, item.terminalId, u.toolCallId)
      }
    } else if (u.sessionUpdate === 'config_option_update') {
      const options = this.normalizeOptions(u.configOptions)
      this.sessionConfigs.set(notif.sessionId, options)
      this.emitter.emit('event', {
        type: 'config',
        options,
        sessionId: notif.sessionId,
      } satisfies AgentEvent)
      this.emitInfo(u, notif.sessionId)
    } else if (u.sessionUpdate === 'current_mode_update') {
      // mode 是 config 里 category=mode 的那一项：改写它的 currentValue 并发一次 config 事件
      // （镜像据此更新、广播）；info.acp 快照照旧留着（协议原样保留）
      this.applyMode(notif.sessionId, u.currentModeId)
      this.emitInfo(u, notif.sessionId)
    } else if (u.sessionUpdate === 'plan') {
      // agent 的计划清单：每次都是整份，客户端整份替换。归一后作为轮次原语发给 RunRecord（成品 `plan`），
      // 不再重复进 info.acp —— 计划随 TodoWrite 更新很频繁，一份数据两条事件是白费带宽
      const { entries, truncated } = normalizePlan(u.entries)
      this.emitter.emit('event', {
        type: 'plan',
        entries,
        ...(truncated ? { truncated: true } : {}),
        sessionId: notif.sessionId,
      } satisfies AgentEvent)
    } else {
      // 其余 ACP 会话更新（session_info_update / notice / compaction_* / subagent_update /
      // session_message* / user_message_chunk / 未知）：原样存 info.acp[key]，不静默丢弃
      this.emitInfo(u, notif.sessionId)
    }
  }

  /** 挂一条要人点头的请求并广播。agent 用 $/cancel_request 撤回（signal abort，codex 的提问超时就这样）→ 按取消结束：
   *  回应 agent（协作式取消，对方还在等我们的应答）并发 permission_resolved，卡片随之摘掉 */
  private hold(event: PermissionEvent, settle: PendingPermission['settle'], signal: AbortSignal, turnOf?: string): void {
    this.pending.set(event.requestId, { event, settle, ...(turnOf ? { turnOf } : {}) })
    this.emitter.emit('event', event)
    if (signal.aborted) this.resolvePending(event.requestId, null)
    else signal.addEventListener('abort', () => this.resolvePending(event.requestId, null), { once: true })
  }

  private onPermission(params: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    if (this.restricted.has(params.sessionId)) {
      // 受限会话：自动拒绝，不进待批、不发事件（没有人会看到、也没有人能批）。优先选 agent 给的「拒绝」选项，没有就按取消
      const reject = params.options.find((o) => o.kind === 'reject_once') ?? params.options.find((o) => o.kind === 'reject_always')
      return Promise.resolve({ outcome: reject ? ({ outcome: 'selected', optionId: reject.optionId } as const) : ({ outcome: 'cancelled' } as const) })
    }
    const { promise, resolve } = Promise.withResolvers<RequestPermissionResponse>()
    const options: PermissionOption[] = params.options.map((o) => ({
      optionId: o.optionId,
      name: o.name,
      kind: o.kind,
    }))
    // params.toolCall 是 SDK 结构体；widening 成通用字段表以便统一限长（不猜形状，原样保留）
    const toolCallFields = params.toolCall as Record<string, unknown>
    const event: PermissionEvent = {
      type: 'permission',
      requestId: `perm-${this.nextRequestId++}`,
      title: params.toolCall.title ?? params.toolCall.kind ?? '权限请求',
      options,
      toolCall: clipAcp(toolCallFields).acp,
      sessionId: params.sessionId,
    }
    this.hold(
      event,
      (optionId) => resolve({ outcome: optionId === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } }),
      signal,
    )
    return promise
  }

  /** 提问（ACP elicitation/create）：只认会话里的 form 模式（我们只声明了 form）。受限会话（随手 AI）不弹给任何人，
   *  回 decline（claude 当成「用户跳过」接着跑；cancel 会中止工具）。表单认不出（必填字段类型不认识）→ cancel */
  private onElicitation(params: CreateElicitationRequest, signal: AbortSignal): Promise<CreateElicitationResponse> {
    const raw = params as Record<string, unknown>
    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : undefined
    if (params.mode !== 'form' || !sessionId) return Promise.resolve({ action: 'cancel' })
    if (this.restricted.has(sessionId)) return Promise.resolve({ action: 'decline' })
    const form = normalizeAskForm(raw)
    if (!form) return Promise.resolve({ action: 'cancel' })
    const { promise, resolve } = Promise.withResolvers<CreateElicitationResponse>()
    const event: PermissionEvent = {
      type: 'permission',
      requestId: `perm-${this.nextRequestId++}`,
      title: form.message.split('\n').find((l) => l.trim())?.trim().slice(0, 200) || '提问',
      options: ASK_OPTIONS,
      form,
      sessionId,
    }
    const inTurn = (this.sessionPrompts.get(sessionId) ?? 0) > 0
    this.hold(event, (optionId, content) => resolve(askResponse(optionId, content)), signal, inTurn ? sessionId : undefined)
    return promise
  }

  private onWriteFile(params: WriteTextFileRequest, signal: AbortSignal): Promise<Record<string, never>> {
    if (this.restricted.has(params.sessionId)) return Promise.reject(RequestError.invalidRequest(undefined, RESTRICTED_MESSAGE))
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, never>>()
    const event: PermissionEvent = {
      type: 'permission',
      requestId: `perm-${this.nextRequestId++}`,
      title: `写入文件 ${params.path}`,
      options: [
        { optionId: 'allow', name: '允许', kind: 'allow_once' },
        { optionId: 'reject', name: '拒绝', kind: 'reject_once' },
      ],
      sessionId: params.sessionId,
    }
    this.hold(
      event,
      (optionId) => {
        if (optionId === null) {
          reject(new Error('用户拒绝了文件写入'))
        } else {
          writeFile(params.path, params.content).then(() => resolve({}), reject)
        }
      },
      signal,
    )
    return promise
  }

  private async onReadFile(params: ReadTextFileRequest): Promise<{ content: string }> {
    if (this.restricted.has(params.sessionId)) throw RequestError.invalidRequest(undefined, RESTRICTED_MESSAGE)
    return { content: await readFile(params.path, 'utf8') }
  }

  /** 只留 select 变体且带可选值；ACP options 可能是分组形式（group），拍平取内层 */
  private normalizeOptions(raw: SessionConfigOption[] | undefined | null): ConfigOption[] {
    const out: ConfigOption[] = []
    for (const o of raw ?? []) {
      if (o.type !== 'select') continue
      const values: ConfigOptionValue[] = (o.options ?? []).flatMap((g) =>
        'group' in g ? g.options : [g],
      )
      if (values.length === 0) continue
      out.push({
        id: o.id,
        name: o.name,
        category: o.category ?? null,
        currentValue: o.currentValue,
        options: values.map((v) => ({ value: v.value, name: v.name, description: v.description ?? null })),
      })
    }
    return out
  }

  /** tools：中心交给 AI 的能力（只有凭证 / 地址）。命令在这里拼：本进程就是拉起 AI 的进程，
   *  `process.execPath` 与脚本路径都在本机，见 page-read.ts 的 pageToolServer。缺省空数组 = 不给工具 */
  async newSession(cwd: string, tools: PageTool[] = []): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    await this.ready()
    const mcpServers: AcpMcpServer[] = tools.map(pageToolServer)
    const params: NewSessionRequest = { cwd, mcpServers }
    const res = await this.conn!.agent.request('session/new', params).catch((err: unknown) => this.explain(err).then((e) => Promise.reject(e)))
    const configOptions = this.normalizeOptions(res.configOptions)
    this.sessionConfigs.set(res.sessionId, configOptions)
    this.sessionCwds.set(res.sessionId, cwd)
    return { sessionId: res.sessionId, configOptions }
  }

  /** 随手 AI 的受限会话（connector/quick.ts 用）：不给任何 MCP 工具；之后 agent 向客户端要读写文件 / 开终端都被拒绝，审批自动拒绝。
   *  标记在 session/new 应答回来的同一个同步段里打上（agent 在 prompt 之前不会发这些请求） */
  async newRestrictedSession(cwd: string): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    await this.ready()
    const res = await this.conn!.agent.request('session/new', { cwd, mcpServers: [] }).catch((err: unknown) => this.explain(err).then((e) => Promise.reject(e)))
    this.restricted.add(res.sessionId)
    const configOptions = this.normalizeOptions(res.configOptions)
    this.sessionConfigs.set(res.sessionId, configOptions)
    this.sessionCwds.set(res.sessionId, cwd)
    return { sessionId: res.sessionId, configOptions }
  }

  isRestricted(sessionId: string): boolean {
    return this.restricted.has(sessionId)
  }

  /** 丢掉一个受限会话在本适配器里的全部记录（用完即弃：命令 / 配置 / 工作区 / 受限标记）。不通知 agent：ACP 没有关闭会话的稳定方法，
   *  agent 自己那边的会话记录（比如 claude 的 ~/.claude 下的 jsonl）由它自己管 */
  discardSession(sessionId: string): void {
    this.restricted.delete(sessionId)
    this.sessionConfigs.delete(sessionId)
    this.sessionCommands.delete(sessionId)
    this.sessionCwds.delete(sessionId)
  }

  async loadSession(sessionId: string, cwd: string, tools: PageTool[] = []): Promise<{ configOptions: ConfigOption[] }> {
    await this.ready()
    const mcpServers: AcpMcpServer[] = tools.map(pageToolServer)
    const params: LoadSessionRequest = { sessionId, cwd, mcpServers }
    const res = await this.conn!.agent.request('session/load', params).catch((err: unknown) => this.explain(err).then((e) => Promise.reject(e)))
    const configOptions = this.normalizeOptions(res.configOptions)
    this.sessionConfigs.set(sessionId, configOptions)
    this.sessionCwds.set(sessionId, cwd)
    return { configOptions }
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<ConfigOption[]> {
    await this.ready()
    const res = await this.conn!.agent.request('session/set_config_option', { sessionId, configId, value }).catch((err: unknown) => this.explain(err).then((e) => Promise.reject(e)))
    const configOptions = this.normalizeOptions(res.configOptions)
    this.sessionConfigs.set(sessionId, configOptions)
    // 任何缓存变化都发事件：镜像是这些事件的投影（agent 自己通常也会推一条 config_option_update，重复无害）
    this.emitter.emit('event', { type: 'config', options: configOptions, sessionId } satisfies AgentEvent)
    return configOptions
  }

  /** 该会话缓存的会话级状态（命令 / config options / 待批审批）。只读，不打扰 agent */
  sessionState(sessionId: string): SessionState {
    return {
      commands: this.sessionCommands.get(sessionId) ?? [],
      configs: this.sessionConfigs.get(sessionId) ?? [],
      approvals: [...this.pending.values()].map((p) => p.event).filter((e) => e.sessionId === sessionId),
    }
  }

  /** 进程内已知的全部会话（connector 在 hello 后推全量快照用） */
  knownSessions(): string[] {
    const ids = new Set([...this.sessionConfigs.keys(), ...this.sessionCommands.keys()])
    for (const p of this.pending.values()) if (p.event.sessionId) ids.add(p.event.sessionId)
    return [...ids].filter((id) => !this.restricted.has(id)) // 随手 AI 的受限会话不对中心露面
  }

  /** current_mode_update：改写 config 里 category=mode 那一项的 currentValue，发一次 config 事件。
   *  该会话没有 mode 配置项（agent 没把 mode 暴露成 config option）就没有可改写的，只剩 info 快照 */
  private applyMode(sessionId: string, modeId: string): void {
    const configs = this.sessionConfigs.get(sessionId)
    const mode = configs?.find((o) => o.category === 'mode')
    if (!configs || !mode || mode.currentValue === modeId) return
    const options = configs.map((o) => (o === mode ? { ...o, currentValue: modeId } : o))
    this.sessionConfigs.set(sessionId, options)
    this.emitter.emit('event', { type: 'config', options, sessionId } satisfies AgentEvent)
  }

  async prompt(sessionId: string, blocks: PromptBlock[]): Promise<PromptResult> {
    await this.ready()
    this.inFlight++
    this.sessionPrompts.set(sessionId, (this.sessionPrompts.get(sessionId) ?? 0) + 1)
    try {
      const params: PromptRequest = {
        sessionId,
        prompt: blocks.flatMap((b): PromptRequest['prompt'] => {
          if (b.type === 'text') return [{ type: 'text', text: b.text }]
          // 不能收图的 agent：图片块丢掉（文本里的 ![](/api/files/…) 链接还在，它要看可以自己 read_image）
          if (b.type === 'image') return this.promptImages ? [{ type: 'image', data: b.data, mimeType: b.mimeType }] : []
          return [{ type: 'resource', resource: { uri: b.uri, mimeType: b.mimeType, text: b.text } }]
        }),
      }
      const res = await this.conn!.agent.request('session/prompt', params)
      const usage = turnUsage(res.usage)
      // 原始 PromptResponse（含 _meta）先作为 info 事件发出：connector 会把它缓冲进本轮，
      // 重放/重连后仍能拿到 stopReason 与完整 usage（含 provider _meta），不只在内存的 prompt 结果里
      this.emitter.emit('event', { type: 'info', info: promptResponseInfo(res), sessionId } satisfies AgentEvent)
      return usage ? { stopReason: res.stopReason, usage } : { stopReason: res.stopReason }
    } catch (err) {
      throw await this.explain(err)
    } finally {
      // prompt 在飞期间不许被闲置回收（长轮次全程不发请求）；错误/取消也必须归零
      this.inFlight--
      this.endTurn(sessionId)
    }
  }

  /** 该会话的 prompt 都结束了：这一轮里来的提问还没答的按取消结束（agent 超时后不通知我们的，比如 omp） */
  private endTurn(sessionId: string): void {
    const left = (this.sessionPrompts.get(sessionId) ?? 1) - 1
    if (left > 0) return void this.sessionPrompts.set(sessionId, left)
    this.sessionPrompts.delete(sessionId)
    for (const [requestId, p] of [...this.pending]) {
      if (p.turnOf === sessionId) this.resolvePending(requestId, null)
    }
  }

  cancel(sessionId: string): void {
    // 只结束该会话的待批审批（协议要求客户端按取消应答），再发 session/cancel。
    // 不能结束整个进程的全部待批：否则停 A 页会拒掉 B 页同 agent 的审批
    for (const [requestId, p] of [...this.pending]) {
      if (p.event.sessionId === sessionId) this.resolvePending(requestId, null)
    }
    this.conn?.agent.notify('session/cancel', { sessionId }).catch(() => {})
  }

  /** 用户点了「停止这条命令」：杀掉这个会话里 agent 用 ACP 终端起的那条命令（agent 的 wait_for_exit 随之返回，由它决定接着做什么） */
  killCommand(sessionId: string, terminalId: string): boolean {
    return this.terms.killByUser(sessionId, terminalId)
  }

  respondPermission(requestId: string, optionId: string | null, content?: AskContent): boolean {
    return this.resolvePending(requestId, optionId, content)
  }

  /** 审批结束的唯一出口（有人答 / 停止该会话 / 进程退出 / agent 撤回 / 提问所在的一轮结束）：先摘掉、再应答 agent、最后发
   *  permission_resolved（镜像与前端据此移除）。没有超时，不会有别的路径结束它 */
  private resolvePending(requestId: string, optionId: string | null, content?: AskContent): boolean {
    const p = this.pending.get(requestId)
    if (!p) return false
    this.pending.delete(requestId)
    p.settle(optionId, content)
    this.emitter.emit('event', { type: 'permission_resolved', requestId, sessionId: p.event.sessionId } satisfies AgentEvent)
    return true
  }

  on(listener: (ev: AgentEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }

  kill(): void {
    this.stopped = true
    this.dead = true
    this.terms.killAll()
    this.proc?.kill()
    this.proc = null
    this.conn = null
  }
}
