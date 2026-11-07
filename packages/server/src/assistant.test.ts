/* ---------- Genet（真库 + test-kit 的完整服务；模型是假的，派活的目标是本机假 agent）----------
 * Genet 页：第一次唤起在个人空间顶层建「Genet」页（不进页面树；早先建在树里的启动时改过来），进回收站后再唤起另建一页，并发只建一页。
 * Genet 只在发起人自己的 Genet 页上能用：别的页面指定它 400，别人的 Genet 页 404；重新生成 / 排队派发在 Genet 页上照常。
 * 一轮：read_page 经 MCP 回打中心 → 回复块、过程页、assistant_sessions；没配模型连接 → 回复块失败条上是引导文案；
 * trash_page 先在 Genet 页上弹审批。派活：dispatch_task 在 Genet 页下建任务页、以用户身份写消息并开跑，不等那一轮跑完；
 * 派不出去不留空页；指定的模型 / 思考程度写成任务页的页面级配置，对不上就派不出去（列出可选值、不留页）。任务状态：running / approval / failed / done / idle，看不到的页不返回。
 * 会话重载：另起一份服务（新的 manager）接着发，历史从库里读回来，只发新消息。 */
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { pagesInPageTree } from '@ramet/shared/page-tree'
import { insertConnection } from './ai-connections.js'
import { loadDocFromDb, writeDocState } from './collab.js'
import { initDb } from './db.js'
import { startServer } from './index.js'
import { mintPageToken } from './page-read.js'
import { parseNew } from './page-write.js'
import { ASSISTANT_ID, NO_TEAM_LEAD } from './agents/assistant-agent.js'
import { NO_CONNECTION } from './agents/drivers/assistant/driver.js'
import { after, brief, callTool, lastResult, say, script as fakeModel, type GenetCall, type Step } from './agents/drivers/assistant/test-model.js'
import { newPageDoc } from './agents/markdown.js'
import {
  assistantModel,
  assistantSecret,
  base,
  connectDoc,
  continuePage,
  insertUser,
  login,
  pool,
  postJson,
  replyAttr,
  replyBlocks,
  settled,
  setupPage,
  SSECollector,
  userMessage,
  waitFor,
  waitPermission,
} from './agents/test-kit.js'
import type { AgentEvent } from './agents/types.js'

/** 把剧本交给 test-kit 起的中心；返回每次请求的快照 */
function script(...steps: Step[]): GenetCall[] {
  const fake = fakeModel(...steps)
  assistantModel.script = fake.stream
  return fake.calls
}

type Home = { cookie: string; userId: string; pageId: string; doc: HocuspocusProvider; sse: SSECollector; turns: number }

