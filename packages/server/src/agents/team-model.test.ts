/* ---------- 带队的纯逻辑（不起服务、不碰库）----------
 * 一、team 原语的 reducer（@ramet/shared/run-model）：幂等（快照 + 之后的事件 = 终态，重放同一条不变）、时段 / 等待的开合、
 *    持久化边界的归一（normalizeTeam / encodeTeam / decodeTeam）、RunRecord.team 发的成品事件与归档形状；
 * 二、计划校验（validatePlan）：组长交来的东西一律不信，任务数 / id / 标题 / 说明有上限、依赖只能指向已有任务且无环、cwd 不收；
 * 三、`/带队` 的识别（planGoalOf）。 */
import { expect, test } from 'vitest'
import {
  applyRunEvent,
  decodeTeam,
  emptyRun,
  encodeTeam,
  normalizeTeam,
  TEAM_LIMITS,
  teamProgress,
  type RunEvent,
  type TeamState,
} from '@ramet/shared/run-model'
import { RunRecord } from './run-record.js'
import { planGoalOf } from './team.js'
import { TeamPlanError, validatePlan } from './team-plan.js'

const team = (): TeamState => ({
  planId: 'p1',
  title: '做个站',
  goal: '做个站',
  leader: 'claude',
  status: 'running',
  tasks: [
    { id: 't1', title: '后端', assignee: 'a', dependsOn: [], status: 'pending', spans: [] },
    { id: 't2', title: '前端', assignee: 'b', dependsOn: ['t1'], status: 'pending', spans: [] },
  ],
})

function replay(events: RunEvent[]) {
  const state = emptyRun()
  for (const ev of events) applyRunEvent(state, ev)
  return state
}

const plan = (): RunEvent => ({ type: 'team', op: 'plan', team: team(), t: 0 })

test('team 原语：计划整份替换；任务状态 / 时段 / 等待按绝对值归约，open / close 对已开 / 已关是空操作（幂等）', () => {
  const events: RunEvent[] = [
    plan(),
    { type: 'team', op: 'task', id: 't1', patch: { status: 'running', backs: 0 }, span: 'open', t: 10 },
    { type: 'team', op: 'task', id: 't1', span: 'open', t: 11 }, // 已开：空操作
    { type: 'team', op: 'task', id: 't1', wait: 'open', t: 20 },
    { type: 'team', op: 'task', id: 't1', wait: 'open', t: 21 }, // 已在等：空操作
    { type: 'team', op: 'task', id: 't1', wait: 'close', t: 30 },
    { type: 'team', op: 'task', id: 't1', wait: 'close', t: 31 }, // 没在等：空操作
    { type: 'team', op: 'task', id: 't1', patch: { status: 'done', output: '好了', steps: 3 }, span: 'close', t: 40 },
    { type: 'team', op: 'task', id: 't1', span: 'close', t: 41 }, // 已关：空操作
    { type: 'team', op: 'task', id: 'nope', patch: { status: 'done' }, t: 42 }, // 没有这个任务：丢
  ]
  const t1 = replay(events).team!.tasks[0]!
  expect(t1).toMatchObject({ status: 'done', output: '好了', steps: 3, backs: 0 })
  expect(t1.spans).toEqual([{ t: 10, end: 40, waits: [{ t: 20, end: 30 }] }])
  // 每条事件重复送达一次（快照里已经有、事件又来了一遍）：结果不变
  const twice = emptyRun()
  for (const ev of events.flatMap((e) => [e, e])) applyRunEvent(twice, ev)
  expect(twice.team!.tasks[0]).toEqual(t1)
})

test('team 原语：打回重做多一段 span；这一段结束时还在等人批准的，等待一并收口；没开 span 时等待不记', () => {
  const state = replay([
    plan(),
    { type: 'team', op: 'task', id: 't1', wait: 'open', t: 5 }, // 没有开着的 span：不记
    { type: 'team', op: 'task', id: 't1', span: 'open', t: 10 },
    { type: 'team', op: 'task', id: 't1', patch: { status: 'done' }, span: 'close', t: 20 },
    { type: 'team', op: 'task', id: 't1', patch: { status: 'running', backs: 1 }, span: 'open', t: 30 },
    { type: 'team', op: 'task', id: 't1', wait: 'open', t: 35 },
    { type: 'team', op: 'task', id: 't1', patch: { status: 'cancelled' }, span: 'close', t: 50 },
  ])
  const t1 = state.team!.tasks[0]!
  expect(t1.backs).toBe(1)
  expect(t1.spans).toEqual([{ t: 10, end: 20 }, { t: 30, end: 50, waits: [{ t: 35, end: 50 }] }])
})

