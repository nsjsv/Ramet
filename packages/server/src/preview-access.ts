// ---------- 端口预览的进入凭证：一次性票据 + 预览会话（都只存内存） ----------
// 流程：网页（Ramet 同源，带登录 cookie）问 `POST /api/pages/:id/previews/:pid/ticket` 换一张票据，
// 浏览器打开 `${预览源}/__ramet/enter?t=<票据>`，预览监听核票（一次性、60 秒、绑定用户 + 预览）后设 `ramet_pv` 会话 cookie 并 302 到预览入口。
// 之后预览源上的每个请求只认这个会话 cookie，Ramet 自己的登录 cookie 在预览源上不认，转发时也会剥掉。
//
// 票据与会话重启即失效（预览登记本来也在内存里）。同一个浏览器同时只能看一个预览：cookie 同名，后开的覆盖先开的。

import { randomBytes } from 'node:crypto'

export const PREVIEW_COOKIE = 'ramet_pv'
export const TICKET_TTL_MS = 60_000
/** 预览会话的寿命（cookie 的 Max-Age 与服务端记录同值；不续期） */
export const PREVIEW_SESSION_TTL_MS = 8 * 3600_000
/** 每人未使用的票据上限 / 全局上限 / 会话上限，防止登录用户刷内存 */
const TICKETS_PER_USER = 20
const TICKETS_MAX = 5000
const SESSIONS_MAX = 10_000

type Ticket = { userId: string; previewId: string; expires: number }
export type PreviewSession = {
  userId: string
  previewId: string
  expires: number
  /** 上次重新确认预览还在共享、此人仍可读该页的时刻（缓存几秒，不每个请求都查库） */
  checkedAt: number
}

export type PreviewAccessOptions = {
  ticketTtlMs?: number
  sessionTtlMs?: number
  /** 测试注入时钟 */
  now?: () => number
}

export class PreviewAccess {
  private tickets = new Map<string, Ticket>()
  private sessions = new Map<string, PreviewSession>()
  private readonly ticketTtl: number
  readonly sessionTtl: number
  private readonly now: () => number

  constructor(options: PreviewAccessOptions = {}) {
    this.ticketTtl = options.ticketTtlMs ?? TICKET_TTL_MS
    this.sessionTtl = options.sessionTtlMs ?? PREVIEW_SESSION_TTL_MS
    this.now = options.now ?? Date.now
  }

  /** 发一张票据（32 字节随机，hex），额度用完返回 null */
  issueTicket(userId: string, previewId: string): string | null {
    const now = this.now()
    this.purge(now)
    let mine = 0
    for (const t of this.tickets.values()) if (t.userId === userId) mine += 1
    if (mine >= TICKETS_PER_USER || this.tickets.size >= TICKETS_MAX) return null
    const ticket = randomBytes(32).toString('hex')
    this.tickets.set(ticket, { userId, previewId, expires: now + this.ticketTtl })
    return ticket
  }

  /** 核票，一次性：无论后面的检查通不通过，这张票都已经被消费。过期或没见过返回 null */
  redeem(ticket: string): { userId: string; previewId: string } | null {
    const t = this.tickets.get(ticket)
    if (!t) return null
    this.tickets.delete(ticket)
    return t.expires > this.now() ? { userId: t.userId, previewId: t.previewId } : null
  }

  /** 新开一个预览会话，返回 cookie 值 */
  openSession(userId: string, previewId: string): string {
    const now = this.now()
    this.purge(now)
    // 超额时丢最老的（Map 按插入序）而不是拒绝新的，正在用的人比放着的会话要紧
    while (this.sessions.size >= SESSIONS_MAX) this.sessions.delete(this.sessions.keys().next().value as string)
    const sid = randomBytes(32).toString('hex')
    this.sessions.set(sid, { userId, previewId, expires: now + this.sessionTtl, checkedAt: now })
    return sid
  }

  session(sid: string): PreviewSession | null {
    const s = this.sessions.get(sid)
    if (!s) return null
    if (s.expires <= this.now()) {
      this.sessions.delete(sid)
      return null
    }
    return s
  }

  touch(sid: string): void {
    const s = this.sessions.get(sid)
    if (s) s.checkedAt = this.now()
  }

  dropSession(sid: string): void {
    this.sessions.delete(sid)
  }

  /** 预览停止共享：它的会话和没用的票据全部作废 */
  dropPreview(previewId: string): void {
    for (const [sid, s] of this.sessions) if (s.previewId === previewId) this.sessions.delete(sid)
    for (const [t, ticket] of this.tickets) if (ticket.previewId === previewId) this.tickets.delete(t)
  }

  currentTime(): number {
    return this.now()
  }

  private purge(now: number): void {
    for (const [t, ticket] of this.tickets) if (ticket.expires <= now) this.tickets.delete(t)
    for (const [sid, s] of this.sessions) if (s.expires <= now) this.sessions.delete(sid)
  }
}

/** 从 Cookie 头里取一个 cookie 的值，取不到或畸形返回 null。不解码，会话 id 是 hex */
export function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of header?.split(';') ?? []) {
    const eq = part.indexOf('=')
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null
  }
  return null
}
