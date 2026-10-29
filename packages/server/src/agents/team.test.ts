/* ---------- 带队（/带队）全栈：本机假 agent（fake / claude，主人 = 全局 admin alice）+ 真 MCP ----------
 * 假 agent 会按 session/new 收到的 mcpServers 拉起 Ramet 的 MCP 进程，真调中心的 submit_plan / send_back（fake-agent.mjs 文件头有触发词清单）。
 *
 * 一、计划轮：`/带队 目标` → 组长 submit_plan → team_plans 草稿 + 本轮 team 原语 + 回复块 team 属性 + 页面 SSE team_plan；
 *    组长给的 cwd 被忽略、校验不过的计划回告组长；带队不写会话记录（hash 口径）；submit_plan / send_back 只在对应阶段的组长凭证里
 * 二、改计划 / 取消 / 开工的门槛：只有发起人；viewer / 非成员 404；非草稿 409；负责人 / 工作目录校验
 * 三、执行轮：依赖排队 + 并行上限、出错后下游跳过、停止取消全部组员、send_back 与次数上限、组员等审批的时段、工作目录、hash 口径
 * 四、收件箱：我发起的草稿计划（只给页面可写的发起人）
 * 机器所有权 / 授权收回类的安全用例在 team-safety.test.ts（脚本化机器）。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { decodeTeam, type TeamPlanView, type TeamState, type TeamTask } from '@ramet/shared/run-model'
import type { InboxItem } from '../inbox.js'
import { mintPageToken } from '../page-read.js'
import {
  SSECollector,
  agentSession,
  answerPermission,
  base,
  connectDoc,
  continuePage,
  insertUser,
  joinPageSpace,
  login,
  pool,
  postJson,
  replyAttr,
  replyBlocks,
  settled,
  setupPage,
  userMessage,
  userIdOf,
  waitFor,
  waitPermission,
} from './test-kit.js'

const dir = mkdtempSync(join(tmpdir(), 'ramet-team-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let seq = 0
const planFile = (plan: unknown): string => {
  const file = join(dir, `plan-${++seq}.json`)
  writeFileSync(file, JSON.stringify(plan))
  return file
}
const task = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `任务${id}`, detail: '', assignee: 'fake', ...extra })

type W = { cookie: string; pageId: string; sse: SSECollector; doc: HocuspocusProvider; rounds: number }

async function startWorld(): Promise<W> {
  const { cookie, pageId } = await setupPage()
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  const doc = await connectDoc(pageId, cookie)
  return { cookie, pageId, sse, doc, rounds: 0 }
}

const stop = (w: W): void => {
  w.sse.stop()
  w.doc.destroy()
}

/** 发 `/带队 <目标>`（组长 = agent）并等这一轮收尾；返回这一页最新的计划 id（没有就是 null） */
async function planRound(w: W, plan: unknown, opts: { goal?: string; agent?: string; extra?: string } = {}): Promise<string | null> {
  const agent = opts.agent ?? 'fake'
  userMessage(w.doc.document, `/带队 ${opts.goal ?? '做个站'} PLANFILE=${planFile(plan)} ${opts.extra ?? ''}`, { agent })
  expect(await continuePage(w.pageId, w.cookie, { agent })).toBe(202)
  await settled(w.sse, ++w.rounds)
  await replyDone(w)
  return latestPlan(w.pageId)
}

/** 第 rounds 条回复已经收尾（客户端文档同步到了；按条数等，免得读到上一条的旧文字） */
const replyDone = (w: W): Promise<void> => waitFor(() => replyBlocks(w.doc).length >= w.rounds && replyBlocks(w.doc).at(-1)?.outcome !== 'run')

async function latestPlan(pageId: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM team_plans WHERE page_id = $1 ORDER BY created_at DESC, id LIMIT 1', [pageId])
  return rows[0]?.id ?? null
}

/** 写一条开工消息并带 team 发起执行轮；返回 continue 的状态码（202 时调用方自己 settled） */
async function startExec(w: W, planId: string, agent = 'fake', cookie = w.cookie): Promise<number> {
  userMessage(w.doc.document, '开工：计划', { agent })
  return continuePage(w.pageId, cookie, { agent, team: planId })
}

async function execRound(w: W, planId: string, agent = 'fake'): Promise<void> {
  expect(await startExec(w, planId, agent)).toBe(202)
  await settled(w.sse, ++w.rounds)
  await replyDone(w)
}

