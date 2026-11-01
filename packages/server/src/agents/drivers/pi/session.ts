// ---------- 一个 pi / omp 会话：一个 RPC 进程 + 它的一轮轮 prompt ----------
// pi / omp 的 RPC 进程一次只绑一个会话（切会话会中止在跑的回合），所以每会话一个进程。会话记录放在 Ramet 自己的目录
// （pi：<根>/pi/<id>.jsonl；omp：<根>/omp/<id>/），新建与恢复走同一条路：pi 用 --session <路径>，omp 起进程后 open_session。
// 两家对不存在的记录都会静默新建一个空会话，所以「要恢复」时由这里先确认记录在、再核对 CLI 的应答。
// 进程没了（崩溃 / 取消卡死被关掉 / 换了工具凭证）下一轮重新起，按同一份记录接上。
// 同一会话同一时刻只有一轮在 CLI 里：后来的 prompt 排在前一轮收尾之后再发（pi 遇到在跑的回合直接拒绝新 prompt）。
// 配置（config.ts）跟着会话走、不跟进程走：用户选过的模型 / 思考档位每个新进程补发一次；omp 的审批档是启动参数，变了就换进程。

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pageToolServer, type PageTool } from '../../../page-read.js'
import type { AgentCommand, AgentConfig, AgentEvent, ConfigOption, PromptBlock, PromptResult } from '../../types.js'
import { rec } from '../tool-text.js'
import { PiSessionConfig, splitModelKey, type Overrides } from './config.js'
import { commandsOf, PiEvents, type SettingsChange } from './events.js'
import { HostTools } from './host-tools.js'
import type { ContextUsage, ImageContent, PiDialect, PiEvent, SessionStateData, UiAnswer, UiDialogRequest, UiNoticeRequest } from './protocol.js'
import { PiRpc } from './rpc.js'

/** 取消后等 CLI 收尾（abort 正常很快就有收尾事件）的上限：过了就当它卡死了，本轮按取消收尾、关掉这个会话的进程，
 *  下一轮按会话记录重起（每会话一个进程，关掉不影响别的会话） */
export const FORCE_CANCEL_MS = 30_000
/** 起进程到就绪（pi：get_state 应答；omp：ready 帧 + 打开会话）的上限：冷启动慢的机器上也够；过了当它起不来 */
export const START_TIMEOUT_MS = 60_000
/** 收尾时取上下文占用的上限：取不到就不报，不能拖住一轮的收尾 */
const STATS_TIMEOUT_MS = 3_000
/** prompt 命令的应答上限（两家都是当场应答，回合本身靠事件收尾） */
const PROMPT_ACK_MS = 60_000
/** Ramet 页面工具在 pi 里注册的服务名。用户的 mcp.json 里有同名服务时 pi 用用户的（不报错），所以撞名就换一个 */
const MCP_NAME = 'ramet'
const MCP_FALLBACK = 'ramet-page'
/** 驱动交给 pi 的扩展（按路径加载，connector 安装包里在入口同级的 extension/ 下） */
export const PI_EXTENSION = fileURLToPath(new URL('./extension/ramet-mcp.mjs', import.meta.url))

export type SessionSpec = { cwd: string; tools: PageTool[]; restricted: boolean }

export type SessionHost = {
  cfg: AgentConfig
  dialect: PiDialect
  /** 这一家会话记录的根目录（<根>/pi 或 <根>/omp） */
  root: string
  emit(ev: AgentEvent): void
  setCommands(sessionId: string, list: AgentCommand[]): void
  /** 配置项变了（CLI 报的、或用户改的）：更新缓存并发 config 事件 */
  setConfigs(sessionId: string, options: ConfigOption[]): void
  ui(session: PiSession, req: UiDialogRequest, signal: AbortSignal): UiAnswer | null | Promise<UiAnswer | null>
  cancelPending(sessionId: string): void
  /** 驱动已经 kill：进程退出不是崩溃，不打日志 */
  stopped(): boolean
}

