import { afterAll, afterEach, beforeEach, expect, test } from 'vitest'
import { Document, OutgoingMessage } from '@hocuspocus/server'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { closePool, getPool, initDb } from './db.js'
import { startServer } from './index.js'
import { hashPassword, SESSION_COOKIE } from './auth.js'
import { truncateAll } from './test-helpers.js'

// 测试必须显式指向测试库(如 ramet_test),防止误写开发库
if (!process.env.DATABASE_URL) {
  throw new Error('需要 DATABASE_URL 指向测试库,例如 postgres://postgres:postgres@localhost:5432/ramet_test')
}

const pool = getPool()
await initDb(pool)

const s = await startServer(pool)
const base = `http://127.0.0.1:${s.port}`
const wsBase = `ws://127.0.0.1:${s.port}/collab`

beforeEach(async () => {
  await truncateAll(pool)
})

afterEach(() => {
  // 本文件不建长连;ws 用例各自 close(),没有需要清理的残留连接
})

afterAll(async () => {
  await s.close()
  await closePool()
})

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

type PageBody = { id: string; parent_id: string | null; space_id: string | null; title: string; published: boolean }

async function createPage(cookie: string, body: Record<string, unknown> = {}): Promise<PageBody> {
  const res = await fetch(`${base}/api/pages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as PageBody
}

async function listPages(cookie: string): Promise<PageBody[]> {
  const res = await fetch(`${base}/api/pages`, { headers: { cookie } })
  return (await res.json()) as PageBody[]
}

type TrashEntryBody = { id: string; title: string; space_id: string | null; parent_id: string | null; deleted_at: string; descendants: number }

async function listTrash(cookie: string): Promise<TrashEntryBody[]> {
  const res = await fetch(`${base}/api/pages/trash`, { headers: { cookie } })
  expect(res.status).toBe(200)
  return (await res.json()) as TrashEntryBody[]
}

async function trashPage(cookie: string, id: string): Promise<{ status: number; body: { trashed?: string[]; error?: string } }> {
  const res = await fetch(`${base}/api/pages/${id}/trash`, { method: 'POST', headers: { cookie } })
  return { status: res.status, body: (await res.json()) as { trashed?: string[]; error?: string } }
}

async function restorePage(cookie: string, id: string): Promise<number> {
  const res = await fetch(`${base}/api/pages/${id}/restore`, { method: 'POST', headers: { cookie } })
  return res.status
}

async function purgePage(cookie: string, id: string): Promise<number> {
  const res = await fetch(`${base}/api/pages/${id}`, { method: 'DELETE', headers: { cookie } })
  return res.status
}

async function emptyTrash(cookie: string, spaceId: string): Promise<number> {
  const res = await fetch(`${base}/api/pages/trash?space_id=${encodeURIComponent(spaceId)}`, {
    method: 'DELETE',
    headers: { cookie },
  })
  return res.status
}

async function setTitle(cookie: string, id: string, title: string): Promise<number> {
  const res = await fetch(`${base}/api/pages/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title }),
  })
  return res.status
}

/** 页面当前的父页 id(供断言恢复后的父子关系) */
async function parentOf(id: string): Promise<string | null> {
  const { rows } = await pool.query<{ parent_id: string | null }>('SELECT parent_id FROM pages WHERE id = $1', [id])
  return rows[0]?.parent_id ?? null
}

async function count(query: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(query, params)
  return rows[0]!.n
}

/** 给某页预置正文快照 + 增量 + 版本快照,用来验证回收不动历史与正文 */
async function seedContent(pageId: string): Promise<void> {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, '正文')
  const docName = `page:${pageId}`
  await pool.query('INSERT INTO yjs_documents (doc_name, state) VALUES ($1, $2)', [docName, Buffer.from(Y.encodeStateAsUpdate(doc))])
  await pool.query('INSERT INTO yjs_updates (doc_name, data) VALUES ($1, $2)', [docName, Buffer.from(Y.encodeStateAsUpdate(doc))])
  await pool.query(
    `INSERT INTO page_snapshots (id, page_id, title, origin, data, is_base) VALUES ($1, $2, $3, $4, $5, true)`,
    [crypto.randomUUID(), pageId, '标题', 'auto', Buffer.from(Y.encodeStateAsUpdate(doc))],
  )
}

// 裸 ws 客户端:握手头带 cookie,发 SyncStep1 触发 onLoadDocument(同 auth.test.ts)。
// 用 executor 形式而非 Promise.withResolvers:tsconfig 的 lib 还没到 ES2024
function openWs(cookie: string): Promise<WebSocket> {
  const ws = new WebSocket(wsBase, { headers: { cookie } })
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

/** ws 包 close 事件回调是 (code, reason),不是 CloseEvent 对象 */
function onWsClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.on('close', resolve))
}

