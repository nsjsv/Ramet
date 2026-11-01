// ---------- 驱动公共层：与协议无关的执行端状态与规则 ----------
// 每个驱动（各家原生协议）都是「执行端」：会话级状态（命令 / 配置 / 待批审批）的唯一事实源，
// 闲置回收读它的 busy，中心镜像用它的 sessionState() 播种。这些规则各驱动必须一模一样，
// 各写一份必然漂移，所以收在这里；子类只管协议本身（起进程、握手、收发消息、把原生事件翻成 AgentEvent）。

import { EventEmitter } from 'node:events'
import type { PageTool } from '../../page-read.js'
import type {
  AgentAdapter,
  AgentCommand,
  AgentConfig,
  AgentEvent,
  AskContent,
  ConfigOption,
  PermissionEvent,
  PromptBlock,
  PromptResult,
  SessionState,
} from '../types.js'
import type { SessionPort } from './session-port.js'

type PendingPermission = {
  /** 按选项结束这条请求（null = 取消）：协议应答 / 写文件闸门的落盘或拒绝 / 提问的答案都在这里。
   *  只在 resolvePending 里调用，别处不许直接碰 */
  settle: (optionId: string | null, content?: AskContent) => void
  event: PermissionEvent
  /** 提问到达时这个会话有在飞的 prompt：那一轮结束时还没答就按取消结束（提问不比所在的一轮活得久；
   *  有的 agent 超时后不通知客户端，不收掉就永远挂着）。普通审批没有这个标记：后台审批本来就可以比一轮活得久 */
  turnOf?: string
}

export abstract class DriverBase implements AgentAdapter {
  private readonly emitter = new EventEmitter()
  private readonly pending = new Map<string, PendingPermission>()
  private nextRequestId = 0
  /** 在飞 prompt 的会话数（同一进程可承载多个会话）：闲置回收的唯一"忙"判据（见 types.AgentAdapter.busy） */
  private inFlight = 0
  /** sessionId → 该会话在飞的 prompt 数（提问的 turnOf 据此判定、归零时收掉） */
  private readonly sessionPrompts = new Map<string, number>()
  /** 进程没了 / 被主动 kill：之后不再复用，下一次要新建适配器 */
  protected dead = false
  /** sessionId → 当前 config options（改配置 / agent 推送配置变化后更新） */
  protected readonly sessionConfigs = new Map<string, ConfigOption[]>()
  /** sessionId → 原生斜杠命令。不论有没有监听者都缓存：命令在会话建立后才推，那时监听者（轮次 / 中心镜像）
   *  往往还没绑上，之后的 bind 用 sessionState() 补齐 */
  protected readonly sessionCommands = new Map<string, AgentCommand[]>()
  /** 随手 AI 的受限会话：agent 要读文件 / 写文件 / 开终端一律拒绝，审批自动拒绝（不进 pending、不发事件）。
   *  会话级事件也不对外：knownSessions 不含它们，connector 的常驻监听据 isRestricted 跳过 */
  protected readonly restricted = new Set<string>()

  /** 会话文件端口（换机器搬会话用，connector/session-files.ts）：只有原生驱动有；没有 = 这家不支持搬，上层退回新建会话 + 全文重放 */
  readonly sessionPort?: SessionPort

  constructor(protected readonly cfg: AgentConfig) {
    this.emitter.setMaxListeners(0)
  }

  // ---------- 子类回答的两个事实 ----------

  /** 连接可用。握手失败 / 超时时子类必须把它清成 false（进程活着也一样），否则留下 alive 的僵尸 */
  protected abstract get connected(): boolean
  /** 起过进程（或开始过握手） */
  protected abstract get spawned(): boolean

  /** 能复用：没死、握手成功。只按"进程在"判活会在握手超时后留下 alive 的僵尸，之后每个请求都挂在死的握手上 */
  get alive(): boolean {
    return !this.dead && this.connected
  }

  /** 有在飞 prompt 或有待批审批：审批期间进程不许被闲置回收（回收 = 审批永远答不到） */
  get busy(): boolean {
    return this.inFlight > 0 || this.pending.size > 0
  }