type Turn = {
  cancelled: boolean
  settled: boolean
  /** 收尾事件到了、正在取上下文占用：别的收尾信号不再重复处理 */
  finishing: boolean
  /** omp 的 prompt_result：回合本身的结局（会话可能还没静止，后台子代理跑完才算） */
  status?: 'completed' | 'aborted' | 'error'
  error?: string
  resolve: (r: PromptResult) => void
  reject: (err: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

/** 一个 CLI 进程：它在跑的那一轮跟着它走（进程换了，晚到的收尾不能落到新进程的一轮上）。
 *  applied = 已经交给这个进程的覆盖（新进程从空的开始，选过的值要补发）；isReady = 握手完成 */
type Live = { rpc: PiRpc; key: string; turn: Turn | null; ready: Promise<void>; isReady: boolean; applied: Overrides; host?: HostTools }

/** 脚本（测试用的假 CLI、npm 装的 .js 入口）不一定有执行位：用当前 node 跑 */
function spawnSpec(cfg: AgentConfig, args: string[]): { command: string; args: string[] } {
  const all = [...(cfg.args ?? []), ...args]
  return /\.[cm]?js$/.test(cfg.command) ? { command: process.execPath, args: [cfg.command, ...all] } : { command: cfg.command, args: all }
}

/** PromptBlock → pi 的 prompt：文字拼成一条消息，引用页的正文作为文字附件（`<context ref>`，与其它驱动同一写法），图片单独带 */
export function promptOf(blocks: PromptBlock[]): { message: string; images?: ImageContent[] } {
  const text: string[] = []
  const context: string[] = []
  const images: ImageContent[] = []
  for (const b of blocks) {
    if (b.type === 'text') text.push(b.text)
    else if (b.type === 'image') images.push({ type: 'image', data: b.data, mimeType: b.mimeType })
    else {
      text.push(b.uri)
      const title = b.title ? ` title="${b.title.replace(/"/g, "'")}"` : ''
      context.push(`\n<context ref="${b.uri}"${title}>\n${b.text}\n</context>`)
    }
  }
  return { message: [...text, ...context].join(''), ...(images.length > 0 ? { images } : {}) }
}

/** 用户 pi 配置里的 MCP 服务名（用户级 mcp.json + 项目级 .pi/mcp.json）。读不到就当没有：pi 遇到同名用用户的，最坏是页面工具不可用 */
export function piMcpNames(cwd: string, agentDir: string): Set<string> {
  const names = new Set<string>()
  for (const file of [join(agentDir, 'mcp.json'), join(cwd, '.pi', 'mcp.json')]) {
    try {
      const json = rec(JSON.parse(readFileSync(file, 'utf8')))
      for (const name of Object.keys(json.mcpServers && typeof json.mcpServers === 'object' ? rec(json.mcpServers) : json)) names.add(name)
    } catch {
      // 没有这个文件 / 不是 JSON：跳过
    }
  }
  return names
}

/** Ramet 的页面工具 → 交给 pi 扩展的 MCP 配置（按名字的表）。exposure 必须是 direct：缺省的 codemode 不进模型的工具表 */
export function piMcpServers(tools: PageTool[], taken: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const free = (name: string) => !taken.has(name) && !(name in out)
  for (const tool of tools) {
    const s = pageToolServer(tool)
    let name = free(MCP_NAME) ? MCP_NAME : MCP_FALLBACK
    for (let i = 2; !free(name); i++) name = `${MCP_FALLBACK}-${i}`
    out[name] = { command: s.command, args: s.args, env: Object.fromEntries(s.env.map((e) => [e.name, e.value])), exposure: 'direct' }
  }
  return out
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class PiSession {
  readonly events: PiEvents
  readonly config: PiSessionConfig
  private live: Live | null = null
  /** 前一轮的收尾：下一轮排在它后面 */
  private chain: Promise<void> = Promise.resolve()
  /** 每次取消加一：排着队、还没发出去的 prompt 看到它变了就直接按取消收尾 */
  private cancelGen = 0

  constructor(
    readonly id: string,
    public spec: SessionSpec,
    private readonly host: SessionHost,
  ) {
    this.config = new PiSessionConfig(host.dialect)
    this.events = new PiEvents(
      id,
      (ev) => host.emit(ev),
      (list) => this.setCommands(list),
      (change) => this.onSettings(change),
    )
  }

  /** pi 的会话文件 / omp 的会话目录（迁移会话时整份搬的就是它） */
  get location(): string {
    return this.host.dialect === 'pi' ? join(this.host.root, `${this.id}.jsonl`) : join(this.host.root, this.id)
  }

  /** CLI 那边已经有这份会话记录（第一轮收尾后才落盘） */
  recorded(): boolean {
    const at = this.location
    if (this.host.dialect === 'pi') return existsSync(at)
    try {
      return readdirSync(at).some((f) => f.endsWith('.jsonl'))
    } catch {
      return false
    }
  }

  get running(): boolean {
    return this.live?.turn != null
  }

  private setCommands(list: AgentCommand[]): void {
    if (!this.spec.restricted) this.host.setCommands(this.id, list)
  }

  /** 换了工作区 / 工具凭证：进程按旧配置起的（凭证在启动环境 / 宿主工具里），下一轮要用新的重起。在跑的一轮不动 */
  respec(spec: SessionSpec): void {
    const changed = JSON.stringify(spec) !== JSON.stringify(this.spec)
    this.spec = spec
    if (changed && this.live && !this.live.turn) this.close()
  }

  /** 进程身份：工作区 / 工具凭证 / 受限与否 + 启动参数里的配置（omp 的审批档）。变了下一轮就换进程 */
  private specKey(): string {
    return JSON.stringify([this.spec, this.config.launchArgs()])
  }

  // ---------- 进程 ----------

  /** 起进程并就绪（没起就起；起着且配置没变就复用）。resume = 必须接上已有记录（CLI 静默新建了就算失败） */
  async start(resume = this.recorded()): Promise<void> {
    const live = this.live && this.live.key === this.specKey() ? this.live : this.spawn(resume)
    await live.ready
  }

  private args(): { args: string[]; env: Record<string, string> } {
    const { cfg, dialect } = this.host
    const { spec } = this
    // 受限会话不带审批档：它的审批一律由驱动拒绝，没有配置项
    if (dialect === 'omp') return { args: ['--mode', 'rpc-ui', ...(spec.restricted ? ['--no-tools'] : this.config.launchArgs())], env: {} }
    const args = ['--mode', 'rpc', '--session', this.location]
    // 受限会话（随手 AI）：不给内置工具、不连任何 MCP（用户配置里的也不连）、不加载我们的扩展
    if (spec.restricted) return { args: [...args, '--no-tools', '--no-mcp'], env: {} }
    if (spec.tools.length === 0) return { args, env: {} }
    const agentDir = cfg.env?.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? '', '.pi', 'agent')
    const servers = piMcpServers(spec.tools, piMcpNames(spec.cwd, agentDir))
    return { args: [...args, '-e', PI_EXTENSION], env: { RAMET_PI_MCP: JSON.stringify(servers) } }
  }

  private spawn(resume: boolean): Live {
    this.close()
    const { cfg, dialect } = this.host
    const { args, env } = this.args()
    const spec = spawnSpec(cfg, args)
    const live = { turn: null, key: this.specKey(), isReady: false, applied: {} } as unknown as Live
    // 会话记录的目录要先在：两家第一次落盘时不一定自己建上层目录
    mkdirSync(dialect === 'pi' ? dirname(this.location) : this.location, { recursive: true })
    live.rpc = new PiRpc({
      id: cfg.id,
      dialect,
      command: spec.command,
      args: spec.args,
      env: { ...cfg.env, ...env },
      cwd: this.spec.cwd,
      onEvent: (ev) => this.onEvent(live, ev),
      onUiDialog: (req, signal) => this.host.ui(this, req, signal),
      onUiNotice: (req) => this.onNotice(req),
      onHostTool: (call, signal) => {
        if (!live.host) throw new Error(`没有宿主工具 ${call.toolName}`)
        return live.host.call(call, signal)
      },
      onProtocolError: (message) => console.error(`[${dialect}] ${cfg.id} 会话 ${this.id}：${message}`),
      onExit: (info) => this.ended(live, info.reason, info.crashed),
    })
    this.live = live
    live.ready = this.handshake(live, resume)
    // 握手失败由 start 的调用方处理；这里只防它变成未处理的 rejection
    live.ready.catch(() => {})
    return live
  }

  private async handshake(live: Live, resume: boolean): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${this.host.cfg.id} 在 ${START_TIMEOUT_MS / 1000} 秒内没有完成启动`)), START_TIMEOUT_MS)
    })
    try {
      await Promise.race([this.host.dialect === 'pi' ? this.openPi(live) : this.openOmp(live, resume), timeout])
      live.isReady = true
    } catch (err) {
      const exited = live.rpc.exited
      if (this.live === live) this.close()
      // 进程自己退了：退出说明（退出码 + stderr 尾巴）比「命令失败」更有用
      throw new Error(exited && !errText(err).includes(exited) ? `${errText(err)}：${exited}` : errText(err))
    } finally {
      clearTimeout(timer)
    }
  }

  /** pi 没有握手帧：get_state 成功即就绪 */
  private async openPi(live: Live): Promise<void> {
    const state = await live.rpc.request('get_state', {}, { timeoutMs: START_TIMEOUT_MS })
    if (this.spec.restricted) return
    const [{ commands }] = await Promise.all([
      live.rpc.request('get_commands', {}).catch(() => ({ commands: [] })),
      this.loadConfig(live, state),
    ])
    this.setCommands(commandsOf(Array.isArray(commands) ? commands : []))
  }

  /** 模型清单、当前模型 / 思考档位、当前模型可选的档位。取不到哪项就少哪项，不影响开会话 */
  private async loadConfig(live: Live, state?: SessionStateData): Promise<void> {
    const { rpc } = live
    const quiet = <T>(p: Promise<T>): Promise<T | undefined> => p.catch(() => undefined)
    const [st, models, levels] = await Promise.all([
      state ? Promise.resolve(state) : quiet(rpc.request('get_state', {})),
      quiet(rpc.request('get_available_models', {})),
      quiet(rpc.request('get_available_thinking_levels', {})),
    ])
    this.noteConfig({
      ...(Array.isArray(models?.models) ? { models: models.models } : {}),
      ...(st ? { model: st.model ?? null, thinking: typeof st.thinkingLevel === 'string' ? st.thinkingLevel : null } : {}),
      ...(Array.isArray(levels?.levels) ? { levels: levels.levels } : {}),
    })
  }

  private noteConfig(update: Parameters<PiSessionConfig['note']>[0]): void {
    if (this.config.note(update) && !this.spec.restricted) this.publishConfig()
  }

  private publishConfig(): void {
    if (!this.spec.restricted) this.host.setConfigs(this.id, this.config.options())
  }

  /** CLI 报的当前模型 / 思考档位变了。换了模型要重取它的可选档位 */
  private onSettings(change: SettingsChange): void {
    if (this.spec.restricted) return
    if (change.thinking !== undefined) this.noteConfig({ thinking: change.thinking })
    if (change.model !== undefined) {
      this.noteConfig({ model: change.model })
      const live = this.live
      if (live?.isReady) void this.refreshLevels(live)
    }
  }

  private async refreshLevels(live: Live): Promise<void> {
    const r = await live.rpc.request('get_available_thinking_levels', {}).catch(() => undefined)
    if (r && Array.isArray(r.levels) && this.live === live) this.noteConfig({ levels: r.levels })
  }

  /** 把用户选过、这个进程还没收到的模型 / 思考档位交给它（先模型：换模型会连带夹思考档位）。
   *  strict：失败就抛（用户当场改配置时要看到原因）；否则丢掉那项覆盖、记日志，这一轮照常跑 */
  private async sync(live: Live, strict: boolean): Promise<void> {
    const want = this.config.overrides
    const fail = (what: 'model' | 'thinking', err: unknown) => {
      if (strict) throw err
      console.error(`[${this.host.dialect}] ${this.host.cfg.id} 会话 ${this.id} 切换${what === 'model' ? '模型' : '思考档位'}失败：${errText(err)}`)
      delete this.config.overrides[what]
      this.publishConfig()
    }
    if (want.model && live.applied.model !== want.model) {
      const target = splitModelKey(want.model)
      try {
        if (!target) throw new Error(`模型 ${want.model} 不对`)
        const model = await live.rpc.request('set_model', target)
        live.applied.model = want.model
        this.noteConfig({ model })
        await this.refreshLevels(live)
      } catch (err) {
        fail('model', err)
      }
    }
    if (want.thinking && live.applied.thinking !== want.thinking) {
      const level = want.thinking
      try {
        await live.rpc.request('set_thinking_level', { level })
        live.applied.thinking = level
        this.noteConfig({ thinking: level })
      } catch (err) {
        fail('thinking', err)
      }
    }
  }

  /** 改一项配置。模型 / 思考档位：进程活着且空闲就当场交给它（失败原样抛、覆盖退回），否则记下等下一轮开头补发；
   *  omp 的审批档：记下，空闲就关掉进程，下一轮按新的启动参数重起并打开同一份会话记录（在跑的一轮不打断） */
  async setConfig(configId: string, value: string): Promise<void> {
    const saved = this.config.snapshot()
    if (!this.config.set(configId, value)) return
    const live = this.live
    if (live && !live.turn && live.key !== this.specKey()) this.close()
    else if (live?.isReady && !live.turn) {
      try {
        await this.sync(live, true)
      } catch (err) {
        this.config.restore(saved)
        throw err
      }
    }
    this.publishConfig()
  }

  /** omp：等 ready 帧、协商 v2 分块帧、打开会话目录；再开提问对话框、子代理事件订阅、宿主工具 */
  private async openOmp(live: Live, resume: boolean): Promise<void> {
    const { rpc } = live
    await rpc.negotiate()
    const opened = await rpc.request('open_session', { sessionDir: this.location }, { timeoutMs: START_TIMEOUT_MS })
    // 会话记录的工作目录与进程的不同：omp 不报错，只回 cancelled，当前会话还是启动时默认开的那个
    if (opened.cancelled) throw new Error(`omp 没有打开会话 ${this.id}（记录的工作目录与 ${this.spec.cwd} 不同）`)
    if (resume && !opened.resumed) throw new Error(`omp 没有找到会话 ${this.id} 的记录`)
    if (this.spec.restricted) return
    const optional = (p: Promise<unknown>, what: string) =>
      p.catch((err: unknown) => console.error(`[omp] ${this.host.cfg.id} ${what}失败：${errText(err)}`))
    await Promise.all([
      optional(rpc.request('set_ask_dialog', { enabled: true }), '打开提问对话框'),
      optional(rpc.request('set_subagent_subscription', { level: 'events' }), '订阅子代理事件'),
      rpc.request('get_available_commands', {}).then(
        (r) => this.setCommands(commandsOf(Array.isArray(r.commands) ? r.commands : [])),
        () => {},
      ),
      this.loadConfig(live),
    ])
    if (this.spec.tools.length === 0) return
    const tools = await HostTools.start(this.spec.tools, this.host.cfg.env)
    if (this.live !== live) return tools.close()
    live.host = tools
    await rpc.request('set_host_tools', { tools: tools.definitions })
  }

  /** 关掉进程；在跑的一轮由 onExit 收尾 */
  close(): void {
    const live = this.live
    if (!live) return
    this.live = null
    live.host?.close()
    live.rpc.kill()
  }

  /** 进程没了（崩溃 / 被关掉）：在飞的一轮收尾，待批收掉（不可达的待批会让适配器永远 busy），下一轮重起 */
  private ended(live: Live, reason: string, crashed: boolean): void {
    const newer = this.live !== null && this.live !== live
    if (this.live === live) this.live = null
    live.host?.close()
    const turn = live.turn
    if (turn) this.settle(live, turn, turn.cancelled ? { stopReason: 'cancelled' } : new Error(reason))
    // 已经换了新进程：新进程的待批不能跟着收。旧进程的待批由 rpc 在退出时 abort 掉的 signal 收
    if (!newer) this.host.cancelPending(this.id)
    if (crashed && !this.host.stopped()) console.error(`[${this.host.dialect}] ${this.host.cfg.id} 会话 ${this.id}：${reason}`)
  }

  private onNotice(req: UiNoticeRequest): void {
    if (req.method !== 'notify' || !this.live?.turn) return
    this.host.emit({ type: 'info', info: { acp: { notify: { message: req.message, ...(req.notifyType ? { level: req.notifyType } : {}) } } }, sessionId: this.id })
  }

  // ---------- 一轮 ----------

  async prompt(blocks: PromptBlock[]): Promise<PromptResult> {
    const gen = this.cancelGen
    const prev = this.chain
    let release!: () => void
    this.chain = new Promise<void>((resolve) => (release = resolve))
    try {
      await prev
      if (gen !== this.cancelGen) return { stopReason: 'cancelled' }
      await this.start()
      const live = this.live
      if (!live) throw new Error(`${this.host.cfg.id} 已停止`)
      if (!this.spec.restricted) await this.sync(live, false)
      if (gen !== this.cancelGen) return { stopReason: 'cancelled' }
      const { promise, resolve, reject } = Promise.withResolvers<PromptResult>()
      const turn: Turn = { cancelled: false, settled: false, finishing: false, resolve, reject }
      live.turn = turn
      this.events.beginTurn()
      live.rpc.request('prompt', promptOf(blocks), { timeoutMs: PROMPT_ACK_MS }).then(
        (ack) => {
          // 扩展命令就地处理完（pi：handled；omp：agentInvoked:false）：不会有后续事件，本轮直接收尾
          const a = rec(ack)
          if (a.disposition === 'handled' || a.agentInvoked === false) void this.finish(live, turn)
        },
        // 当场失败（没有可用模型等）：错误原样作为本轮的失败原因
        (err: unknown) => this.settle(live, turn, new Error(errText(err))),
      )
      return await promise
    } finally {
      release()
    }
  }

  private onEvent(live: Live, ev: PiEvent): void {
    // 被关掉的旧进程的晚到事件：不落到新进程的一轮上
    if (this.live !== live) return
    const turn = live.turn
    switch (ev.type) {
      case 'agent_settled':
        // pi：会话不会再自己往下跑了（agent_end 之后还可能有重试 / 压缩 / 排队消息，不能按它收尾）
        if (this.host.dialect === 'pi' && turn) void this.finish(live, turn, ev.aborted)
        return
      case 'prompt_result':
        if (!turn) return
        turn.status = ev.status
        if (ev.error?.message) turn.error = ev.error.message
        // omp：回合结束不等于会话静止（后台子代理跑完还会再起一段），静止了才收尾
        if (ev.sessionSettled) void this.finish(live, turn)
        return
      case 'session_settled':
        if (turn) void this.finish(live, turn)
        return
      default:
        this.events.handle(ev)
    }
  }

  /** 收尾：结局按「是否取消 → omp 的回合结局 → 最后一条 assistant 消息」判；取一次上下文占用再交出去 */
  private async finish(live: Live, turn: Turn, aborted = false): Promise<void> {
    if (turn.settled || turn.finishing) return
    turn.finishing = true
    const last = this.events.lastStop
    const usage = this.events.turnUsage
    let outcome: PromptResult | Error
    if (turn.cancelled || aborted || turn.status === 'aborted' || (!turn.status && last?.stopReason === 'aborted')) outcome = { stopReason: 'cancelled' }
    else if (turn.status === 'error') outcome = new Error(turn.error || last?.errorMessage || `${this.host.cfg.id} 本轮失败`)
    else if (last?.stopReason === 'error') outcome = new Error(last.errorMessage || `${this.host.cfg.id} 本轮失败`)
    else outcome = { stopReason: last?.stopReason === 'length' ? 'max_tokens' : 'end_turn' }
    if (!(outcome instanceof Error)) {
      await this.reportContext(live)
      this.host.emit({ type: 'info', info: { stopReason: outcome.stopReason, ...(usage ? { usage } : {}) }, sessionId: this.id })
      if (usage) outcome = { ...outcome, usage }
    }
    this.settle(live, turn, outcome)
  }

  /** 上下文占用：pi 在 get_session_stats，omp 在 get_state。取不到不报 */
  private async reportContext(live: Live): Promise<void> {
    if (!live.rpc.alive) return
    try {
      const data =
        this.host.dialect === 'pi'
          ? await live.rpc.request('get_session_stats', {}, { timeoutMs: STATS_TIMEOUT_MS })
          : await live.rpc.request('get_state', {}, { timeoutMs: STATS_TIMEOUT_MS })
      const ctx = rec(data).contextUsage as ContextUsage | undefined
      if (ctx && typeof ctx.tokens === 'number' && ctx.contextWindow > 0) {
        this.host.emit({ type: 'usage', used: ctx.tokens, size: ctx.contextWindow, sessionId: this.id })
      }
    } catch {
      // 只是信息
    }
  }

  private settle(live: Live, turn: Turn, outcome: PromptResult | Error): void {
    if (turn.settled) return
    turn.settled = true
    if (turn.timer) clearTimeout(turn.timer)
    if (live.turn === turn) live.turn = null
    this.events.endTurn(!(outcome instanceof Error) && outcome.stopReason === 'cancelled')
    if (outcome instanceof Error) turn.reject(outcome)
    else turn.resolve(outcome)
  }

  /** 停止这一轮：打标记（之后到的任何收尾都按取消）→ abort（应答在收尾事件之后才回）。迟迟不收尾就按取消结束并关掉进程 */
  cancel(): void {
    this.cancelGen++
    const live = this.live
    const turn = live?.turn
    if (!live || !turn || turn.settled) return
    turn.cancelled = true
    live.rpc.request('abort', {}, { timeoutMs: FORCE_CANCEL_MS }).catch(() => {})
    turn.timer ??= setTimeout(() => {
      if (turn.settled) return
      this.settle(live, turn, { stopReason: 'cancelled' })
      // 卡死的进程留着，它晚到的收尾会被当成下一轮的；关掉它，下一轮按会话记录重起
      if (this.live === live) this.close()
    }, FORCE_CANCEL_MS)
    turn.timer.unref?.()
  }

  /** 停掉一个子代理（omp）：句柄是那一步的子代理 id，停的是这一步起的全部子代理，主回合照常 */
  stopSubagent(handle: string): boolean {
    const live = this.live
    const ids = this.events.liveSubagents(handle)
    if (!live || ids.length === 0) return false
    for (const subagentId of ids) {
      live.rpc
        .request('cancel_subagent', { subagentId })
        .catch((err: unknown) => console.error(`[omp] ${this.host.cfg.id} 停止子代理 ${subagentId} 失败：${errText(err)}`))
    }
    return true
  }
}
