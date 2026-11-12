// ---------- Web Push 的协议层：加密（RFC 8291）、VAPID 签名（RFC 8292）、往推送服务发一条 ----------
// 只用 node:crypto / node:https，不引 web-push 包。推送服务由浏览器决定（Chrome → FCM、Firefox → Mozilla、
// Safari → Apple、Edge → 微软），我们只往订阅给的 endpoint 发，所以不需要任何开发者账号或 API key。
//
// endpoint 是用户提交的地址、由服务器去请求：只认已知推送服务的 https 主机（checkEndpoint），否则就是内网探测跳板。
// 这里不做「解析结果不能落在内网」那一套（endpoint-guard.ts）：主机已经限死在几家公共服务上，再查 DNS 只会在
// 走 fake-ip 代理的机器上把它们全拦掉。

import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'

const b64 = (buf: Buffer): string => buf.toString('base64url')
const unb64 = (text: string): Buffer => Buffer.from(text, 'base64url')
const cat = (...parts: (Buffer | string | number[])[]): Buffer =>
  Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.isBuffer(p) ? p : Buffer.from(p))))
const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest()
/** ECDH 私钥按大数导出，高位是 0 时会短于 32 字节；JWK 的 d 必须定长 */
const pad32 = (buf: Buffer): Buffer => (buf.length >= 32 ? buf : Buffer.concat([Buffer.alloc(32 - buf.length), buf]))

/** VAPID 密钥对：公钥 = 65 字节未压缩点，私钥 = 32 字节，都是 base64url */
export type VapidKeys = { publicKey: string; privateKey: string }

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(pad32(ecdh.getPrivateKey())) }
}

/** 浏览器订阅里给的两把：p256dh = 浏览器的 ECDH 公钥（65 字节），auth = 16 字节认证密钥 */
export type PushKeys = { p256dh: string; auth: string }

/** 只有 RFC 附录 A 的向量测试会传：固定盐与发送方私钥 */
export type FixedEncryption = { salt: Buffer; senderPrivate: Buffer }

/** 单条推送里明文的上限（RFC 8291 第 4 节：4096 − 头 86 − 分隔符 1 − 标签 16） */
export const MAX_PLAINTEXT = 3993
const RECORD_SIZE = 4096

/** aes128gcm 内容编码，单记录。浏览器公钥不在 P-256 上时 computeSecret 会抛错（RFC 要求的校验） */
export function encryptPayload(plaintext: Buffer, keys: PushKeys, fixed?: FixedEncryption): Buffer {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error('push payload too large')
  const uaPublic = unb64(keys.p256dh)
  const authSecret = unb64(keys.auth)
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error('invalid subscription keys')
  const sender = createECDH('prime256v1')
  if (fixed) sender.setPrivateKey(fixed.senderPrivate)
  else sender.generateKeys()
  const asPublic = sender.getPublicKey()
  const ecdhSecret = sender.computeSecret(uaPublic)
  const ikm = hmac(hmac(authSecret, ecdhSecret), cat('WebPush: info\0', uaPublic, asPublic, [1]))
  const salt = fixed?.salt ?? randomBytes(16)
  const prk = hmac(salt, ikm)
  const cek = hmac(prk, cat('Content-Encoding: aes128gcm\0', [1])).subarray(0, 16)
  const nonce = hmac(prk, cat('Content-Encoding: nonce\0', [1])).subarray(0, 12)
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const sealed = cat(cipher.update(cat(plaintext, [2])), cipher.final(), cipher.getAuthTag())
  const rs = Buffer.alloc(4)
  rs.writeUInt32BE(RECORD_SIZE)
  return cat(salt, rs, [asPublic.length], asPublic, sealed)
}

