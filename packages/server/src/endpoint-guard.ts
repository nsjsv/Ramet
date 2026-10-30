// ---------- 出站地址防护（SSRF）----------
// 随手 AI 允许用户填自己的模型服务地址，服务器会替他去请求。没有防护的话，这就是一个让任何登录用户探测内网、
// 打云元数据（169.254.169.254）的跳板。防线（缺一不可）：
//   1. 只允许 https:，地址里不带用户名密码；
//   2. 域名解析出的每一个地址都不能落在回环 / 私网 / 链路本地 / CGNAT / 保留段（含 IPv4 映射 / NAT64 / 6to4 的 IPv6 写法）；
//   3. 连接阶段再校验一次，并且只连校验过的那个地址（自定义 lookup），防 DNS 重绑定：保存时解析到公网、
//      请求时解析到内网，也过不了；
//   4. 不跟随重定向（3xx 直接报错），否则一个公网地址一跳就能跳进内网；
//   5. 每个请求新开连接（agent:false）：不复用旧 keep-alive 连接，每次都重新走第 2、3 步。
// 官方 Anthropic 地址（没填 baseUrl）不经过这里。
// 网页书签抓元信息（link-preview.ts）也走这里，多两个开关：允许 http:（allowHttp），以及 3xx 交回调用方逐跳跟随
// （init.redirect = 'manual'）——调用方对每一跳重新调用本函数，形状、DNS、连接期三道校验一跳不落。
// 不用 undici：它不是本仓库的直接依赖；node:https 的 lookup 钩子足够做连接阶段校验，并且能直接给 SDK 当 fetch 注入。

import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'

/** 地址不被允许（用户可读的原因在 message 里）。code 用来跨 SDK 的 cause 链识别它 */
export class UnsafeEndpointError extends Error {
  readonly code = 'RAMET_UNSAFE_ENDPOINT'
}

export function isUnsafeEndpointError(err: unknown): err is UnsafeEndpointError {
  return err instanceof UnsafeEndpointError || (err instanceof Error && (err as { code?: unknown }).code === 'RAMET_UNSAFE_ENDPOINT')
}

export type ResolvedAddress = { address: string; family: number }
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>

/** 默认解析：系统解析器（getaddrinfo，认 /etc/hosts），要全部结果 */
export const systemResolve: Resolver = async (hostname) => {
  const list = await dns.promises.lookup(hostname, { all: true, verbatim: true })
  return list.map((a) => ({ address: a.address, family: a.family }))
}

// ---------- 地址判定 ----------

// [基址, 前缀长度]。公网服务不会落在这些段；宁可多拦（测试网段 / 基准测试 / 组播 / 保留）
const FORBIDDEN_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // 本网络
  ['10.0.0.0', 8], // 私网
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // 回环
  ['169.254.0.0', 16], // 链路本地（含云元数据 169.254.169.254）
  ['172.16.0.0', 12], // 私网
  ['192.0.0.0', 24], // IETF 协议分配
  ['192.0.2.0', 24], // 文档用 TEST-NET-1
  ['192.168.0.0', 16], // 私网
  ['198.18.0.0', 15], // 基准测试
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4], // 保留（含 255.255.255.255 广播）
]

function v4ToInt(addr: string): number | null {
  const parts = addr.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n
}

function v4Forbidden(addr: string): boolean {
  const n = v4ToInt(addr)
  if (n === null) return true // 解析不了：宁可拒绝
  return FORBIDDEN_V4.some(([base, bits]) => {
    const b = v4ToInt(base) as number
    const size = 2 ** (32 - bits)
    return Math.floor(n / size) === Math.floor(b / size)
  })
}

