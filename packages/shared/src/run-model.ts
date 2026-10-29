// ---------- 一轮 run 的过程模型：服务端 RunRecord 与前端 store 共用同一个 reducer ----------
// 条目按时间排：思考 / 说明（被新的一段话顶下来的旧话）/ 工具调用。`text` 是当前那段话，一轮结束时它就是回复。
// 事件是服务端已经决定好的原语：什么时候换段由服务端判定后显式发 `said`，reducer 只照做，
// 所以服务端的 record 与每个前端的状态必然一致（中途订阅 = 快照 + 之后的事件）。

/** kind/status 取 ACP ToolKind / ToolCallStatus 的字面量集合（协议外的值由适配层窄化） */
export type StepKind =
  | 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other'
export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

/** agent 报的本轮用量（ACP PromptResponse.usage，UNSTABLE）。缺项不补 0，没报就是没有 */
export type TurnUsage = {
  total: number
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  thought?: number
}

/** 一轮的实时附加信息：本轮用量、上下文占用（含 cost）、stop reason、以及 ACP 原样元数据。
 *  acp 按 sessionUpdate / 命名键存最近一份（promptResponse / notice ...；plan 有自己的原语，不在这里），未知字段也留着可查 */
export type RunInfo = {
  usage?: TurnUsage
  context?: { used: number; size: number; cost?: { amount: number; currency: string }; [key: string]: unknown }
  stopReason?: string
  acp?: Record<string, unknown>
  /** info/上下文等命中体积上限被截断（可见标记） */
  truncated?: boolean
}
/** detail = 首个 location 路径；note = 失败时工具输出的首行（都截断过，不带 diff/原始输出）。
 *  parentId = 这一步属于哪次子代理调用；activity = 这一步现在在做什么（快照，不进正文）。
 *  acp = 原始 tool_call/tool_call_update 字段（除 sessionUpdate/toolCallId）：rawInput/rawOutput/
 *  content/locations/_meta 等，增量合并；acp 里的键显式 null/[] 覆盖，缺省保持。
 *  output/thought = 子代理自己的正文/思考，与限长的 activity 分开保留。
 *  truncated = acp/output/thought 命中体积上限被截断（可见标记，不静默裁） */
export type Step = {
  id: string
  kind: StepKind
  title: string
  status: StepStatus
  detail?: string
  note?: string
  parentId?: string
  activity?: string
  acp?: Record<string, unknown>
  output?: string
  thought?: string
  truncated?: boolean
}

/** agent 的计划清单（ACP `plan` 会话更新的条目：content / priority / status，三个字段就是协议的全部）。
 *  agent 每次都发整份，客户端整份替换，所以它是 RunState 上的当前值，不是时间线条目 */
export type PlanStatus = 'pending' | 'in_progress' | 'completed'
export type PlanPriority = 'high' | 'medium' | 'low'
export type PlanEntry = { content: string; status: PlanStatus; priority?: PlanPriority }

/** 一份计划最多收这么多条、每条最多这么多字；超出的部分不记并标 truncated（可见，不静默裁） */
export const MAX_PLAN_ENTRIES = 100
export const MAX_PLAN_TEXT = 500

const PLAN_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed'])
const PLAN_PRIORITIES: ReadonlySet<string> = new Set(['high', 'medium', 'low'])

/** ACP / 持久化边界转成 PlanEntry[]：对端可能给任何形状，未知 status 落 pending、未知 priority 丢掉、
 *  空内容的条目跳过。服务端（acp.ts 收 plan 更新）与前端（读回复块上的 plan 属性）共用这一个，口径不会漂 */
export function normalizePlan(raw: unknown): { entries: PlanEntry[]; truncated: boolean } {
  const list = Array.isArray(raw) ? raw : []
  const entries: PlanEntry[] = []
  let truncated = list.length > MAX_PLAN_ENTRIES
  for (const item of list.slice(0, MAX_PLAN_ENTRIES)) {
    if (!item || typeof item !== 'object') continue
    const { content, status, priority } = item as Record<string, unknown>
    if (typeof content !== 'string' || !content.trim()) continue
    const text = content.trim()
    if (text.length > MAX_PLAN_TEXT) truncated = true
    entries.push({
      content: text.slice(0, MAX_PLAN_TEXT),
      status: typeof status === 'string' && PLAN_STATUSES.has(status) ? (status as PlanStatus) : 'pending',
      ...(typeof priority === 'string' && PLAN_PRIORITIES.has(priority) ? { priority: priority as PlanPriority } : {}),
    })
  }
  return { entries, truncated }
}

