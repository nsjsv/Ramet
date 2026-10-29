/* ---------- 带队前端的纯函数 ----------
 * 甘特布局、任务的展示状态、计划卡能不能改 / 能不能开工、运行条上的一句话、审批卡来自哪个组员。
 * 不碰 DOM 和 React，也不拿文案：文案在 team-copy.ts，组件按这里给出的结构去拼。
 * 数据形状在 @ramet/shared/run-model（TeamState / TeamTask / TeamPlanView，服务端 RunRecord 与前端 store 用同一个 reducer 归约）。
 * 时间全是相对本轮开始的毫秒，现在也要换算成同一个基准（本机时钟减 run.startedAt），由调用方传 now。 */

import type { TeamPlanView, TeamSpan, TeamState, TeamTask, TeamTaskStatus } from '@ramet/shared/run-model'

const FINAL: ReadonlySet<TeamTaskStatus> = new Set(['done', 'failed', 'skipped', 'cancelled'])

/** 任务收尾了（不会再变，除非被组长打回重做） */
export const isTaskFinal = (status: TeamTaskStatus): boolean => FINAL.has(status)

const lastOf = <T>(list: readonly T[] | undefined): T | undefined => list?.[list.length - 1]

export type TaskView = 'pending' | 'running' | 'ask' | 'done' | 'failed' | 'skipped' | 'cancelled'

/** 这个任务此刻正在等人批准（最后一段还开着、其中最后一个等待也还开着） */
export function isWaiting(task: TeamTask): boolean {
  const span = lastOf(task.spans)
  const wait = lastOf(span?.waits)
  return span !== undefined && span.end === undefined && wait !== undefined && wait.end === undefined
}

/** 行上显示的状态：进行中且在等批准算 ask，单独一档 */
export function taskView(task: TeamTask): TaskView {
  if (task.status === 'running') return isWaiting(task) ? 'ask' : 'running'
  return task.status
}

/** 依赖用序号（从 1 起，#1、#2）展示，id 是组长随手起的英文名，不给人看 */
export function depNumbers(task: TeamTask, team: TeamState, opts: { unmetOnly?: boolean } = {}): number[] {
  const out: number[] = []
  for (const id of task.dependsOn) {
    const i = team.tasks.findIndex((x) => x.id === id)
    if (i < 0) continue
    if (opts.unmetOnly && team.tasks[i]!.status === 'done') continue
    out.push(i + 1)
  }
  return out
}

/** 负责人显示名：当前目录里的名字 > 提交 / 改动时记下的名字 > id */
export function assigneeLabel(task: Pick<TeamTask, 'assignee' | 'label'>, lookup: (agentId: string) => string | undefined): string {
  return lookup(task.assignee)?.trim() || task.label?.trim() || task.assignee
}

/** team 里出现过的最大时刻，开着的段按它收口（静态视图没有现在可用） */
function knownEnd(team: TeamState): number {
  let max = 0
  for (const task of team.tasks) {
    for (const span of task.spans) {
      max = Math.max(max, span.t, span.end ?? 0)
      for (const wait of span.waits ?? []) max = Math.max(max, wait.t, wait.end ?? 0)
    }
  }
  return max
}

const spanEnd = (span: TeamSpan, now: number | undefined, fallback: number): number => span.end ?? Math.max(span.t, now ?? fallback)

/** 一个任务干了多久，各段相加，打回重做的间隔不算；没开始过返回 null */
export function taskElapsed(task: TeamTask, now?: number): number | null {
  if (task.spans.length === 0) return null
  const fallback = Math.max(...task.spans.map((s) => s.end ?? s.t))
  return task.spans.reduce((sum, span) => sum + Math.max(0, spanEnd(span, now, fallback) - span.t), 0)
}

/** 组员阶段的墙钟用时：第一个开工到最后一个收工（还在跑的算到 now），一个都没开始是 0 */
export function teamWall(team: TeamState, now?: number): number {
  const spans = team.tasks.flatMap((t) => t.spans)
  if (spans.length === 0) return 0
  const fallback = knownEnd(team)
  const t0 = Math.min(...spans.map((s) => s.t))
  return Math.max(0, Math.max(...spans.map((s) => spanEnd(s, now, fallback))) - t0)
}

/** 颜色槽数（CSS 的 --team-c0..c4）：同一个 agent 恒用同一种颜色 */
export const SLOT_COUNT = 5
/** 最短的条宽（占轴的百分比）：很短的任务也要看得见 */
const MIN_WIDTH = 0.6
/** 轴最短一秒：刚开工第一帧不会除以 0 */
const MIN_TOTAL = 1000

export type GanttWait = { left: number; width: number; ms: number }
export type GanttSeg = {
  /** 占整条轴的百分比 */
  left: number
  width: number
  /** 相对本轮开始的毫秒（提示文字用） */
  from: number
  to: number
  /** 还在跑（条会随时间伸长，末端呼吸）：只有传了 now 且这段没收口 */
  live: boolean
  /** 第二段起 = 被组长打回重做 */
  again: boolean
  /** 这一段里等批准的时段，占这一段宽度的百分比（打斜线） */
  waits: GanttWait[]
}
export type GanttRow = { id: string; title: string; assignee: string; slot: number; segs: GanttSeg[] }
export type Gantt = {
  rows: GanttRow[]
  /** 轴的起点与总长（毫秒，相对本轮开始） */
  t0: number
  total: number
  /** 出现过的负责人，按首次出现排；颜色槽与行里一致 */
  legend: Array<{ assignee: string; slot: number }>
  hasWait: boolean
}