/** IPv6 文本 → 8 个 16 位组；认 `::` 压缩、末尾内嵌的点分 IPv4、%zone。解析不了返回 null */
function parseV6(raw: string): number[] | null {
  const addr = raw.split('%')[0] ?? ''
  let text = addr
  // 末尾的点分 IPv4（::ffff:127.0.0.1）折成两个十六进制组
  const dot = text.lastIndexOf('.')
  if (dot !== -1) {
    const colon = text.lastIndexOf(':')
    const n = v4ToInt(text.slice(colon + 1))
    if (n === null) return null
    text = `${text.slice(0, colon + 1)}${(Math.floor(n / 65536)).toString(16)}:${(n % 65536).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parseGroups = (s: string): number[] | null => {
    if (s === '') return []
    const out: number[] = []
    for (const g of s.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }
  const head = parseGroups(halves[0] ?? '')
  if (!head) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const tail = parseGroups(halves[1] ?? '')
  if (!tail) return null
  const fill = 8 - head.length - tail.length
  if (fill < 1) return null
  return [...head, ...new Array<number>(fill).fill(0), ...tail]
}

function embeddedV4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

function v6Forbidden(addr: string): boolean {
  const h = parseV6(addr)
  if (!h) return true
  const [h0, h1, h2, h3, h4, h5, h6, h7] = h as [number, number, number, number, number, number, number, number]
  // :: 与 ::1
  if (h.every((x) => x === 0)) return true
  if (h.slice(0, 7).every((x) => x === 0) && h7 === 1) return true
  // IPv4 映射（::ffff:a.b.c.d）与已弃用的 IPv4 兼容（::a.b.c.d）：按内嵌的 IPv4 判
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && (h5 === 0xffff || h5 === 0)) {
    return v4Forbidden(embeddedV4(h6, h7))
  }
  // NAT64：64:ff9b::/96 内嵌 IPv4；64:ff9b:1::/48 是本地用途，整段不要
  if (h0 === 0x64 && h1 === 0xff9b) {
    if (h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) return v4Forbidden(embeddedV4(h6, h7))
    return true
  }
  // 6to4：2002::/16，IPv4 在第 2、3 组
  if (h0 === 0x2002) return v4Forbidden(embeddedV4(h1, h2))
  if ((h0 & 0xfe00) === 0xfc00) return true // fc00::/7 唯一本地
  if ((h0 & 0xffc0) === 0xfe80) return true // fe80::/10 链路本地
  if ((h0 & 0xffc0) === 0xfec0) return true // fec0::/10 站点本地（已弃用）
  if ((h0 & 0xff00) === 0xff00) return true // ff00::/8 组播
  if (h0 === 0x2001 && (h1 === 0 || h1 === 0xdb8)) return true // Teredo / 文档段
  if (h0 === 0x100 && h1 === 0 && h2 === 0 && h3 === 0) return true // 100::/64 黑洞
  return false
}

/** 这个 IP 字面量是否禁止出站。认不出是不是 IP → 也禁止（失败即拒绝） */
export function isForbiddenAddress(address: string): boolean {
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address
  const family = isIP(bare.split('%')[0] ?? '')
  if (family === 4) return v4Forbidden(bare)
  if (family === 6) return v6Forbidden(bare)
  return true
}

// ---------- 地址校验 ----------

const FORBIDDEN_MESSAGE = '这个地址指向本机、内网或保留地址，不允许'
// 域名这一类故意只给一句话：解析不到 与 解析到内网 对用户说成同一件事，免得这里变成「探测服务器内网有哪些域名」的预言机
const UNUSABLE_MESSAGE = '这个地址不可用：域名解析不到，或者指向了本机、内网、保留地址'

/** 地址形状：https（allowHttp 时也认 http）、不带用户名密码、有主机名；主机名是 IP 字面量时当场查范围。返回解析后的 URL */
export function assertSafeUrlShape(raw: string | URL, opts: { allowHttp?: boolean } = {}): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UnsafeEndpointError('地址格式不对')
  }
  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) {
    throw new UnsafeEndpointError(opts.allowHttp ? '只允许 http(s) 地址' : '只允许 https 地址')
  }
  if (url.username || url.password) throw new UnsafeEndpointError('地址里不能带用户名和密码')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new UnsafeEndpointError('地址缺少主机名')
  // RFC 6761：localhost 与 *.localhost 永远是本机，不依赖 DNS 怎么答（某些解析器 / hosts 配置不一定给回环）
  const name = host.toLowerCase().replace(/\.+$/, '') // 末尾的点是合法的绝对域名写法（localhost.）
  if (name === 'localhost' || name.endsWith('.localhost')) throw new UnsafeEndpointError(FORBIDDEN_MESSAGE)
  // WHATWG URL 已把 0x7f.1 / 2130706433 这类写法规整成点分十进制，这里拿到的就是最终的字面量
  if (isIP(host) && isForbiddenAddress(host)) throw new UnsafeEndpointError(FORBIDDEN_MESSAGE)
  return url
}

/** 解析并检查一个主机名的全部地址；任何一个落在禁止段都拒绝。返回通过检查的地址 */
export async function resolveChecked(
  hostname: string,
  resolve: Resolver,
  forbidden: (address: string) => boolean = isForbiddenAddress,
): Promise<ResolvedAddress[]> {
  let list: ResolvedAddress[]
  try {
    list = await resolve(hostname)
  } catch {
    throw new UnsafeEndpointError(UNUSABLE_MESSAGE)
  }
  if (list.length === 0 || list.some((a) => forbidden(a.address))) throw new UnsafeEndpointError(UNUSABLE_MESSAGE)
  return list
}

/** 保存连接 / 测试连接 / 每次请求前的校验：形状 + DNS 解析结果。通过返回 URL，不通过抛 UnsafeEndpointError */
export async function validateEndpoint(raw: string | URL, deps: { resolve?: Resolver } = {}): Promise<URL> {
  const url = assertSafeUrlShape(raw)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!isIP(host)) await resolveChecked(host, deps.resolve ?? systemResolve)
  return url
}

// ---------- 连接阶段校验 ----------

/**
 * net.connect 用的 lookup：解析 → 逐个检查 → 只把检查过的地址交给 socket。
 * 这是 DNS 重绑定的真正防线：连的就是这里验过的地址，不存在「验一次、连一次、两次解析不同」的间隙。
 */
export function createGuardedLookup(resolve: Resolver, forbidden: (address: string) => boolean = isForbiddenAddress) {
  return (
    hostname: string,
    options: unknown,
    callback?: (err: Error | null, address?: string | ResolvedAddress[], family?: number) => void,
  ): void => {
    const cb = (typeof options === 'function' ? options : callback) as NonNullable<typeof callback>
    const wantAll = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true
    resolveChecked(hostname, resolve, forbidden).then(
      (list) => {
        if (wantAll) cb(null, list)
        else cb(null, list[0]!.address, list[0]!.family)
      },
      (err: unknown) => cb(err instanceof Error ? err : new UnsafeEndpointError(FORBIDDEN_MESSAGE)),
    )
  }
}

// ---------- 防护版 fetch ----------

/** 传输层空闲超时：对端这么久一个字节都不发就断（流式响应也算，每个分片都会续期） */
const IDLE_TIMEOUT_MS = 60_000
/** 无响应体的状态码：构造 Response 时 body 必须为 null */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304])

export type SafeFetchDeps = {
  resolve?: Resolver
  /** 测试注入：默认 node:https。测试用本机 http 服务验证重定向 / 流式读取，不用真证书 */
  transport?: { request: typeof https.request }
  /** 测试注入：判定「禁止地址」。生产永远用默认实现 */
  forbidden?: (address: string) => boolean
  /** 也允许 http: 地址（走 httpTransport）。缺省只认 https */
  allowHttp?: boolean
  /** http: 地址用的传输，缺省 node:http */
  httpTransport?: { request: typeof http.request }
}

type FetchInput = string | URL | Request
export type SafeFetch = (input: FetchInput, init?: RequestInit) => Promise<Response>

/**
 * 造一个 fetch 兼容函数，所有请求走上面的防线。可直接塞给 Anthropic SDK 的 `fetch` 选项，
 * 也被 OpenAI 兼容通道直接调用。3xx 一律抛错（不跟随）。
 */
export function createSafeFetch(deps: SafeFetchDeps = {}): SafeFetch {
  const resolve = deps.resolve ?? systemResolve
  const transport = deps.transport ?? https
  const forbidden = deps.forbidden ?? isForbiddenAddress
  const httpTransport = deps.httpTransport ?? http
  const lookup = createGuardedLookup(resolve, forbidden)

  return (input, init) =>
    new Promise<Response>((resolveResponse, reject) => {
      let url: URL
      try {
        url = assertSafeUrlShape(typeof input === 'string' || input instanceof URL ? input : input.url, { allowHttp: deps.allowHttp })
      } catch (err) {
        reject(err)
        return
      }
      const signal = init?.signal ?? null
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('已取消', 'AbortError'))
        return
      }

      const body = init?.body
      let payload: Buffer | null = null
      if (body === undefined || body === null) payload = null
      else if (typeof body === 'string') payload = Buffer.from(body)
      else if (body instanceof Uint8Array) payload = Buffer.from(body)
      else if (body instanceof ArrayBuffer) payload = Buffer.from(body)
      else {
        reject(new TypeError('防护版 fetch 只支持字符串或二进制请求体'))
        return
      }

      const headers = new Headers(init?.headers)
      headers.delete('host')
      // 不让对端压缩：Node 的 https 不会自动解压，流式回复本来也不需要
      headers.set('accept-encoding', 'identity')
      if (payload) headers.set('content-length', String(payload.length))

      const req = (url.protocol === 'http:' ? httpTransport : transport).request(
        {
          hostname: url.hostname.replace(/^\[|\]$/g, ''),
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? 'GET',
          headers: Object.fromEntries(headers),
          // 每个请求新开连接：不复用 keep-alive，保证每次都重新过 lookup 校验
          agent: false,
          lookup: lookup as unknown as https.RequestOptions['lookup'],
        },
        (res) => {
          const status = res.statusCode ?? 0
          if (status >= 300 && status < 400 && init?.redirect === 'manual') {
            // 交回调用方：只带状态与 Location，下一跳由调用方重新经本函数发起（重新校验）
            res.resume()
            const location = res.headers.location
            resolveResponse(new Response(null, { status, headers: location ? { location } : {} }))
            return
          }
          if (status >= 300 && status < 400) {
            // 不跟随重定向：公网地址一跳就能跳进内网。Location 不回显（可能指向内网）
            res.destroy()
            reject(new UnsafeEndpointError(`服务返回了重定向（${status}），出于安全不会跟随，请直接填最终地址`))
            return
          }
          const respHeaders = new Headers()
          for (const [name, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) for (const v of value) respHeaders.append(name, v)
            else if (value !== undefined) respHeaders.set(name, value)
          }
          const webBody = NULL_BODY_STATUS.has(status) ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>)
          if (!webBody) res.resume()
          resolveResponse(new Response(webBody, { status, statusText: res.statusMessage ?? '', headers: respHeaders }))
        },
      )

      const onAbort = (): void => {
        req.destroy((signal?.reason as Error | undefined) ?? new DOMException('已取消', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(Object.assign(new Error('模型服务长时间没有响应'), { code: 'ETIMEDOUT' })))
      req.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      })
      req.on('close', () => signal?.removeEventListener('abort', onAbort))
      req.end(payload ?? undefined)
    })
}
