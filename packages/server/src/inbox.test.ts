/* ---------- 收件箱 ----------
 * 收件箱只是视图：每条能看到的你本来就能看到，每个按钮调的都是已有接口。这里逐类断言「谁看得到」，
 * 安全相关的（审批、待批准的接入、使用申请、首次使用、消除）同时断言「看不到的人，答 / 批 / 消也不行」。
 * 夹具：一个空间 + 一台 bob 接入的真 connector（跑假 agent）。人：
 *   alice  全局 admin、空间 owner（页面创建人），空间 owner / 全局 admin 对别人的机器没有任何特权
 *   bob    成员，机器主人        carol  成员，没有任何授权
 *   dave   成员，持有 agent 授权   erin   只读成员，库里有一条 agent 授权行（viewer 写不了，所以答不了）
 *   root   全局 admin，只是成员    frank  不在空间里 */
import { expect, test, vi } from 'vitest'
import { WebSocket } from 'ws'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { mintPageToken } from './page-read.js'
import { InboxPoke, type InboxItem } from './inbox.js'
import {
  addPage,
  answerPermission,
  base,
  connectDoc,
  continuePage,
  grantMachine,
  insertUser,
  joinPageSpace,
  login,
  pageOwnership,
  pairViaBrowser,
  pool,
  postJson,
  s,
  settled,
  setupPage,
  SSECollector,
  startConnector,
  userIdOf,
  userMessage,
  waitFor,
  waitPermission,
} from './agents/test-kit.js'

type Who = 'alice' | 'bob' | 'carol' | 'dave' | 'erin' | 'root' | 'frank'
const OTHERS_THAN_BOB: readonly Who[] = ['alice', 'carol', 'dave', 'erin', 'root', 'frank']

type World = {
  pageId: string
  spaceId: string
  connectorId: string
  agent: string
  cookie: Record<Who, string>
  id: Record<Who, string>
}

async function world(): Promise<World> {
  const { cookie: alice, pageId } = await setupPage()
  const { spaceId } = await pageOwnership(pageId)
  const cookie = { alice } as Record<Who, string>
  cookie.bob = await joinPageSpace(pageId, 'bob', { role: 'member' })
  cookie.carol = await joinPageSpace(pageId, 'carol', { role: 'member' })
  cookie.dave = await joinPageSpace(pageId, 'dave', { role: 'member' })
  cookie.erin = await joinPageSpace(pageId, 'erin', { role: 'viewer' })
  cookie.root = await joinPageSpace(pageId, 'root', { user: 'admin', role: 'member' })
  await insertUser('frank')
  cookie.frank = await login('frank')
  const id = {} as Record<Who, string>
  for (const who of Object.keys(cookie) as Who[]) id[who] = await userIdOf(who)
  const connectorId = await startConnector({ spaceId, ownerId: id.bob, name: 'bobbox', cookie: cookie.bob })
  await grantMachine(connectorId, id.dave, { scopes: ['agent'] })
  await grantMachine(connectorId, id.erin, { scopes: ['agent'] })
  return { pageId, spaceId, connectorId, agent: `c:${connectorId}:fake`, cookie, id }
}

async function inbox(cookie: string): Promise<InboxItem[]> {
  const res = await fetch(`${base}/api/inbox`, { headers: { cookie } })
  expect(res.status).toBe(200)
  return ((await res.json()) as { items: InboxItem[] }).items
}

function ofType<T extends InboxItem['type']>(items: InboxItem[], type: T): Array<Extract<InboxItem, { type: T }>> {
  return items.filter((i): i is Extract<InboxItem, { type: T }> => i.type === type)
}

/** 这个人此刻某一类条目的数量 */
async function count(cookie: string, type: InboxItem['type']): Promise<number> {
  return ofType(await inbox(cookie), type).length
}

