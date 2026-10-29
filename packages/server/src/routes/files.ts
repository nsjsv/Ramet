import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { rename, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import sharp from 'sharp'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv } from '../auth.js'
import { variantPath, type FileVariant } from '../uploads.js'
import { storeFile } from '../file-store.js'
import type { ImgbedSync } from '../imgbed-sync.js'

// 上传文件路由：原图落盘 UPLOAD_DIR/<uuid>，sharp 生成 <uuid>.webp 做编辑器 / 公开页的 display 版。
// 页面图标另有惰性的方形派生版 <uuid>.icon.webp（GET /api/files/:id/icon，见 iconDerivative）。
// 无 DELETE 端点：文件永不删除，历史版本里的引用要能回溯（见 db.ts 的 files 表注释）。
// 同内容静默查重：sha256 命中库中已有行就复用，不落盘、不插表、不跑 sharp，用户无感。
// 图床：三个 GET 先问 imgbed.route，该变体已镜像且校验通过就 302 到图床（正文流量走图床），否则本地出。
// ?direct=1 恒本地出：前端从图床加载失败时的回退（web/src/file-fallback.ts）、附件下载、导出都走它。
// 本地出但这份以后还会换到图床（pending）时只给短的 private 缓存：域名经 CF，/api/files 按 Cache-Control 进边缘缓存，
// 给了 immutable 一年，这份传好之后也永远走不到图床。

// 图标派生版：方形 160，覆盖标题大图 56px 的 2x 屏，cover 居中裁切保证任何原图都是方形缩略图。
// 全站图标共用一个 URL（侧栏 18px 与标题 56px 同一份），客户端只下一次
const ICON_EDGE = 160
const ICON_QUALITY = 80
// 302 只给浏览器私有缓存 1 小时：断路器打开后，最多这么久所有浏览器都回到本地出（期间由前端回退兜底）
const REDIRECT_CACHE = 'private, max-age=3600'
// uuid 即内容版本：文件永不覆盖（同内容重传复用同 id，不同内容必得新 id），缓存可无限期
const IMMUTABLE = 'public, max-age=31536000, immutable'
// 还没换到图床的本地响应：CF 不缓存（private），浏览器 5 分钟后再来问，那时多半已能 302
const PENDING_CACHE = 'private, max-age=300'
// 上限 10MB：原图直传（前端不做压缩），闸门只在服务端这一道
const MAX_FILE_SIZE = 10 * 1024 * 1024

const SELECT_FILE = 'SELECT id, name, mime FROM files WHERE id = $1'

type FileRow = { id: string; name: string; mime: string }

// 图标派生版：方形小图，惰性生成并缓存在磁盘。
// 惰性而非上传时生成：上传热路径不变，只有真被当图标的文件才付这份磁盘 / CPU，存量文件也能直接当图标用。
// 临时文件加 rename 落盘：并发生成同一图标时读者绝不会看到半截文件（uuid 内容不可变，谁赢都一样）。
// 生成失败（非图片 / 冷门格式）回 null，调用方退原图，与 /display 同语义
async function iconDerivative(id: string, onCreated: () => void): Promise<string | null> {
  const iconPath = variantPath(id, 'icon')
  if (existsSync(iconPath)) return iconPath
  const tmpPath = `${iconPath}.${randomUUID()}.tmp`
  try {
    const webp = await sharp(variantPath(id, 'orig'))
      .resize(ICON_EDGE, ICON_EDGE, { fit: 'cover', position: 'centre' })
      .webp({ quality: ICON_QUALITY })
      .toBuffer()
    await writeFile(tmpPath, webp)
    await rename(tmpPath, iconPath)
    onCreated()
    return iconPath
  } catch {
    return null
  }
}

// 流式回文件：上传侧已被 bodyLimit 压在 10MB，响应侧不再整读进内存，磁盘流直接接进 Response。
// toWeb 给的是 node:stream/web 的 ReadableStream，Hono 要全局那一个，结构一致但类型不同名，所以要转一下
function body(c: Context, filePath: string, range?: { start: number; end: number }): Response {
  return c.body(Readable.toWeb(createReadStream(filePath, range)) as unknown as ReadableStream)
}

/** 单段 Range（`bytes=a-b` / `bytes=a-` / `bytes=-n`）解析成闭区间；多段 / 坏格式返回 null（回整个文件，RFC 允许忽略），
 *  越界返回 'unsatisfiable'（416） */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  return start > end || start >= size ? 'unsatisfiable' : { start, end }
}