function sendSyncStep1(ws: WebSocket, docName: string): void {
  const message = new OutgoingMessage(docName)
    .createSyncMessage()
    .writeFirstSyncStepFor(new Y.Doc() as unknown as Document)
  ws.send(message.toUint8Array())
}

test('移入回收站:整棵活子树从树里消失,正文与版本历史一行不动', async () => {
  await insertUser('alice', 'pw-a')
  const alice = await login('alice', 'pw-a')
  const root = await createPage(alice)
  const child = await createPage(alice, { parent_id: root.id })
  const grandchild = await createPage(alice, { parent_id: child.id })
  await setTitle(alice, child.id, '子页标题')
  await seedContent(child.id)

  const { status, body } = await trashPage(alice, root.id)
  expect(status).toBe(200)
  expect(new Set(body.trashed)).toEqual(new Set([root.id, child.id, grandchild.id]))

  const ids = (await listPages(alice)).map((p) => p.id)
  expect(ids).not.toContain(root.id)
  expect(ids).not.toContain(child.id)
  expect(ids).not.toContain(grandchild.id)

  // 行还在(软删),正文与历史一行未少:历史只在彻底删除时才清
  expect(await count('SELECT count(*)::int AS n FROM pages WHERE id = ANY($1::text[])', [[root.id, child.id, grandchild.id]])).toBe(3)
  expect(await count('SELECT count(*)::int AS n FROM yjs_documents WHERE doc_name = $1', [`page:${child.id}`])).toBe(1)
  expect(await count('SELECT count(*)::int AS n FROM yjs_updates WHERE doc_name = $1', [`page:${child.id}`])).toBe(1)
  expect(await count('SELECT count(*)::int AS n FROM page_snapshots WHERE page_id = $1', [child.id])).toBe(1)

  // 条目是被删子树的根,只有一条,子孙不单独成条
  const trash = await listTrash(alice)
  expect(trash).toHaveLength(1)
  // 原位置是空间顶层,descendants 是子 + 孙
  expect(trash[0]).toMatchObject({ id: root.id, space_id: root.space_id, parent_id: null, descendants: 2 })
  expect(typeof trash[0]!.deleted_at).toBe('string')

  // 已回收页面再回收与"不存在"同响应(幂等、不泄露)
  expect((await trashPage(alice, root.id)).status).toBe(404)
})

test('恢复:整棵子树回到树里,标题/历史/可写性照旧', async () => {
  await insertUser('alice', 'pw-a')
  const alice = await login('alice', 'pw-a')
  const root = await createPage(alice)
  const child = await createPage(alice, { parent_id: root.id })
  await setTitle(alice, child.id, '子页标题')
  await seedContent(child.id)
  await trashPage(alice, root.id)

  expect(await restorePage(alice, root.id)).toBe(200)

  const ids = (await listPages(alice)).map((p) => p.id)
  expect(ids).toContain(root.id)
  expect(ids).toContain(child.id)
  // 父子关系原地保留,行从未离开 pages
  expect(await parentOf(child.id)).toBe(root.id)
  const { rows } = await pool.query<{ title: string }>('SELECT title FROM pages WHERE id = $1', [child.id])
  expect(rows[0]!.title).toBe('子页标题')
  expect(await count('SELECT count(*)::int AS n FROM page_snapshots WHERE page_id = $1', [child.id])).toBe(1)
  // 恢复后可写,历史接口可达
  expect(await setTitle(alice, child.id, '改过')).toBe(200)
  const snaps = await fetch(`${base}/api/pages/${child.id}/snapshots?limit=50`, { headers: { cookie: alice } })
  expect(snaps.status).toBe(200)
  expect(await listTrash(alice)).toHaveLength(0)
})

test('已回收页面的子孙不是条目:单独恢复被拒(404),恢复根才把它带回来', async () => {
  await insertUser('alice', 'pw-a')
  const alice = await login('alice', 'pw-a')
  const root = await createPage(alice)
  const child = await createPage(alice, { parent_id: root.id })
  await trashPage(alice, root.id)

  expect(await restorePage(alice, child.id)).toBe(404)
  expect(await restorePage(alice, root.id)).toBe(200)
  expect((await listPages(alice)).map((p) => p.id)).toContain(child.id)
})

test('先回收子页再回收父页:只剩父页这一条,恢复父页把子页带回且父子关系保持', async () => {
  await insertUser('alice', 'pw-a')
  const alice = await login('alice', 'pw-a')
  const root = await createPage(alice)
  const child = await createPage(alice, { parent_id: root.id })

  await trashPage(alice, child.id)
  expect((await listTrash(alice)).map((e) => e.id)).toEqual([child.id])

  await trashPage(alice, root.id)
  // 子页的父已回收,它不再是条目根,整个子树归父页这一条(一次删除对应一个条目)
  expect((await listTrash(alice)).map((e) => e.id)).toEqual([root.id])

  expect(await restorePage(alice, root.id)).toBe(200)
  expect((await listPages(alice)).map((p) => p.id).sort()).toEqual([root.id, child.id].sort())
  expect(await parentOf(child.id)).toBe(root.id)
})

