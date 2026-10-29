/* ---------- 空间公共记忆 × agent ----------
 * 一、propose_memory：agent 只能「提议」。中心在当前页弹一张「记住这条？」审批（Ramet 自己的审批，进收件箱），
 *    点「记住」才写库（记在点的人名下、来源是当前页）；点「不用」/ 这一轮被停止 / 调用方断开都不写；
 *    写不进去（空 / 超长 / 空间满）在打扰用户之前就回告 agent。
 * 二、注入：每轮开跑把这个空间的全部记忆带上（全文重放时在文档前面）。
 * 三、hash：会话复用的基线 hash 把记忆算进去，记忆没变是原生续聊（load + 只发新消息），记忆变了新建会话全文重放；
 *    没有记忆时 hash 与不带记忆的算法逐字节一致（老会话不因此重放）。起止同口径（收尾 hash 用本轮开头那份记忆）。
 * agent 拿到什么，用 fake agent 的「回显提示词」看。 */
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { mintPageToken } from '../page-read.js'
import { addMemory, memoryBlock } from '../memories.js'
import { promptHash } from './prompt-env.js'
import type { InboxItem } from '../inbox.js'
import {
  SSECollector,
  agentSession,
  answerPermission,
  base,
  connectDoc,
  continuePage,
  docText,
  joinPageSpace,
  insertUser,
  login,
  pageOwnership,
  pool,
  postJson,
  replyBlocks,
  settled,
  setupPage,
  userIdOf,
  userMessage,
  waitFor,
  waitPermission,
} from './test-kit.js'

const RAMET_MCP = fileURLToPath(new URL('../mcp/ramet.mjs', import.meta.url))
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

type World = {
  pageId: string
  spaceId: string
  alice: string // cookie：全局 admin、空间 owner
  bob: string // 成员
  carol: string // 只读成员
  id: { alice: string; bob: string; carol: string }
}

async function world(): Promise<World> {
  const { cookie: alice, pageId } = await setupPage()
  const { spaceId } = await pageOwnership(pageId)
  const bob = await joinPageSpace(pageId, 'bob', { role: 'member' })
  const carol = await joinPageSpace(pageId, 'carol', { role: 'viewer' })
  return { pageId, spaceId, alice, bob, carol, id: { alice: await userIdOf('alice'), bob: await userIdOf('bob'), carol: await userIdOf('carol') } }
}

const memories = async (spaceId: string): Promise<Array<{ text: string; created_by: string | null; source_page_id: string | null }>> =>
  (await pool.query('SELECT text, created_by, source_page_id FROM space_memories WHERE space_id = $1 ORDER BY created_at, id', [spaceId])).rows

