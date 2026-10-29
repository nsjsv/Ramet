// ---------- connector 的端口预览执行端：把 127.0.0.1:<端口> 上的网站转给中心 ----------
// 跑在用户自己的机器上。帧在 connector/index.ts 已过第二道闸（署名人是主人或本地名单里 machine 范围的人），这里再做：
//   1. 只连 127.0.0.1:<共享时登记的端口>：帧里没有主机名字段，多带的字段一律忽略；请求目标必须是 `/` 开头的路径。
//   2. 每个 http / ws 帧按 previewId 找共享记录，署名人必须就是记录里的共享人，并再过一遍本机名单（machine 范围）；
//      共享人的授权没了（到期 / 被收窄 / 被收回）就不转发，并撤掉他共享的全部预览。
//   3. 体积与并发约束：单请求体 10MB、单响应体 50MB（声明超了直接拒绝，流式超了截断并报错）、在转的请求 / WebSocket 有上限、各种超时。
// 登记只在内存里：每次 welcome 清空，中心随后把还在共享的再登记一遍，两边始终一致。

import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import WebSocket from 'ws'
import type { ConnMsg, PreviewMsg } from '../agents/protocol.js'
import {
  PREVIEW_CHUNK_BYTES,
  PREVIEW_HEADER_TIMEOUT_MS,
  PREVIEW_IDLE_TIMEOUT_MS,
  PREVIEW_MAX_INFLIGHT,
  PREVIEW_MAX_PER_MACHINE,
  PREVIEW_MAX_WS,
  PREVIEW_METHODS,
  PREVIEW_REQ_BODY_MAX,
  PREVIEW_RES_BODY_MAX,
  PREVIEW_WS_MSG_MAX,
  PreviewDenied,
  cleanPairs,
  isHopHeader,
  setsRametCookie,
  stripRametCookies,
  validPort,
  validRequestTarget,
  wsCloseCode,
  type HeaderPairs,
} from '../agents/preview-types.js'
import type { PreviewReply } from '../agents/project-types.js'

export type PreviewDeps = {
  send: (msg: ConnMsg) => boolean
  /** 这个人是不是这台机器的主人（本机钉住的 ownerId）：停止别人共享的预览时用 */
  isOwner: (actor: string) => boolean
  /** 此刻这个人还有没有 machine 范围的使用权（读本机名单；每次现读） */
  stillAllowed: (actor: string) => boolean
  /** 往中心写 socket 的积压字节数：太多就暂停读上游，免得慢链路把内存堆爆 */
  backlog?: () => number
  log?: (line: string) => void
  /** 授权巡检间隔（0 = 不自动巡检，测试手动 tick） */
  tickMs?: number
  /** 测试注入：缩小上限 / 超时 */
  limits?: Partial<{
    maxShares: number
    maxInflight: number
    maxWs: number
    reqBodyMax: number
    resBodyMax: number
    headerTimeoutMs: number
    idleMs: number
  }>
}

type Share = { port: number; actor: string }
type HttpEntry = {
  previewId: string
  req: ClientRequest
  reqBytes: number
  resBytes: number
  responded: boolean
  timer: NodeJS.Timeout | null
  poll: NodeJS.Timeout | null
}
type WsEntry = { previewId: string; ws: WebSocket; opened: boolean; ended: boolean }

const BACKLOG_HIGH = 2 * 1024 * 1024
const BACKLOG_LOW = 512 * 1024
const WS_BUFFER_MAX = 8 * 1024 * 1024
const ACCESS_TICK_MS = 15_000

/** 转给上游的请求头：去逐跳头 / host / expect；Ramet 的 cookie 再剥一遍（中心已剥，这里是第二层）；
 *  origin / referer 改成上游自己的地址（开发服务器常按 Origin / Host 做校验，预览源的地址对它没有意义） */
