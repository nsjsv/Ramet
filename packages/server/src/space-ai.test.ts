/* ---------- 空间 AI（真库 + test-kit 的完整服务；模型是假的）----------
 * 配置：成员看得到启用没有和名字、owner 另看得到连接；只有 owner 能改、只能选自己的连接、名字 1–20 字；个人空间 / 非成员 404；
 *   空间列表带 ai；owner 删了连接就停用。
 * >> 里 @AI：团队空间的成员叫它，用的是 owner 的连接与空间 AI 的提示词，每条消息带署名、工具里没有派活 / 叫人 / 定时器；
 *   另一个成员接着说是同一个会话，之后的工具以他的身份执行；没启用 / 个人空间 / 连接没了 = 未知 agent，viewer 叫不动。
 * 凭证范围：读写只限这个空间（别的空间的页即使叫它的人是成员也 404），搜索只出本空间，派活 / 叫人 / 定时器 / 盯页面 /
 *   代发评论等白名单外的端点 403；只读凭证改不了页面；移入回收站的审批只给叫它的人批。显示名按页面空间取。 */
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { deleteConnection, insertConnection } from './ai-connections.js'
import { writeDocState } from './collab.js'
import { mintPageToken } from './page-read.js'
import { parseNew } from './page-write.js'
import { agentNames } from './agents/agent-names.js'
import { callTool, lastResult, say, script as fakeModel, type GenetCall, type Step } from './agents/drivers/assistant/test-model.js'
import { newPageDoc } from './agents/markdown.js'
import { resolveSpaceAi, SPACE_AI_ID, spaceTools } from './agents/space-ai.js'
import {
  agentSession,
  assistantModel,
  assistantSecret,
  base,
  connectDoc,
  continuePage,
  insertUser,
  login,
  pool,
  postJson,
  replyAgent,
  serverReplies,
  settled,
  setupPage,
  SSECollector,
  waitPermission,
  answerPermission,
} from './agents/test-kit.js'

const ALICE_KEY = 'sk-ant-test-alice-1111'
const BOB_KEY = 'sk-ant-test-bob-2222'

function script(...steps: Step[]): GenetCall[] {
  const fake = fakeModel(...steps)
  assistantModel.script = fake.stream
  return fake.calls
}

function putJson(path: string, cookie: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })
}

async function getJson<T>(path: string, cookie: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, { headers: { cookie } })
  return { status: res.status, body: (await res.json()) as T }
}

async function idOf(username: string): Promise<string> {
  return (await pool.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [username])).rows[0]!.id
}

async function spaceOf(pageId: string): Promise<string> {
  return (await pool.query<{ space_id: string }>('SELECT space_id FROM pages WHERE id = $1', [pageId])).rows[0]!.space_id
}

async function join(spaceId: string, username: string, role: 'member' | 'viewer' = 'member'): Promise<{ id: string; cookie: string }> {
  const existing = (await pool.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [username])).rows[0]?.id
  const id = existing ?? (await insertUser(username))
  await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [spaceId, id, role])
  return { id, cookie: await login(username) }
}

/** 用户消息（带作者，同前端写入的形状）；mention = 文字前面 @ 一个 agent */
function message(doc: Y.Doc, author: string, text: string, opts: { mention?: string; agent?: string } = {}): void {
  const frag = doc.getXmlFragment('prosemirror')
  const msg = new Y.XmlElement('user_message')
  msg.setAttribute('author', author)
  if (opts.agent) msg.setAttribute('agent', opts.agent)
  const p = new Y.XmlElement('paragraph')
  msg.insert(0, [p])
  frag.insert(frag.length, [msg])
  if (opts.mention) {
    const m = new Y.XmlElement('agent_mention')
    m.setAttribute('agentId', opts.mention)
    m.setAttribute('label', 'AI')
    p.insert(0, [m])
  }
  const t = new Y.XmlText()
  p.insert(p.length, [t])
  t.insert(0, text)
}

type Team = { alice: string; aliceId: string; pageId: string; spaceId: string; connectionId: string }