/** agent 在 alice 的这一页上提议记一条（凭证绑 页面 + agent）。返回还没结束的请求：要等有人答 */
function propose(w: World, text: unknown, opts: { signal?: AbortSignal; pageId?: string | null } = {}): Promise<Response> {
  const pageId = opts.pageId === undefined ? w.pageId : opts.pageId
  const token = mintPageToken(w.id.alice, 'fake', pageId ? { pageId, agentId: 'fake' } : undefined)
  return fetch(`${base}/api/ramet/memories/propose`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
}

/** 会等很久的端点先发头、吐空白保活，最后一段才是 JSON */
const result = async (res: Response): Promise<Record<string, unknown>> => JSON.parse((await res.text()).trim()) as Record<string, unknown>

const isMemoryAsk = (ev: { requestId: string }): boolean => ev.requestId.startsWith('ramet-')

async function inbox(cookie: string): Promise<InboxItem[]> {
  return ((await (await fetch(`${base}/api/inbox`, { headers: { cookie } })).json()) as { items: InboxItem[] }).items
}

// ---------- 一、propose_memory ----------

test('提议 → 点「记住」才写入：审批在当前页弹出（选项「记住」/「不用」），记在点的人名下、来源是当前页；agent 拿到结果', async () => {
  const w = await world()
  const sse = new SSECollector()
  await sse.start(w.pageId, w.alice)
  const pending = propose(w, '  部署只用 scripts/deploy.sh，禁止裸 rsync --delete  ')
  const ask = await waitPermission(sse, isMemoryAsk)
  expect(ask).toMatchObject({ agentId: 'fake', title: expect.stringContaining('记住这条？') })
  expect(ask.title).toContain('部署只用 scripts/deploy.sh')
  expect(ask.options.map((o) => [o.name, o.kind])).toEqual([['记住', 'allow_once'], ['不用', 'reject_once']])
  expect(JSON.stringify(ask.toolCall)).toContain('禁止裸 rsync --delete')
  // 没点之前什么都没写
  expect(await memories(w.spaceId)).toEqual([])

  // bob（成员）点「记住」：记在 bob 名下，不是发起提议的 alice
  expect((await answerPermission(w.pageId, w.bob, ask, 'allow')).status).toBe(200)
  expect(await result(await pending)).toMatchObject({ ok: true })
  expect(await memories(w.spaceId)).toEqual([{ text: '部署只用 scripts/deploy.sh，禁止裸 rsync --delete', created_by: w.id.bob, source_page_id: w.pageId }])
  await sse.wait((e) => e.type === 'permission_resolved' && e.requestId === ask.requestId)
  sse.stop()
})

test('点「不用」不写；这一轮被停止不写；调用方断开不写（都回告 agent 没写）', async () => {
  const w = await world()
  const sse = new SSECollector()
  await sse.start(w.pageId, w.alice)

  const refused = propose(w, '会被拒绝的一条')
  const ask1 = await waitPermission(sse, isMemoryAsk)
  expect((await answerPermission(w.pageId, w.alice, ask1, 'reject')).status).toBe(200)
  expect(await result(await refused)).toEqual({ declined: true })

  const stopped = propose(w, '会被停止的一条')
  const ask2 = await waitPermission(sse, (e) => isMemoryAsk(e) && e.requestId !== ask1.requestId)
  expect((await postJson(`/api/pages/${w.pageId}/stop`, w.alice)).status).toBe(200)
  expect(await result(await stopped)).toEqual({ declined: true })
  await sse.wait((e) => e.type === 'permission_resolved' && e.requestId === ask2.requestId)

  const controller = new AbortController()
  const dropped = propose(w, '调用方会断开的一条', { signal: controller.signal }).catch(() => null)
  const ask3 = await waitPermission(sse, (e) => isMemoryAsk(e) && e.requestId !== ask1.requestId && e.requestId !== ask2.requestId)
  controller.abort()
  await dropped
  await sse.wait((e) => e.type === 'permission_resolved' && e.requestId === ask3.requestId)

  expect(await memories(w.spaceId)).toEqual([])
  sse.stop()
})

test('写不进去的在打扰用户之前就回告：空 / 超长 / 空间满都不弹审批；凭证没绑页面不能提议', async () => {
  const w = await world()
  const sse = new SSECollector()
  await sse.start(w.pageId, w.alice)

  const empty = await propose(w, '   ')
  expect(empty.status).toBe(400)
  const tooLong = await propose(w, '长'.repeat(2001))
  expect(tooLong.status).toBe(413)
  expect((await result(tooLong)).error).toEqual(expect.stringContaining('2000'))

  await pool.query('INSERT INTO space_memories (id, space_id, text) VALUES ($1, $2, $3)', ['seed', w.spaceId, '字'.repeat(29995)])
  const full = await propose(w, '再来一条放不下的')
  expect(full.status).toBe(413)
  expect((await result(full)).error).toEqual(expect.stringContaining('30000'))

  const unbound = await propose(w, '没地方弹确认', { pageId: null })
  expect(unbound.status).toBe(403)

  await new Promise((r) => setTimeout(r, 300))
  expect(sse.events.filter((e) => e.type === 'permission')).toEqual([])
  expect(await memories(w.spaceId)).toHaveLength(1) // 只有预置的那条
  sse.stop()
})

test('只有能答这张审批的人能点「记住」：只读成员答不了（审批仍在）；收件箱里能写的成员看得到，只读与外人看不到', async () => {
  const w = await world()
  await insertUser('dave')
  const dave = await login('dave')
  const sse = new SSECollector()
  await sse.start(w.pageId, w.alice)
  const pending = propose(w, '只有写得了的人能确认')
  const ask = await waitPermission(sse, isMemoryAsk)

  expect((await answerPermission(w.pageId, w.carol, ask, 'allow')).ok).toBe(false)
  expect((await answerPermission(w.pageId, dave, ask, 'allow')).ok).toBe(false)
  expect(await memories(w.spaceId)).toEqual([])

  for (const cookie of [w.alice, w.bob]) {
    const items = (await inbox(cookie)).filter((i): i is Extract<InboxItem, { type: 'approval' }> => i.type === 'approval')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ pageId: w.pageId, requestId: ask.requestId, title: expect.stringContaining('记住这条？') })
    expect(items[0]!.options.map((o) => o.name)).toEqual(['记住', '不用'])
    expect(items[0]!.detail.description).toBe('只有写得了的人能确认')
  }
  expect((await inbox(w.carol)).filter((i) => i.type === 'approval')).toEqual([])
  expect((await inbox(dave)).filter((i) => i.type === 'approval')).toEqual([])

  // 在收件箱里点「记住」调的就是同一个接口
  expect((await answerPermission(w.pageId, w.bob, ask, 'allow')).status).toBe(200)
  expect(await result(await pending)).toMatchObject({ ok: true })
  expect((await memories(w.spaceId)).map((m) => m.created_by)).toEqual([w.id.bob])
  sse.stop()
})

