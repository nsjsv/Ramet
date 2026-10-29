/* ---------- 收藏 / 反向链接 / 空间成员管理（服务端）----------
 * 不变量：
 *   收藏  只有自己可见；对象是整页或一个块；列表现读原块当前内容（改了跟着变）；原块 / 原页没了（删了、回收站、
 *         被移出空间）展示存档并标 gone，不区分原因，被移出空间后不会再泄露现在的文字
 *   反链  从正文已有的引用派生（@ 页面 / 块提及 / 同步块 / 站内链接），不含子页面块；存页面时重算；
 *         启动时补没建过的页；只列此人看得见的来源，回收站里的与过程页不出现
 *   成员  viewer 能读成员列表；改角色 / 按用户名拉人是 owner（或 admin）的事；owner 角色不可改；已是成员 409 */
import { afterAll, afterEach, beforeEach, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { WebSocket } from 'ws'
import { hashPassword } from './auth.js'
import { loadDocFromDb, writeDocState } from './collab.js'
import { closePool, getPool, initDb } from './db.js'
import { startServer } from './index.js'
import { refreshFavoriteArchives } from './favorites.js'
import { backfillPageLinks, collectLinks, syncPageLinks } from './page-links.js'
import { truncateAll } from './test-helpers.js'

if (!process.env.DATABASE_URL) {
  throw new Error('需要 DATABASE_URL 指向测试库,例如 postgres://postgres:postgres@localhost:5432/ramet_test')
}

const pool = getPool()
await initDb(pool)
const s = await startServer(pool)
const base = `http://127.0.0.1:${s.port}`

// beforeEach 兜底：前一个测试文件遗留的行（全量串行跑时同一个库）不能影响本文件的首个用例
beforeEach(async () => {
  await truncateAll(pool)
})
afterEach(async () => {
  await truncateAll(pool)
})
afterAll(async () => {
  await s.close()
  await closePool()
})

type User = { id: string; name: string; cookie: string; spaceId: string }

async function newUser(name: string, role = 'user'): Promise<User> {
  const id = randomUUID()
  await pool.query('INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)', [id, name, hashPassword('pw-123456'), role])
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: name, password: 'pw-123456' }),
  })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const space = (await (await call('/api/spaces', cookie, 'POST', { name: `${name}-space` })).json()) as { id: string }
  return { id, name, cookie, spaceId: space.id }
}

function call(path: string, cookie: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T

async function newPage(user: { cookie: string }, spaceId: string, title: string): Promise<string> {
  const page = await json<{ id: string }>(await call('/api/pages', user.cookie, 'POST', { space_id: spaceId, title }))
  return page.id
}

type Part = string | { mention: string } | { quote: [pageId: string, blockId: string] } | { sync: [pageId: string, blockId: string] } | { link: [text: string, href: string] }
type Block = { id: string; parts: Part[]; name?: string }

/** 把页面正文整体写成给定的块（每块一个段落 + 块 id；引用落成与编辑器同形的行内节点 / link mark） */
async function seed(pageId: string, blocks: Block[], title = ''): Promise<void> {
  const doc = new Y.Doc()
  if (title) {
    const t = new Y.XmlElement('paragraph')
    doc.getXmlFragment('title').insert(0, [t])
    const tt = new Y.XmlText()
    t.insert(0, [tt])
    tt.insert(0, title)
  }
  const frag = doc.getXmlFragment('prosemirror')
  for (const block of blocks) {
    const p = new Y.XmlElement(block.name ?? 'paragraph')
    frag.insert(frag.length, [p])
    p.setAttribute('id', block.id)
    for (const part of block.parts) {
      if (typeof part === 'string') {
        const t = new Y.XmlText()
        p.insert(p.length, [t])
        t.insert(0, part)
      } else if ('link' in part) {
        const t = new Y.XmlText()
        p.insert(p.length, [t])
        t.insert(0, part.link[0], { link: { href: part.link[1] } })
      } else {
        const [name, attrs] =
          'mention' in part
            ? ['page_mention', { pageId: part.mention, title: 'x' }]
            : 'quote' in part
              ? ['block_ref', { pageId: part.quote[0], blockId: part.quote[1], text: 'q' }]
              : ['block_sync', { pageId: part.sync[0], blockId: part.sync[1] }]
        const el = new Y.XmlElement(name)
        p.insert(p.length, [el])
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
      }
    }
  }
  await writeDocState(pool, `page:${pageId}`, doc)
}

/** 启动补索引用的读法：从库里重建页面正文 */
const loadBody = async (id: string): Promise<Y.XmlFragment> => (await loadDocFromDb(pool, `page:${id}`)).getXmlFragment('prosemirror')

const waitUntil = async (pred: () => Promise<boolean>, ms = 15_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, 100))
  }
}

