/* ---------- 收回即断 + 到期清扫 + 使用记录 ----------
 * 授权被收回 / 本人放弃 / 到期之后，中心必须当场断开此人在这台机器上的一切：
 *   - 他在飞的一轮：机器收到 cancel，回复收成 error + 原因（不是「已停止」），之后他再发起 403；
 *   - 他的 MCP 短期凭证作废（别人的不受影响）；
 *   - 机器收到非驱动帧 grant-revoked（本机名单删人 + 取消他的在飞 prompt）；离线时重连补发；
 *   - run_agent 子运行同样取消；对机器主人的收回无效。
 * 使用记录：只记非主人的 run / answer / config，主人自己不记；第一次使用设 first_used_at；只有主人能读，分页。 */
import { expect, test } from 'vitest'
import * as Y from 'yjs'
import { CONNECTOR_TOKEN_HEADER, type DrivenMsg } from './agents/protocol.js'
import { connectMachine, pairMachine, type Machine } from './agents/scripted-machine.js'
import type { PermissionEvent } from './agents/types.js'
import {
  SSECollector,
  agentsList,
  answerPermission,
  base,
  connectDoc,
  continuePage,
  insertUser,
  login,
  pool,
  postJson,
  s,
  serverReplies,
  settled,
  userMessage,
  waitFor,
} from './agents/test-kit.js'
import { mintPageToken } from './page-read.js'

type Who = 'mowner' | 'sowner' | 'alice' | 'bob' | 'outsider'
const WHO: readonly Who[] = ['mowner', 'sowner', 'alice', 'bob', 'outsider']

type World = { spaceId: string; pageId: string; id: Record<Who, string>; cookie: Record<Who, string>; m: Machine; claude: string; fake: string }

async function world(): Promise<World> {
  const id = {} as Record<Who, string>
  const cookie = {} as Record<Who, string>
  for (const who of WHO) {
    id[who] = await insertUser(who)
    cookie[who] = await login(who)
  }
  const space = (await (await postJson('/api/spaces', cookie.sowner, { name: 's' })).json()) as { id: string }
  for (const who of ['mowner', 'alice', 'bob'] as const) {
    await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [space.id, id[who], 'member'])
  }
  const page = (await (await postJson('/api/pages', cookie.sowner, { space_id: space.id })).json()) as { id: string }
  const m = await pairMachine(space.id, id.mowner, 'box')
  return { spaceId: space.id, pageId: page.id, id, cookie, m, claude: `c:${m.id}:claude`, fake: `c:${m.id}:fake` }
}

