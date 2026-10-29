import { afterAll, beforeEach, expect, test } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
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

let pool = getPool()
await initDb(pool)

// 上传落盘指向独立临时目录:files.ts 按请求惰性读 UPLOAD_DIR(见该文件 uploadDir 注释),
// 这里在测试体顶端赋值即可,用完整个清掉
const uploadDir = mkdtempSync(join(tmpdir(), 'ramet-uploads-'))
process.env.UPLOAD_DIR = uploadDir

// 整个文件共用一个 server;各用例自建账号,互不依赖
const s = await startServer(pool)
const base = `http://127.0.0.1:${s.port}`

beforeEach(async () => {
  // 每个用例从空库出发;files 无被引用,与既有清单一并清
  await truncateAll(pool)
})

afterAll(async () => {
  await s.close()
  await closePool()
  // 清临时上传目录:测试产物不落残留
  rmSync(uploadDir, { recursive: true, force: true })
})

// ---------- 造数助手(同 public.test.ts 风格) ----------

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

type UploadBody = { id: string; url: string; display: string; name: string; mime: string; size: number }

async function upload(
  cookie: string | undefined,
  file: File,
): Promise<{ status: number; body: UploadBody | { error: string } }> {
  const form = new FormData()
  form.append('file', file)
  // 不手动设 content-type:fetch 自带 multipart boundary
  const res = await fetch(`${base}/api/files`, { method: 'POST', headers: cookie ? { cookie } : {}, body: form })
  return { status: res.status, body: (await res.json()) as UploadBody | { error: string } }
}

// ---------- 上传 png(含 display webp) ----------

test('上传 png:201 回 url/display,磁盘有原图+webp,GET 原图字节一致,display 回 1600px webp', async () => {
  await insertUser('alice', 'pw-a')
  const alice = await login('alice', 'pw-a')

  // 2000px 宽超过 display 最长边 1600:顺带验证 resize 生效;文件名带中文/空格/单引号,
  // 验证 RFC 5987 编码原样保留(encodeURIComponent 不转义 ',files.ts 里补了 %27,这里锁死)
  const png = await sharp({
    create: { width: 2000, height: 1000, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .png()
    .toBuffer()
  const { status, body } = await upload(alice, new File([png], "截图 一'号.png", { type: 'image/png' }))
  expect(status).toBe(201)
  const meta = body as UploadBody
  expect(meta.name).toBe("截图 一'号.png")
  expect(meta.mime).toBe('image/png')
  expect(meta.size).toBe(png.length)
  expect(meta.url).toBe(`/api/files/${meta.id}`)
  expect(meta.display).toBe(`/api/files/${meta.id}/display`)

  // 磁盘:原图与 webp display 版都在(断言只看本次上传的 id 前缀:目录跨用例共用,历史产物不干扰),原图字节级一致
  const mine = readdirSync(uploadDir).filter((f) => f.startsWith(meta.id))
  expect(mine).toEqual(expect.arrayContaining([meta.id, `${meta.id}.webp`]))
  expect((await readFile(join(uploadDir, meta.id))).equals(png)).toBe(true)

  // GET 原图(无 auth):字节一致 + 三件头齐全
  const raw = await fetch(`${base}${meta.url}`)
  expect(raw.status).toBe(200)
  expect(Buffer.from(await raw.arrayBuffer()).equals(png)).toBe(true)
  expect(raw.headers.get('content-type')).toBe('image/png')
  expect(raw.headers.get('content-disposition')).toBe(
    `inline; filename*=UTF-8''${encodeURIComponent("截图 一'号.png").replace(/'/g, '%27')}`,
  )
  expect(raw.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')

  // GET display:真 webp 且最长边压到 1600
  const disp = await fetch(`${base}${meta.display}`)
  expect(disp.status).toBe(200)
  expect(disp.headers.get('content-type')).toBe('image/webp')
  const m = await sharp(Buffer.from(await disp.arrayBuffer())).metadata()
  expect(m.format).toBe('webp')
  expect(Math.max(m.width!, m.height!)).toBe(1600)
})

// ---------- 非图片:display 退原图 ----------

test('上传文本:不生成 webp,display 退回原图内容', async () => {
  await insertUser('alice', 'pw-a')
  const alice = await login('alice', 'pw-a')

  const text = 'hello 你好,这是附件内容'
  const { status, body } = await upload(alice, new File([text], 'notes.txt', { type: 'text/plain' }))
  expect(status).toBe(201)
  const meta = body as UploadBody

  // 磁盘只有原图,无 .webp(只看本次 id 前缀,同上)
  expect(readdirSync(uploadDir).filter((f) => f.startsWith(meta.id))).toEqual([meta.id])

  const disp = await fetch(`${base}${meta.display}`)
  expect(disp.status).toBe(200)
  expect(disp.headers.get('content-type')).toBe('text/plain')
  expect(await disp.text()).toBe(text)

  // 不存在的 id:两路由都 404
  expect((await fetch(`${base}/api/files/${crypto.randomUUID()}`)).status).toBe(404)
  expect((await fetch(`${base}/api/files/${crypto.randomUUID()}/display`)).status).toBe(404)
})

// ---------- 鉴权与限流 ----------

test('未登录 POST 401;超 10MB 413;GET 不鉴权', async () => {
  await insertUser('alice', 'pw-a')
  const alice = await login('alice', 'pw-a')

  // 未登录:requireAuth 在 bodyLimit 之前,空 body 的小文件也 401
  expect((await upload(undefined, new File(['x'], 'x.txt', { type: 'text/plain' }))).status).toBe(401)

  // 超 10MB:fetch 对已知长度的 body 自动带 Content-Length,bodyLimit 对带 Content-Length 的请求
  // 不读体直接短路拒,默认 onError 回 413(流式无 Content-Length 时同样 413,只是读完才判)
  const big = Buffer.alloc(10 * 1024 * 1024 + 1, 7)
  expect((await upload(alice, new File([big], 'big.bin', { type: 'application/octet-stream' }))).status).toBe(413)

  // 恰好 10MB 会被拒:限额管的是整个 multipart 请求体,10MB 文件加 boundary/分部头必然超线 ——
  // 可用文件大小略小于 10MB,留 1KB 余量验证边界内放行
  const ok = await upload(
    alice,
    new File([Buffer.alloc(10 * 1024 * 1024 - 1024, 7)], 'ok.bin', { type: 'application/octet-stream' }),
  )
  expect(ok.status).toBe(201)

  // GET 无 cookie 可达(uuid 即权限边界,刻意不鉴权)
  const meta = ok.body as UploadBody
  expect((await fetch(`${base}${meta.url}`)).status).toBe(200)
})

// ---------- gif:不生成 display ----------

test('上传 gif:不生成 .webp,display 退原图', async () => {
  await insertUser('alice', 'pw-a')
  const alice = await login('alice', 'pw-a')

  const gif = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 10, g: 200, b: 30 } },
  })
    .gif()
    .toBuffer()
  const { status, body } = await upload(alice, new File([gif], 'anim.gif', { type: 'image/gif' }))
  expect(status).toBe(201)
  const meta = body as UploadBody

  // gif 走"图片但跳过 sharp"分支:磁盘只有原图(只看本次 id 前缀,同上)
  expect(readdirSync(uploadDir).filter((f) => f.startsWith(meta.id))).toEqual([meta.id])

  const disp = await fetch(`${base}${meta.display}`)
  expect(disp.status).toBe(200)
  expect(disp.headers.get('content-type')).toBe('image/gif')
  expect(Buffer.from(await disp.arrayBuffer()).equals(gif)).toBe(true)
})

