import { afterAll, beforeEach, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { closePool, getPool, initDb } from './db.js'
import { startServer } from './index.js'
import { hashPassword, SESSION_COOKIE } from './auth.js'
import { storeFile } from './file-store.js'
import { createImgbedSync } from './imgbed-sync.js'
import { truncateAll } from './test-helpers.js'
import { variantPath } from './uploads.js'

// 图床镜像：假图床 + 注入的 ImgbedSync（不起定时器、上传不限速），验证上传后镜像、回读校验、
// 302 跳转、?direct 回源、非位图不上图床、图标镜像、断路器、补传扫描与失败退避

if (!process.env.DATABASE_URL) {
  throw new Error('需要 DATABASE_URL 指向测试库,例如 postgres://postgres:postgres@localhost:5432/ramet_test')
}

const pool = getPool()
await initDb(pool)

const uploadDir = mkdtempSync(join(tmpdir(), 'ramet-imgbed-'))
process.env.UPLOAD_DIR = uploadDir

// ---------- 假图床：POST /upload 存字节回 [{src}]，GET /file/* 回字节 ----------
// corrupt = 回读时改字节（模拟图床压图）；down = 一切请求 500；uploadFail = 只有上传 500
const bedMode = { corrupt: false, down: false, uploadFail: false }
const bedFiles = new Map<string, Buffer>()
const bedUploads: Array<{ params: URLSearchParams; auth: string | undefined; name: string; type: string }> = []
const bed = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', async () => {
    const url = new URL(req.url ?? '/', 'http://bed')
    if (bedMode.down) return res.writeHead(500).end('down')
    if (req.method === 'POST' && url.pathname === '/upload') {
      if (bedMode.uploadFail) return res.writeHead(500).end('upload error')
      const form = await new Request('http://bed/upload', {
        method: 'POST',
        headers: { 'content-type': req.headers['content-type'] ?? '' },
        body: Buffer.concat(chunks),
      }).formData()
      const file = form.get('file') as File
      bedUploads.push({ params: url.searchParams, auth: req.headers.authorization, name: file.name, type: file.type })
      const src = `/file/${url.searchParams.get('uploadFolder')}/${file.name}`
      bedFiles.set(src, Buffer.from(await file.arrayBuffer()))
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{ src }]))
    }
    const data = bedFiles.get(url.pathname)
    if (req.method !== 'GET' || !data) return res.writeHead(404).end('Error: Image Not Found')
    return res.writeHead(200).end(bedMode.corrupt ? Buffer.concat([data, Buffer.from('x')]) : data)
  })
})
await new Promise<void>((r) => bed.listen(0, '127.0.0.1', r))
const bedUrl = `http://127.0.0.1:${(bed.address() as { port: number }).port}`
const PUBLIC = 'https://img.example'

const sync = createImgbedSync(pool, {
  config: { url: bedUrl, token: 'tok', publicUrl: PUBLIC },
  spacingMs: 0,
  probeEveryMs: 0,
  scanEveryMs: 0,
})
const s = await startServer(pool, 0, { imgbed: sync })
const base = `http://127.0.0.1:${s.port}`

beforeEach(async () => {
  await sync.idle()
  await truncateAll(pool)
  Object.assign(bedMode, { corrupt: false, down: false, uploadFail: false })
  bedFiles.clear()
  bedUploads.length = 0
})

afterAll(async () => {
  await s.close()
  await new Promise<void>((r) => bed.close(() => r()))
  await closePool()
  rmSync(uploadDir, { recursive: true, force: true })
})

async function loginNew(username: string): Promise<string> {
  await pool.query('INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)', [
    crypto.randomUUID(),
    username,
    hashPassword('pw'),
    'user',
  ])
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'pw' }),
  })
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  if (!cookie?.startsWith(`${SESSION_COOKIE}=`)) throw new Error('登录未返回会话 cookie')
  return cookie
}

async function upload(cookie: string, data: Buffer | string, name: string, type: string): Promise<string> {
  const form = new FormData()
  form.append('file', new File([data], name, { type }))
  const res = await fetch(`${base}/api/files`, { method: 'POST', headers: { cookie }, body: form })
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: string }).id
}

async function png(seed: number): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: { r: seed, g: 100, b: 50 } } }).png().toBuffer()
}

const get = (path: string): Promise<Response> => fetch(`${base}${path}`, { redirect: 'manual' })
const IMMUTABLE = 'public, max-age=31536000, immutable'
const PENDING = 'private, max-age=300'
const cacheOf = async (path: string): Promise<string | null> => (await get(path)).headers.get('cache-control')
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