test('确认的时候空间已经被别人记满了：不写，回告 agent 原因', async () => {
  const w = await world()
  const sse = new SSECollector()
  await sse.start(w.pageId, w.alice)
  const pending = propose(w, '提议时放得下、确认时放不下')
  const ask = await waitPermission(sse, isMemoryAsk)
  await pool.query('INSERT INTO space_memories (id, space_id, text) VALUES ($1, $2, $3)', ['filler', w.spaceId, '字'.repeat(29995)])
  expect((await answerPermission(w.pageId, w.alice, ask, 'allow')).status).toBe(200)
  expect((await result(await pending)).error).toEqual(expect.stringContaining('30000'))
  expect(await memories(w.spaceId)).toHaveLength(1)
  sse.stop()
})

test('工具清单：凭证绑了页面才有 propose_memory；MCP 进程里真调一次，用户点「记住」后 agent 看到「已记入」', async () => {
  const w = await world()
  const bound = mintPageToken(w.id.alice, 'fake', { pageId: w.pageId, agentId: 'fake' })
  const listed = await (await fetch(`${base}/api/ramet/tools`, { headers: { authorization: `Bearer ${bound}` } })).json() as { tools: string[] }
  expect(listed.tools).toContain('propose_memory')
  const unbound = mintPageToken(w.id.alice, 'fake')
  expect(((await (await fetch(`${base}/api/ramet/tools`, { headers: { authorization: `Bearer ${unbound}` } })).json()) as { tools: string[] }).tools).not.toContain('propose_memory')

  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [RAMET_MCP], env: { RAMET_PAGE_URL: base, RAMET_PAGE_TOKEN: bound }, stderr: 'inherit' }))
  const tool = (await client.listTools()).tools.find((t) => t.name === 'propose_memory')
  expect(tool?.inputSchema).toMatchObject({ type: 'object', required: ['text'] })
  expect(tool?.description).toContain('提议')

  const sse = new SSECollector()
  await sse.start(w.pageId, w.alice)
  const called = client.callTool({ name: 'propose_memory', arguments: { text: '提交信息用中文' } })
  const ask = await waitPermission(sse, isMemoryAsk)
  expect((await answerPermission(w.pageId, w.alice, ask, 'allow')).status).toBe(200)
  const text = ((await called).content as Array<{ text: string }>)[0]!.text
  expect(text).toContain('已记入')
  expect((await memories(w.spaceId)).map((m) => m.text)).toEqual(['提交信息用中文'])

  const second = client.callTool({ name: 'propose_memory', arguments: { text: '另一条' } })
  const ask2 = await waitPermission(sse, (e) => isMemoryAsk(e) && e.requestId !== ask.requestId)
  expect((await answerPermission(w.pageId, w.alice, ask2, 'reject')).status).toBe(200)
  const refused = ((await second).content as Array<{ text: string }>)[0]!.text
  expect(refused).toContain('没有同意')
  expect(await memories(w.spaceId)).toHaveLength(1)

  const tooLong = (await client.callTool({ name: 'propose_memory', arguments: { text: '长'.repeat(2001) } })) as { isError?: boolean; content: Array<{ text: string }> }
  expect(tooLong.isError).toBe(true)
  expect(tooLong.content[0]!.text).toContain('2000')
  await client.close()
  sse.stop()
})

