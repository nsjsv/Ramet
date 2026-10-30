import { afterAll, beforeEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { closePool, getPool, initDb } from './db.js'
import { startServer } from './index.js'
import { hashPassword, SESSION_COOKIE } from './auth.js'
import { parseCoverInput } from './page-cover.js'
import { truncateAll } from './test-helpers.js'

if (!process.env.DATABASE_URL) {
  throw new Error('需要 DATABASE_URL 指向测试库,例如 postgres://postgres:postgres@localhost:5432/ramet_test')
}

const pool = getPool()
await initDb(pool)

const uploadDir = mkdtempSync(join(tmpdir(), 'ramet-cover-uploads-'))
process.env.UPLOAD_DIR = uploadDir

const s = await startServer(pool)
const base = `http://127.0.0.1:${s.port}`

beforeEach(async () => {
  await truncateAll(pool)
})

afterAll(async () => {
  await s.close()
  await closePool()
  rmSync(uploadDir, { recursive: true, force: true })
})

type Cover = { kind: 'file' | 'url' | 'preset'; value: string; y: number } | null
type PageBody = { id: string; title: string; cover: Cover }

async function insertUser(username: string, password: string): Promise<void> {
  await pool.query('INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)', [
    crypto.randomUUID(),
    username,
    hashPassword(password),
    'user',
  ])
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

async function post<T>(cookie: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  expect(res.status).toBeLessThan(300)
  return (await res.json()) as T
}

async function patch(cookie: string | undefined, id: string, body: unknown): Promise<{ status: number; body: Partial<PageBody> & { error?: string } }> {
  const res = await fetch(`${base}/api/pages/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Partial<PageBody> & { error?: string } }
}

async function listPages(cookie: string): Promise<PageBody[]> {
  const res = await fetch(`${base}/api/pages`, { headers: { cookie } })
  expect(res.status).toBe(200)
  return (await res.json()) as PageBody[]
}

async function upload(cookie: string, file: File): Promise<{ id: string }> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${base}/api/files`, { method: 'POST', headers: { cookie }, body: form })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}

async function coverColumns(id: string): Promise<{ cover_kind: string | null; cover_value: string | null; cover_y: number }> {
  const row = (await pool.query('SELECT cover_kind, cover_value, cover_y FROM pages WHERE id = $1', [id])).rows[0]
  if (!row) throw new Error('页面不存在')
  return row as { cover_kind: string | null; cover_value: string | null; cover_y: number }
}

test('parseCoverInput:三种来源与位置的格式校验', () => {
  expect(parseCoverInput(null)).toEqual({ ok: true, cover: null })
  expect(parseCoverInput({ kind: 'preset', value: 'dolomites' })).toEqual({ ok: true, cover: { kind: 'preset', value: 'dolomites', y: 50 } })
  expect(parseCoverInput({ kind: 'url', value: ' https://example.com/a.jpg ', y: 0 })).toEqual({
    ok: true,
    cover: { kind: 'url', value: 'https://example.com/a.jpg', y: 0 },
  })
  for (const bad of [
    'x',
    [],
    { kind: 'emoji', value: 'x' },
    { kind: 'url', value: '' },
    { kind: 'url', value: 'javascript:alert(1)' },
    { kind: 'url', value: 'data:image/png;base64,AAAA' },
    { kind: 'url', value: 'https://example.com/a b.jpg' },
    { kind: 'url', value: `https://example.com/${'a'.repeat(2048)}` },
    { kind: 'preset', value: '../etc' },
    { kind: 'preset', value: 'Dolomites' },
    { kind: 'preset', value: 'dolomites', y: 101 },
    { kind: 'preset', value: 'dolomites', y: -1 },
    { kind: 'preset', value: 'dolomites', y: '50' },
  ]) {
    expect(parseCoverInput(bad).ok, JSON.stringify(bad)).toBe(false)
  }
})

test('封面:预设 / 外链 / 上传图三种来源写入读出;只改位置;清除;不带 cover 的 PATCH 不动', async () => {
  await insertUser('cover-alice', 'pw-a')
  const alice = await login('cover-alice', 'pw-a')
  const page = await post<PageBody>(alice, '/api/pages', {})
  expect(page.cover).toBeNull()

  const preset = await patch(alice, page.id, { cover: { kind: 'preset', value: 'dolomites' } })
  expect(preset.status).toBe(200)
  expect(preset.body.cover).toEqual({ kind: 'preset', value: 'dolomites', y: 50 })

  // 列表是侧栏与编辑器的唯一数据源:带同一个派生字段,原始三列不外泄
  const listed = (await listPages(alice)).find((p) => p.id === page.id)
  expect(listed?.cover).toEqual({ kind: 'preset', value: 'dolomites', y: 50 })
  expect(listed).not.toHaveProperty('cover_kind')

  const moved = await patch(alice, page.id, { cover: { kind: 'preset', value: 'dolomites', y: 12.5 } })
  expect(moved.body.cover).toEqual({ kind: 'preset', value: 'dolomites', y: 12.5 })

  const renamed = await patch(alice, page.id, { title: '改名' })
  expect(renamed.body.cover).toEqual({ kind: 'preset', value: 'dolomites', y: 12.5 })

  const url = await patch(alice, page.id, { cover: { kind: 'url', value: 'https://example.com/a.jpg', y: 80 } })
  expect(url.body.cover).toEqual({ kind: 'url', value: 'https://example.com/a.jpg', y: 80 })

  const buf = await sharp({ create: { width: 800, height: 400, channels: 3, background: { r: 10, g: 90, b: 160 } } }).png().toBuffer()
  const meta = await upload(alice, new File([buf], 'cover.png', { type: 'image/png' }))
  const file = await patch(alice, page.id, { cover: { kind: 'file', value: meta.id } })
  expect(file.status).toBe(200)
  // 换图不继承上一张的位置
  expect(file.body.cover).toEqual({ kind: 'file', value: meta.id, y: 50 })

  const cleared = await patch(alice, page.id, { cover: null })
  expect(cleared.body.cover).toBeNull()
  expect(await coverColumns(page.id)).toEqual({ cover_kind: null, cover_value: null, cover_y: 50 })

  // DB 约束兜底:半截封面写不进去
  await expect(pool.query("UPDATE pages SET cover_kind = 'url' WHERE id = $1", [page.id])).rejects.toThrow(/pages_cover_valid/)
  await expect(pool.query("UPDATE pages SET cover_kind = 'x', cover_value = 'y' WHERE id = $1", [page.id])).rejects.toThrow(/pages_cover_valid/)
})

test('封面:非法输入 400 且不落库;上传图必须是已存在的图片', async () => {
  await insertUser('cover-alice', 'pw-a')
  const alice = await login('cover-alice', 'pw-a')
  const page = await post<PageBody>(alice, '/api/pages', {})

  expect((await patch(alice, page.id, { cover: { kind: 'url', value: 'javascript:alert(1)' } })).status).toBe(400)
  expect((await patch(alice, page.id, { cover: { kind: 'preset', value: 'x', y: 200 } })).status).toBe(400)
  const missing = await patch(alice, page.id, { cover: { kind: 'file', value: crypto.randomUUID() } })
  expect(missing.status).toBe(400)
  expect(missing.body.error).toBe('cover file not found')

  const text = await upload(alice, new File(['hello'], 'a.txt', { type: 'text/plain' }))
  expect((await patch(alice, page.id, { cover: { kind: 'file', value: text.id } })).status).toBe(400)
  expect(await coverColumns(page.id)).toEqual({ cover_kind: null, cover_value: null, cover_y: 50 })
})

test('封面:viewer 403、非成员 404、未登录 401', async () => {
  await insertUser('cover-alice', 'pw-a')
  await insertUser('cover-viewer', 'pw-v')
  await insertUser('cover-carol', 'pw-c')
  const alice = await login('cover-alice', 'pw-a')
  const viewer = await login('cover-viewer', 'pw-v')
  const carol = await login('cover-carol', 'pw-c')
  const space = await post<{ id: string }>(alice, '/api/spaces', { name: '共享' })
  const page = await post<PageBody>(alice, '/api/pages', { space_id: space.id })
  const invite = await post<{ token: string }>(alice, `/api/spaces/${space.id}/invites`, { role: 'viewer' })
  await post(viewer, `/api/invites/${invite.token}/accept`, {})

  const cover = { kind: 'preset', value: 'dolomites' }
  expect((await patch(viewer, page.id, { cover })).status).toBe(403)
  expect((await patch(carol, page.id, { cover })).status).toBe(404)
  expect((await patch(undefined, page.id, { cover })).status).toBe(401)
  expect(await coverColumns(page.id)).toEqual({ cover_kind: null, cover_value: null, cover_y: 50 })
})

test('封面:公开页 doc 带封面;克隆跟着复制', async () => {
  await insertUser('cover-alice', 'pw-a')
  await insertUser('cover-bob', 'pw-b')
  const alice = await login('cover-alice', 'pw-a')
  const bob = await login('cover-bob', 'pw-b')
  const page = await post<PageBody>(alice, '/api/pages', {})
  await patch(alice, page.id, { cover: { kind: 'url', value: 'https://example.com/c.jpg', y: 30 } })
  const published = await fetch(`${base}/api/pages/${page.id}/publish`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: alice },
    body: JSON.stringify({ published: true }),
  })
  expect(published.status).toBe(200)

  const doc = (await (await fetch(`${base}/api/public/pages/${page.id}/doc`)).json()) as { cover: Cover }
  expect(doc.cover).toEqual({ kind: 'url', value: 'https://example.com/c.jpg', y: 30 })

  const clone = await post<{ id: string }>(bob, `/api/public/pages/${page.id}/clone`, {})
  expect((await listPages(bob)).find((p) => p.id === clone.id)?.cover).toEqual({ kind: 'url', value: 'https://example.com/c.jpg', y: 30 })
})
