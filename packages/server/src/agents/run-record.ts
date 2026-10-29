// ---------- 一轮 run 的状态所有者：思考 / 说明 / 工具条目 + 当前那段话 + 用量 ----------
// 运行中的一切都在这里（内存），不进文档：经 SSE 推给前端，收尾时 manager 只把当前那段话写进回复块、
// 把整份 record 归档成过程页。三件事归这里管：
//   1. 换段判定：两段文字之间夹着工具调用或思考就是两段；新的一段第一个非空白字符到达时，
//      旧的一段收成说明条目（`said`）。前导空白不触发，调完工具吐个换行不该把正经回复顶走
//   2. 合批：正文 / 思考 / 子代理增量攒 100ms 一发；其它事件发出前先冲刷，类型切换也冲刷（保序）
//   3. 增量冲刷时才进状态：快照只含已发出的部分，中途订阅者拿快照再接后续事件不会重复文字
//
// 工具原始载荷（step.acp）、子代理正文 / 思考（step.output / thought）、用量与上下文
// （RunState.info）都随事件增量保留。step 事件只带变化字段（StepDelta），acp 可达 MB 不重发。

import {
  activityTail,
  applyRunEvent,
  closeThought,
  emptyRun,
  MAX_CHILD_TEXT,
  MAX_RUN_STEPS,
  MAX_THOUGHT_TOTAL,
  runTally,
  toolCount,
  type RunEntry,
  type RunEvent,
  type PlanEntry,
  type RunInfo,
  type RunState,
  type StepDelta,
  type TeamOp,
  type TeamState,
  type ToolEntry,
} from '@ramet/shared/run-model'
import { encodeStats } from '@ramet/shared/reply-stats'
import type { AgentEvent, PermissionEvent, TurnUsage } from './types.js'

export const FLUSH_MS = 100

export type RunOutcome = 'end' | 'cancelled' | 'error'

/** 过程页的持久形状（runs.record，jsonb）。老过程页迁移来的没有 ms / usage / 条目时间 */
export type RunRecordV1 = {
  v: 1
  agent: string
  parentId: string
  /** 产生它的回复块 id（老过程页迁移来的为空串） */
  replyId: string
  startedAt: number
  ms?: number
  outcome: RunOutcome
  usage?: TurnUsage
  context?: { used: number; size: number }
  /** 实时附加信息：完整 usage（含 cache/thought）、上下文（含 cost）、stopReason、ACP 元数据。 */
  info?: RunInfo
  /** agent 最后一份计划清单（ACP plan）；没报过就没有这一项 */
  plan?: PlanEntry[]
  /** 带队（/带队）的团队计划与每个任务的状态 / 时段（甘特的数据源）；不是带队的一轮没有这一项 */
  team?: TeamState
  /** 最终 AI 回复正文（state.text）；纯文本回合也要能进过程页，不重复成 say 条目 */
  output?: string
  entries: RunEntry[]
}

type ToolInput = Extract<AgentEvent, { type: 'tool' }>
type ChildBuf = { output?: string; thought?: string; truncated?: boolean }

/** tool 事件 → Step 增量：只带出现的字段，缺省保持上一份（status-only 更新不抹 rawInput/output） */
function toolDelta(ev: ToolInput): StepDelta {
  return {
    id: ev.id,
    ...(ev.kind !== undefined ? { kind: ev.kind } : {}),
    ...(ev.title !== undefined ? { title: ev.title } : {}),
    ...(ev.status !== undefined ? { status: ev.status } : {}),
    ...(ev.detail !== undefined ? { detail: ev.detail } : {}),
    ...(ev.note !== undefined ? { note: ev.note } : {}),
    ...(ev.parentId !== undefined ? { parentId: ev.parentId } : {}),
    ...(ev.activity !== undefined ? { activity: ev.activity } : {}),
    ...(ev.acp !== undefined ? { acp: ev.acp } : {}),
    ...(ev.truncated !== undefined ? { truncated: ev.truncated } : {}),
  }
}

