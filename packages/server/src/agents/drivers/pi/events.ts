// ---------- pi / omp 的会话事件 → AgentEvent ----------
// 一个会话一个翻译器（每会话一个进程）。只翻译「一轮的过程」与斜杠命令；一轮的收尾（agent_settled / prompt_result /
// session_settled）由会话认领，这里只记下收尾要用的用量与最后一条 assistant 消息的结局：
//
//   message_update 的 text_delta / thinking_delta   → text / thought
//   message_end（assistant，没逐字流过的部分）       → text / thought 整块补发；累计用量；记下 stopReason / errorMessage；
//                                                     消息里的 toolCall 记成「已请求、还没开始执行」（ask 的对话框先于执行到达）
//   tool_execution_start                           → tool（kind / 标题 / 视图由 tools.ts 算，in_progress）
//   tool_execution_update                          → 命令类：terminal 原料事件（累计值换算成增量）；其它：activity
//   tool_execution_end                             → tool 增量（状态、结果、退出码）；todo → plan；task 是后台作业时那一步保持进行中
//   subagent_lifecycle / progress / event（omp）    → 子代理挂在唤起它的 task 那一步下（view.handle = 子代理 id，可单独停）
//   compaction_*、auto_retry_*、extension_error     → info
//   available_commands_update（omp）               → commands
//   model_changed（omp）/ thinking_level_changed    → 交给会话更新配置项（不是一轮的过程）

import { normalizePlan, type RunInfo } from '@ramet/shared/run-model'
import type { AgentCommand, AgentEvent, TurnUsage } from '../../types.js'
import { clipValue, NOTE_MAX, oneLine, rec, str, stripAnsi } from '../tool-text.js'
import type { Model, OmpSlashCommand, PiEvent, PiSlashCommand, SubagentLifecycle, SubagentProgress, Usage } from './protocol.js'
import {
  contentText,
  isAsyncRunning,
  outputDelta,
  PLAN_TOOL,
  STREAMING_TOOLS,
  SUBAGENT_TOOL,
  todoEntries,
  toolDone,
  toolFace,
  type ToolFace,
} from './tools.js'

/** parentId：子代理里的工具（挂在子代理那一步下）；asked：已经有一张审批卡挂在这一步上 */
type ToolSeen = { name: string; args: unknown; output: string; face?: ToolFace; done: boolean; parentId?: string; asked?: boolean }

/** CLI 报的配置变化（当前模型 / 思考档位） */
export type SettingsChange = { model?: Model | null; thinking?: string }

/** 一个子代理：挂在哪一步下、还在不在跑、它当前这条消息有没有逐字流过 */
type Sub = { stepId: string; live: boolean; streamed: boolean }

/** 子代理那一步（omp 的 task 调用；一次调用可能起好几个子代理） */
type SubStep = { subs: Set<string>; closed: boolean; handle: boolean }

/** 归属还不知道时（子代理帧先于它的 lifecycle 到达）最多攒这么多条 */
const BUFFER_MAX = 500

const META_EVENTS: ReadonlySet<string> = new Set([
  'compaction_start', 'compaction_end', 'auto_compaction_start', 'auto_compaction_end', 'manual_compaction_start', 'manual_compaction_end',
  'auto_retry_start', 'auto_retry_end', 'extension_error', 'rpc_frame_error',
])

/** 进 info 的原样元数据（info.acp 是「agent 原样元数据」那一格，按事件名存最近一份） */
function metaInfo(ev: Record<string, unknown>): RunInfo {
  const { type, ...rest } = ev
  const { value, truncated } = clipValue(rest)
  return { acp: { [String(type)]: value }, ...(truncated ? { truncated: true } : {}) }
}

/** 斜杠命令：pi 的 get_commands 与 omp 的 get_available_commands / available_commands_update */
export function commandsOf(list: Array<PiSlashCommand | OmpSlashCommand>): AgentCommand[] {
  return list
    .filter((c) => c && typeof c.name === 'string' && c.name)
    .map((c) => {
      const hint = 'input' in c ? str(rec(c.input).hint) : ''
      return { name: c.name, description: c.description ?? null, input: hint || null }
    })
}