const api = (method: string, path: string, cookie: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const planView = async (w: W, planId: string, cookie = w.cookie): Promise<TeamPlanView> => (await (await api('GET', `/api/pages/${w.pageId}/team/${planId}`, cookie)).json()) as TeamPlanView

const taskOf = (team: TeamState, id: string): TeamTask => team.tasks.find((x) => x.id === id)!
const lastReplyText = (w: W): string => replyBlocks(w.doc).at(-1)!.text
const rows = async (planId: string) => (await pool.query('SELECT status, plan, goal, leader_agent, user_id FROM team_plans WHERE id = $1', [planId])).rows[0]

// ---------- 一、计划轮 ----------

test('计划轮：组长 submit_plan → 草稿落库（负责人标 usable，组长给的 cwd 被忽略）、本轮 team 原语、回复块 team 属性、页面 SSE team_plan；不写会话记录', async () => {
  const w = await startWorld()
  const planId = await planRound(w, {
    title: '做个站',
    tasks: [task('t1', { detail: '写后端', cwd: '/etc' }), task('t2', { assignee: 'claude', dependsOn: ['t1'] })],
  })
  expect(planId).not.toBeNull()
  expect(lastReplyText(w)).toContain('plan-submitted')

  const row = await rows(planId!)
  expect(row).toMatchObject({ status: 'draft', goal: expect.stringContaining('做个站'), leader_agent: 'fake' })
  expect(row.plan.tasks.map((t: { id: string; label: string }) => [t.id, t.label])).toEqual([['t1', 'Fake'], ['t2', 'Claude']])
  expect(JSON.stringify(row.plan)).not.toContain('/etc') // 组长给的 cwd 一概不收

  // 本轮 RunRecord：先 plan 原语（草稿），实时推给前端；回复块 team 属性是同一份
  const ev = w.sse.events.find((e) => e.type === 'team')
  expect(ev).toMatchObject({ type: 'team', op: 'plan', team: { planId, status: 'draft', leader: 'fake' } })
  const attr = decodeTeam(replyAttr(w.doc, 'team'))
  expect(attr).toMatchObject({ planId, status: 'draft', title: '做个站' })
  expect(attr!.tasks.map((t) => [t.id, t.status, t.usable])).toEqual([['t1', 'pending', true], ['t2', 'pending', true]])
  // 页面 SSE：整份计划视图（带谁发起的，不带因人而异的 mine）
  const broadcast = w.sse.events.find((e) => e.type === 'team_plan')
  expect(broadcast).toMatchObject({ type: 'team_plan', plan: { planId, status: 'draft', pageId: w.pageId, initiator: 'alice' } })
  expect(JSON.stringify(broadcast)).not.toContain('"mine"')
  // 过程页归档了（只出了计划的一轮也有过程可看）
  expect(replyAttr(w.doc, 'run')).toBeTruthy()
  // 带队不写会话记录：agent_session 里没有 fake 的会话
  expect((await agentSession(w.pageId))?.fake).toBeUndefined()
  stop(w)
})

test('GET 计划：页面可读的人都能看（草稿带 usable，mine = 我是不是发起人）；不是这一页的计划 / 非成员 404', async () => {
  const w = await startWorld()
  const planId = (await planRound(w, { title: 'p', tasks: [task('t1')] }))!
  const bob = await joinPageSpace(w.pageId, 'bob', { role: 'member' })
  const carol = await joinPageSpace(w.pageId, 'carol', { role: 'viewer' })
  const dave = await joinPageSpace((await setupOther()).pageId, 'dave', { role: 'member' }) // 别的空间的人

  const mine = await planView(w, planId)
  expect(mine).toMatchObject({ planId, status: 'draft', mine: true, initiator: 'alice', tasks: [{ id: 't1', usable: true, status: 'pending', spans: [] }] })
  expect(await planView(w, planId, bob)).toMatchObject({ mine: false, initiator: 'alice' })
  expect(await planView(w, planId, carol)).toMatchObject({ mine: false })
  expect((await api('GET', `/api/pages/${w.pageId}/team/${planId}`, dave)).status).toBe(404)
  expect((await api('GET', `/api/pages/${w.pageId}/team/nope`, w.cookie)).status).toBe(404)
  // 计划必须属于这一页：别的页面用同一个计划 id 取不到
  const { pageId: other } = await setupOther()
  expect((await api('GET', `/api/pages/${other}/team/${planId}`, w.cookie)).status).toBe(404)
  stop(w)
})

/** 另一个空间里的页面（另起一个用户，不与 setupPage 的 alice 撞名） */
let otherSeq = 0
async function setupOther(): Promise<{ pageId: string }> {
  const name = `other${++otherSeq}`
  await insertUser(name)
  const cookie = await login(name)
  const space = (await (await postJson('/api/spaces', cookie, { name: 'o' })).json()) as { id: string }
  const page = (await (await postJson('/api/pages', cookie, { space_id: space.id })).json()) as { id: string }
  return { pageId: page.id }
}

test('校验不过的计划回告组长（不落库）；同一轮重复提交覆盖上一份', async () => {
  const w = await startWorld()
  expect(await planRound(w, { title: 'p', tasks: Array.from({ length: 9 }, (_, i) => task(`t${i}`)) })).toBeNull()
  expect(lastReplyText(w)).toContain('plan-error:')
  expect(lastReplyText(w)).toContain('任务最多 8 个')

  expect(await planRound(w, { title: 'p', tasks: [task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })] })).toBeNull()
  expect(lastReplyText(w)).toContain('成环')

  // 同一轮里先交一份再交第二份：覆盖，只有一行
  userMessage(w.doc.document, `/带队 覆盖 PLANFILE=${planFile({ title: '第一版', tasks: [task('t1')] })} PLANFILE2=${planFile({ title: '第二版', tasks: [task('t1'), task('t2')] })}`, { agent: 'fake' })
  expect(await continuePage(w.pageId, w.cookie, { agent: 'fake' })).toBe(202)
  await settled(w.sse, ++w.rounds)
  const { rows: all } = await pool.query('SELECT plan FROM team_plans WHERE page_id = $1', [w.pageId])
  expect(all).toHaveLength(1)
  expect(all[0].plan.title).toBe('第二版')
  expect(all[0].plan.tasks).toHaveLength(2)
  stop(w)
})

