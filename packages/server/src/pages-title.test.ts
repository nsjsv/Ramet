// ---------- 带标题建页（POST /api/pages 的 title） ----------
// 标题同时写进 pages.title 与文档的 title 片段：编辑器以文档为准，只写其一的话打开页面时标题会被空文档冲掉。
import { afterAll, afterEach, beforeEach, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { hashPassword } from './auth.js'
import { extractTitle, loadDocFromDb } from './collab.js'
import { closePool, getPool, initDb } from './db.js'
import { startServer } from './index.js'
import { truncateAll } from './test-helpers.js'

if (!process.env.DATABASE_URL) {
  throw new Error('需要 DATABASE_URL 指向测试库,例如 postgres://postgres:postgres@localhost:5432/ramet_test')
}

const pool = getPool()
await initDb(pool)
const s = await startServer(pool)
const base = `http://127.0.0.1:${s.port}`

// beforeEach 兜底：同一个库里前一个测试文件遗留的行不能影响本文件的首个用例
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

async function newUser(): Promise<{ cookie: string; spaceId: string }> {
  await pool.query('INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)', [randomUUID(), 'u', hashPassword('pw-123456'), 'user'])
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'u', password: 'pw-123456' }),
  })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const space = (await (await fetch(`${base}/api/spaces`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 's' }) })).json()) as { id: string }
  return { cookie, spaceId: space.id }
}

const create = (cookie: string, body: unknown): Promise<Response> =>
  fetch(`${base}/api/pages`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })

test('带标题建页：pages.title 与文档 title 片段一致；不带标题仍是空页；标题不是字符串 400', async () => {
  const { cookie, spaceId } = await newUser()
  const res = await create(cookie, { space_id: spaceId, title: '  产品路线  ' })
  expect(res.status).toBe(201)
  const page = (await res.json()) as { id: string; title: string }
  expect(page.title).toBe('产品路线')
  expect(extractTitle(await loadDocFromDb(pool, `page:${page.id}`))).toBe('产品路线')

  const blank = (await (await create(cookie, { space_id: spaceId })).json()) as { id: string; title: string }
  expect(blank.title).toBe('')
  expect(extractTitle(await loadDocFromDb(pool, `page:${blank.id}`))).toBe('')

  expect((await create(cookie, { space_id: spaceId, title: 42 })).status).toBe(400)
})
