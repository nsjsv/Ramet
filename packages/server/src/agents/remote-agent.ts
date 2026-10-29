// ---------- RemoteAgent：把 AgentAdapter 的调用翻成 WSS 上的指令 ----------
// 中心侧对 connector 的适配器接口实现：本地 ACP 进程在 connector 机器上，
// 这里只负责 rid 关联、事件转发，以及会话级状态的副本。turn.ts 的 runTurn 完全不知道差别。
//
// 会话 / 审批的路由事实：
//   - 会话 id 由 connector 侧的适配器生成，中心只存不复用；
//   - prompt 的流式事件（轮次事件）按 rid 回来；
//   - 会话级状态（命令 / config options / 待批审批）的事实源是 connector 上的 AcpAgent。这里的副本由
//     `session` 帧（增量）、new/load 应答（播种）、hello 后的 `sessions` 快照（重连对账）维护，
//     接口与 AcpAgent 一致：sessionState() / busy / 同一个 emitter 发会话级事件；
//   - 审批应答按 agent + requestId 回 connector（requestId 只在单个 agent 进程内唯一）。
//
// 实例归 hub 所有（hub.remote()）：中心刚重启、还没有人绑定时 session 帧也要有地方落，
// 所以 kill() 只摘监听，副本留着等下一次绑定。
//
// 同一台机器同一个 agent 只有一份实例，由所有人共用，所以驱动机器的方法都要 MachinePass
// （newSession / loadSession / setConfigOption / prompt / respondPermission），帧里的 actor 取自凭据。
// 它不直接 implements AgentAdapter，对外的适配器视图是 as(pass)：绑定了操作人的 AgentAdapter，
// 调用方（turn / session-config / sub-run / mirror）拿到的永远是某个已授权用户的视图。

import { EventEmitter } from 'node:events'
import type { ConnectorHub } from './hub.js'
import type {
  AgentAdapter,
  AgentEvent,
  AskContent,
  ConfigOption,
  PromptBlock,
  PromptResult,
  SessionEvent,
  SessionState,
} from './types.js'
import type { PageTool } from '../page-read.js'
import { MachinePass } from './machine-access.js'
import { PROMPT_IMAGE_CAP } from './project-types.js'

/** 没见过的会话：副本里的值都按不可变处理（只替换、不原地改），共用一份空状态没有别名风险 */
const EMPTY_STATE: SessionState = { commands: [], configs: [], approvals: [] }

export class RemoteAgent {
  private emitter = new EventEmitter()
  /** sessionId → 会话级状态副本 */
  private replica = new Map<string, SessionState>()
  /** 在飞 prompt 数：闲置回收的"忙"判据之一（见 types.AgentAdapter.busy） */
  private inFlight = 0

  constructor(
    private hub: ConnectorHub,
    readonly connectorId: string,
    /** connector 侧该 agent 的原始 id（不带 c:<connectorId>: 前缀） */
    private agentId: string,
  ) {
    this.emitter.setMaxListeners(0)
  }

  /** connector 在线即可用（真正的进程由 connector 按需 spawn 与回收） */
  get alive(): boolean {
    return this.hub.online(this.connectorId)
  }

  /** 在飞 prompt 或副本里有待批审批：审批期间不许回收这个适配器（回收会摘掉监听，
   *  重连后的 sessions 快照就没有人接得到） */
  get busy(): boolean {
    if (this.inFlight > 0) return true
    for (const state of this.replica.values()) if (state.approvals.length > 0) return true
    return false
  }

  async ready(): Promise<void> {
    if (!this.alive) throw new Error('connector 不在线')
  }

  /** 应答里的 state 是 connector 在应答那一刻的快照，要在应答帧到达的那一刻播种副本（不发事件，调用方紧接着 bind）。
   *  不能等 await 之后再播：同一个 TCP 包里紧跟在应答后面的 session 帧（如 new 之后的 available_commands_update）
   *  会先更新副本，await 之后再用旧快照播种就把它盖掉了 */
  private seed(sessionId: string, state: SessionState | undefined): void {
    this.replica.set(sessionId, state ?? EMPTY_STATE)
  }