test('工具只在对应阶段的组长凭证里：普通对话没有 submit_plan / send_back；计划轮有 submit_plan 没有 run_agent；组员什么带队工具都没有', async () => {
  const w = await startWorld()
  userMessage(w.doc.document, '报工具', { agent: 'fake' })
  expect(await continuePage(w.pageId, w.cookie, { agent: 'fake' })).toBe(202)
  await settled(w.sse, ++w.rounds)
  await replyDone(w)
  const normal = lastReplyText(w)
  expect(normal).toContain('tools:')
  expect(normal).toContain('run_agent')
  expect(normal).not.toContain('submit_plan')
  expect(normal).not.toContain('send_back')

  const planId = (await planRound(w, { title: 'p', tasks: [task('t1', { detail: '工作:报工具' })] }, { extra: '报工具' }))!
  const planTools = lastReplyText(w)
  expect(planTools).toContain('submit_plan')
  expect(planTools).not.toContain('send_back')
  expect(planTools).not.toContain('run_agent') // 带队的组长不能再叫别人，调度归中心

  await execRound(w, planId)
  const team = await planView(w, planId)
  const out = taskOf(team, 't1').output!
  expect(out).toContain('tools:')
  for (const banned of ['run_agent', 'submit_plan', 'send_back']) expect(out).not.toContain(banned)
  expect(out).toContain('read_page') // 其余工具照常有
  stop(w)
})

test('hash 口径：带队的两种轮都不改写会话记录；带队之后的下一轮普通对话全文重放一次，之后恢复原生续聊；没有带队时路径不变', async () => {
  const w = await startWorld()
  // 先来一轮普通对话：建会话、落记录
  userMessage(w.doc.document, '你好', { agent: 'fake' })
  expect(await continuePage(w.pageId, w.cookie, { agent: 'fake' })).toBe(202)
  await settled(w.sse, ++w.rounds)
  await replyDone(w)
  expect(lastReplyText(w)).toContain('turn:full')
  const before = (await agentSession(w.pageId))!.fake!

  // 计划轮 + 执行轮之后，记录原样（sessionId 与 hash 都没被带队改写）
  const planId = (await planRound(w, { title: 'p', tasks: [task('t1')] }))!
  expect((await agentSession(w.pageId))!.fake).toEqual(before)
  await execRound(w, planId)
  expect((await agentSession(w.pageId))!.fake).toEqual(before)

  // 文档变长了：下一轮普通对话的基线 hash 对不上旧记录，新建会话全文重放（turn:full），并写回新记录
  userMessage(w.doc.document, '带队之后再问', { agent: 'fake' })
  expect(await continuePage(w.pageId, w.cookie, { agent: 'fake' })).toBe(202)
  await settled(w.sse, ++w.rounds)
  await replyDone(w)
  expect(lastReplyText(w)).toContain('turn:full')
  const after = (await agentSession(w.pageId))!.fake!
  expect(after.sessionId).not.toBe(before.sessionId)
  // 再下一轮：原生续聊恢复（同一个会话，只发新消息）
  userMessage(w.doc.document, '接着问', { agent: 'fake' })
  expect(await continuePage(w.pageId, w.cookie, { agent: 'fake' })).toBe(202)
  await settled(w.sse, ++w.rounds)
  await replyDone(w)
  expect(lastReplyText(w)).toContain('turn:delta')
  expect((await agentSession(w.pageId))!.fake!.sessionId).toBe(after.sessionId)
  stop(w)
})

// ---------- 二、改计划 / 取消 / 开工的门槛 ----------