/** 回复块 `plan` 属性（节点 attrs 里不能放对象，存 JSON 串）：收尾时服务端写、前端读。空计划是空串（不写属性） */
export function encodePlan(entries: readonly PlanEntry[] | undefined): string {
  return entries && entries.length > 0 ? JSON.stringify(entries) : ''
}

export function decodePlan(raw: unknown): PlanEntry[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    return normalizePlan(JSON.parse(raw)).entries
  } catch {
    return []
  }
}

/** 计划进度：已完成几条 / 共几条 */
export function planProgress(entries: readonly PlanEntry[]): { done: number; total: number } {
  return { done: entries.filter((e) => e.status === 'completed').length, total: entries.length }
}

/** 增量步骤负载：run 事件在线上只带变化字段（acp/output 可达 MB），合并归 mergeStep */
export type StepDelta = { id: string } & Partial<Omit<Step, 'id'>>

/** acp 载荷的增量合并：缺省键保持，显式值（含 null/[]）覆盖 */
function mergeAcp(prev: Record<string, unknown> | undefined, delta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...prev }
  for (const [k, v] of Object.entries(delta)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

/** 把一条增量并进已有 Step。服务端 RunRecord 与前端 reducer 共用同一份语义：
 *  缺省字段保持原值，status-only 更新不会抹掉上一份 rawInput/output */
export function mergeStep(prev: Step | undefined, delta: StepDelta): Step {
  const base: Step = prev ?? { id: delta.id, kind: 'other', title: '', status: 'pending' }
  const merged: Step = { ...base, ...delta }
  if (delta.acp !== undefined) merged.acp = mergeAcp(base.acp, delta.acp)
  return merged
}

/** 工具狂刷保护：一轮最多收这么多步 */
export const MAX_RUN_STEPS = 200
/** 单条思考/说明的字数上限，与整轮思考累计上限（超出的部分不记也不推，命中即标记 truncated） */
export const MAX_ENTRY_TEXT = 20_000
export const MAX_THOUGHT_TOTAL = 300_000
/** 子代理「现在在做什么」只留最近这一截（快照，不进正文）；完整 output/thought 另行保留 */
export const MAX_ACTIVITY_TEXT = 160
/** 单个工具的子代理正文/思考上限：超出即标记 truncated（可见），不静默裁 */
export const MAX_CHILD_TEXT = 1_000_000

/** 压平空白，只留末尾 MAX_ACTIVITY_TEXT 字 */
export function activityTail(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_ACTIVITY_TEXT ? flat.slice(-MAX_ACTIVITY_TEXT) : flat
}

/** 子代理正文/思考超出上限就截到上限并标 truncated（可见，不静默） */
function capChildText(step: ToolEntry): void {
  for (const field of ['output', 'thought'] as const) {
    const text = step[field]
    if (text !== undefined && text.length > MAX_CHILD_TEXT) {
      step[field] = text.slice(0, MAX_CHILD_TEXT)
      step.truncated = true
    }
  }
}

/** t / end 是相对本轮开始的毫秒；迁移来的旧过程页条目没有时间。
 *  truncated：该条命中字数上限被截断（可见标记，不静默裁） */
export type ThoughtEntry = { k: 'thought'; t?: number; end?: number; text: string; truncated?: boolean }
export type SayEntry = { k: 'say'; t?: number; end?: number; text: string; truncated?: boolean }
export type ToolEntry = { k: 'tool'; t?: number; end?: number } & Step
export type RunEntry = ThoughtEntry | SayEntry | ToolEntry

export type RunState = {
  entries: RunEntry[]
  /** 当前那段话 */
  text: string
  /** 当前那段话第一批 / 最后一批字到达的时刻；还没开口为 null */
  textAt: number | null
  textEnd: number | null
  /** 当前那段话开口时条目列表的长度：被顶下来时按这个位置插回（它比之后的工具/思考更早） */
  textSlot: number | null
  /** 整轮已记录的思考字数（上限判定用） */
  thoughtChars: number
  /** 实时附加信息（用量 / 上下文 / stop reason / ACP 元数据）；无则缺省 */
  info?: RunInfo
  /** agent 当前的计划清单（ACP plan，整份替换）；没报过 = 缺省，报过空清单 = [] */
  plan?: PlanEntry[]
  /** 带队（/带队）的团队计划与执行进度；不是带队的一轮缺省。见下面「带队」一节 */
  team?: TeamState
  /** 思考/说明命中字数上限被截断（可见标记，不静默裁） */
  truncated?: boolean
}

export type RunEvent =
  | { type: 'reply'; d: string; t: number }
  | { type: 'think'; d: string; t: number }
  | { type: 'said'; t: number }
  /** step 只带变化字段（StepDelta）；合并语义见 mergeStep */
  | { type: 'step'; step: StepDelta; t: number }
  /** 子代理正文/思考的增量：追加到 id 那一步的 output/thought（不重发累计全文）。
   *  kind 'terminal' 是这一步（ACP 终端里跑的命令）的实时输出：同样追加到 output，但不改 activity。
   *  activity 会顶替这一步的一行文字（stepLabel），命令的标签始终是命令本身，不能被输出的最后一行顶掉 */
  | { type: 'child'; id: string; d: string; kind: 'output' | 'thought' | 'terminal'; t: number }
  /** info 快照：按字段合并，acp 按命名键合并 */
  | { type: 'info'; info: RunInfo; t: number }
  /** agent 的计划清单：整份替换（服务端已归一，truncated = 超出条数 / 字数上限被截断） */
  | { type: 'plan'; entries: PlanEntry[]; truncated?: boolean; t: number }
  /** 带队的团队进度（计划整份替换 / 整体状态 / 单个任务的状态与时段）：服务端已决定好的原语，reducer 幂等 */
  | ({ type: 'team'; t: number } & TeamOp)

export function emptyRun(): RunState {
  return { entries: [], text: '', textAt: null, textEnd: null, textSlot: null, thoughtChars: 0 }
}

export function isTerminal(status: StepStatus): boolean {
  return status === 'completed' || status === 'failed'
}

export function toolCount(state: RunState): number {
  let n = 0
  for (const entry of state.entries) if (entry.k === 'tool') n++
  return n
}

/* ---------- 一步的一行：动词 + 文字（过程页的行、状态条、提示词里的过程摘要共用）----------
 * 过程页的步骤是文档里的块（`run_step`）：块里放的就是这一行的字（用户能改的那一份，也是进上下文的那一份），
 * 完整详情（工具输入输出 / diff / 子代理正文）只在不可变的 runs.record，按 sid 取。动词表与一行里的对象
 * 只在这里定义一次，server 写块、web 画行、server 拼提示词都从这里读。 */
export const STEP_VERB: Record<StepKind, string> = {
  read: '读取',
  edit: '编辑',
  delete: '删除',
  move: '移动',
  search: '搜索',
  execute: '执行',
  think: '思考',
  fetch: '获取',
  switch_mode: '切换模式',
  other: '调用',
}

/** 动作词：思考 / 说明各有固定的一个，工具按类型（块 attrs 里是任意字符串，协议外的值兜底「调用」） */
export function stepVerb(k: string, kind?: string): string {
  if (k === 'thought') return '思考'
  if (k === 'say') return '说明'
  return STEP_VERB[kind as StepKind] ?? STEP_VERB.other
}

/** 一行里的对象：工具依次取子代理当前动作、标题（标题自带同一个动作词时去掉，免得「读取 读取 …」）、路径；
 *  思考 / 说明取原文 */
export function stepLabel(e: RunEntry): string {
  if (e.k !== 'tool') return e.text
  if (e.activity) return e.activity
  const verb = STEP_VERB[e.kind] ?? ''
  const title = verb && e.title.startsWith(verb) ? e.title.slice(verb.length).trim() : e.title
  return title || e.detail || ''
}

/** 步骤标识：块与 record 里那一条的唯一连接。record 不可变，所以下标永远稳定：
 *  工具用 ACP toolCallId，思考 / 说明没有 id，用 `${k}:${下标}`（下标是在 record.entries 里的位置） */
export function entrySid(e: RunEntry, index: number): string {
  return e.k === 'tool' ? e.id : `${e.k}:${index}`
}

function openThought(state: RunState): ThoughtEntry | null {
  const last = state.entries[state.entries.length - 1]
  return last?.k === 'thought' && last.end === undefined ? last : null
}

/** 思考被任何别的事件（正文、工具、换段、收尾）结束 */
export function closeThought(state: RunState, t: number): void {
  const open = openThought(state)
  if (open) open.end = t
}

export function applyRunEvent(state: RunState, ev: RunEvent): void {
  switch (ev.type) {
    case 'reply': {
      closeThought(state, ev.t)
      if (state.textAt === null) {
        state.textAt = ev.t
        state.textSlot = state.entries.length
      }
      state.text += ev.d
      state.textEnd = ev.t
      return
    }
    case 'think': {
      const open = openThought(state)
      const room = Math.min(MAX_THOUGHT_TOTAL - state.thoughtChars, MAX_ENTRY_TEXT - (open?.text.length ?? 0))
      if (room <= 0) {
        state.truncated = true
        if (open) open.truncated = true
        return
      }
      const d = ev.d.slice(0, room)
      if (d.length < ev.d.length) {
        state.truncated = true
        if (open) open.truncated = true
      }
      state.thoughtChars += d.length
      if (open) open.text += d
      else state.entries.push({ k: 'thought', t: ev.t, text: d, ...(d.length < ev.d.length ? { truncated: true } : {}) })
      return
    }
    case 'said': {
      closeThought(state, ev.t)
      const text = state.text.trim()
      if (text) {
        const clipped = text.length > MAX_ENTRY_TEXT
        const say: SayEntry = { k: 'say', t: state.textAt ?? ev.t, end: state.textEnd ?? ev.t, text: text.slice(0, MAX_ENTRY_TEXT) }
        if (clipped) {
          say.truncated = true
          state.truncated = true
        }
        state.entries.splice(state.textSlot ?? state.entries.length, 0, say)
      }
      state.text = ''
      state.textAt = null
      state.textEnd = null
      state.textSlot = null
      return
    }
    case 'step': {
      const hit = state.entries.find((e): e is ToolEntry => e.k === 'tool' && e.id === ev.step.id)
      if (hit) {
        Object.assign(hit, mergeStep(hit, ev.step))
        capChildText(hit)
        if (hit.end === undefined && isTerminal(hit.status)) hit.end = ev.t
        return
      }
      if (toolCount(state) >= MAX_RUN_STEPS) return
      closeThought(state, ev.t)
      const step = mergeStep(undefined, ev.step)
      const entry: ToolEntry = { k: 'tool', t: ev.t, ...step, ...(isTerminal(step.status) ? { end: ev.t } : {}) }
      // 首插的步骤也要过限长（子代理正文可能先攒着、在步骤里一次带进来）
      capChildText(entry)
      state.entries.push(entry)
      return
    }
    case 'child': {
      const hit = state.entries.find((e): e is ToolEntry => e.k === 'tool' && e.id === ev.id)
      if (!hit) return
      const field = ev.kind === 'thought' ? 'thought' : 'output'
      hit[field] = (hit[field] ?? '') + ev.d
      capChildText(hit)
      if (ev.kind !== 'terminal') hit.activity = activityTail(`${hit.output ?? ''}\n${hit.thought ?? ''}`)
      return
    }
    case 'info': {
      state.info = mergeInfo(state.info, ev.info)
      return
    }
    case 'plan': {
      state.plan = ev.entries
      if (ev.truncated) state.truncated = true
      return
    }
    case 'team': {
      applyTeamOp(state, ev)
      return
    }
  }
}

/** info 快照合并：普通字段显式值覆盖（含 null），acp 按命名键合并 */
export function mergeInfo(prev: RunInfo | undefined, next: RunInfo): RunInfo {
  const merged: RunInfo = { ...prev }
  if (next.usage !== undefined) merged.usage = next.usage
  if (next.context !== undefined) merged.context = next.context
  if (next.stopReason !== undefined) merged.stopReason = next.stopReason
  if (next.truncated !== undefined) merged.truncated = next.truncated
  if (next.acp !== undefined) {
    const acp = { ...merged.acp }
    for (const [k, v] of Object.entries(next.acp)) {
      if (v !== undefined) acp[k] = v
    }
    merged.acp = acp
  }
  return merged
}

// ---------- 带队（/带队）：团队计划与执行进度 ----------
// 带队分两轮（各自是普通的一轮）：计划轮里组长提交一份计划（draft），用户在计划卡上改完点「开工」后的执行轮里，
// 中心按依赖调度组员（并行 ≤ 4），组长最后交叉审查。`team` 原语把计划和每个任务的状态与时段放在这一轮的 RunState 上，
// 实时视图、回复块上的 `team` 属性、过程页 record、甘特都从它读；reducer 两端同源（服务端 RunRecord 与前端 store）。
// 时间 t / end / waits 全部是相对本轮开始的毫秒；甘特画每个任务的 spans（一次执行一段，打回重做会多一段），
// waits 是这段里在等人批准的时段（打斜线）。

export type TeamStatus = 'draft' | 'running' | 'done' | 'cancelled' | 'error'
export type TeamTaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled'

/** 带队的上限：服务端校验（提交计划 / 改计划）与前端输入限制共用 */
export const TEAM_LIMITS = {
  tasks: 8,
  title: 100,
  detail: 4000,
  /** 任务 id：字母数字、-、_ */
  idPattern: /^[A-Za-z0-9_-]{1,32}$/,
  assignee: 200,
  cwd: 1000,
  goal: 2000,
  /** 并行执行的组员数 */
  parallel: 4,
  /** 每个任务最多被组长打回几次 */
  sendBack: 2,
  /** team 原语里每个任务带的结果摘要 / 失败原因字数（完整结果只在组长的提示词里，不进文档） */
  output: 2000,
  error: 500,
} as const

export type TeamWait = { t: number; end?: number }
export type TeamSpan = { t: number; end?: number; waits?: TeamWait[] }

export type TeamTask = {
  id: string
  title: string
  detail?: string
  /** 负责人（agent catalog id）与显示名（提交 / 改动时记下，机器离线后仍能显示） */
  assignee: string
  label?: string
  dependsOn: string[]
  /** 组员的工作目录（执行端机器上的路径）；缺省 = 页面上该 agent 当前的工作区 */
  cwd?: string
  /** 发起人此刻能不能用这个 agent（服务端按发起人现算）；false 的计划不能开工 */
  usable?: boolean
  status: TeamTaskStatus
  spans: TeamSpan[]
  /** 已被组长打回几次 */
  backs?: number
  error?: string
  output?: string
  /** 组员做了几步（工具调用数） */
  steps?: number
}

export type TeamState = {
  planId: string
  title: string
  goal?: string
  /** 组长（agent catalog id） */
  leader: string
  status: TeamStatus
  tasks: TeamTask[]
}

/** 页面 SSE 的 `team_plan` 事件与 GET /api/pages/:id/team/:planId 的形状：计划（TeamState）加发起人。
 *  mine（我是不是发起人）只在 GET 里有，广播是发给所有订阅者的，不能带因人而异的字段 */
export type TeamPlanView = TeamState & {
  pageId: string
  initiatorId: string
  initiator: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  mine?: boolean
}

export type TeamTaskPatch = Partial<Pick<TeamTask, 'status' | 'backs' | 'error' | 'output' | 'steps'>>

/** team 事件的载荷：
 *  plan 整份替换；status 改整体状态；task 改一个任务（patch 是绝对值，span / wait 的 open / close 对已开 / 已关是空操作）。
 *  所有操作幂等：快照加之后的事件、或重放同一条，结果不变 */
export type TeamOp =
  | { op: 'plan'; team: TeamState }
  | { op: 'status'; status: TeamStatus }
  | { op: 'task'; id: string; patch?: TeamTaskPatch; span?: 'open' | 'close'; wait?: 'open' | 'close' }

const lastOf = <T>(list: T[] | undefined): T | undefined => list?.[list.length - 1]

function applyTeamOp(state: RunState, ev: { t: number } & TeamOp): void {
  if (ev.op === 'plan') {
    state.team = structuredClone(ev.team)
    return
  }
  const team = state.team
  if (!team) return
  if (ev.op === 'status') {
    team.status = ev.status
    return
  }
  const task = team.tasks.find((x) => x.id === ev.id)
  if (!task) return
  const patch = ev.patch
  if (patch) {
    if (patch.status !== undefined) task.status = patch.status
    if (patch.backs !== undefined) task.backs = patch.backs
    if (patch.steps !== undefined) task.steps = patch.steps
    if (patch.error !== undefined) task.error = patch.error.slice(0, TEAM_LIMITS.error)
    if (patch.output !== undefined) task.output = patch.output.slice(0, TEAM_LIMITS.output)
  }
  const span = lastOf(task.spans)
  if (ev.span === 'open' && (!span || span.end !== undefined)) task.spans.push({ t: ev.t })
  else if (ev.span === 'close' && span && span.end === undefined) {
    span.end = ev.t
    // 这一段结束时还在等人批准的，等待一并收口
    const wait = lastOf(span.waits)
    if (wait && wait.end === undefined) wait.end = ev.t
  }
  const cur = lastOf(task.spans)
  if (ev.wait && cur && cur.end === undefined) {
    const wait = lastOf(cur.waits)
    if (ev.wait === 'open' && (!wait || wait.end !== undefined)) (cur.waits ??= []).push({ t: ev.t })
    else if (ev.wait === 'close' && wait && wait.end === undefined) wait.end = ev.t
  }
}

const TEAM_STATUSES: ReadonlySet<string> = new Set(['draft', 'running', 'done', 'cancelled', 'error'])
const TEAM_TASK_STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'done', 'failed', 'skipped', 'cancelled'])

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