function addUsage(a: TurnUsage | undefined, u: Usage): TurnUsage {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const b: TurnUsage = {
    total: num(u.totalTokens) || num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite),
    input: num(u.input),
    output: num(u.output),
    cacheRead: num(u.cacheRead),
    cacheWrite: num(u.cacheWrite),
    ...(typeof u.reasoning === 'number' ? { thought: u.reasoning } : {}),
  }
  if (!a) return b
  return {
    total: a.total + b.total,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
    cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
    ...(a.thought !== undefined || b.thought !== undefined ? { thought: (a.thought ?? 0) + (b.thought ?? 0) } : {}),
  }
}

export type LastStop = { stopReason: string; errorMessage?: string }

export class PiEvents {
  private readonly tools = new Map<string, ToolSeen>()
  /** assistant 消息里已经请求、还没开始执行的工具调用（id → 名字 / 参数）：ask 的对话框先于它的执行开始到达 */
  private readonly requested = new Map<string, { name: string; args: unknown }>()
  private readonly subs = new Map<string, Sub>()
  private readonly subSteps = new Map<string, SubStep>()
  private readonly buffered = new Map<string, Array<{ kind: 'event' | 'progress'; ev: unknown }>>()
  /** 主线这条 assistant 消息的正文 / 思考有没有逐字流过（整块到达时据此决定补不补发） */
  private streamedText = false
  private streamedThought = false
  /** 上一段正文还没被工具 / 思考隔开：下一条消息的正文开头补一个空行，免得两条消息首尾粘在一起 */
  private textOpen = false
  private usage: TurnUsage | undefined
  private last: LastStop | undefined

  constructor(
    private readonly sessionId: string,
    private readonly emit: (ev: AgentEvent) => void,
    private readonly onCommands: (list: AgentCommand[]) => void,
    private readonly onSettings: (change: SettingsChange) => void = () => {},
  ) {}

  /** 一轮开始：用量与结局复位 */
  beginTurn(): void {
    this.usage = undefined
    this.last = undefined
    this.textOpen = false
  }

  /** 一轮结束（含强制收尾）：还开着的子代理步骤收掉，子代理的归属作废（之后的晚到帧不再落到下一轮上） */
  endTurn(cancelled: boolean): void {
    for (const [stepId, step] of this.subSteps) {
      if (!step.closed) this.closeStep(stepId, step, cancelled ? 'failed' : 'completed', cancelled ? '已停止' : undefined)
    }
    this.subSteps.clear()
    this.subs.clear()
    this.buffered.clear()
    this.tools.clear()
    this.requested.clear()
  }

  get turnUsage(): TurnUsage | undefined {
    return this.usage
  }

  /** 这一轮最后一条 assistant 消息的结局（出错 / 被中止 / 正常） */
  get lastStop(): LastStop | undefined {
    return this.last
  }

  faceOf(id: string): ToolFace | undefined {
    return this.tools.get(id)?.face
  }

  /** 审批卡挂到哪一步：还在执行、还没挂过审批的这个工具最近的一次调用，主线与子代理里的都算（omp 的审批 select
   *  只带工具名，到达时这一步已经开始；子代理的审批也经主会话的对话框问）。挂过的记下，同名的下一张卡落到别的调用上 */
  claimLive(name: string): string | undefined {
    let found: string | undefined
    for (const [id, t] of this.tools) if (t.name === name && !t.done && !t.asked && t.face) found = id
    if (found) this.tools.get(found)!.asked = true
    return found
  }

  /** 已请求、还没开始执行的这个工具最近的一次调用（omp 的 ask 对话框先于 ask 的执行开始）。顺手把这一步先开出来，
   *  提问的答案要写进它 */
  claimRequested(name: string): string | undefined {
    let found: string | undefined
    for (const [id, c] of this.requested) if (c.name === name) found = id
    if (!found) return undefined
    const call = this.requested.get(found)!
    this.requested.delete(found)
    this.startTool(found, call.name, call.args)
    return found
  }

