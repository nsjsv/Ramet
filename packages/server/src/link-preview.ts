// ---------- 网页书签的元信息：服务端现抓、只放内存 ----------
// 书签块里只存 URL。卡片渲染时前端来要标题 / 描述 / 预览图 / 站点图标，这里替它抓网页的 <head> 解析出来。
// 结果只进进程内缓存（成功 6 小时、失败 10 分钟），不落库；图片地址原样给前端外链，服务端不碰图片。
// 出站一律走 endpoint-guard 的防护 fetch：只认 http(s)，DNS 与连接期双重校验内网地址，重定向逐跳重新校验。
// 抓不到（站点挂了、超时、不是网页、地址被拦）一律只回 { url }：前端只显示链接，也不告诉调用方是哪一种失败，
// 免得这里成为「服务器能不能连到某个地址」的探针。
// HTML 用正则扫 <meta> / <link> / <title>，不引 HTML 解析库：只看 <head> 里少数几个标签，换来不动依赖。
// 中继（可选，RAMET_LINK_RELAY_URL + RAMET_LINK_RELAY_SECRET）：配了就一律请 Cloudflare Worker（仓库 cloudflare/link-fetch/）
// 把 <head> 取回来，服务器自己不再出站（机房 IP 可能被目标地区封了，直连只会白等超时），解析照旧在这里。
// Worker 在 CF 网络里，碰不到本机和内网；地址形状照样先过一遍（localhost / 内网 IP 字面量当场拒，不发出去）。

import { assertSafeUrlShape, createSafeFetch, type SafeFetch } from './endpoint-guard.js'

export type LinkMeta = {
  /** 跟完重定向后的最终地址 */
  url: string
  title?: string
  description?: string
  image?: string
  icon?: string
  site?: string
}

export type LinkPreview = { get(url: string): Promise<LinkMeta> }

const OK_TTL = 6 * 3600_000
const FAIL_TTL = 10 * 60_000
const CACHE_MAX = 1000
const CONCURRENCY = 8
const TIMEOUT_MS = 8000
const MAX_REDIRECTS = 5
const MAX_BYTES = 1024 * 1024
const URL_MAX = 2048
const TITLE_MAX = 300
const DESC_MAX = 500

// 浏览器风格的 UA：不少站点只给像浏览器的请求返回带 OG 标签的页面；尾巴标明身份
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 RametBot/1.0',
  accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
}

/** 书签地址的形状：http(s) 绝对地址、不超长。不合格返回 null */
export function bookmarkUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > URL_MAX) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

// ---------- 解析 ----------

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
    }
    return NAMED[body.toLowerCase()] ?? m
  })
}

const clean = (s: string, max: number): string => {
  const t = decodeEntities(s).replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** 一个标签的属性表（键小写；值做实体解码） */
function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  const body = tag.replace(/^<[a-z]+/i, '').replace(/\/?>$/, '')
  for (const m of body.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    out[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
  }
  return out
}

/** 相对地址按页面地址解析，只留 http(s)、不超长 */
function absolute(raw: string | undefined, base: string): string | undefined {
  if (!raw) return undefined
  try {
    const url = new URL(raw.trim(), base)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.href.length > URL_MAX) return undefined
    return url.href
  } catch {
    return undefined
  }
}

/** 图标候选里挑一个：rel=icon 类优先（sizes 大的优先，any / svg 视为最大），没有再用 apple-touch-icon */
function pickIcon(links: Record<string, string>[], base: string): string | undefined {
  const sizeOf = (l: Record<string, string>): number => {
    if (/any/i.test(l.sizes ?? '') || /svg/i.test(l.type ?? '')) return 1e6
    const m = /(\d+)x\d+/i.exec(l.sizes ?? '')
    return m ? Number(m[1]) : 16
  }
  const rels = (l: Record<string, string>): string[] => (l.rel ?? '').toLowerCase().split(/\s+/)
  const icons = links.filter((l) => rels(l).includes('icon') && l.href).sort((a, b) => sizeOf(b) - sizeOf(a))
  const apple = links.find((l) => rels(l).some((r) => r.startsWith('apple-touch-icon')) && l.href)
  return absolute(icons[0]?.href ?? apple?.href, base) ?? absolute('/favicon.ico', base)
}

/** 网页 HTML → 元信息。只看 </head> 之前（没有 </head> 就看全文） */
export function parseLinkMeta(html: string, pageUrl: string): LinkMeta {
  const end = html.search(/<\/head\s*>/i)
  const head = end === -1 ? html : html.slice(0, end)
  const meta = new Map<string, string>()
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrsOf(m[0])
    const key = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase()
    // 同名标签以第一个为准（og:image 可以有多张，取主图）
    if (key && a.content && !meta.has(key)) meta.set(key, a.content)
  }
  const links = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => attrsOf(m[0]))
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1]
  const first = (...keys: string[]): string | undefined => keys.map((k) => meta.get(k)).find((v) => v && v.trim())

  const out: LinkMeta = { url: pageUrl }
  const title = first('og:title', 'twitter:title') ?? titleTag
  if (title && clean(title, TITLE_MAX)) out.title = clean(title, TITLE_MAX)
  const desc = first('og:description', 'twitter:description', 'description')
  if (desc && clean(desc, DESC_MAX)) out.description = clean(desc, DESC_MAX)
  const image = absolute(first('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'), pageUrl)
  if (image) out.image = image
  const icon = pickIcon(links, pageUrl)
  if (icon) out.icon = icon
  const site = first('og:site_name', 'application-name')
  if (site && clean(site, TITLE_MAX)) out.site = clean(site, TITLE_MAX)
  return out
}