test('改计划：只有发起人（还要页面可写）；标题 / 负责人 / 工作目录的校验；换负责人时旧目录作废', async () => {
  const w = await startWorld()
  const planId = (await planRound(w, { title: '原标题', tasks: [task('t1'), task('t2', { dependsOn: ['t1'] })] }))!
  const bob = await joinPageSpace(w.pageId, 'bob', { role: 'member' }) // 页面可写，但不是发起人
  const carol = await joinPageSpace(w.pageId, 'carol', { role: 'viewer' })
  const dave = await joinPageSpace((await setupOther()).pageId, 'dave', { role: 'member' })
  const url = `/api/pages/${w.pageId}/team/${planId}`

  // 门槛：非发起人 403（不论角色）；viewer / 非成员 404；都没改动
  expect((await api('PATCH', url, bob, { title: 'x' })).status).toBe(403)
  expect((await api('PATCH', url, carol, { title: 'x' })).status).toBe(404)
  expect((await api('PATCH', url, dave, { title: 'x' })).status).toBe(404)
  expect((await api('POST', `${url}/cancel`, bob)).status).toBe(403)
  expect((await api('POST', `${url}/cancel`, carol)).status).toBe(404)
  expect((await rows(planId)).plan.title).toBe('原标题')

  // 发起人：改计划标题 / 任务标题 / 负责人 / 目录
  const ok = await api('PATCH', url, w.cookie, { title: '新标题', tasks: [{ id: 't1', title: '后端', assignee: 'claude', cwd: '/tmp' }, { id: 't2', cwd: '/tmp' }] })
  expect(ok.status).toBe(200)
  const view = (await ok.json()) as TeamPlanView
  expect(view).toMatchObject({ title: '新标题', status: 'draft' })
  expect(view.tasks.map((t) => [t.id, t.title, t.assignee, t.label, t.cwd])).toEqual([['t1', '后端', 'claude', 'Claude', '/tmp'], ['t2', '任务t2', 'fake', 'Fake', '/tmp']])
  await waitFor(() => w.sse.events.filter((e) => e.type === 'team_plan').length >= 2) // 改动广播了
  // 换负责人时旧目录作废（路径属于另一台机器）
  const swapped = (await (await api('PATCH', url, w.cookie, { tasks: [{ id: 't2', assignee: 'claude' }] })).json()) as TeamPlanView
  expect(swapped.tasks[1]).toMatchObject({ assignee: 'claude' })
  expect(swapped.tasks[1]!.cwd).toBeUndefined()

  // 校验：不存在的任务 / 不可用的负责人 / 非法标题 / 非法目录
  const bad = async (body: unknown): Promise<number> => (await api('PATCH', url, w.cookie, body)).status
  expect(await bad({ tasks: [{ id: 'nope', title: 'x' }] })).toBe(400)
  expect(await bad({ tasks: [{ id: 't1', assignee: 'ghost' }] })).toBe(400)
  expect(await bad({ tasks: [{ id: 't1', title: '' }] })).toBe(400)
  expect(await bad({ title: 'x'.repeat(101) })).toBe(400)
  expect(await bad({ tasks: [{ id: 't1', cwd: 'relative/path' }] })).toBe(400)
  expect(await bad({ tasks: [{ id: 't1', cwd: '/no/such/dir/anywhere' }] })).toBe(400)
  expect(await bad({ tasks: [{ id: 't1', cwd: `/tmp/${'x'.repeat(1100)}` }] })).toBe(400)
  expect(await bad({ tasks: [{ id: 't1', cwd: '/tmp\0/x' }] })).toBe(400)
  expect(await bad({ tasks: 'x' })).toBe(400)
  expect((await rows(planId)).plan.title).toBe('新标题')
  // 清除目录
  const cleared = (await (await api('PATCH', url, w.cookie, { tasks: [{ id: 't1', cwd: null }] })).json()) as TeamPlanView
  expect(cleared.tasks[0]!.cwd).toBeUndefined()
  stop(w)
})

test('取消：发起人取消草稿 → cancelled，之后不能改、不能开工；收件箱里的待批计划消失；开工的 team 参数不合法 400', async () => {
  const w = await startWorld()
  const planId = (await planRound(w, { title: 'p', tasks: [task('t1')] }))!
  const items = async (): Promise<InboxItem[]> => ((await (await api('GET', '/api/inbox', w.cookie)).json()) as { items: InboxItem[] }).items
  expect((await items()).filter((i) => i.type === 'plan')).toMatchObject([{ key: `plan:${planId}`, planId, pageId: w.pageId, title: 'p' }])

  const cancelled = await api('POST', `/api/pages/${w.pageId}/team/${planId}/cancel`, w.cookie)
  expect(cancelled.status).toBe(200)
  expect(await cancelled.json()).toMatchObject({ status: 'cancelled' })
  expect((await rows(planId)).status).toBe('cancelled')
  expect((await api('PATCH', `/api/pages/${w.pageId}/team/${planId}`, w.cookie, { title: 'x' })).status).toBe(409)
  expect((await api('POST', `/api/pages/${w.pageId}/team/${planId}/cancel`, w.cookie)).status).toBe(409)
  expect(await startExec(w, planId)).toBe(409)
  expect(await startExec(w, 'not-a-plan')).toBe(404)
  expect(await continuePage(w.pageId, w.cookie, { agent: 'fake', team: 5 })).toBe(400)
  expect((await items()).filter((i) => i.type === 'plan')).toEqual([])
  stop(w)
})

