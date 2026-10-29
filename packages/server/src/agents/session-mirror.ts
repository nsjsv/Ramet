// ---------- 会话镜像：按「页面 + agent」持有会话级状态（命令 / 配置 / 待批审批）----------
// 事实源是执行端（持有 ACP 连接的进程：本机 AcpAgent / connector 上的 AcpAgent），不论有没有监听者都缓存。
// 这里只是它的投影，也是中心唯一读这些状态的地方：
//   - 每个拿到 sessionId 的绑定点（prepare、turn 里 new/load、adopt、改配置）用执行端快照播种：bind()
//   - 之后由适配器上的常驻监听增量更新：listen()（ensureAdapter 时每个适配器装一次，按 sessionId 找页面）
//   - SSE 新订阅者先 replay() 全量，再接增量
// 审批只在这些时候结束：有人答、停止该会话、会话被换掉（bind 换了 sessionId）、适配器进程退出、
// connector 终态断开。没有超时；镜像里的移除只由执行端的 permission_resolved 驱动（bind / dropConnector 两处
// 是镜像自己宣布结束的例外，都会广播 resolved）。
// 带队的组员会话走单独的 worker 槽：同一个 agent 可以同时有主会话和多个组员会话，bind 的一个 agent 一个会话槽
// 会让它们互相取消审批，所以组员各占一个以 sessionId 为键的槽（只管待批审批，不管命令 / 配置，bindWorker）。
import { parseRemoteId } from './manager-types.js'
import { isSessionEvent, type AgentAdapter, type AgentCommand, type AgentEvent, type ConfigOption, type PermissionEvent, type SessionEvent } from './types.js'

/** 镜像只用适配器的这三个成员（读快照 / 答审批 / 听事件）：桩适配器不必实现整个 AgentAdapter */
export type MirrorAdapter = Pick<AgentAdapter, 'sessionState' | 'respondPermission' | 'on'>

type Entry = {
  sessionId: string
  commands: AgentCommand[]
  configs: ConfigOption[]
  approvals: Map<string, PermissionEvent>
}

/** 镜像不碰 manager / 数据库 / RunState，要什么从这里拿（同 ManagerHost） */
export type MirrorHost = {
  broadcast(pageId: string, ev: AgentEvent): void
  /** agent 侧改动的 config 值 → 页面级意图（pages.agent_session.configs），fire-and-forget */
  persist(pageId: string, agentId: string, values: Record<string, string>): void
  /** 这个 config id 此刻是本轮消息级覆盖（attrs.opts）的值，或轮末对它的还原：临时的，不能落成页面级意图 */
  overridden(pageId: string, agentId: string, configId: string): boolean
  /** 审批请求里的工具数据并入本轮 RunRecord 的同一个工具步骤（有 toolCallId 就与真实 tool_call 合并） */
  fold(pageId: string, agentId: string, ev: PermissionEvent): void
}

/** 带队的组员会话：只持有待批审批（命令 / 配置是主会话的事，组员的不广播，否则前端会把它当成页面上那个 agent 的） */
type Worker = { agentId: string; adapter: MirrorAdapter; approvals: Map<string, PermissionEvent> }

export class SessionMirror {
  /** pageId → agentId（catalog id）→ 条目 */
  private pages = new Map<string, Map<string, Entry>>()
  /** pageId → sessionId → 组员会话 */
  private workers = new Map<string, Map<string, Worker>>()

  constructor(private host: MirrorHost) {}

