/* ---------- 评论里 @空间 AI ----------
 * 团队空间里成员在评论里 @空间 AI：串里先显示「正在回复」（所有成员都看得到），随后出现一条作者是空间 AI 的回复（没有用户 id），
 * 用的是空间 owner 的连接，凭证只读、只碰得到这个空间；没启用 / 个人空间 → failed「这个空间还没有启用 AI」，原因所有成员都看得到。
 * AI 的回复里带了记号也不再叫它自己；同一个串里的呼叫一个接一个跑。
 * AI 写的评论没人能编辑，串的发起人、叫它的人、空间 owner 能删，别的成员不能。公开接口只有名字、不带任何 id。 */
import { describe, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import { insertConnection } from '../ai-connections.js'
import { writeDocState } from '../collab.js'
import { mintPageToken } from '../page-read.js'
import { parseNew } from '../page-write.js'
import { newPageDoc } from '../agents/markdown.js'
import { SPACE_AI_ID, SPACE_AI_OFF } from '../agents/space-ai.js'
import { after, lastResult, replay, say, script as fakeModel, type GenetCall, type Step } from '../agents/drivers/assistant/test-model.js'
import { assistantModel, assistantSecret, base, joinPageSpace, pool, postJson, setupPage, userIdOf, waitFor } from '../agents/test-kit.js'
import { callPrompt } from './space-ai-call.js'
import { callsSpaceAi, mayDelete, mentionIds, plainMentions, withoutSpaceAi, type Comment, type Thread } from './store.js'

const ALICE_KEY = 'sk-ant-test-alice-5555'
const BOB_KEY = 'sk-ant-test-bob-6666'
const AI = '@[小助手](agent:ramet:space-ai)'
const ANCHOR = { from: 'AQIDBA==', to: 'AQIDBQ==', blockId: 'blk-x', text: '被评论的字', n: 0 }

function script(...steps: Step[]): GenetCall[] {
  const model = fakeModel(...steps)
  assistantModel.script = model.stream
  return model.calls
}

function req(method: string, path: string, cookie?: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** alice 的团队空间（空间 AI「小助手」用 alice 的连接）+ 一页；bob、carol、dave 是成员，bob 自己也有一套连接 */
async function world(opts: { enable?: boolean } = {}) {
  const { cookie: alice, pageId } = await setupPage()
  const aliceId = await userIdOf('alice')
  const spaceId = (await pool.query<{ space_id: string }>('SELECT space_id FROM pages WHERE id = $1', [pageId])).rows[0]!.space_id
  const conn = await insertConnection(pool, aliceId, { name: 'a', protocol: 'anthropic', baseUrl: null, model: 'claude-opus-5-5' }, ALICE_KEY, assistantSecret)
  if (opts.enable !== false) expect((await req('PUT', `/api/spaces/${spaceId}/ai`, alice, { connectionId: conn.id, name: '小助手' })).status).toBe(200)
  const bob = await joinPageSpace(pageId, 'bob')
  const carol = await joinPageSpace(pageId, 'carol')
  const dave = await joinPageSpace(pageId, 'dave')
  const bobId = await userIdOf('bob')
  await insertConnection(pool, bobId, { name: 'b', protocol: 'anthropic', baseUrl: null, model: 'claude-opus-5-5' }, BOB_KEY, assistantSecret)
  return { alice, aliceId, pageId, spaceId, bob, bobId, carol, carolId: await userIdOf('carol'), dave }
}

async function newThread(cookie: string, pageId: string, body: string): Promise<Thread> {
  const res = await postJson(`/api/pages/${pageId}/comments`, cookie, { kind: 'inline', anchor: ANCHOR, body })
  expect(res.status).toBe(201)
  return ((await res.json()) as { thread: Thread }).thread
}

async function reply(cookie: string, threadId: string, body: string): Promise<Comment> {
  const res = await postJson(`/api/comment-threads/${threadId}/replies`, cookie, { body })
  expect(res.status).toBe(201)
  return ((await res.json()) as { comment: Comment }).comment
}

async function commentsOf(cookie: string, pageId: string, threadId: string): Promise<Comment[]> {
  const { threads } = (await (await req('GET', `/api/pages/${pageId}/comments`, cookie)).json()) as { threads: Thread[] }
  return threads.find((t) => t.id === threadId)?.comments ?? []
}

async function callState(commentId: string): Promise<{ state: string; reason: string } | undefined> {
  return (await pool.query<{ state: string; reason: string }>('SELECT state, reason FROM comment_ai_calls WHERE comment_id = $1', [commentId])).rows[0]
}

const aiReplies = async (cookie: string, pageId: string, threadId: string): Promise<Comment[]> =>
  (await commentsOf(cookie, pageId, threadId)).filter((c) => c.author && 'ai' in c.author)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('记号与判定（纯函数）', () => {
  it('空间 AI 记号：认得出、去得掉、降成纯文字；别的 agent 记号不算', () => {
    expect(callsSpaceAi(`${AI} 帮我看看`)).toBe(true)
    expect(callsSpaceAi('@[Genet](agent:ramet:assistant) 看看')).toBe(false)
    expect(withoutSpaceAi(`请 ${AI}  总结一下`)).toBe('请 总结一下')
    expect(plainMentions(`${AI} 和 @[bob](user:u1) 看看`)).toBe('@小助手 和 @bob 看看')
    // 几种记号挨着：各认各的，不互相吞
    expect(plainMentions(`@[bob](user:u1) 和 ${AI}`)).toBe('@bob 和 @小助手')
    expect(withoutSpaceAi(`@[bob](user:u1) 和 ${AI} 看看`)).toBe('@[bob](user:u1) 和 看看')
    expect(mentionIds(`${AI} 和 @[bob](user:u1)`)).toEqual(['u1'])
  })

  it('谁能删：人写的 = 作者 / owner；AI 写的 = 串的发起人 / 叫它的人 / owner', () => {
    const human = { authorId: 'u1', authorAi: false, invokerId: null, threadBy: 'u2' }
    expect(mayDelete(human, 'u1', 'member')).toBe(true)
    expect(mayDelete(human, 'u2', 'member')).toBe(false)
    expect(mayDelete(human, 'u3', 'owner')).toBe(true)
    const ai = { authorId: null, authorAi: true, invokerId: 'u1', threadBy: 'u2' }
    expect(mayDelete(ai, 'u1', 'viewer')).toBe(true)
    expect(mayDelete(ai, 'u2', 'member')).toBe(true)
    expect(mayDelete(ai, 'u3', 'owner')).toBe(true)
    expect(mayDelete(ai, 'u4', 'member')).toBe(false)
  })

  it('交给空间 AI 的那段话：署名行、记忆、页面、原文、整串、要求', () => {
    const text = callPrompt({
      invoker: 'bob',
      memory: '这个空间的公共记忆：\n- 用中文',
      page: { id: 'p1', title: '周报' },
      quote: '被评论的字',
      lines: ['carol：这里对吗', 'bob（叫你的这条）：@小助手 看看\n第二行'],
      request: '看看',
    })
    expect(text.split('\n')[0]).toBe('[来自 bob]')
    expect(text).toContain('- 用中文')
    expect(text).toContain('页面：《周报》（page:p1')
    expect(text).toContain('评论针对的原文：「被评论的字」')
    expect(text).toContain('- bob（叫你的这条）：@小助手 看看\n  第二行')
    expect(text.endsWith('bob 的要求：看看')).toBe(true)
  })
})

describe('评论里 @空间 AI', () => {
  it('成员叫它：先「正在回复」人人看得到；之后串里多一条 AI 写的回复，用的是 owner 的连接，凭证只读', async () => {
    const w = await world()
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    const calls = script(after(gate, say('结论：没问题。')))
    const t = await newThread(w.carol, w.pageId, '这里对吗')
    const asked = await reply(w.bob, t.id, `${AI} 帮我判断一下`)
    await waitFor(() => calls.length === 1)
    for (const cookie of [w.bob, w.carol]) {
      const mine = (await commentsOf(cookie, w.pageId, t.id)).find((c) => c.id === asked.id)
      expect(mine?.call).toEqual({ state: 'waiting', reason: '', ai: '小助手' })
    }
    open()
    await waitFor(async () => (await aiReplies(w.carol, w.pageId, t.id)).length === 1)
    const [ai] = await aiReplies(w.carol, w.pageId, t.id)
    expect(ai).toMatchObject({ author: { ai: 'space', name: '小助手' }, body: '结论：没问题。', invoker: w.bobId, deleted: false })
    expect((await commentsOf(w.bob, w.pageId, t.id)).find((c) => c.id === asked.id)?.call).toBeUndefined()
    expect(await callState(asked.id)).toEqual({ state: 'answered', reason: '' })

    const first = calls[0]!
    expect(first.apiKey).toBe(ALICE_KEY)
    expect(first.system).toContain('这个空间共用的 AI')
    const prompt = JSON.stringify(first.messages)
    expect(prompt).toContain('[来自 bob]')
    expect(prompt).toContain('carol：这里对吗')
    expect(prompt).toContain('（叫你的这条）')
    expect(prompt).toContain('bob 的要求：帮我判断一下')
    expect(prompt).toContain('被评论的字')
    // 只读：工具里只有读的，没有改页面 / 派活 / 回评论
    const tools = first.tools.map((x) => x.name)
    expect(tools).toEqual(expect.arrayContaining(['read_page', 'search_pages']))
    for (const name of ['edit_page', 'create_page', 'trash_page', 'dispatch_task', 'reply_comment']) expect(tools).not.toContain(name)
    // 同样形状的凭证改不了页面
    const token = mintPageToken(w.bobId, SPACE_AI_ID, { pageId: w.pageId, agentId: SPACE_AI_ID, canDispatch: false, space: w.spaceId, readOnly: true })
    const edit = await fetch(`${base}/api/pages/${w.pageId}/edit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [{ op: 'replace', old: '', new: 'x' }] }),
    })
    expect(edit.status).toBe(403)
  })

  it('只碰得到这个空间：读别的空间的页（叫它的人在那边也是成员）也是「没有找到」；调工具之前说的过程话不进回复', async () => {
    const w = await world()
    const other = (await (await postJson('/api/spaces', w.alice, { name: 'other' })).json()) as { id: string }
    await pool.query("INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'member')", [other.id, w.bobId])
    const page = (await (await postJson('/api/pages', w.alice, { space_id: other.id })).json()) as { id: string }
    await writeDocState(pool, `page:${page.id}`, newPageDoc('别处', parseNew('别处的秘密')))
    const readFirst: Step = () =>
      replay(fauxAssistantMessage([fauxText('我先读一下。'), fauxToolCall('read_page', { pageId: page.id }, { id: 't1' })], { stopReason: 'toolUse' }))
    script(readFirst, say((c) => `读到：${lastResult(c)}`))
    const t = await newThread(w.bob, w.pageId, `${AI} 读一下 page:${page.id}`)
    await waitFor(async () => (await aiReplies(w.bob, w.pageId, t.id)).length === 1)
    const [ai] = await aiReplies(w.bob, w.pageId, t.id)
    expect(ai!.body).toMatch(/^读到：.*没有找到/)
    expect(ai!.body).not.toContain('别处的秘密')
    expect(ai!.body).not.toContain('我先读一下')
  })

  it('没启用（含没开的个人空间）：记 failed「这个空间还没有启用 AI」，成员都看得到原因；模型不被调用', async () => {
    const w = await world({ enable: false })
    const calls = script(say('不该到这里'))
    const t = await newThread(w.bob, w.pageId, `${AI} 在吗`)
    const asked = t.comments[0]!
    await waitFor(async () => (await callState(asked.id))?.state === 'failed')
    expect(await callState(asked.id)).toEqual({ state: 'failed', reason: SPACE_AI_OFF })
    expect((await commentsOf(w.carol, w.pageId, t.id))[0]?.call).toEqual({ state: 'failed', reason: SPACE_AI_OFF, ai: '空间 AI' })

    // bob 的个人空间（没开）：手打了记号也一样
    const personal = (await (await postJson('/api/pages', w.bob, {})).json()) as { id: string }
    const pt = await newThread(w.bob, personal.id, `${AI} 在吗`)
    await waitFor(async () => (await callState(pt.comments[0]!.id))?.state === 'failed')
    expect((await callState(pt.comments[0]!.id))?.reason).toBe(SPACE_AI_OFF)
    expect(calls).toHaveLength(0)
  })

  it('模型出错：failed 带原因；空回复同样 failed', async () => {
    const w = await world()
    script(say(''))
    const t = await newThread(w.bob, w.pageId, `${AI} 说点什么`)
    await waitFor(async () => (await callState(t.comments[0]!.id))?.state === 'failed')
    expect((await callState(t.comments[0]!.id))?.reason).toBe('没有给出回复')
    expect(await aiReplies(w.bob, w.pageId, t.id)).toEqual([])
  })

  it('AI 的回复里带了记号也不再叫它自己', async () => {
    const w = await world()
    const calls = script(say(`${AI} 我在`))
    const t = await newThread(w.bob, w.pageId, `${AI} 在吗`)
    await waitFor(async () => (await aiReplies(w.bob, w.pageId, t.id)).length === 1)
    await sleep(500)
    expect(calls).toHaveLength(1)
    const [ai] = await aiReplies(w.bob, w.pageId, t.id)
    expect(await callState(ai!.id)).toBeUndefined()
  })

  it('同一个串里的两次呼叫一个接一个跑：后一次看得到前一次的回复', async () => {
    const w = await world()
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    const calls = script(after(gate, say('第一次的回答')), say('第二次的回答'))
    const t = await newThread(w.bob, w.pageId, `${AI} 第一个问题`)
    await waitFor(() => calls.length === 1)
    await reply(w.carol, t.id, `${AI} 第二个问题`)
    await sleep(500)
    expect(calls).toHaveLength(1)
    open()
    await waitFor(async () => (await aiReplies(w.bob, w.pageId, t.id)).length === 2)
    expect(calls).toHaveLength(2)
    const second = JSON.stringify(calls[1]!.messages)
    expect(second).toContain('[来自 carol]')
    expect(second).toContain('小助手（你）：第一次的回答')
    expect((await aiReplies(w.bob, w.pageId, t.id)).map((c) => c.body)).toEqual(['第一次的回答', '第二次的回答'])
  })

  it('AI 写的评论：没人能编辑；别的成员删不了，串的发起人、叫它的人、空间 owner 能删', async () => {
    const w = await world()
    script(say('答'))
    const t = await newThread(w.carol, w.pageId, '起个头')
    for (let i = 1; i <= 3; i++) {
      await reply(w.bob, t.id, `${AI} 第 ${i} 问`)
      await waitFor(async () => (await aiReplies(w.bob, w.pageId, t.id)).length === i)
    }
    const ais = await aiReplies(w.bob, w.pageId, t.id)
    for (const cookie of [w.bob, w.alice, w.carol]) expect((await req('PATCH', `/api/comments/${ais[0]!.id}`, cookie, { body: '改' })).status).toBe(403)
    expect((await req('DELETE', `/api/comments/${ais[0]!.id}`, w.dave)).status).toBe(403)
    expect((await req('DELETE', `/api/comments/${ais[0]!.id}`, w.carol)).status).toBe(200)
    expect((await req('DELETE', `/api/comments/${ais[1]!.id}`, w.bob)).status).toBe(200)
    expect((await req('DELETE', `/api/comments/${ais[2]!.id}`, w.alice)).status).toBe(200)
    expect(await aiReplies(w.bob, w.pageId, t.id)).toEqual([])
  })

  it('公开接口：AI 作者只有名字（标 ai），整个响应里没有任何 user id', async () => {
    const w = await world()
    script(say('公开的回答'))
    const t = await newThread(w.bob, w.pageId, `${AI} 问一下`)
    await waitFor(async () => (await aiReplies(w.bob, w.pageId, t.id)).length === 1)
    expect((await req('PATCH', `/api/pages/${w.pageId}/publish`, w.alice, { published: true })).status).toBe(200)
    const raw = await (await req('GET', `/api/public/pages/${w.pageId}/comments`)).text()
    for (const id of [w.aliceId, w.bobId, w.carolId]) expect(raw).not.toContain(id)
    const { threads } = JSON.parse(raw) as { threads: Array<{ comments: Array<{ author: unknown; body: string }> }> }
    expect(threads[0]!.comments.map((c) => [c.author, c.body])).toEqual([
      [{ name: 'bob' }, '@小助手 问一下'],
      [{ ai: 'space', name: '小助手' }, '公开的回答'],
    ])
  })

  it('收件箱：AI 的回复以空间 AI 的名字出现在参与过这个串的人那里', async () => {
    const w = await world()
    script(say('给你的回答'))
    const t = await newThread(w.bob, w.pageId, `${AI} 问一下`)
    await waitFor(async () => (await aiReplies(w.bob, w.pageId, t.id)).length === 1)
    const inbox = (await (await req('GET', '/api/inbox', w.bob)).json()) as { items: Array<{ type: string; threadId?: string; author?: unknown }> }
    const item = inbox.items.find((i) => i.type === 'comment' && i.threadId === t.id)
    expect(item?.author).toEqual({ ai: 'space', name: '小助手' })
  })
})