/** 甘特布局。每个任务一行（没开始的也占一行，行不会中途冒出来），一个任务都没开工返回 null。
 *  now 缺省是静态视图，开着的段按已知的最晚时刻收口，不当作还在跑 */
export function ganttLayout(team: TeamState, now?: number): Gantt | null {
  const spans = team.tasks.flatMap((t) => t.spans)
  if (spans.length === 0) return null
  const fallback = knownEnd(team)
  const t0 = Math.min(...spans.map((s) => s.t))
  const tEnd = Math.max(...spans.map((s) => spanEnd(s, now, fallback)))
  const total = Math.max(MIN_TOTAL, tEnd - t0)
  const pct = (ms: number): number => (ms / total) * 100

  const slots = new Map<string, number>()
  for (const task of team.tasks) if (!slots.has(task.assignee)) slots.set(task.assignee, slots.size % SLOT_COUNT)

  let hasWait = false
  const rows = team.tasks.map((task): GanttRow => {
    const segs = task.spans.map((span, i): GanttSeg => {
      const end = spanEnd(span, now, fallback)
      const left = Math.min(100 - MIN_WIDTH, pct(span.t - t0))
      const width = Math.max(MIN_WIDTH, Math.min(100 - left, pct(end - span.t)))
      const len = Math.max(1, end - span.t)
      const waits: GanttWait[] = []
      for (const w of span.waits ?? []) {
        const from = Math.max(span.t, w.t)
        const to = Math.min(end, w.end ?? end)
        if (to <= from) continue
        waits.push({ left: ((from - span.t) / len) * 100, width: ((to - from) / len) * 100, ms: to - from })
      }
      if (waits.length > 0) hasWait = true
      return { left, width, from: span.t, to: end, live: span.end === undefined && now !== undefined, again: i > 0, waits }
    })
    return { id: task.id, title: task.title, assignee: task.assignee, slot: slots.get(task.assignee) ?? 0, segs }
  })
  return { rows, t0, total, legend: [...slots].map(([assignee, slot]) => ({ assignee, slot })), hasWait }
}

export type TeamNow = { phase: 'prepare' | 'run' | 'review'; running: number; done: number; total: number }

/** 执行轮里组长自己还没开口的那段（组员先干，干完组长才建会话），胶囊上显示组员的进展，不是思考中 */
export function teamNow(team: TeamState): TeamNow {
  const total = team.tasks.length
  const running = team.tasks.filter((t) => t.status === 'running').length
  const done = team.tasks.filter((t) => t.status === 'done').length
  const allFinal = total > 0 && team.tasks.every((t) => isTaskFinal(t.status))
  const started = team.tasks.some((t) => t.spans.length > 0)
  const phase = running > 0 ? 'run' : allFinal ? 'review' : started ? 'run' : 'prepare'
  return { phase, running, done, total }
}

/** 带队执行中，某个 agent 发来的审批是哪些任务在等：先看开着的等待，没有（事件顺序差一拍）再看该 agent 正在跑的任务。
 *  foreign 表示这个 agent 不是组长（组员在问）；tasks 为空且不是 foreign 说明是组长自己在问，不需要额外说明 */
export function askSource(team: TeamState | undefined, agentId: string): { tasks: TeamTask[]; foreign: boolean } {
  if (!team || team.status !== 'running') return { tasks: [], foreign: false }
  const mine = team.tasks.filter((t) => t.assignee === agentId && t.status === 'running')
  const waiting = mine.filter(isWaiting)
  return { tasks: waiting.length > 0 ? waiting : mine, foreign: agentId !== team.leader }
}

/** 我是不是这份计划的发起人。广播（team_plan）不带因人而异的 mine，所以用 initiatorId 对，GET 的 mine 只作补充 */
export function isInitiator(view: Pick<TeamPlanView, 'initiatorId' | 'mine'>, selfId: string): boolean {
  if (view.initiatorId) return view.initiatorId === selfId
  return view.mine === true
}

/** 计划卡可编辑：草稿、我是发起人、页面可写。服务端还会再判一次，这里只决定摆不摆控件 */
export function canEditPlan(view: Pick<TeamPlanView, 'status' | 'initiatorId' | 'mine'>, selfId: string, canWrite: boolean): boolean {
  return canWrite && view.status === 'draft' && isInitiator(view, selfId)
}

export type StartBlocker = 'loading' | 'empty' | 'unusable' | 'busy'

/** 开工前挡一道：没有计划视图、没有任务、有负责人你用不了、页面上已有 agent 在生成。null 表示可以开工。
 *  usable === false 才算用不了，缺省是服务端没标，开工时服务端会逐个再判，不在这里替它拒 */
export function startBlocker(view: Pick<TeamPlanView, 'tasks'> | null, pageBusy: boolean): StartBlocker | null {
  if (!view) return 'loading'
  if (view.tasks.length === 0) return 'empty'
  if (view.tasks.some((t) => t.usable === false || !t.assignee)) return 'unusable'
  if (pageBusy) return 'busy'
  return null
}

/** 计划视图里不可用的任务 id（卡上逐个标出来） */
export const unusableIds = (view: Pick<TeamPlanView, 'tasks'>): string[] => view.tasks.filter((t) => t.usable === false).map((t) => t.id)

/** 计划卡显示的模式：草稿还是进度（已开工之后）。以来源快照的状态为准，
 *  计划轮回复上的快照恒是草稿，执行轮的快照一开始就是 running */
export const isPlanSnapshot = (team: Pick<TeamState, 'status'>): boolean => team.status === 'draft'