  /** 绑定点：用执行端快照整份替换，再把全量广播出去。
   *  换了会话（全文重放建新会话）时旧会话的待批一律按取消应答，否则不可达的待批会让进程永远 busy；
   *  旧条目里有、新快照里没有的待批（断线期间已结束）广播 resolved，前端据此移除 */
  bind(pageId: string, agentId: string, sessionId: string, adapter: MirrorAdapter): void {
    const state = adapter.sessionState(sessionId)
    let agents = this.pages.get(pageId)
    if (!agents) this.pages.set(pageId, (agents = new Map()))
    const prev = agents.get(agentId)
    const entry: Entry = {
      sessionId,
      commands: state.commands,
      configs: state.configs,
      approvals: new Map(state.approvals.map((a) => [a.requestId, a])),
    }
    agents.set(agentId, entry)
    for (const old of prev?.approvals.values() ?? []) {
      if (prev!.sessionId !== sessionId) adapter.respondPermission(old.requestId, null)
      if (!entry.approvals.has(old.requestId)) {
        this.host.broadcast(pageId, { type: 'permission_resolved', requestId: old.requestId, sessionId: old.sessionId, agentId })
      }
    }
    this.emit(agentId, entry, (ev) => this.host.broadcast(pageId, ev))
    for (const a of entry.approvals.values()) this.host.fold(pageId, agentId, a)
  }

  /** 带队的组员会话绑进来：它的待批审批照常进审批条 / 收件箱（事件带 agentId），但不占 agent 的主会话槽，
   *  同一个 agent 的主会话和别的组员会话的审批互不相干。返回释放函数：组员收尾时调用，该会话还挂着的待批按取消应答并广播 resolved */
  bindWorker(pageId: string, agentId: string, sessionId: string, adapter: MirrorAdapter): () => void {
    const worker: Worker = {
      agentId,
      adapter,
      approvals: new Map(adapter.sessionState(sessionId).approvals.map((a) => [a.requestId, a])),
    }
    let sessions = this.workers.get(pageId)
    if (!sessions) this.workers.set(pageId, (sessions = new Map()))
    sessions.set(sessionId, worker)
    for (const a of worker.approvals.values()) this.host.broadcast(pageId, { ...a, agentId })
    return () => {
      const mine = this.workers.get(pageId)
      if (mine?.get(sessionId) !== worker) return
      mine.delete(sessionId)
      if (mine.size === 0) this.workers.delete(pageId)
      for (const a of worker.approvals.values()) {
        adapter.respondPermission(a.requestId, null)
        this.host.broadcast(pageId, { type: 'permission_resolved', requestId: a.requestId, sessionId, agentId })
      }
    }
  }

  /** 适配器常驻监听：会话级事件按 sessionId 找页面，找不到就丢（之后的 bind 用执行端快照补齐，不会漏）。
   *  不需要退订：适配器被 kill / 丢弃时监听随它一起走 */
  listen(agentId: string, adapter: Pick<MirrorAdapter, 'on'>): void {
    adapter.on((ev) => {
      if (!isSessionEvent(ev) || !ev.sessionId) return
      for (const [pageId, agents] of this.pages) {
        const entry = agents.get(agentId)
        if (entry?.sessionId === ev.sessionId) this.apply(pageId, agentId, entry, ev)
      }
      for (const [pageId, sessions] of this.workers) {
        const worker = sessions.get(ev.sessionId)
        if (worker?.agentId === agentId) this.applyWorker(pageId, ev.sessionId, worker, ev)
      }
    })
  }

  /** 新订阅者的全量回放：每个已绑定 agent 的 commands / config / 每条待批（含组员会话的待批） */
  replay(pageId: string, send: (ev: AgentEvent) => void): void {
    for (const [agentId, entry] of this.pages.get(pageId) ?? []) this.emit(agentId, entry, send)
    for (const worker of this.workers.get(pageId)?.values() ?? []) {
      for (const a of worker.approvals.values()) send({ ...a, agentId: worker.agentId })
    }
  }

  approval(pageId: string, agentId: string, requestId: string): PermissionEvent | undefined {
    const main = this.pages.get(pageId)?.get(agentId)?.approvals.get(requestId)
    if (main) return main
    for (const worker of this.workers.get(pageId)?.values() ?? []) {
      if (worker.agentId === agentId && worker.approvals.has(requestId)) return worker.approvals.get(requestId)
    }
    return undefined
  }

