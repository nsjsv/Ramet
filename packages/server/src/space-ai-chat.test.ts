// 和空间 AI 的直接对话（agents/space-ai-chat.ts、routes/space-ai.ts 的 POST /api/spaces/:id/ai/chat）与空间 AI 的范围（space-ai.ts、ramet-tools.ts）：
//   对话页建 / 复用 / 回收站后另建、并发只一页；在我的私人区（别的成员打不开）；只读成员 403、没开 409、非成员 404；空间列表带 ai.chat；
//   空间 AI 在我的对话页上解析得出，别的私人页、别人的对话页解析不出；它的写工具碰不到私人页，在对话页上建页缺省落到空间顶层；
//   空间概览（公共区顶层页、上限、私人页不列）只给空间 AI 的新会话。
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { insertConnection } from './ai-connections.js'
import { ensureSpaceAiChat } from './agents/space-ai-chat.js'
import { OVERVIEW_MAX, resolveSpaceAi, SPACE_AI_ID, spaceOverview } from './agents/space-ai.js'
import { resolvePromptEnv } from './agents/prompt-env.js'
import { mintPageToken } from './page-read.js'
import { assistantSecret, base, insertUser, login, pool, postJson } from './agents/test-kit.js'

type Person = { id: string; cookie: string }

async function person(name: string): Promise<Person> {
  const id = await insertUser(name, 'user')
  return { id, cookie: await login(name) }
}

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T
}

const put = (path: string, cookie: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })

/** alice 的「研发组」（bob member、vic viewer），alice 用自己的连接开了空间 AI（enable = false 就不开） */
async function world(enable = true) {
  const alice = await person('alice')
  const bob = await person('bob')
  const vic = await person('vic')
  const space = (await json<{ id: string }>(postJson('/api/spaces', alice.cookie, { name: '研发组' }))).id
  await pool.query("INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [space, bob.id, vic.id])
  if (enable) {
    const conn = await insertConnection(pool, alice.id, { name: 'a', protocol: 'anthropic', baseUrl: null, model: 'claude-opus-5-5' }, 'sk-ant-test-1', assistantSecret)
    expect((await put(`/api/spaces/${space}/ai`, alice.cookie, { connectionId: conn.id })).status).toBe(200)
  }
  return { alice, bob, vic, space }
}

const openChat = (who: Person, space: string) => postJson(`/api/spaces/${space}/ai/chat`, who.cookie)

describe('直接对话页', () => {
  it('建在我的私人区、不进页面树；再开是同一页；进回收站后另建；别的成员打不开；空间列表带 ai.chat', async () => {
    const w = await world()
    const first = await json<{ pageId: string; created: boolean }>(openChat(w.bob, w.space))
    expect(first.created).toBe(true)
    const row = (await pool.query('SELECT private_owner, in_page_tree, title, space_id FROM pages WHERE id = $1', [first.pageId])).rows[0]
    expect(row).toEqual({ private_owner: w.bob.id, in_page_tree: false, title: '和 空间 AI 的对话', space_id: w.space })
    expect(await json(openChat(w.bob, w.space))).toEqual({ pageId: first.pageId, created: false })
    expect((await fetch(`${base}/api/pages/${first.pageId}`, { headers: { cookie: w.alice.cookie } })).status).toBe(404)
    const spaces = await json<Array<{ id: string; ai: { chat: string | null } }>>(fetch(`${base}/api/spaces`, { headers: { cookie: w.bob.cookie } }))
    expect(spaces.find((s) => s.id === w.space)?.ai.chat).toBe(first.pageId)
    expect((await postJson(`/api/pages/${first.pageId}/trash`, w.bob.cookie)).status).toBe(200)
    const again = await json<{ pageId: string; created: boolean }>(openChat(w.bob, w.space))
    expect(again.created).toBe(true)
    expect(again.pageId).not.toBe(first.pageId)
  })

  it('并发打开只建一页；只读成员 403、没开 409、非成员 404', async () => {
    const w = await world()
    const [a, b] = await Promise.all([ensureSpaceAiChat(pool, w.bob, w.space), ensureSpaceAiChat(pool, w.bob, w.space)])
    expect('pageId' in a && 'pageId' in b && a.pageId === b.pageId).toBe(true)
    expect((await openChat(w.vic, w.space)).status).toBe(403)
    const stranger = await person('stranger')
    expect((await openChat(stranger, w.space)).status).toBe(404)
  })

  it('没开空间 AI：409 off', async () => {
    const w = await world(false)
    const res = await openChat(w.bob, w.space)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'off' })
  })
})

describe('空间 AI 的范围', () => {
  it('在我的对话页上解析得出；别的私人页、别人的对话页解析不出', async () => {
    const w = await world()
    const chat = (await json<{ pageId: string }>(openChat(w.bob, w.space))).pageId
    expect(await resolveSpaceAi(pool, w.bob, chat)).toMatchObject({ id: SPACE_AI_ID, space: { id: w.space } })
    const notes = (await json<{ id: string }>(postJson('/api/pages', w.bob.cookie, { space_id: w.space, private: true }))).id
    expect(await resolveSpaceAi(pool, w.bob, notes)).toBeNull()
    expect(await resolveSpaceAi(pool, w.alice, chat)).toBeNull()
  })

  it('写工具碰不到私人页；在对话页上建页缺省落到空间顶层（公共区）', async () => {
    const w = await world()
    const chat = (await json<{ pageId: string }>(openChat(w.bob, w.space))).pageId
    const notes = (await json<{ id: string }>(postJson('/api/pages', w.bob.cookie, { space_id: w.space, private: true, title: '私事' }))).id
    const token = mintPageToken(w.bob.id, SPACE_AI_ID, { pageId: chat, agentId: SPACE_AI_ID, space: w.space })
    const call = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await call(`/api/ramet/pages/${notes}/rename`, { title: 'x' })).status).toBe(404)
    const created = await json<{ id: string }>(call('/api/ramet/pages', { title: '空间 AI 建的', text: '正文' }))
    const row = (await pool.query('SELECT parent_id, private_owner, space_id FROM pages WHERE id = $1', [created.id])).rows[0]
    expect(row).toEqual({ parent_id: null, private_owner: null, space_id: w.space })
  })
})

describe('空间概览', () => {
  it('空间名 + 公共区顶层页（按页面树顺序，最多 OVERVIEW_MAX 个），私人页不列；只给带 scope 的一轮', async () => {
    const w = await world()
    for (let i = 0; i < OVERVIEW_MAX + 2; i++) await postJson('/api/pages', w.alice.cookie, { space_id: w.space, title: `页 ${i}` })
    await postJson('/api/pages', w.alice.cookie, { space_id: w.space, private: true, title: '私人笔记' })
    const text = await spaceOverview(pool, w.space)
    expect(text.startsWith('这个空间：「研发组」\n顶层页面：\n- 页 0（page:')).toBe(true)
    expect(text).toContain('…另有 2 个')
    expect(text).not.toContain('私人笔记')
    const page = (await pool.query<{ id: string }>("SELECT id FROM pages WHERE title = '页 0'")).rows[0]!.id
    const frag = new Y.Doc().getXmlFragment('prosemirror')
    const scoped = await resolvePromptEnv(pool, { id: w.alice.id, role: 'user' }, frag, page, 'full', undefined, { space: w.space })
    expect(scoped.memory).toContain('这个空间：「研发组」')
    const plain = await resolvePromptEnv(pool, { id: w.alice.id, role: 'user' }, frag, page, 'full')
    expect(plain.memory).toBe('')
  })
})
