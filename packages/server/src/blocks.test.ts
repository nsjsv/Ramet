import { afterAll, afterEach, beforeEach, expect, test } from 'vitest'
import * as Y from 'yjs'
import { closePool, getPool, initDb } from './db.js'
import { startServer } from './index.js'
import { hashPassword, SESSION_COOKIE } from './auth.js'
import { truncateAll } from './test-helpers.js'

// 测试必须显式指向测试库(如 ramet_test),防止误写开发库
if (!process.env.DATABASE_URL) {
  throw new Error('需要 DATABASE_URL 指向测试库,例如 postgres://postgres:postgres@localhost:5432/ramet_test')
}

let pool = getPool()
await initDb(pool)

// 整个文件共用一个 server;各用例自建账号,互不依赖
const s = await startServer(pool)
const base = `http://127.0.0.1:${s.port}`

beforeEach(async () => {
  // 每个用例从空库出发;users 被 pages/sessions/spaces 外键引用,须同一语句一并清
  await truncateAll(pool)
})

afterEach(async () => {
  // 无 ws provider(纯 REST 用例),无需逐个清理
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

async function createPage(cookie: string, body: Record<string, unknown> = {}): Promise<{ status: number; page: { id: string } }> {
  const res = await fetch(`${base}/api/pages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return { status: res.status, page: (await res.json()) as { id: string } }
}

// 组一个 'prosemirror' fragment 的 Yjs 全量状态(直插 yjs_documents,无需走协同),块带 id attr
function docWithBlocks(blocks: Array<{ id: string; text: string }>): Buffer {
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment('prosemirror')
  for (const b of blocks) {
    const p = new Y.XmlElement('paragraph')
    p.setAttribute('id', b.id)
    const t = new Y.XmlText()
    if (b.text) t.insert(0, b.text)
    p.insert(0, [t])
    frag.insert(frag.length, [p])
  }
  return Buffer.from(Y.encodeStateAsUpdate(doc))
}

async function insertDocState(pageId: string, state: Buffer): Promise<void> {
  await pool.query('INSERT INTO yjs_documents (doc_name, state) VALUES ($1, $2)', [`page:${pageId}`, state])
}

async function getBlock(cookie: string | undefined, pageId: string, blockId: string): Promise<{ status: number; body: { text?: string; error?: string } }> {
  const res = await fetch(`${base}/api/pages/${pageId}/blocks/${blockId}`, {
    headers: cookie ? { cookie } : {},
  })
  return { status: res.status, body: (await res.json()) as { text?: string; error?: string } }
}

test('块文本:命中段落返回 {text};列表多条目以 \\n 连接;空段落命中返回空串;页内无此块 404', async () => {
  await insertUser('alice', 'pw-a')
  const alice = await login('alice', 'pw-a')
  const { body: space } = await createSpace(alice, '块空间')
  const { page } = await createPage(alice, { space_id: space.id })

  const idA = crypto.randomUUID()
  const idEmpty = crypto.randomUUID()
  await insertDocState(
    page.id,
    docWithBlocks([
      { id: idA, text: '第一段正文' },
      { id: idEmpty, text: '' },
    ]),
  )

  // 命中:返回文本快照
  const hit = await getBlock(alice, page.id, idA)
  expect(hit.status).toBe(200)
  expect(hit.body.text).toBe('第一段正文')

  // 空内容块也是命中(返回空串,不是 404)
  const empty = await getBlock(alice, page.id, idEmpty)
  expect(empty.status).toBe(200)
  expect(empty.body.text).toBe('')

  // 页面可见但块 id 不存在(源块已删/链接拼错)→ 404
  expect((await getBlock(alice, page.id, crypto.randomUUID())).status).toBe(404)

  // 页面本身不存在 → 同响应 404,不泄露存在性
  expect((await getBlock(alice, crypto.randomUUID(), idA)).status).toBe(404)

  // 列表:块级子节点(list_item)之间以 \n 连接,嵌套段落文本直拼
  const { page: page2 } = await createPage(alice, { space_id: space.id })
  const listId = crypto.randomUUID()
  const itemIds = [crypto.randomUUID(), crypto.randomUUID()]
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment('prosemirror')
  const list = new Y.XmlElement('bullet_list')
  list.setAttribute('id', listId)
  for (const [i, item] of ['第一条', '第二条'].entries()) {
    const li = new Y.XmlElement('list_item')
    li.setAttribute('id', itemIds[i]!)
    const p = new Y.XmlElement('paragraph')
    const t = new Y.XmlText()
    t.insert(0, item)
    p.insert(0, [t])
    li.insert(0, [p])
    list.insert(list.length, [li])
  }
  frag.insert(0, [list])
  await insertDocState(page2.id, Buffer.from(Y.encodeStateAsUpdate(doc)))
  const rich = await getBlock(alice, page2.id, listId)
  expect(rich.status).toBe(200)
  expect(rich.body.text).toBe('第一条\n第二条')

  // 列表项可寻址（任意深度，见 @ramet/shared/block-address）：单条也能取快照
  const item = await getBlock(alice, page2.id, itemIds[1]!)
  expect(item.status).toBe(200)
  expect(item.body.text).toBe('第二条')
})

test('块文本权限:非成员(含全局 admin)404 不泄露存在性;未登录 401;viewer 可读', async () => {
  await insertUser('alice', 'pw-a')
  await insertUser('bob', 'pw-b')
  await insertUser('carol', 'pw-c')
  await insertUser('root', 'pw-root', 'admin')
  const alice = await login('alice', 'pw-a')
  const bob = await login('bob', 'pw-b')
  const carol = await login('carol', 'pw-c')
  const admin = await login('root', 'pw-root')
  const { body: space } = await createSpace(alice, '权限空间')
  const { page } = await createPage(alice, { space_id: space.id })
  const blockId = crypto.randomUUID()
  await insertDocState(page.id, docWithBlocks([{ id: blockId, text: '机密内容' }]))

  // 非成员与不存在同响应 404,不泄露存在性
  expect((await getBlock(bob, page.id, blockId)).status).toBe(404)
  // 未登录 401(子应用全量 requireAuth)
  expect((await getBlock(undefined, page.id, blockId)).status).toBe(401)

  // carol 以 viewer 入空间:可见即可读(只读 ≠ 不可见)
  const inv = await fetch(`${base}/api/spaces/${space.id}/invites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: alice },
    body: JSON.stringify({ role: 'viewer' }),
  })
  expect(inv.status).toBe(201)
  const token = ((await inv.json()) as { token: string }).token
  expect((await fetch(`${base}/api/invites/${token}/accept`, { method: 'POST', headers: { cookie: carol } })).status).toBe(200)
  expect((await getBlock(carol, page.id, blockId)).body.text).toBe('机密内容')

  // 全局 admin 不是成员:与普通非成员同样 404
  expect((await getBlock(admin, page.id, blockId)).status).toBe(404)
})
