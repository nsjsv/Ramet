import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { closePool, getPool, initDb } from './db.js'
import { startServer } from './index.js'
import { extractTitle, loadDocFromDb } from './collab.js'
import { hashPassword, SESSION_COOKIE } from './auth.js'
import { truncateAll } from './test-helpers.js'

// 必须显式指向测试库（如 ramet_test），防止误写开发库
if (!process.env.DATABASE_URL) {
  throw new Error('需要 DATABASE_URL 指向测试库,例如 postgres://postgres:postgres@localhost:5432/ramet_test')
}

let pool = getPool()
await initDb(pool)

// 整个文件共用一个 server，各用例自建账号
const s = await startServer(pool)
const base = `http://127.0.0.1:${s.port}`
const wsBase = `ws://127.0.0.1:${s.port}/collab`
const cleanup: (() => Promise<void> | void)[] = []

beforeEach(async () => {
  // users 被 pages / sessions / spaces 外键引用，须同一语句一并清
  await truncateAll(pool)
})

afterEach(async () => {
  // 断干净 ws provider，避免幽灵连接在 truncate 后重连
  for (const fn of cleanup.reverse()) {
    try {
      await fn()
    } catch {
      // 单个失败不影响其余
    }
  }
  cleanup.length = 0
})

afterAll(async () => {
  await s.close()
  await closePool()
})

// ---------- 造数助手 ----------

async function insertUser(username: string, password: string, role = 'user'): Promise<string> {
  const id = crypto.randomUUID()
  await pool.query('INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)', [
    id,
    username,
    hashPassword(password),
    role,
  ])
  return id
}

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  expect(res.status).toBe(200)
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  if (!cookie || !cookie.startsWith(`${SESSION_COOKIE}=`)) throw new Error('登录未返回会话 cookie')
  return cookie
}

type SpaceBody = { id: string; name: string; owner_id: string; is_personal: boolean; created_at: string }

async function createSpace(cookie: string, name: string): Promise<{ status: number; body: SpaceBody }> {
  const res = await fetch(`${base}/api/spaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name }),
  })
  return { status: res.status, body: (await res.json()) as SpaceBody }
}

type PageBody = {
  id: string
  parent_id: string | null
  owner_id: string | null
  space_id: string | null
  published: boolean
}

async function createPage(cookie: string, body: Record<string, unknown> = {}): Promise<{ status: number; page: PageBody }> {
  const res = await fetch(`${base}/api/pages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return { status: res.status, page: (await res.json()) as PageBody }
}

async function patchPage(cookie: string, id: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}/api/pages/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function publish(cookie: string, id: string, published: boolean): Promise<{ status: number; body: PageBody | { error: string } }> {
  const res = await fetch(`${base}/api/pages/${id}/publish`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ published }),
  })
  return { status: res.status, body: (await res.json()) as PageBody | { error: string } }
}