const call = (method: string, path: string, cookie: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/** bob 在页面上发一条消息并发起一轮，等审批出来 */
async function startRunWithApproval(w: World, text: string) {
  const doc = await connectDoc(w.pageId, w.cookie.bob)
  const sse = new SSECollector()
  await sse.start(w.pageId, w.cookie.bob)
  userMessage(doc.document, text)
  expect(await continuePage(w.pageId, w.cookie.bob, { agent: w.agent })).toBe(202)
  const ask = await waitPermission(sse)
  return { doc, sse, ask }
}


/** Ramet 自己的审批（trash_page）：以 user 的页面凭证打「移入回收站」端点，它会一直等审批被答；abortAll 结束这些挂着的请求 */
function rametApprovals(w: World, target: string) {
  const aborts: AbortController[] = []
  return {
    ask(user: Who, agentId: string): void {
      const controller = new AbortController()
      aborts.push(controller)
      const token = mintPageToken(w.id[user], agentId, { pageId: w.pageId, agentId })
      void fetch(`${base}/api/ramet/pages/${target}/trash`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      }).catch(() => undefined)
    },
    abortAll(): void {
      for (const controller of aborts) controller.abort()
    },
  }
}

/** 连 control:global：收服务端的 stateless 广播（'inbox' 等） */
async function connectControl(cookie: string, onStateless: (payload: string) => void): Promise<HocuspocusProvider> {
  const wsProvider = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${s.port}/collab`,
    WebSocketPolyfill: class extends WebSocket {
      constructor(url: string) {
        super(url, undefined, { headers: { cookie } })
      }
    } as unknown as typeof WebSocket,
    quiet: true,
  })
  const provider = new HocuspocusProvider({
    websocketProvider: wsProvider,
    name: 'control:global',
    token: 'test',
    quiet: true,
    onStateless: ({ payload }) => onStateless(payload),
  })
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('control provider 同步超时')), 10_000)
    provider.on('synced', () => {
      clearTimeout(t)
      resolve()
    })
  })
  return provider
}

// ---------- 基础 ----------

test('未登录 401；没有任何事时是空的', async () => {
  expect((await fetch(`${base}/api/inbox`)).status).toBe(401)
  expect((await fetch(`${base}/api/inbox/seen`, { method: 'POST' })).status).toBe(401)
  expect((await fetch(`${base}/api/inbox/dismiss`, { method: 'POST' })).status).toBe(401)
  const { cookie } = await setupPage()
  expect(await inbox(cookie)).toEqual([])
})

test('通知去抖：300ms 内的多次信号合并成一次广播，dispose 之后不再发', () => {
  vi.useFakeTimers()
  try {
    const send = vi.fn()
    const poke = new InboxPoke(send, 300)
    for (let i = 0; i < 5; i++) poke.poke()
    vi.advanceTimersByTime(299)
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(send).toHaveBeenCalledTimes(1)
    poke.poke() // 窗口过后的新信号再发一次
    vi.advanceTimersByTime(301)
    expect(send).toHaveBeenCalledTimes(2)
    poke.poke()
    poke.dispose()
    vi.advanceTimersByTime(1000)
    expect(send).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})

// ---------- 审批 ----------

test('审批（有在飞的一轮）：只有发起人看得到——被授权的人、空间 owner、全局 admin、viewer、外人都没有；发起人经已有接口答掉后消失', async () => {
  const w = await world()
  const { doc, sse, ask } = await startRunWithApproval(w, '需要权限')

  const mine = ofType(await inbox(w.cookie.bob), 'approval')
  expect(mine).toHaveLength(1)
  expect(mine[0]).toMatchObject({
    pageId: w.pageId,
    agentId: w.agent,
    agentName: 'bobbox · Fake',
    requestId: ask.requestId,
    title: '运行命令',
    detail: { kind: 'execute', command: 'npm test -- --run', description: '跑一遍单元测试' },
    options: [
      { optionId: 'allow_once', name: '允许', kind: 'allow_once' },
      { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' },
    ],
  })
  // 只给命令 / 路径这类摘要，不整包吐 toolCall
  expect(JSON.stringify(mine[0])).not.toContain('toolCallId')
  for (const who of OTHERS_THAN_BOB) {
    expect(await count(w.cookie[who], 'approval'), who).toBe(0)
  }

  expect((await answerPermission(w.pageId, w.cookie.bob, ask, 'allow_once')).status).toBe(200)
  await waitFor(async () => (await count(w.cookie.bob, 'approval')) === 0)
  sse.stop()
  doc.destroy()
})

test('审批（没有在飞的一轮，退回「能回答的人」）：机器主人和被授权的成员看得到；没授权的成员、空间 owner、全局 admin、viewer、外人看不到，也答不了', async () => {
  const w = await world()
  const { doc, sse, ask } = await startRunWithApproval(w, '后台审批')
  await sse.wait((e) => e.type === 'status' && e.state === 'done') // 这一轮结束了，审批还挂着

  for (const who of ['bob', 'dave'] as const) {
    const items = ofType(await inbox(w.cookie[who]), 'approval')
    expect(items.map((i) => i.requestId), who).toEqual([ask.requestId])
  }
  // 看不到的人 = 答不了的人（同一判定）；他们的尝试被拒，审批原样留着
  const refused: Array<[Who, number]> = [['alice', 403], ['carol', 403], ['root', 403], ['erin', 404], ['frank', 404]]
  for (const [who, status] of refused) {
    expect(await count(w.cookie[who], 'approval'), `${who} 看`).toBe(0)
    expect((await answerPermission(w.pageId, w.cookie[who], ask, 'allow_once')).status, `${who} 答`).toBe(status)
  }
  expect(await count(w.cookie.bob, 'approval')).toBe(1)

  // 被授权的人答得了，答完两边都消失
  expect((await answerPermission(w.pageId, w.cookie.dave, ask, 'allow_once')).status).toBe(200)
  await waitFor(async () => (await count(w.cookie.bob, 'approval')) === 0 && (await count(w.cookie.dave, 'approval')) === 0)
  sse.stop()
  doc.destroy()
})

test('审批：授权被收回后，被授权的人就看不到了', async () => {
  const w = await world()
  const { doc, sse } = await startRunWithApproval(w, '后台审批')
  await sse.wait((e) => e.type === 'status' && e.state === 'done')
  expect(await count(w.cookie.dave, 'approval')).toBe(1)
  await pool.query('UPDATE machine_grants SET revoked_at = now() WHERE user_id = $1', [w.id.dave])
  expect(await count(w.cookie.dave, 'approval')).toBe(0)
  expect(await count(w.cookie.bob, 'approval')).toBe(1)
  sse.stop()
  doc.destroy()
})

test('审批（Ramet 自己的，不碰机器）：没有在飞的一轮 → 页面可写的人都看得到，viewer 和外人看不到；有在飞的一轮且对得上 agent → 只有发起人', async () => {
  const w = await world()
  const ramet = rametApprovals(w, await addPage(w.pageId, w.cookie.alice))

  // 没有在飞的一轮：agentId 随便一个（这里用 'fake'）
  ramet.ask('carol', 'fake')
  await waitFor(async () => (await count(w.cookie.bob, 'approval')) === 1)
  for (const who of ['alice', 'bob', 'carol', 'dave', 'root'] as const) {
    const items = ofType(await inbox(w.cookie[who]), 'approval')
    expect(items, who).toHaveLength(1)
    expect(items[0]).toMatchObject({ pageId: w.pageId, agentId: 'fake', detail: { kind: 'delete' } })
  }
  for (const who of ['erin', 'frank'] as const) expect(await count(w.cookie[who], 'approval'), who).toBe(0)
  const own = ofType(await inbox(w.cookie.carol), 'approval')[0]!
  // 答它走已有的 /permission（拒绝）：消失
  expect((await postJson(`/api/pages/${w.pageId}/permission`, w.cookie.dave, { agentId: own.agentId, requestId: own.requestId, optionId: 'reject' })).status).toBe(200)
  await waitFor(async () => (await count(w.cookie.bob, 'approval')) === 0)

  // 有在飞的一轮（bob 的，agent 对得上）：Ramet 自己的审批也只给发起人
  const { doc, sse, ask } = await startRunWithApproval(w, '需要权限')
  ramet.ask('carol', w.agent)
  await waitFor(async () => (await count(w.cookie.bob, 'approval')) === 2)
  expect(ofType(await inbox(w.cookie.bob), 'approval').map((i) => i.requestId)).toContain(ask.requestId)
  for (const who of OTHERS_THAN_BOB) expect(await count(w.cookie[who], 'approval'), who).toBe(0)

  ramet.abortAll()
  expect((await answerPermission(w.pageId, w.cookie.bob, ask, 'allow_once')).status).toBe(200)
  sse.stop()
  doc.destroy()
})

// ---------- 待批准的 agent 接入 ----------

test('connector_pending：只有该空间的 owner 看得到；接入人自己、别的成员、只是成员的全局 admin 看不到；批准 / 拒绝后消失', async () => {
  const { cookie: alice, pageId } = await setupPage() // alice：空间 owner
  const carol = await joinPageSpace(pageId, 'carol', { role: 'member' }) // 接入人
  const bob = await joinPageSpace(pageId, 'bob', { role: 'member' })
  const root = await joinPageSpace(pageId, 'root', { user: 'admin', role: 'member' })
  const { spaceId } = await pageOwnership(pageId)

  const pair = (cookie: string, name: string) => pairViaBrowser(cookie, spaceId, name, [{ id: 'claude', label: 'Claude' }])
  const first = await pair(carol, 'carol-box')
  const second = await pair(carol, 'carol-box-2')
  expect([first.status, second.status]).toEqual(['pending', 'pending'])

  const seen = ofType(await inbox(alice), 'connector_pending')
  expect(seen.map((i) => i.machine)).toEqual(['carol-box', 'carol-box-2'])
  expect(seen[0]).toMatchObject({ connectorId: first.connectorId, owner: 'carol', agents: ['Claude'], spaceId })
  for (const [who, cookie] of [['carol', carol], ['bob', bob], ['root', root]] as const) {
    expect(await count(cookie, 'connector_pending'), who).toBe(0)
  }

  // 按钮调的是已有接口：批准一台、拒绝一台
  expect((await call('POST', `/api/connectors/${first.connectorId}/approve`, alice)).status).toBe(200)
  expect((await call('POST', `/api/connectors/${second.connectorId}/reject`, alice)).status).toBe(200)
  expect(await count(alice, 'connector_pending')).toBe(0)
})

test('connector_pending：全局 admin 在自己当 owner 的空间里看得到，别人的空间里看不到', async () => {
  const { cookie: alice, pageId } = await setupPage()
  const carol = await joinPageSpace(pageId, 'carol', { role: 'member' })
  const { spaceId } = await pageOwnership(pageId)
  // gadmin 是另一个空间的 owner，同时是 alice 空间的成员
  const gadmin = await joinPageSpace(pageId, 'gadmin', { user: 'admin', role: 'member' })
  const own = (await (await postJson('/api/spaces', gadmin, { name: 'g' })).json()) as { id: string }
  const pairIn = async (space: string, cookie: string, name: string): Promise<void> => {
    await pairViaBrowser(cookie, space, name)
  }
  await pairIn(spaceId, carol, 'in-alice-space')
  const gUser = await userIdOf('carol')
  await pool.query("INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'member')", [own.id, gUser])
  await pairIn(own.id, carol, 'in-g-space')

  expect(ofType(await inbox(gadmin), 'connector_pending').map((i) => i.machine)).toEqual(['in-g-space'])
  expect(ofType(await inbox(alice), 'connector_pending').map((i) => i.machine)).toEqual(['in-alice-space'])
})

// ---------- 使用申请 / 首次使用 ----------

test('access_request：只有机器主人看得到，只展示（申请人、范围、备注）；处理后消失', async () => {
  const w = await world()
  const res = await call('POST', `/api/machines/${w.connectorId}/requests`, w.cookie.carol, { scopes: ['agent', 'machine'], note: '想跑个测试' })
  expect(res.status).toBe(201)
  const { id: requestId } = (await res.json()) as { id: string }

  const items = ofType(await inbox(w.cookie.bob), 'access_request')
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({ connectorId: w.connectorId, machine: 'bobbox', username: 'carol', scopes: ['agent', 'machine'], note: '想跑个测试', requestId })
  for (const who of ['alice', 'carol', 'dave', 'erin', 'root', 'frank'] as const) {
    expect(await count(w.cookie[who], 'access_request'), who).toBe(0)
  }
  // 主人拒绝 = 处理掉
  expect((await call('DELETE', `/api/machines/${w.connectorId}/requests/${requestId}`, w.cookie.bob)).status).toBe(200)
  expect(await count(w.cookie.bob, 'access_request')).toBe(0)
})

test('first_use：被授权的人第一次用机器，主人收到提醒（别人没有）；点「知道了」消掉；别人的 / 乱写的 key 被拒且不写表', async () => {
  const w = await world()
  expect(await count(w.cookie.bob, 'first_use')).toBe(0)
  // dave 真的用了一次：在页面上发起一轮（授权范围 agent）
  const doc = await connectDoc(w.pageId, w.cookie.dave)
  const sse = new SSECollector()
  await sse.start(w.pageId, w.cookie.dave)
  userMessage(doc.document, '你好')
  expect(await continuePage(w.pageId, w.cookie.dave, { agent: w.agent })).toBe(202)
  await sse.wait((e) => e.type === 'status' && e.state === 'done')

  const items = ofType(await inbox(w.cookie.bob), 'first_use')
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({ connectorId: w.connectorId, machine: 'bobbox', username: 'dave', scopes: ['agent'] })
  for (const who of ['alice', 'carol', 'dave', 'erin', 'root', 'frank'] as const) {
    expect(await count(w.cookie[who], 'first_use'), who).toBe(0)
  }

  const key = items[0]!.key
  // 别人消不掉：dave（被授权人）、alice（空间 owner）、外人；表里不留行
  for (const who of ['dave', 'alice', 'frank'] as const) {
    expect((await postJson('/api/inbox/dismiss', w.cookie[who], { key })).status, who).toBe(404)
  }
  // 乱写的 key：格式不对 400，授权不存在 404，缺参 400
  expect((await postJson('/api/inbox/dismiss', w.cookie.bob, { key: 'first_use:no-such-grant' })).status).toBe(404)
  expect((await postJson('/api/inbox/dismiss', w.cookie.bob, { key: 'done:whatever' })).status).toBe(400)
  expect((await postJson('/api/inbox/dismiss', w.cookie.bob, { key: 'whatever' })).status).toBe(400)
  expect((await postJson('/api/inbox/dismiss', w.cookie.bob, {})).status).toBe(400)
  expect((await pool.query('SELECT 1 FROM inbox_dismissed')).rowCount).toBe(0)
  expect(await count(w.cookie.bob, 'first_use')).toBe(1)

  expect((await postJson('/api/inbox/dismiss', w.cookie.bob, { key })).status).toBe(200)
  expect(await count(w.cookie.bob, 'first_use')).toBe(0)
  expect((await postJson('/api/inbox/dismiss', w.cookie.bob, { key })).status).toBe(200) // 幂等
  expect((await pool.query('SELECT user_id FROM inbox_dismissed')).rows).toEqual([{ user_id: w.id.bob }])
  sse.stop()
  doc.destroy()
})

// ---------- 做完待你看 / 在跑 ----------

test('done：发起人完成一轮后出现（别人没有）；打开页面（seen）后消失；再跑一轮又出现', async () => {
  const w = await world()
  const doc = await connectDoc(w.pageId, w.cookie.bob)
  const sse = new SSECollector()
  await sse.start(w.pageId, w.cookie.bob)
  userMessage(doc.document, '第一问')
  expect(await continuePage(w.pageId, w.cookie.bob, { agent: w.agent })).toBe(202)
  await settled(sse, 1)

  await waitFor(async () => (await count(w.cookie.bob, 'done')) === 1)
  const items = ofType(await inbox(w.cookie.bob), 'done')
  expect(items[0]).toMatchObject({ pageId: w.pageId, agentId: w.agent, agentName: 'bobbox · Fake', outcome: 'end' })
  expect(items[0]!.runPageId).toBeTruthy()
  for (const who of OTHERS_THAN_BOB) expect(await count(w.cookie[who], 'done'), who).toBe(0)

  expect((await postJson('/api/inbox/seen', w.cookie.bob, { pageId: w.pageId })).status).toBe(200)
  expect(await count(w.cookie.bob, 'done')).toBe(0)

  userMessage(doc.document, '第二问')
  expect(await continuePage(w.pageId, w.cookie.bob, { agent: w.agent })).toBe(202)
  await settled(sse, 2)
  await waitFor(async () => (await count(w.cookie.bob, 'done')) === 1)
  sse.stop()
  doc.destroy()
})

test('done：页面被回收 / 发起人不再是空间成员后不再出现；seen 对读不到的页面 404 且不写行', async () => {
  const w = await world()
  const doc = await connectDoc(w.pageId, w.cookie.bob)
  const sse = new SSECollector()
  await sse.start(w.pageId, w.cookie.bob)
  userMessage(doc.document, '问一句')
  expect(await continuePage(w.pageId, w.cookie.bob, { agent: w.agent })).toBe(202)
  await settled(sse, 1)
  await waitFor(async () => (await count(w.cookie.bob, 'done')) === 1)

  // seen：外人（不是成员）、不存在的页面 404；表里没有行
  expect((await postJson('/api/inbox/seen', w.cookie.frank, { pageId: w.pageId })).status).toBe(404)
  expect((await postJson('/api/inbox/seen', w.cookie.bob, { pageId: 'no-such-page' })).status).toBe(404)
  expect((await postJson('/api/inbox/seen', w.cookie.bob, {})).status).toBe(400)
  expect((await pool.query('SELECT 1 FROM inbox_seen')).rowCount).toBe(0)

  // 页面进回收站：看不到了；恢复后又在
  expect((await call('POST', `/api/pages/${w.pageId}/trash`, w.cookie.alice)).status).toBe(200)
  expect(await count(w.cookie.bob, 'done')).toBe(0)
  expect((await call('POST', `/api/pages/${w.pageId}/restore`, w.cookie.alice)).status).toBe(200)
  expect(await count(w.cookie.bob, 'done')).toBe(1)

  // 被移出空间：不再是成员，页面对他不可读
  await pool.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [w.spaceId, w.id.bob])
  expect(await count(w.cookie.bob, 'done')).toBe(0)
  sse.stop()
  doc.destroy()
})

test('running：发起人在飞时出现（别人没有），结束后消失', async () => {
  const w = await world()
  const { doc, sse, ask } = await startRunWithApproval(w, '需要权限') // 审批没答，这一轮一直在飞
  const items = ofType(await inbox(w.cookie.bob), 'running')
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({ pageId: w.pageId, agentId: w.agent, agentName: 'bobbox · Fake' })
  for (const who of OTHERS_THAN_BOB) expect(await count(w.cookie[who], 'running'), who).toBe(0)

  expect((await answerPermission(w.pageId, w.cookie.bob, ask, 'allow_once')).status).toBe(200)
  await sse.wait((e) => e.type === 'status' && e.state === 'done')
  expect(await count(w.cookie.bob, 'running')).toBe(0)
  sse.stop()
  doc.destroy()
})

// ---------- 广播 ----------

test("广播：审批出现、审批结束、回合开始、回合结束，control:global 都收到 'inbox'；消息不带任何内容", async () => {
  const w = await world()
  const all: string[] = []
  let got: string[] = []
  const control = await connectControl(w.cookie.carol, (payload) => {
    all.push(payload)
    got.push(payload)
  }) // 旁观者也收得到：广播是全员的，所以不能带内容
  const fired = (): Promise<void> => waitFor(() => got.includes('inbox'), 8000)
  /** 等上一波去抖广播过去，再清零重新计 */
  const quiet = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 600))
    got = []
  }
  const ramet = rametApprovals(w, await addPage(w.pageId, w.cookie.alice))

  // 1. 审批出现（Ramet 自己的审批，此刻没有任何回合在动，所以只能是它触发的）
  await quiet()
  ramet.ask('carol', 'fake')
  await fired()
  // 2. 审批结束（只有 permission_resolved）
  await quiet()
  const own = ofType(await inbox(w.cookie.bob), 'approval')[0]!
  expect((await postJson(`/api/pages/${w.pageId}/permission`, w.cookie.bob, { agentId: own.agentId, requestId: own.requestId, optionId: 'reject' })).status).toBe(200)
  await fired()
  ramet.abortAll()

  // 3. 回合开始、回合结束（慢一点的一轮，开始和结束的信号落在两个去抖窗口里）
  await quiet()
  const doc = await connectDoc(w.pageId, w.cookie.bob)
  const sse = new SSECollector()
  await sse.start(w.pageId, w.cookie.bob)
  userMessage(doc.document, '慢慢来')
  expect(await continuePage(w.pageId, w.cookie.bob, { agent: w.agent })).toBe(202)
  await fired()
  got = []
  await sse.wait((e) => e.type === 'status' && (e.state === 'done' || e.state === 'error'))
  await fired()

  // 只有 'inbox' 这一个词，没有 pageId / userId / 条目内容
  expect(all.filter((p) => p.includes('inbox') && p !== 'inbox')).toEqual([])
  expect(all.some((p) => p.includes(w.pageId) || Object.values(w.id).some((id) => p.includes(id)))).toBe(false)
  control.destroy()
  sse.stop()
  doc.destroy()
})
