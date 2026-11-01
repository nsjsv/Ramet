/* ---------- 页面评论 REST ----------
 * 不变量：能读页面的空间成员（含 viewer）都能看、发、回复、解决；非成员 / 不存在 / 回收站 一律 404（全局 admin 不例外）；
 * 不是 doc 页发不了；编辑只有作者，删除是作者或空间 owner；删首条留占位、串里没有活评论整串消失；
 * 公开接口只给已发布页面的未解决串，不出任何 user id；写成功在页面文档上广播 {t:'comments'}。
 * 人：alice 空间 owner、页面创建人；bob 成员；erin 只读成员；root 全局 admin 但不在空间里；frank 外人 */
import { expect, test } from 'vitest'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { base, connectDoc, insertUser, joinPageSpace, login, pool, setupPage, userIdOf, waitFor } from '../agents/test-kit.js'
import type { Comment, Thread } from '../comments/store.js'

type Who = 'alice' | 'bob' | 'erin' | 'root' | 'frank'
type World = { pageId: string; cookie: Record<Who, string>; id: Record<Who, string> }

async function world(): Promise<World> {
  const { cookie: alice, pageId } = await setupPage()
  const cookie = { alice } as Record<Who, string>
  cookie.bob = await joinPageSpace(pageId, 'bob', { role: 'member' })
  cookie.erin = await joinPageSpace(pageId, 'erin', { role: 'viewer' })
  await insertUser('root', 'admin')
  cookie.root = await login('root')
  await insertUser('frank')
  cookie.frank = await login('frank')
  const id = {} as Record<Who, string>
  for (const who of Object.keys(cookie) as Who[]) id[who] = await userIdOf(who)
  return { pageId, cookie, id }
}