type Fav = { id: string; pageId: string; blockId: string | null; blockType: string; text: string; title: string; gone: boolean }
const favorites = async (user: { cookie: string }): Promise<Fav[]> => json(await call('/api/favorites', user.cookie))
const favorite = (user: { cookie: string }, pageId: string, blockId?: string): Promise<Response> =>
  call('/api/favorites', user.cookie, 'POST', { pageId, blockId })

/** 模拟 collab 存储钩子对收藏存档的刷新（seed 直接写库不走钩子） */
async function stored(pageId: string, title = ''): Promise<void> {
  await refreshFavoriteArchives(pool, pageId, await loadBody(pageId), title)
}

test('收藏页面与块：幂等；列表跟着最近一次存页面的内容走，改了跟着变；只有自己看得到', async () => {
  const alice = await newUser('alice')
  const bob = await newUser('bob')
  const page = await newPage(alice, alice.spaceId, '设计稿')
  await seed(page, [{ id: 'b1', parts: ['第一版文字'] }, { id: 'b2', name: 'agent_reply', parts: ['AI 的回答'] }], '设计稿')

  const whole = await favorite(alice, page)
  expect(whole.status).toBe(201)
  const wholeId = (await json<{ id: string }>(whole)).id
  expect((await json<{ id: string }>(await favorite(alice, page))).id).toBe(wholeId) // 幂等
  const block = await json<{ id: string }>(await favorite(alice, page, 'b1'))
  await favorite(alice, page, 'b2')

  let list = await favorites(alice)
  expect(list).toHaveLength(3)
  expect(list.find((f) => f.id === block.id)).toMatchObject({ pageId: page, blockId: 'b1', blockType: 'paragraph', text: '第一版文字', title: '设计稿', gone: false })
  expect(list.find((f) => f.id === wholeId)).toMatchObject({ blockId: null, text: '设计稿', gone: false })
  expect(list.find((f) => f.blockId === 'b2')?.blockType).toBe('agent_reply')

  // 原块改了、页面存了 → 列表里是新的（列表只读库，不为每条收藏去加载文档）
  await seed(page, [{ id: 'b1', parts: ['改过的文字'] }, { id: 'b2', name: 'agent_reply', parts: ['AI 的回答'] }], '设计稿')
  await stored(page, '设计稿')
  list = await favorites(alice)
  expect(list.find((f) => f.id === block.id)?.text).toBe('改过的文字')

  // 别人看不到；也不能替我取消
  expect(await favorites(bob)).toEqual([])
  expect((await call(`/api/favorites/${block.id}`, bob.cookie, 'DELETE')).status).toBe(404)
  expect((await call(`/api/favorites/${block.id}`, alice.cookie, 'DELETE')).status).toBe(200)
  expect((await favorites(alice)).map((f) => f.id)).not.toContain(block.id)
  expect((await call(`/api/favorites/${block.id}`, alice.cookie, 'DELETE')).status).toBe(404)
})

test('收藏的目标必须看得见：别人的页面与不存在的块同样 404；viewer 可以收藏', async () => {
  const alice = await newUser('alice-vis')
  const bob = await newUser('bob-vis')
  const viewer = await newUser('viewer-vis')
  await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [alice.spaceId, viewer.id, 'viewer'])
  const page = await newPage(alice, alice.spaceId, 'p')
  await seed(page, [{ id: 'b1', parts: ['text'] }])

  const missing = await favorite(bob, randomUUID())
  expect(missing.status).toBe(404)
  const denied = await favorite(bob, page, 'b1')
  expect(denied.status).toBe(404)
  expect(await denied.json()).toEqual(await missing.json())
  expect((await favorite(alice, page, 'no-such-block')).status).toBe(404)
  expect((await favorite(viewer, page, 'b1')).status).toBe(201)
  expect((await call('/api/favorites', alice.cookie, 'POST', {})).status).toBe(400)
})