/** 字节 → 文本：Content-Type 的 charset > 前 4KB 里的 <meta charset> / http-equiv > utf-8；认不出的编码名退 utf-8 */
export function decodeHtml(bytes: Uint8Array, contentType: string): string {
  const sniff = Buffer.from(bytes.subarray(0, 4096)).toString('latin1')
  const label =
    /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1] ??
    /<meta\b[^>]*charset\s*=\s*["']?([\w-]+)/i.exec(sniff)?.[1] ??
    'utf-8'
  try {
    return new TextDecoder(label.toLowerCase()).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** 读响应体直到 </head> 或上限，然后断开（不为一页正文下载几 MB） */
async function readHead(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || !value) break
      const chunk = Buffer.from(value)
      chunks.push(chunk)
      size += chunk.length
      // 标签可能跨块：带上前一块的尾巴一起找
      const window = Buffer.concat(chunks.slice(-2)).toString('latin1')
      if (size >= MAX_BYTES || /<\/head\s*>/i.test(window)) break
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks).subarray(0, MAX_BYTES)
}

function lastSegment(url: string): string | undefined {
  try {
    const seg = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '')
    return seg ? clean(seg, TITLE_MAX) : undefined
  } catch {
    return undefined
  }
}

// ---------- 抓取 + 缓存 ----------

export type LinkRelay = { url: string; secret: string }

/** RAMET_LINK_RELAY_URL / RAMET_LINK_RELAY_SECRET 都设了才开中继 */
export function relayFromEnv(env: NodeJS.ProcessEnv = process.env): LinkRelay | null {
  const url = env.RAMET_LINK_RELAY_URL?.trim()
  const secret = env.RAMET_LINK_RELAY_SECRET?.trim()
  return url && secret ? { url: url.replace(/\/+$/, ''), secret } : null
}

export type LinkPreviewDeps = {
  /** 测试注入（放行本机地址、换 http 传输）；缺省 = 生产防护 fetch（允许 http） */
  fetch?: SafeFetch
  /** 中继：undefined = 读环境变量；null = 不用 */
  relay?: LinkRelay | null
  /** 请求中继用的 fetch（测试注入）；中继地址是配置给的、可信，不过出站防护 */
  relayFetch?: typeof fetch
  now?: () => number
}

export function createLinkPreview(deps: LinkPreviewDeps = {}): LinkPreview {
  const safeFetch = deps.fetch ?? createSafeFetch({ allowHttp: true })
  const now = deps.now ?? Date.now
  const relay = deps.relay === undefined ? relayFromEnv() : deps.relay
  const relayFetch = deps.relayFetch ?? fetch
  // Map 的插入序当 LRU：命中时删了重插到队尾，满了删队首
  const cache = new Map<string, { at: number; ttl: number; value: Promise<LinkMeta> }>()
  let running = 0
  const waiting: (() => void)[] = []

  async function slot<T>(fn: () => Promise<T>): Promise<T> {
    if (running >= CONCURRENCY) await new Promise<void>((r) => waiting.push(r))
    running++
    try {
      return await fn()
    } finally {
      running--
      waiting.shift()?.()
    }
  }

  async function direct(start: string): Promise<LinkMeta | null> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      let url = start
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const res = await safeFetch(url, { headers: HEADERS, redirect: 'manual', signal: ctrl.signal })
        if (res.status >= 300 && res.status < 400) {
          const next = absolute(res.headers.get('location') ?? undefined, url)
          if (!next) return null
          url = next
          continue
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined)
          return null
        }
        const type = res.headers.get('content-type') ?? ''
        if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
          await res.body?.cancel().catch(() => undefined)
          const title = lastSegment(url)
          return title ? { url, title } : { url }
        }
        return parseLinkMeta(decodeHtml(await readHead(res.body), type), url)
      }
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async function viaRelay(url: string, cfg: LinkRelay): Promise<LinkMeta | null> {
    const res = await relayFetch(`${cfg.url}/?url=${encodeURIComponent(url)}`, {
      headers: { authorization: `Bearer ${cfg.secret}` },
      signal: AbortSignal.timeout(TIMEOUT_MS + 2000),
    })
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      return null
    }
    const status = Number(res.headers.get('x-target-status'))
    const final = bookmarkUrl(res.headers.get('x-final-url') ?? '') ?? url
    const type = res.headers.get('x-target-type') ?? ''
    const bytes = new Uint8Array(await res.arrayBuffer()).subarray(0, MAX_BYTES)
    if (!(status >= 200 && status < 300)) return null
    if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
      const title = lastSegment(final)
      return title ? { url: final, title } : { url: final }
    }
    return parseLinkMeta(decodeHtml(bytes, type), final)
  }

  async function fetchMeta(url: string): Promise<LinkMeta | null> {
    if (!relay) return direct(url)
    assertSafeUrlShape(url, { allowHttp: true })
    return viaRelay(url, relay)
  }

  return {
    get(url) {
      const hit = cache.get(url)
      if (hit && now() - hit.at < hit.ttl) {
        cache.delete(url)
        cache.set(url, hit)
        return hit.value
      }
      const entry = { at: now(), ttl: OK_TTL, value: Promise.resolve<LinkMeta>({ url }) }
      entry.value = slot(() => fetchMeta(url)).then(
        (meta) => {
          if (meta) return meta
          entry.ttl = FAIL_TTL
          return { url }
        },
        () => {
          entry.ttl = FAIL_TTL
          return { url }
        },
      )
      cache.delete(url)
      cache.set(url, entry)
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
      return entry.value
    },
  }
}