function normalizeSpans(raw: unknown): TeamSpan[] {
  const out: TeamSpan[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue
    const { t, end, waits } = item as Record<string, unknown>
    const start = num(t)
    if (start === undefined) continue
    const span: TeamSpan = { t: start, ...(num(end) !== undefined ? { end: num(end)! } : {}) }
    const ws: TeamWait[] = []
    for (const w of Array.isArray(waits) ? waits : []) {
      const wt = num((w as Record<string, unknown> | null)?.t)
      if (wt === undefined) continue
      const we = num((w as Record<string, unknown>).end)
      ws.push({ t: wt, ...(we !== undefined ? { end: we } : {}) })
    }
    if (ws.length > 0) span.waits = ws
    out.push(span)
  }
  return out
}

/** 持久化边界转成 TeamState：回复块属性 / 过程页 record 里读出来的东西可能是任何形状，结构不对返回 null，字段按上限收口 */
export function normalizeTeam(raw: unknown): TeamState | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const planId = str(r.planId, 100)
  const title = str(r.title, TEAM_LIMITS.title)
  const leader = str(r.leader, TEAM_LIMITS.assignee)
  if (!planId || title === undefined || leader === undefined) return null
  const status = typeof r.status === 'string' && TEAM_STATUSES.has(r.status) ? (r.status as TeamStatus) : 'error'
  const tasks: TeamTask[] = []
  for (const item of (Array.isArray(r.tasks) ? r.tasks : []).slice(0, TEAM_LIMITS.tasks)) {
    if (!item || typeof item !== 'object') continue
    const t = item as Record<string, unknown>
    const id = str(t.id, 32)
    if (!id) continue
    const detail = str(t.detail, TEAM_LIMITS.detail)
    const label = str(t.label, TEAM_LIMITS.assignee)
    const cwd = str(t.cwd, TEAM_LIMITS.cwd)
    const error = str(t.error, TEAM_LIMITS.error)
    const output = str(t.output, TEAM_LIMITS.output)
    tasks.push({
      id,
      title: str(t.title, TEAM_LIMITS.title) ?? '',
      ...(detail ? { detail } : {}),
      assignee: str(t.assignee, TEAM_LIMITS.assignee) ?? '',
      ...(label ? { label } : {}),
      dependsOn: (Array.isArray(t.dependsOn) ? t.dependsOn : []).filter((d): d is string => typeof d === 'string').slice(0, TEAM_LIMITS.tasks),
      ...(cwd ? { cwd } : {}),
      ...(typeof t.usable === 'boolean' ? { usable: t.usable } : {}),
      status: typeof t.status === 'string' && TEAM_TASK_STATUSES.has(t.status) ? (t.status as TeamTaskStatus) : 'pending',
      spans: normalizeSpans(t.spans),
      ...(num(t.backs) !== undefined ? { backs: num(t.backs)! } : {}),
      ...(error ? { error } : {}),
      ...(output ? { output } : {}),
      ...(num(t.steps) !== undefined ? { steps: num(t.steps)! } : {}),
    })
  }
  const goal = str(r.goal, TEAM_LIMITS.goal)
  return { planId, title, ...(goal ? { goal } : {}), leader, status, tasks }
}