test('原块删了 / 页面进回收站 / 被移出空间：展示存档并标 gone（不区分原因）；恢复后又活了；移出后存档不再刷新，不泄露现在的文字', async () => {
  const alice = await newUser('alice-gone')
  const bob = await newUser('bob-gone')
  await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [alice.spaceId, bob.id, 'member'])
  const page = await newPage(alice, alice.spaceId, '页')
  await seed(page, [{ id: 'b1', parts: ['原来的话'] }, { id: 'b2', parts: ['别的块'] }], '页')
  const fav = (await json<{ id: string }>(await favorite(bob, page, 'b1'))).id

  // 改后的字成为存档；随后块被删（存页面）→ gone，展示改后的存档
  await seed(page, [{ id: 'b1', parts: ['改后的话'] }, { id: 'b2', parts: ['别的块'] }], '页')
  await stored(page, '页')
  await seed(page, [{ id: 'b2', parts: ['别的块'] }], '页')
  await stored(page, '页')
  expect((await favorites(bob))[0]).toMatchObject({ id: fav, text: '改后的话', gone: true, blockType: 'paragraph' })
  // 块又回来了（比如从历史里恢复）：存页面后 gone 清掉，文字是现在的
  await seed(page, [{ id: 'b1', parts: ['改后的话'] }, { id: 'b2', parts: ['别的块'] }], '页')
  await stored(page, '页')
  expect((await favorites(bob))[0]).toMatchObject({ text: '改后的话', gone: false })

  // 页面进回收站：gone（不再刷新）；恢复：活
  expect((await call(`/api/pages/${page}/trash`, alice.cookie, 'POST', {})).status).toBe(200)
  expect((await favorites(bob))[0]).toMatchObject({ gone: true, text: '改后的话', title: '页' })
  expect((await call(`/api/pages/${page}/restore`, alice.cookie, 'POST', {})).status).toBe(200)
  expect((await favorites(bob))[0]!.gone).toBe(false)

  // bob 被移出空间：gone；之后原块再怎么改、页面再怎么存，bob 看到的都是存档，不是现在的文字
  await call(`/api/spaces/${alice.spaceId}/members/${bob.id}`, alice.cookie, 'DELETE')
  await seed(page, [{ id: 'b1', parts: ['移出之后的秘密'] }], '页')
  await stored(page, '页') // collab 存储钩子对每次存页面都会调它：被移出的人的存档必须被跳过
  const after = (await favorites(bob))[0]!
  expect(after.gone).toBe(true)
  expect(after.text).toBe('改后的话')
  expect(JSON.stringify(after)).not.toContain('秘密')
})

type Backlinks = { backlinks: Array<{ pageId: string; title: string; blocks: Array<{ blockId: string; text: string; kind: string; targetBlockId: string }> }>; total: number }
const backlinks = async (user: { cookie: string }, pageId: string): Promise<Backlinks> => json(await call(`/api/pages/${pageId}/backlinks`, user.cookie))

test('collectLinks：提及 / 块提及 / 同步块 / 站内链接；子页面块不算；块 id 记在最近的可寻址块（列表项）上；同一条只记一次', () => {
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment('prosemirror')
  const T = '11111111-1111-4111-8111-111111111111'
  const U = '22222222-2222-4222-8222-222222222222'
  const para = new Y.XmlElement('paragraph')
  para.setAttribute('id', 'top')
  frag.insert(0, [para])
  const t = new Y.XmlText()
  para.insert(0, [t])
  t.insert(0, '站内链接', { link: { href: `https://x.example/page/${T}?block=1` } })
  const mention = (parent: Y.XmlElement) => {
    const m = new Y.XmlElement('page_mention')
    parent.insert(parent.length, [m])
    m.setAttribute('pageId', T)
  }
  mention(para)
  mention(para) // 同块同目标同种类：只记一条
  const list = new Y.XmlElement('bullet_list')
  frag.insert(1, [list])
  const item = new Y.XmlElement('list_item')
  list.insert(0, [item])
  item.setAttribute('id', 'li-1')
  const inner = new Y.XmlElement('paragraph')
  item.insert(0, [inner])
  const ref = new Y.XmlElement('block_ref')
  inner.insert(0, [ref])
  ref.setAttribute('pageId', U)
  ref.setAttribute('blockId', 'bb')
  const sub = new Y.XmlElement('page_ref')
  frag.insert(2, [sub])
  sub.setAttribute('pageId', T)

  const links = collectLinks(frag).map((l) => `${l.sourceBlock}>${l.targetPage === T ? 'T' : 'U'}#${l.targetBlock}:${l.kind}`).sort()
  expect(links).toEqual(['li-1>U#bb:quote', 'top>T#:link', 'top>T#:mention'])
})