export class RunRecord {
  readonly state: RunState = emptyRun()
  /** 最后一次 usage_update（上下文占用）；运行中不推给前端，收尾进 stats 与过程页 */
  context: { used: number; size: number; cost?: { amount: number; currency: string }; _meta?: unknown } | undefined
  private pending:
    | { type: 'reply' | 'think'; d: string; t: number }
    | { type: 'child'; id: string; kind: 'output' | 'thought' | 'terminal'; d: string; t: number }
    | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** 自上一段正文之后发生过工具调用或思考：下一次含非空白字符的正文要先换段 */
  private gap = false
  /** 子代理正文/思考比它的工具步骤先到：按 parentId 攒着，步骤出现时一并贴上（有上限，命中标 truncated） */
  private childBuf = new Map<string, ChildBuf>()
  /** 上限类信息只标一次（思考截断、步数超限），避免每个被丢的增量都发一条 */
  private capped: { thought: boolean; steps: boolean } = { thought: false, steps: false }

  constructor(
    readonly replyId: string,
    readonly startedAt: number,
    /** RunRecord 只发成品 RunEvent（run 快照与 AgentEvent 原料由调用方各自处理） */
    private emit: (ev: RunEvent) => void,
  ) {}

  elapsed(): number {
    return Date.now() - this.startedAt
  }

  /** agent = 跑这一轮的 agent（catalog id），随快照给前端（右上角岛画头像） */
  snapshot(agent?: string): AgentEvent {
    return { type: 'run', replyId: this.replyId, at: this.elapsed(), state: structuredClone(this.state), ...(agent ? { agent } : {}) }
  }

  text(delta: string, parentId?: string): void {
    if (!delta) return
    if (parentId) {
      this.appendChild(parentId, delta, 'output')
      return
    }
    if (this.gap) {
      if (!/\S/.test(delta)) return
      this.gap = false
      if (/\S/.test(this.state.text)) {
        this.flush()
        this.send({ type: 'said', t: this.elapsed() })
      }
    }
    this.queue('reply', delta)
  }

  thought(delta: string, parentId?: string): void {
    if (!delta) return
    if (parentId) {
      this.appendChild(parentId, delta, 'thought')
      return
    }
    this.gap = true
    const queued = this.pending?.type === 'think' ? this.pending.d.length : 0
    if (this.state.thoughtChars + queued >= MAX_THOUGHT_TOTAL) {
      // 到顶了：不再接正文（不无限流被丢弃的字），但把截断如实标记一次
      this.markCapped('thought')
      return
    }
    this.queue('think', delta)
  }

  tool(ev: ToolInput): void {
    this.gap = true
    const prev = this.state.entries.find((e): e is ToolEntry => e.k === 'tool' && e.id === ev.id)
    if (!prev && toolCount(this.state) >= MAX_RUN_STEPS) {
      this.markCapped('steps')
      return
    }
    const delta = toolDelta(ev)
    const buf = this.childBuf.get(ev.id)
    if (buf) {
      this.childBuf.delete(ev.id)
      if (delta.output === undefined && buf.output) delta.output = buf.output
      if (delta.thought === undefined && buf.thought) delta.thought = buf.thought
      if (buf.truncated) delta.truncated = true
      if (delta.activity === undefined && (buf.output || buf.thought)) {
        delta.activity = activityTail(`${buf.output ?? ''}\n${buf.thought ?? ''}`)
      }
    }
    this.flush()
    this.send({ type: 'step', step: delta, t: this.elapsed() })
  }

  /** 审批请求里的工具数据并入同一个工具步骤（同一个详情归属）：有 ACP toolCallId 就用它，与真实
   *  tool_call/update 合并成同一步；没有才退化到 requestId（fs/write_text_file 之类的纯闸门请求）。
   *  status/kind 原样留在 acp，不臆造完成。审批弹出前冲刷合批缓冲：前端看到的顺序 = 发生的顺序。
   *  由会话镜像在审批到达时调用（审批归会话、不归某一轮，不在轮次事件流里） */
  permission(ev: PermissionEvent): void {
    if (ev.toolCall) {
      const toolCallId = ev.toolCall.toolCallId
      this.tool({
        type: 'tool',
        id: typeof toolCallId === 'string' && toolCallId ? toolCallId : ev.requestId,
        ...(typeof ev.toolCall.title === 'string' ? { title: ev.toolCall.title } : {}),
        acp: { ...ev.toolCall, permission: { options: ev.options } },
      })
    }
    this.flush()
  }