async function aliceId(): Promise<string> {
  return (await pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'alice'")).rows[0]!.id
}

async function assistantPage(cookie: string): Promise<string> {
  const res = await postJson('/api/me/assistant', cookie)
  expect(res.status).toBe(200)
  return ((await res.json()) as { pageId: string }).pageId
}

/** alice（admin，能用本机假 agent）+ 模型连接 + Genet 页 + 连着的文档与 SSE */
async function home(opts: { connection?: boolean } = {}): Promise<Home & { otherPage: string }> {
  const { cookie, pageId: otherPage } = await setupPage()
  const userId = await aliceId()
  if (opts.connection !== false) {
    await insertConnection(pool, userId, { name: 'c', protocol: 'anthropic', baseUrl: null, model: 'claude-opus-5-5' }, 'sk-ant-test-secret-9999', assistantSecret)
  }
  const pageId = await assistantPage(cookie)
  const doc = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  return { cookie, userId, pageId, doc, sse, turns: 0, otherPage }
}

function close(h: Home): void {
  h.sse.stop()
  h.doc.destroy()
}

/** 在 Genet 页上发一条消息，跑完这一轮 */
async function ask(h: Home, text: string): Promise<void> {
  userMessage(h.doc.document, text, { agent: ASSISTANT_ID })
  expect(await continuePage(h.pageId, h.cookie, { agent: ASSISTANT_ID })).toBe(202)
  await settled(h.sse, ++h.turns)
}

/** Genet 页下的任务页（doc；过程页也挂在 Genet 页下，是 run） */
async function taskPages(pageId: string): Promise<Array<{ id: string; title: string }>> {
  const { rows } = await pool.query<{ id: string; title: string }>(
    "SELECT id, title FROM live_pages WHERE parent_id = $1 AND kind = 'doc' ORDER BY created_at",
    [pageId],
  )
  return rows
}

type ListedPage = { id: string; parent_id: string | null; in_page_tree: boolean }

async function listPages(cookie: string): Promise<ListedPage[]> {
  return (await (await fetch(`${base}/api/pages`, { headers: { cookie } })).json()) as ListedPage[]
}

async function runStatus(cookie: string, ids: string[]): Promise<Record<string, string>> {
  const res = await fetch(`${base}/api/pages/run-status?ids=${ids.join(',')}`, { headers: { cookie } })
  expect(res.status).toBe(200)
  return ((await res.json()) as { statuses: Record<string, string> }).statuses
}

async function notesPage(cookie: string, text: string): Promise<string> {
  const page = (await (await postJson('/api/pages', cookie, {})).json()) as { id: string }
  await writeDocState(pool, `page:${page.id}`, newPageDoc('读书笔记', parseNew(text)))
  return page.id
}

describe('Genet 页', () => {
  it('第一次唤起建在个人空间顶层，标题「Genet」、来源记成 Genet；再唤起是同一页；进回收站后再唤起另建一页', async () => {
    const { cookie } = await setupPage()
    const userId = await aliceId()
    const first = await assistantPage(cookie)
    const { rows } = await pool.query<{ title: string; parent_id: string | null; choice: string; is_personal: boolean; space_owner: string }>(
      `SELECT p.title, p.parent_id, p.agent_session->>'choice' AS choice, s.is_personal, s.owner_id AS space_owner
         FROM pages p JOIN spaces s ON s.id = p.space_id WHERE p.id = $1`,
      [first],
    )
    expect(rows[0]).toEqual({ title: 'Genet', parent_id: null, choice: ASSISTANT_ID, is_personal: true, space_owner: userId })
    const title = (await loadDocFromDb(pool, `page:${first}`)).getXmlFragment('title').toString()
    expect(title).toContain('Genet')
    expect(await assistantPage(cookie)).toBe(first)
    // 页面列表里有（能打开、能搜），但不进页面树（入口是侧栏的「AI」）
    const listed = await listPages(cookie)
    expect(listed.find((p) => p.id === first)?.in_page_tree).toBe(false)
    expect(pagesInPageTree(listed).some((p) => p.id === first)).toBe(false)

    expect((await postJson(`/api/pages/${first}/trash`, cookie)).status).toBe(200)
    const second = await assistantPage(cookie)
    expect(second).not.toBe(first)
    const trashed = await pool.query('SELECT 1 FROM pages WHERE id = $1 AND deleted_at IS NOT NULL', [first])
    expect(trashed.rowCount).toBe(1)
    expect((await pool.query<{ page_id: string }>('SELECT page_id FROM assistants WHERE user_id = $1', [userId])).rows[0]!.page_id).toBe(second)
  })

  it('并发唤起两次只建一页', async () => {
    await insertUser('carol')
    const cookie = await login('carol')
    const [a, b] = await Promise.all([assistantPage(cookie), assistantPage(cookie)])
    expect(a).toBe(b)
    const userId = (await pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'carol'")).rows[0]!.id
    expect((await pool.query("SELECT 1 FROM pages WHERE owner_id = $1 AND title = 'Genet'", [userId])).rowCount).toBe(1)
  })

  it('早先建在页面树里的 Genet 页：启动时改成不进页面树；重复启动不报错，已改过的不再动', async () => {
    const { cookie, pageId: normal } = await setupPage()
    const first = await assistantPage(cookie)
    await pool.query('UPDATE pages SET in_page_tree = true WHERE id = $1', [first])
    await initDb(pool)
    const inTree = async (id: string): Promise<boolean> =>
      (await pool.query<{ in_page_tree: boolean }>('SELECT in_page_tree FROM pages WHERE id = $1', [id])).rows[0]!.in_page_tree
    expect(await inTree(first)).toBe(false)
    // 别的页不受影响
    expect(await inTree(normal)).toBe(true)
    const before = (await pool.query('SELECT 1 FROM page_changes WHERE page_id = $1', [first])).rowCount
    await initDb(pool)
    expect(await inTree(first)).toBe(false)
    expect((await pool.query('SELECT 1 FROM page_changes WHERE page_id = $1', [first])).rowCount).toBe(before)
  })
})

describe('Genet 只在自己的 Genet 页上能用', () => {
  it('别的页面指定 Genet（请求体 / 消息 chip / 预备会话）400；别人的 Genet 页 404', async () => {
    const h = await home()
    script(say('不该到这里'))
    const other = await connectDoc(h.otherPage, h.cookie)
    userMessage(other.document, '你好', { agent: ASSISTANT_ID })
    expect((await postJson(`/api/pages/${h.otherPage}/continue`, h.cookie, { agent: ASSISTANT_ID })).status).toBe(400)
    expect((await postJson(`/api/pages/${h.otherPage}/agent-prepare`, h.cookie, { agent: ASSISTANT_ID })).status).toBe(400)
    expect((await postJson(`/api/pages/${h.otherPage}/agent-choice`, h.cookie, { agent: ASSISTANT_ID })).status).toBe(400)
    other.destroy()

    await insertUser('bob')
    const bob = await login('bob')
    expect((await postJson(`/api/pages/${h.pageId}/continue`, bob, { agent: ASSISTANT_ID })).status).toBe(404)
    // bob 自己的 Genet 页上，alice 的 Genet 页 id 不是他的 Genet 页：在他看得到的页上指定也不行
    const bobHome = await assistantPage(bob)
    expect(bobHome).not.toBe(h.pageId)
    close(h)
  })

  it('@ 点名 Genet：别的页面上 400；同空间的另一个成员在别人的 Genet 页上也解析不出来（看得到这页，所以是 400 不是 404）', async () => {
    const h = await home()
    const requests = script(say('不该到这里'))
    const other = await connectDoc(h.otherPage, h.cookie)
    mentionAssistant(other.document)
    expect((await postJson(`/api/pages/${h.otherPage}/continue`, h.cookie, {})).status).toBe(400)
    other.destroy()

    const bobId = await insertUser('bob')
    const bob = await login('bob')
    const space = (await pool.query<{ space_id: string }>('SELECT space_id FROM pages WHERE id = $1', [h.pageId])).rows[0]!.space_id
    await pool.query("INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'member')", [space, bobId])
    const bobDoc = await connectDoc(h.pageId, bob)
    mentionAssistant(bobDoc.document)
    expect((await postJson(`/api/pages/${h.pageId}/continue`, bob, {})).status).toBe(400)
    expect((await postJson(`/api/pages/${h.pageId}/continue`, bob, { agent: ASSISTANT_ID })).status).toBe(400)
    expect((await postJson(`/api/pages/${h.pageId}/agent-choice`, bob, { agent: ASSISTANT_ID })).status).toBe(400)
    bobDoc.destroy()
    expect(requests).toHaveLength(0)
    close(h)
  })
})

/** 一条只 @ 了 Genet 的用户消息（段落里 agent_mention 元素，同前端落的形状） */
function mentionAssistant(doc: Y.Doc): void {
  const frag = doc.getXmlFragment('prosemirror')
  const msg = new Y.XmlElement('user_message')
  const p = new Y.XmlElement('paragraph')
  msg.insert(0, [p])
  frag.insert(frag.length, [msg])
  const m = new Y.XmlElement('agent_mention')
  m.setAttribute('agentId', ASSISTANT_ID)
  m.setAttribute('label', 'Genet')
  const t = new Y.XmlText()
  p.insert(0, [m, t])
  t.insert(0, ' 你好')
}

describe('Genet 的一轮', () => {
  it('read_page 经 MCP 回打中心 → 回复块（agent = Genet）、过程页里有这一步、会话落库', async () => {
    const h = await home()
    const notes = await notesPage(h.cookie, '第一行正文\n\n第二段')
    const requests = script(callTool('toolu_1', 'read_page', { pageId: notes }), say((req) => `总结：${lastResult(req).includes('第一行正文') ? '读到了' : '没读到'}`))
    await ask(h, `总结一下 page:${notes}`)
    await waitFor(() => replyBlocks(h.doc)[0]?.outcome === 'end')
    expect(replyBlocks(h.doc)[0]!.text).toContain('总结：读到了')
    expect(h.doc.document.getXmlFragment('prosemirror').toArray().some((n) => n instanceof Y.XmlElement && n.nodeName === 'agent_reply' && n.getAttribute('agent') === ASSISTANT_ID)).toBe(true)
    // 全文重放里带着这条消息
    expect(JSON.stringify(requests[0]!.messages)).toContain(`总结一下 page:${notes}`)
    const runId = replyAttr(h.doc, 'run')!
    const run = (await pool.query<{ record: { entries: Array<{ k: string; id?: string; kind?: string }> } }>('SELECT record FROM runs WHERE page_id = $1', [runId])).rows[0]!
    expect(run.record.entries.some((e) => e.k === 'tool' && e.id === 'toolu_1' && e.kind === 'read')).toBe(true)
    expect((await pool.query('SELECT parent_id FROM pages WHERE id = $1', [runId])).rows[0]).toEqual({ parent_id: h.pageId })
    const sessions = await pool.query<{ messages: unknown[] }>('SELECT messages FROM assistant_sessions WHERE user_id = $1', [h.userId])
    expect(sessions.rowCount).toBe(1)
    expect(sessions.rows[0]!.messages).toHaveLength(4)
    close(h)
  })

  it('没配模型连接：回复块以失败收尾，失败条上是去配置的引导；配好以后点重试（续跑）就能用，原来的问题还在会话里', async () => {
    const h = await home({ connection: false })
    const requests = script(say('在的'))
    await ask(h, '在吗')
    const err = (await h.sse.wait((e) => e.type === 'error')) as Extract<AgentEvent, { type: 'error' }>
    expect(err.message).toBe(NO_CONNECTION)
    const replyId = replyBlocks(h.doc)[0]!.id
    expect(err.replyId).toBe(replyId)
    await waitFor(() => replyBlocks(h.doc)[0]?.outcome === 'error')
    expect(requests).toHaveLength(0)

    await insertConnection(pool, h.userId, { name: 'c', protocol: 'anthropic', baseUrl: null, model: 'claude-opus-5-5' }, 'sk-ant-test-secret-9999', assistantSecret)
    expect((await postJson(`/api/pages/${h.pageId}/replies/${replyId}/resume`, h.cookie)).status).toBe(202)
    await settled(h.sse, 2)
    await waitFor(() => replyBlocks(h.doc)[0]?.outcome === 'end')
    expect(replyBlocks(h.doc)).toHaveLength(1)
    expect(replyBlocks(h.doc)[0]!.text).toContain('在的')
    const sent = JSON.stringify(requests[0]!.messages)
    expect(sent).toContain('在吗')
    expect(sent).toContain('[Ramet 续跑]')
    close(h)
  })

  it('移入回收站先在 Genet 页上弹审批（agentId = Genet），批了才执行', async () => {
    const h = await home()
    const notes = await notesPage(h.cookie, '要删的')
    script(callTool('toolu_t', 'trash_page', { pageId: notes }), say((req) => (lastResult(req).includes('移入回收站') ? '删好了' : `没删：${lastResult(req)}`)))
    userMessage(h.doc.document, '把读书笔记删了', { agent: ASSISTANT_ID })
    expect(await continuePage(h.pageId, h.cookie, { agent: ASSISTANT_ID })).toBe(202)
    const perm = await waitPermission(h.sse)
    expect(perm.agentId).toBe(ASSISTANT_ID)
    expect((await pool.query('SELECT 1 FROM live_pages WHERE id = $1', [notes])).rowCount).toBe(1)
    // 收件箱：Genet 的审批是 Ramet 自己的审批，页面主人看得到（不判机器使用权）；名字与在跑的那一条都是「Genet」，不是原始 id
    const inbox = (await (await fetch(`${base}/api/inbox`, { headers: { cookie: h.cookie } })).json()) as {
      items: Array<{ type: string; agentId?: string; agentName?: string; requestId?: string }>
    }
    expect(inbox.items.find((i) => i.type === 'approval')).toMatchObject({ agentId: ASSISTANT_ID, agentName: 'Genet', requestId: perm.requestId })
    expect(inbox.items.find((i) => i.type === 'running')).toMatchObject({ agentId: ASSISTANT_ID, agentName: 'Genet' })
    const res = await postJson(`/api/pages/${h.pageId}/permission`, h.cookie, { agentId: ASSISTANT_ID, requestId: perm.requestId, optionId: 'allow' })
    expect(res.status).toBe(200)
    await settled(h.sse, 1)
    await waitFor(() => replyBlocks(h.doc)[0]?.outcome === 'end')
    expect(replyBlocks(h.doc)[0]!.text).toContain('删好了')
    expect((await pool.query('SELECT 1 FROM live_pages WHERE id = $1', [notes])).rowCount).toBe(0)
    close(h)
  })

  it('Genet 不能带队：/带队 在 Genet 页上被拒，原因挂在那块回复上，模型一次都没被调用、没有出计划', async () => {
    const h = await home()
    const requests = script(say('不该到这里'))
    await ask(h, '/带队 把登录页重构一下')
    const err = (await h.sse.wait((e) => e.type === 'error')) as Extract<AgentEvent, { type: 'error' }>
    expect(err.message).toBe(NO_TEAM_LEAD)
    await waitFor(() => replyBlocks(h.doc)[0]?.outcome === 'error')
    expect(err.replyId).toBe(replyBlocks(h.doc)[0]!.id)
    expect(requests).toHaveLength(0)
    expect((await pool.query('SELECT 1 FROM team_plans WHERE page_id = $1', [h.pageId])).rowCount).toBe(0)
    close(h)
  })

  it('重新生成 Genet 的回复：照常在 Genet 页上跑（新建会话、只看目标之前）', async () => {
    const h = await home()
    script(say('第一版'), say('第二版'))
    await ask(h, '写一句')
    await waitFor(() => replyBlocks(h.doc)[0]?.outcome === 'end')
    const replyId = replyBlocks(h.doc)[0]!.id
    expect((await postJson(`/api/pages/${h.pageId}/replies/${replyId}/regenerate`, h.cookie)).status).toBe(202)
    await settled(h.sse, 2)
    await waitFor(() => replyBlocks(h.doc)[0]?.text.includes('第二版') === true)
    close(h)
  })

  it('运行中排队：排着的消息在这一轮结束后派发给 Genet（不因为「Genet 不在目录里」被丢掉）', async () => {
    const h = await home()
    const gate = Promise.withResolvers<void>()
    const requests = script(after(gate.promise, say('第一答')), say('第二答'))
    userMessage(h.doc.document, '第一问', { agent: ASSISTANT_ID })
    expect(await continuePage(h.pageId, h.cookie, { agent: ASSISTANT_ID })).toBe(202)
    await waitFor(() => requests.length === 1)
    expect((await postJson(`/api/pages/${h.pageId}/queue`, h.cookie, { agent: ASSISTANT_ID, kind: 'message', text: '第二问' })).status).toBe(201)
    gate.resolve()
    await settled(h.sse, 2)
    expect(h.sse.events.some((e) => e.type === 'queue_dropped')).toBe(false)
    expect(JSON.stringify(requests[1]!.messages.at(-1))).toContain('第二问')
    close(h)
  })
})

describe('输入框旁的供应商 / 思考程度', () => {
  it('预备会话就推出两项；改思考程度落成 Genet 页的页面级配置，下一轮按它问模型；值不在选项里 400', async () => {
    const h = await home()
    expect((await postJson(`/api/pages/${h.pageId}/agent-prepare`, h.cookie, { agent: ASSISTANT_ID })).status).toBe(202)
    const cfg = (await h.sse.wait((e) => e.type === 'config' && e.agentId === ASSISTANT_ID && e.options.length > 0)) as Extract<AgentEvent, { type: 'config' }>
    expect(cfg.options.map((o) => [o.id, o.category, o.currentValue])).toEqual([
      ['provider', 'model', expect.any(String)],
      ['effort', 'thought_level', 'low'],
    ])
    const set = (value: string) => postJson(`/api/pages/${h.pageId}/agent-config`, h.cookie, { agent: ASSISTANT_ID, configId: 'effort', value })
    expect((await set('xhigh')).status).toBe(200)
    expect((await set('ultra')).status).toBe(400)
    const { rows } = await pool.query<{ configs: Record<string, string> | null }>('SELECT agent_session->\'configs\'->$2 AS configs FROM pages WHERE id = $1', [h.pageId, ASSISTANT_ID])
    expect(rows[0]!.configs).toMatchObject({ effort: 'xhigh' })
    const requests = script(say('好'))
    await ask(h, '想深一点')
    expect(requests[0]).toMatchObject({ model: 'claude-opus-5-5', thinking: { effort: 'xhigh' }, maxTokens: 64000 })
    close(h)
  })
})

describe('派活：dispatch_task', () => {
  it('Genet 页下建任务页、以用户身份写任务并开跑，不等那一轮跑完；回复里是任务页的链接；工具表里没有 run_agent', async () => {
    const h = await home()
    const requests = script(
      callTool('toolu_d', 'dispatch_task', { agent: 'fake', title: '修一下登录', task: '断线续 修一下登录页' }),
      say((req) => `派好了：${/\[@[^\]]*\]\(page:[^)]+\)/.exec(lastResult(req))?.[0] ?? '没有链接'}`),
    )
    await ask(h, '让 Fake 修一下登录')
    const tools = requests[0]!.tools
    const dispatch = tools.find((t) => t.name === 'dispatch_task')!
    expect(tools.some((t) => t.name === 'run_agent')).toBe(false)
    expect((dispatch.parameters as { properties: { agent: { enum: string[] } } }).properties.agent.enum.sort()).toEqual(['claude', 'fake'])

    const [task] = await taskPages(h.pageId)
    expect(task?.title).toBe('修一下登录')
    // 任务页跟着 Genet 页一起不在页面树里，照常在页面列表里
    const listed = await listPages(h.cookie)
    expect(listed.some((p) => p.id === task!.id)).toBe(true)
    expect(pagesInPageTree(listed).some((p) => p.id === task!.id || p.id === h.pageId)).toBe(false)
    // Genet 这一轮已经收尾，任务页上那一轮（断线续：要跑 8 秒）还在跑
    expect((await runStatus(h.cookie, [task!.id]))[task!.id]).toBe('running')
    await waitFor(() => replyBlocks(h.doc)[0]?.outcome === 'end')
    expect(lastResult(requests[1]!)).toContain(`[@修一下登录](page:${task!.id})`)
    // 回复落块时任务链接就是页面提及（@ramet/shared/markdown-blocks），不是带链接的文字
    expect(replyBlocks(h.doc)[0]!.text).toContain(`派好了：page:${task!.id}`)
    const reply = h.doc.document.getXmlFragment('prosemirror').toArray().find((n) => n instanceof Y.XmlElement && n.nodeName === 'agent_reply') as Y.XmlElement
    const chip = (reply.get(0) as Y.XmlElement).toArray().find((n) => n instanceof Y.XmlElement && n.nodeName === 'page_mention') as Y.XmlElement | undefined
    expect(chip?.getAttribute('pageId')).toBe(task!.id)
    expect(chip?.getAttribute('title')).toBe('修一下登录')

    const taskDoc = await connectDoc(task!.id, h.cookie)
    const msg = taskDoc.document.getXmlFragment('prosemirror').toArray().find((n) => n instanceof Y.XmlElement && n.nodeName === 'user_message') as Y.XmlElement
    expect(msg.getAttribute('author')).toBe(h.userId)
    expect(msg.getAttribute('agent')).toBe('fake')
    expect(msg.toString()).toContain('断线续 修一下登录页')
    expect((await pool.query<{ choice: string }>("SELECT agent_session->>'choice' AS choice FROM pages WHERE id = $1", [task!.id])).rows[0]!.choice).toBe('fake')
    expect((await postJson(`/api/pages/${task!.id}/stop`, h.cookie)).status).toBe(200)
    await waitFor(async () => (await runStatus(h.cookie, [task!.id]))[task!.id] === 'failed')
    taskDoc.destroy()
    close(h)
  })

  it('派给不存在的 agent：工具参数校验当场拦下、列出能派的 agent，不建空的任务页（不在线的 agent 在可选值里，原因由中心给）', async () => {
    const h = await home()
    const requests = script(callTool('toolu_x', 'dispatch_task', { agent: 'c:00000000-0000-0000-0000-000000000000:claude', title: '没人接', task: '随便' }), say('派不出去'))
    await ask(h, '派个活')
    const result = requests[1]!.messages.at(-1)
    expect(result).toMatchObject({ role: 'toolResult', isError: true })
    expect(lastResult(requests[1]!)).toContain('expected one of ["fake","claude"]')
    expect(await taskPages(h.pageId)).toEqual([])
    close(h)
  })

  it('指定模型 / 思考程度：写成任务页的页面级配置再开跑，那一轮跑在指定的模型上；工具结果里写着用了什么', async () => {
    const h = await home()
    const requests = script(
      callTool('toolu_c', 'dispatch_task', { agent: 'fake', title: '换个模型', task: '审批模式', model: 'm2', effort: 'medium' }),
      say('派好了'),
    )
    await ask(h, '用 M2 派个活')
    expect(lastResult(requests[1]!)).toContain('已派给 Fake（模型 M2 · 推理强度 中）')
    const [task] = await taskPages(h.pageId)
    const { rows } = await pool.query<{ configs: Record<string, string> | null }>("SELECT agent_session->'configs'->'fake' AS configs FROM pages WHERE id = $1", [task!.id])
    expect(rows[0]!.configs).toMatchObject({ model: 'm2', effort: 'medium' })
    // 假 agent 回显这一轮实际用的模型
    const taskDoc = await connectDoc(task!.id, h.cookie)
    await waitFor(() => replyBlocks(taskDoc)[0]?.outcome === 'end')
    expect(replyBlocks(taskDoc)[0]!.text).toContain('model:m2')
    taskDoc.destroy()
    close(h)
  })

  it('模型 / 思考程度对不上：派不出去，原因里列出可选值，不留任务页；思考程度按换完模型之后的选项对', async () => {
    const h = await home()
    const requests = script(
      callTool('toolu_m', 'dispatch_task', { agent: 'fake', title: '没这个模型', task: '随便', model: 'gpt-9' }),
      callTool('toolu_e', 'dispatch_task', { agent: 'fake', title: 'M2 没有高档', task: '随便', model: 'm2', effort: 'high' }),
      say('派不出去'),
    )
    await ask(h, '派两个活')
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: 'toolResult', isError: true })
    expect(lastResult(requests[1]!)).toContain('派不出去')
    expect(lastResult(requests[1]!)).toContain('m1（M1）、m2（M2）')
    // 默认的 m1 有 high、m2 只有 medium：先换模型再对思考程度才会被拒
    expect(requests[2]!.messages.at(-1)).toMatchObject({ role: 'toolResult', isError: true })
    expect(lastResult(requests[2]!)).toContain('可选：medium（中）')
    expect(await taskPages(h.pageId)).toEqual([])
    close(h)
  })

  it('端点只认 Genet 页上的 Genet 凭证；Genet 凭证叫不了 run_agent', async () => {
    const h = await home()
    const post = (path: string, token: string, body: unknown) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const task = { agent: 'fake', title: 't', task: 'x' }
    const otherAgent = mintPageToken(h.userId, 'fake', { pageId: h.pageId, agentId: 'fake', canDispatch: true })
    expect((await post('/api/ramet/dispatch', otherAgent, task)).status).toBe(403)
    const offPage = mintPageToken(h.userId, ASSISTANT_ID, { pageId: h.otherPage, agentId: ASSISTANT_ID, canDispatch: true })
    expect((await post('/api/ramet/dispatch', offPage, task)).status).toBe(403)
    const mine = mintPageToken(h.userId, ASSISTANT_ID, { pageId: h.pageId, agentId: ASSISTANT_ID, canDispatch: true })
    expect((await post('/api/ramet/run-agent', mine, { agent: 'fake', task: 'x' })).status).toBe(403)
    const listed = (await (await fetch(`${base}/api/ramet/tools`, { headers: { authorization: `Bearer ${mine}` } })).json()) as { tools: string[]; agents: Array<{ id: string }> }
    expect(listed.tools).toContain('dispatch_task')
    expect(listed.tools).not.toContain('run_agent')
    expect(listed.agents.map((a) => a.id)).not.toContain(ASSISTANT_ID)
    expect(await taskPages(h.pageId)).toEqual([])
    close(h)
  })
})