// ---------- 二、注入 + 三、hash ----------

/** 跑一轮「回显提示词」并拿回 agent 收到的内容（第 n 条回复的文字） */
async function echo(sse: SSECollector, p: HocuspocusProvider, w: World, n: number, message: string): Promise<string> {
  userMessage(p.document, `回显提示词 ${message}`)
  expect(await continuePage(w.pageId, w.alice, { agent: 'fake' })).toBe(202)
  await settled(sse, n)
  await waitFor(() => replyBlocks(p)[n - 1]?.outcome === 'end')
  return replyBlocks(p)[n - 1]!.text
}

const savedHash = async (pageId: string): Promise<string | null | undefined> => (await agentSession(pageId))?.fake?.lastSyncedHash
const savedSession = async (pageId: string): Promise<string | undefined> => (await agentSession(pageId))?.fake?.sessionId

test('没有记忆：提示词里没有这一段，收尾 hash 就是对文档视图的 sha256（与引入记忆之前逐字节一致），下一轮照常原生续聊', async () => {
  const w = await world()
  const sse = new SSECollector()
  await sse.start(w.pageId, w.alice)
  const p = await connectDoc(w.pageId, w.alice)

  const first = await echo(sse, p, w, 1, '第一问')
  expect(first).not.toContain('公共记忆')
  const session = await savedSession(w.pageId)
  await waitFor(async () => (await savedHash(w.pageId)) === sha(docText(p)))

  const second = await echo(sse, p, w, 2, '第二问')
  expect(second).not.toContain('公共记忆')
  expect(second).not.toContain('第一问') // 增量：只发了最后一问
  expect(await savedSession(w.pageId)).toBe(session)
  sse.stop()
  p.destroy()
})

test('有记忆：全文重放时全部记忆在文档前面；hash 把记忆算进去；没变就原生续聊（不再重复发）；加一条 / 删光后下一轮全文重放', async () => {
  const w = await world()
  await addMemory(pool, w.spaceId, '部署只用 scripts/deploy.sh', w.id.alice, null)
  await addMemory(pool, w.spaceId, '注释与提交信息用中文\n界面文案进 COPY', w.id.bob, null)
  const sse = new SSECollector()
  await sse.start(w.pageId, w.alice)
  const p = await connectDoc(w.pageId, w.alice)
  const block1 = memoryBlock([{ text: '部署只用 scripts/deploy.sh' }, { text: '注释与提交信息用中文\n界面文案进 COPY' }])

  // 第一轮：全文重放，记忆在最前面、文档在后面
  const first = await echo(sse, p, w, 1, '第一问')
  expect(first.startsWith(block1)).toBe(true)
  expect(first.indexOf('公共记忆')).toBeLessThan(first.indexOf('>> 回显提示词 第一问'))
  const session1 = await savedSession(w.pageId)
  await waitFor(async () => (await savedHash(w.pageId)) === promptHash(block1, docText(p)))
  expect(await savedHash(w.pageId)).not.toBe(sha(docText(p))) // 记忆算进了 hash

  // 第二轮：记忆没变 → 原生续聊，只发新消息（记忆已在会话里，不再重复）
  const second = await echo(sse, p, w, 2, '第二问')
  expect(second).not.toContain('公共记忆')
  expect(second).toBe('回显提示词 第二问')
  expect(await savedSession(w.pageId)).toBe(session1)
  await waitFor(async () => (await savedHash(w.pageId)) === promptHash(block1, docText(p)))

  // 第三轮：加了一条 → hash 不等 → 新建会话全文重放，带上新记忆
  await addMemory(pool, w.spaceId, '测试库叫 ramet_test', w.id.alice, null)
  const block2 = memoryBlock([{ text: '部署只用 scripts/deploy.sh' }, { text: '注释与提交信息用中文\n界面文案进 COPY' }, { text: '测试库叫 ramet_test' }])
  const third = await echo(sse, p, w, 3, '第三问')
  expect(third.startsWith(block2)).toBe(true)
  expect(third).toContain('测试库叫 ramet_test')
  const session3 = await savedSession(w.pageId)
  expect(session3).not.toBe(session1)
  await waitFor(async () => (await savedHash(w.pageId)) === promptHash(block2, docText(p)))

  // 第四轮：记忆没变 → 又回到原生续聊（起止 hash 同口径，收尾那份记忆就是开头那份）
  const fourth = await echo(sse, p, w, 4, '第四问')
  expect(fourth).toBe('回显提示词 第四问')
  expect(await savedSession(w.pageId)).toBe(session3)

  // 第五轮：删光 → 新建会话全文重放，不再带记忆，hash 回到没有记忆时的算法
  await pool.query('DELETE FROM space_memories WHERE space_id = $1', [w.spaceId])
  const fifth = await echo(sse, p, w, 5, '第五问')
  expect(fifth.startsWith('这个空间的公共记忆')).toBe(false)
  expect(await savedSession(w.pageId)).not.toBe(session3)
  await waitFor(async () => (await savedHash(w.pageId)) === sha(docText(p)))
  sse.stop()
  p.destroy()
})