const call = (method: string, path: string, cookie: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/** 走完整个授权仪式：主人网页发起 → 在机器上用确认码确认。返回 grantId */
async function grantVia(w: World, who: Who, scopes: Array<'agent' | 'machine'> = ['agent']): Promise<string> {
  const res = await call('POST', `/api/machines/${w.m.id}/grants`, w.cookie.mowner, {
    password: 'pw-123456', userId: w.id[who], username: who, machineName: 'box', scopes, days: 7, acknowledged: true,
  })
  expect(res.status).toBe(201)
  const { grantId, code } = (await res.json()) as { grantId: string; code: string }
  const done = await fetch(`${base}/api/connector/grants/${code}/confirm`, { method: 'POST', headers: { [CONNECTOR_TOKEN_HEADER]: w.m.token } })
  expect(done.status).toBe(200)
  return grantId
}

const revokeApi = (w: World, grantId: string, by: Who): Promise<Response> => call('DELETE', `/api/machines/${w.m.id}/grants/${grantId}`, w.cookie[by])

async function waitMessages(w: World, n: number): Promise<void> {
  await waitFor(async () => {
    const p = await connectDoc(w.pageId, w.cookie.mowner)
    let count = 0
    p.document.getXmlFragment('prosemirror').forEach((c) => {
      if (c instanceof Y.XmlElement && c.nodeName === 'user_message') count += 1
    })
    p.destroy()
    return count >= n
  })
}

/** 这个人在机器上最近一次 `new` 帧里拿到的 MCP 凭证 */
function mcpTokenOf(w: World, who: Who): string {
  const frame = w.m.by(w.id[who]).filter((f): f is Extract<DrivenMsg, { t: 'new' }> => f.t === 'new').at(-1)
  const token = frame?.tools?.[0]?.mcp?.token
  if (!token) throw new Error(`${who} 没有拿到 MCP 凭证`)
  return token
}

/** 凭证读本页：能读 200，作废了 401 */
const readPageWith = (w: World, token: string): Promise<Response> =>
  fetch(`${base}/api/pages/${w.pageId}/text`, { headers: { authorization: `Bearer ${token}` } })

/** alice 发起一轮并挂在机器上（hold）。返回她这一轮的 SSE */
async function aliceRunning(w: World): Promise<{ sse: SSECollector; doc: Awaited<ReturnType<typeof connectDoc>> }> {
  const sse = new SSECollector()
  await sse.start(w.pageId, w.cookie.alice)
  const doc = await connectDoc(w.pageId, w.cookie.alice)
  userMessage(doc.document, '慢慢来', { agent: w.claude })
  await waitMessages(w, 1)
  w.m.hold = true
  expect(await continuePage(w.pageId, w.cookie.alice, { agent: w.claude })).toBe(202)
  await waitFor(() => w.m.held.length === 1)
  return { sse, doc }
}

/** 收回之后此人面前的一切都已断开 */
async function expectCutOff(w: World, who: Who, sse: SSECollector, token: string): Promise<void> {
  // 机器：收到 cancel（该会话）与 grant-revoked（只带 userId）
  await waitFor(() => w.m.frames.some((f) => f.t === 'cancel') && w.m.of('grant-revoked').length > 0)
  expect(w.m.of('grant-revoked')).toEqual([{ t: 'grant-revoked', userId: w.id[who] }])
  const promptOf = w.m.by(w.id[who]).filter((f): f is Extract<DrivenMsg, { t: 'prompt' }> => f.t === 'prompt').at(-1)
  expect(w.m.frames.find((f) => f.t === 'cancel')).toMatchObject({ t: 'cancel', agent: 'claude', sessionId: promptOf?.sessionId })
  // 回复收成 error + 原因（不是「已停止」）
  const failed = await sse.wait((e) => e.type === 'error' && e.message.includes('授权已收回'))
  expect(failed).toMatchObject({ replyId: expect.any(String) })
  const status = await sse.wait((e) => e.type === 'status' && e.state === 'error')
  expect(status).toMatchObject({ message: expect.stringContaining('授权已收回') })
  await settled(sse, 1)
  expect((await serverReplies(w.pageId, w.cookie.mowner)).map((r) => r.outcome)).toEqual(['error'])
  // 之后：目录里没有、发起 403、凭证作废
  expect((await agentsList(w.cookie[who])).filter((a) => a.id.startsWith('c:'))).toEqual([])
  expect(await continuePage(w.pageId, w.cookie[who], { agent: w.claude })).toBe(403)
  expect((await postJson(`/api/pages/${w.pageId}/agent-prepare`, w.cookie[who], { agent: w.claude })).status).toBe(403)
  expect((await readPageWith(w, token)).status).toBe(401)
  expect((await fetch(`${base}/api/ramet/tools`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401)
}

test('主人收回：alice 在飞的一轮当场被取消（回复收成「授权已收回」）、MCP 凭证作废、机器收到 grant-revoked；主人自己的凭证不受影响', async () => {
  const w = await world()
  const grantId = await grantVia(w, 'alice')
  // 主人先建一个会话，拿到他自己的凭证（证明收回只动 alice 的）
  const ownerSse = new SSECollector()
  await ownerSse.start(w.pageId, w.cookie.mowner)
  expect((await postJson(`/api/pages/${w.pageId}/agent-prepare`, w.cookie.mowner, { agent: w.claude })).status).toBe(202)
  await ownerSse.wait((e) => e.type === 'config' && e.agentId === w.claude)
  const ownerToken = mcpTokenOf(w, 'mowner')

  const { sse, doc } = await aliceRunning(w)
  const aliceToken = mcpTokenOf(w, 'alice')
  expect((await readPageWith(w, aliceToken)).status).toBe(200) // 收回前凭证有效
  expect(w.m.of('grant-revoked')).toEqual([])

  expect((await revokeApi(w, grantId, 'mowner')).status).toBe(200)
  await expectCutOff(w, 'alice', sse, aliceToken)
  expect((await readPageWith(w, ownerToken)).status).toBe(200) // 主人的凭证还在
  expect(w.m.by(w.id.mowner).every((f) => f.t !== 'prompt')).toBe(true)
  // 授权行：已收回且已断开
  expect(await pool.query('SELECT revoked_at, ended_at FROM machine_grants WHERE id = $1', [grantId]).then((r) => r.rows[0])).toMatchObject({
    revoked_at: expect.any(Date),
    ended_at: expect.any(Date),
  })
  // 收回不是删历史：授权记录还在列表里
  const listed = (await (await call('GET', `/api/machines/${w.m.id}/grants`, w.cookie.mowner)).json()) as Array<{ status: string }>
  expect(listed.map((g) => g.status)).toEqual(['revoked'])
  sse.stop()
  ownerSse.stop()
  doc.destroy()
})

test('被授权人自己放弃：效果和主人收回一样；别人（同空间的 bob、不在空间的人）不能替他放弃', async () => {
  const w = await world()
  const grantId = await grantVia(w, 'alice')
  await grantVia(w, 'bob')
  const { sse, doc } = await aliceRunning(w)
  const aliceToken = mcpTokenOf(w, 'alice')

  expect((await revokeApi(w, grantId, 'bob')).status).toBe(403)
  expect((await revokeApi(w, grantId, 'sowner')).status).toBe(403)
  expect((await revokeApi(w, grantId, 'outsider')).status).toBe(404)
  expect(w.m.of('grant-revoked')).toEqual([])
  expect((await readPageWith(w, aliceToken)).status).toBe(200)

  expect((await revokeApi(w, grantId, 'alice')).status).toBe(200)
  await expectCutOff(w, 'alice', sse, aliceToken)
  expect((await revokeApi(w, grantId, 'alice')).status).toBe(404) // 已经收回
  expect((await revokeApi(w, grantId, 'mowner')).status).toBe(404)
  // bob 的授权没受影响
  expect((await agentsList(w.cookie.bob)).some((a) => a.id === w.claude)).toBe(true)
  sse.stop()
  doc.destroy()
})

test('到期清扫：到期的授权效果同收回，且只执行一次（ended_at）；没到期的不动', async () => {
  const w = await world()
  const aliceGrant = await grantVia(w, 'alice')
  const bobGrant = await grantVia(w, 'bob')
  const { sse, doc } = await aliceRunning(w)
  const aliceToken = mcpTokenOf(w, 'alice')

  // 到期但还没清扫：判定已经为假，在飞的一轮还在跑，清扫才会当场断开
  await pool.query("UPDATE machine_grants SET expires_at = now() - interval '1 second' WHERE id = $1", [aliceGrant])
  expect((await agentsList(w.cookie.alice)).some((a) => a.id === w.claude)).toBe(false)
  expect(w.m.of('grant-revoked')).toEqual([])
  expect((await readPageWith(w, aliceToken)).status).toBe(200)

  expect(await s.sweepGrants()).toBe(1)
  await expectCutOff(w, 'alice', sse, aliceToken)
  expect((await pool.query('SELECT ended_at FROM machine_grants WHERE id = $1', [aliceGrant])).rows[0].ended_at).not.toBeNull()
  expect((await pool.query('SELECT ended_at FROM machine_grants WHERE id = $1', [bobGrant])).rows[0].ended_at).toBeNull()
  expect(w.m.of('grant-revoked').map((f) => f.userId)).toEqual([w.id.alice]) // 只通知了 alice

  // 第二次清扫什么都不做
  const frames = w.m.frames.length
  expect(await s.sweepGrants()).toBe(0)
  await new Promise((r) => setTimeout(r, 200))
  expect(w.m.frames.length).toBe(frames)
  sse.stop()
  doc.destroy()
})

test('新授权顶掉旧授权时，清扫不会把此人断开（他还有有效授权）；授权全无才断', async () => {
  const w = await world()
  const first = await grantVia(w, 'alice')
  await pool.query("UPDATE machine_grants SET expires_at = now() - interval '1 second' WHERE id = $1", [first])
  const second = await grantVia(w, 'alice', ['agent', 'machine']) // 到期的旧授权还没清扫，新的已确认
  expect(await s.sweepGrants()).toBe(1)
  expect(w.m.of('grant-revoked')).toEqual([]) // 旧的标记为已处理，但没断开
  expect((await agentsList(w.cookie.alice)).some((a) => a.id === w.claude)).toBe(true)
  await revokeApi(w, second, 'mowner')
  await waitFor(() => w.m.of('grant-revoked').length === 1)
})

test('run_agent 子运行：授权被收回时同样当场取消（outcome = cancelled），机器收到对被叫会话的 cancel', async () => {
  const w = await world()
  const grantId = await grantVia(w, 'alice')
  w.m.hold = true
  const token = mintPageToken(w.id.alice, w.claude, { pageId: w.pageId, agentId: w.claude, canDispatch: true })
  const running = fetch(`${base}/api/ramet/run-agent`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ agent: w.fake, task: '做点事' }),
  })
  await waitFor(() => w.m.held.length === 1)
  expect((await revokeApi(w, grantId, 'mowner')).status).toBe(200)
  const res = await running
  expect(JSON.parse((await res.text()).trim())).toMatchObject({ outcome: 'cancelled' })
  expect(w.m.frames.some((f) => f.t === 'cancel')).toBe(true)
  expect(w.m.of('grant-revoked').map((f) => f.userId)).toEqual([w.id.alice])
})

