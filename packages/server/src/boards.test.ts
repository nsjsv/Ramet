// 空间目录树注册表（boards）的服务端测试，页面树是空间派生视图、没有实体行：
//   一空间至多一行目录树（UNIQUE(space_id)）
//   新用户（登录惰性补建个人空间）/ 新空间没有目录树行，首次写入时惰性落库
//   POST /api/spaces/:id/dir-tree 幂等（201 新建 / 200 已存在）；viewer 403；非成员与不存在同 404
//   页面树 = 空间 pages 的 parent_id 森林（顶层页 parent_id NULL 合法），数据由 GET /api/pages 提供
//   DELETE /api/boards/:id 只删目录树行（级联目录 / 条目，pages / files 本体不动）
// 另覆盖：目录 CRUD / 嵌套 / 改名 / 移动 / 防环 / 跨空间 parent、条目单归属 UPSERT 移动、根级条目与排序、
// 权限矩阵、v2 / v3 存量库迁移（migrateBoardsV4，含幂等重跑）。
import { afterAll, beforeEach, expect, test } from 'vitest'
import { pagesInPageTree } from '@ramet/shared/page-tree'
import { closePool, getPool, initDb, migrateBoardsV4 } from './db.js'
import { startServer } from './index.js'
import { hashPassword, SESSION_COOKIE } from './auth.js'
import { truncateAll } from './test-helpers.js'

// 测试必须显式指向测试库（如 ramet_test），防止误写开发库
if (!process.env.DATABASE_URL) {
  throw new Error('需要 DATABASE_URL 指向测试库,例如 postgres://postgres:postgres@localhost:5432/ramet_test')
}

const pool = getPool()
await initDb(pool)

const s = await startServer(pool)
const base = `http://127.0.0.1:${s.port}`

beforeEach(async () => {
  await truncateAll(pool)
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

/** 一次登录多账号，键名即用户名（泛型收窄，避免 noUncheckedIndexedAccess 下解构出 undefined） */
async function loginAll<K extends string>(...specs: [K, string][]): Promise<Record<K, string>> {
  const out = {} as Record<K, string>
  for (const [name, pw] of specs) out[name] = await login(name, pw)
  return out
}

/** 目录树行（无 kind，页面树不是行） */
type BoardBody = { id: string; space_id: string; created_at: string }
type FolderBody = { id: string; board_id: string; parent_id: string | null; name: string }
type ItemBody = {
  id: string
  board_id: string
  folder_id: string | null
  kind: 'page' | 'file'
  item_id: string
  title: string | null
  name: string | null
  mime: string | null
}
type BoardsList = { boards: BoardBody[]; folders: FolderBody[]; items: ItemBody[] }
type PageBody = {
  id: string
  space_id: string | null
  title: string
  parent_id: string | null
  in_page_tree: boolean
}
type SpaceBody = { id: string; name: string; is_personal: boolean }

async function createSpace(cookie: string, name: string): Promise<SpaceBody> {
  const res = await fetch(`${base}/api/spaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as SpaceBody
}

/** 个人空间 id：登录即惰性补建（空间行 + owner 成员行，不落任何板块行） */
async function personalSpaceId(cookie: string): Promise<string> {
  const res = await fetch(`${base}/api/spaces`, { headers: { cookie } })
  const spaces = (await res.json()) as SpaceBody[]
  return spaces.find((sp) => sp.is_personal)!.id
}

async function listBoards(cookie: string): Promise<BoardsList> {
  const res = await fetch(`${base}/api/boards`, { headers: { cookie } })
  expect(res.status).toBe(200)
  return (await res.json()) as BoardsList
}

async function boardsOf(cookie: string, spaceId: string): Promise<BoardBody[]> {
  return (await listBoards(cookie)).boards.filter((b) => b.space_id === spaceId)
}

async function ensureDirTree(
  cookie: string,
  spaceId: string,
): Promise<{ status: number; body: { board?: BoardBody; error?: string } }> {
  const res = await fetch(`${base}/api/spaces/${spaceId}/dir-tree`, { method: 'POST', headers: { cookie } })
  return { status: res.status, body: (await res.json()) as { board?: BoardBody; error?: string } }
}

/** 幂等补建并回读该空间目录树行，缺失或落出多行都是 bug */
async function dirTreeOf(cookie: string, spaceId: string): Promise<BoardBody> {
  const res = await ensureDirTree(cookie, spaceId)
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  const rows = await boardsOf(cookie, spaceId)
  expect(rows).toEqual([res.body.board!])
  return res.body.board!
}

async function deleteBoard(cookie: string, boardId: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}/api/boards/${boardId}`, { method: 'DELETE', headers: { cookie } })
  return { status: res.status, body: await res.json() }
}

type FolderRes = { status: number; body: { id?: string; parent_id?: string | null; name?: string; error?: string } }

async function postFolder(cookie: string, boardId: string, body: Record<string, unknown>): Promise<FolderRes> {
  const res = await fetch(`${base}/api/boards/${boardId}/folders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as FolderRes['body'] }
}

async function createFolder(
  cookie: string,
  boardId: string,
  body: { parent_id?: string | null; name: string },
): Promise<{ id: string; parent_id: string | null }> {
  const res = await postFolder(cookie, boardId, body)
  expect(res.status).toBe(201)
  return res.body as { id: string; parent_id: string | null }
}

async function patchFolder(cookie: string, id: string, body: Record<string, unknown>): Promise<FolderRes> {
  const res = await fetch(`${base}/api/folders/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as FolderRes['body'] }
}

async function attach(
  cookie: string,
  folderId: string,
  kind: 'page' | 'file',
  itemId: string,
): Promise<{ status: number; body: { id?: string; folder_id?: string | null; error?: string } }> {
  const res = await fetch(`${base}/api/folders/${folderId}/items`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ kind, item_id: itemId }),
  })
  return { status: res.status, body: (await res.json()) as { id?: string; folder_id?: string | null; error?: string } }
}

/** 挂载到目录树顶层（folder_id NULL 的根级条目） */
async function attachRoot(
  cookie: string,
  boardId: string,
  kind: 'page' | 'file',
  itemId: string,
): Promise<{ status: number; body: { id?: string; folder_id?: string | null; error?: string } }> {
  const res = await fetch(`${base}/api/boards/${boardId}/items`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ kind, item_id: itemId }),
  })
  return { status: res.status, body: (await res.json()) as { id?: string; folder_id?: string | null; error?: string } }
}