/** 回复块 `team` 属性（节点 attrs 里不能放对象，存 JSON 串）：收尾时服务端写、前端读。没有就是空串（不写属性） */
export function encodeTeam(team: TeamState | undefined): string {
  return team ? JSON.stringify(team) : ''
}

export function decodeTeam(raw: unknown): TeamState | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    return normalizeTeam(JSON.parse(raw))
  } catch {
    return null
  }
}

/** 任务进度：已完成几个 / 共几个（甘特与胶囊用） */
export function teamProgress(team: TeamState): { done: number; total: number } {
  return { done: team.tasks.filter((x) => x.status === 'done').length, total: team.tasks.length }
}

// ---------- @ 点名链的进度（一串 run 的进度；放在这里是因为不为它多开 shared 子路径，改 exports 会让部署机重建环境镜像）----------
// 链的进度就是文档本身：最后一条用户消息里 @ 到的 agent（按出现顺序，catalog id）加它之后已有几条回复。
// 回复块是按 @ 的顺序一家一家追加的（含失败的那条），所以已有几条回复就是已经轮过的家数，下一家是 agents[replied]。
// 服务端（Yjs 文档，决定下一个跑谁）与前端（ProseMirror 文档，失败条上要不要出「继续剩下的」）各自把顶层块
// 摊成 ChainBlock 再喂给这一个函数，规则只有这一份，两端不会各算各的。
// 没有 @ 任何 agent 返回 null（走普通的单家发送）。

export type ChainBlock =
  | { kind: 'user_message'; mentions: readonly string[] }
  | { kind: 'agent_reply' }
  | { kind: 'other' }

export type MentionChain = { agents: string[]; replied: number }

export function mentionChainOf(blocks: Iterable<ChainBlock>): MentionChain | null {
  let mentions: readonly string[] | null = null
  let replied = 0
  for (const block of blocks) {
    if (block.kind === 'user_message') {
      mentions = block.mentions
      replied = 0
    } else if (block.kind === 'agent_reply' && mentions) replied++
  }
  return mentions && mentions.length > 0 ? { agents: [...mentions], replied } : null
}

/** 还没轮到的家数（链已经走完或没有链是 0） */
export function chainRest(chain: MentionChain | null): number {
  return chain ? Math.max(0, chain.agents.length - chain.replied) : 0
}


// ---------- 转出行级 diff 与一轮的统计口径（同样不新增 shared 子路径） ----------
export { DIFF_CONTEXT, foldDiff, lineDiff, type DiffLine } from './line-diff.js'
export { runTally, SPEND_KEYS, type RunTally, type SpendKey, type TallyAgent, type TallyFile } from './run-tally.js'