const call = (method: string, path: string, cookie?: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const ANCHOR = { from: 'AQIDBA==', to: 'AQIDBQ==', blockId: 'blk-1', text: '被评论的字', n: 0 }

async function newThread(w: World, who: Who, body: string, kind: 'inline' | 'page' = 'inline'): Promise<Thread> {
  const res = await call('POST', `/api/pages/${w.pageId}/comments`, w.cookie[who], kind === 'inline' ? { kind, anchor: ANCHOR, body } : { kind, body })
  expect(res.status).toBe(201)
  return ((await res.json()) as { thread: Thread }).thread
}

async function reply(w: World, who: Who, tid: string, body: string): Promise<Comment> {
  const res = await call('POST', `/api/comment-threads/${tid}/replies`, w.cookie[who], { body })
  expect(res.status).toBe(201)
  return ((await res.json()) as { comment: Comment }).comment
}

async function threads(w: World, who: Who = 'alice'): Promise<Thread[]> {
  const res = await call('GET', `/api/pages/${w.pageId}/comments`, w.cookie[who])
  expect(res.status).toBe(200)
  return ((await res.json()) as { threads: Thread[] }).threads
}

test('未登录 401', async () => {
  const { pageId } = await setupPage()
  expect((await call('GET', `/api/pages/${pageId}/comments`)).status).toBe(401)
  expect((await call('POST', `/api/pages/${pageId}/comments`, undefined, { kind: 'page', body: 'x' })).status).toBe(401)
  expect((await call('POST', '/api/comment-threads/x/replies', undefined, { body: 'x' })).status).toBe(401)
  expect((await call('PATCH', '/api/comments/x', undefined, { body: 'x' })).status).toBe(401)
  expect((await call('DELETE', '/api/comments/x')).status).toBe(401)
})

test('viewer 能发、回复、解决、重新打开；形状与已读', async () => {
  const w = await world()
  const t = await newThread(w, 'erin', '这句话\n有问题 https://example.com')
  expect(t).toMatchObject({ kind: 'inline', anchor: ANCHOR, resolvedAt: null, resolvedBy: null })
  expect(t.readAt).not.toBeNull() // 发言人自己算已读
  expect(t.comments).toEqual([
    { id: expect.any(String), author: { id: w.id.erin, name: 'erin' }, body: '这句话\n有问题 https://example.com', createdAt: expect.any(String), editedAt: null, deleted: false },
  ])
  const r = await reply(w, 'bob', t.id, '同意')
  expect(r.author).toEqual({ id: w.id.bob, name: 'bob' })

  const resolved = await call('POST', `/api/comment-threads/${t.id}/resolve`, w.cookie.erin, { resolved: true })
  expect(resolved.status).toBe(200)
  const rt = ((await resolved.json()) as { thread: Thread }).thread
  expect(rt.resolvedAt).not.toBeNull()
  expect(rt.resolvedBy).toEqual({ id: w.id.erin, name: 'erin' })
  const reopened = ((await (await call('POST', `/api/comment-threads/${t.id}/resolve`, w.cookie.bob, { resolved: false })).json()) as { thread: Thread }).thread
  expect(reopened).toMatchObject({ resolvedAt: null, resolvedBy: null })

  // alice 没读过：readAt null；读一下之后有了
  const page = await newThread(w, 'bob', '整页讨论', 'page')
  expect(page.anchor).toBeNull()
  const list = await threads(w, 'alice')
  expect(list.map((x) => x.id)).toEqual([t.id, page.id])
  expect(list[0]!.readAt).toBeNull()
  expect(list[0]!.comments.map((c) => c.body)).toEqual(['这句话\n有问题 https://example.com', '同意'])
  expect((await call('POST', `/api/comment-threads/${t.id}/read`, w.cookie.alice)).status).toBe(200)
  expect((await threads(w, 'alice'))[0]!.readAt).not.toBeNull()
})

test('非成员 / 全局 admin 非成员 / 不存在：每个接口都 404，且什么都没写', async () => {
  const w = await world()
  const t = await newThread(w, 'bob', 'hello')
  const cid = t.comments[0]!.id
  for (const who of ['root', 'frank'] as const) {
    const ck = w.cookie[who]
    expect((await call('GET', `/api/pages/${w.pageId}/comments`, ck)).status).toBe(404)
    expect((await call('POST', `/api/pages/${w.pageId}/comments`, ck, { kind: 'page', body: 'x' })).status).toBe(404)
    expect((await call('POST', `/api/comment-threads/${t.id}/replies`, ck, { body: 'x' })).status).toBe(404)
    expect((await call('POST', `/api/comment-threads/${t.id}/resolve`, ck, { resolved: true })).status).toBe(404)
    expect((await call('POST', `/api/comment-threads/${t.id}/read`, ck)).status).toBe(404)
    expect((await call('PATCH', `/api/comments/${cid}`, ck, { body: 'x' })).status).toBe(404)
    expect((await call('DELETE', `/api/comments/${cid}`, ck)).status).toBe(404)
  }
  const missing = '00000000-0000-4000-8000-000000000000'
  expect((await call('GET', `/api/pages/${missing}/comments`, w.cookie.alice)).status).toBe(404)
  expect((await call('POST', `/api/comment-threads/${missing}/replies`, w.cookie.alice, { body: 'x' })).status).toBe(404)
  expect((await call('PATCH', `/api/comments/${missing}`, w.cookie.alice, { body: 'x' })).status).toBe(404)
  const list = await threads(w)
  expect(list).toHaveLength(1)
  expect(list[0]!.comments).toHaveLength(1)
  expect(list[0]!.resolvedAt).toBeNull()
  expect((await pool.query('SELECT 1 FROM comment_reads WHERE user_id = ANY($1)', [[w.id.root, w.id.frank]])).rowCount).toBe(0)
})

test('入参校验：kind / anchor / body 空与超长；4000 字按码点算', async () => {
  const w = await world()
  const post = (body: unknown) => call('POST', `/api/pages/${w.pageId}/comments`, w.cookie.bob, body)
  expect((await post({ kind: 'x', body: 'a' })).status).toBe(400)
  expect((await post({ kind: 'inline', body: 'a' })).status).toBe(400)
  expect((await post({ kind: 'inline', anchor: { ...ANCHOR, from: '' }, body: 'a' })).status).toBe(400)
  expect((await post({ kind: 'inline', anchor: { ...ANCHOR, n: -1 }, body: 'a' })).status).toBe(400)
  expect((await post({ kind: 'page', anchor: ANCHOR, body: 'a' })).status).toBe(400)
  expect((await post({ kind: 'page', body: '   \n ' })).status).toBe(400)
  expect((await post({ kind: 'page', body: 'a'.repeat(4001) })).status).toBe(400)
  expect((await post({ kind: 'page', body: '😀'.repeat(4000) })).status).toBe(201)
  const t = (await threads(w))[0]!
  expect((await call('POST', `/api/comment-threads/${t.id}/replies`, w.cookie.bob, { body: '' })).status).toBe(400)
  expect((await call('POST', `/api/comment-threads/${t.id}/resolve`, w.cookie.bob, { resolved: 'yes' })).status).toBe(400)
  // 多余的锚点字段不落库
  const res = await post({ kind: 'inline', anchor: { ...ANCHOR, extra: 'x' }, body: 'b' })
  expect(((await res.json()) as { thread: Thread }).thread.anchor).toEqual(ANCHOR)
})

test('不是 doc 页发不了（400），回收站页面 404，恢复后评论原样回来，物理删页级联', async () => {
  const w = await world()
  const t = await newThread(w, 'bob', '留着')
  await pool.query("UPDATE pages SET kind = 'skill' WHERE id = $1", [w.pageId])
  expect((await call('POST', `/api/pages/${w.pageId}/comments`, w.cookie.bob, { kind: 'page', body: 'x' })).status).toBe(400)
  expect((await call('POST', `/api/comment-threads/${t.id}/replies`, w.cookie.bob, { body: 'x' })).status).toBe(400)
  await pool.query("UPDATE pages SET kind = 'doc' WHERE id = $1", [w.pageId])

  expect((await call('POST', `/api/pages/${w.pageId}/trash`, w.cookie.alice, {})).status).toBe(200)
  expect((await call('POST', `/api/pages/${w.pageId}/comments`, w.cookie.bob, { kind: 'page', body: 'x' })).status).toBe(404)
  expect((await call('POST', `/api/comment-threads/${t.id}/replies`, w.cookie.bob, { body: 'x' })).status).toBe(404)
  expect((await call('GET', `/api/pages/${w.pageId}/comments`, w.cookie.bob)).status).toBe(404)
  expect((await call('POST', `/api/pages/${w.pageId}/restore`, w.cookie.alice, {})).status).toBe(200)
  const back = await threads(w)
  expect(back.map((x) => x.id)).toEqual([t.id])
  expect(back[0]!.comments.map((c) => c.body)).toEqual(['留着'])

  expect((await call('DELETE', `/api/pages/${w.pageId}`, w.cookie.alice)).status).toBe(200)
  expect((await pool.query('SELECT 1 FROM comment_threads')).rowCount).toBe(0)
  expect((await pool.query('SELECT 1 FROM comments')).rowCount).toBe(0)
})

test('编辑只有作者（显示已编辑）；删除是作者或空间 owner', async () => {
  const w = await world()
  const t = await newThread(w, 'bob', '原话')
  const cid = t.comments[0]!.id
  for (const who of ['alice', 'erin'] as const) {
    expect((await call('PATCH', `/api/comments/${cid}`, w.cookie[who], { body: '改' })).status).toBe(403)
  }
  const edited = await call('PATCH', `/api/comments/${cid}`, w.cookie.bob, { body: '改过了' })
  expect(edited.status).toBe(200)
  const ec = ((await edited.json()) as { comment: Comment }).comment
  expect(ec).toMatchObject({ body: '改过了', deleted: false })
  expect(ec.editedAt).not.toBeNull()
  expect((await call('PATCH', `/api/comments/${cid}`, w.cookie.bob, { body: '' })).status).toBe(400)

  // erin（viewer）的评论：bob（member）删不了，alice（空间 owner）删得了
  const e = await reply(w, 'erin', t.id, 'viewer 的话')
  expect((await call('DELETE', `/api/comments/${e.id}`, w.cookie.bob)).status).toBe(403)
  expect((await call('DELETE', `/api/comments/${e.id}`, w.cookie.alice)).status).toBe(200)
  // erin 删自己的
  const e2 = await reply(w, 'erin', t.id, '再说一句')
  expect((await call('DELETE', `/api/comments/${e2.id}`, w.cookie.erin)).status).toBe(200)
  expect((await threads(w))[0]!.comments.map((c) => c.body)).toEqual(['改过了'])
})

test('删除规则：首条有回复时留占位；删回复不留；没有活评论了整串消失', async () => {
  const w = await world()
  const t = await newThread(w, 'bob', '首条')
  const head = t.comments[0]!.id
  const r1 = await reply(w, 'alice', t.id, '回复一')
  const r2 = await reply(w, 'erin', t.id, '回复二')

  const del = await call('DELETE', `/api/comments/${head}`, w.cookie.bob)
  expect(await del.json()).toEqual({ threadDeleted: false })
  let list = await threads(w)
  expect(list[0]!.comments.map((c) => [c.deleted, c.body])).toEqual([[true, ''], [false, '回复一'], [false, '回复二']])
  // 已删的不能再编辑 / 删除
  expect((await call('PATCH', `/api/comments/${head}`, w.cookie.bob, { body: 'x' })).status).toBe(404)
  expect((await call('DELETE', `/api/comments/${head}`, w.cookie.bob)).status).toBe(404)

  expect(await (await call('DELETE', `/api/comments/${r1.id}`, w.cookie.alice)).json()).toEqual({ threadDeleted: false })
  list = await threads(w)
  expect(list[0]!.comments.map((c) => c.body)).toEqual(['', '回复二'])
  expect(await (await call('DELETE', `/api/comments/${r2.id}`, w.cookie.erin)).json()).toEqual({ threadDeleted: true })
  expect(await threads(w)).toEqual([])
  expect((await pool.query('SELECT 1 FROM comments')).rowCount).toBe(0)

  // 只有一条：删了就整串没了
  const solo = await newThread(w, 'bob', '单条', 'page')
  expect(await (await call('DELETE', `/api/comments/${solo.comments[0]!.id}`, w.cookie.bob)).json()).toEqual({ threadDeleted: true })
  expect(await threads(w)).toEqual([])
})

test('@ 只记本空间成员；编辑后重算', async () => {
  const w = await world()
  const body = `看看 @[bob](user:${w.id.bob}) 和 @[frank](user:${w.id.frank}) 以及 @[带]括号](user:${w.id.erin})`
  const t = await newThread(w, 'alice', body)
  const mentions = async (): Promise<string[]> =>
    (await pool.query<{ mentions: string[] }>('SELECT mentions FROM comments WHERE id = $1', [t.comments[0]!.id])).rows[0]!.mentions
  expect((await mentions()).sort()).toEqual([w.id.bob, w.id.erin].sort())
  expect((await threads(w))[0]!.comments[0]!.body).toBe(body) // 成员接口原样给记号，前端画 chip
  await call('PATCH', `/api/comments/${t.comments[0]!.id}`, w.cookie.alice, { body: '不点名了' })
  expect(await mentions()).toEqual([])
})

test('公开页：未发布 404；发布后只给未解决的串，作者只有名字，接口里没有任何 user id', async () => {
  const w = await world()
  const open = await newThread(w, 'bob', `问 @[erin](user:${w.id.erin}) 一下`)
  await reply(w, 'erin', open.id, '收到')
  const done = await newThread(w, 'alice', '已经解决的', 'page')
  await call('POST', `/api/comment-threads/${done.id}/resolve`, w.cookie.alice, { resolved: true })

  expect((await call('GET', `/api/public/pages/${w.pageId}/comments`)).status).toBe(404)
  expect((await call('PATCH', `/api/pages/${w.pageId}/publish`, w.cookie.alice, { published: true })).status).toBe(200)
  const res = await call('GET', `/api/public/pages/${w.pageId}/comments`)
  expect(res.status).toBe(200)
  const raw = await res.text()
  for (const uid of Object.values(w.id)) expect(raw).not.toContain(uid)
  const { threads: pub } = JSON.parse(raw) as { threads: Array<{ id: string; resolvedBy: unknown; readAt: unknown; comments: Array<{ author: unknown; body: string }> }> }
  expect(pub.map((t) => t.id)).toEqual([open.id])
  expect(pub[0]!.resolvedBy).toBeNull()
  expect(pub[0]!.readAt).toBeNull()
  expect(pub[0]!.comments.map((c) => [c.author, c.body])).toEqual([
    [{ name: 'bob' }, '问 @erin 一下'],
    [{ name: 'erin' }, '收到'],
  ])
  // 公开接口只读：匿名发不了（登录端点要会话）
  expect((await call('POST', `/api/pages/${w.pageId}/comments`, undefined, { kind: 'page', body: 'x' })).status).toBe(401)
})

test('写成功在页面文档上广播 {t:"comments"}；读不广播', async () => {
  const w = await world()
  const provider: HocuspocusProvider = await connectDoc(w.pageId, w.cookie.erin)
  const got: string[] = []
  provider.on('stateless', ({ payload }: { payload: string }) => got.push(payload))
  try {
    const t = await newThread(w, 'bob', 'ping')
    await waitFor(() => got.length === 1)
    expect(JSON.parse(got[0]!)).toEqual({ t: 'comments' })
    await reply(w, 'alice', t.id, 'pong')
    await waitFor(() => got.length === 2)
    await call('POST', `/api/comment-threads/${t.id}/resolve`, w.cookie.erin, { resolved: true })
    await waitFor(() => got.length === 3)
    await call('POST', `/api/comment-threads/${t.id}/read`, w.cookie.erin)
    await call('GET', `/api/pages/${w.pageId}/comments`, w.cookie.erin)
    // 再写一次作为栅栏：read / GET 若广播了，这里会多出来
    await call('DELETE', `/api/comments/${t.comments[0]!.id}`, w.cookie.bob)
    await waitFor(() => got.length >= 4)
    expect(got).toHaveLength(4)
  } finally {
    provider.destroy()
  }
})

test('删号：作者显示为已注销（null），串还在', async () => {
  const w = await world()
  const t = await newThread(w, 'bob', '我要走了')
  await reply(w, 'alice', t.id, '再见')
  expect((await call('DELETE', `/api/admin/users/${w.id.bob}`, w.cookie.alice)).status).toBe(200)
  const list = await threads(w)
  expect(list[0]!.comments.map((c) => c.author)).toEqual([null, { id: w.id.alice, name: 'alice' }])
})
