/* ---------- 带队的安全面（脚本化机器 + 非机器主人的发起人）----------
 * 发起人 bob 是空间成员，被机器主人 mowner 授权使用 box（agent 范围）；空间 owner sowner 与 carol 没有任何机器权限。
 * 不变量：
 *   - 只有计划的发起人能改计划 / 取消 / 开工，哪怕是机器主人、空间 owner、全局 admin（403）；
 *   - 负责人不可用（发起人没有那台机器的使用权）：计划卡上标 usable=false、不能换成它、不能带着它开工（403），机器上一帧都不发；
 *   - 非机器主人的使用照常留痕（组长一条、每个组员一条，via=team）；帧里的操作人始终是发起人；
 *   - 每个组员真正派发前都再判一次：开工时有权、轮到它时授权已被收回，这个任务出错并写明原因，机器上不发帧，其它任务照常；
 *   - 在飞的组员所在机器的授权被收回，该任务被取消（记出错，不是已停止），其它照常；组长所在机器被收回，整轮中止，组员全部取消。 */
import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import type { TeamPlanView } from '@ramet/shared/run-model'
import { pairMachine, type Machine } from './scripted-machine.js'
import {
  SSECollector,
  base,
  connectDoc,
  continuePage,
  grantMachine,
  insertUser,
  login,
  pool,
  postJson,
  settled,
  userMessage,
  waitFor,
} from './test-kit.js'

type Who = 'mowner' | 'sowner' | 'bob' | 'carol'

type World = {
  spaceId: string
  pageId: string
  id: Record<Who, string>
  cookie: Record<Who, string>
  a: Machine
  b: Machine
}

async function world(): Promise<World> {
  const id = {} as Record<Who, string>
  const cookie = {} as Record<Who, string>
  for (const who of ['mowner', 'sowner', 'bob', 'carol'] as const) {
    id[who] = await insertUser(who)
    cookie[who] = await login(who)
  }
  const space = (await (await postJson('/api/spaces', cookie.sowner, { name: 's' })).json()) as { id: string }
  for (const who of ['mowner', 'bob', 'carol'] as const) {
    await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [space.id, id[who], 'member'])
  }
  const page = (await (await postJson('/api/pages', cookie.sowner, { space_id: space.id })).json()) as { id: string }
  const a = await pairMachine(space.id, id.mowner, 'box')
  const b = await pairMachine(space.id, id.mowner, 'boxb')
  return { spaceId: space.id, pageId: page.id, id, cookie, a, b }
}

