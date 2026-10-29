// ---------- ConnectorHub：在线 connector 的进程内注册表 + 协议分发 ----------
// 在线态的唯一事实源是这里（WSS 连接在 map 里就在线），不写库：进程重启后所有 connector 都会
// 重连，库里的 online 标志必然陈旧。
// 职责：
//   - attach/detach（ws 路由握手成功后调）
//   - 请求/应答：request() 发一条带 rid 的消息并等 res/err（new/load/config）
//   - prompt 的寿命在 connector 进程里，不在这条 socket 上。waiter 按 runId 挂着；
//     非终结掉线只挂起，重连后的 ev/end/err/resumed 按 runId 送回（没有 runId 才退回本连接的 rid）
//   - 终结掉线（4403 撤销）才 reject prompt

import { AsyncLocalStorage } from 'node:async_hooks'
import type { WebSocket } from 'ws'
import type { Pool } from 'pg'
import type { AgentEvent, PromptResult, SessionState } from './types.js'
import { touchConnector } from './connectors.js'
import { DRIVEN_SCOPE, FRAME_CAP, type ConnectorAgentInfo, type ConnMsg, type CenterMsg, type DrivenMsg } from './protocol.js'
import { ConnectorOutdatedError, PROJECT_CAP, TerminalUnsupportedError, WRITE_CAP } from './project-types.js'
import { PreviewBridge } from './preview-bridge.js'
import { PtyBridge } from './pty-bridge.js'
import { TERMINAL_CAP } from './pty-types.js'
import { MachinePass, type MachineScope } from './machine-access.js'
import { revokedUsersOf } from './machine-grants.js'
import { RemoteAgent } from './remote-agent.js'

/** 冷启动类请求（session/new、session/load）的应答上限。claude 的 ACP 适配器是
 *  `npx -y @agentclientprotocol/claude-agent-acp`，首次要下载 + 起 CLI + 握手，可能超过 120s 才回 session/new。
 *  这类请求不在 HTTP 路径上（prepare 立即 202、配置项走 SSE），放宽没有代价。600s 是保守上界。 */
const REQUEST_TIMEOUT_MS = 600_000

/** hello 认领回调正在跑。bindRun 发生在这次回调里时，waiter 归这条连接，
 *  终结掉线才能在「回调还没返回」的窗口里找到它。 */
const helloContext = new AsyncLocalStorage<string>()

export type InflightPrompt = { runId: string; agent: string; sessionId: string }
export type ResumePlan = { resume: { runId: string; after: number }[]; drop: string[] }

type RequestPending = {
  resolve: (msg: ConnMsg) => void
  reject: (err: Error) => void
  timer?: NodeJS.Timeout
  /** 应答帧到达的那一刻、resolve 之前同步调用：要「按到达顺序」落地的副作用放这里（见 RemoteAgent.seed） */
  onReply?: (msg: ConnMsg) => void
  /** 流式增量（quick-delta 的文本）：随手 AI 本地通道，应答（res / err）之前陆续到达 */
  onStream?: (text: string) => void
}

type PromptHandlers = {
  onEvent: (ev: AgentEvent, seq: number) => void
  onResumed: () => void
  onEnd: (result: PromptResult) => void
  onError: (message: string) => void
}

type PromptWaiter = {
  runId: string
  /** 发起这次 prompt 的连接本地 rid。断线后作废；重放靠 runId。 */
  rid: string
  connectorId: string
  handlers: PromptHandlers
  /** stream() 造出来的那次 promise。bindRun 只换 handlers，不换它。server 重启后的认领没有这个。 */
  settle?: { resolve: (result: PromptResult) => void; reject: (err: Error) => void }
  settled: boolean
}