  /** 刚建出来、还没起过进程也没死过：第一次 ready() 才会 spawn。适配器池里这种对象不是僵尸，不能当成死的杀掉重建
   *  （并行的两个调用方先后 ensureAdapter、各自再去 newSession 之前有 await：第二个把第一个杀了，第一个就收到「agent 已停止」） */
  get pristine(): boolean {
    return !this.dead && !this.spawned
  }

  /** 池里的这个适配器能接着用：握手成功、还没起过（pristine）、或正在起（ready() 在飞）。握手 / 检查失败时各驱动都会 kill()，
   *  所以没死就不是僵尸。只认 alive 的话，并行的调用方先后 ensureAdapter 时，后到的会把正在握手的那个杀掉重建，先到的收到「agent 已停止」 */
  get reusable(): boolean {
    return !this.dead
  }

  // ---------- 协议相关：子类实现 ----------

  abstract ready(): Promise<void>
  abstract newSession(cwd: string, tools?: PageTool[]): Promise<{ sessionId: string; configOptions: ConfigOption[] }>
  /** 随手 AI 的受限会话（connector/quick.ts 用）：不给任何工具，之后的读写 / 终端 / 审批都被拒绝。
   *  受限标记必须在会话建立的同一个同步段里加进 restricted，agent 在 prompt 之前不会发这些请求 */
  abstract newRestrictedSession(cwd: string): Promise<{ sessionId: string; configOptions: ConfigOption[] }>
  abstract loadSession(sessionId: string, cwd: string, tools?: PageTool[]): Promise<{ configOptions: ConfigOption[] }>
  abstract setConfigOption(sessionId: string, configId: string, value: string): Promise<ConfigOption[]>
  abstract prompt(sessionId: string, blocks: PromptBlock[], runId?: string): Promise<PromptResult>
  abstract cancel(sessionId: string): void
  abstract killCommand(sessionId: string, handle: string): boolean
  abstract kill(): void

  /** 彻底放掉这个会话在本进程里的状态（进程 / 内存里的会话 / 缓存的配置与命令），之后 loadSession 一定重新从磁盘读。
   *  换机器把中心那份记录写到这台机器之前必须先调：不然驱动可能沿用内存里的旧会话，写进去的新记录不生效。
   *  缺省 = 收掉待批 + 丢掉会话（claude 关掉该会话的 query、pi / omp 杀掉该会话的进程，都在各自的 discardSession 里）；
   *  进程共享的驱动（codex）覆盖它 */
  async closeSession(sessionId: string): Promise<void> {
    this.cancelPending(sessionId)
    this.discardSession(sessionId)
  }

  /** 这个会话此刻有在飞的 prompt：connector 据此拒绝关闭 / 覆盖一个正在跑的会话的记录 */
  running(sessionId: string): boolean {
    return this.inTurn(sessionId)
  }

  // ---------- 监听者 ----------