  /** 子代理那一步现在还能停的子代理（句柄 = 其中任一个子代理 id，停的是这一步） */
  liveSubagents(handle: string): string[] {
    const sub = this.subs.get(handle)
    const step = sub ? this.subSteps.get(sub.stepId) : undefined
    if (!step || step.closed) return []
    return [...step.subs].filter((id) => this.subs.get(id)?.live)
  }

  handle(ev: PiEvent): void {
    const e = ev as unknown as Record<string, unknown>
    if (META_EVENTS.has(ev.type)) return this.emit({ type: 'info', info: metaInfo(e), sessionId: this.sessionId })
    switch (ev.type) {
      case 'message_start':
        if (rec(ev.message).role === 'assistant') {
          this.streamedText = false
          this.streamedThought = false
        }
        return
      case 'message_update': {
        const a = rec(ev.assistantMessageEvent)
        if (a.type === 'text_delta') this.say(str(a.delta))
        else if (a.type === 'thinking_delta') this.think(str(a.delta))
        return
      }
      case 'message_end':
        return this.messageEnd(rec(ev.message))
      case 'tool_execution_start':
        this.requested.delete(ev.toolCallId)
        return this.startTool(ev.toolCallId, ev.toolName, ev.args)
      case 'tool_execution_update':
        return this.updateTool(ev.toolCallId, ev.partialResult)
      case 'tool_execution_end':
        return this.endTool(ev.toolCallId, ev.toolName, ev.result, ev.isError)
      case 'available_commands_update':
        return this.onCommands(commandsOf(Array.isArray(ev.commands) ? ev.commands : []))
      case 'model_changed':
        return this.onSettings({ model: ev.model ?? null })
      case 'thinking_level_changed':
        return typeof ev.level === 'string' ? this.onSettings({ thinking: ev.level }) : undefined
      case 'subagent_lifecycle':
        return this.lifecycle(rec(ev.payload) as unknown as SubagentLifecycle)
      case 'subagent_progress':
        return this.progress(rec(ev.payload) as unknown as SubagentProgress)
      case 'subagent_event': {
        const p = rec(ev.payload)
        return this.subEvent(str(p.id), p.event)
      }
      default:
    }
  }

  // ---------- 正文 / 思考 ----------

  private say(delta: string, parentId?: string): void {
    if (!delta) return
    if (!parentId) {
      if (!this.streamedText && this.textOpen) this.emit({ type: 'text', delta: '\n\n', sessionId: this.sessionId })
      this.streamedText = true
      this.textOpen = true
    }
    this.emit({ type: 'text', delta, sessionId: this.sessionId, ...(parentId ? { parentId } : {}) })
  }

  private think(delta: string, parentId?: string): void {
    if (!delta) return
    if (!parentId) {
      this.streamedThought = true
      this.textOpen = false
    }
    this.emit({ type: 'thought', delta, sessionId: this.sessionId, ...(parentId ? { parentId } : {}) })
  }

  private messageEnd(msg: Record<string, unknown>): void {
    if (msg.role !== 'assistant') return
    const content = Array.isArray(msg.content) ? msg.content.map(rec) : []
    // 没逐字流过（有的模型 / 服务只给整块）：整块补发
    if (!this.streamedThought) this.think(content.filter((b) => b.type === 'thinking').map((b) => str(b.thinking)).join('\n\n'))
    if (!this.streamedText) this.say(content.filter((b) => b.type === 'text').map((b) => str(b.text)).join(''))
    this.streamedText = false
    this.streamedThought = false
    for (const b of content) if (b.type === 'toolCall' && str(b.id)) this.requested.set(str(b.id), { name: str(b.name), args: b.arguments })
    if (msg.usage && typeof msg.usage === 'object') this.usage = addUsage(this.usage, msg.usage as Usage)
    const stopReason = str(msg.stopReason)
    if (stopReason && stopReason !== 'toolUse') this.last = { stopReason, ...(str(msg.errorMessage) ? { errorMessage: str(msg.errorMessage) } : {}) }
  }

