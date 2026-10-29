// ---------- 端口预览的监听：与 Ramet 不同的端口（不同源），只做预览转发 ----------
// 预览的是别人机器上的开发服务器，里面的 JS 不可信；同源的话它能带着看预览的人的 Ramet 登录态调接口（XSS），所以要单独的端口。
// 这个监听不挂任何 Ramet 路由：除了 `/__ramet/enter`（凭一次性票据换预览会话），没有有效预览会话的请求一律 404；
// 有会话的请求全部转发给那台机器上登记的端口（所以 /src/main.ts 这样的绝对路径也能用）。
//
// cookie 不分端口（同主机不同端口算同站，cookie 共享）：
//   - 转发给机器的请求里剥掉 Ramet 的 cookie（`ramet_` 前缀：登录会话、预览会话），否则看预览的人的登录令牌会进到别人的开发服务器；
//   - 预览响应里想设置 Ramet 同名 cookie 的 Set-Cookie 丢掉（防覆盖登录态 / 会话固定）；
//   - 预览会话 cookie `ramet_pv`：HttpOnly、SameSite=Lax、值是随机会话 id。
// 每个请求都重新确认：预览还在共享、此人仍可读该页、共享人仍有 machine 授权（缓存几秒，不每个请求查库）。
// 已知局限：预览页的 JS 能用 document.cookie 写同名的非 HttpOnly cookie（浏览器不按端口隔离 cookie），已有的 HttpOnly 登录 cookie 不会被覆盖。

import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Pool } from 'pg'
import { userFromRequest } from './auth.js'
import { pageAccess } from './collab.js'
import { canUse } from './agents/machine-access.js'
import type { ConnectorHub } from './agents/hub.js'
import { PreviewBusyError, PreviewOfflineError, type HttpFlight, type HttpSink, type Preview, type WsLink, type WsSink } from './agents/preview-bridge.js'
import {
  PREVIEW_METHODS,
  PREVIEW_REQ_BODY_MAX,
  PREVIEW_WS_MSG_MAX,
  isHopHeader,
  stripRametCookies,
  validRequestTarget,
  wsCloseCode,
  type HeaderPairs,
} from './agents/preview-types.js'
import { cookieValue, PREVIEW_COOKIE, type PreviewAccess } from './preview-access.js'

/** 重新确认的缓存时长 */
const REVALIDATE_MS = 5000
/** 浏览器那头写不动时，最多让多少字节堆在中心的发送缓冲里（超了掐断这个请求，不让慢客户端拖爆内存） */
const WRITE_BACKLOG_MAX = 8 * 1024 * 1024

/** 这些请求头不转给机器：逐跳头、host（connector 自己设）、expect（会让上游等 100-continue）、代理痕迹 */
const NOT_FORWARDED = new Set([
  'host', 'expect', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip',
])