  on(listener: (ev: AgentEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }

  protected emit(ev: AgentEvent): void {
    this.emitter.emit('event', ev)
  }

  // ---------- 会话级状态 ----------

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

  isRestricted(sessionId: string): boolean {
    return this.restricted.has(sessionId)
  }

  /** 丢掉一个受限会话在本适配器里的全部记录（用完即弃）。不通知 agent：agent 自己那边的会话记录由它自己管。
   *  子类有按会话存的东西要覆盖它并调 super */
  discardSession(sessionId: string): void {
    this.restricted.delete(sessionId)
    this.sessionConfigs.delete(sessionId)
    this.sessionCommands.delete(sessionId)
  }

  /** mode 变了：改写 config 里 category=mode 那一项的 currentValue，发一次 config 事件。
   *  该会话没有 mode 配置项（agent 没把 mode 暴露成 config option）就没有可改写的 */
  protected applyMode(sessionId: string, modeId: string): void {
    const configs = this.sessionConfigs.get(sessionId)
    const mode = configs?.find((o) => o.category === 'mode')
    if (!configs || !mode || mode.currentValue === modeId) return
    const options = configs.map((o) => (o === mode ? { ...o, currentValue: modeId } : o))
    this.sessionConfigs.set(sessionId, options)
    this.emit({ type: 'config', options, sessionId })
  }

  // ---------- 一轮的在飞计数 ----------

  /** prompt 开始（在 ready() 之后、发给 agent 之前）：长轮次全程不发请求，在飞期间不许被闲置回收 */
  protected beginTurn(sessionId: string): void {
    this.inFlight++
    this.sessionPrompts.set(sessionId, (this.sessionPrompts.get(sessionId) ?? 0) + 1)
  }

  /** prompt 结束（成功 / 出错 / 取消都必须调，放 finally）。该会话的 prompt 都结束了：
   *  这一轮里来的提问还没答的按取消结束（agent 超时后不通知我们的） */
  protected endTurn(sessionId: string): void {
    this.inFlight--
    const left = (this.sessionPrompts.get(sessionId) ?? 1) - 1
    if (left > 0) return void this.sessionPrompts.set(sessionId, left)
    this.sessionPrompts.delete(sessionId)
    this.turnsDone(sessionId)
    for (const [requestId, p] of [...this.pending]) {
      if (p.turnOf === sessionId) this.resolvePending(requestId, null)
    }
  }

  /** 该会话没有在飞的 prompt 了（子类清按轮记的东西）。在收掉本轮提问之前调 */
  protected turnsDone(_sessionId: string): void {}

  /** 这个会话此刻有在飞的 prompt（提问据此决定是否打 turnOf） */
  protected inTurn(sessionId: string): boolean {
    return (this.sessionPrompts.get(sessionId) ?? 0) > 0
  }

  // ---------- 审批 / 提问 ----------

  /** 审批 / 提问的 requestId：只在本进程内唯一（中心按 agentId + requestId 认同一条） */
  protected nextPermissionId(): string {
    return `perm-${this.nextRequestId++}`
  }

  /** 挂一条要人点头的请求并广播。agent 撤回（signal abort）→ 按取消结束：
   *  回应 agent（协作式取消，对方还在等我们的应答）并发 permission_resolved，卡片随之摘掉 */
  protected hold(event: PermissionEvent, settle: PendingPermission['settle'], signal: AbortSignal, turnOf?: string): void {
    this.pending.set(event.requestId, { event, settle, ...(turnOf ? { turnOf } : {}) })
    this.emit(event)
    if (signal.aborted) this.resolvePending(event.requestId, null)
    else signal.addEventListener('abort', () => this.resolvePending(event.requestId, null), { once: true })
  }

  respondPermission(requestId: string, optionId: string | null, content?: AskContent): boolean {
    return this.resolvePending(requestId, optionId, content)
  }

  /** 审批结束的唯一出口（有人答 / 停止该会话 / 进程退出 / agent 撤回 / 提问所在的一轮结束）：先摘掉、再应答 agent、最后发
   *  permission_resolved（镜像与前端据此移除）。没有超时，不会有别的路径结束它 */
  protected resolvePending(requestId: string, optionId: string | null, content?: AskContent): boolean {
    const p = this.pending.get(requestId)
    if (!p) return false
    this.pending.delete(requestId)
    p.settle(optionId, content)
    this.emit({ type: 'permission_resolved', requestId, sessionId: p.event.sessionId })
    return true
  }

  /** 停止该会话：只结束该会话的待批（协议要求客户端按取消应答）。
   *  不能结束整个进程的全部待批：否则停 A 页会拒掉 B 页同 agent 的审批 */
  protected cancelPending(sessionId: string): void {
    for (const [requestId, p] of [...this.pending]) {
      if (p.event.sessionId === sessionId) this.resolvePending(requestId, null)
    }
  }

  /** 进程没了：它的全部待批按取消结束（不可达的待批会让适配器永远 busy） */
  protected cancelAllPending(): void {
    for (const requestId of [...this.pending.keys()]) this.resolvePending(requestId, null)
  }
}
