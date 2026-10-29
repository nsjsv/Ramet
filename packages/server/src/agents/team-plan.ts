// ---------- 带队计划：校验、落库、视图、改计划 / 取消 / 开工的守卫 ----------
// 带队分两轮（各自是普通的一轮，页面互斥 / 归档 / 收尾全部沿用 runTurn）：
//   计划轮：用户发 `/带队 <目标>`，组长 agent 经 MCP 工具 submit_plan 提交一份计划 → team_plans（draft）→ 回复里出计划卡；
//   执行轮：发起人在计划卡上改完点开工 → POST /continue {team: planId}，中心按依赖调度组员（agents/team.ts），组长最后交叉审查。
// 这个文件管计划本身：
//   - 组长给的东西一律不信：validatePlan 严格校验（≤8 个任务、id / 标题 / 说明长度、依赖只能指向已有任务且无环），
//     组长给的 cwd 一概忽略；每个任务的负责人 usable 是此刻发起人能不能用（manager.resolve 的结果，现算，不落库）；
//   - 只有发起人（计划所属用户）能改计划 / 取消 / 开工，还要页面可写（路由已判）；改负责人必须是发起人此刻 resolve 得通的 agent；
//     工作目录必须是那台机器上 listWorkspaceDirs 能列出的目录（落库的是执行端 realpath 之后的绝对路径）；
//   - draft → running 的翻转是一条带条件的 UPDATE（并发的两次开工只有一个赢）。
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { TEAM_LIMITS, type TeamPlanView, type TeamState, type TeamStatus, type TeamTask } from '@ramet/shared/run-model'
import { revokeTeamGrants } from '../page-read.js'
import type { ResolvedAgent } from './manager-types.js'
import { ForbiddenError } from './posture.js'
import { runOutcome } from './run-finalize.js'
import type { RunState, TeamRound } from './run-state.js'
import type { AgentEvent } from './types.js'

export class TeamPlanError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export type PlanTask = {
  id: string
  title: string
  detail: string
  assignee: string
  /** 负责人的显示名（提交 / 换人时记下） */
  label: string
  dependsOn: string[]
  /** 工作目录（执行端机器上的绝对路径）；只能由发起人在计划卡上设，组长给的被忽略 */
  cwd?: string
}
export type PlanData = { title: string; tasks: PlanTask[] }

export type PlanRow = {
  id: string
  page_id: string
  user_id: string
  initiator: string
  leader_agent: string
  status: TeamStatus
  goal: string
  plan: PlanData
  run_id: string | null
  result: TeamState | null
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
}

export type UserRef = { id: string; role: string }

// ---------- 校验（纯函数）----------

function bad(message: string): never {
  throw new TeamPlanError(400, 'invalid plan', message)
}

/** 组长交来的计划整理成干净的 PlanData（assignee 只验是字符串，能不能用由 usable 另算；label 之后补；cwd 一概不收）。
 *  不合格抛 TeamPlanError(400)，message 是写给组长看的（它要据此改了重交） */
