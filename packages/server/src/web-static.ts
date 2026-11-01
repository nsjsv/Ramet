// ---------- 前端产物托管（packages/web/dist）：页面、协同、API 同一个端口，前面只需要一层用户自己的反代 ----------
// 挂在所有子应用之前（index.ts）：子应用自己 use('*', requireAuth)，挂得晚了匿名打开页面会被拦成 401。
// 产物目录每个请求现解析（realpath 不缓存）：部署机上它经软链指向当前 release，切换 release 后不用重启 server 就出新前端。
// 目录不存在（dev 由 vite 出页面）就整个不接管。
//
// 缓存规则：
// - 带内容哈希的 /assets/、文件名即码点的 /twemoji/、换版本就换名的精灵图：一年 immutable；
// - 其余（index.html、version.json……）no-cache + ETag：发版后浏览器拿到新的入口页，才不会去拉旧脚本；
// - 上面那些长缓存路径带查询串一律 404：前面有 CDN 时缓存键含查询串，`?x=随机数` 能绕过边缘每次回源拉一整份
//  （精灵图 2.9MB、主包 1.5MB）。前端引用它们从不带查询串；
// - /assets/、/twemoji/ 缺文件回 404，不能落进 SPA fallback：Twemoji 没有的新 emoji 靠 404 让前端 onerror 退回文本字符；
// - /dl/ 恒 404：connector 从 npm 分发，旧的 npm i -g <地址>/dl/… 要得到明确的错误，而不是把 index.html 当 tgz 解。

import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import type { Context, MiddlewareHandler } from 'hono'
import { getMimeType } from 'hono/utils/mime'

/** 归 server 自己的路径（REST 与三条 WebSocket），不当静态文件找 */
const SERVER_PATHS = ['/api', '/collab', '/term', '/connector']
const IMMUTABLE_PREFIXES = ['/assets/', '/twemoji/']
const IMMUTABLE_FILES = ['/twemoji-sprite-64.png']
const LONG = 'public, max-age=31536000, immutable'
const REVALIDATE = 'no-cache'
const COMPRESSIBLE = /^(text\/|application\/(javascript|json|manifest\+json|xml|wasm)|image\/svg\+xml)/
/** 小于这个不压：省下的字节抵不过一次压缩 */
const GZIP_MIN_BYTES = 1024
/** 压缩结果的内存缓存上限：首屏那几个包每个请求重压一遍太浪费，旧 release 带过来的 chunk 又多，不能无限存 */
const GZIP_CACHE_BYTES = 64 * 1024 * 1024

/** RAMET_WEB_DIST > 与 server 包同级的 web/dist（仓库里、镜像里都是这个布局） */
export function webRootFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.RAMET_WEB_DIST?.trim()
  return fromEnv ? resolve(fromEnv) : resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist')
}

type Found = { file: string; size: number; mtime: Date }

/** root 里的普通文件；越出 root（含经软链越出）、不存在、是目录都回 null */
async function findFile(root: string, path: string): Promise<Found | null> {
  if (path.includes('\0')) return null
  const full = resolve(root, `.${path}`)
  if (!full.startsWith(root + sep)) return null
  try {
    const real = await realpath(full)
    if (!real.startsWith(root + sep)) return null
    const st = await stat(real)
    return st.isFile() ? { file: real, size: st.size, mtime: st.mtime } : null
  } catch {
    return null
  }
}

/** 按插入序淘汰的压缩缓存，键里带 mtime / size：同名文件换了内容自然失效 */
class GzipCache {
  private readonly entries = new Map<string, Buffer>()
  private bytes = 0
  constructor(private readonly limit: number) {}

  get(key: string): Buffer | undefined {
    const hit = this.entries.get(key)
    if (hit) {
      this.entries.delete(key)
      this.entries.set(key, hit)
    }
    return hit
  }

  set(key: string, value: Buffer): void {
    if (value.length > this.limit) return
    this.entries.set(key, value)
    this.bytes += value.length
    for (const [k, v] of this.entries) {
      if (this.bytes <= this.limit) break
      this.entries.delete(k)
      this.bytes -= v.length
    }
  }
}

function notFound(c: Context): Response {
  return c.text('Not Found', 404)
}

export function webStatic(root: string): MiddlewareHandler {
  const gzipped = new GzipCache(GZIP_CACHE_BYTES)

  async function send(c: Context, found: Found, cacheControl: string): Promise<Response> {
    const type = getMimeType(found.file) ?? 'application/octet-stream'
    const etag = `W/"${found.size.toString(16)}-${Math.floor(found.mtime.getTime()).toString(16)}"`
    const headers = new Headers({
      'Content-Type': type,
      'Cache-Control': cacheControl,
      ETag: etag,
      'Last-Modified': found.mtime.toUTCString(),
    })
    const compressible = COMPRESSIBLE.test(type) && found.size >= GZIP_MIN_BYTES
    if (compressible) headers.set('Vary', 'Accept-Encoding')
    const ifNoneMatch = c.req.header('if-none-match')
    if (ifNoneMatch?.split(',').some((t) => t.trim() === etag)) return new Response(null, { status: 304, headers })

    let body: Buffer
    if (compressible && /\bgzip\b/.test(c.req.header('accept-encoding') ?? '')) {
      const key = `${found.file}\0${etag}`
      const hit = gzipped.get(key)
      body = hit ?? gzipSync(await readFile(found.file))
      if (!hit) gzipped.set(key, body)
      headers.set('Content-Encoding', 'gzip')
    } else {
      body = await readFile(found.file)
    }
    headers.set('Content-Length', String(body.length))
    return new Response(c.req.method === 'HEAD' ? null : new Uint8Array(body), { status: 200, headers })
  }

  return async (c, next) => {
    const method = c.req.method
    if (method !== 'GET' && method !== 'HEAD') return next()
    const path = c.req.path
    if (SERVER_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return next()

    let base: string
    try {
      base = await realpath(root)
    } catch {
      return next()
    }
    if (path === '/dl' || path.startsWith('/dl/')) return notFound(c)
    const immutable = IMMUTABLE_FILES.includes(path) || IMMUTABLE_PREFIXES.some((p) => path.startsWith(p))
    if (immutable && new URL(c.req.url).search !== '') return notFound(c)

    const found = await findFile(base, path)
    if (found) return send(c, found, immutable ? LONG : REVALIDATE)
    if (immutable) return notFound(c)
    // SPA fallback：前端路由（/page/:id、/p/…）都落到入口页
    const index = await findFile(base, '/index.html')
    return index ? send(c, index, REVALIDATE) : next()
  }
}
