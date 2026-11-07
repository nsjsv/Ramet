// ---------- Codex 原生驱动：经 `codex app-server`（stdio JSON-RPC）直接驱动用户本机的 codex ----------
// 一个实例 = 一个 agent 配置（本机或 connector 上）= 一个 app-server 进程，承载这个 agent 的全部线程（会话）。
// 线程的 MCP 配置经 thread/start | thread/resume 的 config 覆盖按线程注入，实测只对该线程生效，所以进程可以共享。
// 沿用用户自己的 codex：登录、默认模型、审批策略、config.toml 都是它自己的；只有用户在 Ramet 里选过的值才作为回合覆盖带上。
// 审批 / 会话级状态 / 在飞计数的规则在 DriverBase，这里只管协议。

import { existsSync } from 'node:fs'
import { pageToolServer, type PageTool } from '../../../page-read.js'
import type { AgentConfig, ConfigOption, PromptBlock, PromptResult, TurnUsage } from '../../types.js'
import { DriverBase } from '../base.js'
import { cliUnavailable, probeVersion } from '../cli-version.js'
import type { SessionPort } from '../session-port.js'
import { rec, str } from '../tool-text.js'
import { CodexThreadConfig } from './config.js'
import { CodexEvents } from './events.js'
import { CodexPermissions } from './permissions.js'
import type {
  JsonValue,
  McpServerConfig,
  Model,
  ModelListResponse,
  ServerNotifications,
  ThreadOpenResponse,
  ThreadResumeParams,
  ThreadStartParams,
  TokenUsageBreakdown,
  TurnStartParams,
  UserInput,
} from './protocol.js'
import { CodexRpc } from './rpc.js'
import { codexSessionPort, ownRollout } from './session-port.js'

/** 握手上限：app-server 冷启动（读配置、登录态）慢的机器上也够；过了当它起不来 */
export const INITIALIZE_TIMEOUT_MS = 60_000
/** 取消后等 codex 收尾（turn/interrupt 正常很快就有 turn/completed）的上限：过了就当它卡住了，本轮按取消收尾，
 *  这一回合之后的通知一律丢掉。进程是这个 agent 所有会话共用的，不能为一轮卡住把它杀掉 */
export const FORCE_CANCEL_MS = 30_000
/** Ramet 注入的页面工具在 codex 里的服务名。用户配置里有同名服务时，codex 会把两份按字段深合并（用户的 url 混进我们的 command），
 *  所以撞名就换一个 */
const MCP_NAME = 'ramet'
const MCP_FALLBACK = 'ramet-page'
/** model/list 最多翻这么多页：清单一页就几十个，翻不完说明 codex 在兜圈子 */
const MODEL_PAGES = 10

type Turn = {
  /** codex 的回合 id：turn/start 应答或这一回合的第一条通知带来，先到先用 */
  id: string | null
  cancelled: boolean
  interrupted: boolean
  settled: boolean
  resolve: (r: PromptResult) => void
  reject: (err: Error) => void
  timer?: ReturnType<typeof setTimeout>
  usage?: TurnUsage
  /** codex 报的错误（error 通知，不再重试的那种）：回合以 failed 收尾时用它当原因 */
  error?: string
}

type Thread = {
  id: string
  /** 本进程已经加载着这个线程（start 或 resume 过）：再 resume 会被当成重新挂上、忽略新的 config */
  loaded: boolean
  /** 前一轮的收尾：同一线程的下一轮排在它后面。codex 遇到在跑的回合会把新输入并进去，两条 prompt 只有一个收尾 */
  chain: Promise<void>
  /** 每次取消加一：排着队、还没发出去的 prompt 看到它变了就直接按取消收尾 */
  cancelGen: number
  turn: Turn | null
  /** 被强制收尾的回合：之后到的通知丢掉，不落到下一轮头上 */
  stale: Set<string>
  /** 模型 / 推理强度 / 权限：codex 报的当前值 + 用户在 Ramet 里选过的覆盖（下一个 turn/start 带上）。线程打开时建 */
  config: CodexThreadConfig | null
}

/** 脚本（测试用的假 CLI、npm 装的 .js 入口）不一定有执行位：用当前 node 跑 */
function spawnSpec(cfg: AgentConfig): { command: string; args: string[] } {
  const args = cfg.args?.includes('app-server') ? cfg.args : [...(cfg.args ?? []), 'app-server']
  return /\.[cm]?js$/.test(cfg.command) ? { command: process.execPath, args: [cfg.command, ...args] } : { command: cfg.command, args }
}