test('机器离线时收回：连上后补发 grant-revoked（本机名单里可能还留着他）；现在又有有效授权的人不补发', async () => {
  const w = await world()
  const aliceGrant = await grantVia(w, 'alice')
  await grantVia(w, 'bob')
  const offline = async (m: Machine): Promise<void> => {
    m.ws.terminate()
    await waitFor(async () => !(await agentsList(w.cookie.bob)).some((a) => a.id === w.claude))
  }
  await offline(w.m)
  expect((await revokeApi(w, aliceGrant, 'mowner')).status).toBe(200) // 机器不在线也能收回（中心这一道闸立刻生效）
  expect((await agentsList(w.cookie.alice)).length).toBe(0)

  const back = await connectMachine({ id: w.m.id, name: 'box', token: w.m.token })
  await waitFor(() => back.of('grant-revoked').length > 0)
  await new Promise((r) => setTimeout(r, 200))
  expect(back.of('grant-revoked')).toEqual([{ t: 'grant-revoked', userId: w.id.alice }]) // bob 没有

  // alice 重新被授权之后再掉线重连：不再补发（别把新授权的本机条目删了）
  await grantVia(w, 'alice')
  await offline(back)
  const again = await connectMachine({ id: w.m.id, name: 'box', token: w.m.token })
  await new Promise((r) => setTimeout(r, 300))
  expect(again.of('grant-revoked')).toEqual([])
})

