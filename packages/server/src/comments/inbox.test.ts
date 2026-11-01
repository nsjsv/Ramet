/* ---------- 收件箱里的评论条目 ----------
 * 规则：别人的新评论，满足其一才给我——回复了我发过言的串 / @了我 / 在我建的页面上新开了串；自己的不给；
 * 一个串一条（最新那条命中的）；读过（打开串 / 自己发言）之后消失，再有新的又出现；
 * 只给仍是空间成员、页面仍活着的人；30 天窗口。
 * 人：alice 页面创建人、空间 owner；bob / carol 成员；erin 只读成员；frank 外人 */
import { expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { base, insertUser, joinPageSpace, login, pool, s, setupPage, userIdOf, waitFor } from '../agents/test-kit.js'
import type { InboxItem } from '../inbox.js'
import type { Thread } from './store.js'

type Who = 'alice' | 'bob' | 'carol' | 'erin' | 'frank'
type World = { pageId: string; cookie: Record<Who, string>; id: Record<Who, string> }
type CommentItem = Extract<InboxItem, { type: 'comment' }>

async function world(): Promise<World> {
  const { cookie: alice, pageId } = await setupPage()
  const cookie = { alice } as Record<Who, string>
  cookie.bob = await joinPageSpace(pageId, 'bob', { role: 'member' })
  cookie.carol = await joinPageSpace(pageId, 'carol', { role: 'member' })
  cookie.erin = await joinPageSpace(pageId, 'erin', { role: 'viewer' })
  await insertUser('frank')
  cookie.frank = await login('frank')
  const id = {} as Record<Who, string>
  for (const who of Object.keys(cookie) as Who[]) id[who] = await userIdOf(who)
  return { pageId, cookie, id }
}

const post = (path: string, cookie: string, body: unknown = {}): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })

// 整页讨论默认关：发之前先打开（开关本身的行为在 routes/comments.test.ts）
async function open(w: World, who: Who, body: string, pageId = w.pageId): Promise<Thread> {
  await pool.query('UPDATE pages SET page_comments = true WHERE id = $1', [pageId])
  const res = await post(`/api/pages/${pageId}/comments`, w.cookie[who], { kind: 'page', body })
  expect(res.status).toBe(201)
  return ((await res.json()) as { thread: Thread }).thread
}

async function reply(w: World, who: Who, tid: string, body: string): Promise<void> {
  expect((await post(`/api/comment-threads/${tid}/replies`, w.cookie[who], { body })).status).toBe(201)
}

async function comments(w: World, who: Who): Promise<CommentItem[]> {
  const res = await fetch(`${base}/api/inbox`, { headers: { cookie: w.cookie[who] } })
  expect(res.status).toBe(200)
  return ((await res.json()) as { items: InboxItem[] }).items.filter((i): i is CommentItem => i.type === 'comment')
}

const reasons = async (w: World, who: Who): Promise<string[]> => (await comments(w, who)).map((i) => i.reason)

test('新开串 → 页面创建人；自己的不给；与此无关的人不给', async () => {
  const w = await world()
  const t = await open(w, 'bob', '这页写得不错')
  const [item, ...rest] = await comments(w, 'alice')
  expect(rest).toEqual([])
  expect(item).toEqual({
    type: 'comment',
    key: `comment:${t.id}`,
    at: t.comments[0]!.createdAt,
    pageId: w.pageId,
    pageTitle: expect.any(String),
    threadId: t.id,
    author: { id: w.id.bob, name: 'bob' },
    excerpt: '这页写得不错',
    reason: 'new_thread',
  })
  for (const who of ['bob', 'carol', 'erin', 'frank'] as const) expect(await comments(w, who)).toEqual([])
  // 页面创建人自己开的串：谁都不通知（没人参与、没人被 @）
  await open(w, 'alice', '自言自语')
  expect(await comments(w, 'alice')).toHaveLength(1)
  expect(await comments(w, 'bob')).toEqual([])
  // 自己的评论不靠已读挡：没有已读记录也不给自己
  await pool.query('DELETE FROM comment_reads WHERE user_id = $1', [w.id.alice])
  expect((await comments(w, 'alice')).map((i) => i.threadId)).toEqual([t.id])
})