describe('任务状态 GET /api/pages/run-status', () => {
  it('running / approval / failed / done / idle；看不到的页、不存在的页不返回；超过 50 个 400', async () => {
    const { cookie } = await setupPage()
    const page = async () => ((await (await postJson('/api/pages', cookie, {})).json()) as { id: string }).id
    const run = async (text: string): Promise<{ id: string; sse: SSECollector; doc: HocuspocusProvider }> => {
      const id = await page()
      const doc = await connectDoc(id, cookie)
      const sse = new SSECollector()
      await sse.start(id, cookie)
      userMessage(doc.document, text, { agent: 'fake' })
      expect(await continuePage(id, cookie, { agent: 'fake' })).toBe(202)
      return { id, sse, doc }
    }
    const idle = await page()
    const done = await run('普通一问')
    const failed = await run('失败')
    await settled(done.sse, 1)
    await settled(failed.sse, 1)
    const running = await run('断线续')
    await running.sse.wait((e) => e.type === 'status' && e.state === 'running')
    const approval = await run('需要权限')
    await waitPermission(approval.sse)

    await insertUser('bob')
    const bob = await login('bob')
    const hidden = ((await (await postJson('/api/pages', bob, {})).json()) as { id: string }).id

    const statuses = await runStatus(cookie, [idle, done.id, failed.id, running.id, approval.id, hidden, 'no-such-page'])
    expect(statuses).toEqual({ [idle]: 'idle', [done.id]: 'done', [failed.id]: 'failed', [running.id]: 'running', [approval.id]: 'approval' })
    const tooMany = await fetch(`${base}/api/pages/run-status?ids=${Array.from({ length: 51 }, (_, i) => `p${i}`).join(',')}`, { headers: { cookie } })
    expect(tooMany.status).toBe(400)

    for (const r of [running, approval]) await postJson(`/api/pages/${r.id}/stop`, cookie)
    await settled(running.sse, 1)
    await settled(approval.sse, 1)
    for (const r of [done, failed, running, approval]) {
      r.sse.stop()
      r.doc.destroy()
    }
  })
})