export function upstreamHeaders(pairs: HeaderPairs, port: number): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  const add = (key: string, value: string): void => {
    const cur = out[key]
    if (cur === undefined) out[key] = value
    else if (Array.isArray(cur)) cur.push(value)
    else out[key] = [cur, value]
  }
  const self = `http://localhost:${port}`
  for (const [name, value] of pairs) {
    const key = name.toLowerCase()
    if (isHopHeader(key) || key === 'host' || key === 'expect' || key.startsWith('sec-websocket-')) continue
    if (key === 'cookie') {
      const kept = stripRametCookies(value)
      if (kept) add('cookie', kept)
    } else if (key === 'origin') {
      add('origin', self)
    } else if (key === 'referer') {
      try {
        const u = new URL(value)
        add('referer', `${self}${u.pathname}${u.search}`)
      } catch {
        // 不认识的 referer 不转
      }
    } else {
      add(key, value)
    }
  }
  out.host = `localhost:${port}`
  return out
}

/** 上游的绝对地址重定向（指回它自己）改成相对路径，否则浏览器会跑去访问用户本机的 localhost。其余原样 */
export function rewriteLocation(value: string, port: number): string {
  try {
    const u = new URL(value)
    if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && Number(u.port || 80) === port) {
      // 以 // 或 /\ 开头的路径浏览器会当成别的主机（开放重定向）：压成单个 /
      return `/${`${u.pathname}${u.search}${u.hash}`.replace(/^[/\\]+/, '')}`
    }
  } catch {
    // 相对地址：不用改
  }
  return value
}

/** 上游响应头 → 帧里的头：去逐跳头；Location 改写；想设 Ramet 的 cookie 一律丢（中心还会再滤一次） */
export function responseHeaders(raw: string[], port: number): HeaderPairs {
  const out: HeaderPairs = []
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i]!
    const value = raw[i + 1]!
    const key = name.toLowerCase()
    if (isHopHeader(key)) continue
    if (key === 'set-cookie' && setsRametCookie(value)) continue
    out.push([key, key === 'location' ? rewriteLocation(value, port) : value])
  }
  return out
}

/** 连不上上游时给人看的话 */
function describeFailure(err: unknown, port: number): { status: number; message: string } {
  const code = err instanceof Error && 'code' in err ? String((err as NodeJS.ErrnoException).code) : ''
  if (code === 'ECONNREFUSED') return { status: 502, message: `这台机器的 ${port} 端口上没有程序在监听。开发服务器启动了吗？` }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return { status: 504, message: `这台机器的 ${port} 端口连接超时。` }
  return { status: 502, message: `连接这台机器的 ${port} 端口失败。` }
}

export class PreviewForwarder {
  private shares = new Map<string, Share>()
  private http = new Map<string, HttpEntry>()
  private sockets = new Map<string, WsEntry>()
  private ticker: NodeJS.Timeout | null = null
  private readonly lim: Required<NonNullable<PreviewDeps['limits']>>

  constructor(private deps: PreviewDeps) {
    this.lim = {
      maxShares: PREVIEW_MAX_PER_MACHINE,
      maxInflight: PREVIEW_MAX_INFLIGHT,
      maxWs: PREVIEW_MAX_WS,
      reqBodyMax: PREVIEW_REQ_BODY_MAX,
      resBodyMax: PREVIEW_RES_BODY_MAX,
      headerTimeoutMs: PREVIEW_HEADER_TIMEOUT_MS,
      idleMs: PREVIEW_IDLE_TIMEOUT_MS,
      ...deps.limits,
    }
    const tickMs = deps.tickMs ?? ACCESS_TICK_MS
    if (tickMs > 0) {
      this.ticker = setInterval(() => this.tick(), tickMs)
      this.ticker.unref()
    }
  }

  get size(): number {
    return this.shares.size
  }

  private log(line: string): void {
    this.deps.log?.(line)
  }

  // ---------- 登记 ----------