test('已回收页面对所有活页面读路径不可见(列表/历史/块文本/公开页/ws)', async () => {
  const aliceId = await insertUser('alice', 'pw-a')
  const alice = await login('alice', 'pw-a')
  const page = await createPage(alice)
  await seedContent(page.id)
  expect(aliceId).toBeTruthy()

  // 公开后再回收:公开态随回收失效(闸门走 live_pages)
  const pub = await fetch(`${base}/api/pages/${page.id}/publish`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: alice },
    body: JSON.stringify({ published: true }),
  })
  expect(pub.status).toBe(200)
  expect((await fetch(`${base}/api/public/pages/${page.id}`)).status).toBe(200)

  await trashPage(alice, page.id)

  // 历史 / 块文本 / 详情族与"不存在"同响应 404
  expect((await fetch(`${base}/api/pages/${page.id}/snapshots?limit=50`, { headers: { cookie: alice } })).status).toBe(404)
  expect((await fetch(`${base}/api/pages/${page.id}/updates?limit=50`, { headers: { cookie: alice } })).status).toBe(404)
  expect((await fetch(`${base}/api/pages/${page.id}/blocks/b1`, { headers: { cookie: alice } })).status).toBe(404)
  expect((await fetch(`${base}/api/public/pages/${page.id}`)).status).toBe(404)
  expect((await fetch(`${base}/api/public/pages/${page.id}/doc`)).status).toBe(404)

  // 侧栏的页面列表不含它
  const listed = (await (await fetch(`${base}/api/pages`, { headers: { cookie: alice } })).json()) as { id: string }[]
  expect(listed.map((p) => p.id)).not.toContain(page.id)

  // ws 连回收站里的页面,onLoadDocument 闸门过不去,4403
  const ws = await openWs(alice)
  const closed = onWsClose(ws)
  sendSyncStep1(ws, `page:${page.id}`)
  expect(await closed).toBe(4403)

  // 恢复后公开态与可达性一起回来(回收不改 published 字段)
  expect(await restorePage(alice, page.id)).toBe(200)
  expect((await fetch(`${base}/api/public/pages/${page.id}`)).status).toBe(200)
})

test('已回收页面不能当父:建子页 400、移动页面到它下面 400', async () => {
  await insertUser('alice', 'pw-a')
  const alice = await login('alice', 'pw-a')
  const trashed = await createPage(alice)
  const other = await createPage(alice)
  await trashPage(alice, trashed.id)

  const created = await fetch(`${base}/api/pages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: alice },
    body: JSON.stringify({ parent_id: trashed.id }),
  })
  expect(created.status).toBe(400)

  const moved = await fetch(`${base}/api/pages/${other.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: alice },
    body: JSON.stringify({ parent_id: trashed.id }),
  })
  expect(moved.status).toBe(400)
})

test('彻底删除:清 pages/yjs 两表/快照;重复彻底删除与恢复都 404', async () => {
  await insertUser('alice', 'pw-a')
  const alice = await login('alice', 'pw-a')
  const root = await createPage(alice)
  const child = await createPage(alice, { parent_id: root.id })
  await seedContent(child.id)

  // 活页面也能走物理删(link-watcher 的自动清理),这里从回收站条目入口验一遍
  await trashPage(alice, root.id)
  expect(await purgePage(alice, root.id)).toBe(200)

  expect(await count('SELECT count(*)::int AS n FROM pages WHERE id = ANY($1::text[])', [[root.id, child.id]])).toBe(0)
  expect(await count('SELECT count(*)::int AS n FROM yjs_documents WHERE doc_name = $1', [`page:${child.id}`])).toBe(0)
  expect(await count('SELECT count(*)::int AS n FROM yjs_updates WHERE doc_name = $1', [`page:${child.id}`])).toBe(0)
  // 版本历史随页面外键级联清空,这是允许清历史的时刻
  expect(await count('SELECT count(*)::int AS n FROM page_snapshots WHERE page_id = $1', [child.id])).toBe(0)
  expect(await purgePage(alice, root.id)).toBe(404)
  expect(await restorePage(alice, root.id)).toBe(404)
})