async function patchItem(
  cookie: string,
  id: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: { folder_id?: string | null; error?: string } }> {
  const res = await fetch(`${base}/api/folder-items/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as { folder_id?: string | null; error?: string } }
}

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
  expect(res.status).toBe(200)
  return (await res.json()) as PageBody[]
}

async function patchPage(
  cookie: string,
  id: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}/api/pages/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function insertFile(name: string): Promise<string> {
  const id = crypto.randomUUID()
  await pool.query('INSERT INTO files (id, name, mime, size) VALUES ($1, $2, $3, $4)', [id, name, 'text/plain', 1])
  return id
}

async function addMember(spaceId: string, username: string, role: 'member' | 'viewer'): Promise<void> {
  await pool.query(
    `INSERT INTO space_members (space_id, user_id, role)
     VALUES ($1, (SELECT id FROM users WHERE username = $2), $3)`,
    [spaceId, username, role],
  )
}

// 迁移用例的 schema 探针
async function boardColumns(): Promise<string[]> {
  const { rows } = await pool.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'boards'",
  )
  return rows.map((r) => r.column_name).sort()
}

async function boardUniqueConstraints(): Promise<[string, string][]> {
  const { rows } = await pool.query<{ conname: string; def: string }>(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid = 'boards'::regclass AND contype = 'u' ORDER BY conname`,
  )
  return rows.map((r) => [r.conname, r.def])
}

async function boardIds(): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM boards ORDER BY id')
  return rows.map((r) => r.id)
}

test('未登录访问板块 API 401', async () => {
  expect((await fetch(`${base}/api/boards`)).status).toBe(401)
})

