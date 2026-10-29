// ---------- 配对台：connector 申请 → 浏览器确认 → 经同一条 ws 下发长期 token ----------
// 流程：connector 连 /connector/pair 发 pair-request，这里发一次性码 pair-link（connector 打印 <中心>/connect/<码>），
// 用户在浏览器登录、选空间、确认（routes/connectors.ts 的 /api/connect/:code*），createConnector 建行，
// paired（带长期 token）只经发起申请的那条 ws 下发，REST 响应里没有 token，浏览器从不经手。
// 待确认的申请只在内存，生命周期等于发起它的那条 ws：确认 / 拒绝 / 过期都归结为「发完结果关 ws」，ws 一关就删，
// 链接因此天然一次性，connector 断开即作废；中心重启则全部作废（connector 报错退出，重新执行即可）。

import { randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import WebSocket from 'ws'
import { createConnector, deleteConnector, type ConnectorStatus } from './connectors.js'
import type { ConnectorAgentInfo, ConnMsg, PairReply } from './protocol.js'
import { keepAlive } from './ws-heartbeat.js'

/** 链接有效期：够人开浏览器、登录、确认；过了就让 connector 重新申请 */
export const PAIR_LINK_TTL_MS = 10 * 60 * 1000
/** 连上后多久内必须发 pair-request */
const REQUEST_TIMEOUT_MS = 15_000
/** 同时待确认的上限（无凭据端点，防内存滥用） */
const MAX_PENDING = 1000
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LEN = 8

type Pending = {
  code: string
  name: string
  defaultCwd: string
  agents: ConnectorAgentInfo[]
  expiresAt: number
  ws: WebSocket
  /** 确认进行中：挡住并发的第二次确认 / 拒绝 */
  claimed: boolean
}

/** 确认页看到的机器信息（不含任何凭据） */
export type PairInfo = { code: string; name: string; defaultCwd: string; agents: ConnectorAgentInfo[]; expiresAt: string }

export type ConfirmResult =
  | { ok: true; connectorId: string; status: ConnectorStatus }
  /** gone = 码无效 / 已用 / 正在被别人确认 / 机器已断开；role = 确认人此刻不是该空间的 owner / member */
  | { ok: false; reason: 'gone' | 'role' }

/** 32 字母表 × 8 位 = 40 bit；显示成 XXXX-XXXX */
function newCode(): string {
  let out = ''
  for (const b of randomBytes(CODE_LEN)) out += CODE_ALPHABET[b % CODE_ALPHABET.length]
  return out
}

/** 链接里的码：大小写、连字符都容忍 */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function displayCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

function clip(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function cleanAgents(value: unknown): ConnectorAgentInfo[] {
  if (!Array.isArray(value)) return []
  const out: ConnectorAgentInfo[] = []
  for (const a of value.slice(0, 32)) {
    if (!a || typeof a !== 'object') continue
    const { id, label, logo } = a as Record<string, unknown>
    if (typeof id !== 'string' || !id) continue
    out.push({ id: id.slice(0, 80), label: clip(label, 80) || id.slice(0, 80), logo: typeof logo === 'string' ? logo.slice(0, 2000) : null })
  }
  return out
}

function parse(data: unknown): ConnMsg | null {
  try {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as ConnMsg) : null
  } catch {
    return null
  }
}

export class PairingDesk {
  private readonly byCode = new Map<string, Pending>()

  /** onPaired：建了一台机器（成员接入是 pending，空间 owner 的收件箱要多一条待批准） */
  constructor(
    private readonly pool: Pool,
    private readonly onPaired?: () => void,
    private readonly ttlMs = PAIR_LINK_TTL_MS,
  ) {}

  /** 接管一条 /connector/pair 连接：只认第一条 pair-request */
  open(ws: WebSocket): void {
    let asked = false
    let code = ''
    const deadline = setTimeout(() => this.fail(ws, '没有收到配对申请'), REQUEST_TIMEOUT_MS)
    deadline.unref()
    ws.on('close', () => {
      clearTimeout(deadline)
      if (code && this.byCode.get(code)?.ws === ws) this.byCode.delete(code)
    })
    ws.on('error', () => undefined)
    keepAlive(ws, () => undefined) // 待确认要挂几分钟：定时 ping，防代理（Cloudflare）闲置断开，也及时发现死连接
    ws.on('message', (data) => {
      if (asked) return
      const msg = parse(data)
      if (!msg || msg.t !== 'pair-request') return
      asked = true
      clearTimeout(deadline)
      if (this.byCode.size >= MAX_PENDING) return this.fail(ws, '中心待确认的配对过多，请稍后再试')
      do {
        code = newCode()
      } while (this.byCode.has(code))
      const expiresAt = Date.now() + this.ttlMs
      this.byCode.set(code, {
        code,
        name: clip(msg.name, 80) || '未命名机器',
        defaultCwd: clip(msg.defaultCwd, 300),
        agents: cleanAgents(msg.agents),
        expiresAt,
        ws,
        claimed: false,
      })
      const expiry = setTimeout(() => this.fail(ws, '配对链接已过期，请重新执行'), this.ttlMs)
      expiry.unref()
      ws.on('close', () => clearTimeout(expiry))
      this.send(ws, { t: 'pair-link', code: displayCode(code), expiresAt: new Date(expiresAt).toISOString() })
    })
  }

  /** 确认页取机器信息；码无效 / 已用 / 机器已断开 → null */
  peek(rawCode: string): PairInfo | null {
    const p = this.live(rawCode)
    if (!p) return null
    return { code: displayCode(p.code), name: p.name, defaultCwd: p.defaultCwd, agents: p.agents, expiresAt: new Date(p.expiresAt).toISOString() }
  }

  /** 确认：确认人成为机器主人，状态按他此刻在空间的角色定（owner → approved，member → pending）。
   *  空间角色的 404 / 403 由路由先判，这里的 role 只兜「判完之后角色变了」的竞争 */
  async confirm(rawCode: string, spaceId: string, userId: string): Promise<ConfirmResult> {
    const p = this.live(rawCode)
    if (!p || p.claimed) return { ok: false, reason: 'gone' }
    p.claimed = true
    let created: Awaited<ReturnType<typeof createConnector>>
    try {
      created = await createConnector(this.pool, spaceId, userId, p.name, p.agents)
    } catch (err) {
      p.claimed = false
      throw err
    }
    if (!created) {
      p.claimed = false // 换个空间还能再确认
      return { ok: false, reason: 'role' }
    }
    // 插库期间 connector 断了：token 送不到，这行就是孤儿，删掉
    if (p.ws.readyState !== WebSocket.OPEN) {
      await deleteConnector(this.pool, created.connectorId)
      return { ok: false, reason: 'gone' }
    }
    this.byCode.delete(p.code)
    this.send(p.ws, { t: 'paired', connectorId: created.connectorId, token: created.token, ownerId: userId })
    p.ws.close(1000, 'paired')
    this.onPaired?.()
    return { ok: true, connectorId: created.connectorId, status: created.status }
  }

  /** 浏览器里点了拒绝：connector 收到后退出 */
  reject(rawCode: string): boolean {
    const p = this.live(rawCode)
    if (!p || p.claimed) return false
    this.fail(p.ws, '已在浏览器里拒绝这次配对')
    return true
  }

  private live(rawCode: string): Pending | null {
    const p = this.byCode.get(normalizeCode(rawCode))
    if (!p || p.ws.readyState !== WebSocket.OPEN || Date.now() >= p.expiresAt) return null
    return p
  }

  /** 发错误并关：关握手期间 readyState 已不是 OPEN，live() 不再认它；close 事件里再从表里删 */
  private fail(ws: WebSocket, message: string): void {
    this.send(ws, { t: 'pair-error', message })
    ws.close(1000, 'pair-error')
  }

  private send(ws: WebSocket, msg: PairReply): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }
}