// ---------- 查重:同内容静默复用已有行 ----------

async function countFiles(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM files')
  return rows[0]!.n
}

test('同一内容传两次:响应 id 相同,files 表仍 1 行,磁盘只有一份', async () => {
  await insertUser('alice', 'pw-a')
  const alice = await login('alice', 'pw-a')

  const png = await sharp({
    create: { width: 500, height: 400, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .png()
    .toBuffer()

  const first = await upload(alice, new File([png], 'a.png', { type: 'image/png' }))
  expect(first.status).toBe(201)
  const a = first.body as UploadBody
  expect(await countFiles()).toBe(1)

  // 第二次上传同内容:磁盘零新文件(目录快照比对,不按 id 前缀过滤 —— 新落盘会是新 id)
  const diskBefore = readdirSync(uploadDir)
  const second = await upload(alice, new File([png], 'b.png', { type: 'image/png' }))
  expect(second.status).toBe(201)
  const b = second.body as UploadBody
  expect(readdirSync(uploadDir)).toEqual(diskBefore)

  // 复用行:两次响应同一个 id/url/display;名字保留首次上传者的
  expect(b.id).toBe(a.id)
  expect(b.url).toBe(a.url)
  expect(b.display).toBe(a.display)
  expect(b.name).toBe('a.png')
  expect(b.size).toBe(png.length)

  // 表仍 1 行;display 版也不重复生成(只有首次那一份 webp);GET 原图字节一致
  expect(await countFiles()).toBe(1)
  expect(readdirSync(uploadDir).filter((f) => f.startsWith(a.id))).toEqual([a.id, `${a.id}.webp`])
  const raw = await fetch(`${base}${b.url}`)
  expect(Buffer.from(await raw.arrayBuffer()).equals(png)).toBe(true)
})

test('不同内容各自落盘:互不命中查重', async () => {
  await insertUser('alice', 'pw-a')
  const alice = await login('alice', 'pw-a')

  const a = await upload(alice, new File(['content-one'], 'same.txt', { type: 'text/plain' }))
  const b = await upload(alice, new File(['content-two'], 'same.txt', { type: 'text/plain' }))
  expect(a.status).toBe(201)
  expect(b.status).toBe(201)
  // 名字相同内容不同:两个不同 id,各自落盘可取
  expect((a.body as UploadBody).id).not.toBe((b.body as UploadBody).id)
  expect(await countFiles()).toBe(2)
  expect(await (await fetch(`${base}${(a.body as UploadBody).url}`)).text()).toBe('content-one')
  expect(await (await fetch(`${base}${(b.body as UploadBody).url}`)).text()).toBe('content-two')
})

test('名字不同内容相同:命中复用(跨用户也一样,返回已有行不新增)', async () => {
  await insertUser('alice', 'pw-a')
  await insertUser('bob', 'pw-b')
  const alice = await login('alice', 'pw-a')
  const bob = await login('bob', 'pw-b')

  const payload = '同内容不同名,只看内容指纹'
  const first = await upload(alice, new File([payload], '原始名.txt', { type: 'text/plain' }))
  const second = await upload(bob, new File([payload], '改名了.txt', { type: 'text/plain' }))
  expect(first.status).toBe(201)
  expect(second.status).toBe(201)
  const a = first.body as UploadBody
  const b = second.body as UploadBody

  // 复用已有行:id 相同,名字是首次上传者的(内容一致,下载名不同属可接受偏差)
  expect(b.id).toBe(a.id)
  expect(b.name).toBe('原始名.txt')
  expect(await countFiles()).toBe(1)
  // 磁盘也只有首次那一份
  expect(readdirSync(uploadDir).filter((f) => f.startsWith(a.id))).toEqual([a.id])
})