const TITLES: Record<number, string> = {
  400: '请求不对',
  403: '没有权限',
  404: '没有这个页面',
  405: '不支持的请求方法',
  410: '预览已停止',
  413: '请求太大',
  502: '预览连不上',
  503: '预览正忙',
  504: '预览超时',
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

/** 预览源自己的错误页，极简、不带任何脚本，机器上的网站返回的内容不会出现在这里 */
export function sendPage(res: ServerResponse, status: number, message: string, extra: OutgoingHttpHeaders = {}): void {
  const title = TITLES[status] ?? '出错了'
  const body =
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<body style="font:15px/1.7 system-ui,sans-serif;max-width:32em;margin:12vh auto;padding:0 1em;color:#333">` +
    `<h1 style="font-size:1.25em">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body>`
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    ...extra,
  })
  res.end(body)
}

type Verdict = { ok: true } | { ok: false; status: 403 | 404; message: string }

/** 此人此刻还能不能读这个页面（角色现查，被降级 / 删号立刻生效） */
async function canRead(pool: Pool, pageId: string, userId: string): Promise<boolean> {
  const { rows } = await pool.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [userId])
  const role = rows[0]?.role
  return role !== undefined && (await pageAccess(pool, pageId, { id: userId, role })) !== null
}

/** 此人此刻还能不能看这条预览：他仍可读这个页面，共享人也仍可读这个页面（被移出空间的人留下的共享不再对读者开放），
 *  并且共享人仍有这台机器的 machine 授权（没有了就把预览停掉） */
async function reverify(pool: Pool, hub: ConnectorHub, preview: Preview, userId: string): Promise<Verdict> {
  if (!(await canRead(pool, preview.pageId, userId))) {
    return { ok: false, status: 403, message: '你已经看不到这个页面了，预览不再对你开放。' }
  }
  const sharerOk =
    (preview.sharedBy === userId || (await canRead(pool, preview.pageId, preview.sharedBy))) &&
    (await canUse(pool, preview.sharedBy, preview.connectorId, 'machine'))
  if (!sharerOk) {
    hub.previews.unshare(preview.id)
    return { ok: false, status: 404, message: '这个预览已经停止共享。' }
  }
  return { ok: true }
}

type Authorized = { preview: Preview } | { status: 403 | 404; message: string }

/** 浏览器的请求头 → 转给机器的头。sec-websocket-* 不转（connector 的 ws 客户端自己生成握手头） */
function forwardHeaders(raw: string[]): HeaderPairs {
  const out: HeaderPairs = []
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const lower = raw[i]!.toLowerCase()
    const value = raw[i + 1]!
    if (isHopHeader(lower) || NOT_FORWARDED.has(lower)) continue
    if (lower.startsWith('sec-websocket-')) continue
    if (lower === 'cookie') {
      const kept = stripRametCookies(value)
      if (kept) out.push(['cookie', kept])
      continue
    }
    out.push([lower, value])
  }
  return out
}

export type PreviewServerDeps = {
  pool: Pool
  hub: ConnectorHub
  access: PreviewAccess
  /** 重新确认的缓存时长，缺省 5 秒；设 0 = 每个请求都重新确认 */
  revalidateMs?: number
}

export type PreviewServer = {
  server: Server
  /** 监听（port 0 = 随机），返回实际端口 */
  listen(port: number): Promise<number>
  close(): Promise<void>
}

export function createPreviewServer({ pool, hub, access, revalidateMs = REVALIDATE_MS }: PreviewServerDeps): PreviewServer {
  const chosen = new WeakMap<IncomingMessage, string>()
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: PREVIEW_WS_MSG_MAX,
    perMessageDeflate: false,
    // 子协议以上游选定的为准（Vite 的 HMR 要求服务端回 vite-hmr）
    handleProtocols: (protocols, req) => {
      const want = chosen.get(req)
      return want && protocols.has(want) ? want : false
    },
  })

  /** 会话 cookie → 预览。重新确认的结果缓存 REVALIDATE_MS */
  async function authorize(sid: string | null): Promise<Authorized> {
    if (!sid) return { status: 404, message: '这里只用来看 Ramet 页面上共享的预览。请回到 Ramet 页面，点开预览。' }
    const session = access.session(sid)
    if (!session) return { status: 404, message: '预览会话已过期。请回到 Ramet 页面，重新点开预览。' }
    const preview = hub.previews.get(session.previewId)
    if (!preview) {
      access.dropSession(sid)
      return { status: 404, message: '这个预览已经停止共享。' }
    }
    if (access.currentTime() - session.checkedAt >= revalidateMs) {
      const verdict = await reverify(pool, hub, preview, session.userId)
      if (!verdict.ok) {
        access.dropSession(sid)
        return { status: verdict.status, message: verdict.message }
      }
      access.touch(sid)
    }
    return { preview }
  }

  // ---------- 进入：票据 → 会话 cookie → 302 ----------

  async function enter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') return sendPage(res, 405, '只支持 GET。')
    const t = new URL(req.url ?? '/', 'http://x').searchParams.get('t') ?? ''
    // redeem 把票据消费掉，后面不管通过与否都不能再用
    const ticket = /^[0-9a-f]{64}$/.test(t) ? access.redeem(t) : null
    if (!ticket) return sendPage(res, 403, '这个预览链接已经用过或者过期了。请回到 Ramet 页面，重新点开预览。')
    const preview = hub.previews.get(ticket.previewId)
    if (!preview) return sendPage(res, 404, '这个预览已经停止共享。')
    // 浏览器若带着 Ramet 的登录 cookie（同主机不同端口会带过来），必须是发票据的那个人；没带（跨站部署）不拦，票据本身就是凭证
    const who = await userFromRequest(pool, req)
    if (who && who.id !== ticket.userId) return sendPage(res, 403, '这个预览链接不是发给当前登录的账号的。')
    const verdict = await reverify(pool, hub, preview, ticket.userId)
    if (!verdict.ok) return sendPage(res, verdict.status, verdict.message)
    const sid = access.openSession(ticket.userId, preview.id)
    res.writeHead(302, {
      location: preview.path,
      'set-cookie': `${PREVIEW_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(access.sessionTtl / 1000)}`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-length': '0',
    })
    res.end()
  }

  // ---------- HTTP 转发 ----------

  function proxyHttp(req: IncomingMessage, res: ServerResponse, preview: Preview): void {
    const method = (req.method ?? 'GET').toUpperCase()
    if (!PREVIEW_METHODS.has(method)) return sendPage(res, 405, `不支持 ${method} 请求。`)
    const target = req.url
    if (!validRequestTarget(target)) return sendPage(res, 400, '请求路径不合法。')
    const declared = Number(req.headers['content-length'] ?? 0)
    if (Number.isFinite(declared) && declared > PREVIEW_REQ_BODY_MAX) {
      return sendPage(res, 413, `请求体超过 ${PREVIEW_REQ_BODY_MAX / 1024 / 1024} MB 的上限。`, { connection: 'close' })
    }
    const hasBody = declared > 0 || req.headers['transfer-encoding'] !== undefined

    let flight: HttpFlight | null = null
    const sink: HttpSink = {
      head: (status, headers) => {
        try {
          res.writeHead(status, headers.flat())
        } catch {
          // 响应头里有 Node 不收的字符，当成上游返回了坏东西
          flight?.abort()
          sendPage(res, 502, '这台机器上的网站返回了不合法的响应头。')
        }
      },
      body: (chunk) => {
        if (res.destroyed || res.writableEnded) return
        res.write(chunk)
        if (res.writableLength > WRITE_BACKLOG_MAX) {
          flight?.abort()
          res.destroy()
        }
      },
      end: () => {
        if (!res.writableEnded && !res.destroyed) res.end()
      },
      broken: () => res.destroy(),
      fail: (status, message) => sendPage(res, status, message),
    }
    try {
      flight = hub.previews.openHttp(preview, { method, path: target, headers: forwardHeaders(req.rawHeaders), hasBody }, sink)
    } catch (err) {
      if (err instanceof PreviewOfflineError) return sendPage(res, 502, '这台机器现在不在线，预览暂时看不了。')
      if (err instanceof PreviewBusyError) return sendPage(res, 503, err.message, { 'retry-after': '2' })
      return sendPage(res, 502, '预览转发失败。')
    }
    const active = flight
    res.on('close', () => {
      if (!res.writableFinished) active.abort()
    })
    if (!hasBody) {
      req.resume()
      return
    }
    let received = 0
    let over = false
    req.on('data', (chunk: Buffer) => {
      if (over) return
      received += chunk.length
      if (received > PREVIEW_REQ_BODY_MAX) {
        over = true
        active.abort()
        sendPage(res, 413, `请求体超过 ${PREVIEW_REQ_BODY_MAX / 1024 / 1024} MB 的上限。`, { connection: 'close' })
        return
      }
      active.write(chunk)
    })
    req.on('end', () => {
      if (!over) active.end()
    })
    req.on('error', () => active.abort())
  }

  // ---------- WebSocket 转发（Vite HMR 等）----------

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const refuse = (status: number, text: string): void => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      socket.destroy()
    }
    const target = req.url
    if (!validRequestTarget(target) || target.startsWith('/__ramet/')) return refuse(404, 'Not Found')
    // 跨站页面不能借浏览器里的预览会话连进来，握手带了 Origin 就必须是预览源自己
    const origin = req.headers.origin
    if (origin) {
      let same = false
      try {
        same = new URL(origin).host === (req.headers.host ?? '').toLowerCase()
      } catch {
        same = false
      }
      if (!same) return refuse(403, 'Forbidden')
    }
    const auth = await authorize(cookieValue(req.headers.cookie, PREVIEW_COOKIE))
    if (!('preview' in auth)) return refuse(auth.status, auth.status === 403 ? 'Forbidden' : 'Not Found')
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)

    let browser: WebSocket | null = null
    let link: WsLink | null = null
    const ready = Promise.withResolvers<string>()
    ready.promise.catch(() => undefined) // 握手前就失败时没人 await，避免未处理的 rejection
    const sink: WsSink = {
      ready: (protocol) => ready.resolve(protocol),
      data: (data, binary) => {
        if (browser?.readyState === 1) browser.send(data, { binary })
      },
      end: (code, reason, opened) => {
        if (!opened) {
          ready.reject(new Error(reason))
          return
        }
        // ws close 的 reason 不能超过 123 字节
        browser?.close(wsCloseCode(code), Buffer.from(reason).subarray(0, 120).toString())
      },
    }
    try {
      link = hub.previews.openWs(auth.preview, { path: target, headers: forwardHeaders(req.rawHeaders), protocols }, sink)
    } catch (err) {
      return refuse(err instanceof PreviewBusyError ? 503 : 502, 'Bad Gateway')
    }
    const opened = link
    const earlyClose = (): void => opened.close() // 握手期间浏览器走了
    socket.on('close', earlyClose)
    let protocol: string
    try {
      protocol = await ready.promise
    } catch {
      return refuse(502, 'Bad Gateway')
    }
    if (socket.destroyed) return
    chosen.set(req, protocol)
    wss.handleUpgrade(req, socket, head, (ws) => {
      socket.off('close', earlyClose) // 升级完成后由 ws 的 close 事件接手（带关闭码）
      browser = ws
      ws.on('message', (data, binary) => {
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer)
        opened.send(binary ? buf : buf.toString('utf8'), binary)
      })
      ws.on('close', (code) => opened.close(wsCloseCode(code)))
      ws.on('error', () => opened.close())
    })
  }

  const server = createServer((req, res) => {
    void (async () => {
      const pathname = (req.url ?? '/').split('?')[0] ?? '/'
      if (pathname === '/__ramet/enter') return enter(req, res)
      // 保留前缀：这里只有 enter，其余一律 404
      if (pathname.startsWith('/__ramet/')) return sendPage(res, 404, '没有这个页面。')
      const auth = await authorize(cookieValue(req.headers.cookie, PREVIEW_COOKIE))
      if (!('preview' in auth)) return sendPage(res, auth.status, auth.message)
      proxyHttp(req, res, auth.preview)
    })().catch(() => {
      if (!res.headersSent) sendPage(res, 502, '预览转发失败。')
      else res.destroy()
    })
  })
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => undefined)
    upgrade(req, socket, head).catch(() => socket.destroy())
  })

  return {
    server,
    listen: (port) =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, () => {
          server.off('error', reject)
          resolve((server.address() as { port: number }).port)
        })
      }),
    close: async () => {
      for (const client of wss.clients) client.terminate()
      wss.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
