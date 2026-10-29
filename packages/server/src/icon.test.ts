import { afterAll, beforeEach, expect, test } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
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

// 图标派生版落盘在 UPLOAD_DIR(files.ts 按请求惰性读,故此处赋值即可)
const uploadDir = mkdtempSync(join(tmpdir(), 'ramet-icon-uploads-'))
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

/* ---------- 造数助手 ---------- */

type Icon = { kind: 'emoji' | 'image'; value: string } | null
type PageBody = { id: string; title: string; icon: Icon }
type UploadBody = { id: string; url: string; display: string; name: string; mime: string; size: number }

async function insertUser(username: string, password: string): Promise<string> {
  const id = crypto.randomUUID()
  await pool.query('INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)', [
    id,
    username,
    hashPassword(password),
    'user',
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

/** PATCH 图标;返回原始响应便于断言状态码 */
async function patchIcon(
  cookie: string | undefined,
  id: string,
  icon: unknown,
): Promise<{ status: number; body: Partial<PageBody> & { error?: string } }> {
  const res = await fetch(`${base}/api/pages/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ icon }),
  })
  return { status: res.status, body: (await res.json()) as Partial<PageBody> & { error?: string } }
}

/** 当前库里该页的图标两列(验证「至多一个非空」的不变量) */
async function iconColumns(id: string): Promise<{ icon_emoji: string | null; icon_file_id: string | null }> {
  const row = (
    await pool.query<{ icon_emoji: string | null; icon_file_id: string | null }>(
      'SELECT icon_emoji, icon_file_id FROM pages WHERE id = $1',
      [id],
    )
  ).rows[0]
  if (!row) throw new Error('页面不存在')
  return row
}

async function upload(cookie: string, file: File): Promise<UploadBody> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${base}/api/files`, { method: 'POST', headers: { cookie }, body: form })
  expect(res.status).toBe(201)
  return (await res.json()) as UploadBody
}

/** 2000×1000 的 png(长边大于图标派生版的 160,能验证 cover 裁切 + 体积下降) */
async function pngFile(): Promise<{ buf: Buffer; file: File }> {
  const buf = await sharp({
    create: { width: 2000, height: 1000, channels: 3, background: { r: 30, g: 120, b: 200 } },
  })
    .png()
    .toBuffer()
  return { buf, file: new File([buf], 'icon.png', { type: 'image/png' }) }
}

/* ---------- emoji 图标:写入 / 读出 / 清除 / DB 不变量 ---------- */

test('emoji 图标:列表读出同值;两列互斥由 DB 约束兜底;清除与「不带 icon 的 PATCH」语义正确', async () => {
  await insertUser('icon-alice', 'pw-a')
  const alice = await login('icon-alice', 'pw-a')
  const page = await createPage(alice)

  // 新页面无图标
  expect(page.icon).toBeNull()

  const set = await patchIcon(alice, page.id, { kind: 'emoji', value: '🚀' })
  expect(set.status).toBe(200)
  expect(set.body.icon).toEqual({ kind: 'emoji', value: '🚀' })
  expect(await iconColumns(page.id)).toEqual({ icon_emoji: '🚀', icon_file_id: null })

  // 侧栏/面包屑等所有展示点的唯一数据源是列表:必须带上同一个派生字段
  const listed = (await listPages(alice)).find((p) => p.id === page.id)
  expect(listed?.icon).toEqual({ kind: 'emoji', value: '🚀' })
  // 原始两列不外泄(契约只有 icon 单字段)
  expect(listed).not.toHaveProperty('icon_emoji')
  expect(listed).not.toHaveProperty('icon_file_id')

  // PATCH 只改标题:图标不动(icon === undefined 的语义)
  const rename = await fetch(`${base}/api/pages/${page.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: alice },
    body: JSON.stringify({ title: '改个名' }),
  })
  expect(rename.status).toBe(200)
  const renamed = (await rename.json()) as PageBody
  expect(renamed.icon).toEqual({ kind: 'emoji', value: '🚀' })

  // DB 层不变量:两列同时非空必须被拒(任何未来写入路径都造不出非法行)
  await expect(
    pool.query('UPDATE pages SET icon_emoji = $1, icon_file_id = $2 WHERE id = $3', ['🚀', 'not-a-file', page.id]),
  ).rejects.toThrow(/pages_icon_at_most_one/)

  // 清除
  const cleared = await patchIcon(alice, page.id, null)
  expect(cleared.status).toBe(200)
  expect(cleared.body.icon).toBeNull()
  expect(await iconColumns(page.id)).toEqual({ icon_emoji: null, icon_file_id: null })
})

/* ---------- 图片图标:上传 → 设置 → 换成 emoji 时图片列被清 ---------- */

test('图片图标:派生方形 webp(比原图小、磁盘缓存);换成 emoji 时两列互斥切换', async () => {
  await insertUser('icon-alice', 'pw-a')
  const alice = await login('icon-alice', 'pw-a')
  const page = await createPage(alice)
  const { buf, file } = await pngFile()
  const meta = await upload(alice, file)

  const set = await patchIcon(alice, page.id, { kind: 'image', value: meta.id })
  expect(set.status).toBe(200)
  expect(set.body.icon).toEqual({ kind: 'image', value: meta.id })
  expect(await iconColumns(page.id)).toEqual({ icon_emoji: null, icon_file_id: meta.id })

  // /icon:方形 160 webp,体积远小于 2000×1000 原图
  const icon = await fetch(`${base}/api/files/${meta.id}/icon`)
  expect(icon.status).toBe(200)
  expect(icon.headers.get('content-type')).toBe('image/webp')
  expect(icon.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  const bytes = Buffer.from(await icon.arrayBuffer())
  expect(bytes.length).toBeLessThan(buf.length)
  const m = await sharp(bytes).metadata()
  expect(m.format).toBe('webp')
  expect([m.width, m.height]).toEqual([160, 160])
  // 惰性派生版落盘(第二次请求走磁盘缓存,不再跑 sharp)
  expect(existsSync(join(uploadDir, `${meta.id}.icon.webp`))).toBe(true)
  expect((await fetch(`${base}/api/files/${meta.id}/icon`)).status).toBe(200)

  // 换 emoji:一条 UPDATE 同时写两列,图片列必须被清掉(否则 DB 约束会拒绝)
  const swapped = await patchIcon(alice, page.id, { kind: 'emoji', value: '📌' })
  expect(swapped.status).toBe(200)
  expect(swapped.body.icon).toEqual({ kind: 'emoji', value: '📌' })
  expect(await iconColumns(page.id)).toEqual({ icon_emoji: '📌', icon_file_id: null })
})

/* ---------- 非图片:派生版退原图 ---------- */

test('非图片文件当图标源:拒绝;但直接打 /icon 时(存量/被绕过的情形)退原图不 500', async () => {
  await insertUser('icon-alice', 'pw-a')
  const alice = await login('icon-alice', 'pw-a')
  const page = await createPage(alice)

  const text = 'hello 你好'
  const form = new FormData()
  form.append('file', new File([text], 'notes.txt', { type: 'text/plain' }))
  const up = await fetch(`${base}/api/files`, { method: 'POST', headers: { cookie: alice }, body: form })
  const meta = (await up.json()) as UploadBody

  const rejected = await patchIcon(alice, page.id, { kind: 'image', value: meta.id })
  expect(rejected.status).toBe(400)
  expect(await iconColumns(page.id)).toEqual({ icon_emoji: null, icon_file_id: null })

  const icon = await fetch(`${base}/api/files/${meta.id}/icon`)
  expect(icon.status).toBe(200)
  expect(await icon.text()).toBe(text)
  expect(existsSync(join(uploadDir, `${meta.id}.icon.webp`))).toBe(false)

  expect((await fetch(`${base}/api/files/does-not-exist/icon`)).status).toBe(404)
})

/* ---------- 非法输入:一律 400 且不改动现状 ---------- */

test('非法 icon 输入一律 400 且不改动现有图标', async () => {
  await insertUser('icon-alice', 'pw-a')
  const alice = await login('icon-alice', 'pw-a')
  const page = await createPage(alice)
  await patchIcon(alice, page.id, { kind: 'emoji', value: '🚀' })

  const bad: unknown[] = [
    { kind: 'emoji', value: '' },
    { kind: 'emoji', value: '   ' },
    { kind: 'emoji', value: '123456789' }, // 9 码点,超上限
    { kind: 'emoji', value: 'a\u0000b' }, // 控制字符
    { kind: 'video', value: 'x' },
    { kind: 'emoji' }, // value 缺失
    { kind: 'image', value: 'no-such-file' },
    42,
    'emoji',
    [],
  ]
  for (const icon of bad) {
    const res = await patchIcon(alice, page.id, icon)
    expect(res.status, JSON.stringify(icon)).toBe(400)
  }
  // 现状不变
  expect(await iconColumns(page.id)).toEqual({ icon_emoji: '🚀', icon_file_id: null })

  // ZWJ 组合序列(家庭)应被接受:上限按码点算,不能按 UTF-16 单元
  const family = '👨‍👩‍👧'
  expect((await patchIcon(alice, page.id, { kind: 'emoji', value: family })).status).toBe(200)
  expect((await iconColumns(page.id)).icon_emoji).toBe(family)
})

/* ---------- 权限与可见性:沿用 PATCH 既有闸门 ---------- */

test('viewer 403、非成员 404:图标写面不放宽鉴权', async () => {
  await insertUser('icon-alice', 'pw-a')
  await insertUser('icon-viewer', 'pw-v')
  await insertUser('icon-carol', 'pw-c')
  const alice = await login('icon-alice', 'pw-a')
  const viewer = await login('icon-viewer', 'pw-v')
  const carol = await login('icon-carol', 'pw-c')

  const space = await fetch(`${base}/api/spaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: alice },
    body: JSON.stringify({ name: '共享' }),
  })
  const spaceBody = (await space.json()) as { id: string }
  const spaceId = spaceBody.id
  const page = await createPage(alice, { space_id: spaceId })

  const invite = await fetch(`${base}/api/spaces/${spaceId}/invites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: alice },
    body: JSON.stringify({ role: 'viewer' }),
  })
  const inviteBody = (await invite.json()) as { token: string }
  const token = inviteBody.token
  const accepted = await fetch(`${base}/api/invites/${token}/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: viewer },
  })
  expect(accepted.status).toBe(200)

  expect((await patchIcon(viewer, page.id, { kind: 'emoji', value: '🚀' })).status).toBe(403)
  expect((await patchIcon(carol, page.id, { kind: 'emoji', value: '🚀' })).status).toBe(404)
  expect((await patchIcon(undefined, page.id, { kind: 'emoji', value: '🚀' })).status).toBe(401)
  expect(await iconColumns(page.id)).toEqual({ icon_emoji: null, icon_file_id: null })
})