  /** 子代理自己的正文/思考：追加到唤起它的那一步，不进父回复、不换段。
   *  步骤没到就先按 id 攒着（子正文比它的工具步骤先到），步骤出现时一并贴上；攒的也有上限 */
  private appendChild(id: string, delta: string, kind: 'output' | 'thought'): void {
    const prev = this.state.entries.find((e): e is ToolEntry => e.k === 'tool' && e.id === id)
    if (!prev) {
      const buf = this.childBuf.get(id) ?? {}
      const next = (buf[kind] ?? '') + delta
      if (next.length > MAX_CHILD_TEXT) {
        buf[kind] = next.slice(0, MAX_CHILD_TEXT)
        buf.truncated = true
      } else {
        buf[kind] = next
      }
      this.childBuf.set(id, buf)
      return
    }
    this.queueChild(id, kind, delta)
  }

  /** 给已有的步骤补字段（终端命令的退出状态等）。它不是一次新的工具调用，不触发换段（gap 不动）：
   *  命令退出的通知可能在 agent 正文说到一半时到达，不能把一句话劈成两段。步骤不在就丢 */
  patchStep(delta: StepDelta): void {
    if (!this.state.entries.some((e) => e.k === 'tool' && e.id === delta.id)) return
    this.flush()
    this.send({ type: 'step', step: delta, t: this.elapsed() })
  }

  /** ACP 终端里跑的命令的实时输出：追加到这一步的 output（不改 activity，见 run-model 的 child）。
   *  步骤不在（超出步数上限没建出来）就丢，不像子代理正文那样攒着，攒了也没有步骤可贴 */
  terminalOutput(id: string, delta: string): void {
    if (!delta || !this.state.entries.some((e) => e.k === 'tool' && e.id === id)) return
    this.queueChild(id, 'terminal', delta)
  }