  // ---------- 工具 ----------

  private startTool(id: string, name: string, args: unknown, parentId?: string): void {
    if (!id) return
    const seen = this.tools.get(id)
    if (seen) return
    if (name === PLAN_TOOL && !parentId) return void this.tools.set(id, { name, args, output: '', done: false })
    const face = toolFace(name, args)
    this.tools.set(id, { name, args, output: '', face, done: false, ...(parentId ? { parentId } : {}) })
    if (!parentId) this.textOpen = false
    this.emit({
      type: 'tool',
      id,
      kind: face.kind,
      title: face.title,
      status: 'in_progress',
      ...(face.detail ? { detail: face.detail } : {}),
      view: face.view,
      ...(face.truncated ? { truncated: true } : {}),
      ...(parentId ? { parentId } : {}),
      sessionId: this.sessionId,
    })
    // 子代理那一步的一行字跟着它正在做的事走
    if (parentId) this.emit({ type: 'tool', id: parentId, activity: face.title, sessionId: this.sessionId })
  }

  private updateTool(id: string, partial: unknown): void {
    const t = this.tools.get(id)
    if (!t || t.done || !t.face) return
    const text = stripAnsi(contentText(rec(partial).content))
    if (STREAMING_TOOLS.has(t.name)) {
      const delta = outputDelta(t.output, text)
      t.output = text
      if (delta) this.emit({ type: 'terminal', id, delta, sessionId: this.sessionId })
      return
    }
    const activity = oneLine(text.split('\n').filter((l) => l.trim()).at(-1) ?? '', NOTE_MAX)
    if (activity) this.emit({ type: 'tool', id, activity, sessionId: this.sessionId })
  }

  private endTool(id: string, name: string, result: unknown, isError: boolean, parentId?: string): void {
    let t = this.tools.get(id)
    if (!t) {
      // 没见过开始（订阅晚了 / 帧丢了）：先补一步再收尾
      this.startTool(id, name, undefined, parentId)
      t = this.tools.get(id)
      if (!t) return
    }
    if (t.done) return
    t.done = true
    if (!t.face) {
      if (isError) return
      const { entries, truncated } = normalizePlan(todoEntries(result))
      return this.emit({ type: 'plan', entries, ...(truncated ? { truncated: true } : {}), sessionId: this.sessionId })
    }
    const done = toolDone(t.name, t.args, result, isError)
    // 后台作业：工具当场结束、子代理还在跑。这一步跟着子代理走，子代理结束（或这一轮收尾）时才收
    const background = t.name === SUBAGENT_TOOL && !isError && isAsyncRunning(result)
    const step = this.subSteps.get(id)
    if (background && !step) this.subSteps.set(id, { subs: new Set(), closed: false, handle: false })
    // 子代理比这条结束帧先跑完了：那一步已经按子代理的结局收过，不再改状态
    const status = step?.closed ? undefined : background ? 'in_progress' : done.status
    this.emit({
      type: 'tool',
      id,
      ...(status ? { status } : {}),
      view: done.view,
      ...(done.note ? { note: done.note } : {}),
      ...(done.truncated ? { truncated: true } : {}),
      sessionId: this.sessionId,
    })
  }

  // ---------- 子代理（omp） ----------

  private link(subId: string, stepId: string): Sub | undefined {
    if (!subId || !stepId) return undefined
    let sub = this.subs.get(subId)
    if (sub) return sub
    sub = { stepId, live: true, streamed: false }
    this.subs.set(subId, sub)
    let step = this.subSteps.get(stepId)
    if (!step) {
      step = { subs: new Set(), closed: false, handle: false }
      this.subSteps.set(stepId, step)
    }
    step.subs.add(subId)
    step.closed = false
    if (!step.handle) {
      step.handle = true
      this.emit({ type: 'tool', id: stepId, status: 'in_progress', view: { handle: subId }, sessionId: this.sessionId })
    }
    const queued = this.buffered.get(subId) ?? []
    this.buffered.delete(subId)
    for (const q of queued) {
      if (q.kind === 'event') this.subEvent(subId, q.ev)
      else this.progress(q.ev as SubagentProgress)
    }
    return sub
  }