test('开工预检：组长必须是出计划的那个 agent；非发起人不能开工', async () => {
  const w = await startWorld()
  const planId = (await planRound(w, { title: 'p', tasks: [task('t1')] }))!
  const bob = await joinPageSpace(w.pageId, 'bob', { role: 'member' })
  expect(await startExec(w, planId, 'claude')).toBe(409) // 计划是 fake 出的
  expect(await startExec(w, planId, 'fake', bob)).toBe(403) // bob 不是发起人（也没法用本机 agent）
  expect((await rows(planId)).status).toBe('draft')
  stop(w)
})

// ---------- 四、收件箱 ----------

test('收件箱 plan：只给发起人，且页面必须仍对他可写（降为只读 / 移出空间 / 页面进回收站都不给）', async () => {
  const w = await startWorld()
  const bob = await joinPageSpace(w.pageId, 'bob', { role: 'member' })
  const bobId = await userIdOf('bob')
  const aliceId = await userIdOf('alice')
  const planId = (await planRound(w, { title: 'p', tasks: [task('t1')] }))!
  const forBob = (await pool.query('SELECT space_id FROM pages WHERE id = $1', [w.pageId])).rows[0].space_id as string
  await pool.query(
    `INSERT INTO team_plans (id, page_id, user_id, leader_agent, plan) VALUES ('bobs-plan', $1, $2, 'fake', '{"title":"bob 的","tasks":[]}'::jsonb)`,
    [w.pageId, bobId],
  )
  const plans = async (cookie: string): Promise<string[]> =>
    ((await (await api('GET', '/api/inbox', cookie)).json()) as { items: InboxItem[] }).items.filter((i) => i.type === 'plan').map((i) => (i as { planId: string }).planId)

  expect(await plans(w.cookie)).toEqual([planId]) // alice 只看到自己发起的
  expect(await plans(bob)).toEqual(['bobs-plan'])
  await pool.query(`UPDATE space_members SET role = 'viewer' WHERE space_id = $1 AND user_id = $2`, [forBob, bobId])
  expect(await plans(bob)).toEqual([]) // 降为只读：看得到 ⊆ 做得了，不给
  await pool.query(`UPDATE space_members SET role = 'member' WHERE space_id = $1 AND user_id = $2`, [forBob, bobId])
  expect(await plans(bob)).toEqual(['bobs-plan'])
  await pool.query(`UPDATE pages SET deleted_at = now()::text WHERE id = $1`, [w.pageId])
  expect(await plans(bob)).toEqual([]) // 页面进了回收站
  expect(aliceId).toBeTruthy()
  stop(w)
})

// ---------- 三、执行轮 ----------

/** 一个任务的最近一段 [开始, 结束]（时间都是相对执行轮开始的毫秒） */
const spanOf = (t: TeamTask, i = 0): { t: number; end: number } => {
  const span = t.spans[i]!
  expect(span.end).toBeDefined()
  return { t: span.t, end: span.end! }
}