const call = (method: string, path: string, cookie: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const agentOn = (m: Machine, agent: 'claude' | 'fake'): string => `c:${m.id}:${agent}`

type PlanTaskInput = { id: string; assignee: string; dependsOn?: string[]; detail?: string }

/** 直接插一份草稿计划（计划轮由组长经 MCP 提交，那条路在 team.test.ts 里测过；这里要的是发起人是非机器主人的计划） */
async function insertPlan(w: World, who: Who, leader: string, tasks: PlanTaskInput[], id = randomUUID()): Promise<string> {
  const plan = {
    title: '计划',
    tasks: tasks.map((t) => ({ id: t.id, title: `任务${t.id}`, detail: t.detail ?? '', assignee: t.assignee, label: t.assignee, dependsOn: t.dependsOn ?? [] })),
  }
  await pool.query(`INSERT INTO team_plans (id, page_id, user_id, leader_agent, goal, plan) VALUES ($1, $2, $3, $4, '目标', $5::jsonb)`, [
    id, w.pageId, w.id[who], leader, JSON.stringify(plan),
  ])
  return id
}

const planRow = async (id: string) => (await pool.query('SELECT status, plan FROM team_plans WHERE id = $1', [id])).rows[0]
const view = async (w: World, planId: string, who: Who): Promise<TeamPlanView> => (await (await call('GET', `/api/pages/${w.pageId}/team/${planId}`, w.cookie[who])).json()) as TeamPlanView

/** who 在页面上写一条开工消息并带 team 发起执行轮；返回 continue 状态码 */
async function start(w: World, who: Who, planId: string, agent: string): Promise<number> {
  const doc = await connectDoc(w.pageId, w.cookie[who])
  userMessage(doc.document, '开工', { agent })
  const code = await continuePage(w.pageId, w.cookie[who], { agent, team: planId })
  doc.destroy()
  return code
}

const promptsTo = (m: Machine, who: string) => m.by(who).filter((f) => f.t === 'prompt')
const newsTo = (m: Machine, who: string) => m.by(who).filter((f) => f.t === 'new')

/** 让机器上一条被挂住的 prompt 正常结束 */
function release(m: Machine, held: Machine['held'][number]): void {
  m.send({ t: 'ev', rid: held.rid, runId: held.runId, seq: 0, ev: { type: 'text', delta: '好的', sessionId: held.sessionId } })
  m.send({ t: 'end', rid: held.rid, runId: held.runId, seq: 1, stopReason: 'end_turn' })
}

const usageOf = async (w: World, who: Who) =>
  (await pool.query(`SELECT action, detail FROM machine_usage_log WHERE user_id = $1 AND action = 'run' ORDER BY id`, [w.id[who]])).rows as Array<{ action: string; detail: Record<string, unknown> }>

// ---------- 发起人门槛 ----------

test('只有发起人能改 / 取消 / 开工：机器主人、空间 owner、别的成员都不行（机器主人有机器使用权也一样），计划原样', async () => {
  const w = await world()
  await grantMachine(w.a.id, w.id.bob)
  const planId = await insertPlan(w, 'bob', agentOn(w.a, 'claude'), [{ id: 't1', assignee: agentOn(w.a, 'fake') }])
  const url = `/api/pages/${w.pageId}/team/${planId}`

  for (const who of ['mowner', 'sowner', 'carol'] as const) {
    expect((await call('PATCH', url, w.cookie[who], { title: '被改了' })).status).toBe(403)
    expect((await call('POST', `${url}/cancel`, w.cookie[who])).status).toBe(403)
  }
  // 机器主人对 box 有完整使用权，但开工仍是 403（发起人判定在机器使用权之外）
  expect(await start(w, 'mowner', planId, agentOn(w.a, 'claude'))).toBe(403)
  expect(await start(w, 'carol', planId, agentOn(w.a, 'claude'))).toBe(403) // 没有机器权限：连组长都解析不出来
  expect(await planRow(planId)).toMatchObject({ status: 'draft', plan: { title: '计划' } })
  expect(w.a.driven()).toEqual([]) // 机器上没有收到任何驱动帧
  // 谁都能看（页面可读），mine 因人而异
  expect(await view(w, planId, 'mowner')).toMatchObject({ mine: false, initiator: 'bob' })
  expect(await view(w, planId, 'bob')).toMatchObject({ mine: true })
})

// ---------- 负责人可用性 ----------

test('负责人发起人用不了：计划卡标 usable=false、不能换成它、不能带着它开工（403，机器上一帧不发）', async () => {
  const w = await world()
  await grantMachine(w.a.id, w.id.bob) // bob 只有 box，没有 boxb
  const planId = await insertPlan(w, 'bob', agentOn(w.a, 'claude'), [
    { id: 't1', assignee: agentOn(w.a, 'fake') },
    { id: 't2', assignee: agentOn(w.b, 'fake') },
  ])

  // 视图按发起人现算 usable
  const v = await view(w, planId, 'bob')
  expect(v.tasks.map((t) => [t.id, t.usable])).toEqual([['t1', true], ['t2', false]])
  expect((await view(w, planId, 'sowner')).tasks.map((t) => t.usable)).toEqual([true, false]) // 别人看到的也是发起人能不能用

  // 换成不可用的负责人：403（带主人名），计划不变
  const url = `/api/pages/${w.pageId}/team/${planId}`
  const swap = await call('PATCH', url, w.cookie.bob, { tasks: [{ id: 't1', assignee: agentOn(w.b, 'claude') }] })
  expect(swap.status).toBe(403)
  expect(((await swap.json()) as { message: string }).message).toContain('mowner')
  expect((await planRow(planId)).plan.tasks[0].assignee).toBe(agentOn(w.a, 'fake'))

  // 开工：预检拒绝（403），计划仍是草稿，两台机器上都没有 bob 的任何帧
  expect(await start(w, 'bob', planId, agentOn(w.a, 'claude'))).toBe(403)
  expect((await planRow(planId)).status).toBe('draft')
  expect(w.a.by(w.id.bob)).toEqual([])
  expect(w.b.by(w.id.bob)).toEqual([])
  expect(await usageOf(w, 'bob')).toEqual([])

  // 授权给他之后就能换、能开工
  await grantMachine(w.b.id, w.id.bob)
  expect((await view(w, planId, 'bob')).tasks.map((t) => t.usable)).toEqual([true, true])
})

// ---------- 留痕 + 操作人 ----------

test('非机器主人带队：帧里的操作人始终是发起人；组长一条、每个组员一条留痕（via=team）；做完后计划 done', async () => {
  const w = await world()
  await grantMachine(w.a.id, w.id.bob)
  await grantMachine(w.b.id, w.id.bob)
  const planId = await insertPlan(w, 'bob', agentOn(w.a, 'claude'), [
    { id: 't1', assignee: agentOn(w.a, 'fake') },
    { id: 't2', assignee: agentOn(w.b, 'fake'), dependsOn: ['t1'] },
  ])
  const sse = new SSECollector()
  await sse.start(w.pageId, w.cookie.bob)
  expect(await start(w, 'bob', planId, agentOn(w.a, 'claude'))).toBe(202)
  await settled(sse, 1)

  expect((await planRow(planId)).status).toBe('done')
  expect((await view(w, planId, 'bob')).tasks.map((t) => t.status)).toEqual(['done', 'done'])
  // 驱动帧的操作人全是 bob：A 上 = 组员 t1 + 组长，B 上 = 组员 t2；主人 mowner 的名下一帧没有
  expect(promptsTo(w.a, w.id.bob)).toHaveLength(2)
  expect(promptsTo(w.b, w.id.bob)).toHaveLength(1)
  expect(newsTo(w.a, w.id.bob)).toHaveLength(2)
  expect(w.a.driven().every((f) => f.actor === w.id.bob)).toBe(true)
  expect(w.b.driven().every((f) => f.actor === w.id.bob)).toBe(true)
  // 留痕：组长（带 team = 计划 id）一条 + 两个组员（via=team）
  const used = await usageOf(w, 'bob')
  expect(used).toHaveLength(3)
  expect(used.filter((u) => u.detail.via === 'team')).toHaveLength(2)
  expect(used.filter((u) => u.detail.team === planId)).toHaveLength(1)
  sse.stop()
})

// ---------- 派发前再判 / 收回即断 ----------

test('派发前再判一次：开工时有权，轮到某个组员时它所在机器的授权已被收回 → 该任务出错并写明原因，那台机器上一帧不发，其它照常', async () => {
  const w = await world()
  await grantMachine(w.a.id, w.id.bob)
  const grantB = await grantMachine(w.b.id, w.id.bob)
  const planId = await insertPlan(w, 'bob', agentOn(w.a, 'claude'), [
    { id: 't1', assignee: agentOn(w.a, 'fake') },
    { id: 't2', assignee: agentOn(w.b, 'fake'), dependsOn: ['t1'] },
  ])
  const sse = new SSECollector()
  await sse.start(w.pageId, w.cookie.bob)
  w.a.hold = true
  expect(await start(w, 'bob', planId, agentOn(w.a, 'claude'))).toBe(202) // 预检时 bob 对 box、boxb 都有权
  await waitFor(() => w.a.held.length === 1) // t1 在 A 上跑着
  expect((await call('DELETE', `/api/machines/${w.b.id}/grants/${grantB}`, w.cookie.mowner)).status).toBeLessThan(300)

  w.a.hold = false
  release(w.a, w.a.held[0]!) // t1 做完 → 轮到 t2（B 上）
  await settled(sse, 1)

  const v = await view(w, planId, 'bob')
  expect(v.tasks.map((t) => t.status)).toEqual(['done', 'failed'])
  expect(v.tasks[1]!.error).toContain('需要他授权')
  expect(v.tasks[1]!.spans.length).toBe(1) // 开了一段又立刻收口，不是没记录
  expect(newsTo(w.b, w.id.bob)).toEqual([]) // B 上没有建会话
  expect(promptsTo(w.b, w.id.bob)).toEqual([])
  expect(promptsTo(w.a, w.id.bob)).toHaveLength(2) // 组员 t1 + 组长照常往下走
  expect(v.status).toBe('done')
  // 没派发过的组员不留痕（组长 + t1 两条）
  expect(await usageOf(w, 'bob')).toHaveLength(2)
  sse.stop()
})

test('在飞的组员所在机器的授权被收回：该任务当场取消并写明原因（出错，不是「已停止」），其它组员与组长照常', async () => {
  const w = await world()
  await grantMachine(w.a.id, w.id.bob)
  const grantB = await grantMachine(w.b.id, w.id.bob)
  const planId = await insertPlan(w, 'bob', agentOn(w.a, 'claude'), [
    { id: 't1', assignee: agentOn(w.b, 'fake') },
    { id: 't2', assignee: agentOn(w.a, 'fake') },
  ])
  const sse = new SSECollector()
  await sse.start(w.pageId, w.cookie.bob)
  w.b.hold = true
  expect(await start(w, 'bob', planId, agentOn(w.a, 'claude'))).toBe(202)
  await waitFor(() => w.b.held.length === 1)
  expect((await call('DELETE', `/api/machines/${w.b.id}/grants/${grantB}`, w.cookie.mowner)).status).toBeLessThan(300)
  await settled(sse, 1)

  const v = await view(w, planId, 'bob')
  expect(v.tasks.map((t) => [t.id, t.status])).toEqual([['t1', 'failed'], ['t2', 'done']])
  expect(v.tasks[0]!.error).toContain('授权')
  expect(w.b.frames.some((f) => f.t === 'cancel')).toBe(true) // 机器收到了取消
  expect(promptsTo(w.a, w.id.bob)).toHaveLength(2) // 组员 t2 + 组长
  expect(v.status).toBe('done')
  sse.stop()
})

test('组长所在机器的授权被收回：整轮中止（error），组员全部取消，组长的 prompt 一次都没发', async () => {
  const w = await world()
  const grantA = await grantMachine(w.a.id, w.id.bob)
  await grantMachine(w.b.id, w.id.bob)
  const planId = await insertPlan(w, 'bob', agentOn(w.a, 'claude'), [
    { id: 't1', assignee: agentOn(w.b, 'fake') },
    { id: 't2', assignee: agentOn(w.a, 'fake') },
  ])
  const sse = new SSECollector()
  await sse.start(w.pageId, w.cookie.bob)
  w.a.hold = true
  w.b.hold = true
  expect(await start(w, 'bob', planId, agentOn(w.a, 'claude'))).toBe(202)
  await waitFor(() => w.a.held.length === 1 && w.b.held.length === 1)
  expect((await call('DELETE', `/api/machines/${w.a.id}/grants/${grantA}`, w.cookie.mowner)).status).toBeLessThan(300)
  await settled(sse, 1)

  const v = await view(w, planId, 'bob')
  expect(v.status).toBe('error')
  expect(v.tasks.every((t) => t.status === 'cancelled' || t.status === 'failed')).toBe(true)
  expect(w.b.frames.some((f) => f.t === 'cancel')).toBe(true) // 别的机器上还在跑的组员也停了
  expect(promptsTo(w.a, w.id.bob)).toHaveLength(1) // 只有组员 t2 的；组长没有被叫起来
  sse.stop()
})