  /** port-share / port-unshare：登记与撤销。失败抛 PreviewDenied（message 是人话；forbidden = 不被允许） */
  control(msg: Extract<PreviewMsg, { t: 'port-share' | 'port-unshare' }>): PreviewReply {
    if (typeof msg.previewId !== 'string' || !msg.previewId) throw new PreviewDenied('缺少预览编号')
    const existing = this.shares.get(msg.previewId)
    if (msg.t === 'port-share') {
      if (!validPort(msg.port)) throw new PreviewDenied('端口要在 1024 到 65535 之间')
      if (existing && existing.actor !== msg.actor) throw new PreviewDenied('这个预览已经由别人共享', true)
      if (!existing && this.shares.size >= this.lim.maxShares) throw new PreviewDenied(`这台机器最多同时共享 ${this.lim.maxShares} 个预览`)
      this.shares.set(msg.previewId, { port: msg.port, actor: msg.actor })
      this.log(`预览共享 ${msg.previewId} → 127.0.0.1:${msg.port}（共享人 ${msg.actor}）`)
      return { op: 'port-share' }
    }
    if (!existing) return { op: 'port-unshare' } // 幂等
    if (existing.actor !== msg.actor && !this.deps.isOwner(msg.actor)) {
      throw new PreviewDenied('只有共享的人或这台机器的主人能停止共享', true)
    }
    this.dropShare(msg.previewId)
    this.log(`预览停止共享 ${msg.previewId}`)
    return { op: 'port-unshare' }
  }

  private dropShare(previewId: string): void {
    this.shares.delete(previewId)
    for (const [id, e] of [...this.http]) if (e.previewId === previewId) this.dropHttp(id, e, true)
    for (const [id, e] of [...this.sockets]) {
      if (e.previewId !== previewId) continue
      e.ended = true // 中心已知道（它是撤销的发起方 / 或随后会知道）：不再回 ws-end
      this.sockets.delete(id)
      e.ws.terminate()
    }
  }

  /** 此人的授权没了（grant-revoked / access-reduced / 巡检发现本机名单不再放行）：他共享的预览全部撤掉，在飞的请求与 WebSocket 掐断 */
  closeActor(userId: string): number {
    let n = 0
    for (const [id, share] of [...this.shares]) {
      if (share.actor !== userId) continue
      this.dropShare(id)
      n += 1
    }
    if (n > 0) this.log(`预览：${userId} 共享的 ${n} 个预览已撤掉（授权没了）`)
    return n
  }

  /** 与中心的连接断了 / 重新 welcome：全部清空（中心会把还在共享的再登记一遍） */
  reset(): void {
    for (const id of [...this.shares.keys()]) this.dropShare(id)
  }

  /** 巡检：本机名单不再放行的共享人，他的预览撤掉（中心离线 / 有 bug 也一样） */
  tick(): void {
    for (const actor of new Set([...this.shares.values()].map((s) => s.actor))) {
      if (!this.deps.stillAllowed(actor)) this.closeActor(actor)
    }
  }

  dispose(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    this.reset()
  }

  // ---------- 流量帧 ----------

  /** 署名人必须就是记录里的共享人，并且本机名单此刻仍放行他；否则不转发，并把他共享的预览全部撤掉 */
  private authorize(previewId: unknown, actor: unknown): Share | { status: 403 | 404; message: string } {
    const share = typeof previewId === 'string' ? this.shares.get(previewId) : undefined
    if (!share) return { status: 404, message: '这个预览已经停止共享' }
    if (share.actor !== actor) return { status: 403, message: '帧的署名人不是这个预览的共享人' }
    if (!this.deps.stillAllowed(share.actor)) {
      this.closeActor(share.actor)
      return { status: 403, message: '共享人对这台机器的使用授权已失效' }
    }
    return share
  }