test('空回收站:只清本空间条目;viewer 403、非成员 404', async () => {
  await insertUser('alice', 'pw-a')
  await insertUser('bob', 'pw-b')
  await insertUser('viewer', 'pw-v')
  const alice = await login('alice', 'pw-a')
  const bob = await login('bob', 'pw-b')
  const viewer = await login('viewer', 'pw-v')

  const mine = await createPage(alice)
  await trashPage(alice, mine.id)
  const bobsPage = await createPage(bob)
  await trashPage(bob, bobsPage.id)

  // viewer 通过邀请进 alice 的共享空间
  const space = await fetch(`${base}/api/spaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: alice },
    body: JSON.stringify({ name: '共享' }),
  })
  const spaceBody = (await space.json()) as { id: string }
  const spaceId = spaceBody.id
  const invited = await createPage(alice, { space_id: spaceId })
  await trashPage(alice, invited.id)
  const invite = await fetch(`${base}/api/spaces/${spaceId}/invites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: alice },
    body: JSON.stringify({ role: 'viewer' }),
  })
  const inviteBody = (await invite.json()) as { token: string }
  const token = inviteBody.token
  expect(
    (
      await fetch(`${base}/api/invites/${token}/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: viewer },
      })
    ).status,
  ).toBe(200)

  // 非成员与空间不存在同响应
  expect(await emptyTrash(bob, spaceId)).toBe(404)
  expect(await emptyTrash(alice, crypto.randomUUID())).toBe(404)
  expect(await emptyTrash(viewer, spaceId)).toBe(403)

  // 只清本空间,别人的条目不受影响
  expect(await emptyTrash(alice, spaceId)).toBe(200)
  expect(await count('SELECT count(*)::int AS n FROM pages WHERE id = $1', [invited.id])).toBe(0)
  expect(await count('SELECT count(*)::int AS n FROM pages WHERE id = $1', [mine.id])).toBe(1)
  expect(await count('SELECT count(*)::int AS n FROM pages WHERE id = $1', [bobsPage.id])).toBe(1)
  expect((await listTrash(alice)).map((e) => e.id)).toEqual([mine.id])
})

test('物理删除活页面:子树里已回收的页面摘成顶层条目保留(正文与历史不丢)', async () => {
  await insertUser('alice', 'pw-a')
  const alice = await login('alice', 'pw-a')
  const root = await createPage(alice)
  const child = await createPage(alice, { parent_id: root.id })
  const grandchild = await createPage(alice, { parent_id: child.id })
  await seedContent(child.id)

  // 回收中间那层(条目),再把活着的 root 物理删掉,child 不能被外键级联吞掉
  await trashPage(alice, child.id)
  expect(await purgePage(alice, root.id)).toBe(200)

  expect(await count('SELECT count(*)::int AS n FROM pages WHERE id = $1', [root.id])).toBe(0)
  // 已回收的子树整体保留,只有活的那部分被物理删
  expect(await count('SELECT count(*)::int AS n FROM pages WHERE id = $1', [child.id])).toBe(1)
  expect(await count('SELECT count(*)::int AS n FROM pages WHERE id = $1', [grandchild.id])).toBe(1)
  expect(await parentOf(child.id)).toBeNull()
  expect(await parentOf(grandchild.id)).toBe(child.id)
  expect(await count('SELECT count(*)::int AS n FROM yjs_documents WHERE doc_name = $1', [`page:${child.id}`])).toBe(1)
  expect((await listTrash(alice)).map((e) => e.id)).toEqual([child.id])
  expect(await restorePage(alice, child.id)).toBe(200)
  const restored = (await listPages(alice)).map((p) => p.id)
  expect(restored).toContain(child.id)
  expect(restored).toContain(grandchild.id)
})

test('link-watcher 的自动清理走物理删:不进回收站', async () => {
  await insertUser('alice', 'pw-a')
  const alice = await login('alice', 'pw-a')
  const stub = await createPage(alice)

  expect(await purgePage(alice, stub.id)).toBe(200)
  expect(await listTrash(alice)).toHaveLength(0)
  expect(await count('SELECT count(*)::int AS n FROM pages WHERE id = $1', [stub.id])).toBe(0)
})

test('回收站列表隔离:非成员看不到他人空间的条目,admin 也看不到', async () => {
  await insertUser('alice', 'pw-a')
  await insertUser('bob', 'pw-b')
  await insertUser('root', 'pw-root', 'admin')
  const alice = await login('alice', 'pw-a')
  const bob = await login('bob', 'pw-b')
  const admin = await login('root', 'pw-root')

  const bobPage = await createPage(bob)
  await trashPage(bob, bobPage.id)

  expect(await listTrash(alice)).toHaveLength(0)
  expect((await listTrash(bob)).map((e) => e.id)).toEqual([bobPage.id])
  expect(await listTrash(admin)).toHaveLength(0)
  // 非成员恢复不了,与"不存在"同响应
  expect(await restorePage(alice, bobPage.id)).toBe(404)
})
