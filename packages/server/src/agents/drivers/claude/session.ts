// ---------- 一个 Claude 会话：一个 SDK query()（流式输入）+ 它的一轮轮 prompt ----------
// 建会话 / 加载会话时就起 CLI 进程（start）：选了 agent 就要看到模型、模式、斜杠命令，这些只有进程起来后的 initialize
// 应答里有。空会话的进程由适配器的闲置回收收掉。进程没了（崩溃 / 取消卡死被关掉 / 换了工具凭证）下一次 prompt
// 重新起，用 resume 接同一个会话 id。一个会话同一时刻只有一轮在 CLI 里：后来的 prompt 排在前一轮的 result 之后再发，
// 否则 CLI 会把排队的消息并进正在跑的一轮，两条 prompt 只有一个 result，后一条永远等不到收尾。

import {
  query,
  type CanUseTool,
  type OnElicitation,
  type Options,
  type Query,
  type SDKControlInitializeResponse,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { pageToolServer, type PageTool } from '../../../page-read.js'
import type { AgentCommand, AgentConfig, AgentEvent, ConfigOption, PromptBlock, PromptResult } from '../../types.js'
import { ALLOW_BYPASS, ClaudeConfig, type ConfigChange } from './config.js'
import { ClaudeEvents, commandsOf } from './events.js'
import { rec, str } from '../tool-text.js'

/** 取消后等 CLI 收尾（interrupt 正常几十毫秒内就有 result）的上限：过了就当它卡死了，本轮按取消收尾、关掉进程，
 *  下一轮 resume 重起。宽松是故意的：只用来兜「明显卡住」，不能抢在一次慢但正常的中断前面 */
export const FORCE_CANCEL_MS = 30_000
const STDERR_TAIL = 4_000
/** 起进程到 initialize 应答的上限：CLI 冷启动（加载插件、MCP、登录态）慢的机器上也够；过了当它起不来 */
export const START_TIMEOUT_MS = 60_000

export type SessionSpec = { cwd: string; tools: PageTool[]; restricted: boolean }

/** 驱动交给会话的能力：发事件、写命令缓存、审批回调、收掉该会话的待批 */
export type SessionHost = {
  cfg: AgentConfig
  emit(ev: AgentEvent): void
  setCommands(sessionId: string, list: AgentCommand[]): void
  canUseTool(sessionId: string): CanUseTool
  onElicitation(sessionId: string): OnElicitation
  /** 配置项变了（模型清单到了 / CLI 报了新的模型或模式 / 改了配置）：写进会话状态并发 config 事件 */
  setConfigs(sessionId: string, options: ConfigOption[]): void
  cancelPending(sessionId: string): void
  /** 驱动已经 kill：进程退出不是崩溃，不打日志 */
  stopped(): boolean
}

/** 流式输入的队列：prompt 往里推一条用户消息，close 后 SDK 关掉 CLI 的 stdin */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private closed = false

  push(msg: SDKUserMessage): void {
    this.items.push(msg)
    this.wake?.()
  }

  close(): void {
    this.closed = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.items.shift()
      if (next) yield next
      else if (this.closed) return
      else await new Promise<void>((resolve) => (this.wake = resolve))
    }
  }
}