  /** 全部页面上此刻待批的审批（收件箱聚合用的只读快照）。agentId 是 catalog id */
  allApprovals(): Array<{ pageId: string; agentId: string; event: PermissionEvent }> {
    const out: Array<{ pageId: string; agentId: string; event: PermissionEvent }> = []
    for (const [pageId, agents] of this.pages) {
      for (const [agentId, entry] of agents) {
        for (const event of entry.approvals.values()) out.push({ pageId, agentId, event })
      }
    }
    for (const [pageId, sessions] of this.workers) {
      for (const worker of sessions.values()) {
        for (const event of worker.approvals.values()) out.push({ pageId, agentId: worker.agentId, event })
      }
    }
    return out
  }

  configs(pageId: string, agentId: string): ConfigOption[] {
    return this.pages.get(pageId)?.get(agentId)?.configs ?? []
  }

  /** connector 终态断开（撤销 / 换 token）：它所有会话的待批不会再有人答，按结束处理并广播 */
  dropConnector(connectorId: string): void {
    for (const [pageId, agents] of this.pages) {
      for (const [agentId, entry] of agents) {
        if (parseRemoteId(agentId)?.connectorId !== connectorId) continue
        for (const a of entry.approvals.values()) {
          this.host.broadcast(pageId, { type: 'permission_resolved', requestId: a.requestId, sessionId: entry.sessionId, agentId })
        }
        agents.delete(agentId)
      }
    }
    for (const [pageId, sessions] of this.workers) {
      for (const [sessionId, worker] of sessions) {
        if (parseRemoteId(worker.agentId)?.connectorId !== connectorId) continue
        for (const a of worker.approvals.values()) {
          this.host.broadcast(pageId, { type: 'permission_resolved', requestId: a.requestId, sessionId, agentId: worker.agentId })
        }
        sessions.delete(sessionId)
      }
    }
  }

  private emit(agentId: string, entry: Entry, send: (ev: AgentEvent) => void): void {
    send({ type: 'commands', list: entry.commands, agentId, sessionId: entry.sessionId })
    send({ type: 'config', options: entry.configs, agentId, sessionId: entry.sessionId })
    for (const a of entry.approvals.values()) send({ ...a, agentId })
  }

  /** 组员会话的会话级事件：只认待批审批（照常广播，带 agentId）；命令 / 配置不属于页面上那个 agent，丢掉 */
  private applyWorker(pageId: string, sessionId: string, worker: Worker, ev: SessionEvent): void {
    if (ev.type === 'permission') worker.approvals.set(ev.requestId, ev)
    else if (ev.type === 'permission_resolved') worker.approvals.delete(ev.requestId)
    else return
    this.host.broadcast(pageId, { ...ev, agentId: worker.agentId, sessionId })
  }

  private apply(pageId: string, agentId: string, entry: Entry, ev: SessionEvent): void {
    if (ev.type === 'commands') entry.commands = ev.list
    else if (ev.type === 'config') this.setConfigs(pageId, agentId, entry, ev.options)
    else if (ev.type === 'permission') {
      entry.approvals.set(ev.requestId, ev)
      this.host.fold(pageId, agentId, ev)
    } else entry.approvals.delete(ev.requestId)
    this.host.broadcast(pageId, { ...ev, agentId })
  }

  /** agent 侧改了的 config 值落成页面级意图：只落变了的 id，且本轮消息级覆盖（临时的）不落。
   *  重建会话（编辑文档触发全文重放）时 applyConfigs 按这份意图重新应用，否则 agent 自己切的模型会静默丢 */
  private setConfigs(pageId: string, agentId: string, entry: Entry, options: ConfigOption[]): void {
    const changed: Record<string, string> = {}
    for (const o of options) {
      const was = entry.configs.find((c) => c.id === o.id)
      if (was && was.currentValue !== o.currentValue && !this.host.overridden(pageId, agentId, o.id)) {
        changed[o.id] = o.currentValue
      }
    }
    entry.configs = options
    if (Object.keys(changed).length > 0) this.host.persist(pageId, agentId, changed)
  }
}