export function validatePlan(raw: unknown): Omit<PlanData, 'tasks'> & { tasks: Array<Omit<PlanTask, 'label'>> } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('计划必须是一个对象：{ title, tasks }')
  const { title: rawTitle, tasks: rawTasks } = raw as Record<string, unknown>
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : ''
  if (!title) bad('缺少计划标题 title')
  if (title.length > TEAM_LIMITS.title) bad(`计划标题不能超过 ${TEAM_LIMITS.title} 字`)
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) bad('tasks 必须是至少包含一个任务的数组')
  if (rawTasks.length > TEAM_LIMITS.tasks) bad(`任务最多 ${TEAM_LIMITS.tasks} 个，把相关的合并一下`)
  const ids = new Set<string>()
  const tasks: Array<Omit<PlanTask, 'label'>> = []
  rawTasks.forEach((item: unknown, i) => {
    const at = `第 ${i + 1} 个任务`
    if (!item || typeof item !== 'object' || Array.isArray(item)) bad(`${at}必须是对象`)
    const t = item as Record<string, unknown>
    const id = typeof t.id === 'string' ? t.id : ''
    if (!TEAM_LIMITS.idPattern.test(id)) bad(`${at}的 id「${String(t.id ?? '')}」不合法：只能用字母、数字、- 和 _，最长 32 个字符`)
    if (ids.has(id)) bad(`任务 id「${id}」重复了`)
    ids.add(id)
    const taskTitle = typeof t.title === 'string' ? t.title.trim() : ''
    if (!taskTitle) bad(`任务 ${id} 缺少标题 title`)
    if (taskTitle.length > TEAM_LIMITS.title) bad(`任务 ${id} 的标题不能超过 ${TEAM_LIMITS.title} 字`)
    if (t.detail !== undefined && typeof t.detail !== 'string') bad(`任务 ${id} 的 detail 必须是字符串`)
    const detail = typeof t.detail === 'string' ? t.detail.trim() : ''
    if (detail.length > TEAM_LIMITS.detail) bad(`任务 ${id} 的说明不能超过 ${TEAM_LIMITS.detail} 字`)
    const assignee = typeof t.assignee === 'string' ? t.assignee.trim() : ''
    if (!assignee) bad(`任务 ${id} 缺少负责人 assignee（从可用组员里选一个 id）`)
    if (assignee.length > TEAM_LIMITS.assignee) bad(`任务 ${id} 的 assignee 太长`)
    if (t.dependsOn !== undefined && (!Array.isArray(t.dependsOn) || t.dependsOn.some((d) => typeof d !== 'string'))) {
      bad(`任务 ${id} 的 dependsOn 必须是任务 id 的数组`)
    }
    tasks.push({ id, title: taskTitle, detail, assignee, dependsOn: [...new Set((t.dependsOn as string[] | undefined) ?? [])] })
  })
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.id) bad(`任务 ${task.id} 不能依赖自己`)
      if (!ids.has(dep)) bad(`任务 ${task.id} 依赖的「${dep}」不在计划里`)
    }
  }
  // 环：反复摘掉入度为 0 的任务，摘不完就有环
  const left = new Map(tasks.map((t) => [t.id, new Set(t.dependsOn)]))
  for (;;) {
    const free = [...left].filter(([, deps]) => deps.size === 0).map(([id]) => id)
    if (free.length === 0) break
    for (const id of free) left.delete(id)
    for (const deps of left.values()) for (const id of free) deps.delete(id)
  }
  if (left.size > 0) bad(`任务的依赖成环了：${[...left.keys()].join('、')}`)
  return { title, tasks }
}

// ---------- 落库 ----------

const SELECT_PLAN = `SELECT t.id, t.page_id, t.user_id, u.username AS initiator, t.leader_agent, t.status, t.goal, t.plan, t.run_id,
  t.result, t.created_at, t.started_at, t.finished_at
  FROM team_plans t JOIN users u ON u.id = t.user_id WHERE t.id = $1`
// 同一个计划轮重复提交会覆盖同一行（组长改主意了），但只在还是 draft 时：已经开工 / 取消的不许再被组长改
const INSERT_PLAN = `INSERT INTO team_plans (id, page_id, user_id, leader_agent, goal, plan, run_id)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
  ON CONFLICT (run_id) WHERE run_id IS NOT NULL DO UPDATE SET plan = EXCLUDED.plan, goal = EXCLUDED.goal
  WHERE team_plans.status = 'draft'
  RETURNING id`
const UPDATE_DRAFT = `UPDATE team_plans SET plan = $2::jsonb WHERE id = $1 AND status = 'draft' RETURNING id`
const CANCEL_DRAFT = `UPDATE team_plans SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status = 'draft' RETURNING id`
const START_PLAN = `UPDATE team_plans SET status = 'running', started_at = now()
  WHERE id = $1 AND user_id = $2 AND page_id = $3 AND status = 'draft' RETURNING id`
