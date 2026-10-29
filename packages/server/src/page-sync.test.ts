import { afterAll, beforeEach, expect, test } from 'vitest'
import { comparePages } from '@ramet/shared/page-tree'
import { closePool, getPool, initDb } from './db.js'
import { startServer } from './index.js'
import { hashPassword, SESSION_COOKIE } from './auth.js'
import { prunePageChanges } from './page-sync.js'
import { truncateAll } from './test-helpers.js'

// 页面列表增量同步：变更日志由 pages 上的触发器采集，游标 = 读取快照的 xmin。
// 合并后的列表必须与 GET /api/pages 整表逐字段相等，别的空间的页 id 不出现，晚提交的事务不漏，正文存盘不产生日志

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

type Page = { id: string; parent_id: string | null; created_at: string; position: number | null; title: string; space_id: string }
type Sync = { cursor: string; members: string; full?: Page[]; up?: Page[]; rm?: string[] }

async function login(username: string): Promise<{ cookie: string; id: string }> {
  const id = crypto.randomUUID()
  await pool.query('INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)', [id, username, hashPassword('pw-123456'), 'user'])
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'pw-123456' }),
  })
  expect(res.status).toBe(200)
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  if (!cookie?.startsWith(`${SESSION_COOKIE}=`)) throw new Error('登录未返回会话 cookie')
  return { cookie, id }
}

async function call(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: any; bytes: number }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, data: text ? JSON.parse(text) : null, bytes: Buffer.byteLength(text) }
}

async function sync(cookie: string, since?: { cursor: string; members: string }): Promise<Sync> {
  const q = since ? `?${new URLSearchParams({ since: since.cursor, members: since.members })}` : ''
  const r = await call(cookie, 'GET', `/api/pages/sync${q}`)
  expect(r.status).toBe(200)
  return r.data
}

/** 客户端的合并，同 web page-sync.ts 的 applyPageSync */
function merge(cur: Page[], res: Sync): Page[] {
  if (res.full) return res.full
  const byId = new Map(cur.map((p) => [p.id, p]))
  for (const id of res.rm ?? []) byId.delete(id)
  for (const p of res.up ?? []) byId.set(p.id, p)
  return [...byId.values()].sort(comparePages)
}

/** 一个客户端：持有列表与游标 */
async function client(cookie: string) {
  let res = await sync(cookie)
  expect(res.full).toBeDefined()
  let pages = res.full!
  let mark = { cursor: res.cursor, members: res.members }
  return {
    /** 增量同步一次，断言是增量且合并结果与整表相等 */
    async step(): Promise<{ up: string[]; rm: string[] }> {
      res = await sync(cookie, mark)
      expect(res.full).toBeUndefined()
      pages = merge(pages, res)
      mark = { cursor: res.cursor, members: res.members }
      const whole = await call(cookie, 'GET', '/api/pages')
      expect(pages).toEqual(whole.data)
      return { up: (res.up ?? []).map((p) => p.id).sort(), rm: [...(res.rm ?? [])].sort() }
    },
    async raw(): Promise<Sync> {
      res = await sync(cookie, mark)
      if (!res.full) pages = merge(pages, res)
      else pages = res.full
      mark = { cursor: res.cursor, members: res.members }
      return res
    },
    mark: () => mark,
  }
}