describe('会话重载', () => {
  it('另起一份服务（新的 manager）接着发：历史从库里读回来，只发新消息', async () => {
    const h = await home()
    const requests = script(say('第一答'), say('第二答'))
    await ask(h, '第一问')
    await waitFor(() => replyBlocks(h.doc)[0]?.outcome === 'end')
    close(h)

    const revived = await startServer(pool, 0, { preview: null, assistant: { stream: (conn, model, context, req) => assistantModel.script!(conn, model, context, req), secretKey: assistantSecret, catalog: null } })
    const doc = await connectDoc(h.pageId, h.cookie, revived.port)
    try {
      userMessage(doc.document, '第二问', { agent: ASSISTANT_ID })
      const res = await fetch(`http://127.0.0.1:${revived.port}/api/pages/${h.pageId}/continue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: h.cookie },
        body: JSON.stringify({ agent: ASSISTANT_ID }),
      })
      expect(res.status).toBe(202)
      await waitFor(() => replyBlocks(doc)[1]?.outcome === 'end', 20_000)
      const second = requests[1]!.messages
      expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
      expect(brief(second[0]!).text).toContain('>> 第一问')
      expect(brief(second[1]!)).toEqual({ role: 'assistant', text: '第一答' })
      // 接着用原会话：只发新消息（与全文重放不同，不带 >> 记号和之前的内容）
      expect(brief(second[2]!)).toEqual({ role: 'user', text: '第二问' })
      expect((await pool.query('SELECT 1 FROM assistant_sessions WHERE user_id = $1', [h.userId])).rowCount).toBe(1)
    } finally {
      // 连着的客户端先断开，不然关服务时它会一直重连
      doc.destroy()
      await revived.close()
    }
  })
})