  private buffer(subId: string, kind: 'event' | 'progress', ev: unknown): void {
    const list = this.buffered.get(subId) ?? []
    if (list.length >= BUFFER_MAX) return
    list.push({ kind, ev })
    this.buffered.set(subId, list)
  }

  private lifecycle(p: SubagentLifecycle): void {
    const subId = str(p.id)
    const sub = p.status === 'started' ? this.link(subId, str(p.parentToolCallId)) : this.subs.get(subId) ?? this.link(subId, str(p.parentToolCallId))
    if (!sub || p.status === 'started') return
    sub.live = false
    const step = this.subSteps.get(sub.stepId)
    if (!step || step.closed) return
    // 一步唤起了几个子代理：都结束了这一步才收尾
    if ([...step.subs].some((id) => this.subs.get(id)?.live)) return
    if (p.status === 'completed') this.closeStep(sub.stepId, step, 'completed')
    else this.closeStep(sub.stepId, step, 'failed', p.status === 'aborted' ? '已停止' : '子代理出错')
  }

  private progress(p: SubagentProgress): void {
    const progress = rec(p.progress)
    const subId = str(progress.id)
    const sub = this.subs.get(subId) ?? this.link(subId, str(p.parentToolCallId))
    if (!sub) return void (subId && this.buffer(subId, 'progress', p))
    const recent = Array.isArray(progress.recentTools) ? progress.recentTools.map(rec) : []
    const lastTool = recent.at(-1)
    const activity = oneLine(lastTool ? str(lastTool.tool) || str(lastTool.name) : '', NOTE_MAX)
    if (activity) this.emit({ type: 'tool', id: sub.stepId, activity, sessionId: this.sessionId })
  }

  /** 子代理里的工具 id 带上子代理 id：几个子代理各自从头编号，不能撞到主线或彼此的步骤上 */
  private subEvent(subId: string, raw: unknown): void {
    const sub = this.subs.get(subId)
    if (!sub) return void (subId && this.buffer(subId, 'event', raw))
    const ev = rec(raw)
    const parentId = sub.stepId
    const toolId = (id: unknown) => `${subId}#${str(id)}`
    switch (ev.type) {
      case 'message_start':
        sub.streamed = false
        return
      case 'message_update': {
        const a = rec(ev.assistantMessageEvent)
        if (a.type === 'text_delta') {
          sub.streamed = true
          this.say(str(a.delta), parentId)
        } else if (a.type === 'thinking_delta') this.think(str(a.delta), parentId)
        return
      }
      case 'message_end': {
        const msg = rec(ev.message)
        if (msg.role !== 'assistant' || sub.streamed) return
        const content = Array.isArray(msg.content) ? msg.content.map(rec) : []
        this.say(content.filter((b) => b.type === 'text').map((b) => str(b.text)).join(''), parentId)
        return
      }
      case 'tool_execution_start':
        return this.startTool(toolId(ev.toolCallId), str(ev.toolName), ev.args, parentId)
      case 'tool_execution_update':
        return this.updateTool(toolId(ev.toolCallId), ev.partialResult)
      case 'tool_execution_end':
        return this.endTool(toolId(ev.toolCallId), str(ev.toolName), ev.result, ev.isError === true, parentId)
      default:
    }
  }

  private closeStep(stepId: string, step: SubStep, status: 'completed' | 'failed', note?: string): void {
    step.closed = true
    this.emit({ type: 'tool', id: stepId, status, activity: '', ...(note ? { note } : {}), sessionId: this.sessionId })
  }
}