/** PromptBlock → codex 的用户输入。引用页的正文作为文字附件（`<context ref>`，与 Claude 驱动同一写法）；图片走 data URL */
export function userInput(blocks: PromptBlock[]): UserInput[] {
  const input: UserInput[] = []
  const context: UserInput[] = []
  for (const b of blocks) {
    if (b.type === 'text') input.push({ type: 'text', text: b.text, text_elements: [] })
    else if (b.type === 'image') input.push({ type: 'image', url: `data:${b.mimeType};base64,${b.data}` })
    else {
      input.push({ type: 'text', text: b.uri, text_elements: [] })
      const title = b.title ? ` title="${b.title.replace(/"/g, "'")}"` : ''
      context.push({ type: 'text', text: `\n<context ref="${b.uri}"${title}>\n${b.text}\n</context>`, text_elements: [] })
    }
  }
  return [...input, ...context]
}

/** Ramet 的页面工具 → codex 的 mcp_servers 覆盖（按名字的表）。taken = 用户配置里已有的服务名 */
export function mcpServersOf(tools: PageTool[], taken: ReadonlySet<string>): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {}
  const free = (name: string) => !taken.has(name) && !(name in out)
  for (const tool of tools) {
    const s = pageToolServer(tool)
    let name = free(MCP_NAME) ? MCP_NAME : MCP_FALLBACK
    for (let i = 2; !free(name); i++) name = `${MCP_FALLBACK}-${i}`
    out[name] = { command: s.command, args: s.args, env: Object.fromEntries(s.env.map((e) => [e.name, e.value])) }
  }
  return out
}

/** codex 的 token 明细 → TurnUsage。codex 的 inputTokens 含缓存命中的部分，拆开记 */
function usageOf(b: TokenUsageBreakdown): TurnUsage {
  return {
    total: b.totalTokens,
    input: b.inputTokens - b.cachedInputTokens,
    output: b.outputTokens,
    cacheRead: b.cachedInputTokens,
    cacheWrite: b.cacheWriteInputTokens,
    thought: b.reasoningOutputTokens,
  }
}