const FINISH_PLAN = `UPDATE team_plans SET status = $2, finished_at = now(), result = $3::jsonb WHERE id = $1 AND status = 'running'`
const SWEEP_RUNNING = `UPDATE team_plans SET status = 'error', finished_at = now() WHERE status = 'running'`
const SELECT_USER = 'SELECT id, role FROM users WHERE id = $1'

/** 启动时清扫：进程重启后不可能还有在跑的执行轮（组员阶段由中心驱动，随进程没了）。返回清扫了几份 */
export async function sweepRunningPlans(pool: Pool): Promise<number> {
  return (await pool.query(SWEEP_RUNNING)).rowCount ?? 0
}

/** 执行轮收尾时的计划状态：与 team 原语里发的 status 同一个判定（runOutcome） */
export function teamStatusOf(run: RunState): Exclude<TeamStatus, 'draft' | 'running'> {
  const outcome = runOutcome(run)
  return outcome === 'end' ? 'done' : outcome === 'cancelled' ? 'cancelled' : 'error'
}

/** 计划行转成团队状态（任务全是 pending）。usable 缺省就不标 */
export function draftState(row: Pick<PlanRow, 'id' | 'leader_agent' | 'goal' | 'plan' | 'status'>, usable?: Map<string, boolean>): TeamState {
  return {
    planId: row.id,
    title: row.plan.title,
    ...(row.goal ? { goal: row.goal } : {}),
    leader: row.leader_agent,
    status: row.status,
    tasks: row.plan.tasks.map((t): TeamTask => ({
      id: t.id,
      title: t.title,
      ...(t.detail ? { detail: t.detail } : {}),
      assignee: t.assignee,
      ...(t.label ? { label: t.label } : {}),
      dependsOn: t.dependsOn,
      ...(t.cwd ? { cwd: t.cwd } : {}),
      ...(usable ? { usable: usable.get(t.assignee) ?? false } : {}),
      status: 'pending',
      spans: [],
    })),
  }
}

/** 管理器交给计划模块的能力（计划模块不碰 manager 的私有状态，同 SubRunHost） */
export type TeamPlansHost = {
  pool: Pool
  /** 机器使用权的唯一判定（manager.resolve）：不可用的 agent 抛 ForbiddenError，不存在 / 离线 null */
  resolve(agentId: string, user: UserRef): Promise<ResolvedAgent | null>
  /** 该用户能用的 agent 清单 */
  catalog(user: UserRef): Promise<Array<{ id: string; label: string }>>
  /** 列执行端目录（manager.listWorkspaceDirs；已含 agent 范围的授权判定）：返回的 path 是执行端 realpath 之后的绝对路径 */
  listDirs(pageId: string, agentId: string, path: string, user: UserRef): Promise<{ path: string }>
  broadcast(pageId: string, ev: AgentEvent): void
  /** 执行轮在跑时，这份计划的实时团队状态（没有在跑就是 undefined） */
  liveTeam(planId: string): TeamState | undefined
}

const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\)/

export class TeamPlans {
  constructor(private host: TeamPlansHost) {}

  async load(planId: string): Promise<PlanRow | null> {
    return (await this.host.pool.query<PlanRow>(SELECT_PLAN, [planId])).rows[0] ?? null
  }

  private async userRef(userId: string): Promise<UserRef | null> {
    return (await this.host.pool.query<UserRef>(SELECT_USER, [userId])).rows[0] ?? null
  }

  /** 这个 agent 发起人此刻能不能用（manager.resolve 签得出凭据）。不存在 / 离线 / 没授权都是 false */
  private async usable(user: UserRef, agentId: string): Promise<boolean> {
    try {
      return (await this.host.resolve(agentId, user)) !== null
    } catch (err) {
      if (err instanceof ForbiddenError) return false
      throw err
    }
  }

  /** 发起人能用的 agent（计划轮告诉组长有哪些组员可选） */
  candidates(user: UserRef): Promise<Array<{ id: string; label: string }>> {
    return this.host.catalog(user)
  }