test('执行轮：无依赖的并行（≤ 4）、有依赖的排在前置之后并拿到前置结果；计划 running → done；回复块 team 属性与组长的附录一致', async () => {
  const w = await startWorld()
  const slow = { detail: '工作:慢500' }
  const tasks = [
    task('a1', slow),
    task('a2', { ...slow, assignee: 'claude' }),
    task('a3', slow),
    task('a4', { ...slow, assignee: 'claude' }),
    task('a5', slow),
    task('b', { dependsOn: ['a1', 'a2'], assignee: 'claude' }),
  ]
  const planId = (await planRound(w, { title: '并行', tasks }))!
  await execRound(w, planId)

  const view = await planView(w, planId)
  expect(view.status).toBe('done')
  expect(view.tasks.map((t) => t.error ?? t.status)).toEqual(Array(6).fill('done'))
  // 并行：同一时刻最多 4 个在跑，且真的有并行（不是串行）
  const spans = ['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => spanOf(taskOf(view, id)))
  const concurrent = (at: number): number => spans.filter((x) => x.t <= at && at < x.end).length
  const peak = Math.max(...spans.map((x) => concurrent(x.t)))
  expect(peak).toBeGreaterThanOrEqual(2)
  expect(peak).toBeLessThanOrEqual(4)
  // 第 5 个要等前面某一个结束才开始
  const startOrder = [...spans].sort((x, y) => x.t - y.t)
  expect(startOrder[4]!.t).toBeGreaterThanOrEqual(Math.min(...startOrder.slice(0, 4).map((x) => x.end)))
  // b 依赖 a1、a2：排在两者结束之后，并拿到它们的结果
  const b = taskOf(view, 'b')
  expect(spanOf(b).t).toBeGreaterThanOrEqual(Math.max(spanOf(taskOf(view, 'a1')).end, spanOf(taskOf(view, 'a2')).end))
  expect(b.output).toContain('delivered:b pre:a1,a2')
  // 回复块 team 属性是收尾时的状态；组长看到的附录里每个任务都是已交付
  const attr = decodeTeam(replyAttr(w.doc, 'team'))!
  expect(attr.status).toBe('done')
  expect(attr.tasks.map((t) => t.status)).toEqual(Array(6).fill('done'))
  expect(lastReplyText(w)).toContain('review:a1=已交付;a2=已交付;a3=已交付;a4=已交付;a5=已交付;b=已交付')
  // 页面 SSE：计划状态 running → done；本轮 team 原语里每个任务有状态变化
  const states = w.sse.events.filter((e) => e.type === 'team_plan').map((e) => (e.type === 'team_plan' ? e.plan.status : ''))
  expect(states.slice(-2)).toEqual(['running', 'done'])
  expect(teamEvents(w).some((e) => e.op === 'task' && e.id === 'b' && e.patch?.status === 'running')).toBe(true)
  stop(w)
})

test('前置任务出错：下游跳过（写明原因、不会被派发），不相干的照常做完；计划整体仍 done（组长收了尾）', async () => {
  const w = await startWorld()
  const planId = (await planRound(w, {
    title: '出错',
    tasks: [task('t1', { detail: '工作:出错' }), task('t2', { dependsOn: ['t1'] }), task('t3', { dependsOn: ['t2'] }), task('t4')],
  }))!
  await execRound(w, planId)
  const view = await planView(w, planId)
  expect(view.status).toBe('done')
  expect(view.tasks.map((t) => [t.id, t.status])).toEqual([['t1', 'failed'], ['t2', 'skipped'], ['t3', 'skipped'], ['t4', 'done']])
  expect(taskOf(view, 't1').error).toBeTruthy()
  expect(taskOf(view, 't2').error).toContain('前置任务「任务t1」没有完成')
  expect(taskOf(view, 't2').spans).toEqual([]) // 根本没派发
  expect(taskOf(view, 't3').error).toContain('前置任务「任务t2」没有完成')
  expect(lastReplyText(w)).toContain('review:t1=出错;t2=没有执行;t3=没有执行;t4=已交付')
  stop(w)
})

test('停止：在跑的组员当场取消、没开始的标取消，计划收成 cancelled，页面立刻空闲', async () => {
  const w = await startWorld()
  const planId = (await planRound(w, {
    title: '停',
    tasks: [task('t1', { detail: '工作:慢8000' }), task('t2', { detail: '工作:慢8000', assignee: 'claude' }), task('t3', { dependsOn: ['t1'] })],
  }))!
  expect(await startExec(w, planId)).toBe(202)
  await waitFor(() => ['t1', 't2'].every((id) => teamEvents(w).some((e) => e.op === 'task' && e.id === id && e.patch?.status === 'running')))
  // 执行中：计划已是 running，不能再改 / 取消 / 二次开工；GET 取实时状态
  const url = `/api/pages/${w.pageId}/team/${planId}`
  expect((await api('PATCH', url, w.cookie, { title: 'x' })).status).toBe(409)
  expect((await api('POST', `${url}/cancel`, w.cookie)).status).toBe(409)
  expect(await continuePage(w.pageId, w.cookie, { agent: 'fake', team: planId })).toBe(409)
  const live = await planView(w, planId)
  expect(live.status).toBe('running')
  expect(live.tasks.filter((t) => t.status === 'running').map((t) => t.id).sort()).toEqual(['t1', 't2'])

  const stoppedAt = Date.now()
  expect((await postJson(`/api/pages/${w.pageId}/stop`, w.cookie)).status).toBe(200)
  await settled(w.sse, ++w.rounds)
  expect(Date.now() - stoppedAt).toBeLessThan(6000) // 没有等 8 秒的组员跑完
  await replyDone(w)
  const view = await planView(w, planId)
  expect(view.status).toBe('cancelled')
  expect(view.tasks.map((t) => [t.id, t.status])).toEqual([['t1', 'cancelled'], ['t2', 'cancelled'], ['t3', 'cancelled']])
  expect(view.tasks.slice(0, 2).every((t) => t.spans[0]?.end !== undefined)).toBe(true) // 时段收了口
  expect(replyBlocks(w.doc).at(-1)!.outcome).toBe('cancelled')
  expect(decodeTeam(replyAttr(w.doc, 'team'))!.status).toBe('cancelled')
  stop(w)
})

test('send_back：组长把任务打回，组员同步重做并返回新结果；每个任务最多 2 次，第 3 次被拒', async () => {
  const w = await startWorld()
  const planId = (await planRound(w, { title: '审', tasks: [task('t1'), task('t2')] }, { goal: 'SENDBACK=t1x3' }))!
  await execRound(w, planId)
  const view = await planView(w, planId)
  const t1 = taskOf(view, 't1')
  expect(t1).toMatchObject({ status: 'done', backs: 2 })
  expect(t1.spans).toHaveLength(3) // 首次 + 两次返工
  expect(t1.output).toContain('redelivered:t1:2')
  expect(taskOf(view, 't2').backs ?? 0).toBe(0)
  const text = lastReplyText(w)
  expect(text).toContain('redelivered:t1:1')
  expect(text).toContain('redelivered:t1:2')
  expect(text).toMatch(/sb-error:.*已经被打回 2 次/)
  expect(text.match(/sb:/g)).toHaveLength(2)
  stop(w)
})

test('send_back / submit_plan 的凭证约束：不是对应阶段的组长、那一轮已经结束、普通凭证，一律拒绝；工具清单里也没有', async () => {
  const w = await startWorld()
  const aliceId = await userIdOf('alice')
  const planId = (await planRound(w, { title: 'p', tasks: [task('t1')] }))!
  await execRound(w, planId) // 这一轮已经结束了
  const mint = (team?: { kind: 'plan' | 'exec'; runId: string; planId?: string }) =>
    mintPageToken(aliceId, 'fake', { pageId: w.pageId, agentId: 'fake', canDispatch: false, ...(team ? { team } : {}) })
  const post = (path: string, token: string, body: unknown) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const toolsOf = async (token: string): Promise<string[]> =>
    ((await (await fetch(`${base}/api/ramet/tools`, { headers: { authorization: `Bearer ${token}` } })).json()) as { tools: string[] }).tools

  // 普通凭证（含能叫人的普通会话）：两个端点都 403，清单里没有
  const normal = mint()
  expect((await post('/api/ramet/team/send-back', normal, { taskId: 't1', feedback: 'x' })).status).toBe(403)
  expect((await post('/api/ramet/team/plan', normal, { title: 'p', tasks: [task('x')] })).status).toBe(403)
  expect(await toolsOf(normal)).not.toContain('send_back')
  expect(await toolsOf(normal)).not.toContain('submit_plan')
  // 阶段对不上：exec 凭证提交计划 / plan 凭证打回
  const exec = mint({ kind: 'exec', runId: 'gone', planId })
  const plan = mint({ kind: 'plan', runId: 'gone' })
  expect((await post('/api/ramet/team/plan', exec, { title: 'p', tasks: [task('x')] })).status).toBe(403)
  expect((await post('/api/ramet/team/send-back', plan, { taskId: 't1', feedback: 'x' })).status).toBe(403)
  // 阶段对得上但那一轮已经不在飞：工具不列出；提交 409；打回回告已经结束
  expect(await toolsOf(exec)).not.toContain('send_back')
  expect(await toolsOf(plan)).not.toContain('submit_plan')
  const late = await post('/api/ramet/team/plan', plan, { title: 'p', tasks: [task('x')] })
  expect(late.status).toBe(409)
  const back = JSON.parse((await (await post('/api/ramet/team/send-back', exec, { taskId: 't1', feedback: 'x' })).text()).trim()) as { error: string }
  expect(back.error).toContain('已经结束')
  // 没凭证 / 坏凭证 401
  expect((await post('/api/ramet/team/plan', 'bad', { title: 'p', tasks: [] })).status).toBe(401)
  expect(await rows(planId)).toMatchObject({ status: 'done' })
  stop(w)
})

test('执行轮在飞时拿它的凭证直接打端点：别人 / 别的页面 / 别的阶段的凭证一律不行；打回并发只有一个进得去，次数上限照样守', async () => {
  const w = await startWorld()
  const aliceId = await userIdOf('alice')
  await joinPageSpace(w.pageId, 'bob', { role: 'member' })
  const bobId = await userIdOf('bob')
  const planId = (await planRound(w, { title: 'p', tasks: [task('t1')] }, { goal: '审查等待6000' }))!
  expect(await startExec(w, planId)).toBe(202)
  await waitFor(() => teamEvents(w).some((e) => e.op === 'task' && e.id === 't1' && e.patch?.status === 'done'))
  // 组长正在审查等待：从收件箱的在跑条目拿到这一轮的 runId
  const running = async () => ((await (await api('GET', '/api/inbox', w.cookie)).json()) as { items: InboxItem[] }).items.find((i) => i.type === 'running')
  await waitFor(async () => (await running()) !== undefined)
  const runId = (await running() as Extract<InboxItem, { type: 'running' }>).runId

  const mint = (userId: string, team: { kind: 'plan' | 'exec'; runId: string; planId?: string }, pageId = w.pageId) =>
    mintPageToken(userId, 'fake', { pageId, agentId: 'fake', canDispatch: false, team })
  const sendBack = async (token: string, taskId = 't1'): Promise<{ error?: string; output?: string }> =>
    JSON.parse(
      (await (await fetch(`${base}/api/ramet/team/send-back`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ taskId, feedback: '再来' }) })).text()).trim(),
    ) as { error?: string; output?: string }
  const toolsOf = async (token: string): Promise<string[]> => ((await (await fetch(`${base}/api/ramet/tools`, { headers: { authorization: `Bearer ${token}` } })).json()) as { tools: string[] }).tools

  // 凭证绑的人 / 页面 / 阶段对不上这一轮：清单里没有 send_back，打回回告已经结束，任务没被动
  const { pageId: otherPage } = await setupOther()
  const wrong = [mint(bobId, { kind: 'exec', runId }), mint(aliceId, { kind: 'exec', runId }, otherPage), mint(aliceId, { kind: 'plan', runId })]
  for (const token of wrong) {
    expect(await toolsOf(token)).not.toContain('send_back')
    expect(await toolsOf(token)).not.toContain('submit_plan')
  }
  for (const token of [wrong[0]!, wrong[1]!]) expect((await sendBack(token)).error).toContain('已经结束')
  expect(taskOf(await planView(w, planId), 't1').backs ?? 0).toBe(0)

  // 对的凭证：清单里有；两个并发的打回只有一个进得去，另一个被告知正在重做
  const token = mint(aliceId, { kind: 'exec', runId, planId })
  expect(await toolsOf(token)).toContain('send_back')
  const [x, y] = await Promise.all([sendBack(token), sendBack(token)])
  expect([x, y].filter((r) => r.error === undefined)).toHaveLength(1)
  expect([x, y].find((r) => r.error)!.error).toContain('正在重做')
  expect((await sendBack(token)).error).toBeUndefined() // 第二次
  expect((await sendBack(token)).error).toContain('已经被打回 2 次') // 第三次被拒
  expect((await sendBack(token, 'nope')).error).toContain('没有任务')

  await postJson(`/api/pages/${w.pageId}/stop`, w.cookie)
  await settled(w.sse, ++w.rounds)
  stop(w)
})