async function streamFile(c: Context, filePath: string, mime: string, name: string, opts: { range?: boolean; cache?: string } = {}): Promise<Response> {
  // 文件名按 RFC 5987 编码进 header（中文 / 空格可原样还原），磁盘名恒为 uuid，与它无关。
  // ext-value 的 value 段不能含 '（它是 charset'language'value 的分隔符），必须一并转义
  c.header('Content-Type', mime)
  c.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g, '%27')}`)
  c.header('Cache-Control', opts.cache ?? IMMUTABLE)
  if (!opts.range) return body(c, filePath)
  // 原文件支持单段 Range：视频 / 音频拖进度只拉需要的那段，不必整个重下（带宽）
  const { size } = await stat(filePath)
  c.header('Accept-Ranges', 'bytes')
  const range = parseRange(c.req.header('Range'), size)
  if (range === 'unsatisfiable') {
    c.header('Content-Range', `bytes */${size}`)
    return c.body(null, 416)
  }
  if (!range) {
    c.header('Content-Length', String(size))
    return body(c, filePath)
  }
  c.header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
  c.header('Content-Length', String(range.end - range.start + 1))
  c.status(206)
  return body(c, filePath, range)
}

export function filesRoutes(pool: Pool, imgbed: ImgbedSync) {
  const app = new Hono<AuthEnv>()

  // 图床里有这份就回 302，否则回本地出时用的缓存头（带 ?direct、图床关着、永远不上图床都是一年 immutable）
  async function toBed(c: Context, id: string, variant: FileVariant, candidate = true): Promise<Response | { cache: string }> {
    if (c.req.query('direct') !== undefined) return { cache: IMMUTABLE }
    const { url, pending } = await imgbed.route(id, variant, candidate)
    if (!url) return { cache: pending ? PENDING_CACHE : IMMUTABLE }
    c.header('Cache-Control', REDIRECT_CACHE)
    return c.redirect(url, 302)
  }

  // 10MB 只挂本子应用：bodyLimit 会整个经手请求体，全局挂会拖累所有 JSON 端点
  const limit = bodyLimit({
    maxSize: MAX_FILE_SIZE,
    onError: (c) => c.json({ error: 'file too large' }, 413),
  })

  app.post('/api/files', requireAuth(pool), limit, async (c) => {
    const body = await c.req.parseBody()
    const file = body['file']
    if (!(file instanceof File)) return c.json({ error: 'file required' }, 400)
    const stored = await storeFile(pool, Buffer.from(await file.arrayBuffer()), file.name, file.type, (id) => imgbed.enqueue(id))
    return c.json(stored, 201)
  })

  // 两个 GET 刻意不鉴权：公开页匿名访客要能看图，uuid 不可枚举即权限边界。
  // 磁盘路径用 DB 里的 id 拼而不是请求参数，id 合法性由表兜住，杜绝路径拼接类问题
  app.get('/api/files/:id', async (c) => {
    const row = (await pool.query<FileRow>(SELECT_FILE, [c.req.param('id')])).rows[0]
    if (!row) return c.json({ error: 'file not found' }, 404)
    const bed = await toBed(c, row.id, 'orig', row.mime.startsWith('image/'))
    if (bed instanceof Response) return bed
    return streamFile(c, variantPath(row.id, 'orig'), row.mime, row.name, { range: true, cache: bed.cache })
  })

  app.get('/api/files/:id/display', async (c) => {
    const row = (await pool.query<FileRow>(SELECT_FILE, [c.req.param('id')])).rows[0]
    if (!row) return c.json({ error: 'file not found' }, 404)
    const displayPath = variantPath(row.id, 'display')
    // 有 display 版回 webp，没有（非图片 / gif / 生成失败）退原图，调用方无需区分（图床跳转同一条退法）
    const local = existsSync(displayPath)
    const bed = await toBed(c, row.id, local ? 'display' : 'orig', local || row.mime.startsWith('image/'))
    if (bed instanceof Response) return bed
    if (local) return streamFile(c, displayPath, 'image/webp', row.name, { cache: bed.cache })
    return streamFile(c, variantPath(row.id, 'orig'), row.mime, row.name, { cache: bed.cache })
  })

  // 页面图标派生版：方形 160 小图，页面 icon 唯一读入口。与上面两个 GET 同契约：
  // 不鉴权（公开页匿名访客要能看图），uuid 不可枚举即权限边界，调用方同样无需区分，生成失败（非图片）退原图。
  // 缓存策略沿用 streamFile 里的 immutable（uuid 即内容版本）
  app.get('/api/files/:id/icon', async (c) => {
    const row = (await pool.query<FileRow>(SELECT_FILE, [c.req.param('id')])).rows[0]
    if (!row) return c.json({ error: 'file not found' }, 404)
    const bed = await toBed(c, row.id, 'icon')
    if (bed instanceof Response) return bed
    // 刚生成的图标入队镜像，已在盘上的由定时扫描补（只扫真被当图标 / 头像用的文件）
    const iconPath = await iconDerivative(row.id, () => imgbed.enqueue(row.id, ['icon']))
    if (iconPath) return streamFile(c, iconPath, 'image/webp', row.name, { cache: bed.cache })
    // 生成不了图标（非图片）：退原图，永远不上图床
    return streamFile(c, variantPath(row.id, 'orig'), row.mime, row.name)
  })

  return app
}