  /** 视图：计划 + 谁发起的。草稿现算 usable（按发起人）；执行中取实时状态，收尾后取收尾时存下的结果；状态以行为准 */
  async view(row: PlanRow, viewerId?: string): Promise<TeamPlanView> {
    let state: TeamState | undefined
    if (row.status === 'running') state = this.host.liveTeam(row.id)
    else if (row.status !== 'draft') state = row.result ?? undefined
    if (state) state = { ...state, status: row.status }
    else {
      const initiator = row.status === 'draft' ? await this.userRef(row.user_id) : null
      const usable = new Map<string, boolean>()
      if (initiator) for (const t of row.plan.tasks) usable.set(t.assignee, await this.usable(initiator, t.assignee))
      state = draftState(row, initiator ? usable : undefined)
    }
    return {
      ...state,
      pageId: row.page_id,
      initiatorId: row.user_id,
      initiator: row.initiator,
      createdAt: row.created_at.toISOString(),
      ...(row.started_at ? { startedAt: row.started_at.toISOString() } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at.toISOString() } : {}),
      ...(viewerId !== undefined ? { mine: viewerId === row.user_id } : {}),
    }
  }

  /** 页面上的一份计划（GET）：计划必须属于这一页，否则当不存在 */
  async get(pageId: string, planId: string, viewerId: string): Promise<TeamPlanView> {
    const row = await this.load(planId)
    if (!row || row.page_id !== pageId) throw new TeamPlanError(404, 'plan not found', '没有这份计划')
    return this.view(row, viewerId)
  }

  /** 发起人守卫：计划属于这一页、操作的人就是发起人、还是 draft。改计划 / 取消 / 开工预检共用 */
  private async mine(pageId: string, planId: string, user: UserRef): Promise<PlanRow> {
    const row = await this.load(planId)
    if (!row || row.page_id !== pageId) throw new TeamPlanError(404, 'plan not found', '没有这份计划')
    if (row.user_id !== user.id) throw new TeamPlanError(403, 'forbidden', `这份计划是 ${row.initiator} 发起的，只有他能操作`)
    if (row.status !== 'draft') {
      const now: Record<string, string> = { running: '已经开工', done: '已经做完', cancelled: '已经取消', error: '已经中止' }
      throw new TeamPlanError(409, 'plan not draft', `这份计划${now[row.status] ?? '不在草稿状态'}，不能再改了`)
    }
    return row
  }

  private async publish(row: PlanRow): Promise<TeamPlanView> {
    const view = await this.view((await this.load(row.id)) ?? row)
    this.host.broadcast(row.page_id, { type: 'team_plan', plan: view })
    return view
  }

  // ---------- 计划轮：组长提交 ----------

  /** 组长调 submit_plan：校验 → 落库（draft）→ 本轮 RunRecord 里出现 team 原语（回复里的计划卡）→ 广播。
   *  同一个计划轮重复提交覆盖上一份（只在还是 draft 时）。raw 里的 cwd 一概不收 */
  async submit(run: RunState, raw: unknown): Promise<{ planId: string }> {
    if (run.team?.kind !== 'plan' || run.closed || run.cancelled) {
      throw new TeamPlanError(409, 'round over', '这一轮已经结束了，提交不了计划')
    }
    const plan = validatePlan(raw)
    const user = await this.userRef(run.userId)
    if (!user) throw new TeamPlanError(404, 'user not found', '发起人不存在了')
    const labels = new Map((await this.host.catalog(user)).map((a) => [a.id, a.label]))
    const data: PlanData = { title: plan.title, tasks: plan.tasks.map((t) => ({ ...t, label: labels.get(t.assignee) ?? '' })) }
    const saved = await this.host.pool.query<{ id: string }>(INSERT_PLAN, [
      randomUUID(), run.pageId, run.userId, run.adapterKey, run.team.goal, JSON.stringify(data), run.runId,
    ])
    const id = saved.rows[0]?.id
    if (!id) throw new TeamPlanError(409, 'plan locked', '这一轮提交过的计划已经被开工或取消，不能再改了')
    const view = await this.view((await this.load(id))!)
    run.record?.team({ op: 'plan', team: stateOf(view) })
    this.host.broadcast(run.pageId, { type: 'team_plan', plan: view })
    return { planId: id }
  }

  // ---------- 发起人改计划 / 取消 ----------

  private async requireUsable(user: UserRef, assignee: string): Promise<void> {
    let agent: ResolvedAgent | null
    try {
      agent = await this.host.resolve(assignee, user)
    } catch (err) {
      if (err instanceof ForbiddenError) throw new TeamPlanError(403, 'forbidden', err.message)
      throw err
    }
    if (!agent) throw new TeamPlanError(400, 'unknown agent', '这个 agent 当前不可用（不存在或它的机器不在线）')
  }

  /** 工作目录：绝对路径、≤1000、无 NUL，且那台机器上 listWorkspaceDirs 列得出来（落库的是执行端 realpath 之后的路径） */
  private async checkCwd(pageId: string, assignee: string, user: UserRef, cwd: string): Promise<string> {
    if (cwd.length > TEAM_LIMITS.cwd || cwd.includes('\0') || !ABSOLUTE_PATH.test(cwd)) {
      throw new TeamPlanError(400, 'invalid cwd', '工作目录必须是绝对路径')
    }
    try {
      return (await this.host.listDirs(pageId, assignee, cwd, user)).path
    } catch (err) {
      if (err instanceof ForbiddenError) throw new TeamPlanError(403, 'forbidden', err.message)
      throw new TeamPlanError(400, 'cwd not accessible', err instanceof Error ? err.message : String(err))
    }
  }

  /** 改草稿：计划标题、任务标题、负责人、工作目录（别的一概不能改）。换负责人时旧目录作废（路径属于另一台机器），要同时给新的 */
  async patch(pageId: string, planId: string, user: UserRef, body: unknown): Promise<TeamPlanView> {
    const row = await this.mine(pageId, planId, user)
    const input = (body && typeof body === 'object' ? body : {}) as { title?: unknown; tasks?: unknown }
    const plan: PlanData = structuredClone(row.plan)
    if (input.title !== undefined) {
      const title = typeof input.title === 'string' ? input.title.trim() : ''
      if (!title || title.length > TEAM_LIMITS.title) throw new TeamPlanError(400, 'invalid title', `计划标题要 1–${TEAM_LIMITS.title} 字`)
      plan.title = title
    }
    if (input.tasks !== undefined && !Array.isArray(input.tasks)) throw new TeamPlanError(400, 'invalid tasks', 'tasks 必须是数组')
    const labels = new Map((await this.host.catalog(user)).map((a) => [a.id, a.label]))
    for (const raw of (input.tasks as unknown[] | undefined) ?? []) {
      const p = (raw && typeof raw === 'object' ? raw : {}) as { id?: unknown; title?: unknown; assignee?: unknown; cwd?: unknown }
      const task = plan.tasks.find((t) => t.id === p.id)
      if (!task) throw new TeamPlanError(400, 'unknown task', `计划里没有任务 ${String(p.id)}`)
      if (p.title !== undefined) {
        const title = typeof p.title === 'string' ? p.title.trim() : ''
        if (!title || title.length > TEAM_LIMITS.title) throw new TeamPlanError(400, 'invalid title', `任务标题要 1–${TEAM_LIMITS.title} 字`)
        task.title = title
      }
      if (p.assignee !== undefined) {
        const assignee = typeof p.assignee === 'string' ? p.assignee.trim() : ''
        if (!assignee || assignee.length > TEAM_LIMITS.assignee) throw new TeamPlanError(400, 'invalid assignee', 'assignee 不合法')
        await this.requireUsable(user, assignee)
        if (assignee !== task.assignee) delete task.cwd
        task.assignee = assignee
        task.label = labels.get(assignee) ?? ''
      }
      if (p.cwd !== undefined) {
        if (p.cwd !== null && typeof p.cwd !== 'string') throw new TeamPlanError(400, 'invalid cwd', 'cwd 必须是字符串或 null')
        const cwd = typeof p.cwd === 'string' ? p.cwd.trim() : ''
        if (cwd) task.cwd = await this.checkCwd(pageId, task.assignee, user, cwd)
        else delete task.cwd
      }
    }
    const saved = await this.host.pool.query(UPDATE_DRAFT, [planId, JSON.stringify(plan)])
    if (!saved.rowCount) throw new TeamPlanError(409, 'plan not draft', '这份计划刚刚被开工或取消了，不能再改')
    return this.publish(row)
  }

  async cancel(pageId: string, planId: string, user: UserRef): Promise<TeamPlanView> {
    const row = await this.mine(pageId, planId, user)
    const done = await this.host.pool.query(CANCEL_DRAFT, [planId])
    if (!done.rowCount) throw new TeamPlanError(409, 'plan not draft', '这份计划刚刚被开工或取消了')
    return this.publish(row)
  }

  // ---------- 开工 ----------

  /** 开工预检（POST /continue 带 team，202 之前同步判，错误是干净的 4xx）：发起人本人、页面对得上、还是 draft、
   *  组长就是出这份计划的那个 agent、每个任务的负责人此刻发起人都能用。通过只是预检，真正的翻转在 begin，
   *  每个组员真正派发前还会再判一次（runSubAgent 里的 resolve） */
  async precheckStart(pageId: string, planId: string, user: UserRef, leaderId: string): Promise<void> {
    const row = await this.mine(pageId, planId, user)
    if (row.leader_agent !== leaderId) {
      throw new TeamPlanError(409, 'leader mismatch', '这份计划是另一个 agent 出的，组长要用同一个 agent，请先选回它再开工')
    }
    for (const t of row.plan.tasks) {
      let agent: ResolvedAgent | null
      try {
        agent = await this.host.resolve(t.assignee, user)
      } catch (err) {
        if (err instanceof ForbiddenError) throw new TeamPlanError(403, 'forbidden', `任务「${t.title}」：${err.message}`)
        throw err
      }
      if (!agent) throw new TeamPlanError(409, 'assignee unavailable', `任务「${t.title}」的负责人当前不可用，请先换人`)
    }
  }

  /** 执行轮开跑时的原子翻转 draft → running（manager.continue 里，page.run 占上之后）。并发的第二次开工或刚被取消的返回 409 */
  async begin(pageId: string, team: Extract<TeamRound, { kind: 'exec' }>, user: UserRef): Promise<void> {
    const started = await this.host.pool.query(START_PLAN, [team.planId, user.id, pageId])
    if (!started.rowCount) throw new TeamPlanError(409, 'plan not draft', '这份计划已经开工或被取消了')
    team.begun = true
    const row = await this.load(team.planId)
    if (row) await this.publish(row)
  }

  /** 一轮收尾（manager.continue 的 finally，每一轮都走）：撤销本轮的带队凭证；执行轮把计划行收口并广播。
   *  关停期间的远端回合（hold）不收口：它的占位块也没收，下次启动清扫成 error */
  async endRound(run: RunState): Promise<void> {
    revokeTeamGrants(run.runId)
    if (run.team?.kind !== 'exec' || !run.team.begun || run.hold) return
    const status = teamStatusOf(run)
    const result = run.record?.state.team ?? null
    await this.host.pool.query(FINISH_PLAN, [run.team.planId, status, result ? JSON.stringify({ ...result, status }) : null])
    const row = await this.load(run.team.planId)
    if (row) await this.publish(row)
  }
}

/** TeamPlanView 里只含团队状态的部分（进 RunRecord / 回复块 team 属性的就是它，不带谁发起、什么时候建的） */
function stateOf(view: TeamPlanView): TeamState {
  return { planId: view.planId, title: view.title, ...(view.goal ? { goal: view.goal } : {}), leader: view.leader, status: view.status, tasks: view.tasks }
}