export type Conn = {
  id: string
  name: string
  spaceId: string
  /** 配对人（connectors.owner_id）= 这台机器的主人；老 connector 没有，重新配对后才有 */
  ownerId: string | null
  defaultCwd: string
  agents: ConnectorAgentInfo[]
  /** hello 里声明的能力（'project' 等）；老 connector 没有 = []。要求某能力的帧（protocol.ts 的 FRAME_CAP）对它不发 */
  caps: string[]
  ws: WebSocket
  /** new/load/config/ls。任何掉线都 reject：这些请求没有跨连接的身份。 */
  pending: Map<string, RequestPending>
  /** 本连接上 prompt 的 rid → runId。只为老消息（不带 runId）服务；连接对象死了就没了。 */
  promptRids: Map<string, string>
  rid: number
}

export class ConnectorHub {
  private conns = new Map<string, Conn>()
  private rtts = new Map<string, number>()
  /** 回合 waiter。键是 runId，不是连接。非终结掉线不删。 */
  private prompts = new Map<string, PromptWaiter>()
  /** connectorId → agentId → RemoteAgent。实例归 hub：session 帧在中心刚重启、还没有人绑定时也要有地方落 */
  private remotes = new Map<string, Map<string, RemoteAgent>>()
  private helloHandler?: (connectorId: string, inflight: InflightPrompt[]) => Promise<ResumePlan>
  /** 终结掉线的次数。hello 认领若跨过一次终结，回调里刚建的 waiter 也要收掉。 */
  private termGen = new Map<string, number>()
  /** 项目面板的终端：浏览器订阅的扇出与 pty 帧的收发（pty-data / pty-exit 从 handle 交进去，连接没了从 detach 通知） */
  readonly ptys = new PtyBridge(this)
  /** 端口预览：共享登记 + HTTP / WebSocket 经 connector 转发（预览源的监听在 preview-server.ts，用的是这里的登记） */
  readonly previews = new PreviewBridge(this)
  /** 在飞的随手 AI 本地通道调用：授权收回 / 收窄时按「机器 + 人」当场取消（manager.endAgentAccess） */
  private quickRuns = new Set<{ connectorId: string; userId: string; cancel: (reason: string) => void }>()

  /** onAgentsChanged = 在线清单变了（上线/下线）时通知客户端失效 agent 目录缓存
   *  （见 collab.ts notifyAgentsChanged）。catalog 是「本机 + 在线 connector」的合成视图，
   *  Hub 就是那半个事实源。
   *  onConnectorGone = 这条连接没了。terminal=false 只是 socket 没了，connector 进程里的 prompt
   *  还在；terminal=true 才是 4403（撤销/拒绝 token），进程不会把这些回合跑完。 */
  constructor(
    private pool: Pool,
    private onAgentsChanged?: () => void,
    private onConnectorGone?: (connectorId: string, terminal: boolean) => void,
  ) {}

  get(connectorId: string): Conn | undefined {
    return this.conns.get(connectorId)
  }

  /** 中心 ↔ connector 最近一次心跳往返（ms，connector-ws.ts 记）；网页终端的延迟标签把它加在浏览器 ↔ 中心那段上 */
  noteRtt(connectorId: string, ms: number): void {
    this.rtts.set(connectorId, ms)
  }

  rtt(connectorId: string): number | null {
    return this.rtts.get(connectorId) ?? null
  }

  online(connectorId: string): boolean {
    return this.conns.has(connectorId)
  }

  /** 空间内在线 connector（前端列表/agent 合流用） */
  onlineOfSpace(spaceId: string): Conn[] {
    return [...this.conns.values()].filter((c) => c.spaceId === spaceId)
  }

  onlineIds(): Set<string> {
    return new Set(this.conns.keys())
  }

  /** 某 connector 上某 agent 的 RemoteAgent（没有就建；副本在里面，终态断开才丢） */
  remote(connectorId: string, agentId: string): RemoteAgent {
    let agents = this.remotes.get(connectorId)
    if (!agents) this.remotes.set(connectorId, (agents = new Map()))
    let agent = agents.get(agentId)
    if (!agent) agents.set(agentId, (agent = new RemoteAgent(this, connectorId, agentId)))
    return agent
  }