async function mirror(id: string, variant: string): Promise<{ status: string; path: string | null; attempts: number; last_error: string | null } | undefined> {
  return (
    await pool.query<{ status: string; path: string | null; attempts: number; last_error: string | null }>(
      'SELECT status, path, attempts, last_error FROM file_mirrors WHERE file_id = $1 AND variant = $2',
      [id, variant],
    )
  ).rows[0]
}

test('上传 png：原图与 display 原样镜像到图床，GET 302 过去；?direct=1 本地出', async () => {
  const cookie = await loginNew('alice')
  const data = await png(10)
  const id = await upload(cookie, data, '图.png', 'image/png')
  await sync.idle()

  // 上传参数是硬约束：不压缩、只走 TG、用我们给的名字
  expect(bedUploads.map((u) => u.name).sort()).toEqual([`${id}.display.webp`, `${id}.png`])
  for (const u of bedUploads) {
    expect(u.auth).toBe('Bearer tok')
    expect(u.params.get('serverCompress')).toBe('false')
    expect(u.params.get('uploadChannel')).toBe('telegram')
    expect(u.params.get('autoRetry')).toBe('false')
    expect(u.params.get('uploadNameType')).toBe('origin')
  }
  expect(bedUploads.find((u) => u.name.endsWith('.png'))?.type).toBe('image/png')
  // 图床上的字节与本地完全一致
  expect(sha(bedFiles.get(`/file/ramet/${id}.png`)!)).toBe(sha(data))
  expect(sha(bedFiles.get(`/file/ramet/${id}.display.webp`)!)).toBe(sha(await readFile(variantPath(id, 'display'))))
  expect((await mirror(id, 'orig'))?.status).toBe('ok')

  const orig = await get(`/api/files/${id}`)
  expect(orig.status).toBe(302)
  expect(orig.headers.get('location')).toBe(`${PUBLIC}/file/ramet/${id}.png`)
  expect(orig.headers.get('cache-control')).toBe('private, max-age=3600')
  const disp = await get(`/api/files/${id}/display`)
  expect(disp.status).toBe(302)
  expect(disp.headers.get('location')).toBe(`${PUBLIC}/file/ramet/${id}.display.webp`)

  const direct = await get(`/api/files/${id}?direct=1`)
  expect(direct.status).toBe(200)
  expect(direct.headers.get('cache-control')).toBe(IMMUTABLE)
  expect(Buffer.from(await direct.arrayBuffer()).equals(data)).toBe(true)
  expect((await get(`/api/files/${id}/display?direct=1`)).status).toBe(200)
})

test('图床回读字节不一致（压过图）：记 skip、不跳转，以后也不再传', async () => {
  const cookie = await loginNew('alice')
  bedMode.corrupt = true
  const id = await upload(cookie, await png(20), 'a.png', 'image/png')
  await sync.idle()

  const row = await mirror(id, 'orig')
  expect(row?.status).toBe('skip')
  expect(row?.last_error).toContain('不一致')
  expect((await get(`/api/files/${id}`)).status).toBe(200)
  expect((await get(`/api/files/${id}/display`)).status).toBe(200)
  // 永远本地出：照旧一年缓存（CF 边缘也能缓存）
  expect(await cacheOf(`/api/files/${id}`)).toBe(IMMUTABLE)

  bedMode.corrupt = false
  const before = bedUploads.length
  sync.enqueue(id)
  await sync.scan()
  await sync.idle()
  expect(bedUploads.length).toBe(before)
})