  stream(msg: Exclude<PreviewMsg, { t: 'port-share' | 'port-unshare' }>): void {
    switch (msg.t) {
      case 'http-req':
        return this.httpReq(msg)
      case 'http-body':
        return this.httpBody(msg)
      case 'ws-open':
        return this.wsOpen(msg)
      case 'ws-msg':
        return this.wsMsg(msg)
      case 'ws-close':
        return this.wsClose(msg)
    }
  }

  // ---------- HTTP ----------

  private httpReq(msg: Extract<PreviewMsg, { t: 'http-req' }>): void {
    const reqId = msg.reqId
    if (typeof reqId !== 'string' || !reqId || this.http.has(reqId)) return
    const fail = (status: number, message: string): void => void this.deps.send({ t: 'http-fail', reqId, status, message })
    const share = this.authorize(msg.previewId, msg.actor)
    if ('status' in share) return fail(share.status, share.message)
    if (typeof msg.method !== 'string' || !PREVIEW_METHODS.has(msg.method)) return fail(405, '不支持这种请求方法')
    if (!validRequestTarget(msg.path)) return fail(400, '请求路径不合法')
    const pairs = cleanPairs(msg.headers)
    if (!pairs) return fail(400, '请求头不合法')
    if (this.http.size >= this.lim.maxInflight) return fail(503, '这台机器上的预览正忙，请稍后再试')
    let req: ClientRequest
    try {
      // 主机写死 127.0.0.1，端口是共享时登记的那个：帧里的任何主机名都不会被用到
      req = httpRequest({
        host: '127.0.0.1',
        port: share.port,
        method: msg.method,
        path: msg.path,
        headers: upstreamHeaders(pairs, share.port),
        setHost: false,
        agent: false, // 回环连接，每个请求一条新连接：不和开发服务器的 keep-alive 超时赛跑
      })
    } catch {
      return fail(400, '请求头不合法')
    }
    const entry: HttpEntry = { previewId: msg.previewId, req, reqBytes: 0, resBytes: 0, responded: false, timer: null, poll: null }
    this.http.set(reqId, entry)
    entry.timer = setTimeout(() => {
      if (entry.responded) return
      fail(504, '这台机器上的网站太久没有响应')
      this.dropHttp(reqId, entry, true)
    }, this.lim.headerTimeoutMs)
    entry.timer.unref()
    req.on('response', (res) => this.onResponse(reqId, entry, res, share.port, msg.method))
    req.on('error', (err) => {
      if (this.http.get(reqId) !== entry) return
      const { status, message } = describeFailure(err, share.port)
      if (entry.responded) this.deps.send({ t: 'http-res-body', reqId, error: '预览响应中断' })
      else fail(status, message)
      this.dropHttp(reqId, entry, false)
    })
    if (!msg.hasBody) req.end()
  }