  setHelloHandler(handler: (connectorId: string, inflight: InflightPrompt[]) => Promise<ResumePlan>): void {
    this.helloHandler = handler
  }

  /** 握手成功后注册；同一 connector 重连时顶掉旧 socket。旧 socket 上的 prompt 只挂起：
   *  顶替是换连接，不是换进程。 */
  attach(input: {
    id: string
    spaceId: string
    ownerId: string | null
    name: string
    defaultCwd: string
    agents: ConnectorAgentInfo[]
    caps?: string[]
    ws: WebSocket
  }): Conn {
    const old = this.conns.get(input.id)
    if (old) {
      this.detach(input.id, '已被新连接顶替', false)
      // 旧连接当场断开：connector 都重连了，说明它那头早已当这条死了（connector-ws.ts 只注销它自己）
      try {
        old.ws.terminate()
      } catch {
        // 测试里的假 socket 没有 terminate
      }
    }
    const conn: Conn = { ...input, caps: input.caps ?? [], pending: new Map(), promptRids: new Map(), rid: 0 }
    this.conns.set(input.id, conn)
    void touchConnector(this.pool, input.id).catch(() => undefined)
    this.onAgentsChanged?.()
    return conn
  }

  /**
   * terminal 缺省 false：请求类 waiter 失败，prompt 按 runId 留着。
   * terminal true：prompt 也失败（撤销 token，进程不会再把回合跑完）。
   */
  detach(connectorId: string, reason: string, terminal = false): void {
    const conn = this.conns.get(connectorId)
    if (!conn) return
    this.conns.delete(connectorId)
    this.rtts.delete(connectorId)
    if (terminal) this.termGen.set(connectorId, (this.termGen.get(connectorId) ?? 0) + 1)
    const message = `connector ${conn.name} ${reason}`
    for (const pending of conn.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
    }
    conn.pending.clear()
    conn.promptRids.clear()
    this.ptys.connectorGone(connectorId)
    this.previews.connectorGone(connectorId, terminal)
    if (terminal) {
      for (const waiter of [...this.prompts.values()]) {
        if (waiter.connectorId !== connectorId) continue
        this.failPrompt(waiter, message)
      }
      // 终态：进程不会再回来，副本（含待批审批）随之作废。审批的清理与广播在 manager 的 onConnectorGone
      for (const agent of this.remotes.get(connectorId)?.values() ?? []) agent.kill()
      this.remotes.delete(connectorId)
    }
    this.onConnectorGone?.(connectorId, terminal)
    this.onAgentsChanged?.()
  }

  /** 空间被删/被撤销时主动断开（connector 侧收到 close 后按码处理：4403 停重连） */
  closeBySpace(spaceId: string, reason: string): void {
    for (const conn of [...this.conns.values()]) {
      if (conn.spaceId !== spaceId) continue
      this.detach(conn.id, reason, true)
      conn.ws.close(4403, reason)
    }
  }

  /** 进程收尾。server 退出不是回合结局（connector 会连上新进程），prompt 只挂起。
   *  不发 4403：那是撤销，connector 会停止重连。请求类 waiter 仍失败。 */
  closeAll(reason: string): void {
    for (const id of [...this.conns.keys()]) {
      const conn = this.conns.get(id)
      if (!conn) continue
      this.detach(id, reason, false)
      try {
        conn.ws.close(1001, reason)
      } catch {
        // terminate 已经把 socket 拆了
      }
    }
  }

  closeOne(connectorId: string, reason: string): void {
    const conn = this.conns.get(connectorId)
    if (!conn) return
    this.detach(connectorId, reason, true)
    conn.ws.close(4403, reason)
  }

  // ---------- 请求/应答 ----------

  private send(conn: Conn, msg: CenterMsg): void {
    if (conn.ws.readyState !== 1) throw new Error(`connector ${conn.name} 未连接`)
    conn.ws.send(JSON.stringify(msg))
  }