test('非位图不上图床：文本、伪装成 png 的文本、SVG 原图都 skip；SVG 的 display webp 照常镜像', async () => {
  const cookie = await loginNew('alice')
  const txt = await upload(cookie, 'hello', 'a.txt', 'text/plain')
  const fake = await upload(cookie, '<html>not a png</html>', 'b.png', 'image/png')
  const svg = await upload(
    cookie,
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>',
    'c.svg',
    'image/svg+xml',
  )
  await sync.idle()

  for (const id of [txt, fake, svg]) {
    expect((await mirror(id, 'orig'))?.status).toBe('skip')
    const res = await get(`/api/files/${id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE)
  }
  expect(await cacheOf(`/api/files/${txt}/display`)).toBe(IMMUTABLE)
  expect(bedUploads.some((u) => u.name.endsWith('.svg') || u.type === 'image/svg+xml')).toBe(false)
  expect((await mirror(svg, 'display'))?.status).toBe('ok')
  expect((await get(`/api/files/${svg}/display`)).status).toBe(302)
})

test('gif 没有 display 版：/display 退到原图的图床地址', async () => {
  const cookie = await loginNew('alice')
  const gif = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).gif().toBuffer()
  const id = await upload(cookie, gif, 'a.gif', 'image/gif')
  await sync.idle()

  expect((await mirror(id, 'display'))?.status).toBe('skip')
  const disp = await get(`/api/files/${id}/display`)
  expect(disp.status).toBe(302)
  expect(disp.headers.get('location')).toBe(`${PUBLIC}/file/ramet/${id}.gif`)
})

test('图标：/icon 首次生成后入队镜像，之后 302', async () => {
  const cookie = await loginNew('alice')
  const id = await upload(cookie, await png(30), 'a.png', 'image/png')
  await sync.idle()

  const first = await get(`/api/files/${id}/icon`)
  expect(first.status).toBe(200)
  expect(first.headers.get('content-type')).toBe('image/webp')
  // 这一刻还没镜像：不能让 CF / 浏览器长缓存，否则以后永远到不了图床
  expect(first.headers.get('cache-control')).toBe(PENDING)
  await sync.idle()

  expect(sha(bedFiles.get(`/file/ramet/${id}.icon.webp`)!)).toBe(sha(await readFile(variantPath(id, 'icon'))))
  const again = await get(`/api/files/${id}/icon`)
  expect(again.status).toBe(302)
  expect(again.headers.get('location')).toBe(`${PUBLIC}/file/ramet/${id}.icon.webp`)
})

test('断路器：图床连续 3 次探测失败后全部本地出，恢复后重新跳转', async () => {
  const cookie = await loginNew('alice')
  const id = await upload(cookie, await png(40), 'a.png', 'image/png')
  await sync.idle()
  expect((await get(`/api/files/${id}`)).status).toBe(302)

  bedMode.down = true
  await sync.probe()
  await sync.probe()
  expect((await get(`/api/files/${id}`)).status).toBe(302)
  await sync.probe()
  expect((await get(`/api/files/${id}`)).status).toBe(200)
  expect((await get(`/api/files/${id}/display`)).status).toBe(200)
  expect(await cacheOf(`/api/files/${id}/display`)).toBe(PENDING)

  bedMode.down = false
  await sync.probe()
  expect((await get(`/api/files/${id}`)).status).toBe(302)
})

test('补传扫描：没走上传入队的存量图片（含已生成的头像图标）被补齐', async () => {
  // 直接落库、不传 onStored = 存量老文件
  const data = await png(50)
  const { id } = await storeFile(pool, data, 'old.png', 'image/png')
  const icon = await sharp(data).resize(160, 160).webp().toBuffer()
  await writeFile(variantPath(id, 'icon'), icon)
  await pool.query('INSERT INTO users (id, username, password, role, avatar_file_id) VALUES ($1, $2, $3, $4, $5)', [
    crypto.randomUUID(),
    'bob',
    hashPassword('pw'),
    'user',
    id,
  ])
  expect(await mirror(id, 'orig')).toBeUndefined()

  await sync.scan()
  await sync.idle()
  for (const v of ['orig', 'display', 'icon']) expect((await mirror(id, v))?.status).toBe('ok')
  expect((await get(`/api/files/${id}/icon`)).status).toBe(302)
})

test('上传失败记 failed 并退避：退避期内不重试，过了由扫描重传成功', async () => {
  const cookie = await loginNew('alice')
  bedMode.uploadFail = true
  const id = await upload(cookie, await png(60), 'a.png', 'image/png')
  await sync.idle()

  const row = await mirror(id, 'orig')
  expect(row?.status).toBe('failed')
  expect(row?.attempts).toBe(1)
  expect(row?.last_error).toContain('500')
  const local = await get(`/api/files/${id}`)
  expect(local.status).toBe(200)
  expect(local.headers.get('cache-control')).toBe(PENDING)
  expect(await cacheOf(`/api/files/${id}/display`)).toBe(PENDING)
  expect(await cacheOf(`/api/files/${id}?direct=1`)).toBe(IMMUTABLE)

  bedMode.uploadFail = false
  sync.enqueue(id)
  await sync.scan()
  await sync.idle()
  expect((await mirror(id, 'orig'))?.attempts).toBe(1) // 还在退避期（2 分钟）

  await pool.query("UPDATE file_mirrors SET updated_at = now() - interval '1 hour' WHERE file_id = $1", [id])
  await sync.scan()
  await sync.idle()
  expect((await mirror(id, 'orig'))?.status).toBe('ok')
  expect((await get(`/api/files/${id}`)).status).toBe(302)
})