test('对机器主人的收回无效：主人没有授权也能用，敲错命令（收回主人的名字）不能把他自己的在飞轮次断掉', async () => {
  const w = await world()
  const sse = new SSECollector()
  await sse.start(w.pageId, w.cookie.mowner)
  const doc = await connectDoc(w.pageId, w.cookie.mowner)
  userMessage(doc.document, '慢慢来', { agent: w.claude })
  await waitMessages(w, 1)
  w.m.hold = true
  expect(await continuePage(w.pageId, w.cookie.mowner, { agent: w.claude })).toBe(202)
  await waitFor(() => w.m.held.length === 1)

  const res = await fetch(`${base}/api/connector/grants/revoke`, {
    method: 'POST',
    headers: { [CONNECTOR_TOKEN_HEADER]: w.m.token, 'content-type': 'application/json' },
    body: JSON.stringify({ userId: w.id.mowner }),
  })
  expect(await res.json()).toEqual({ revoked: 0 })
  await new Promise((r) => setTimeout(r, 300))
  expect(w.m.frames.some((f) => f.t === 'cancel' || f.t === 'grant-revoked')).toBe(false)
  expect(w.m.held).toHaveLength(1) // 还在跑
  expect((await agentsList(w.cookie.mowner)).some((a) => a.id === w.claude)).toBe(true)
  await postJson(`/api/pages/${w.pageId}/stop`, w.cookie.mowner)
  sse.stop()
  doc.destroy()
})