  /** 驱动帧下发的唯一入口（new / load / ls / prompt / config / permission 与项目面板的 tree / read / files / git-* 都从这里出去）。
   *  凭据必须是 MachinePass（instanceof 防止用 `as` 伪造结构相同的对象）、是签给这台机器的、scope 与这种帧要的一致；
   *  帧里的 actor 必须是凭据的主人，build 拿到 actor 才能造出帧，造不出别人的帧。
   *  connector 收到后还会按 actor 再判一次（connector/access.ts）。 */
  private driven(pass: MachinePass, connectorId: string, build: (actor: string) => DrivenMsg): { conn: Conn; msg: DrivenMsg } {
    if (!(pass instanceof MachinePass)) throw new Error('缺少机器使用凭据')
    if (pass.machine !== connectorId) throw new Error('凭据不是签给这台机器的')
    const conn = this.conns.get(connectorId)
    if (!conn) throw new Error('connector 不在线')
    const msg = build(pass.userId)
    if (DRIVEN_SCOPE[msg.t] !== pass.scope) throw new Error(`凭据的范围（${pass.scope}）不够发 ${msg.t} 帧`)
    if (msg.actor !== pass.userId) throw new Error('帧的操作人与凭据不一致')
    // 老 connector 不认的帧不发：发了它只会掉进 default 不应答，白等到超时
    const need = FRAME_CAP[msg.t]
    if (need && !conn.caps.includes(need)) {
      // 终端能力单独说明：connector 够新（有项目面板）但 node-pty 没装上，和「版本太旧」不是一回事
      if (need === TERMINAL_CAP && conn.caps.includes(PROJECT_CAP)) throw new TerminalUnsupportedError()
      throw need === WRITE_CAP ? new ConnectorOutdatedError('这台机器上的 connector 版本太旧，升级后才能改文件') : new ConnectorOutdatedError()
    }
    return { conn, msg }
  }