type Turn = {
  cancelled: boolean
  settled: boolean
  resolve: (r: PromptResult) => void
  reject: (err: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

/** 一个 CLI 进程：它在跑的那一轮跟着它走（进程换了，晚到的收尾不能落到新进程的一轮上） */
type Live = { q: Query; inbox: Inbox; key: string; turn: Turn | null }

/** PromptBlock → SDK 用户消息的内容块。引用页的正文作为文字附件（`<context ref>`） */
export function userContent(blocks: PromptBlock[]): SDKUserMessage['message']['content'] {
  const content: Exclude<SDKUserMessage['message']['content'], string> = []
  const context: typeof content = []
  for (const b of blocks) {
    if (b.type === 'text') content.push({ type: 'text', text: b.text })
    else if (b.type === 'image') {
      content.push({ type: 'image', source: { type: 'base64', media_type: b.mimeType as 'image/png', data: b.data } })
    } else {
      content.push({ type: 'text', text: b.uri })
      context.push({ type: 'text', text: `\n<context ref="${b.uri}"${b.title ? ` title="${b.title.replace(/"/g, "'")}"` : ''}>\n${b.text}\n</context>` })
    }
  }
  return [...content, ...context]
}

/** Ramet 的页面工具 → SDK 的 mcpServers（中性描述是 env 键值对数组，SDK 是按名字的表 + env 对象） */
export function mcpServersOf(tools: PageTool[]): NonNullable<Options['mcpServers']> {
  const out: NonNullable<Options['mcpServers']> = {}
  for (const tool of tools) {
    const s = pageToolServer(tool)
    let name = s.name
    for (let i = 2; name in out; i++) name = `${s.name}-${i}`
    out[name] = { type: 'stdio', command: s.command, args: s.args, env: Object.fromEntries(s.env.map((e) => [e.name, e.value])) }
  }
  return out
}

export class ClaudeSession {
  readonly events: ClaudeEvents
  readonly config = new ClaudeConfig()
  /** 上一次交出去的配置项（序列化）：每一轮的 init 都会报模型与模式，没变就不重复发 config 事件 */
  private published = ''
  private live: Live | null = null
  /** 前一轮的收尾：下一轮排在它后面 */
  private chain: Promise<void> = Promise.resolve()
  /** 每次取消加一：排着队、还没发出去的 prompt 看到它变了就直接按取消收尾 */
  private cancelGen = 0
  private stderrTail = ''

  constructor(
    readonly id: string,
    public spec: SessionSpec,
    /** CLI 那边已经有这份会话记录：之后起进程一律 resume（新会话第一次用宿主指定的 id 建） */
    private persisted: boolean,
    private readonly host: SessionHost,
  ) {
    this.events = new ClaudeEvents(id, (ev) => host.emit(ev), (list) => host.setCommands(id, list))
  }

  /** 换了工作区 / 工具凭证：进程按旧配置起的（MCP 凭证写在启动参数里），下一轮要用新的重起。在跑的一轮不动 */
  respec(spec: SessionSpec): void {
    const changed = JSON.stringify(spec) !== JSON.stringify(this.spec)
    this.spec = spec
    if (changed && this.live && !this.live.turn) this.close()
  }

  private specKey(): string {
    return JSON.stringify(this.spec)
  }

  private options(): Options {
    const { cfg } = this.host
    const { spec } = this
    return {
      cwd: spec.cwd,
      pathToClaudeCodeExecutable: cfg.cli ?? cfg.command,
      includePartialMessages: true,
      canUseTool: this.host.canUseTool(this.id),
      onElicitation: this.host.onElicitation(this.id),
      // 沿用用户自己的配置（模型、权限规则、CLAUDE.md、MCP）；SDK 缺省什么都不读
      settingSources: ['user', 'project', 'local'],
      ...(this.persisted ? { resume: this.id } : { sessionId: this.id }),
      ...this.prefOptions(),
      // 受限会话（随手 AI）：不给任何内置工具、只认我们给的（空）MCP 表 —— 用户配置里的放行规则绕不过去
      ...(spec.restricted ? { tools: [], mcpServers: {}, strictMcpConfig: true } : { mcpServers: mcpServersOf(spec.tools) }),
      stderr: (data: string) => {
        this.stderrTail = (this.stderrTail + data).slice(-STDERR_TAIL)
      },
      // 不传 env 时 SDK 用 process.env；传了就是整份替换，所以只在配置里真有附加变量时才合并后传
      ...(cfg.env && Object.keys(cfg.env).length > 0 ? { env: { ...process.env, ...cfg.env } } : {}),
    }
  }

  /** 用户在 Ramet 里选过的模型 / 模式 / 思考强度：进程（重）起时带上；没选过的不传，CLI 用它自己的配置。
   *  受限会话（随手 AI）固定在逐步确认：用户配置里的免确认模式不能带进来 */
  private prefOptions(): Partial<Options> {
    if (this.spec.restricted) return { permissionMode: 'default' }
    const { model, mode, effort } = this.config.prefs
    return {
      ...(model && model !== 'default' ? { model } : {}),
      ...(mode ? { permissionMode: mode } : {}),
      ...(effort ? { effort } : {}),
      // 运行中切到 bypassPermissions 要求进程带着这个开关起；谁能切由中心的 posture 判，不靠它
      ...(ALLOW_BYPASS ? { allowDangerouslySkipPermissions: true } : {}),
    }
  }

  private ensureLive(): Live {
    if (this.live) return this.live
    const inbox = new Inbox()
    const q = query({ prompt: inbox, options: this.options() })
    const live: Live = { q, inbox, key: this.specKey(), turn: null }
    this.live = live
    void this.pump(live)
    // 模型清单与命令清单（带说明与参数提示）在 initialize 的应答里；之后命令的变化走 commands_changed
    q.initializationResult().then((init) => this.live === live && this.onInit(init), () => {})
    return live
  }

  private onInit(init: SDKControlInitializeResponse): void {
    this.config.setModels(Array.isArray(init.models) ? init.models : [])
    this.host.setCommands(this.id, commandsOf(Array.isArray(init.commands) ? init.commands : []))
    this.publish()
  }

  private publish(): void {
    const options = this.config.options()
    const json = JSON.stringify(options)
    if (json === this.published) return
    this.published = json
    this.host.setConfigs(this.id, options)
  }

  /** 起 CLI 进程并等到 initialize 应答（模型 / 命令都到手）。起不来（会话记录不在、CLI 报错退出、超时）抛带原因的错 */
  async start(): Promise<ConfigOption[]> {
    const live = this.ensureLive()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`claude 在 ${START_TIMEOUT_MS / 1000} 秒内没有完成启动`)), START_TIMEOUT_MS)
    })
    try {
      const init = await Promise.race([live.q.initializationResult(), timeout])
      if (this.live === live) this.onInit(init)
    } catch (err) {
      if (this.live === live) this.close()
      throw new Error(this.withStderr(err instanceof Error ? err.message : String(err)))
    } finally {
      clearTimeout(timer)
    }
    return this.config.options()
  }

  /** 改一项配置：记进 prefs（进程重起时带上），进程活着就当场发控制请求；CLI 拒绝则回到改之前并抛错 */
  async setConfig(configId: string, value: string): Promise<ConfigOption[]> {
    const { change, undo } = this.config.set(configId, value)
    const live = this.live
    if (live) {
      try {
        await this.send(live.q, change)
      } catch (err) {
        undo()
        throw err
      }
    }
    this.publish()
    return this.config.options()
  }

  private send(q: Query, change: ConfigChange): Promise<void> {
    if (change.kind === 'model') return q.setModel(change.model)
    if (change.kind === 'mode') return q.setPermissionMode(change.mode)
    return q.applyFlagSettings({ effortLevel: change.effort })
  }

  /** 失败原因带上 CLI stderr 的最后几行（「找不到会话」「没登录」这类只在 stderr 里） */
  private withStderr(why: string): string {
    const tail = this.stderrTail.trim().split('\n').slice(-6).join(' | ')
    return tail && !why.includes(tail) ? `${why}：${tail.slice(-500)}` : why
  }

  private async pump(live: Live): Promise<void> {
    let failure: unknown = null
    try {
      for await (const msg of live.q) this.onMessage(live, msg)
    } catch (err) {
      failure = err
    }
    this.ended(live, failure)
  }

  private onMessage(live: Live, msg: SDKMessage): void {
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.persisted = true
      this.config.noteInit(msg.model, msg.permissionMode)
      this.publish()
    } else if (msg.type === 'system' && msg.subtype === 'status') {
      // 模式变了（agent 自己切的，比如计划批准后）：只有带 permissionMode 的状态消息才算
      const mode = str(rec(msg).permissionMode)
      if (mode) {
        this.config.noteMode(mode)
        this.publish()
      }
    }
    if (msg.type === 'result') {
      const turn = live.turn
      const summary = this.events.result(msg, turn?.cancelled ?? false)
      if (!turn) return
      if (summary.error) this.settle(turn, new Error(summary.error), live)
      else this.settle(turn, { stopReason: summary.stopReason, ...(summary.usage ? { usage: summary.usage } : {}) }, live)
      return
    }
    this.events.handle(msg)
  }

  /** query 结束（进程退出 / 被关掉）：在飞的一轮收尾，待批收掉（不可达的待批会让适配器永远 busy），下一轮重起 */
  private ended(live: Live, failure: unknown): void {
    const newer = this.live !== null && this.live !== live
    if (this.live === live) this.live = null
    live.inbox.close()
    const turn = live.turn
    if (turn) {
      if (turn.cancelled) this.settle(turn, { stopReason: 'cancelled' }, live)
      else {
        this.settle(turn, new Error(this.withStderr(failure instanceof Error ? failure.message : 'claude 进程提前结束了')), live)
      }
    }
    // 已经换了新进程（配置变了重起）：新进程的待批不能跟着收。旧进程的待批由 SDK 关闭时 abort 掉的 signal 收
    if (!newer) this.host.cancelPending(this.id)
    if (failure && !this.host.stopped()) console.error(`[claude] ${this.host.cfg.id} 会话 ${this.id} 的进程结束：${failure instanceof Error ? failure.message : String(failure)}`)
  }

  private settle(turn: Turn, outcome: PromptResult | Error, live: Live): void {
    if (turn.settled) return
    turn.settled = true
    if (turn.timer) clearTimeout(turn.timer)
    if (live?.turn === turn) live.turn = null
    if (outcome instanceof Error) turn.reject(outcome)
    else turn.resolve(outcome)
  }

  async prompt(blocks: PromptBlock[]): Promise<PromptResult> {
    const gen = this.cancelGen
    const prev = this.chain
    let release!: () => void
    this.chain = new Promise<void>((resolve) => (release = resolve))
    try {
      await prev
      if (gen !== this.cancelGen) return { stopReason: 'cancelled' }
      // 配置变了而进程是按旧配置起的（上一轮在跑时没法关）：先关掉，这一轮用新配置重起
      if (this.live && this.live.key !== this.specKey()) this.close()
      const live = this.ensureLive()
      const { promise, resolve, reject } = Promise.withResolvers<PromptResult>()
      const turn: Turn = { cancelled: false, settled: false, resolve, reject }
      live.turn = turn
      live.inbox.push({ type: 'user', message: { role: 'user', content: userContent(blocks) }, parent_tool_use_id: null })
      return await promise
    } finally {
      release()
    }
  }

  /** 停止这一轮：中断 CLI，排着的 prompt 也不再发。迟迟不收尾就按取消结束并关掉进程 */
  cancel(): void {
    this.cancelGen++
    const live = this.live
    const turn = live?.turn
    if (!live || !turn) return
    turn.cancelled = true
    live.q.interrupt().catch(() => {})
    turn.timer ??= setTimeout(() => {
      if (turn.settled) return
      this.settle(turn, { stopReason: 'cancelled' }, live)
      // 卡死的进程留着，它晚到的 result 会被当成下一轮的；关掉它，下一轮 resume 重起
      if (this.live === live) this.close()
    }, FORCE_CANCEL_MS)
    turn.timer.unref?.()
  }

  /** 停掉一个子代理 / 后台任务（stop_task）。不在跑的返回 false */
  stopTask(taskId: string): boolean {
    if (!this.live || !this.events.liveTasks.has(taskId)) return false
    this.live.q.stopTask(taskId).catch((err: unknown) => console.error(`[claude] stop_task ${taskId} 失败：${err instanceof Error ? err.message : String(err)}`))
    return true
  }

  /** 关掉进程（SDK 会杀 CLI 子进程）；pump 随之收尾 */
  close(): void {
    const live = this.live
    if (!live) return
    this.live = null
    live.inbox.close()
    live.q.close()
  }
}