/** RFC 8292：`Authorization: vapid t=<JWT>, k=<公钥>`。aud = 推送服务的 origin；exp 不能超过 24 小时，取 12 小时 */
export function vapidAuthorization(endpoint: URL, keys: VapidKeys, subject: string, nowMs = Date.now()): string {
  const pub = unb64(keys.publicKey)
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)), d: keys.privateKey },
    format: 'jwk',
  })
  const head = b64(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64(Buffer.from(JSON.stringify({ aud: endpoint.origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject })))
  const signature = sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${head}.${claims}.${b64(signature)}, k=${keys.publicKey}`
}

/** 已知推送服务的主机：完整名，或以点开头表示「这个域名下的任意子域」。
 *  Chrome 正式版给 fcm.googleapis.com；Chromium 开源构建（各发行版自带的、Playwright 的）给 jmt17.google.com 这类，
 *  所以放行整个 google.com（都是 Google 的公网服务，碰不到内网） */
export const PUSH_HOSTS = ['fcm.googleapis.com', '.google.com', '.push.services.mozilla.com', '.notify.windows.com', '.push.apple.com']

/** 默认清单 + RAMET_PUSH_HOSTS（逗号分隔，写法同上），给接了别家推送服务的浏览器用 */
export function pushHostsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.RAMET_PUSH_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
  return [...PUSH_HOSTS, ...extra]
}

const ENDPOINT_MAX = 2048

/** 订阅地址能不能发：https、没有用户名密码、默认端口、主机在清单里。不能发返回 null */
export function checkEndpoint(raw: string, hosts: readonly string[]): URL | null {
  if (raw.length > ENDPOINT_MAX) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
  const host = url.hostname.toLowerCase()
  const ok = hosts.some((h) => (h.startsWith('.') ? host.endsWith(h) && host.length > h.length : host === h))
  return ok ? url : null
}

/** 连不上推送服务（DNS / 超时 / 代理拒绝……）。message 是给人看的，不带响应内容 */
export class PushNetworkError extends Error {
  constructor(
    readonly host: string,
    readonly code: string,
  ) {
    super(`连不上推送服务 ${host}（${code}）`)
  }
}

export type PushResponse = { status: number }
export type PushTransport = (url: URL, headers: Record<string, string>, body: Buffer) => Promise<PushResponse>

/** RAMET_PUSH_PROXY > HTTPS_PROXY > https_proxy；只认 http:// 代理（经 CONNECT 建隧道） */
export function pushProxyFromEnv(env: NodeJS.ProcessEnv = process.env): URL | null {
  const raw = (env.RAMET_PUSH_PROXY || env.HTTPS_PROXY || env.https_proxy || '').trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol === 'http:') return url
  } catch {
    // 落到下面的提示
  }
  console.warn(`[push] 推送代理只支持 http://，忽略：${raw.replace(/\/\/[^@/]*@/, '//***@')}`)
  return null
}

const TIMEOUT_MS = 10_000

const errCode = (err: unknown): string => {
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : err instanceof Error ? err.message : String(err)
}

/** 经 http 代理的 CONNECT 隧道拿到一条到 host:443 的原始连接 */
function tunnel(proxy: URL, host: string): Promise<import('node:net').Socket> {
  return new Promise((resolve, reject) => {
    const auth = proxy.username ? { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` } : {}
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: `${host}:443`,
      headers: { host: `${host}:443`, ...auth },
      timeout: TIMEOUT_MS,
    })
    req.once('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket)
      else {
        socket.destroy()
        reject(Object.assign(new Error('proxy refused'), { code: `代理返回 ${res.statusCode}` }))
      }
    })
    req.once('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))
    req.once('error', reject)
    req.end()
  })
}

/** 真发：每次新开连接（不复用 keep-alive），10 秒超时，响应体读完丢掉（只看状态码） */
export function createTransport(proxy: URL | null = pushProxyFromEnv()): PushTransport {
  return async (url, headers, body) => {
    const host = url.hostname
    try {
      const socket = proxy ? await tunnel(proxy, host) : null
      return await new Promise<PushResponse>((resolve, reject) => {
        const req = https.request({
          hostname: host,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: { ...headers, 'content-length': String(body.length) },
          agent: false,
          timeout: TIMEOUT_MS,
          ...(socket && { createConnection: () => tls.connect({ socket, servername: host }) }),
        })
        req.once('response', (res) => {
          res.resume()
          res.once('end', () => resolve({ status: res.statusCode ?? 0 }))
          res.once('error', reject)
        })
        req.once('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))
        req.once('error', reject)
        req.end(body)
      })
    } catch (err) {
      throw new PushNetworkError(host, errCode(err))
    }
  }
}

/** 发一条：加密 + 签名 + POST。endpoint 必须是 checkEndpoint 放行过的；ttl 秒；urgency 见 RFC 8030 5.3 */
export async function sendPush(
  endpoint: URL,
  keys: PushKeys,
  payload: unknown,
  opts: { vapid: VapidKeys; subject: string; transport: PushTransport; ttl?: number; urgency?: 'normal' | 'high' },
): Promise<PushResponse> {
  const body = encryptPayload(Buffer.from(JSON.stringify(payload)), keys)
  return opts.transport(
    endpoint,
    {
      authorization: vapidAuthorization(endpoint, opts.vapid, opts.subject),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(opts.ttl ?? 86_400),
      urgency: opts.urgency ?? 'normal',
    },
    body,
  )
}