test('反链：命中提及 / 块提及 / 同步块，带来源块的当前文字；存页面（真实协同写入）后自动重算，删掉引用就消失', async () => {
  const alice = await newUser('alice-bl')
  const target = await newPage(alice, alice.spaceId, '目标')
  await seed(target, [{ id: 't1', parts: ['被引用的块'] }])
  const a = await newPage(alice, alice.spaceId, '提到它的页')
  const c = await newPage(alice, alice.spaceId, '引用块的页')
  await seed(a, [{ id: 'a1', parts: ['见 ', { mention: target }, ' 这页'] }])
  await seed(c, [{ id: 'c1', parts: ['引一下 ', { quote: [target, 't1'] }] }, { id: 'c2', parts: [{ sync: [target, 't1'] }] }])
  // writeDocState 直接落盘不走存储钩子：靠启动补索引的同一个函数建立
  expect(await backfillPageLinks(pool, loadBody)).toBeGreaterThan(0)

  const first = await backlinks(alice, target)
  expect(first.total).toBe(2)
  const byTitle = Object.fromEntries(first.backlinks.map((b) => [b.title, b.blocks]))
  expect(byTitle['提到它的页']).toEqual([{ blockId: 'a1', text: '见 page:' + target + ' 这页', kind: 'mention', targetBlockId: '' }])
  expect(byTitle['引用块的页']!.map((b) => [b.blockId, b.kind, b.targetBlockId])).toEqual([['c1', 'quote', 't1'], ['c2', 'sync', 't1']])

  // 来源块的文字变了、页面存了（索引重算），反链里的片段跟着变；没变的页面重算不写库
  await seed(a, [{ id: 'a1', parts: ['改写之后 ', { mention: target }] }])
  await syncPageLinks(pool, a, await loadBody(a))
  expect((await backlinks(alice, target)).backlinks.find((b) => b.title === '提到它的页')!.blocks[0]!.text).toBe(`改写之后 page:${target}`)

  // 真实的协同写入：连上去删掉那处提及，断开触发存储钩子，索引重算，反链消失
  const provider = await connect(a, alice.cookie)
  const body = provider.document.getXmlFragment('prosemirror')
  provider.document.transact(() => body.delete(0, body.length))
  provider.destroy()
  await waitUntil(async () => (await backlinks(alice, target)).backlinks.every((b) => b.title !== '提到它的页'))
  expect((await backlinks(alice, target)).total).toBe(1)
})

test('反链只列此人看得见的来源；回收站里的与过程页不出现；目标页不可见 404', async () => {
  const alice = await newUser('alice-bv')
  const bob = await newUser('bob-bv')
  const target = await newPage(alice, alice.spaceId, '目标')
  const mine = await newPage(alice, alice.spaceId, '我的来源')
  const trashed = await newPage(alice, alice.spaceId, '回收站里的来源')
  const run = await newPage(alice, alice.spaceId, '过程页')
  await pool.query("UPDATE pages SET kind = 'run' WHERE id = $1", [run])
  for (const id of [mine, trashed, run]) await seed(id, [{ id: 'x1', parts: [{ mention: target }] }])
  await backfillPageLinks(pool, loadBody)
  await call(`/api/pages/${trashed}/trash`, alice.cookie, 'POST', {})

  // bob 在 alice 的空间里是 viewer：能看目标和来源；另一个空间里的来源 bob 看不到
  await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [alice.spaceId, bob.id, 'viewer'])
  const hidden = await newPage(bob, bob.spaceId, 'bob 的页')
  await seed(hidden, [{ id: 'h1', parts: [{ mention: target }] }])
  await backfillPageLinks(pool, loadBody)
  const titles = async (u: { cookie: string }): Promise<string[]> => (await backlinks(u, target)).backlinks.map((b) => b.title).sort()

  // alice 只看得到自己空间里的活来源（回收站、过程页、她不是成员的空间里的都不出现）；bob 是两个空间的成员，两条都看得到
  expect(await titles(alice)).toEqual(['我的来源'])
  expect(await titles(bob)).toEqual(['bob 的页', '我的来源'])
  const stranger = await newUser('stranger-bv')
  expect((await call(`/api/pages/${target}/backlinks`, stranger.cookie)).status).toBe(404)
  expect((await call(`/api/pages/${randomUUID()}/backlinks`, stranger.cookie)).status).toBe(404)
})