test('组员等审批：审批照常进页面审批条（带组员的 agentId、可答），等待的时段记进 team 原语；答了之后接着做完', async () => {
  const w = await startWorld()
  const planId = (await planRound(w, { title: '批', tasks: [task('t1', { detail: '工作:审批' })] }))!
  expect(await startExec(w, planId)).toBe(202)
  const ask = await waitPermission(w.sse, (e) => e.toolCall?.toolCallId === 'w-t1')
  expect(ask.agentId).toBe('fake')
  await waitFor(() => teamEvents(w).some((e) => e.op === 'task' && e.id === 't1' && e.wait === 'open'))
  expect(teamEvents(w).some((e) => e.op === 'task' && e.wait === 'close')).toBe(false) // 还没答
  // 收件箱里也有（审批归页面上的会话，不因为是组员的就看不见）
  const inbox = ((await (await api('GET', '/api/inbox', w.cookie)).json()) as { items: InboxItem[] }).items
  expect(inbox.some((i) => i.type === 'approval' && i.requestId === ask.requestId && i.pageId === w.pageId)).toBe(true)

  expect((await answerPermission(w.pageId, w.cookie, ask, 'allow_once')).status).toBe(200)
  await settled(w.sse, ++w.rounds)
  await replyDone(w)
  const t1 = taskOf(await planView(w, planId), 't1')
  expect(t1.output).toContain('approved:allow_once')
  expect(t1.spans).toHaveLength(1)
  expect(t1.spans[0]!.waits).toHaveLength(1)
  expect(t1.spans[0]!.waits![0]!.end).toBeDefined()
  expect(t1.spans[0]!.waits![0]!.t).toBeGreaterThanOrEqual(t1.spans[0]!.t)
  stop(w)
})

test('组员的工作目录：计划卡上设的目录就是组员会话的 cwd，没设的用页面上该 agent 的当前工作区', async () => {
  const w = await startWorld()
  const planId = (await planRound(w, { title: '目录', tasks: [task('t1', { detail: '工作:报目录' }), task('t2', { detail: '工作:报目录' })] }))!
  expect((await api('PATCH', `/api/pages/${w.pageId}/team/${planId}`, w.cookie, { tasks: [{ id: 't1', cwd: '/tmp' }] })).status).toBe(200)
  await execRound(w, planId)
  const view = await planView(w, planId)
  expect(taskOf(view, 't1').output).toContain('cwd:/tmp')
  expect(taskOf(view, 't2').output).toContain(`cwd:${process.cwd()}`)
  stop(w)
})

// 带队事件（本轮 RunRecord 的 team 原语，经页面 SSE 推给前端）
const teamEvents = (w: W) => w.sse.events.filter((e): e is Extract<typeof e, { type: 'team' }> => e.type === 'team')