  /** 发一条带 rid 的驱动请求并等应答（res 或 err）。默认 REQUEST_TIMEOUT_MS（new/load 是冷启动，
   *  给分钟级）；短请求（列目录）自己传 timeoutMs。目标机器 = 凭据所属的机器 */
  request(
    pass: MachinePass,
    build: (rid: string, actor: string) => Extract<DrivenMsg, { rid: string }>,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
    onReply?: (msg: ConnMsg) => void,
    onStream?: (text: string) => void,
  ): Promise<ConnMsg> {
    try {
      return this.dispatch(pass, build, timeoutMs, onReply, onStream)
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }

  /** 同 request，但发帧前的拒绝（不在线 / 凭据 / 能力不够）同步抛出，返回的 promise 只代表「发出去之后的应答」。
   *  调用方据此可以只确认「发出去了」而不等应答（终端输入：见 agents/project.ts 的 sendProject） */
  dispatch(
    pass: MachinePass,
    build: (rid: string, actor: string) => Extract<DrivenMsg, { rid: string }>,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
    onReply?: (msg: ConnMsg) => void,
    onStream?: (text: string) => void,
  ): Promise<ConnMsg> {
    const connectorId = pass.machine
    const conn = this.conns.get(connectorId)
    if (!conn) throw new Error('connector 不在线')
    const rid = `r${++conn.rid}`
    const { msg } = this.driven(pass, connectorId, (actor) => build(rid, actor))
    const reply = new Promise<ConnMsg>((resolve, reject) => {
      const timer: NodeJS.Timeout = setTimeout(() => {
        conn.pending.delete(rid)
        reject(new Error('connector 请求超时'))
      }, timeoutMs)
      timer.unref()
      conn.pending.set(rid, { resolve, reject, timer, onReply, onStream })
    })
    try {
      this.send(conn, msg)
    } catch (err) {
      const waiting = conn.pending.get(rid)
      if (waiting) clearTimeout(waiting.timer)
      conn.pending.delete(rid)
      throw err
    }
    return reply
  }

  /** prompt：按 runId 登记。ev 把 seq 交给 waiter（重放要按连接器缓冲下标折）；promise 在 end 完成。 */
  stream(
    pass: MachinePass,
    build: (rid: string, actor: string) => Extract<DrivenMsg, { t: 'prompt' }>,
    onEvent: (ev: AgentEvent, seq: number) => void,
  ): Promise<PromptResult> {
    const connectorId = pass.machine
    const conn = this.conns.get(connectorId)
    if (!conn) return Promise.reject(new Error('connector 不在线'))
    const rid = `r${++conn.rid}`
    let built: DrivenMsg
    try {
      built = this.driven(pass, connectorId, (actor) => build(rid, actor)).msg
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }
    if (built.t !== 'prompt' || !built.runId) return Promise.reject(new Error('prompt 必须带 runId'))
    const runId = built.runId
    if (this.prompts.has(runId)) return Promise.reject(new Error('该 run 已在飞'))
    let settle!: NonNullable<PromptWaiter['settle']>
    const promise = new Promise<PromptResult>((resolve, reject) => {
      settle = { resolve, reject }
    })
    const waiter: PromptWaiter = {
      runId,
      rid,
      connectorId,
      handlers: { onEvent, onResumed: () => undefined, onEnd: () => undefined, onError: () => undefined },
      settle,
      settled: false,
    }
    this.prompts.set(runId, waiter)
    conn.promptRids.set(rid, runId)
    try {
      this.send(conn, built)
    } catch (err) {
      if (!waiter.settled) {
        waiter.settled = true
        this.forget(waiter)
        settle.reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    return promise
  }

  /** 发一个没有应答的驱动帧（端口预览的流量帧：http-req / http-body / ws-*）。校验同 request：凭据必须是 MachinePass、签给这台机器、
   *  范围与帧一致、帧里的 actor 就是凭据主人、connector 声明过这个能力。机器不在线 / 校验不过抛错（调用方据此回 502） */
  frame(pass: MachinePass, build: (actor: string) => DrivenMsg): void {
    const { conn, msg } = this.driven(pass, pass.machine, build)
    this.send(conn, msg)
  }

  /** 审批应答（驱动帧：选「允许」就是让机器去做那件事）。返回是否已写进 socket：socket 不在就丢，
   *  调用方据此回 409，审批留着以后再答。 */
  answer(pass: MachinePass, build: (actor: string) => Extract<DrivenMsg, { t: 'permission' }>): boolean {
    try {
      const { conn, msg } = this.driven(pass, pass.machine, build)
      this.send(conn, msg)
      return true
    } catch {
      // 连接已断：不抛。审批还在 connector 上等着，重连后可以再答
      return false
    }
  }

  /** 取消指令（尽力而为，socket 不在就丢，断线期间的停止记在认领方）。
   *  刻意不要 MachinePass：取消只会让机器停下来、不会让它动起来；谁能停由页面写权限决定（manager.stop）。
   *  类型上只收 cancel 帧，不能借它发别的。 */
  cancel(connectorId: string, msg: Extract<CenterMsg, { t: 'cancel' }>): boolean {
    const conn = this.conns.get(connectorId)
    if (!conn) return false
    try {
      this.send(conn, msg)
      return true
    } catch {
      // 连接已断：不抛。prompt 还挂在 runId 上，等重连后的 hello 决定 resume 还是 drop
      return false
    }
  }

  /** 停掉一次随手 AI 本地通道调用（按 rid）。刻意不要 MachinePass：非驱动帧，只会让机器停下来（同 cancel） */
  cancelQuick(connectorId: string, rid: string): boolean {
    return this.sendTo(connectorId, { t: 'quick-cancel', rid })
  }

  /** 登记一次在飞的 quick 调用；返回注销函数 */
  trackQuick(connectorId: string, userId: string, cancel: (reason: string) => void): () => void {
    const tracked = { connectorId, userId, cancel }
    this.quickRuns.add(tracked)
    return () => void this.quickRuns.delete(tracked)
  }

  /** 此人在这台机器上 agent 范围的使用权没了：取消他在飞的 quick（中心这一侧；connector 在 grant-revoked 里自己也取消） */
  cancelQuickOf(connectorId: string, userId: string, reason: string): void {
    for (const run of [...this.quickRuns]) {
      if (run.connectorId === connectorId && run.userId === userId) run.cancel(reason)
    }
  }

  /** 通知 connector：此人的授权没了（它从本地名单删人并取消此人的在飞 prompt）。
   *  刻意不要 MachinePass：这是非驱动帧，只会减少权限（见 protocol.ts 的 grant-revoked）。socket 不在就丢（返回 false），
   *  重连后 welcomeFor 会补发 */
  grantRevoked(connectorId: string, userId: string): boolean {
    const conn = this.conns.get(connectorId)
    if (!conn) return false
    try {
      this.send(conn, { t: 'grant-revoked', userId })
      return true
    } catch {
      return false
    }
  }

  /** 停止 agent 在 ACP 终端里跑的一条命令。刻意不要 MachinePass：非驱动帧，只会让机器停下来（同 cancel）；
   *  谁能停由页面写权限决定，connector 只认「这个 agent 的这个会话」自己的终端 */
  killCommand(connectorId: string, msg: Extract<CenterMsg, { t: 'kill-cmd' }>): boolean {
    return this.sendTo(connectorId, msg)
  }

  /** 通知 connector：此人在这台机器上 machine 范围的使用权没了（授权收窄）→ 它关掉此人的全部终端。
   *  刻意不要 MachinePass：非驱动帧，只会减少权限；与 grant-revoked 不同，不动 connector 的本地名单 */
  accessReduced(connectorId: string, userId: string, scope: MachineScope): boolean {
    return this.sendTo(connectorId, { t: 'access-reduced', userId, scope })
  }

  private sendTo(connectorId: string, msg: CenterMsg): boolean {
    const conn = this.conns.get(connectorId)
    if (!conn) return false
    try {
      this.send(conn, msg)
      return true
    } catch {
      return false
    }
  }

  /**
   * 有 parked promise 时只换 handlers，prompt() 拿到的还是原来那个 promise。
   * 没有 promise（server 重启，内存是空的）就建一个只有 handlers 的 waiter，重放从这里进。
   */
  bindRun(runId: string, handlers: PromptHandlers): void {
    const claimedBy = helloContext.getStore() ?? ''
    const existing = this.prompts.get(runId)
    if (existing && !existing.settled) {
      existing.handlers = handlers
      if (!existing.connectorId && claimedBy) existing.connectorId = claimedBy
      return
    }
    this.prompts.set(runId, {
      runId,
      rid: '',
      connectorId: claimedBy,
      handlers,
      settled: false,
    })
  }

  /** connector-ws 在 hello 之后调。welcome 一定带 resume 和 drop 两个数组。 */
  async welcomeFor(connectorId: string, inflight: InflightPrompt[]): Promise<void> {
    const conn = this.conns.get(connectorId)
    if (!conn) return
    const ws = conn.ws
    const name = conn.name
    const gen = this.termGen.get(connectorId) ?? 0
    const plan = await this.claim(connectorId, inflight)
    // 认领回调里如果被 4403 拆掉，刚 bindRun 的 waiter 不在 detach 那一轮循环里，这里补收
    if ((this.termGen.get(connectorId) ?? 0) !== gen && !this.conns.has(connectorId)) {
      this.failClaim(name, connectorId, inflight, `connector ${name} 已断开`)
      return
    }
    const current = this.conns.get(connectorId)
    if (!current || current.ws !== ws) return
    this.stamp(connectorId, inflight)
    // hello.inflight 是这个进程还在跑的全部 prompt。挂起的 waiter 不在里面，就永远等不到 end/err。
    // 这条 socket 上刚发出的 prompt 还不在这份快照里，不能一起收。
    this.dropAbsent(current, inflight, plan.resume)
    try {
      this.send(current, { t: 'welcome', connectorId, ownerId: current.ownerId, resume: plan.resume, drop: plan.drop })
    } catch {
      // 窗口里又断了：connector 会重连再 hello
      return
    }
    // connector 在 welcome 时清空了它的预览登记（两边始终一致）：中心还在共享的再登记一遍
    this.previews.resync(connectorId)
    // 它不在线期间被收回的人，本机名单里可能还留着：补发（只删不加；失败无碍，中心这一道闸本来就已经拒绝了他们）
    try {
      for (const userId of await revokedUsersOf(this.pool, connectorId)) this.grantRevoked(connectorId, userId)
    } catch (err) {
      console.error(`[hub] 补发收回失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** ws 路由把每条入站消息转进来 */
  handle(connectorId: string, msg: ConnMsg): void {
    const conn = this.conns.get(connectorId)
    if (!conn) return
    if (msg.t === 'hello') {
      void this.welcomeFor(connectorId, msg.inflight ?? [])
      return
    }
    if (msg.t === 'pair-request') return
    if (msg.t === 'session') {
      this.remote(connectorId, msg.agent).ingest(msg.sessionId, msg.ev)
      return
    }
    if (msg.t === 'sessions') {
      this.reconcileSessions(connectorId, msg.list)
      return
    }
    if (msg.t === 'pty-data' || msg.t === 'pty-exit') {
      this.ptys.ingest(connectorId, msg)
      return
    }
    if (msg.t === 'http-res' || msg.t === 'http-res-body' || msg.t === 'http-fail' || msg.t === 'ws-ready' || msg.t === 'ws-data' || msg.t === 'ws-end') {
      this.previews.ingest(connectorId, msg)
      return
    }
    if (msg.t === 'quick-delta') {
      if (typeof msg.text === 'string') conn.pending.get(msg.rid)?.onStream?.(msg.text)
      return
    }
    if (msg.t === 'resumed') {
      this.waiterFor(conn, { runId: msg.runId })?.handlers.onResumed()
      return
    }
    if (msg.t === 'ev') {
      // 老 connector 不带 seq。0 是缓冲的第一个下标；新协议从 0 递增，认领方按它做 after。
      this.waiterFor(conn, msg)?.handlers.onEvent(msg.ev, typeof msg.seq === 'number' ? msg.seq : 0)
      return
    }
    if (msg.t === 'end') {
      const waiter = this.waiterFor(conn, msg)
      if (!waiter) return
      const result: PromptResult = msg.usage ? { stopReason: msg.stopReason, usage: msg.usage } : { stopReason: msg.stopReason }
      this.finishPrompt(waiter, result)
      return
    }
    if (msg.t === 'err') {
      // 带 runId（或本连接的 prompt rid）就是回合失败。对不上也不要落到 request 上：rid 会在新连接上从头计。
      if (msg.runId || conn.promptRids.has(msg.rid)) {
        const waiter = this.waiterFor(conn, msg)
        if (waiter) this.failPrompt(waiter, msg.message)
        return
      }
      this.settleRequest(conn, msg)
      return
    }
    if (msg.t === 'res') this.settleRequest(conn, msg)
  }

  /** sessions 快照按 agent 分发对账。这个 connector 下已有副本、快照里却一个会话都没有的 agent 也要对账
   *  （它的会话全部已结束） */
  private reconcileSessions(connectorId: string, list: Extract<ConnMsg, { t: 'sessions' }>['list']): void {
    const byAgent = new Map<string, Array<{ sessionId: string; state: SessionState }>>()
    for (const agentId of this.remotes.get(connectorId)?.keys() ?? []) byAgent.set(agentId, [])
    for (const item of list) {
      const sessions = byAgent.get(item.agent) ?? []
      sessions.push({ sessionId: item.sessionId, state: item.state })
      byAgent.set(item.agent, sessions)
    }
    for (const [agentId, sessions] of byAgent) this.remote(connectorId, agentId).reconcile(sessions)
  }

  private async claim(connectorId: string, inflight: InflightPrompt[]): Promise<ResumePlan> {
    const empty: ResumePlan = { resume: [], drop: inflight.map((item) => item.runId) }
    if (!this.helloHandler) return empty
    try {
      const plan = await helloContext.run(connectorId, () => this.helloHandler!(connectorId, inflight))
      return {
        resume: Array.isArray(plan?.resume) ? plan.resume : [],
        drop: Array.isArray(plan?.drop) ? plan.drop : [],
      }
    } catch {
      // 认领抛了也不能不回 welcome，否则 connector 卡在握手上
      return empty
    }
  }

  private stamp(connectorId: string, inflight: InflightPrompt[]): void {
    for (const item of inflight) {
      const waiter = this.prompts.get(item.runId)
      if (waiter && !waiter.settled && !waiter.connectorId) waiter.connectorId = connectorId
    }
  }

  private dropAbsent(conn: Conn, inflight: InflightPrompt[], resume: ResumePlan['resume']): void {
    const live = new Set<string>([...inflight.map((item) => item.runId), ...resume.map((item) => item.runId)])
    const message = `connector ${conn.name} 的进程已不再跑该回合`
    for (const waiter of [...this.prompts.values()]) {
      if (waiter.settled || waiter.connectorId !== conn.id || live.has(waiter.runId)) continue
      if (waiter.rid && conn.promptRids.get(waiter.rid) === waiter.runId) continue
      this.failPrompt(waiter, message)
    }
  }

  private failClaim(name: string, connectorId: string, inflight: InflightPrompt[], message: string): void {
    for (const item of inflight) {
      const waiter = this.prompts.get(item.runId)
      if (!waiter || waiter.settled) continue
      if (waiter.connectorId && waiter.connectorId !== connectorId) continue
      this.failPrompt(waiter, message || `connector ${name} 已断开`)
    }
  }

  /** runId 优先。没有 runId 才用这条连接上的 rid。connectorId 还没盖章（刚 bindRun）时谁先送到都行。 */
  private waiterFor(conn: Conn, msg: { rid?: string; runId?: string }): PromptWaiter | undefined {
    const runId = msg.runId || (msg.rid ? conn.promptRids.get(msg.rid) : undefined)
    if (!runId) return undefined
    const waiter = this.prompts.get(runId)
    if (!waiter || waiter.settled) return undefined
    if (msg.runId && waiter.connectorId && waiter.connectorId !== conn.id) return undefined
    return waiter
  }

  private settleRequest(conn: Conn, msg: Extract<ConnMsg, { t: 'res' | 'err' }>): void {
    const pending = conn.pending.get(msg.rid)
    if (!pending) return
    conn.pending.delete(msg.rid)
    clearTimeout(pending.timer)
    pending.onReply?.(msg)
    pending.resolve(msg)
  }

  private finishPrompt(waiter: PromptWaiter, result: PromptResult): void {
    if (waiter.settled) return
    waiter.settled = true
    this.forget(waiter)
    // 先通知认领方，再放开 prompt() 的 promise：同一轮调用栈里 onEnd 跑完，continue 才从 await 回来。
    try {
      waiter.handlers.onEnd(result)
    } catch (err) {
      console.error(`[hub] run ${waiter.runId} onEnd: ${err instanceof Error ? err.message : String(err)}`)
    }
    waiter.settle?.resolve(result)
  }

  private failPrompt(waiter: PromptWaiter, message: string): void {
    if (waiter.settled) return
    waiter.settled = true
    this.forget(waiter)
    try {
      waiter.handlers.onError(message)
    } catch (err) {
      console.error(`[hub] run ${waiter.runId} onError: ${err instanceof Error ? err.message : String(err)}`)
    }
    waiter.settle?.reject(new Error(message))
  }

  private forget(waiter: PromptWaiter): void {
    this.prompts.delete(waiter.runId)
    const conn = waiter.connectorId ? this.conns.get(waiter.connectorId) : undefined
    if (conn && waiter.rid) conn.promptRids.delete(waiter.rid)
  }
}