test('记忆是这个空间的：别的空间的页面不带它；重新生成（全文重放）同样带上记忆', async () => {
  const w = await world()
  await addMemory(pool, w.spaceId, '只属于这个空间', w.id.alice, null)
  // 同一个人在另一个空间的页面
  const other = ((await (await postJson('/api/spaces', w.alice, { name: '别的空间' })).json()) as { id: string }).id
  const otherPage = ((await (await postJson('/api/pages', w.alice, { space_id: other })).json()) as { id: string }).id

  const sse = new SSECollector()
  await sse.start(otherPage, w.alice)
  const p2 = await connectDoc(otherPage, w.alice)
  userMessage(p2.document, '回显提示词 别处')
  expect(await continuePage(otherPage, w.alice, { agent: 'fake' })).toBe(202)
  await settled(sse, 1)
  await waitFor(() => replyBlocks(p2)[0]?.outcome === 'end')
  expect(replyBlocks(p2)[0]!.text).not.toContain('只属于这个空间')
  sse.stop()
  p2.destroy()

  const sse1 = new SSECollector()
  await sse1.start(w.pageId, w.alice)
  const p = await connectDoc(w.pageId, w.alice)
  const first = await echo(sse1, p, w, 1, '这里')
  expect(first).toContain('只属于这个空间')
  const replyId = replyBlocks(p)[0]!.id
  // 重新生成一律新建会话全文重放：中间新增的记忆也在新回答里（旧回答里没有它，证明是重跑出来的）
  await addMemory(pool, w.spaceId, '重做之前才加的一条', w.id.alice, null)
  expect((await postJson(`/api/pages/${w.pageId}/replies/${replyId}/regenerate`, w.alice)).status).toBe(202)
  await settled(sse1, 2)
  await waitFor(() => replyBlocks(p)[0]?.outcome === 'end' && replyBlocks(p)[0]?.text.includes('重做之前才加的一条') === true)
  expect(replyBlocks(p)[0]!.text.startsWith('这个空间的公共记忆')).toBe(true)
  sse1.stop()
  p.destroy()
})

test('run_agent 的被叫 agent 是全新会话，同样带上这个空间的记忆（没有记忆时任务原样）', async () => {
  const w = await world()
  const token = mintPageToken(w.id.alice, 'fake', { pageId: w.pageId, agentId: 'fake', canDispatch: true })
  const run = async (): Promise<{ outcome: string; output: string }> => {
    const res = await fetch(`${base}/api/ramet/run-agent`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'claude', task: '回显提示词 子任务' }),
    })
    expect(res.status).toBe(200)
    return (await result(res)) as { outcome: string; output: string }
  }

  const plain = await run()
  expect(plain.outcome).toBe('end')
  expect(plain.output).not.toContain('公共记忆')
  expect(plain.output).toContain('回显提示词 子任务')

  await addMemory(pool, w.spaceId, '子任务也要遵守的约定', w.id.alice, null)
  const withMemory = await run()
  expect(withMemory.output).toContain('这个空间的公共记忆')
  expect(withMemory.output).toContain('子任务也要遵守的约定')
  expect(withMemory.output.indexOf('子任务也要遵守的约定')).toBeLessThan(withMemory.output.indexOf('回显提示词 子任务'))
})