async function sharedSpace(ownerId: string, name: string): Promise<string> {
  const id = crypto.randomUUID()
  await pool.query('INSERT INTO spaces (id, name, owner_id) VALUES ($1, $2, $3)', [id, name, ownerId])
  await pool.query(`INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, ownerId])
  return id
}

test('建 / 改名 / 移动 / 图标 / 回收 / 恢复 / 物理删除：每次只下发该页，合并后与整表相等', async () => {
  const { cookie } = await login('alice')
  const a = (await call(cookie, 'POST', '/api/pages', {})).data
  const c = await client(cookie)
  expect(await c.step()).toEqual({ up: [], rm: [] })

  const b = (await call(cookie, 'POST', '/api/pages', {})).data
  expect(await c.step()).toEqual({ up: [b.id], rm: [] })

  expect((await call(cookie, 'PATCH', `/api/pages/${b.id}`, { title: '新名字' })).status).toBe(200)
  expect(await c.step()).toEqual({ up: [b.id], rm: [] })

  expect((await call(cookie, 'PATCH', `/api/pages/${b.id}`, { parent_id: a.id })).status).toBe(200)
  expect(await c.step()).toEqual({ up: [b.id], rm: [] })

  expect((await call(cookie, 'PATCH', `/api/pages/${a.id}`, { icon: { kind: 'emoji', value: '📌' } })).status).toBe(200)
  expect(await c.step()).toEqual({ up: [a.id], rm: [] })

  // 回收父页，整棵子树一起摘掉
  expect((await call(cookie, 'POST', `/api/pages/${a.id}/trash`)).status).toBeLessThan(300)
  expect(await c.step()).toEqual({ up: [], rm: [a.id, b.id].sort() })

  expect((await call(cookie, 'POST', `/api/pages/${a.id}/restore`)).status).toBeLessThan(300)
  expect(await c.step()).toEqual({ up: [a.id, b.id].sort(), rm: [] })

  // 物理删除含外键级联的子页
  expect((await call(cookie, 'DELETE', `/api/pages/${a.id}`)).status).toBe(200)
  expect(await c.step()).toEqual({ up: [], rm: [a.id, b.id].sort() })
})

test('正文存盘（content_text / agent_session / content_updated_at）不产生日志；同值 UPDATE 也不产生', async () => {
  const { cookie } = await login('bob')
  const p = (await call(cookie, 'POST', '/api/pages', {})).data
  const before = (await pool.query('SELECT count(*)::int AS n FROM page_changes')).rows[0].n
  await pool.query(`UPDATE pages SET content_text = 'x', content_updated_at = now()::text, agent_session = '{}'::jsonb WHERE id = $1`, [p.id])
  await pool.query('UPDATE pages SET title = title WHERE id = $1', [p.id])
  expect((await pool.query('SELECT count(*)::int AS n FROM page_changes')).rows[0].n).toBe(before)
  await pool.query('UPDATE pages SET position = 3 WHERE id = $1', [p.id])
  expect((await pool.query('SELECT count(*)::int AS n FROM page_changes')).rows[0].n).toBe(before + 1)
})

test('不泄露：别的空间里的改动不出现；换空间时进出两边各自正确', async () => {
  const alice = await login('alice')
  const bob = await login('bob')
  await call(alice.cookie, 'POST', '/api/pages', {})
  await call(bob.cookie, 'POST', '/api/pages', {})
  const shared = await sharedSpace(alice.id, '共享')
  const bobOnly = await sharedSpace(bob.id, 'bob 独有')
  await pool.query(`INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'member')`, [shared, bob.id])
  const c = await client(alice.cookie)

  // bob 在自己独有的空间里建页、改名，alice 看不到任何 id
  const secret = (await call(bob.cookie, 'POST', '/api/pages', { space_id: bobOnly })).data
  await call(bob.cookie, 'PATCH', `/api/pages/${secret.id}`, { title: '秘密' })
  expect(await c.step()).toEqual({ up: [], rm: [] })

  const sp = (await call(bob.cookie, 'POST', '/api/pages', { space_id: shared })).data
  expect(await c.step()).toEqual({ up: [sp.id], rm: [] })

  // 从共享空间换到 bob 独有的空间，alice 收到 rm
  await pool.query('UPDATE pages SET space_id = $1 WHERE id = $2', [bobOnly, sp.id])
  expect(await c.step()).toEqual({ up: [], rm: [sp.id] })
  // 再在 bob 独有空间里改，与 alice 无关
  await call(bob.cookie, 'PATCH', `/api/pages/${sp.id}`, { title: '换走之后' })
  expect(await c.step()).toEqual({ up: [], rm: [] })
  await pool.query('UPDATE pages SET space_id = $1 WHERE id = $2', [shared, sp.id])
  expect(await c.step()).toEqual({ up: [sp.id], rm: [] })
})

test('空间成员关系变了（加入 / 退出 / 空间被删）→ 整表', async () => {
  const alice = await login('alice')
  const bob = await login('bob')
  await call(alice.cookie, 'POST', '/api/pages', {})
  const space = await sharedSpace(bob.id, 'bob 的共享')
  await call(bob.cookie, 'POST', '/api/pages', { space_id: space })
  const c = await client(alice.cookie)

  await pool.query(`INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'viewer')`, [space, alice.id])
  const joined = await c.raw()
  expect(joined.full).toBeDefined()
  expect(joined.full!.some((p) => p.space_id === space)).toBe(true)
  expect((await c.raw()).full).toBeUndefined()

  await pool.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [space, alice.id])
  const left = await c.raw()
  expect(left.full).toBeDefined()
  expect(left.full!.some((p) => p.space_id === space)).toBe(false)
})

test('不漏：先拿到事务号、晚于这次同步提交的事务，下一次同步仍拿到', async () => {
  const { cookie } = await login('carol')
  const p = (await call(cookie, 'POST', '/api/pages', {})).data
  const q = (await call(cookie, 'POST', '/api/pages', {})).data
  const c = await client(cookie)

  const slow = await pool.connect()
  try {
    await slow.query('BEGIN')
    await slow.query('UPDATE pages SET title = $1 WHERE id = $2', ['慢事务', p.id])
    // 别的事务在它之后拿号、先提交
    await call(cookie, 'PATCH', `/api/pages/${q.id}`, { title: '快事务' })
    expect(await c.step()).toEqual({ up: [q.id], rm: [] })
    await slow.query('COMMIT')
  } finally {
    slow.release()
  }
  const got = await c.step()
  expect(got.up).toContain(p.id)
})

test('游标过旧（清理推过 floor）/ 格式坏 / 比现在新 / 成员指纹不对 → 整表；清理只删保留期外的行', async () => {
  const { cookie } = await login('dave')
  const p = (await call(cookie, 'POST', '/api/pages', {})).data
  const c = await client(cookie)
  const mark = c.mark()
  // 游标之后的一笔改动，日志 xid >= 游标
  await call(cookie, 'PATCH', `/api/pages/${p.id}`, { title: '游标之后' })

  // 7 天保留期内的行不删，增量照常
  expect(await prunePageChanges(pool)).toBe(0)
  expect((await sync(cookie, mark)).up?.map((x) => x.id)).toEqual([p.id])

  // 全删后 floor 推过被删的最大 xid（游标之后那笔），旧游标只能整表
  expect(await prunePageChanges(pool, '0 seconds')).toBeGreaterThan(0)
  expect((await pool.query('SELECT count(*)::int AS n FROM page_changes')).rows[0].n).toBe(0)
  const floor: string = (await pool.query('SELECT xid::text AS x FROM page_changes_floor')).rows[0].x
  expect(BigInt(floor) > BigInt(mark.cursor)).toBe(true)
  const stale = await sync(cookie, mark)
  expect(stale.full).toBeDefined()
  // 整表给的新游标不比 floor 旧，接着增量
  expect((await sync(cookie, { cursor: stale.cursor, members: stale.members })).full).toBeUndefined()
  // floor 只升不降，再清一次不动它
  await prunePageChanges(pool, '0 seconds')
  expect((await pool.query('SELECT xid::text AS x FROM page_changes_floor')).rows[0].x).toBe(floor)

  for (const cursor of ['abc', '-1', '1'.repeat(25), '']) {
    expect((await sync(cookie, { cursor, members: stale.members })).full).toBeDefined()
  }
  expect((await sync(cookie, { cursor: '999999999999999', members: stale.members })).full).toBeDefined()
  expect((await sync(cookie, { cursor: stale.cursor, members: 'nope' })).full).toBeDefined()
})

test('量化：500 页的空间里改一页标题，增量响应 vs 整表', async () => {
  const { cookie } = await login('erin')
  const first = (await call(cookie, 'POST', '/api/pages', {})).data
  await pool.query(
    `INSERT INTO pages (id, owner_id, space_id, title)
     SELECT gen_random_uuid()::text, $1, $2, '页面 ' || g FROM generate_series(1, 499) g`,
    [first.owner_id, first.space_id],
  )
  const c = await client(cookie)
  await call(cookie, 'PATCH', `/api/pages/${first.id}`, { title: '改了一个标题' })
  const delta = await call(cookie, 'GET', `/api/pages/sync?${new URLSearchParams({ since: c.mark().cursor, members: c.mark().members })}`)
  expect(delta.data.up).toHaveLength(1)
  const whole = await call(cookie, 'GET', '/api/pages')
  expect(whole.data).toHaveLength(500)
  console.log(`[page-sync] 500 页改一页标题：整表 ${whole.bytes} B，增量 ${delta.bytes} B`)
  expect(delta.bytes * 50).toBeLessThan(whole.bytes)
})