/* ---------- 其它读路径:搜索命中 / 回收站 / 公开页树 / 克隆 ---------- */

test('搜索命中带图标', async () => {
  await insertUser('icon-alice', 'pw-a')
  const alice = await login('icon-alice', 'pw-a')
  const page = await createPage(alice)
  await fetch(`${base}/api/pages/${page.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: alice },
    body: JSON.stringify({ title: '独一无二的标题', icon: { kind: 'emoji', value: '🔍' } }),
  })

  const res = await fetch(`${base}/api/search?q=${encodeURIComponent('独一无二的标题')}`, { headers: { cookie: alice } })
  expect(res.status).toBe(200)
  const hits = (await res.json()) as { id: string; icon: Icon }[]
  expect(hits.find((h) => h.id === page.id)?.icon).toEqual({ kind: 'emoji', value: '🔍' })
})

test('回收站条目带图标,恢复后图标仍在', async () => {
  await insertUser('icon-alice', 'pw-a')
  const alice = await login('icon-alice', 'pw-a')
  const page = await createPage(alice)
  await patchIcon(alice, page.id, { kind: 'emoji', value: '🗑️' })

  expect(
    (await fetch(`${base}/api/pages/${page.id}/trash`, { method: 'POST', headers: { cookie: alice } })).status,
  ).toBe(200)
  const trash = (await (await fetch(`${base}/api/pages/trash`, { headers: { cookie: alice } })).json()) as {
    id: string
    icon: Icon
  }[]
  expect(trash.find((t) => t.id === page.id)?.icon).toEqual({ kind: 'emoji', value: '🗑️' })

  expect(
    (await fetch(`${base}/api/pages/${page.id}/restore`, { method: 'POST', headers: { cookie: alice } })).status,
  ).toBe(200)
  expect((await listPages(alice)).find((p) => p.id === page.id)?.icon).toEqual({ kind: 'emoji', value: '🗑️' })
})

test('公开页树:匿名可见 emoji 图标,图片图标的 /icon 也匿名可取', async () => {
  await insertUser('icon-alice', 'pw-a')
  const alice = await login('icon-alice', 'pw-a')
  const root = await createPage(alice)
  const child = await createPage(alice, { parent_id: root.id })
  await patchIcon(alice, root.id, { kind: 'emoji', value: '🌍' })
  const meta = await upload(alice, (await pngFile()).file)
  await patchIcon(alice, child.id, { kind: 'image', value: meta.id })
  const published = await fetch(`${base}/api/pages/${root.id}/publish`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: alice },
    body: JSON.stringify({ published: true }),
  })
  expect(published.status).toBe(200)

  // 匿名(无 cookie)
  const treeRes = await fetch(`${base}/api/public/pages/${root.id}`)
  expect(treeRes.status).toBe(200)
  const tree = (await treeRes.json()) as { id: string; icon: Icon; children: { id: string; icon: Icon }[] }
  expect(tree.icon).toEqual({ kind: 'emoji', value: '🌍' })
  expect(tree.children.find((n) => n.id === child.id)?.icon).toEqual({ kind: 'image', value: meta.id })
  expect((await fetch(`${base}/api/files/${meta.id}/icon`)).status).toBe(200)
})

test('克隆页面:图标跟着复制', async () => {
  await insertUser('icon-alice', 'pw-a')
  await insertUser('icon-bob', 'pw-b')
  const alice = await login('icon-alice', 'pw-a')
  const bob = await login('icon-bob', 'pw-b')
  const page = await createPage(alice)
  await patchIcon(alice, page.id, { kind: 'emoji', value: '🧩' })
  await fetch(`${base}/api/pages/${page.id}/publish`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: alice },
    body: JSON.stringify({ published: true }),
  })

  const clone = await fetch(`${base}/api/public/pages/${page.id}/clone`, { method: 'POST', headers: { cookie: bob } })
  expect(clone.status).toBe(201)
  const cloneBody = (await clone.json()) as { id: string }
  const newId = cloneBody.id
  expect((await listPages(bob)).find((p) => p.id === newId)?.icon).toEqual({ kind: 'emoji', value: '🧩' })
})