  private onResponse(reqId: string, entry: HttpEntry, res: IncomingMessage, port: number, method: string): void {
    if (this.http.get(reqId) !== entry) {
      res.destroy()
      return
    }
    entry.responded = true
    const status = res.statusCode ?? 502
    const declared = Number(res.headers['content-length'])
    if (Number.isFinite(declared) && declared > this.lim.resBodyMax) {
      this.deps.send({ t: 'http-fail', reqId, status: 502, message: `预览响应超过 ${Math.round(this.lim.resBodyMax / 1024 / 1024)} MB 的上限（${declared} 字节）` })
      this.dropHttp(reqId, entry, true)
      return
    }
    this.deps.send({ t: 'http-res', reqId, status, headers: responseHeaders(res.rawHeaders, port) })
    if (method === 'HEAD' || status === 204 || status === 304) {
      res.resume()
      this.deps.send({ t: 'http-res-body', reqId, end: true })
      this.dropHttp(reqId, entry, false)
      return
    }
    const idle = (): void => {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        this.deps.send({ t: 'http-res-body', reqId, error: '预览响应中断（太久没有数据）' })
        this.dropHttp(reqId, entry, true)
      }, this.lim.idleMs)
      entry.timer.unref()
    }
    idle()
    res.on('data', (chunk: Buffer) => {
      if (this.http.get(reqId) !== entry) return
      entry.resBytes += chunk.length
      if (entry.resBytes > this.lim.resBodyMax) {
        // 没声明长度的流式响应超了上限：报错（中心掐断浏览器连接，不让它把截断的内容当完整的）
        this.deps.send({ t: 'http-res-body', reqId, error: `预览响应超过 ${Math.round(this.lim.resBodyMax / 1024 / 1024)} MB 的上限` })
        this.dropHttp(reqId, entry, true)
        return
      }
      idle()
      for (let at = 0; at < chunk.length; at += PREVIEW_CHUNK_BYTES) {
        this.deps.send({ t: 'http-res-body', reqId, chunk: chunk.subarray(at, at + PREVIEW_CHUNK_BYTES).toString('base64') })
      }
      this.throttle(entry, res)
    })
    res.on('end', () => {
      if (this.http.get(reqId) !== entry) return
      this.deps.send({ t: 'http-res-body', reqId, end: true })
      this.dropHttp(reqId, entry, false)
    })
    res.on('error', () => {
      if (this.http.get(reqId) !== entry) return
      this.deps.send({ t: 'http-res-body', reqId, error: '预览响应中断' })
      this.dropHttp(reqId, entry, true)
    })
    res.on('close', () => {
      if (this.http.get(reqId) !== entry) return
      // 没收到 end 就关了：上游中途断开
      this.deps.send({ t: 'http-res-body', reqId, error: '预览响应中断' })
      this.dropHttp(reqId, entry, true)
    })
  }

  /** 往中心的 socket 积压太多就暂停读上游，降下来再恢复 */
  private throttle(entry: HttpEntry, res: IncomingMessage): void {
    const backlog = this.deps.backlog
    if (!backlog || entry.poll || backlog() <= BACKLOG_HIGH) return
    res.pause()
    entry.poll = setInterval(() => {
      if (res.destroyed || backlog() < BACKLOG_LOW) {
        if (entry.poll) clearInterval(entry.poll)
        entry.poll = null
        if (!res.destroyed) res.resume()
      }
    }, 25)
    entry.poll.unref()
  }

  private dropHttp(reqId: string, entry: HttpEntry, destroy: boolean): void {
    if (this.http.get(reqId) !== entry) return
    this.http.delete(reqId)
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.poll) clearInterval(entry.poll)
    entry.timer = entry.poll = null
    if (destroy) entry.req.destroy()
  }

  private httpBody(msg: Extract<PreviewMsg, { t: 'http-body' }>): void {
    const entry = typeof msg.reqId === 'string' ? this.http.get(msg.reqId) : undefined
    if (!entry || entry.previewId !== msg.previewId) return
    if (msg.abort) {
      this.dropHttp(msg.reqId, entry, true) // 浏览器走了：只会让机器少干活，不需要再判授权
      return
    }
    const share = this.authorize(msg.previewId, msg.actor)
    if ('status' in share) {
      this.dropHttp(msg.reqId, entry, true)
      return
    }
    if (typeof msg.chunk === 'string' && msg.chunk) {
      const buf = Buffer.from(msg.chunk, 'base64')
      entry.reqBytes += buf.length
      if (entry.reqBytes > this.lim.reqBodyMax) {
        if (!entry.responded) this.deps.send({ t: 'http-fail', reqId: msg.reqId, status: 413, message: `请求体超过 ${Math.round(this.lim.reqBodyMax / 1024 / 1024)} MB 的上限` })
        this.dropHttp(msg.reqId, entry, true)
        return
      }
      entry.req.write(buf)
    }
    if (msg.end) entry.req.end()
  }

  // ---------- WebSocket ----------

  private wsOpen(msg: Extract<PreviewMsg, { t: 'ws-open' }>): void {
    const wsId = msg.wsId
    if (typeof wsId !== 'string' || !wsId || this.sockets.has(wsId)) return
    const fail = (reason: string): void => void this.deps.send({ t: 'ws-end', wsId, code: 1011, reason, opened: false })
    const share = this.authorize(msg.previewId, msg.actor)
    if ('status' in share) return fail(share.message)
    if (!validRequestTarget(msg.path)) return fail('请求路径不合法')
    const pairs = cleanPairs(msg.headers)
    const protocols = Array.isArray(msg.protocols) ? msg.protocols.filter((p): p is string => typeof p === 'string' && /^[\w!#$%&'*+.^`|~-]+$/.test(p)) : []
    if (!pairs) return fail('请求头不合法')
    if (this.sockets.size >= this.lim.maxWs) return fail('这台机器上的预览正忙，请稍后再试')
    let ws: WebSocket
    try {
      ws = new WebSocket(`ws://127.0.0.1:${share.port}${msg.path}`, protocols, {
        headers: upstreamHeaders(pairs, share.port),
        maxPayload: PREVIEW_WS_MSG_MAX,
        handshakeTimeout: 10_000,
        perMessageDeflate: false,
        followRedirects: false,
      })
    } catch {
      return fail('请求头不合法')
    }
    const entry: WsEntry = { previewId: msg.previewId, ws, opened: false, ended: false }
    this.sockets.set(wsId, entry)
    const end = (code: number, reason: string): void => {
      if (entry.ended) return
      entry.ended = true
      this.sockets.delete(wsId)
      this.deps.send({ t: 'ws-end', wsId, code, reason: reason.slice(0, 120), opened: entry.opened })
    }
    ws.on('open', () => {
      entry.opened = true
      this.deps.send({ t: 'ws-ready', wsId, protocol: ws.protocol })
    })
    ws.on('message', (data, binary) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer)
      this.deps.send({ t: 'ws-data', wsId, binary, data: binary ? buf.toString('base64') : buf.toString('utf8') })
    })
    ws.on('close', (code, reason) => end(wsCloseCode(code), reason.toString()))
    ws.on('unexpected-response', (req, res) => {
      // 上游拒绝了升级（比如 404）：握手阶段失败
      res.resume()
      req.destroy()
      end(1011, `上游拒绝了 WebSocket（HTTP ${res.statusCode ?? '?'}）`)
    })
    ws.on('error', (err) => {
      const { message } = describeFailure(err, share.port)
      if (!entry.opened) end(1011, message)
    })
  }

  private wsMsg(msg: Extract<PreviewMsg, { t: 'ws-msg' }>): void {
    const entry = typeof msg.wsId === 'string' ? this.sockets.get(msg.wsId) : undefined
    if (!entry || entry.previewId !== msg.previewId || !entry.opened) return
    const share = this.authorize(msg.previewId, msg.actor)
    if ('status' in share) {
      entry.ws.close(1008, '授权已失效')
      return
    }
    if (typeof msg.data !== 'string' || entry.ws.readyState !== WebSocket.OPEN) return
    if (msg.data.length > PREVIEW_WS_MSG_MAX * 1.4) {
      entry.ws.close(1009, '消息太大')
      return
    }
    if (entry.ws.bufferedAmount > WS_BUFFER_MAX) {
      entry.ws.close(1013, '积压太多')
      return
    }
    entry.ws.send(msg.binary ? Buffer.from(msg.data, 'base64') : msg.data, { binary: msg.binary === true })
  }

  private wsClose(msg: Extract<PreviewMsg, { t: 'ws-close' }>): void {
    const entry = typeof msg.wsId === 'string' ? this.sockets.get(msg.wsId) : undefined
    if (!entry || entry.previewId !== msg.previewId) return
    // 浏览器走了：只会让机器少干活，不需要再判授权
    if (entry.ws.readyState === WebSocket.CONNECTING) entry.ws.terminate()
    else entry.ws.close(wsCloseCode(msg.code))
  }
}