test('启动补索引：只补没建过的页；页面物理删除后索引随外键清掉', async () => {
  const alice = await newUser('alice-bf')
  const target = await newPage(alice, alice.spaceId, '目标')
  const src = await newPage(alice, alice.spaceId, '来源')
  await seed(src, [{ id: 's1', parts: [{ mention: target }] }])
  const first = await backfillPageLinks(pool, loadBody)
  expect(first).toBe(2) // 目标页与来源页都没建过
  expect(await backfillPageLinks(pool, loadBody)).toBe(0) // 建过的不再补
  expect((await pool.query('SELECT count(*)::int AS n FROM page_links')).rows[0].n).toBe(1)
  await pool.query('DELETE FROM pages WHERE id = $1', [src])
  expect((await pool.query('SELECT count(*)::int AS n FROM page_links')).rows[0].n).toBe(0)
})

async function connect(pageId: string, cookie: string): Promise<HocuspocusProvider> {
  const wsProvider = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${s.port}/collab`,
    WebSocketPolyfill: class extends WebSocket {
      constructor(url: string) {
        super(url, undefined, { headers: { cookie } })
      }
    } as unknown as typeof WebSocket,
    quiet: true,
  })
  const provider = new HocuspocusProvider({ websocketProvider: wsProvider, name: `page:${pageId}`, token: 'test', quiet: true })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('provider 同步超时')), 10_000)
    provider.on('synced', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  return provider
}

type Member = { user_id: string; username: string; role: string }

test('viewer 能读成员列表；非成员 404', async () => {
  const owner = await newUser('owner-m')
  const viewer = await newUser('viewer-m')
  const outsider = await newUser('outsider-m')
  await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [owner.spaceId, viewer.id, 'viewer'])
  const res = await call(`/api/spaces/${owner.spaceId}/members`, viewer.cookie)
  expect(res.status).toBe(200)
  expect((await json<Member[]>(res)).map((m) => [m.username, m.role]).sort()).toEqual([['owner-m', 'owner'], ['viewer-m', 'viewer']])
  expect((await call(`/api/spaces/${owner.spaceId}/members`, outsider.cookie)).status).toBe(404)
})

test('改角色：owner 才行；owner 的角色不可改；目标不在空间 400；角色只能是 member|viewer', async () => {
  const owner = await newUser('owner-r')
  const member = await newUser('member-r')
  const other = await newUser('other-r')
  const outsider = await newUser('outsider-r')
  const admin = await newUser('admin-r', 'admin')
  for (const u of [member, other]) await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [owner.spaceId, u.id, 'member'])
  const patch = (who: { cookie: string }, target: string, role: unknown) => call(`/api/spaces/${owner.spaceId}/members/${target}`, who.cookie, 'PATCH', { role })

  const demoted = await patch(owner, member.id, 'viewer')
  expect(demoted.status).toBe(200)
  expect(await json<Member>(demoted)).toMatchObject({ username: 'member-r', role: 'viewer' })
  expect((await patch(owner, member.id, 'member')).status).toBe(200)

  expect((await patch(member, other.id, 'viewer')).status).toBe(403) // 成员改别人：管理动作，403
  expect((await patch(member, member.id, 'viewer')).status).toBe(403) // 自己也不行
  expect((await patch(outsider, other.id, 'viewer')).status).toBe(404) // 非成员：不泄露空间存在
  expect((await patch(owner, owner.id, 'viewer')).status).toBe(400) // owner 的角色不可改
  expect((await patch(owner, outsider.id, 'viewer')).status).toBe(400) // 不在空间里
  expect((await patch(owner, other.id, 'owner')).status).toBe(400) // 永不授 owner
  expect((await patch(owner, other.id, 'boss')).status).toBe(400)
  expect((await patch(admin, other.id, 'viewer')).status).toBe(404) // 全局 admin 不是成员，与非成员同样 404
  expect((await pool.query("SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2", [owner.spaceId, other.id])).rows[0].role).toBe('member')
})

test('按用户名拉人：owner 才行；用户不存在 404；已在空间里 409；拉进来的人立刻看得到这个空间', async () => {
  const owner = await newUser('owner-a')
  const member = await newUser('member-a')
  const newbie = await newUser('newbie-a')
  await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [owner.spaceId, member.id, 'member'])
  const add = (who: { cookie: string }, body: unknown) => call(`/api/spaces/${owner.spaceId}/members`, who.cookie, 'POST', body)

  expect((await add(member, { username: 'newbie-a', role: 'viewer' })).status).toBe(403)
  expect((await add(owner, { username: 'nobody', role: 'member' })).status).toBe(404)
  expect((await add(owner, { username: '  ', role: 'member' })).status).toBe(400)
  expect((await add(owner, { username: 'newbie-a', role: 'owner' })).status).toBe(400)
  expect((await add(owner, { username: 'newbie-a' })).status).toBe(400)

  const ok = await add(owner, { username: ' newbie-a ', role: 'viewer' })
  expect(ok.status).toBe(201)
  expect(await json<Member>(ok)).toMatchObject({ username: 'newbie-a', role: 'viewer' })
  expect((await add(owner, { username: 'newbie-a', role: 'member' })).status).toBe(409) // 已是成员：改角色走 PATCH
  expect((await json<Array<{ id: string }>>(await call('/api/spaces', newbie.cookie))).map((sp) => sp.id)).toContain(owner.spaceId)
})

test('导出：这一页和它的子页（活的 doc 页）的文档状态；根页在最前；过程页 / 回收站 / 他人空间的不带；非成员 404', async () => {
  const alice = await newUser('alice-ex')
  const bob = await newUser('bob-ex')
  const root = await newPage(alice, alice.spaceId, '根页')
  const child = await newPage(alice, alice.spaceId, '子页')
  const grand = await newPage(alice, alice.spaceId, '孙页')
  const run = await newPage(alice, alice.spaceId, '过程页')
  const trashed = await newPage(alice, alice.spaceId, '回收站里的子页')
  await pool.query('UPDATE pages SET parent_id = $2 WHERE id = $1', [child, root])
  await pool.query('UPDATE pages SET parent_id = $2 WHERE id = $1', [grand, child])
  await pool.query("UPDATE pages SET parent_id = $2, kind = 'run' WHERE id = $1", [run, root])
  await pool.query('UPDATE pages SET parent_id = $2 WHERE id = $1', [trashed, root])
  await seed(root, [{ id: 'r1', parts: ['根页正文'] }], '根页')
  await seed(child, [{ id: 'c1', parts: ['子页正文'] }], '子页')
  await call(`/api/pages/${trashed}/trash`, alice.cookie, 'POST', {})

  const res = await call(`/api/pages/${root}/export`, alice.cookie)
  expect(res.status).toBe(200)
  const body = await json<{ pages: Array<{ id: string; parentId: string | null; title: string; state: string }>; truncated: boolean }>(res)
  expect(body.pages.map((p) => p.id)).toEqual([root, child, grand])
  expect(body.pages[1]).toMatchObject({ parentId: root, title: '子页' })
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Uint8Array.from(Buffer.from(body.pages[1]!.state, 'base64')))
  expect(doc.getXmlFragment('prosemirror').toString()).toContain('子页正文')

  expect((await call(`/api/pages/${root}/export`, bob.cookie)).status).toBe(404)
  expect((await call(`/api/pages/${run}/export`, alice.cookie)).status).toBe(404) // 过程页不是 doc 页
  expect((await call(`/api/pages/${randomUUID()}/export`, alice.cookie)).status).toBe(404)
})