/** alice 的团队空间 + 一页 + alice 的模型连接；enable = 把它设成空间 AI（名字「小助手」） */
async function team(opts: { enable?: boolean } = {}): Promise<Team> {
  const { cookie: alice, pageId } = await setupPage()
  const aliceId = await idOf('alice')
  const conn = await insertConnection(pool, aliceId, { name: 'a', protocol: 'anthropic', baseUrl: null, model: 'claude-opus-5-5' }, ALICE_KEY, assistantSecret)
  const spaceId = await spaceOf(pageId)
  if (opts.enable !== false) expect((await putJson(`/api/spaces/${spaceId}/ai`, alice, { connectionId: conn.id, name: '小助手' })).status).toBe(200)
  return { alice, aliceId, pageId, spaceId, connectionId: conn.id }
}

/** 同一个 alice 名下另建一个团队空间 + 一页（正文给定） */
async function otherSpace(alice: string, text: string): Promise<{ spaceId: string; pageId: string }> {
  const space = (await (await postJson('/api/spaces', alice, { name: 't' })).json()) as { id: string }
  const page = (await (await postJson('/api/pages', alice, { space_id: space.id })).json()) as { id: string }
  await writeDocState(pool, `page:${page.id}`, newPageDoc('另一个空间', parseNew(text)))
  return { spaceId: space.id, pageId: page.id }
}

async function newPage(cookie: string, spaceId: string, title: string, text: string): Promise<string> {
  const page = (await (await postJson('/api/pages', cookie, { space_id: spaceId })).json()) as { id: string }
  await writeDocState(pool, `page:${page.id}`, newPageDoc(title, parseNew(text)))
  return page.id
}