test('team 原语：整体状态；没有 plan 之前的 status / task 事件丢掉；结果摘要与失败原因按上限收口；reducer 不与事件对象共享引用', () => {
  const s0 = replay([{ type: 'team', op: 'status', status: 'done', t: 1 }, { type: 'team', op: 'task', id: 't1', patch: { status: 'done' }, t: 2 }])
  expect(s0.team).toBeUndefined()
  const ev = plan()
  const state = replay([
    ev,
    { type: 'team', op: 'task', id: 't1', patch: { output: 'x'.repeat(TEAM_LIMITS.output + 50), error: 'e'.repeat(TEAM_LIMITS.error + 50) }, t: 3 },
    { type: 'team', op: 'status', status: 'done', t: 4 },
  ])
  expect(state.team!.status).toBe('done')
  expect(state.team!.tasks[0]!.output).toHaveLength(TEAM_LIMITS.output)
  expect(state.team!.tasks[0]!.error).toHaveLength(TEAM_LIMITS.error)
  expect((ev as { team: TeamState }).team.status).toBe('running') // 事件里的那份没被改
  expect(teamProgress(state.team!)).toEqual({ done: 0, total: 2 })
})

test('RunRecord.team：发成品事件（带相对时间），快照 + 之后的事件 = 终态；归档形状带 team，hasTeam 触发归档', () => {
  const events: RunEvent[] = []
  const rec = new RunRecord('r1', Date.now(), (ev) => events.push(ev))
  expect(rec.hasTeam()).toBe(false)
  rec.team({ op: 'plan', team: team() })
  const snapshot = structuredClone(rec.state)
  rec.team({ op: 'task', id: 't1', patch: { status: 'running' }, span: 'open' })
  rec.team({ op: 'task', id: 't1', patch: { status: 'done', output: 'ok' }, span: 'close' })
  rec.team({ op: 'status', status: 'done' })
  expect(events.map((e) => e.type)).toEqual(['team', 'team', 'team', 'team'])
  expect(events.every((e) => e.type === 'team' && typeof e.t === 'number')).toBe(true)
  // 中途订阅：快照（plan 之后）+ 之后的事件 = 服务端终态
  for (const ev of events.slice(1)) applyRunEvent(snapshot, ev)
  expect(snapshot.team).toEqual(rec.state.team)
  expect(rec.hasTeam()).toBe(true)
  const record = rec.record({ agent: 'claude', parentId: 'page' }, 'end', 10, undefined)
  expect(record.team?.status).toBe('done')
  expect(record.team?.tasks[0]?.status).toBe('done')
})

test('encodeTeam / decodeTeam / normalizeTeam：往返不变；坏数据收口或判无效，不抛', () => {
  const t = team()
  t.tasks[0]!.spans = [{ t: 1, end: 5, waits: [{ t: 2, end: 3 }] }]
  expect(decodeTeam(encodeTeam(t))).toEqual(t)
  expect(encodeTeam(undefined)).toBe('')
  expect(decodeTeam('')).toBeNull()
  expect(decodeTeam('不是 json')).toBeNull()
  expect(decodeTeam(JSON.stringify({ title: '缺 planId' }))).toBeNull()
  expect(decodeTeam(null)).toBeNull()
  const dirty = normalizeTeam({
    planId: 'p',
    title: 't',
    leader: 'l',
    status: '乱写',
    tasks: [
      { id: 'a', title: 1, assignee: 2, dependsOn: ['x', 3], status: 'bad', spans: [{ t: -1 }, { t: 5, waits: [{ t: 'x' }] }] },
      { title: '没有 id' },
      ...Array.from({ length: 20 }, (_, i) => ({ id: `n${i}` })),
    ],
  })!
  expect(dirty.status).toBe('error')
  expect(dirty.tasks).toHaveLength(TEAM_LIMITS.tasks - 1) // 先截到上限再丢掉没有 id 的那条
  expect(dirty.tasks[0]).toMatchObject({ id: 'a', title: '', assignee: '', dependsOn: ['x'], status: 'pending', spans: [{ t: 5 }] })
})

// ---------- validatePlan ----------

const task = (extra: Record<string, unknown> = {}) => ({ id: 't1', title: '标题', detail: '说明', assignee: 'a', ...extra })
const rejects = (raw: unknown, message: string): void => {
  try {
    validatePlan(raw)
  } catch (err) {
    expect(err).toBeInstanceOf(TeamPlanError)
    expect((err as TeamPlanError).status).toBe(400)
    expect((err as Error).message).toContain(message)
    return
  }
  throw new Error(`应当拒绝：${message}`)
}

