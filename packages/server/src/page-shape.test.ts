import { afterAll, beforeEach, expect, test } from 'vitest'
import { closePool, getPool, initDb } from './db.js'
import { startServer } from './index.js'
import { hashPassword, SESSION_COOKIE } from './auth.js'
import { API_PAGE_FIELDS } from './page-icon.js'
import { truncateAll } from './test-helpers.js'

// 对外的页面形状只有白名单字段（page-icon.ts 的 API_PAGE_FIELDS + icon），content_text（全文）和 agent_session 不能下发给客户端

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

const SHAPE = [...API_PAGE_FIELDS, 'icon'].sort()
const BODY = '这是一段只该待在服务端的正文。'.repeat(40)

async function login(role: 'user' | 'admin', username: string): Promise<string> {
  await pool.query('INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)', [
    crypto.randomUUID(),
    username,
    hashPassword('pw-123456'),
    role,
  ])
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'pw-123456' }),
  })
  expect(res.status).toBe(200)
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  if (!cookie?.startsWith(`${SESSION_COOKIE}=`)) throw new Error('登录未返回会话 cookie')
  return cookie
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

const keys = (o: object): string[] => Object.keys(o).sort()

test('页面形状的各端点只出白名单字段；正文与会话不下发', async () => {
  const cookie = await login('user', 'alice')
  const created = await call(cookie, 'POST', '/api/pages', {})
  expect(created.status).toBe(201)
  expect(keys(created.data)).toEqual(SHAPE)
  const id: string = created.data.id
  await pool.query(`UPDATE pages SET content_text = $1, agent_session = '{"sessions":{"x":{"lastSyncedHash":"h"}}}'::jsonb WHERE id = $2`, [BODY, id])

  const patched = await call(cookie, 'PATCH', `/api/pages/${id}`, { title: '改个名' })
  expect(patched.status).toBe(200)
  expect(keys(patched.data)).toEqual(SHAPE)

  const list = await call(cookie, 'GET', '/api/pages')
  expect(list.status).toBe(200)
  for (const page of list.data) expect(keys(page)).toEqual(SHAPE)
  const raw = JSON.stringify(list.data)
  expect(raw).not.toContain('只该待在服务端')
  expect(raw).not.toContain('lastSyncedHash')

  const coll = await call(cookie, 'POST', '/api/collections', { space_id: created.data.space_id, inline: false })
  expect(coll.status).toBe(201)
  expect(keys(coll.data)).toEqual([...SHAPE, 'inline'].sort())
})

test('回收站条目照旧带 deleted_at / descendants / icon，不带图标两列', async () => {
  const cookie = await login('user', 'bob')
  const root = await call(cookie, 'POST', '/api/pages', {})
  await call(cookie, 'POST', '/api/pages', { parent_id: root.data.id })
  expect((await call(cookie, 'POST', `/api/pages/${root.data.id}/trash`)).status).toBeLessThan(300)
  const trash = await call(cookie, 'GET', '/api/pages/trash')
  expect(trash.status).toBe(200)
  expect(trash.data).toHaveLength(1)
  expect(keys(trash.data[0])).toEqual(['deleted_at', 'descendants', 'icon', 'id', 'kind', 'parent_id', 'space_id', 'title'])
  expect(trash.data[0].descendants).toBe(1)
})

test('量化：100 页各带约 1.7KB 正文，页面列表的响应体积（修复前 = SELECT * 原样展开）', async () => {
  const cookie = await login('user', 'carol')
  for (let i = 0; i < 100; i++) await call(cookie, 'POST', '/api/pages', {})
  await pool.query(`UPDATE pages SET content_text = $1, agent_session = '{"sessions":{}}'::jsonb`, [BODY])
  const after = await call(cookie, 'GET', '/api/pages')
  // 对照基线：整行原样展开，只把图标两列折成 icon
  const { rows } = await pool.query('SELECT * FROM live_pages ORDER BY position ASC NULLS LAST, created_at, id')
  const before = Buffer.byteLength(
    JSON.stringify(rows.map(({ icon_emoji: _e, icon_file_id: _f, ...rest }) => ({ ...rest, icon: null }))),
  )
  console.log(`[page-shape] 100 页：修复前 ${before} B，修复后 ${after.bytes} B`)
  expect(after.bytes * 5).toBeLessThan(before)
})