describe('空间 AI 的配置', () => {
  it('成员看得到启用没有和名字；只有 owner 看得到 / 改得了连接；非成员与个人空间 404；空间列表带 ai', async () => {
    const t = await team({ enable: false })
    const bob = await join(t.spaceId, 'bob')
    expect(await getJson(`/api/spaces/${t.spaceId}/ai`, bob.cookie)).toEqual({ status: 200, body: { enabled: false, name: 'AI' } })
    expect((await getJson(`/api/spaces/${t.spaceId}/ai`, t.alice)).body).toEqual({ enabled: false, name: 'AI', connectionId: null })

    // bob 自己的连接：选它也不行（只能选 owner 自己的），bob 也改不了
    const bobConn = await insertConnection(pool, bob.id, { name: 'b', protocol: 'anthropic', baseUrl: null, model: 'claude-opus-5-5' }, BOB_KEY, assistantSecret)
    expect((await putJson(`/api/spaces/${t.spaceId}/ai`, bob.cookie, { connectionId: bobConn.id })).status).toBe(403)
    expect((await putJson(`/api/spaces/${t.spaceId}/ai`, t.alice, { connectionId: bobConn.id })).status).toBe(400)
    expect((await putJson(`/api/spaces/${t.spaceId}/ai`, t.alice, { connectionId: 'no-such' })).status).toBe(400)
    expect((await putJson(`/api/spaces/${t.spaceId}/ai`, t.alice, { name: '  ' })).status).toBe(400)
    expect((await putJson(`/api/spaces/${t.spaceId}/ai`, t.alice, { name: '一'.repeat(21) })).status).toBe(400)

    const res = await putJson(`/api/spaces/${t.spaceId}/ai`, t.alice, { connectionId: t.connectionId, name: ' 小助手 ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enabled: true, name: '小助手', connectionId: t.connectionId })
    expect((await getJson(`/api/spaces/${t.spaceId}/ai`, bob.cookie)).body).toEqual({ enabled: true, name: '小助手' })
    // 只改名字：连接不动
    await putJson(`/api/spaces/${t.spaceId}/ai`, t.alice, { name: 'AI 秘书' })
    expect((await getJson(`/api/spaces/${t.spaceId}/ai`, t.alice)).body).toEqual({ enabled: true, name: 'AI 秘书', connectionId: t.connectionId })

    // 非成员 / 不存在同一个 404；个人空间没有空间 AI
    await insertUser('dave')
    const dave = await login('dave')
    expect((await getJson(`/api/spaces/${t.spaceId}/ai`, dave)).status).toBe(404)
    expect((await putJson(`/api/spaces/${t.spaceId}/ai`, dave, { name: 'x' })).status).toBe(404)
    expect((await getJson('/api/spaces/no-such/ai', t.alice)).status).toBe(404)
    await postJson('/api/pages', t.alice, {})
    const personal = (await pool.query<{ id: string }>('SELECT id FROM spaces WHERE owner_id = $1 AND is_personal', [t.aliceId])).rows[0]!.id
    expect((await getJson(`/api/spaces/${personal}/ai`, t.alice)).status).toBe(404)
    expect((await putJson(`/api/spaces/${personal}/ai`, t.alice, { connectionId: t.connectionId })).status).toBe(404)

    const list = (await getJson<Array<{ id: string; ai: unknown }>>('/api/spaces', bob.cookie)).body
    expect(list.find((s) => s.id === t.spaceId)?.ai).toEqual({ enabled: true, name: 'AI 秘书' })
    const own = (await getJson<Array<{ id: string; ai: unknown }>>('/api/spaces', t.alice)).body
    expect(own.find((s) => s.id === personal)?.ai).toBeNull()

    // owner 删了连接：停用（列表与 GET 都是），名字留着
    await deleteConnection(pool, t.aliceId, t.connectionId)
    expect((await getJson(`/api/spaces/${t.spaceId}/ai`, t.alice)).body).toEqual({ enabled: false, name: 'AI 秘书', connectionId: null })
    expect((await getJson<Array<{ id: string; ai: unknown }>>('/api/spaces', bob.cookie)).body.find((s) => s.id === t.spaceId)?.ai).toEqual({
      enabled: false,
      name: 'AI 秘书',
    })
  })
})

describe('>> 里 @AI', () => {
  it('成员叫它：用 owner 的连接与空间 AI 的提示词，消息带署名，工具里没有派活 / 叫人 / 定时器；回复块记成空间 AI', async () => {
    const t = await team()
    const bob = await join(t.spaceId, 'bob')
    // bob 自己也有连接：空间 AI 不用它
    await insertConnection(pool, bob.id, { name: 'b', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' }, BOB_KEY, assistantSecret)
    const calls = script(say('这是空间 AI 的回答'))
    const doc = await connectDoc(t.pageId, bob.cookie)
    const sse = new SSECollector()
    await sse.start(t.pageId, bob.cookie)
    message(doc.document, bob.id, '帮我总结一下', { mention: SPACE_AI_ID })
    expect(await continuePage(t.pageId, bob.cookie)).toBe(202)
    await settled(sse, 1)
    const replies = await serverReplies(t.pageId, bob.cookie)
    expect(replies).toEqual([expect.objectContaining({ text: '这是空间 AI 的回答', outcome: 'end' })])
    const fresh = await connectDoc(t.pageId, bob.cookie)
    expect(replyAgent(fresh)).toBe(SPACE_AI_ID)
    fresh.destroy()

    const req = calls[0]!
    expect(req.apiKey).toBe(ALICE_KEY)
    expect(req.model).toBe('claude-opus-5-5')
    expect(req.system).toContain('团队空间共用的 AI')
    const last = JSON.stringify(req.messages[req.messages.length - 1])
    expect(last).toContain('[来自 bob]')
    expect(last).toContain('帮我总结一下')
    const names = req.tools.map((x) => x.name)
    expect(names).toEqual(expect.arrayContaining(['read_page', 'search_pages', 'edit_page', 'create_page', 'trash_page']))
    for (const banned of ['dispatch_task', 'run_agent', 'set_timer', 'wait_task', 'reply_comment', 'mark_handled', 'watch_page']) expect(names).not.toContain(banned)
    sse.stop()
    doc.destroy()
  })

  it('另一个成员接着说：同一个会话（历史接得上），之后的工具以他的身份执行；名字随配置', async () => {
    const t = await team()
    const bob = await join(t.spaceId, 'bob')
    const carol = await join(t.spaceId, 'carol')
    const calls = script(
      say('第一轮'),
      callTool('toolu_1', 'create_page', { title: '卡罗尔的新页' }),
      say('建好了'),
    )
    const sse = new SSECollector()
    await sse.start(t.pageId, bob.cookie)
    const bobDoc = await connectDoc(t.pageId, bob.cookie)
    message(bobDoc.document, bob.id, '先说一句', { mention: SPACE_AI_ID })
    expect(await continuePage(t.pageId, bob.cookie)).toBe(202)
    await settled(sse, 1)
    const first = (await agentSession(t.pageId))?.[SPACE_AI_ID]
    expect(first?.userId).toBe(bob.id)

    const carolDoc = await connectDoc(t.pageId, carol.cookie)
    message(carolDoc.document, carol.id, '帮我建一页', { agent: SPACE_AI_ID })
    expect(await continuePage(t.pageId, carol.cookie, { agent: SPACE_AI_ID })).toBe(202)
    await settled(sse, 2)
    const second = (await agentSession(t.pageId))?.[SPACE_AI_ID]
    expect(second?.sessionId).toBe(first?.sessionId)
    expect(second?.userId).toBe(carol.id)
    // 接着会话：第二轮的请求里有第一轮的历史，新消息署名 carol
    const req = calls[1]!
    expect(JSON.stringify(req.messages)).toContain('第一轮')
    expect(JSON.stringify(req.messages[req.messages.length - 1])).toContain('[来自 carol]')
    // 建出来的页记在 carol 名下（MCP 换上了她的凭证），在这个空间里、挂在当前页下
    const made = (await pool.query<{ owner_id: string; space_id: string; parent_id: string }>("SELECT owner_id, space_id, parent_id FROM live_pages WHERE title = '卡罗尔的新页'")).rows
    expect(made).toEqual([{ owner_id: carol.id, space_id: t.spaceId, parent_id: t.pageId }])

    const names = await agentNames(pool, { localAgents: () => [], onlineAgents: () => undefined }, [SPACE_AI_ID], t.pageId)
    expect(names.get(SPACE_AI_ID)).toEqual({ label: '小助手' })
    expect((await agentNames(pool, { localAgents: () => [], onlineAgents: () => undefined }, [SPACE_AI_ID])).get(SPACE_AI_ID)).toEqual({ label: 'AI' })
    sse.stop()
    bobDoc.destroy()
    carolDoc.destroy()
  })

  it('没启用 / owner 删了连接 / 个人空间：未知 agent（400）；viewer 叫不动；非成员解析不出来', async () => {
    const t = await team({ enable: false })
    const bob = await join(t.spaceId, 'bob')
    script(say('不该到这里'))
    const doc = await connectDoc(t.pageId, bob.cookie)
    message(doc.document, bob.id, '在吗', { mention: SPACE_AI_ID })
    expect(await continuePage(t.pageId, bob.cookie)).toBe(400)

    expect((await putJson(`/api/spaces/${t.spaceId}/ai`, t.alice, { connectionId: t.connectionId })).status).toBe(200)
    expect(await resolveSpaceAi(pool, { id: bob.id }, t.pageId)).toMatchObject({ id: SPACE_AI_ID, space: { id: t.spaceId } })
    await deleteConnection(pool, t.aliceId, t.connectionId)
    expect(await continuePage(t.pageId, bob.cookie)).toBe(400)
    expect(await resolveSpaceAi(pool, { id: bob.id }, t.pageId)).toBeNull()

    // 重新启用：viewer 写不了文档，叫不动（与别的 agent 同一个闸门）
    const conn = await insertConnection(pool, t.aliceId, { name: 'a2', protocol: 'anthropic', baseUrl: null, model: 'claude-opus-5-5' }, ALICE_KEY, assistantSecret)
    await putJson(`/api/spaces/${t.spaceId}/ai`, t.alice, { connectionId: conn.id })
    const viewer = await join(t.spaceId, 'vic', 'viewer')
    expect(await continuePage(t.pageId, viewer.cookie)).toBe(404)
    const daveId = await insertUser('dave')
    expect(await resolveSpaceAi(pool, { id: daveId }, t.pageId)).toBeNull()

    // 个人空间的页：没有空间 AI
    const personal = (await (await postJson('/api/pages', t.alice, {})).json()) as { id: string }
    const pdoc = await connectDoc(personal.id, t.alice)
    message(pdoc.document, t.aliceId, '在吗', { mention: SPACE_AI_ID })
    expect(await continuePage(personal.id, t.alice)).toBe(400)
    expect(await resolveSpaceAi(pool, { id: t.aliceId }, personal.id)).toBeNull()
    expect((await postJson(`/api/pages/${personal.id}/agent-choice`, t.alice, { agent: SPACE_AI_ID })).status).toBe(400)
    pdoc.destroy()
    doc.destroy()
  })

  it('一轮里读别的空间的页：叫它的人是那个空间的成员也读不到', async () => {
    const t = await team()
    const bob = await join(t.spaceId, 'bob')
    const other = await otherSpace(t.alice, '别的空间的机密')
    await join(other.spaceId, 'bob')
    const calls = script(callTool('toolu_1', 'read_page', { pageId: other.pageId }), say('读不到'))
    const sse = new SSECollector()
    await sse.start(t.pageId, bob.cookie)
    const doc = await connectDoc(t.pageId, bob.cookie)
    message(doc.document, bob.id, '读一下那页', { mention: SPACE_AI_ID })
    expect(await continuePage(t.pageId, bob.cookie)).toBe(202)
    await settled(sse, 1)
    expect(lastResult(calls[1]!)).toContain('没有找到页面')
    expect(JSON.stringify(calls[1]!.messages)).not.toContain('别的空间的机密')
    sse.stop()
    doc.destroy()
  })

  it('消息里引用了别的空间的块：提示词里只有插入时的快照，不解析原块（同读不到）', async () => {
    const t = await team()
    const bob = await join(t.spaceId, 'bob')
    const other = await otherSpace(t.alice, '')
    await join(other.spaceId, 'bob')
    const src = newPageDoc('别处', [])
    const p = new Y.XmlElement('paragraph')
    p.setAttribute('id', 'P1')
    const pt = new Y.XmlText()
    p.insert(0, [pt])
    pt.insert(0, '别处的原文现在是这样')
    src.getXmlFragment('prosemirror').insert(0, [p])
    await writeDocState(pool, `page:${other.pageId}`, src)
    const calls = script(say('收到'))
    const sse = new SSECollector()
    await sse.start(t.pageId, bob.cookie)
    const doc = await connectDoc(t.pageId, bob.cookie)
    message(doc.document, bob.id, '看看这段', { mention: SPACE_AI_ID })
    const para = (doc.document.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlElement
    const ref = new Y.XmlElement('block_ref')
    ref.setAttribute('pageId', other.pageId)
    ref.setAttribute('blockId', 'P1')
    ref.setAttribute('text', '插入时的快照')
    para.insert(para.length, [ref])
    expect(await continuePage(t.pageId, bob.cookie)).toBe(202)
    await settled(sse, 1)
    const prompt = JSON.stringify(calls[0]!.messages)
    expect(prompt).toContain('插入时的快照')
    expect(prompt).not.toContain('别处的原文现在是这样')
    sse.stop()
    doc.destroy()
  })
})

describe('空间 AI 的凭证范围', () => {
  /** bob 是两个空间的成员；凭证收窄到 t 的空间 */
  async function scoped(opts: { readOnly?: boolean } = {}) {
    const t = await team()
    const bob = await join(t.spaceId, 'bob')
    const other = await otherSpace(t.alice, '共同的词 另一边')
    await join(other.spaceId, 'bob')
    const mine = await newPage(t.alice, t.spaceId, '这边', '共同的词 这一边')
    const token = mintPageToken(bob.id, SPACE_AI_ID, { pageId: t.pageId, agentId: SPACE_AI_ID, canDispatch: false, space: t.spaceId, ...(opts.readOnly ? { readOnly: true } : {}) })
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    return { t, bob, other, mine, call }
  }

  it('读写只限这个空间：别的空间的页 404，搜索只出本空间，建 / 移到别的空间 404', async () => {
    const { t, other, mine, call } = await scoped()
    expect((await call('GET', `/api/pages/${mine}/text`)).status).toBe(200)
    expect((await call('GET', `/api/pages/${other.pageId}/text`)).status).toBe(404)
    expect((await call('POST', `/api/pages/${other.pageId}/edit`, { ops: [{ op: 'replace', old: '', new: '写进去' }] })).status).toBe(404)
    expect((await call('POST', `/api/pages/${mine}/edit`, { ops: [{ op: 'replace', old: '', new: '写进去' }] })).status).toBe(200)

    const search = (await (await call('POST', '/api/ramet/search', { query: '共同的词' })).json()) as { results: Array<{ id: string }> }
    const hits = search.results.map((r) => r.id)
    expect(hits).toContain(mine)
    expect(hits).not.toContain(other.pageId)

    expect((await call('POST', '/api/ramet/pages', { title: '越界', parentId: other.pageId })).status).toBe(404)
    const made = await call('POST', '/api/ramet/pages', { title: '本空间' })
    expect(made.status).toBe(200)
    expect((await pool.query<{ space_id: string }>("SELECT space_id FROM live_pages WHERE title = '本空间'")).rows[0]!.space_id).toBe(t.spaceId)
    expect((await call('POST', `/api/ramet/pages/${mine}/move`, { parentId: other.pageId })).status).toBe(404)
    expect((await call('POST', `/api/ramet/pages/${other.pageId}/move`, {})).status).toBe(404)
    expect((await call('POST', `/api/ramet/pages/${other.pageId}/rename`, { title: 'x' })).status).toBe(404)
    expect((await call('POST', `/api/ramet/pages/${other.pageId}/trash`)).status).toBe(404)
    expect((await call('POST', `/api/ramet/pages/${mine}/rename`, { title: '改名' })).status).toBe(200)
  })

  it('白名单外的端点一律 403：派活、叫人、带队、定时器、盯页面、代发评论、不用处理、等任务', async () => {
    const { call } = await scoped()
    const denied: Array<[string, string, unknown?]> = [
      ['POST', '/api/ramet/dispatch', { agent: 'fake', title: 't', task: 'x' }],
      ['POST', '/api/ramet/run-agent', { agent: 'fake', task: 'x' }],
      ['POST', '/api/ramet/team/plan', {}],
      ['GET', '/api/ramet/timers'],
      ['POST', '/api/ramet/timers', {}],
      ['GET', '/api/ramet/watches'],
      ['POST', '/api/ramet/comments/reply', { thread: 'x', body: 'y' }],
      ['POST', '/api/ramet/mark-handled', { reason: 'x' }],
      ['POST', '/api/ramet/wait-task', { page: 'x' }],
      ['POST', '/api/ramet/no-such-endpoint', {}],
    ]
    for (const [method, path, body] of denied) expect([method, path, (await call(method, path, body)).status]).toEqual([method, path, 403])
    const tools = (await (await call('GET', '/api/ramet/tools')).json()) as { tools: string[]; agents: unknown[] }
    expect(tools).toMatchObject({ tools: spaceTools(false, false), agents: [] })
  })

  it('只读凭证：读得了，改不了页面，有副作用的工具都 403', async () => {
    const { mine, call } = await scoped({ readOnly: true })
    expect((await call('GET', `/api/pages/${mine}/text`)).status).toBe(200)
    expect((await call('POST', `/api/pages/${mine}/edit`, { ops: [{ op: 'replace', old: '', new: 'x' }] })).status).toBe(403)
    expect((await call('POST', '/api/ramet/search', { query: '共同的词' })).status).toBe(200)
    expect((await call('POST', '/api/ramet/pages', { title: 'x' })).status).toBe(403)
    expect((await call('POST', `/api/ramet/pages/${mine}/rename`, { title: 'x' })).status).toBe(403)
    expect((await call('POST', '/api/ramet/memories/propose', { text: 'x' })).status).toBe(403)
    const tools = (await (await call('GET', '/api/ramet/tools')).json()) as { tools: string[] }
    expect(tools.tools).toEqual(spaceTools(true, false))
    expect(tools.tools).not.toContain('edit_page')
  })

  it('移入回收站的审批只给叫它的人批：别的成员答不了', async () => {
    const { t, bob, mine, call } = await scoped()
    const sse = new SSECollector()
    await sse.start(t.pageId, bob.cookie)
    const pending = call('POST', `/api/ramet/pages/${mine}/trash`)
    const ev = await waitPermission(sse)
    expect(ev.only).toBe(bob.id)
    expect(ev.agentId).toBe(SPACE_AI_ID)
    expect((await answerPermission(t.pageId, t.alice, ev, 'allow')).status).toBe(404)
    expect((await answerPermission(t.pageId, bob.cookie, ev, 'allow')).status).toBe(200)
    const res = await pending
    expect(JSON.parse((await res.text()).trim())).toEqual({ ok: true, trashed: 1 })
    sse.stop()
  })
})

// 名字在文档里的回复块不存；改名后旧回复也跟着显示新名字（这里验服务端的显示名来源）
describe('显示名', () => {
  it('收件箱 / 署名用的名字跟着配置变；没配过是「AI」', async () => {
    const t = await team()
    const host = { localAgents: () => [], onlineAgents: () => undefined }
    expect((await agentNames(pool, host, [SPACE_AI_ID], t.pageId)).get(SPACE_AI_ID)?.label).toBe('小助手')
    await putJson(`/api/spaces/${t.spaceId}/ai`, t.alice, { name: '新名字' })
    expect((await agentNames(pool, host, [SPACE_AI_ID], t.pageId)).get(SPACE_AI_ID)?.label).toBe('新名字')
    // 没配过空间 AI 的团队空间
    const fresh = (await otherSpace(t.alice, '空的')).pageId
    expect((await agentNames(pool, host, [SPACE_AI_ID], fresh)).get(SPACE_AI_ID)?.label).toBe('AI')
  })
})