function addUsage(a: TurnUsage | undefined, b: TurnUsage): TurnUsage {
  if (!a) return b
  const sum = (x?: number, y?: number) => (x ?? 0) + (y ?? 0)
  return {
    total: a.total + b.total,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: sum(a.cacheRead, b.cacheRead),
    cacheWrite: sum(a.cacheWrite, b.cacheWrite),
    thought: sum(a.thought, b.thought),
  }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class CodexDriver extends DriverBase {
  private rpc: CodexRpc | null = null
  private handshake: Promise<void> | null = null
  private handshaken = false
  private stopped = false
  private readonly threads = new Map<string, Thread>()
  private readonly events = new CodexEvents((ev) => this.emit(ev))
  private readonly permissions = new CodexPermissions({
    restricted: (sessionId) => this.restricted.has(sessionId),
    nextId: () => this.nextPermissionId(),
    hold: (event, settle, signal, turnOf) => this.hold(event, settle, signal, turnOf),
    inTurn: (sessionId) => this.inTurn(sessionId),
    faceOf: (itemId) => this.events.faceOf(itemId),
  })
  /** 本机 codex 可选的模型（model/list）：进程里所有线程共用一份，第一次开线程时取 */
  private models: Model[] = []
  private modelsLoad: Promise<void> | null = null
  override readonly sessionPort: SessionPort

  constructor(
    protected readonly cfg: AgentConfig,
    /** app-server 进程的工作目录（connector 上是本机默认目录）；各线程另有自己的 cwd */
    private readonly spawnCwd?: string,
  ) {
    super()
    this.sessionPort = codexSessionPort(cfg.env)
  }

  protected get connected(): boolean {
    return this.handshaken && this.rpc !== null && this.rpc.alive
  }

  protected get spawned(): boolean {
    return this.rpc !== null || this.handshake !== null
  }

  // ---------- 进程 ----------

  /** 起 app-server 并握手（打开实验 API：按路径恢复与提问都要它）。并行调用共享同一次握手；失败即回收，下一次重新起 */
  ready(): Promise<void> {
    if (this.dead) return Promise.reject(new Error(`agent ${this.cfg.id} 已停止`))
    if (this.handshaken) return Promise.resolve()
    return (this.handshake ??= this.connect().catch((err: unknown) => {
      // 握手没成：进程可能还活着，不杀掉就是 alive 的僵尸
      this.kill()
      throw err
    }))
  }

  private async connect(): Promise<void> {
    // 版本取不到不拦（只是信息，真起不来时下面会报）；取到了且太旧就别起：实验字段与提问都依赖这一代的协议
    const why = cliUnavailable('codex', await probeVersion(this.cfg.cli ?? this.cfg.command, this.cfg.env))
    if (why) throw new Error(`${this.cfg.id}：${why}`)
    if (this.dead) throw new Error(`agent ${this.cfg.id} 已停止`)
    const { command, args } = spawnSpec(this.cfg)
    const rpc = new CodexRpc({
      id: this.cfg.id,
      command,
      args,
      ...(this.cfg.env ? { env: this.cfg.env } : {}),
      ...(this.spawnCwd ? { cwd: this.spawnCwd } : {}),
      onRequest: (method, params, signal) => this.onRequest(method, params, signal),
      onNotification: (n) => this.onNotification(n),
      onExit: (info) => this.onExit(rpc, info.reason, info.crashed),
    })
    this.rpc = rpc
    await rpc.request(
      'initialize',
      { clientInfo: { name: 'ramet', title: null, version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } },
      { timeoutMs: INITIALIZE_TIMEOUT_MS },
    )
    rpc.notify('initialized')
    // 握手期间被 kill 了：不能再标成连上
    if (this.dead || this.rpc !== rpc) throw new Error(`agent ${this.cfg.id} 已停止`)
    this.handshaken = true
  }

  private live(): CodexRpc {
    const rpc = this.rpc
    if (!rpc || this.dead) throw new Error(`agent ${this.cfg.id} 已停止`)
    return rpc
  }

  /** 进程没了（崩溃或被 kill）：在飞的回合收尾、待批收掉，之后由上层重建适配器（下一轮 resume 同一个线程） */
  private onExit(rpc: CodexRpc, reason: string, crashed: boolean): void {
    if (this.rpc !== rpc) return
    this.dead = true
    this.handshaken = false
    this.settleAll(reason)
    this.cancelAllPending()
    if (crashed && !this.stopped) console.error(`[codex] ${this.cfg.id}：${reason}`)
  }

  private settleAll(reason: string): void {
    for (const th of this.threads.values()) {
      const turn = th.turn
      if (turn) this.settle(th, turn, turn.cancelled ? { stopReason: 'cancelled' } : new Error(reason))
    }
  }

  kill(): void {
    this.stopped = true
    this.dead = true
    this.handshaken = false
    this.rpc?.kill()
    this.settleAll(`agent ${this.cfg.id} 已停止`)
    this.cancelAllPending()
  }

  // ---------- 线程 ----------

  private track(id: string): Thread {
    let th = this.threads.get(id)
    if (!th) {
      th = { id, loaded: false, chain: Promise.resolve(), cancelGen: 0, turn: null, stale: new Set(), config: null }
      this.threads.set(id, th)
      this.events.addSession(id)
    }
    if (!this.sessionConfigs.has(id)) this.sessionConfigs.set(id, [])
    return th
  }

  /** 取一次模型清单。取不到（没登录、网络问题）不影响开线程：配置项里只剩当前模型，下次开线程再试 */
  private loadModels(): Promise<void> {
    return (this.modelsLoad ??= (async () => {
      const models: Model[] = []
      let cursor: string | null = null
      for (let i = 0; i < MODEL_PAGES; i++) {
        const page: ModelListResponse = await this.live().request('model/list', { cursor, includeHidden: false })
        models.push(...(Array.isArray(page.data) ? page.data : []))
        cursor = page.nextCursor
        if (!cursor) break
      }
      this.models = models.filter((m) => m && typeof m.id === 'string' && m.id)
    })().catch((err: unknown) => {
      this.modelsLoad = null
      console.error(`[codex] ${this.cfg.id} 取模型清单失败：${errText(err)}`)
    }))
  }

  /** 线程打开了（start / resume 的应答）：登记线程、按 codex 报的实际设置算配置项。重新打开的线程保留用户选过的覆盖 */
  private opened(res: ThreadOpenResponse): Thread {
    const th = this.track(res.thread.id)
    th.loaded = true
    const settings = { model: res.model ?? null, effort: res.reasoningEffort ?? null, approvalPolicy: res.approvalPolicy ?? null, sandbox: res.sandbox ?? null }
    if (th.config) th.config.note(this.models, settings)
    else th.config = new CodexThreadConfig(settings)
    if (!this.restricted.has(th.id)) this.sessionConfigs.set(th.id, th.config.options(this.models))
    return th
  }

  private publishConfig(th: Thread): ConfigOption[] {
    const options = th.config?.options(this.models) ?? []
    this.sessionConfigs.set(th.id, options)
    this.emit({ type: 'config', options, sessionId: th.id })
    return options
  }

  /** 用户 config.toml 里的 MCP 服务名（按 cwd 合并项目级配置）。strict：取不到就抛（受限会话靠它逐个关掉用户的服务，不能猜） */
  private async userMcpNames(cwd: string, strict: boolean): Promise<Set<string>> {
    try {
      const { config } = await this.live().request('config/read', { cwd })
      return new Set(Object.keys(rec(config.mcp_servers)))
    } catch (err) {
      if (strict) throw err
      return new Set()
    }
  }

  private async toolsConfig(cwd: string, tools: PageTool[]): Promise<Pick<ThreadStartParams, 'config'>> {
    if (tools.length === 0) return {}
    const servers = mcpServersOf(tools, await this.userMcpNames(cwd, false))
    return { config: { mcp_servers: servers as unknown as JsonValue } }
  }

  async newSession(cwd: string, tools: PageTool[] = []): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    await this.ready()
    const [res] = await Promise.all([this.toolsConfig(cwd, tools).then((c) => this.live().request('thread/start', { cwd, ...c })), this.loadModels()])
    const th = this.opened(res)
    return { sessionId: th.id, configOptions: this.sessionConfigs.get(th.id) ?? [] }
  }

  /** ⌘J：只读沙箱 + 不审批（需要审批的动作直接被拒）+ 不给环境 + 用户配置里的 MCP 逐个关掉
   *  （config 覆盖是深合并，给空表挡不住用户的服务）。受限标记在拿到线程 id 的同一个同步段里加上，codex 在第一轮之前不会发请求 */
  async newRestrictedSession(cwd: string): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    await this.ready()
    const names = await this.userMcpNames(cwd, true)
    const off: Record<string, McpServerConfig> = Object.fromEntries([...names].map((n) => [n, { enabled: false }]))
    const res = await this.live().request('thread/start', {
      cwd,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      environments: [],
      config: { mcp_servers: off as unknown as JsonValue },
    })
    this.restricted.add(res.thread.id)
    this.opened(res)
    return { sessionId: res.thread.id, configOptions: [] }
  }

  /** resume 带上这一次的工具配置（MCP 凭证按发起人 / 页面现签，每次都不一样）。本进程已加载的线程 resume 只是重新挂上、
   *  不认新 config，所以先 unsubscribe 让它卸载再 resume。codex 那边没有这个线程的记录（从没跑过一轮的线程不落盘）时抛错，
   *  调用方据此新建会话、全文重放 */
  async loadSession(sessionId: string, cwd: string, tools: PageTool[] = []): Promise<{ configOptions: ConfigOption[] }> {
    await this.ready()
    const rpc = this.live()
    const existing = this.threads.get(sessionId)
    // 正在跑的一轮不能卸载：沿用当前配置，下一次加载再换
    if (existing?.turn) return { configOptions: this.sessionConfigs.get(sessionId) ?? [] }
    if (existing?.loaded) {
      existing.loaded = false
      await rpc.request('thread/unsubscribe', { threadId: sessionId })
    }
    // 从别的机器下发过来的会话写在 connector 自管的目录里（session-port.ts）：按文件恢复，不碰 codex 自己的目录与索引
    const path = existsSync(ownRollout(sessionId)) ? ownRollout(sessionId) : null
    const params: ThreadResumeParams = { threadId: sessionId, cwd, excludeTurns: true, ...(path ? { path } : {}), ...(await this.toolsConfig(cwd, tools)) }
    const [res] = await Promise.all([
      rpc.request('thread/resume', params).catch((err: unknown) => {
        // path 是实验字段：这一版 codex 不认就说清楚，上层照常降级为新建会话 + 全文重放
        throw path ? new Error(`${this.cfg.id} 没能按会话文件恢复（这一版 codex 可能不支持）：${errText(err)}`) : err
      }),
      this.loadModels(),
    ])
    const th = this.opened(res)
    return { configOptions: this.sessionConfigs.get(th.id) ?? [] }
  }

  /** 彻底放掉这个线程：让 codex 卸载它（之后 resume 一定按磁盘上的记录重新加载），本进程里的记录一并丢掉。
   *  等卸载的应答再返回：调用方紧接着会改写磁盘上的记录再 load，卸载没完成就 load 会挂回内存里的旧线程 */
  override async closeSession(sessionId: string): Promise<void> {
    this.cancelPending(sessionId)
    const th = this.threads.get(sessionId)
    if (th?.loaded && this.rpc?.alive) {
      th.loaded = false
      await this.rpc.request('thread/unsubscribe', { threadId: sessionId })
    }
    this.threads.delete(sessionId)
    this.events.dropSession(sessionId)
    super.discardSession(sessionId)
  }

  /** 改一项配置：记进这个线程的覆盖，下一个 turn/start 带上（运行中的这一轮不变）。不认识的项 / 值抛错 */
  async setConfigOption(sessionId: string, configId: string, value: string): Promise<ConfigOption[]> {
    const th = this.threads.get(sessionId)
    if (!th?.config || this.restricted.has(sessionId)) throw new Error(`Unsupported session ${sessionId}：先 newSession / loadSession`)
    if (!th.config.set(this.models, configId, value)) return this.sessionConfigs.get(sessionId) ?? []
    return this.publishConfig(th)
  }

  override discardSession(sessionId: string): void {
    const th = this.threads.get(sessionId)
    if (th?.loaded && this.rpc?.alive) {
      // 用完即弃的会话让 codex 卸载掉，不在共享进程里越攒越多
      this.rpc.request('thread/unsubscribe', { threadId: sessionId }).catch(() => {})
    }
    this.threads.delete(sessionId)
    this.events.dropSession(sessionId)
    super.discardSession(sessionId)
  }

  // ---------- 一轮 ----------

  async prompt(sessionId: string, blocks: PromptBlock[]): Promise<PromptResult> {
    await this.ready()
    const th = this.threads.get(sessionId)
    // 这个进程里没有这个会话，调用方据此先 load 再试
    if (!th) throw new Error(`Unsupported session ${sessionId}：先 newSession / loadSession`)
    this.beginTurn(sessionId)
    try {
      return await this.runTurn(th, blocks)
    } finally {
      this.endTurn(sessionId)
    }
  }

  private async runTurn(th: Thread, blocks: PromptBlock[]): Promise<PromptResult> {
    const gen = th.cancelGen
    const prev = th.chain
    let release!: () => void
    th.chain = new Promise<void>((resolve) => (release = resolve))
    try {
      await prev
      if (gen !== th.cancelGen) return { stopReason: 'cancelled' }
      const rpc = this.live()
      const { promise, resolve, reject } = Promise.withResolvers<PromptResult>()
      const turn: Turn = { id: null, cancelled: false, interrupted: false, settled: false, resolve, reject }
      th.turn = turn
      this.events.beginTurn(th.id)
      const params: TurnStartParams = { threadId: th.id, input: userInput(blocks), ...(this.restricted.has(th.id) ? {} : th.config?.overrides) }
      rpc.request('turn/start', params).then(
        (r) => {
          if (turn.settled) return void th.stale.add(r.turn.id)
          turn.id ??= r.turn.id
          if (turn.cancelled) this.interrupt(th, turn)
        },
        (err: unknown) => this.settle(th, turn, new Error(errText(err))),
      )
      return await promise
    } finally {
      release()
    }
  }

  private settle(th: Thread, turn: Turn, outcome: PromptResult | Error): void {
    if (turn.settled) return
    turn.settled = true
    if (turn.timer) clearTimeout(turn.timer)
    if (th.turn === turn) th.turn = null
    this.events.endTurn(th.id, !(outcome instanceof Error) && outcome.stopReason === 'cancelled')
    if (outcome instanceof Error) turn.reject(outcome)
    else turn.resolve(outcome)
  }

  private interrupt(th: Thread, turn: Turn): void {
    if (!turn.id || turn.interrupted || turn.settled) return
    turn.interrupted = true
    // 回合恰好已经结束时 codex 回错误：没什么可做的
    this.rpc?.request('turn/interrupt', { threadId: th.id, turnId: turn.id }).catch(() => {})
  }

  /** 停止这一轮：打标记（之后到的任何收尾都按取消）→ 中断 → 收掉该会话的待批。迟迟不收尾就按取消结束、丢掉这一回合之后的通知 */
  cancel(sessionId: string): void {
    const th = this.threads.get(sessionId)
    if (th) {
      th.cancelGen++
      const turn = th.turn
      if (turn && !turn.settled) {
        turn.cancelled = true
        this.interrupt(th, turn)
        turn.timer ??= setTimeout(() => {
          if (turn.settled) return
          if (turn.id) th.stale.add(turn.id)
          this.settle(th, turn, { stopReason: 'cancelled' })
        }, FORCE_CANCEL_MS)
        turn.timer.unref?.()
      }
    }
    this.cancelPending(sessionId)
  }

  /** 停掉一个子代理：句柄是子线程 id（步骤视图里的 handle），中断它正在跑的回合，主回合照常 */
  killCommand(sessionId: string, handle: string): boolean {
    const turnId = this.events.childTurn(sessionId, handle)
    if (!turnId || !this.rpc?.alive) return false
    this.rpc.request('turn/interrupt', { threadId: handle, turnId }).catch((err: unknown) => console.error(`[codex] 停止子代理 ${handle} 失败：${errText(err)}`))
    return true
  }

  // ---------- codex 发来的 ----------

  private onRequest(method: string, params: unknown, signal: AbortSignal): unknown {
    const threadId = str(rec(params).threadId)
    const sessionId = this.events.sessionOf(threadId) ?? threadId
    return this.permissions.handle(sessionId, method, params, signal)
  }

  /** 这条通知属于线程当前的回合吗。回合 id 还没拿到时（通知先于 turn/start 的应答到达）用它的 */
  private ownTurn(th: Thread, turnId: string): boolean {
    const turn = th.turn
    if (!turn || th.stale.has(turnId)) return false
    if (turn.id === null) {
      turn.id = turnId
      if (turn.cancelled) this.interrupt(th, turn)
    }
    return turn.id === turnId
  }

  private onNotification(n: { method: string; params: unknown }): void {
    const p = rec(n.params)
    const th = this.threads.get(str(p.threadId))
    // 子线程（子代理）与 thread/started 等由翻译器按归属处理
    if (!th) return this.events.handle(n.method, n.params)
    const turnId = n.method === 'turn/started' || n.method === 'turn/completed' ? str(rec(p.turn).id) : str(p.turnId)
    if (turnId && !this.ownTurn(th, turnId)) return
    switch (n.method) {
      case 'turn/completed':
        return this.completed(th, n.params as ServerNotifications['turn/completed'])
      case 'thread/tokenUsage/updated':
        return this.onUsage(th, n.params as ServerNotifications['thread/tokenUsage/updated'])
      case 'thread/settings/updated': {
        const s = (n.params as ServerNotifications['thread/settings/updated']).threadSettings
        if (!s || !th.config || this.restricted.has(th.id)) return
        const changed = th.config.note(this.models, { model: s.model, effort: s.effort, approvalPolicy: s.approvalPolicy, sandbox: s.sandboxPolicy })
        if (changed) this.publishConfig(th)
        return
      }
      case 'error': {
        const e = n.params as ServerNotifications['error']
        if (!e.willRetry && th.turn) th.turn.error = e.error?.message
        else this.emit({ type: 'info', info: { acp: { retry: e.error?.message ?? null } }, sessionId: th.id })
        return
      }
      case 'warning':
        if (th.turn) this.emit({ type: 'info', info: { acp: { warning: str(p.message) } }, sessionId: th.id })
        return
      default:
        this.events.handle(n.method, n.params)
    }
  }

  private onUsage(th: Thread, p: ServerNotifications['thread/tokenUsage/updated']): void {
    const last = p.tokenUsage?.last
    if (!last || !th.turn) return
    th.turn.usage = addUsage(th.turn.usage, usageOf(last))
    const size = p.tokenUsage.modelContextWindow
    // 上下文占用 = 最近一次请求的 token 数
    if (size && size > 0) this.emit({ type: 'usage', used: last.totalTokens, size, sessionId: th.id })
  }

  private completed(th: Thread, p: ServerNotifications['turn/completed']): void {
    const turn = th.turn
    if (!turn) return
    const status = p.turn?.status
    const usage = turn.usage
    if (turn.cancelled || status === 'interrupted') {
      this.emit({ type: 'info', info: { stopReason: 'cancelled', ...(usage ? { usage } : {}) }, sessionId: th.id })
      return this.settle(th, turn, { stopReason: 'cancelled', ...(usage ? { usage } : {}) })
    }
    if (status === 'failed') return this.settle(th, turn, new Error(p.turn.error?.message || turn.error || 'codex 本轮失败'))
    this.emit({ type: 'info', info: { stopReason: 'end_turn', ...(usage ? { usage } : {}) }, sessionId: th.id })
    this.settle(th, turn, { stopReason: 'end_turn', ...(usage ? { usage } : {}) })
  }
}