  /** 子代理增量合批：与正文同一份缓冲，100ms 内同一步骤的同类增量发一条（不重发累计全文）。
   *  只在类型/步骤/类别切换时冲刷，相邻同类增量靠 pending 合并 */
  private queueChild(id: string, kind: 'output' | 'thought' | 'terminal', d: string): void {
    if (this.pending && this.pending.type !== 'child') this.flush()
    else if (this.pending && (this.pending.id !== id || this.pending.kind !== kind)) this.flush()
    if (this.pending && this.pending.type === 'child') this.pending.d += d
    else this.pending = { type: 'child', id, kind, d, t: this.elapsed() }
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS)
  }

  /** 上下文占用（usage_update）：cost/_meta 进 info.context（带 cost），顶层 context 只留 used/size */
  setContext(used: number, size: number, cost?: { amount: number; currency: string }, meta?: unknown): void {
    this.context = { used, size, ...(cost ? { cost } : {}), ...(meta !== undefined ? { _meta: meta } : {}) }
    this.info({ context: { used, size, ...(cost ? { cost } : {}), ...(meta !== undefined ? { _meta: meta } : {}) } })
  }

  /** info 快照：折进 state.info（按字段 / acp 按命名键合并）并推给前端 */
  info(info: RunInfo): void {
    if (!info.usage && !info.context && info.stopReason === undefined && !info.acp && info.truncated === undefined) return
    this.flush()
    this.send({ type: 'info', info, t: this.elapsed() })
  }

  /** agent 的计划清单（整份替换）。与当前一样就不发：TodoWrite 常常只是把同一份清单原样再报一遍 */
  plan(entries: PlanEntry[], truncated?: boolean): void {
    const prev = this.state.plan
    if (prev && prev.length === entries.length && JSON.stringify(prev) === JSON.stringify(entries) && !truncated) return
    if (!prev && entries.length === 0) return
    this.flush()
    this.send({ type: 'plan', entries, ...(truncated ? { truncated: true } : {}), t: this.elapsed() })
  }

  /** 带队的团队进度（计划整份替换 / 整体状态 / 单个任务的状态与时段）。原语全是绝对值、幂等；
   *  时间戳在这里盖（相对本轮开始）。多个组员并发地调它没问题，都在同一个事件循环里顺序归约 */
  team(op: TeamOp): void {
    this.flush()
    this.send({ type: 'team', ...op, t: this.elapsed() })
  }

  /** 冲刷合批缓冲（审批弹出、收尾前都要先冲：前端看到的顺序 = 发生的顺序） */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const p = this.pending
    if (!p) return
    this.pending = null
    if (p.type === 'child') this.send({ type: 'child', id: p.id, kind: p.kind, d: p.d, t: p.t })
    else this.send({ type: p.type, d: p.d, t: p.t })
  }

  /** 收尾：冲刷、结束还开着的思考、把父工具始终没出现而攒下的子代理正文落成一步 */
  close(): number {
    this.flush()
    this.drainChildBuf()
    const ms = this.elapsed()
    closeThought(this.state, ms)
    return ms
  }

  hasEntries(): boolean {
    return this.state.entries.length > 0
  }

  /** 有最终回复正文（纯文本回合也要归档过程页） */
  hasOutput(): boolean {
    return this.state.text.trim().length > 0
  }

  /** 有附加信息（用量/上下文/ACP 元数据/截断）：纯元数据回合也要归档，不谎称没有过程 */
  hasInfo(): boolean {
    return this.state.info !== undefined
  }

  /** 有一份非空的计划清单：只列了计划的回合同样要归档（计划也是过程的一部分） */
  hasPlan(): boolean {
    return (this.state.plan?.length ?? 0) > 0
  }

  /** 这一轮是带队的一轮（有团队计划）：只提交了计划 / 只有组员结果的回合同样要归档 */
  hasTeam(): boolean {
    return this.state.team !== undefined
  }

  /** 回复块 stats 属性（编码见 @ramet/shared/reply-stats） */
  stats(outcome: RunOutcome, ms: number, usage: TurnUsage | undefined): string {
    // 改动 / 协作的数：回复抬头停靠的岛直接读（同一个 runTally，前端对在飞的一轮现算）
    const tally = runTally(this.state, ms)
    return encodeStats({
      o: outcome,
      ms,
      st: toolCount(this.state),
      tk: usage?.total,
      in: usage?.input,
      out: usage?.output,
      cr: usage?.cacheRead,
      cw: usage?.cacheWrite,
      th: usage?.thought,
      cu: this.context?.used,
      cs: this.context?.size,
      // 0 不写（与老回复没有这个键对岛来说一样：不出这一段），属性不白长
      fc: tally.files.length || undefined,
      fa: tally.files.reduce((n, f) => n + f.add, 0) || undefined,
      fd: tally.files.reduce((n, f) => n + f.del, 0) || undefined,
      ag: tally.agents.length || undefined,
    })
  }

  record(
    meta: { agent: string; parentId: string },
    outcome: RunOutcome,
    ms: number,
    usage: TurnUsage | undefined,
  ): RunRecordV1 {
    const output = this.state.text
    // reducer 标了逐条截断（思考/说明命中上限）而 info 里还没标 → 归档时带上，别让归档页看不见
    let info = this.state.info
    if (this.state.truncated && !info?.truncated) info = { ...(info ?? {}), truncated: true }
    return {
      v: 1,
      agent: meta.agent,
      parentId: meta.parentId,
      replyId: this.replyId,
      startedAt: this.startedAt,
      ms,
      outcome,
      ...(usage ? { usage } : {}),
      ...(this.context ? { context: { used: this.context.used, size: this.context.size } } : {}),
      ...(info ? { info } : {}),
      ...(this.hasPlan() ? { plan: this.state.plan } : {}),
      ...(this.state.team ? { team: this.state.team } : {}),
      ...(output ? { output } : {}),
      entries: this.state.entries,
    }
  }

  /** 上限类标记只发一次，走 info 通道（进 state.info.truncated，快照与归档都看得到） */
  private markCapped(kind: 'thought' | 'steps'): void {
    if (this.capped[kind]) return
    this.capped[kind] = true
    this.info({ truncated: true })
  }

  /** 攒着但父工具一直没到：收尾时按 id 落一步，别把收到的子代理正文悄悄丢掉。
   *  落步也要守 MAX_RUN_STEPS；超了就如实标截断，不再新增条目 */
  private drainChildBuf(): void {
    for (const [id, buf] of this.childBuf) {
      if (!buf.output && !buf.thought) continue
      if (toolCount(this.state) >= MAX_RUN_STEPS) {
        this.markCapped('steps')
        continue
      }
      const step: StepDelta = {
        id,
        ...(buf.output ? { output: buf.output } : {}),
        ...(buf.thought ? { thought: buf.thought } : {}),
        ...(buf.truncated ? { truncated: true } : {}),
        activity: activityTail(`${buf.output ?? ''}\n${buf.thought ?? ''}`),
      }
      this.flush()
      this.send({ type: 'step', step, t: this.elapsed() })
    }
    this.childBuf.clear()
  }

  private queue(type: 'reply' | 'think', d: string): void {
    if (this.pending && this.pending.type !== type) this.flush()
    if (this.pending) this.pending.d += d
    else this.pending = { type, d, t: this.elapsed() }
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS)
  }

  private send(ev: RunEvent): void {
    applyRunEvent(this.state, ev)
    this.emit(ev)
  }
}