async function joinSpace(ownerCookie: string, userCookie: string, spaceId: string, role: 'member' | 'viewer') {
  const inv = await fetch(`${base}/api/spaces/${spaceId}/invites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: ownerCookie },
    body: JSON.stringify({ role }),
  })
  expect(inv.status).toBe(201)
  const token = ((await inv.json()) as { token: string }).token
  const acc = await fetch(`${base}/api/invites/${token}/accept`, { method: 'POST', headers: { cookie: userCookie } })
  expect(acc.status).toBe(200)
}

async function personalSpaceId(userId: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM spaces WHERE owner_id = $1 AND is_personal ORDER BY created_at, id LIMIT 1',
    [userId],
  )
  return rows[0]?.id
}

// 组一个带 title fragment + 正文的 Yjs 全量状态，直插 yjs_documents，无需走协同
function docState(title: string, content: string): Buffer {
  const doc = new Y.Doc()
  const paragraph = new Y.XmlElement('paragraph')
  const text = new Y.XmlText()
  text.insert(0, title)
  paragraph.insert(0, [text])
  doc.getXmlFragment('title').insert(0, [paragraph])
  doc.getText('content').insert(0, content)
  return Buffer.from(Y.encodeStateAsUpdate(doc))
}

async function insertDocState(pageId: string, title: string, content: string): Promise<void> {
  await pool.query('INSERT INTO yjs_documents (doc_name, state) VALUES ($1, $2)', [
    `page:${pageId}`,
    docState(title, content),
  ])
}

// 公开树节点（递归同构）；icon 是页面图标派生字段，与登录端同一契约
type PublicNode = { id: string; title: string; kind: string; icon: unknown; children: PublicNode[] }

async function publicTree(id: string, cookie?: string): Promise<{ status: number; body: PublicNode | { error: string } }> {
  const res = await fetch(`${base}/api/public/pages/${id}`, { headers: cookie ? { cookie } : {} })
  return { status: res.status, body: (await res.json()) as PublicNode | { error: string } }
}

type PublicDoc = { title: string; data: string }

async function publicDoc(id: string, cookie?: string): Promise<{ status: number; body: PublicDoc | { error: string } }> {
  const res = await fetch(`${base}/api/public/pages/${id}/doc`, { headers: cookie ? { cookie } : {} })
  return { status: res.status, body: (await res.json()) as PublicDoc | { error: string } }
}

// 解码公开 doc 的 base64 全量到本地 Y.Doc，与前端 PublicPage 一致
async function decodeDoc(data: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Buffer.from(data, 'base64'))
  return doc
}

// ---------- ws 助手 ----------

function cookieWebSocket(cookie: string) {
  return class extends WebSocket {
    constructor(url: string) {
      super(url, { headers: { cookie } })
    }
  }
}

function connect(docName: string, doc: Y.Doc, cookie: string): HocuspocusProvider {
  // preserveConnection:false 让 destroy() 连底层 ws 一起断，不留幽灵连接
  const provider = new HocuspocusProvider({
    websocketProvider: new HocuspocusProviderWebsocket({
      url: wsBase,
      WebSocketPolyfill: cookieWebSocket(cookie),
    }),
    name: docName,
    document: doc,
    preserveConnection: false,
  })
  cleanup.push(() => provider.destroy())
  return provider
}

// ---------- publish 权限矩阵 ----------

test('publish 权限矩阵:owner 200,member/viewer 403,非成员(含 admin)/不存在 404,非 boolean 400,未登录 401', async () => {
  const aliceId = await insertUser('alice', 'pw-a')
  await insertUser('bob', 'pw-b')
  await insertUser('carol', 'pw-c')
  await insertUser('dave', 'pw-d')
  await insertUser('root', 'pw-root', 'admin')
  const alice = await login('alice', 'pw-a')
  const bob = await login('bob', 'pw-b')
  const carol = await login('carol', 'pw-c')
  const dave = await login('dave', 'pw-d')
  const admin = await login('root', 'pw-root')

  const { body: space } = await createSpace(alice, '发布空间')
  await joinSpace(alice, bob, space.id, 'member')
  await joinSpace(alice, carol, space.id, 'viewer')
  const { page } = await createPage(alice, { space_id: space.id })
  expect(page.published).toBe(false)

  // 未登录 401，非 boolean 400（字符串 / 数字都不行）
  expect(
    (await fetch(`${base}/api/pages/${page.id}/publish`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ published: true }),
    })).status,
  ).toBe(401)
  for (const v of ['yes', 1, null]) {
    const res = await fetch(`${base}/api/pages/${page.id}/publish`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: alice },
      body: JSON.stringify({ published: v }),
    })
    expect(res.status, JSON.stringify(v)).toBe(400)
  }

  // member / viewer 可见但只够看
  for (const cookie of [bob, carol]) {
    const res = await publish(cookie, page.id, true)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
  }
  // 非成员与不存在同响应 404，不泄露存在性
  expect((await publish(dave, page.id, true)).status).toBe(404)
  expect((await publish(alice, crypto.randomUUID(), true)).status).toBe(404)
  expect((await publish(bob, crypto.randomUUID(), true)).status).toBe(404)

  const on = await publish(alice, page.id, true)
  expect(on.status).toBe(200)
  expect((on.body as PageBody).published).toBe(true)
  const off = await publish(alice, page.id, false)
  expect(off.status).toBe(200)
  expect((off.body as PageBody).published).toBe(false)
  const dbRow = await pool.query<{ published: boolean }>('SELECT published FROM pages WHERE id = $1', [page.id])
  expect(dbRow.rows[0]!.published).toBe(false)

  // 全局 admin 不是成员，与非成员同样 404，公开状态不变
  expect((await publish(admin, page.id, true)).status).toBe(404)
  expect(
    (await pool.query<{ published: boolean }>('SELECT published FROM pages WHERE id = $1', [page.id])).rows[0]!.published,
  ).toBe(false)
  expect(aliceId).toBeTruthy()
})

// ---------- 公开闸门与子树元数据 ----------

test('公开闸门:匿名 GET 已发布 200 且子页在 children;未发布/不存在 404;祖先发布整棵子树公开;停发收回', async () => {
  await insertUser('alice', 'pw-a')
  const alice = await login('alice', 'pw-a')

  const { body: space } = await createSpace(alice, '公开树')
  const { page: parent } = await createPage(alice, { space_id: space.id })
  const { page: child } = await createPage(alice, { space_id: space.id, parent_id: parent.id })
  await patchPage(alice, parent.id, { title: '公开父页' })
  await patchPage(alice, child.id, { title: '公开子页' })

  // 未发布时匿名访问父 / 子一律 404，不泄露存在性
  expect((await publicTree(parent.id)).status).toBe(404)
  expect((await publicTree(child.id)).status).toBe(404)
  expect((await publicTree(crypto.randomUUID())).status).toBe(404)
  // 不存在的页也 404，owner 自己访问同样 404，端点只看公开性
  expect((await publicTree(crypto.randomUUID(), alice)).status).toBe(404)

  // 发布父页后匿名可访问，children 递归含子页
  expect((await publish(alice, parent.id, true)).status).toBe(200)
  const tree = await publicTree(parent.id)
  expect(tree.status).toBe(200)
  // 每个节点带 kind，前端只给 doc 页摆「克隆到我的空间」
  expect(tree.body).toEqual({
    id: parent.id,
    title: '公开父页',
    kind: 'doc',
    icon: null,
    children: [{ id: child.id, title: '公开子页', kind: 'doc', icon: null, children: [] }],
  })
  // 子页自己没发布，但祖先发布，整棵子树匿名可达
  const childTree = await publicTree(child.id)
  expect(childTree.status).toBe(200)
  expect(childTree.body).toEqual({ id: child.id, title: '公开子页', kind: 'doc', icon: null, children: [] })

  // 登录的非成员与匿名同闸门
  await insertUser('dave', 'pw-d')
  const dave = await login('dave', 'pw-d')
  expect((await publicTree(parent.id, dave)).status).toBe(200)

  // 停发父页，整棵子树匿名收回（子页未自发布）
  expect((await publish(alice, parent.id, false)).status).toBe(200)
  expect((await publicTree(parent.id)).status).toBe(404)
  expect((await publicTree(child.id)).status).toBe(404)

  // 单独发布子页，子页公开而父页仍不可达（闸门是自己或任一祖先发布）
  expect((await publish(alice, child.id, true)).status).toBe(200)
  expect((await publicTree(child.id)).status).toBe(200)
  expect((await publicTree(parent.id)).status).toBe(404)
})

// ---------- 公开 doc（DB 重建分支） ----------

test('公开 doc:匿名拿 base64 全量,解码后标题与正文一致;未发布 404', async () => {
  await insertUser('alice', 'pw-a')
  const alice = await login('alice', 'pw-a')
  const { body: space } = await createSpace(alice, 'doc 空间')
  const { page } = await createPage(alice, { space_id: space.id })
  await insertDocState(page.id, '文档标题', '第一段正文')

  expect((await publicDoc(page.id)).status).toBe(404)

  expect((await publish(alice, page.id, true)).status).toBe(200)
  const res = await publicDoc(page.id)
  expect(res.status).toBe(200)
  const { title, data } = res.body as PublicDoc
  expect(title).toBe('文档标题')
  // base64 全量解码回本地 Y.Doc，标题与正文与源一致
  const doc = await decodeDoc(data)
  expect(extractTitle(doc)).toBe('文档标题')
  expect(doc.getText('content').toString()).toBe('第一段正文')
})

// ---------- 公开 doc（活文档优先分支） ----------

test('公开 doc 活文档优先:协同中未压缩进快照的编辑也能拿到', async () => {
  await insertUser('alice', 'pw-a')
  const alice = await login('alice', 'pw-a')
  const { body: space } = await createSpace(alice, '活文档空间')
  const { page } = await createPage(alice, { space_id: space.id })
  expect((await publish(alice, page.id, true)).status).toBe(200)

  // alice 连上协同并编辑，内容只在活文档里（yjs_documents 还没有该页快照）
  const docName = `page:${page.id}`
  const live = new Y.Doc()
  const provider = connect(docName, live, alice)
  await vi.waitFor(() => expect(provider.synced).toBe(true), { timeout: 15_000, interval: 50 })
  live.getText('content').insert(0, '协同中的新内容')

  // 公开 doc 端点优先取活文档，轮询到内容出现为止
  await vi.waitFor(async () => {
    const res = await publicDoc(page.id)
    expect(res.status).toBe(200)
    const decoded = await decodeDoc((res.body as PublicDoc).data)
    expect(decoded.getText('content').toString()).toBe('协同中的新内容')
  }, { timeout: 15_000, interval: 100 })
})

// ---------- 公开克隆 ----------

test('公开克隆:匿名 401;登录后落个人空间(树+内容一致);未公开 404', async () => {
  const aliceId = await insertUser('alice', 'pw-a')
  const bobId = await insertUser('bob', 'pw-b')
  const alice = await login('alice', 'pw-a')
  const bob = await login('bob', 'pw-b')

  const { body: space } = await createSpace(alice, '被克隆树')
  const { page: parent } = await createPage(alice, { space_id: space.id })
  const { page: child } = await createPage(alice, { space_id: space.id, parent_id: parent.id })
  await patchPage(alice, parent.id, { title: '源父页' })
  await patchPage(alice, child.id, { title: '源子页' })
  await insertDocState(parent.id, '源父页', '源父页正文')
  await insertDocState(child.id, '源子页', '源子页正文')

  const clone = async (id: string, cookie?: string) => {
    const res = await fetch(`${base}/api/public/pages/${id}/clone`, {
      method: 'POST',
      headers: cookie ? { cookie } : {},
    })
    return { status: res.status, body: (await res.json()) as { id?: string; error?: string } }
  }

  // 未公开时匿名 401（闸门在鉴权后），bob 登录后 404 不泄露存在性
  expect((await clone(parent.id)).status).toBe(401)
  expect((await clone(parent.id, bob)).status).toBe(404)
  expect((await clone(crypto.randomUUID(), bob)).status).toBe(404)

  expect((await publish(alice, parent.id, true)).status).toBe(200)

  // 匿名 401，bob（非成员）登录后克隆成功
  expect((await clone(parent.id)).status).toBe(401)
  const res = await clone(parent.id, bob)
  expect(res.status).toBe(201)
  const newRootId = (res.body as { id: string }).id
  expect(typeof newRootId).toBe('string')

  // 落点在 bob 的个人空间，树结构保持，owner 全是 bob
  const rows = await pool.query<{ id: string; parent_id: string | null; title: string; owner_id: string | null; space_id: string }>(
    'SELECT id, parent_id, title, owner_id, space_id FROM pages WHERE space_id = $1 ORDER BY created_at, id',
    [await personalSpaceId(bobId)],
  )
  expect(rows.rows).toHaveLength(2)
  const newParent = rows.rows.find((r) => r.title === '源父页')!
  const newChild = rows.rows.find((r) => r.title === '源子页')!
  expect(newParent.id).toBe(newRootId)
  expect(newParent.parent_id).toBeNull()
  expect(newChild.parent_id).toBe(newParent.id)
  expect(newParent.owner_id).toBe(bobId)
  // 克隆页不继承公开态
  expect(
    (await pool.query<{ published: boolean }>('SELECT published FROM pages WHERE id = $1', [newParent.id])).rows[0]!
      .published,
  ).toBe(false)

  // 内容一致，新 doc_name 可重建
  const doc = await loadDocFromDb(pool, `page:${newRootId}`)
  expect(extractTitle(doc)).toBe('源父页')
  expect(doc.getText('content').toString()).toBe('源父页正文')
  const childDoc = await loadDocFromDb(pool, `page:${newChild.id}`)
  expect(extractTitle(childDoc)).toBe('源子页')

  // 源树原样，alice 自己再克隆一份到自己的个人空间也成立
  const source = await pool.query('SELECT COUNT(*)::int AS n FROM pages WHERE space_id = $1', [space.id])
  expect(source.rows[0]!.n).toBe(2)
  const aliceClone = await clone(parent.id, alice)
  expect(aliceClone.status).toBe(201)
  const aliceCloned = await pool.query('SELECT COUNT(*)::int AS n FROM pages WHERE space_id = $1', [
    await personalSpaceId(aliceId),
  ])
  expect(aliceCloned.rows[0]!.n).toBe(2)
})

// ---------- 全宽（页面属性） ----------

test('全宽:PATCH 非 boolean 400、viewer 403;写入后列表带出,公开 doc 带出,克隆保留', async () => {
  const bobId = await insertUser('bob', 'pw-b')
  await insertUser('alice', 'pw-a')
  await insertUser('vic', 'pw-v')
  const alice = await login('alice', 'pw-a')
  const bob = await login('bob', 'pw-b')
  const vic = await login('vic', 'pw-v')

  const { body: space } = await createSpace(alice, '全宽')
  const { page } = await createPage(alice, { space_id: space.id })
  const listed = async (): Promise<boolean | undefined> => {
    const res = await fetch(`${base}/api/pages`, { headers: { cookie: alice } })
    return ((await res.json()) as Array<{ id: string; full_width?: boolean }>).find((p) => p.id === page.id)?.full_width
  }
  expect(await listed()).toBe(false)

  expect((await patchPage(alice, page.id, { full_width: 'yes' })).status).toBe(400)
  await joinSpace(alice, vic, space.id, 'viewer')
  expect((await patchPage(vic, page.id, { full_width: true })).status).toBe(403)
  expect(await listed()).toBe(false)

  const on = await patchPage(alice, page.id, { full_width: true })
  expect(on.status).toBe(200)
  expect((on.body as { full_width: boolean }).full_width).toBe(true)
  expect(await listed()).toBe(true)

  // 公开页与编辑页同一列宽
  expect((await publish(alice, page.id, true)).status).toBe(200)
  const pub = await publicDoc(page.id)
  expect(pub.status).toBe(200)
  expect((pub.body as { full_width?: boolean }).full_width).toBe(true)

  // 克隆带上版式（模板实例化同走 copyPageTree）
  const res = await fetch(`${base}/api/public/pages/${page.id}/clone`, { method: 'POST', headers: { cookie: bob } })
  expect(res.status).toBe(201)
  const cloned = await pool.query<{ full_width: boolean }>('SELECT full_width FROM pages WHERE space_id = $1', [
    await personalSpaceId(bobId),
  ])
  expect(cloned.rows.map((r) => r.full_width)).toEqual([true])

  expect((await patchPage(alice, page.id, { full_width: false })).status).toBe(200)
  expect(await listed()).toBe(false)
})