test('机器上的收回端点：收回此人全部授权并当场断开；没 token 401、坏参数 400；对没有授权的人 revoked = 0', async () => {
  const w = await world()
  await grantVia(w, 'alice')
  const revoke = (body: unknown, token: string | null = w.m.token): Promise<Response> =>
    fetch(`${base}/api/connector/grants/revoke`, {
      method: 'POST',
      headers: { ...(token ? { [CONNECTOR_TOKEN_HEADER]: token } : {}), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  expect((await revoke({ userId: w.id.alice }, null)).status).toBe(401)
  expect((await revoke({})).status).toBe(400)
  expect((await revoke({ userId: 42 })).status).toBe(400)
  expect((await agentsList(w.cookie.alice)).length).toBeGreaterThan(0) // 上面的都没动她

  expect(await (await revoke({ userId: w.id.alice })).json()).toEqual({ revoked: 1 })
  expect((await agentsList(w.cookie.alice)).length).toBe(0)
  expect(w.m.of('grant-revoked').map((f) => f.userId)).toEqual([w.id.alice])
  expect(await (await revoke({ userId: w.id.alice })).json()).toEqual({ revoked: 0 }) // 幂等
  expect(await (await revoke({ userId: w.id.bob })).json()).toEqual({ revoked: 0 })
  // 别的机器的 token 收回不了这台机器上的授权
  await grantVia(w, 'alice')
  const other = await pairMachine(w.spaceId, w.id.mowner, 'box2')
  expect(await (await revoke({ userId: w.id.alice }, other.token)).json()).toEqual({ revoked: 0 })
  expect((await agentsList(w.cookie.alice)).some((a) => a.id === w.claude)).toBe(true)
})

const perm = (requestId: string, sessionId: string): PermissionEvent => ({
  type: 'permission',
  requestId,
  title: '写文件',
  options: [{ optionId: 'allow', name: '允许' }],
  sessionId,
  toolCall: { rawInput: { command: 'rm -rf build' } },
})

type UsageRow = { id: string; userId: string; username: string; action: string; pageId: string | null; detail: Record<string, unknown>; createdAt: string }
const usage = async (w: World, query = '', by: Who = 'mowner'): Promise<UsageRow[]> =>
  (await (await call('GET', `/api/machines/${w.m.id}/usage${query}`, w.cookie[by])).json()) as UsageRow[]

test('使用记录：被授权人的 run / answer / config / run_agent 各记一条（带内容），主人自己的使用不记；第一次使用设 first_used_at', async () => {
  const w = await world()
  await grantVia(w, 'alice')
  const firstUsed = async (): Promise<string | null> =>
    ((await (await call('GET', `/api/machines/${w.m.id}/grants`, w.cookie.mowner)).json()) as Array<{ firstUsedAt: string | null }>)[0]!.firstUsedAt
  const sse = new SSECollector()
  await sse.start(w.pageId, w.cookie.alice)

  // 预备会话不算使用；改配置算
  expect((await postJson(`/api/pages/${w.pageId}/agent-prepare`, w.cookie.alice, { agent: w.claude })).status).toBe(202)
  await sse.wait((e) => e.type === 'config' && e.agentId === w.claude)
  expect(await usage(w)).toEqual([])
  expect(await firstUsed()).toBeNull()
  expect((await postJson(`/api/pages/${w.pageId}/agent-config`, w.cookie.alice, { agent: w.claude, configId: 'model', value: 'm1' })).status).toBe(200)
  const first = await firstUsed()
  expect(first).not.toBeNull()

  // 发起一轮 / 重新生成
  const doc = await connectDoc(w.pageId, w.cookie.alice)
  userMessage(doc.document, '你好', { agent: w.claude })
  await waitMessages(w, 1)
  expect(await continuePage(w.pageId, w.cookie.alice, { agent: w.claude })).toBe(202)
  await settled(sse, 1)
  const [reply] = await serverReplies(w.pageId, w.cookie.alice)
  expect((await postJson(`/api/pages/${w.pageId}/replies/${reply!.id}/regenerate`, w.cookie.alice)).status).toBe(202)
  await settled(sse, 2)

  // 答审批
  const sessionId = w.m.sessions.at(-1)!
  w.m.send({ t: 'session', agent: 'claude', sessionId, ev: perm('perm-0', sessionId) })
  const pending = await sse.wait((e) => e.type === 'permission' && e.requestId === 'perm-0')
  if (pending.type !== 'permission') throw new Error('不是审批事件')
  expect((await answerPermission(w.pageId, w.cookie.alice, pending, 'allow')).status).toBe(200)

  // run_agent 子运行
  const token = mintPageToken(w.id.alice, w.claude, { pageId: w.pageId, agentId: w.claude, canDispatch: true })
  const sub = await fetch(`${base}/api/ramet/run-agent`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ agent: w.fake, task: '做点事' }),
  })
  expect(JSON.parse((await sub.text()).trim())).toMatchObject({ outcome: 'end' })

  const rows = await usage(w) // 新 → 旧
  expect(rows.map((r) => r.action)).toEqual(['run', 'answer', 'run', 'run', 'config'])
  expect(rows.every((r) => r.userId === w.id.alice && r.username === 'alice' && r.pageId === w.pageId)).toBe(true)
  expect(rows[0]!.detail).toMatchObject({ agent: w.fake, via: 'run_agent', task: '做点事' })
  expect(rows[1]!.detail).toMatchObject({ agentId: w.claude, requestId: 'perm-0', optionId: 'allow', optionName: '允许', title: '写文件', command: 'rm -rf build' })
  expect(rows[2]!.detail).toMatchObject({ agent: w.claude, redo: reply!.id })
  expect(rows[3]!.detail).toMatchObject({ agent: w.claude })
  expect(rows[4]!.detail).toMatchObject({ agent: w.claude, configId: 'model', value: 'm1' })
  expect(await firstUsed()).toBe(first) // 只设一次

  // 主人自己做同样的事：一条都不记
  const ownerSse = new SSECollector()
  await ownerSse.start(w.pageId, w.cookie.mowner)
  const ownerDoc = await connectDoc(w.pageId, w.cookie.mowner)
  userMessage(ownerDoc.document, '主人的话', { agent: w.claude })
  await waitMessages(w, 2)
  expect(await continuePage(w.pageId, w.cookie.mowner, { agent: w.claude })).toBe(202)
  await settled(ownerSse, 1)
  expect((await postJson(`/api/pages/${w.pageId}/agent-config`, w.cookie.mowner, { agent: w.claude, configId: 'model', value: 'm1' })).status).toBe(200)
  const ownerSession = w.m.sessions.at(-1)!
  w.m.send({ t: 'session', agent: 'claude', sessionId: ownerSession, ev: perm('perm-1', ownerSession) })
  const ownerPending = await ownerSse.wait((e) => e.type === 'permission' && e.requestId === 'perm-1')
  if (ownerPending.type !== 'permission') throw new Error('不是审批事件')
  expect((await answerPermission(w.pageId, w.cookie.mowner, ownerPending, 'allow')).status).toBe(200)
  expect((await usage(w)).length).toBe(5)
  sse.stop()
  ownerSse.stop()
  doc.destroy()
  ownerDoc.destroy()
})