test('validatePlan：合格的计划被归一（去空白、依赖去重、detail 缺省空串）；组长给的 cwd 一概不收', () => {
  const ok = validatePlan({
    title: '  计划  ',
    tasks: [task({ cwd: '/etc', extra: 1 }), task({ id: 't2', title: ' 二 ', detail: undefined, dependsOn: ['t1', 't1'] })],
  })
  expect(ok).toEqual({
    title: '计划',
    tasks: [
      { id: 't1', title: '标题', detail: '说明', assignee: 'a', dependsOn: [] },
      { id: 't2', title: '二', detail: '', assignee: 'a', dependsOn: ['t1'] },
    ],
  })
  expect(JSON.stringify(ok)).not.toContain('/etc')
})

test('validatePlan：形状 / 数量 / 长度 / id / 依赖 / 环都拒绝，message 写给组长看', () => {
  rejects(null, '必须是一个对象')
  rejects({ tasks: [task()] }, '缺少计划标题')
  rejects({ title: 'x'.repeat(TEAM_LIMITS.title + 1), tasks: [task()] }, '计划标题不能超过')
  rejects({ title: 'p', tasks: [] }, '至少包含一个任务')
  rejects({ title: 'p', tasks: 'x' }, '至少包含一个任务')
  rejects({ title: 'p', tasks: Array.from({ length: TEAM_LIMITS.tasks + 1 }, (_, i) => task({ id: `t${i}` })) }, '任务最多')
  rejects({ title: 'p', tasks: [task({ id: 'bad id!' })] }, '不合法')
  rejects({ title: 'p', tasks: [task({ id: 'x'.repeat(33) })] }, '不合法')
  rejects({ title: 'p', tasks: [task(), task()] }, '重复')
  rejects({ title: 'p', tasks: [task({ title: '' })] }, '缺少标题')
  rejects({ title: 'p', tasks: [task({ title: 'x'.repeat(TEAM_LIMITS.title + 1) })] }, '标题不能超过')
  rejects({ title: 'p', tasks: [task({ detail: 'x'.repeat(TEAM_LIMITS.detail + 1) })] }, '说明不能超过')
  rejects({ title: 'p', tasks: [task({ detail: 5 })] }, 'detail 必须是字符串')
  rejects({ title: 'p', tasks: [task({ assignee: '' })] }, '缺少负责人')
  rejects({ title: 'p', tasks: [task({ assignee: 7 })] }, '缺少负责人')
  rejects({ title: 'p', tasks: [task({ assignee: 'x'.repeat(TEAM_LIMITS.assignee + 1) })] }, 'assignee 太长')
  rejects({ title: 'p', tasks: [task({ dependsOn: 't2' })] }, 'dependsOn 必须是')
  rejects({ title: 'p', tasks: [task({ dependsOn: ['t1'] })] }, '不能依赖自己')
  rejects({ title: 'p', tasks: [task({ dependsOn: ['ghost'] })] }, '不在计划里')
  rejects({ title: 'p', tasks: [task({ dependsOn: ['t2'] }), task({ id: 't2', dependsOn: ['t1'] })] }, '成环')
  rejects({ title: 'p', tasks: [task(), task({ id: 't2', dependsOn: ['t3'] }), task({ id: 't3', dependsOn: ['t2'] })] }, '成环')
  // 恰好 8 个、无环的菱形依赖是合法的
  expect(
    validatePlan({
      title: 'p',
      tasks: [task(), task({ id: 'b', dependsOn: ['t1'] }), task({ id: 'c', dependsOn: ['t1'] }), task({ id: 'd', dependsOn: ['b', 'c'] })],
    }).tasks,
  ).toHaveLength(4)
})

test('planGoalOf：只认以 /带队 开头（后面是空白或结尾）的用户消息，返回目标；其它一律 null', () => {
  expect(planGoalOf('/带队 做个网站')).toBe('做个网站')
  expect(planGoalOf('  /带队\n分几步做\n完')).toBe('分几步做\n完')
  expect(planGoalOf('/带队')).toBe('')
  expect(planGoalOf('/带队做个网站')).toBeNull() // 没有空白：不是命令
  expect(planGoalOf('请 /带队 做个网站')).toBeNull()
  expect(planGoalOf('/记住 一条')).toBeNull()
  expect(planGoalOf(null)).toBeNull()
  expect(planGoalOf(`/带队 ${'x'.repeat(TEAM_LIMITS.goal + 100)}`)).toHaveLength(TEAM_LIMITS.goal)
})