test('新空间与登录惰性补建的个人空间都是 0 行;board 行形状恰为 {id, space_id, created_at}', async () => {
  await insertUser('alice', 'password-alice')
  const { alice } = await loginAll(['alice', 'password-alice'])

  // 登录惰性补建个人空间：空间行 + owner 成员行，不落任何板块行
  const personal = await personalSpaceId(alice)
  expect(await boardsOf(alice, personal)).toEqual([])

  // 新建共享空间：同事务只落空间行 + owner 成员行
  const space = await createSpace(alice, '共享空间')
  expect(await boardsOf(alice, space.id)).toEqual([])
  // 不是"看不见"而是"全库不存在"
  expect((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM boards')).rows[0]!.n).toBe(0)

  // 惰性落行后恰一行，形状无 kind / user_id 等旧列
  const board = await dirTreeOf(alice, space.id)
  expect(Object.keys(board).sort()).toEqual(['created_at', 'id', 'space_id'])
  expect(board.space_id).toBe(space.id)
  expect(await boardsOf(alice, space.id)).toEqual([board])
})

test('POST dir-tree 幂等(首次 201、再次 200 仍 1 行);viewer 403;非成员与不存在同 404;删后 member 可 201 补回', async () => {
  await insertUser('alice', 'password-alice')
  await insertUser('bob', 'password-bob')
  await insertUser('carol', 'password-carol')
  await insertUser('mallory', 'password-mallory')
  const { alice, bob, carol, mallory } = await loginAll(
    ['alice', 'password-alice'],
    ['bob', 'password-bob'],
    ['carol', 'password-carol'],
    ['mallory', 'password-mallory'],
  )
  const space = await createSpace(alice, '补建空间')
  await addMember(space.id, 'bob', 'member')
  await addMember(space.id, 'carol', 'viewer')

  const first = await ensureDirTree(alice, space.id)
  expect(first.status).toBe(201)
  expect(first.body.board!.space_id).toBe(space.id)
  expect(await boardsOf(alice, space.id)).toEqual([first.body.board!])

  // 幂等：已存在返回 200 且同一行，不产生第二行
  const again = await ensureDirTree(alice, space.id)
  expect(again.status).toBe(200)
  expect(again.body.board!.id).toBe(first.body.board!.id)
  expect(await boardsOf(alice, space.id)).toHaveLength(1)

  // viewer 可见不可写 403；非成员与空间不存在同 404（不泄露存在性）
  expect((await ensureDirTree(carol, space.id)).status).toBe(403)
  expect((await ensureDirTree(mallory, space.id)).status).toBe(404)
  expect((await ensureDirTree(alice, crypto.randomUUID())).status).toBe(404)
  // 上面三次失败尝试都没落行
  expect(await boardsOf(alice, space.id)).toEqual([first.body.board!])

  // 删行后 member 可补回：201 新 id；再补 200 幂等
  expect((await deleteBoard(alice, first.body.board!.id)).status).toBe(200)
  expect(await boardsOf(alice, space.id)).toEqual([])
  const made = await ensureDirTree(bob, space.id)
  expect(made.status).toBe(201)
  expect(made.body.board!.id).not.toBe(first.body.board!.id)
  expect((await ensureDirTree(bob, space.id)).status).toBe(200)
  expect(await boardsOf(alice, space.id)).toEqual([made.body.board!])
})

test('UNIQUE(space_id) 在库层兜底 —— 同空间第二次裸 INSERT 被拒;ON CONFLICT DO NOTHING 后仍 1 行', async () => {
  await insertUser('alice', 'password-alice')
  const { alice } = await loginAll(['alice', 'password-alice'])
  const space = await createSpace(alice, '唯一空间')
  const board = await dirTreeOf(alice, space.id)

  await expect(
    pool.query('INSERT INTO boards (id, space_id) VALUES ($1, $2)', [crypto.randomUUID(), space.id]),
  ).rejects.toThrow(/boards_space|duplicate key/)
  // ENSURE_DIR_TREE 同款写法：命中冲突静默 no-op，行数不变
  await pool.query('INSERT INTO boards (id, space_id) VALUES ($1, $2) ON CONFLICT (space_id) DO NOTHING', [
    crypto.randomUUID(),
    space.id,
  ])
  expect(await boardsOf(alice, space.id)).toEqual([board])

  // 约束按空间而非全局：第二个空间的目录树行照常落
  const other = await createSpace(alice, '另一个空间')
  await dirTreeOf(alice, other.id)
  expect((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM boards')).rows[0]!.n).toBe(2)
})

test('旧端点消失:POST /api/spaces/:id/boards/:kind 未匹配路由 404(匿名 401);不存在的 board 删除 404', async () => {
  await insertUser('alice', 'password-alice')
  const { alice } = await loginAll(['alice', 'password-alice'])
  const space = await createSpace(alice, '旧端点空间')

  for (const kind of ['page_tree', 'folder_tree', 'bogus']) {
    const res = await fetch(`${base}/api/spaces/${space.id}/boards/${kind}`, { method: 'POST', headers: { cookie: alice } })
    expect(res.status, kind).toBe(404)
  }
  // 路由已不存在：登录用户拿到路由级 404（不是 403 / 400）；匿名 401（鉴权中间件在）
  expect((await fetch(`${base}/api/spaces/${space.id}/boards/page_tree`, { method: 'POST' })).status).toBe(401)
  // 页面树没有可删实体：任意不存在 id 都 404
  expect((await deleteBoard(alice, crypto.randomUUID())).status).toBe(404)
  expect((await deleteBoard(alice, space.id)).status).toBe(404)
})

test('建页面(含子页)不产生 board 行;页面树数据由 GET /api/pages 提供;置顶层 parent_id null 合法', async () => {
  await insertUser('alice', 'password-alice')
  const { alice } = await loginAll(['alice', 'password-alice'])
  const space = await createSpace(alice, '页面树空间')
  const p1 = await createPage(alice, { space_id: space.id })
  const p2 = await createPage(alice, { space_id: space.id, parent_id: p1.id })

  // 两页在，板块 0 行：页面树是派生视图，不是板块实体
  expect(await boardsOf(alice, space.id)).toEqual([])
  expect((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM boards')).rows[0]!.n).toBe(0)

  const pages = (await listPages(alice)).filter((p) => p.space_id === space.id)
  expect(pages.map((p) => p.id).sort()).toEqual([p1.id, p2.id].sort())
  expect(pages.find((p) => p.id === p2.id)!.parent_id).toBe(p1.id)

  // 顶层页（parent_id NULL）是合法渲染态；置顶层不产生任何板块行
  expect((await patchPage(alice, p2.id, { parent_id: null })).status).toBe(200)
  const after = (await listPages(alice)).filter((p) => p.space_id === space.id)
  expect(after.find((p) => p.id === p2.id)!.parent_id).toBeNull()
  expect(after.map((p) => p.id).sort()).toEqual([p1.id, p2.id].sort())
  expect(await boardsOf(alice, space.id)).toEqual([])
})

test('目录树行可见性:空间成员(任意角色)可见;非成员(含 admin)不可见,?view= 不再生效;树内容只在有行时下发', async () => {
  await insertUser('alice', 'password-alice')
  await insertUser('bob', 'password-bob')
  await insertUser('carol', 'password-carol')
  await insertUser('charlie', 'password-charlie')
  await insertUser('root', 'password-root', 'admin')
  const { alice, bob, carol, charlie, root } = await loginAll(
    ['alice', 'password-alice'],
    ['bob', 'password-bob'],
    ['carol', 'password-carol'],
    ['charlie', 'password-charlie'],
    ['root', 'password-root'],
  )
  const space = await createSpace(alice, '共享空间')
  await addMember(space.id, 'bob', 'member')
  await addMember(space.id, 'carol', 'viewer')
  const board = await dirTreeOf(alice, space.id)
  const folder = await createFolder(alice, board.id, { name: '共享目录' })

  expect(await boardsOf(bob, space.id)).toEqual([board])
  expect(await boardsOf(carol, space.id)).toEqual([board])
  // 非成员看不见（只含自己参与的空间）
  expect(await boardsOf(charlie, space.id)).toEqual([])
  // admin 不是成员：列表里没有；?view= 参数被忽略，照样只回自己参与的空间
  expect(await boardsOf(root, space.id)).toEqual([])
  const viewed = (await (await fetch(`${base}/api/boards?view=${space.id}`, { headers: { cookie: root } })).json()) as BoardsList
  expect(viewed.boards.map((b) => b.space_id)).not.toContain(space.id)
  expect(viewed.folders.map((f) => f.id)).not.toContain(folder.id)
  // folders 也只随目录树行下发：非成员的 folders 里没有该目录
  expect((await listBoards(bob)).folders.map((f) => f.id)).toContain(folder.id)
  expect((await listBoards(charlie)).folders.map((f) => f.id)).not.toContain(folder.id)
})

test('删目录树 —— 目录/条目级联清、树里的页面移入回收站(可恢复)、文件本体不动;删后补建 201 且目录为空', async () => {
  await insertUser('alice', 'password-alice')
  const { alice } = await loginAll(['alice', 'password-alice'])
  const space = await createSpace(alice, '级联空间')
  const board = await dirTreeOf(alice, space.id)
  const root = await createFolder(alice, board.id, { name: '根' })
  const sub = await createFolder(alice, board.id, { parent_id: root.id, name: '子' })
  const page = await createPage(alice, { space_id: space.id })
  const inFolder = await insertFile('in-folder.txt')
  const atRoot = await insertFile('at-root.txt')
  expect((await attach(alice, sub.id, 'page', page.id)).status).toBe(201)
  expect((await attach(alice, sub.id, 'file', inFolder)).status).toBe(201)
  expect((await attachRoot(alice, board.id, 'file', atRoot)).status).toBe(201)

  const del = await deleteBoard(alice, board.id)
  expect(del.status).toBe(200)
  // 树里挂的页面进回收站（响应是被盖章的 id 集）
  expect(del.body).toEqual({ trashed: [page.id] })

  const payload = await listBoards(alice)
  expect(await boardsOf(alice, space.id)).toEqual([])
  expect(payload.folders).toEqual([])
  expect(payload.items).toEqual([])
  // 页面本体在 pages 里、已被软删（不进活列表、进回收站）；文件行仍在
  expect((await listPages(alice)).map((p) => p.id)).not.toContain(page.id)
  const trashed = (await (await fetch(`${base}/api/pages/trash`, { headers: { cookie: alice } })).json()) as {
    id: string
  }[]
  expect(trashed.map((t) => t.id)).toContain(page.id)
  expect((await pool.query('SELECT 1 FROM files WHERE id = ANY($1::text[])', [[inFolder, atRoot]])).rows).toHaveLength(2)

  // 补建是新行新 id、空树：旧目录 / 条目不复活
  const again = await ensureDirTree(alice, space.id)
  expect(again.status).toBe(201)
  expect(again.body.board!.id).not.toBe(board.id)
  expect(await boardsOf(alice, space.id)).toEqual([again.body.board!])
  expect((await listBoards(alice)).folders).toEqual([])
  expect((await listBoards(alice)).items).toEqual([])
})

test('目录树写权限矩阵:viewer 可见不可写 403;非成员 404;member 可写(建/改/挂/删同口径)', async () => {
  await insertUser('alice', 'password-alice')
  await insertUser('bob', 'password-bob')
  await insertUser('carol', 'password-carol')
  await insertUser('mallory', 'password-mallory')
  const { alice, bob, carol, mallory } = await loginAll(
    ['alice', 'password-alice'],
    ['bob', 'password-bob'],
    ['carol', 'password-carol'],
    ['mallory', 'password-mallory'],
  )
  const space = await createSpace(alice, '矩阵空间')
  await addMember(space.id, 'bob', 'member')
  await addMember(space.id, 'carol', 'viewer')
  const board = await dirTreeOf(alice, space.id)
  const folder = await createFolder(alice, board.id, { name: '目录' })
  const page = await createPage(alice, { space_id: space.id })
  const fileId = await insertFile('m.txt')
  const item = await attach(alice, folder.id, 'file', fileId)
  expect(item.status).toBe(201)

  // viewer：树可见不可写
  expect(await boardsOf(carol, space.id)).toEqual([board])
  expect((await deleteBoard(carol, board.id)).status).toBe(403)
  expect((await postFolder(carol, board.id, { name: 'x' })).status).toBe(403)
  expect((await patchFolder(carol, folder.id, { name: 'x' })).status).toBe(403)
  expect((await attach(carol, folder.id, 'file', fileId)).status).toBe(403)
  expect((await attachRoot(carol, board.id, 'page', page.id)).status).toBe(403)
  expect((await patchItem(carol, item.body.id!, { index: 0 })).status).toBe(403)
  expect((await fetch(`${base}/api/folders/${folder.id}`, { method: 'DELETE', headers: { cookie: carol } })).status).toBe(403)

  // 非成员：不可见，写口一律 404（不泄露存在性）
  expect(await boardsOf(mallory, space.id)).toEqual([])
  expect((await deleteBoard(mallory, board.id)).status).toBe(404)
  expect((await postFolder(mallory, board.id, { name: 'x' })).status).toBe(404)
  expect((await patchFolder(mallory, folder.id, { name: 'x' })).status).toBe(404)
  expect((await attach(mallory, folder.id, 'page', page.id)).status).toBe(404)
  expect((await attachRoot(mallory, board.id, 'page', page.id)).status).toBe(404)

  // member 可写，viewer 读得到 member 的写入
  expect((await postFolder(bob, board.id, { name: 'member 目录' })).status).toBe(201)
  expect((await patchFolder(bob, folder.id, { name: 'member 改名' })).status).toBe(200)
  expect((await attach(bob, folder.id, 'page', page.id)).status).toBe(201)
  expect((await fetch(`${base}/api/folder-items/${item.body.id}`, { method: 'DELETE', headers: { cookie: bob } })).status).toBe(200)
  const seen = await listBoards(carol)
  expect(seen.folders.map((f) => f.name)).toContain('member 改名')
  expect(seen.items.some((i) => i.item_id === page.id)).toBe(true)
})

test('目录嵌套、改名、跨父移动、防环 400、跨空间 parent 400', async () => {
  await insertUser('alice', 'password-alice')
  const { alice } = await loginAll(['alice', 'password-alice'])
  const spaceA = await createSpace(alice, '空间 A')
  const spaceB = await createSpace(alice, '空间 B')
  const board = await dirTreeOf(alice, spaceA.id)
  const root = await createFolder(alice, board.id, { name: '根' })
  const child = await createFolder(alice, board.id, { parent_id: root.id, name: '子' })
  const grand = await createFolder(alice, board.id, { parent_id: child.id, name: '孙' })

  // 改名 200 且库中生效
  expect((await patchFolder(alice, child.id, { name: '子改' })).status).toBe(200)
  expect((await listBoards(alice)).folders.find((f) => f.id === child.id)!.name).toBe('子改')

  // 移动到顶层(parent null)
  const move = await patchFolder(alice, grand.id, { parent_id: null })
  expect(move.status).toBe(200)
  expect(move.body.parent_id).toBeNull()
  expect((await listBoards(alice)).folders.find((f) => f.id === grand.id)!.parent_id).toBeNull()

  // 防环：父落进自己子孙 / 自引用 → 400
  expect((await patchFolder(alice, root.id, { parent_id: child.id })).status).toBe(400)
  expect((await patchFolder(alice, root.id, { parent_id: root.id })).status).toBe(400)

  // 跨空间 parent（属于另一目录树行）→ 400（建目录与移动同口径）
  const other = await dirTreeOf(alice, spaceB.id)
  const foreign = await createFolder(alice, other.id, { name: '别空间目录' })
  expect((await patchFolder(alice, root.id, { parent_id: foreign.id })).status).toBe(400)
  expect((await postFolder(alice, board.id, { parent_id: foreign.id, name: 'x' })).status).toBe(400)
  // 不存在的 parent 同 400
  expect((await postFolder(alice, board.id, { parent_id: crypto.randomUUID(), name: 'x' })).status).toBe(400)
})

test('挂载页面与文件;重复挂载 = 移动(单归属);挂他人不可见页面 400(admin 也是);', async () => {
  await insertUser('alice', 'password-alice')
  await insertUser('bob', 'password-bob')
  await insertUser('root', 'password-root', 'admin')
  const { alice, bob, root } = await loginAll(
    ['alice', 'password-alice'],
    ['bob', 'password-bob'],
    ['root', 'password-root'],
  )

  const personal = await personalSpaceId(alice)
  const board = await dirTreeOf(alice, personal)
  const f1 = await createFolder(alice, board.id, { name: '一' })
  const f2 = await createFolder(alice, board.id, { name: '二' })
  const page = await createPage(alice)
  const fileId = await insertFile('doc.txt')

  expect((await attach(alice, f1.id, 'page', page.id)).status).toBe(201)
  expect((await attach(alice, f1.id, 'file', fileId)).status).toBe(201)

  // B 挂 A 的页面（不可见）→ 400；往 A 的目录挂东西 → 404
  const bobBoard = await dirTreeOf(bob, await personalSpaceId(bob))
  const bobFolder = await createFolder(bob, bobBoard.id, { name: 'B目录' })
  expect((await attach(bob, bobFolder.id, 'page', page.id)).status).toBe(400)
  expect((await attach(bob, f1.id, 'file', fileId)).status).toBe(404)

  // 单归属移动：同一页面再挂到 f2，仍只一条 folder_items，落在 f2
  expect((await attach(alice, f2.id, 'page', page.id)).status).toBe(201)
  expect(
    await pool.query('SELECT folder_id FROM folder_items WHERE kind = $1 AND item_id = $2', ['page', page.id]).then((r) => r.rows),
  ).toEqual([{ folder_id: f2.id }])

  // 列表回读：页面条目带 title，文件条目带 name / mime（字段按 kind 单侧填充）
  const payload = await listBoards(alice)
  expect(payload.items.find((i) => i.item_id === page.id)?.title).toBe(page.title)
  expect(payload.items.find((i) => i.item_id === fileId)).toMatchObject({ name: 'doc.txt', mime: 'text/plain', title: null })

  // admin 也不能把他人空间的页面挂进自己的目录（挂进去标题就进了自己的目录树列表）
  const adminBoard = await dirTreeOf(root, await personalSpaceId(root))
  const adminFolder = await createFolder(root, adminBoard.id, { name: '管目录' })
  const page2 = await createPage(alice)
  expect((await attach(root, adminFolder.id, 'page', page2.id)).status).toBe(400)

  // 不存在的页面 / 文件 → 400；脱挂 200
  expect((await attach(alice, f1.id, 'page', 'no-such-page')).status).toBe(400)
  expect((await attach(alice, f1.id, 'file', 'no-such-file')).status).toBe(400)
  const delRes = await fetch(`${base}/api/folder-items/${(await attach(alice, f1.id, 'page', page.id)).body.id}`, {
    method: 'DELETE',
    headers: { cookie: alice },
  })
  expect(delRes.status).toBe(200)
})

test('删除目录:子树里页面移入回收站(可恢复)、文件只脱挂;页面进垃圾箱后条目不再入树', async () => {
  await insertUser('alice', 'password-alice')
  const { alice } = await loginAll(['alice', 'password-alice'])
  const personal = await personalSpaceId(alice)
  const board = await dirTreeOf(alice, personal)
  const root = await createFolder(alice, board.id, { name: '根' })
  const sub = await createFolder(alice, board.id, { parent_id: root.id, name: '子' })
  const page = await createPage(alice)
  const fileId = await insertFile('keep.txt')
  await attach(alice, sub.id, 'page', page.id)
  await attach(alice, sub.id, 'file', fileId)

  // 删根目录：子目录与条目一起消失，子目录里挂的页面进回收站
  const del = await fetch(`${base}/api/folders/${root.id}`, { method: 'DELETE', headers: { cookie: alice } })
  expect(del.status).toBe(200)
  expect((await del.json()) as { trashed: string[] }).toEqual({ trashed: [page.id] })
  const payload = await listBoards(alice)
  expect(payload.folders.map((f) => f.id)).not.toContain(sub.id)
  expect(payload.items).toHaveLength(0)
  // 页面行仍在（已被软删，可恢复）；文件本体不动
  expect((await pool.query('SELECT 1 FROM files WHERE id = $1', [fileId])).rows).toHaveLength(1)
  expect(
    (await pool.query<{ deleted_at: string | null }>('SELECT deleted_at FROM pages WHERE id = $1', [page.id])).rows[0]!
      .deleted_at,
  ).toBeTruthy()
  // 恢复后回到页面树顶层,可重新挂载
  expect((await fetch(`${base}/api/pages/${page.id}/restore`, { method: 'POST', headers: { cookie: alice } })).status).toBe(200)
  const folder2 = await createFolder(alice, board.id, { name: '再建' })
  expect((await attach(alice, folder2.id, 'page', page.id)).status).toBe(201)

  // 页面进垃圾箱（软删）：条目从树里消失，pages 行仍在
  expect((await fetch(`${base}/api/pages/${page.id}/trash`, { method: 'POST', headers: { cookie: alice } })).status).toBe(200)
  const after = await listBoards(alice)
  expect(after.items.map((i) => i.item_id)).not.toContain(page.id)
  expect(
    (await pool.query<{ deleted_at: string | null }>('SELECT deleted_at FROM pages WHERE id = $1', [page.id])).rows[0]!
      .deleted_at,
  ).toBeTruthy()
})

test('根级挂载:PUT /api/boards/:id/items 落 folder_id NULL;移动保持 board_id;删板级联;不可见的板 404', async () => {
  await insertUser('alice', 'password-alice')
  await insertUser('mallory', 'password-mallory')
  const { alice, mallory } = await loginAll(['alice', 'password-alice'], ['mallory', 'password-mallory'])
  const space = await createSpace(alice, '根级空间')
  const board = await dirTreeOf(alice, space.id)
  const fileId = await insertFile('root.txt')
  const page = await createPage(alice, { space_id: space.id })

  // 根级挂文件
  const put = await attachRoot(alice, board.id, 'file', fileId)
  expect(put.status).toBe(201)
  expect(put.body.folder_id).toBeNull()

  // 不存在的板（页面树没有行）与别人空间的板同 404
  expect((await attachRoot(alice, crypto.randomUUID(), 'page', page.id)).status).toBe(404)
  const malloryBoard = await dirTreeOf(mallory, await personalSpaceId(mallory))
  expect((await attachRoot(alice, malloryBoard.id, 'page', page.id)).status).toBe(404)

  // 根级挂页面 + 列表带出两条根级条目
  expect((await attachRoot(alice, board.id, 'page', page.id)).status).toBe(201)
  const roots = (await listBoards(alice)).items.filter((it) => it.folder_id === null && it.board_id === board.id)
  expect(roots).toHaveLength(2)

  // 移动根级条目进目录：board_id 不变
  const folder = await createFolder(alice, board.id, { name: '收纳' })
  const moveRes = await patchItem(alice, put.body.id!, { folder_id: folder.id })
  expect(moveRes.status).toBe(200)
  expect(moveRes.body.folder_id).toBe(folder.id)
  expect(
    (await pool.query<{ board_id: string }>('SELECT board_id FROM folder_items WHERE id = $1', [put.body.id!])).rows[0]!
      .board_id,
  ).toBe(board.id)

  // 删板块：根级与目录级条目一并级联，本体不动
  expect((await deleteBoard(alice, board.id)).status).toBe(200)
  expect((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM folder_items')).rows[0]!.n).toBe(0)
  expect((await pool.query('SELECT 1 FROM files WHERE id = $1', [fileId])).rows).toHaveLength(1)
  expect((await pool.query('SELECT 1 FROM pages WHERE id = $1', [page.id])).rows).toHaveLength(1)
})

test('根级条目排序:PATCH {index} 对 folder_id NULL 生效(IS NOT DISTINCT FROM);挪回顶层按 index 插入', async () => {
  await insertUser('carol', 'password-carol')
  const { carol } = await loginAll(['carol', 'password-carol'])
  const personal = await personalSpaceId(carol)
  const board = await dirTreeOf(carol, personal)

  const ids: string[] = []
  const fileIds: string[] = []
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    const fileId = await insertFile(name)
    const put = await attachRoot(carol, board.id, 'file', fileId)
    expect(put.status).toBe(201)
    fileIds.push(fileId)
    ids.push(put.body.id!)
  }

  const roots = async (): Promise<string[]> =>
    (await listBoards(carol)).items.filter((it) => it.folder_id === null && it.board_id === board.id).map((it) => it.id)

  // 纯根级重排（不带 folder_id）：第 3 个挪到最前
  expect((await patchItem(carol, ids[2]!, { index: 0 })).status).toBe(200)
  expect(await roots()).toEqual([ids[2], ids[0], ids[1]])

  // 挪进目录再拖回顶层（index 为目标位置）
  const folder = await createFolder(carol, board.id, { name: '收纳' })
  expect((await attach(carol, folder.id, 'file', fileIds[0]!)).status).toBe(201)
  const back = await patchItem(carol, ids[0]!, { folder_id: null, index: 1 })
  expect(back.status).toBe(200)
  expect(back.body.folder_id).toBeNull()
  expect(await roots()).toEqual([ids[2], ids[0], ids[1]])
})

test('根级重排隔离:别的板块(别的空间)的根级条目不被一起重写(排序 scope 圈板块)', async () => {
  await insertUser('carol', 'password-carol')
  const { carol } = await loginAll(['carol', 'password-carol'])
  const spaceA = await createSpace(carol, '排序空间 A')
  const spaceB = await createSpace(carol, '排序空间 B')
  const boardA = await dirTreeOf(carol, spaceA.id)
  const boardB = await dirTreeOf(carol, spaceB.id)

  const putFile = async (boardId: string, name: string): Promise<{ id: string }> => {
    const put = await attachRoot(carol, boardId, 'file', await insertFile(name))
    expect(put.status).toBe(201)
    return { id: put.body.id! }
  }
  const a1 = await putFile(boardA.id, 'a1.txt')
  const a2 = await putFile(boardA.id, 'a2.txt')
  const b1 = await putFile(boardB.id, 'b1.txt')

  // 板 A 根级第 2 个挪到最前：只重排板 A 的根级条目
  expect((await patchItem(carol, a2.id, { index: 0 })).status).toBe(200)
  const payload = await listBoards(carol)
  const rootsOf = (boardId: string) =>
    payload.items.filter((it) => it.folder_id === null && it.board_id === boardId).map((it) => it.id)
  expect(rootsOf(boardA.id)).toEqual([a2.id, a1.id])
  expect(rootsOf(boardB.id)).toEqual([b1.id])
  // 板 B 根级条目的 position 原样（NULL）：没被别板的重排顺带改写
  expect(
    (await pool.query<{ position: number | null }>('SELECT position FROM folder_items WHERE id = $1', [b1.id])).rows[0]!
      .position,
  ).toBeNull()
})

test('页面恒属空间:spaceless 创建被拒;目录树文档落所属空间且成员可见;删除进回收站可恢复', async () => {
  await insertUser('dave', 'password-dave')
  await insertUser('eve', 'password-eve')
  const { dave, eve } = await loginAll(['dave', 'password-dave'], ['eve', 'password-eve'])

  // 无空间页面在模型上不可达：显式 space_id: null 被拒
  expect((await fetch(`${base}/api/pages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: dave },
    body: JSON.stringify({ space_id: null }),
  })).status).toBe(400)

  // 目录树“创建文档”是在所属空间建顶层页：space_id 为该空间，parent_id NULL
  const daveSpace = await personalSpaceId(dave)
  const created = await createPage(dave, { space_id: daveSpace })
  expect(created.space_id).toBe(daveSpace)
  const board = await dirTreeOf(dave, daveSpace)
  expect((await attachRoot(dave, board.id, 'page', created.id)).status).toBe(201)

  // 该空间成员可见（不止 owner）：邀请 eve 入共享空间后 eve 能读
  const viewable = await createSpace(dave, '共享空间')
  const shared = await createPage(dave, { space_id: viewable.id })
  const inv = await fetch(`${base}/api/spaces/${viewable.id}/invites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: dave },
    body: JSON.stringify({ role: 'member' }),
  })
  const inviteBody = (await inv.json()) as { token: string }
  await fetch(`${base}/api/invites/${inviteBody.token}/accept`, { method: 'POST', headers: { cookie: eve } })
  expect((await fetch(`${base}/api/pages/${shared.id}/updates`, { headers: { cookie: eve } })).status).toBe(200)

  // 删除即移入回收站；本空间回收站可见；可恢复
  expect((await fetch(`${base}/api/pages/${created.id}/trash`, { method: 'POST', headers: { cookie: dave } })).status).toBe(200)
  const daveTrash = (await (await fetch(`${base}/api/pages/trash`, { headers: { cookie: dave } })).json()) as { id: string }[]
  expect(daveTrash.map((t) => t.id)).toContain(created.id)
  expect((await fetch(`${base}/api/pages/${created.id}/restore`, { method: 'POST', headers: { cookie: dave } })).status).toBe(200)
  expect((await fetch(`${base}/api/pages/${created.id}/updates`, { headers: { cookie: dave } })).status).toBe(200)
})

test('目录树文档属于空间但不进页面树；子孙跟着排除；存量顶层挂载启动时迁出页面树', async () => {
  await insertUser('dave', 'password-dave')
  const { dave } = await loginAll(['dave', 'password-dave'])
  const spaceId = await personalSpaceId(dave)

  const bad = await fetch(`${base}/api/pages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: dave },
    body: JSON.stringify({ space_id: spaceId, in_page_tree: 'no' }),
  })
  expect(bad.status).toBe(400)

  const doc = await createPage(dave, { space_id: spaceId, in_page_tree: false })
  expect(doc.in_page_tree).toBe(false)
  expect(doc.space_id).toBe(spaceId)
  expect(doc.parent_id).toBeNull()
  // 子页自己的标记仍是缺省 true；是否进页面树看祖先，不靠列继承
  const child = await createPage(dave, { space_id: spaceId, parent_id: doc.id })
  expect(child.in_page_tree).toBe(true)
  const normal = await createPage(dave, { space_id: spaceId })
  expect(normal.in_page_tree).toBe(true)

  const listed = await listPages(dave)
  expect(listed.map((p) => p.id)).toEqual(expect.arrayContaining([doc.id, child.id, normal.id]))
  expect(pagesInPageTree(listed.filter((p) => p.space_id === spaceId)).map((p) => p.id)).toEqual([normal.id])

  // 存量：顶层且已挂进目录树的页，下次启动收编为非页面树成员。有父的挂载、未挂载的顶层页不动
  const legacy = await createPage(dave, { space_id: spaceId })
  const nested = await createPage(dave, { space_id: spaceId, parent_id: normal.id })
  const board = await dirTreeOf(dave, spaceId)
  // 存量挂载直接写库：现在的挂载接口会顺手把页移出页面树，模拟不出老数据
  await pool.query(`INSERT INTO folder_items (id, board_id, kind, item_id) VALUES ($1, $2, 'page', $3), ($4, $2, 'page', $5)`,
    [crypto.randomUUID(), board.id, legacy.id, crypto.randomUUID(), nested.id])
  await initDb(pool)
  const flags = await pool.query<{ id: string; in_page_tree: boolean }>(
    'SELECT id, in_page_tree FROM pages WHERE id = ANY($1::text[])',
    [[doc.id, legacy.id, nested.id, normal.id]],
  )
  const flagOf = (id: string) => flags.rows.find((r) => r.id === id)!.in_page_tree
  expect(flagOf(doc.id)).toBe(false)
  expect(flagOf(legacy.id)).toBe(false)
  expect(flagOf(nested.id)).toBe(true)
  expect(flagOf(normal.id)).toBe(true)
})

test('页面树顶层页(parent_id NULL)合法:任意深度置顶层 200、页面仍在列表;跨空间 parent 仍 400', async () => {
  await insertUser('alice', 'password-alice')
  const { alice } = await loginAll(['alice', 'password-alice'])
  const space = await createSpace(alice, '顶层空间')
  const p1 = await createPage(alice, { space_id: space.id })
  const p2 = await createPage(alice, { space_id: space.id, parent_id: p1.id })
  const leaf = await createPage(alice, { space_id: space.id, parent_id: p2.id })

  expect((await patchPage(alice, p2.id, { parent_id: null })).status).toBe(200)
  expect((await patchPage(alice, leaf.id, { parent_id: null })).status).toBe(200)
  const rows = await pool.query<{ parent_id: string | null }>('SELECT parent_id FROM pages WHERE id = ANY($1::text[])', [
    [p2.id, leaf.id],
  ])
  expect(rows.rows.every((r) => r.parent_id === null)).toBe(true)

  // 回归点：置顶层后页面仍在列表（空间页面树是全部 pages，parent 指向不决定可见性）
  const listed = await listPages(alice)
  expect(listed.map((p) => p.id)).toEqual(expect.arrayContaining([p1.id, p2.id, leaf.id]))
  // 页面树始终不产生板块行
  expect(await boardsOf(alice, space.id)).toEqual([])

  // 挂回有父同样放行
  expect((await patchPage(alice, leaf.id, { parent_id: p1.id })).status).toBe(200)
  // 跨空间仍拒（页面属于空间）
  const other = await createSpace(alice, '别处')
  const far = await createPage(alice, { space_id: other.id })
  expect((await patchPage(alice, leaf.id, { parent_id: far.id })).status).toBe(400)
})

test('迁移 v3 → v4:kind 列与 page_tree 行消失、UNIQUE(space_id) 回装、目录树行与内容保留、重跑幂等', async () => {
  await insertUser('alice', 'password-alice')
  const { alice } = await loginAll(['alice', 'password-alice'])
  const space = await createSpace(alice, '迁移空间')

  // 造 v3 形态：boards 回装 kind 列 + UNIQUE(space_id, kind)，去掉当前的 UNIQUE(space_id)
  await pool.query(`ALTER TABLE boards DROP CONSTRAINT IF EXISTS boards_space,
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'folder_tree'`)
  await pool.query('ALTER TABLE boards ADD CONSTRAINT boards_space_kind UNIQUE (space_id, kind)')
  const folderTreeId = crypto.randomUUID()
  const pageTreeId = crypto.randomUUID()
  await pool.query('INSERT INTO boards (id, space_id, kind) VALUES ($1, $2, $3), ($4, $2, $5)', [
    folderTreeId,
    space.id,
    'folder_tree',
    pageTreeId,
    'page_tree',
  ])
  const folderId = crypto.randomUUID()
  await pool.query('INSERT INTO folders (id, board_id, name) VALUES ($1, $2, $3)', [folderId, folderTreeId, '迁移目录'])

  await migrateBoardsV4(pool)

  // v3 独有列与旧约束消失；迁移后形状是 {id, space_id, created_at} + UNIQUE(space_id)
  expect(await boardColumns()).toEqual(['created_at', 'id', 'space_id'])
  expect(await boardUniqueConstraints()).toEqual([['boards_space', 'UNIQUE (space_id)']])
  // 页面树行整类删除（没有实体）；目录树行与其目录保留
  expect(await boardIds()).toEqual([folderTreeId])
  expect((await pool.query('SELECT 1 FROM folders WHERE id = $1', [folderId])).rows).toHaveLength(1)
  expect(await boardsOf(alice, space.id)).toEqual([
    expect.objectContaining({ id: folderTreeId, space_id: space.id }),
  ])

  // 幂等可重跑，状态不变
  await migrateBoardsV4(pool)
  expect(await boardIds()).toEqual([folderTreeId])
  expect(await boardColumns()).toEqual(['created_at', 'id', 'space_id'])
  expect(await boardUniqueConstraints()).toEqual([['boards_space', 'UNIQUE (space_id)']])
  // 迁移后约束真的生效
  await expect(
    pool.query('INSERT INTO boards (id, space_id) VALUES ($1, $2)', [crypto.randomUUID(), space.id]),
  ).rejects.toThrow(/boards_space|duplicate key/)
})

test('迁移 v2 → v4:包装根页收编(子页提顶层/根页回收站)、多目录树去重留条目最多者、v2 列全删、幂等', async () => {
  await insertUser('alice', 'password-alice')
  const { alice } = await loginAll(['alice', 'password-alice'])
  const space = await createSpace(alice, 'v2 迁移空间')
  const uid = (await pool.query<{ id: string }>('SELECT id FROM users WHERE username = $1', ['alice'])).rows[0]!.id

  // v2 包装根页：页面树由 root_page_id 指向的根页承载，真内容是它的子页
  const root = await createPage(alice, { space_id: space.id })
  const child = await createPage(alice, { space_id: space.id, parent_id: root.id })

  // 造 v2 形态：user_id / name NOT NULL、position / root_page_id / kind；无 UNIQUE(space_id)（v2 允许同类多板）
  await pool.query(`ALTER TABLE boards DROP CONSTRAINT IF EXISTS boards_space,
    ADD COLUMN kind TEXT, ADD COLUMN user_id TEXT, ADD COLUMN name TEXT NOT NULL DEFAULT '旧板',
    ADD COLUMN position INTEGER, ADD COLUMN root_page_id TEXT`)
  await pool.query('UPDATE boards SET user_id = $1', [uid])
  await pool.query('ALTER TABLE boards ALTER COLUMN user_id SET NOT NULL, ALTER COLUMN name DROP DEFAULT')
  const keep = crypto.randomUUID()
  const doomed = crypto.randomUUID()
  const pageTreeId = crypto.randomUUID()
  await pool.query(
    `INSERT INTO boards (id, user_id, name, kind, space_id, root_page_id, position) VALUES
     ($1, $2, '旧板 A', 'folder_tree', $3, NULL, 0),
     ($4, $2, '旧板 B', 'folder_tree', $3, NULL, 1),
     ($5, $2, '页面树', 'page_tree', $3, $6, NULL)`,
    [keep, uid, space.id, doomed, pageTreeId, root.id],
  )
  // 去重判据是挂载条目数：给 A 挂一条，B 空，A 留下
  await pool.query(`INSERT INTO folder_items (id, board_id, kind, item_id) VALUES ($1, $2, 'file', $3)`, [
    crypto.randomUUID(),
    keep,
    crypto.randomUUID(),
  ])

  await migrateBoardsV4(pool)

  // 包装根页收编：子页提空间顶层；根页进回收站（可恢复）
  expect((await pool.query<{ parent_id: string | null }>('SELECT parent_id FROM pages WHERE id = $1', [child.id])).rows[0]!.parent_id).toBeNull()
  expect((await pool.query<{ deleted_at: string | null }>('SELECT deleted_at FROM pages WHERE id = $1', [root.id])).rows[0]!.deleted_at).toBeTruthy()
  // 去重：只剩挂着条目的那行；页面树行消失
  expect(await boardIds()).toEqual([keep])
  // v2 独有列与旧约束全删
  expect(await boardColumns()).toEqual(['created_at', 'id', 'space_id'])
  expect(await boardUniqueConstraints()).toEqual([['boards_space', 'UNIQUE (space_id)']])
  // 被淘汰板的条目随行级联（页面 / 文件本体不动）；留下的板内容原样
  const items = await pool.query<{ board_id: string }>('SELECT board_id FROM folder_items')
  expect(items.rows.map((r) => r.board_id)).toEqual([keep])

  // 幂等可重跑
  await migrateBoardsV4(pool)
  expect(await boardIds()).toEqual([keep])
  expect(await boardColumns()).toEqual(['created_at', 'id', 'space_id'])
  expect((await pool.query<{ parent_id: string | null }>('SELECT parent_id FROM pages WHERE id = $1', [child.id])).rows[0]!.parent_id).toBeNull()
})

test('迁移:无空间有主页面归位个人空间、跨空间父子顶层化、遗留无主行不动、幂等', async () => {
  await insertUser('alice', 'password-alice')
  const { alice } = await loginAll(['alice', 'password-alice'])
  const personal = await personalSpaceId(alice)
  const spaceA = await createSpace(alice, '甲空间')
  const spaceB = await createSpace(alice, '乙空间')
  const owner = (await pool.query<{ id: string }>('SELECT id FROM users WHERE username = $1', ['alice'])).rows[0]!.id

  // 有主的无空间行（游离文档，顶层）：应归位到 owner 个人空间
  const freeId = crypto.randomUUID()
  await pool.query('INSERT INTO pages (id, owner_id, space_id, parent_id) VALUES ($1, $2, NULL, NULL)', [freeId, owner])
  // 跨空间父子：子页在甲，父页在乙，子页顶层化（否则父子链绕开空间可见性边界）
  const parentB = await createPage(alice, { space_id: spaceB.id })
  const childAId = crypto.randomUUID()
  await pool.query('INSERT INTO pages (id, owner_id, space_id, parent_id) VALUES ($1, $2, $3, $4)', [
    childAId,
    owner,
    spaceA.id,
    parentB.id,
  ])
  // 遗留无主行（owner 也 NULL）：不动（谁都看不到，不变量的唯一例外）
  const orphanId = crypto.randomUUID()
  await pool.query('INSERT INTO pages (id, owner_id, space_id, parent_id) VALUES ($1, NULL, NULL, NULL)', [orphanId])

  await initDb(pool)

  const rows = await pool.query<{ id: string; space_id: string | null; parent_id: string | null }>(
    'SELECT id, space_id, parent_id FROM pages WHERE id = ANY($1::text[])',
    [[freeId, childAId, orphanId]],
  )
  const byId = new Map(rows.rows.map((r) => [r.id, r]))
  expect(byId.get(freeId)!.space_id).toBe(personal)
  expect(byId.get(freeId)!.parent_id).toBeNull()
  expect(byId.get(childAId)!.space_id).toBe(spaceA.id)
  expect(byId.get(childAId)!.parent_id).toBeNull()
  expect(byId.get(orphanId)!.space_id).toBeNull()

  // 幂等：重跑状态不变
  await initDb(pool)
  expect(
    (await pool.query<{ space_id: string | null }>('SELECT space_id FROM pages WHERE id = $1', [freeId])).rows[0]!.space_id,
  ).toBe(personal)
})