test('回复 → 串里发过言的人；创建人只因首条被通知，不因别人串里的回复', async () => {
  const w = await world()
  const t = await open(w, 'bob', '问题')
  await reply(w, 'erin', t.id, 'viewer 也来说两句')
  // bob 发过言 → reply；alice 是创建人，命中的仍是首条（她没读过）→ 一个串一条
  expect(await reasons(w, 'bob')).toEqual(['reply'])
  const alice = await comments(w, 'alice')
  expect(alice.map((i) => [i.reason, i.excerpt])).toEqual([['new_thread', '问题']])
  expect(await comments(w, 'erin')).toEqual([]) // 自己刚发言 = 已读
  expect(await comments(w, 'carol')).toEqual([])

  // alice 读了串之后，别人再回复：她没在串里发过言，不再通知
  expect((await post(`/api/comment-threads/${t.id}/read`, w.cookie.alice)).status).toBe(200)
  await reply(w, 'carol', t.id, '再补充')
  expect(await comments(w, 'alice')).toEqual([])
  // bob、erin 都发过言：都收到，摘要是最新那条命中的
  for (const who of ['bob', 'erin'] as const) {
    expect((await comments(w, who)).map((i) => [i.reason, i.excerpt, i.author?.name])).toEqual([['reply', '再补充', 'carol']])
  }
})

test('@ → 被 @ 的成员（优先于 reply）；@外人不通知；摘要降成纯文字并截断', async () => {
  const w = await world()
  const long = '长'.repeat(200)
  const t = await open(w, 'bob', `@[carol](user:${w.id.carol}) 和 @[frank](user:${w.id.frank}) 看一下 ${long}`)
  const [item] = await comments(w, 'carol')
  expect(item?.reason).toBe('mention')
  expect(item?.excerpt.startsWith('@carol 和 @frank 看一下 长')).toBe(true)
  expect([...item!.excerpt]).toHaveLength(121) // 120 字 + 省略号
  expect(item?.excerpt).not.toContain(w.id.carol)
  expect(await comments(w, 'frank')).toEqual([])

  // 串内参与者被 @：记成 mention
  await reply(w, 'carol', t.id, '好')
  await reply(w, 'erin', t.id, `@[bob](user:${w.id.bob}) 你看`)
  expect(await reasons(w, 'bob')).toEqual(['mention'])
  expect(await reasons(w, 'carol')).toEqual(['reply'])
})

test('打开串（read）后消失，再有新回复又出现；已删的评论不算', async () => {
  const w = await world()
  const t = await open(w, 'bob', '开头')
  await reply(w, 'carol', t.id, '一')
  expect(await comments(w, 'bob')).toHaveLength(1)
  expect((await post(`/api/comment-threads/${t.id}/read`, w.cookie.bob)).status).toBe(200)
  expect(await comments(w, 'bob')).toEqual([])
  await reply(w, 'carol', t.id, '二')
  expect((await comments(w, 'bob')).map((i) => i.excerpt)).toEqual(['二'])
  // carol 删了这条：bob 的条目跟着没了
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM comments WHERE body = '二'")
  expect((await fetch(`${base}/api/comments/${rows[0]!.id}`, { method: 'DELETE', headers: { cookie: w.cookie.carol } })).status).toBe(200)
  expect(await comments(w, 'bob')).toEqual([])
})

test('被移出空间 / 页面进回收站后不再给；30 天前的不给；多个串按时间倒序', async () => {
  const w = await world()
  const t1 = await open(w, 'bob', '第一串')
  const t2 = await open(w, 'carol', '第二串')
  expect((await comments(w, 'alice')).map((i) => i.threadId)).toEqual([t2.id, t1.id])

  await pool.query("UPDATE comments SET created_at = now() - interval '31 days' WHERE thread_id = $1", [t1.id])
  expect((await comments(w, 'alice')).map((i) => i.threadId)).toEqual([t2.id])

  await reply(w, 'alice', t2.id, '收到')
  await reply(w, 'erin', t2.id, '我也看看')
  expect(await reasons(w, 'carol')).toEqual(['reply'])
  await pool.query('DELETE FROM space_members WHERE user_id = $1', [w.id.carol])
  expect(await comments(w, 'carol')).toEqual([])

  expect(await reasons(w, 'alice')).toEqual(['reply'])
  expect((await post(`/api/pages/${w.pageId}/trash`, w.cookie.alice)).status).toBe(200)
  expect(await comments(w, 'alice')).toEqual([])
})

test('评论写入会发收件箱刷新信号', async () => {
  const w = await world()
  const wsProvider = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${s.port}/collab`,
    WebSocketPolyfill: class extends WebSocket {
      constructor(url: string) {
        super(url, undefined, { headers: { cookie: w.cookie.alice } })
      }
    } as unknown as typeof WebSocket,
    quiet: true,
  })
  const got: string[] = []
  const provider = new HocuspocusProvider({
    websocketProvider: wsProvider,
    name: 'control:global',
    token: 'test',
    quiet: true,
    onStateless: ({ payload }) => {
      got.push(payload)
    },
  })
  try {
    await new Promise<void>((resolve) => provider.on('synced', () => resolve()))
    await open(w, 'bob', '有信号吗')
    await waitFor(() => got.includes('inbox'))
  } finally {
    provider.destroy()
    wsProvider.destroy()
  }
})