test('使用记录只有主人能读，分页不重不漏；参数不合法 400', async () => {
  const w = await world()
  await grantVia(w, 'alice')
  for (let i = 0; i < 5; i++) {
    await pool.query('INSERT INTO machine_usage_log (connector_id, user_id, action, page_id, detail) VALUES ($1, $2, $3, $4, $5)', [
      w.m.id, w.id.alice, 'config', w.pageId, JSON.stringify({ n: i }),
    ])
  }
  for (const who of ['sowner', 'alice', 'bob'] as const) {
    expect((await call('GET', `/api/machines/${w.m.id}/usage`, w.cookie[who])).status, who).toBe(403)
  }
  expect((await call('GET', `/api/machines/${w.m.id}/usage`, w.cookie.outsider)).status).toBe(404)

  const all = await usage(w)
  expect(all.map((r) => r.detail.n)).toEqual([4, 3, 2, 1, 0])
  const page1 = await usage(w, '?limit=2')
  const page2 = await usage(w, `?limit=2&before=${page1.at(-1)!.id}`)
  const page3 = await usage(w, `?limit=2&before=${page2.at(-1)!.id}`)
  expect([...page1, ...page2, ...page3].map((r) => r.detail.n)).toEqual([4, 3, 2, 1, 0])
  expect(page3).toHaveLength(1)
  expect((await usage(w, '?limit=1000')).length).toBe(5) // 上限只是封顶，不报错
  for (const bad of ['?limit=0', '?limit=x', '?before=abc', '?before=-1']) {
    expect((await call('GET', `/api/machines/${w.m.id}/usage${bad}`, w.cookie.mowner)).status, bad).toBe(400)
  }
})