  /** 只转发能力凭证（tools）；命令由 connector 用自己机器上的 node/脚本拼（见 page-read.ts） */
  async newSession(pass: MachinePass, cwd: string, tools: PageTool[] = []): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    this.check(pass)
    const msg = await this.hub.request(
      pass,
      (rid, actor) => ({ t: 'new', rid, actor, agent: this.agentId, cwd, tools }),
      undefined,
      (m) => {
        if (m.t === 'res' && m.sessionId) this.seed(m.sessionId, m.state)
      },
    )
    if (msg.t !== 'res' || !msg.sessionId) throw new Error(msg.t === 'err' ? msg.message : 'connector 未返回 sessionId')
    return { sessionId: msg.sessionId, configOptions: msg.state?.configs ?? [] }
  }

  async loadSession(pass: MachinePass, sessionId: string, cwd: string, tools: PageTool[] = []): Promise<{ configOptions: ConfigOption[] }> {
    this.check(pass)
    const msg = await this.hub.request(
      pass,
      (rid, actor) => ({ t: 'load', rid, actor, agent: this.agentId, sessionId, cwd, tools }),
      undefined,
      (m) => {
        if (m.t === 'res') this.seed(sessionId, m.state)
      },
    )
    if (msg.t === 'err') throw new Error(msg.message)
    return { configOptions: msg.t === 'res' ? (msg.state?.configs ?? []) : [] }
  }

  /** 副本由随后的 session 帧（connector 的 AcpAgent 在缓存变化时发 config 事件，帧先于本应答到）更新 */
  async setConfigOption(pass: MachinePass, sessionId: string, configId: string, value: string): Promise<ConfigOption[]> {
    this.check(pass)
    const msg = await this.hub.request(pass, (rid, actor) => ({
      t: 'config',
      rid,
      actor,
      agent: this.agentId,
      sessionId,
      configId,
      value,
    }))
    if (msg.t === 'err') throw new Error(msg.message)
    return msg.t === 'res' ? (msg.configOptions ?? []) : []
  }

  sessionState(sessionId: string): SessionState {
    return this.replica.get(sessionId) ?? EMPTY_STATE
  }

  /** hub 把 connector 的 session 帧交进来：先更新副本、再发事件（同 AcpAgent 先缓存再发事件） */
  ingest(sessionId: string, ev: SessionEvent): void {
    const prev = this.sessionState(sessionId)
    const next: SessionState =
      ev.type === 'commands'
        ? { ...prev, commands: ev.list }
        : ev.type === 'config'
          ? { ...prev, configs: ev.options }
          : {
              ...prev,
              approvals:
                ev.type === 'permission'
                  ? [...prev.approvals.filter((a) => a.requestId !== ev.requestId), ev]
                  : prev.approvals.filter((a) => a.requestId !== ev.requestId),
            }
    this.replica.set(sessionId, next)
    this.emitter.emit('event', { ...ev, sessionId } satisfies AgentEvent)
  }

  /** hello 之后的 sessions 快照（重连对账）：快照里没有的会话当已结束，其待批审批补发 resolved；
   *  在的会话整份替换，并把命令 / 配置 / 待批再发一遍（镜像按 requestId 去重，重复无害） */
  reconcile(list: Array<{ sessionId: string; state: SessionState }>): void {
    const next = new Map(list.map((s) => [s.sessionId, s.state]))
    for (const sessionId of new Set([...this.replica.keys(), ...next.keys()])) {
      const prev = this.replica.get(sessionId)
      const state = next.get(sessionId)
      if (state) this.replica.set(sessionId, state)
      else this.replica.delete(sessionId)
      for (const a of prev?.approvals ?? []) {
        if (state?.approvals.some((b) => b.requestId === a.requestId)) continue
        this.emitter.emit('event', { type: 'permission_resolved', requestId: a.requestId, sessionId } satisfies AgentEvent)
      }
      if (!state) continue
      this.emitter.emit('event', { type: 'commands', list: state.commands, sessionId } satisfies AgentEvent)
      this.emitter.emit('event', { type: 'config', options: state.configs, sessionId } satisfies AgentEvent)
      for (const a of state.approvals) this.emitter.emit('event', a)
    }
  }

  async prompt(pass: MachinePass, sessionId: string, blocks: PromptBlock[], runId?: string): Promise<PromptResult> {
    this.check(pass)
    // runId 是跨重启的回合身份，没有它断线后的重放对不上这一轮，不许发出去
    if (!runId) throw new Error('远端 prompt 必须带 runId')
    // 老 connector 不认图片块：剥掉，只发文本（文本里的 ![](/api/files/…) 链接还在）
    const sendable = this.hub.get(this.connectorId)?.caps.includes(PROMPT_IMAGE_CAP) ? blocks : blocks.filter((b) => b.type !== 'image')
    this.inFlight++
    try {
      return await this.hub.stream(
        pass,
        (rid, actor) => ({ t: 'prompt', rid, actor, runId, agent: this.agentId, sessionId, blocks: sendable }),
        // seq 只给 hub 的 waiter（bindRun 认领要按序号折）。监听器仍只看 AgentEvent，
        // manager 里 adapter.on 的签名不用跟着变。
        (ev) => this.emitter.emit('event', ev),
      )
    } finally {
      this.inFlight--
    }
  }

  /** 取消不要凭据：它只会让机器停下来（见 hub.cancel） */
  cancel(sessionId: string): void {
    this.hub.cancel(this.connectorId, { t: 'cancel', agent: this.agentId, sessionId })
  }

  /** 停止一条 ACP 终端命令：发 kill-cmd 帧（非驱动帧，connector 只认这个 agent 这个会话自己的终端）。返回是否送出 */
  killCommand(sessionId: string, terminalId: string): boolean {
    return this.hub.killCommand(this.connectorId, { t: 'kill-cmd', agent: this.agentId, sessionId, terminalId })
  }

  /** false = connector 不在线、没送出去：审批还在 connector 上等着，以后可以再答 */
  respondPermission(pass: MachinePass, requestId: string, optionId: string | null, content?: AskContent): boolean {
    this.check(pass)
    return this.hub.answer(pass, (actor) => ({ t: 'permission', actor, agent: this.agentId, requestId, optionId, ...(content ? { content } : {}) }))
  }

  /** 绑定了操作人的适配器视图：turn / session-config / sub-run / 会话镜像拿到的都是它。
   *  凭据必须是签给这台机器的；每个驱动方法把凭据带进帧（actor）。只读 / 监听 / 取消成员直接转给本实例 */
  as(pass: MachinePass): AgentAdapter {
    this.check(pass)
    const self = this
    return {
      ready: () => self.ready(),
      newSession: (cwd, tools) => self.newSession(pass, cwd, tools),
      loadSession: (sessionId, cwd, tools) => self.loadSession(pass, sessionId, cwd, tools),
      setConfigOption: (sessionId, configId, value) => self.setConfigOption(pass, sessionId, configId, value),
      prompt: (sessionId, blocks, runId) => self.prompt(pass, sessionId, blocks, runId),
      cancel: (sessionId) => self.cancel(sessionId),
      killCommand: (sessionId, terminalId) => self.killCommand(sessionId, terminalId),
      respondPermission: (requestId, optionId, content) => self.respondPermission(pass, requestId, optionId, content),
      sessionState: (sessionId) => self.sessionState(sessionId),
      on: (listener) => self.on(listener),
      get busy() {
        return self.busy
      },
      kill: () => self.kill(),
    }
  }

  /** 驱动方法的入口校验：hub 按凭据上的机器路由，这里保证凭据就是签给本实例这台机器的（不会拿 A 机器的凭据、
   *  以本实例的 agent 名义往 A 机器发帧） */
  private check(pass: MachinePass): void {
    if (!(pass instanceof MachinePass) || pass.machine !== this.connectorId) throw new Error('凭据不是签给这台机器的')
  }

  on(listener: (ev: AgentEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }

  /** 进程在远端，这里无事可做（connector 侧按闲置回收自己 kill）。只摘监听：副本归 hub，留着等下一次绑定 */
  kill(): void {
    this.emitter.removeAllListeners()
  }
}
