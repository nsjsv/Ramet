// 一个终端的连接：一条 WebSocket（/term）承载订阅、输入、改尺寸、测往返。
// 服务端见 server/src/routes/pty-socket.ts，消息形状与关闭码以那里的头注释为准。按键收到就发，不等确认，靠这一条连接保序。
//
// 还原：全新打开 after = -1，服务端给屏幕快照（ready.snapshot，老 connector 没有，照旧是回放）；断线重连带 after =
// 已写入的最大 seq，短暂断线补差量，断太久也是快照。快照之后只交付 seq 更大的输出（同一个 seq 不会写两遍）。
// 断线期间敲的字先攒着（上限 PENDING_MAX），连上后按顺序补发。
// 终止条件：终端退出（exit，随后 1000 关闭）、永久性失败（关闭码 44xx，机器离线 4409 除外）、dispose。

import { terminalApi, type TermInfo } from './terminal-api'

/** 屏幕快照：先按 cols / rows 写入，再调整成自己的尺寸（TermPane） */
export type TermSnapshot = { data: string; seq: number; cols: number; rows: number }

export type TermWire =
  | { t: 'ready'; pty: TermInfo; lost: boolean; snapshot?: TermSnapshot }
  | { t: 'data'; seq: number; data: string }
  | { t: 'exit'; code: number | null; reason: string }
  | { t: 'end'; error: string; message: string }
  | { t: 'pong'; id: number; relayMs: number | null }

/** 连接关了怎么办：done = 终端退出了（exit 已交付）；permanent = 再连也没用（没登录 / 没授权 / 不是你的 / 不存在 / connector 不支持）；
 *  offline = 机器离线，慢慢等它回来；retry = 网络 / 服务端暂时的问题（含 4408「收得太慢」，立即重连拿快照） */
export function closeVerdict(code: number, error: string): 'done' | 'permanent' | 'offline' | 'retry' {
  if (code === 1000) return 'done'
  if (code === 4409) return error === 'machine offline' ? 'offline' : 'permanent'
  if (code === 4408) return 'retry'
  if (code >= 4400 && code < 4500) return 'permanent'
  return 'retry'
}

export type SessionStatus = 'connecting' | 'live' | 'reconnecting' | 'ended'

export interface SessionHandlers {
  /** 连上了：snapshot 有值时要先按它还原屏幕（整屏重画），没有就接着往下写（回放 / 实时） */
  ready(info: TermInfo, lost: boolean, snapshot?: TermSnapshot): void
  /** 新到的输出（按 seq 去重后，原样交给 xterm） */
  data(text: string): void
  /** 终端里的进程退出了 / 终端被关了。reason：exited · closed · revoked · idle · shutdown */
  exit(code: number | null, reason: string): void
  /** 连接不会再恢复了，message 是服务端的人话；code 是关闭码 */
  failed(message: string, code: number): void
  status(status: SessionStatus, message?: string): void
  /** 断线期间攒的输入太多，丢掉了 */
  inputError(message: string): void
  /** 一次往返：浏览器 ↔ 中心（rttMs）；中心 ↔ connector 最近一次心跳往返（relayMs，没测到 = null） */
  latency(rttMs: number, relayMs: number | null): void
}

type Socket = Pick<WebSocket, 'send' | 'close' | 'readyState'> & {
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code: number }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

const RETRY_MIN_MS = 500
const RETRY_MAX_MS = 8000
const OFFLINE_RETRY_MS = 3000
const RESIZE_DEBOUNCE_MS = 80
const PING_MS = 5000
/** 断线期间最多攒多少字符的输入（重连可能要很久，不能无限攒） */
const PENDING_MAX = 4096
/** 单条输入消息最多多少字符（服务端上限 64K，留一半余量；粘贴大段文本按块发） */
export const INPUT_CHUNK_MAX = 32 * 1024
const OPEN = 1

export class TermSession {
  private after = -1
  private ws: Socket | null = null
  private live = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private resizeTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private retries = 0
  private done = false
  private size: { cols: number; rows: number } | null = null
  /** 这条连接上已经发过的尺寸（重连后要重发） */
  private sentSize = ''
  private pending = ''
  private lastEnd: { error: string; message: string } | null = null
  private pings = new Map<number, number>()
  private nextPing = 1

  constructor(
    private target: { pageId: string; agent: string; ptyId: string },
    private h: SessionHandlers,
    private deps: { socket?: (url: string) => Socket; now?: () => number } = {},
  ) {}

  start(): void {
    this.connect()
  }

  /** 用户敲的字：连着就立刻发，没连上先攒着 */
  send(data: string): void {
    if (this.done || !data) return
    if (this.live && this.ws?.readyState === OPEN) return this.sendInput(data)
    if (this.pending.length + data.length > PENDING_MAX) {
      this.h.inputError('连接断开期间敲的字太多，没能攒住')
      return
    }
    this.pending += data
  }

  /** 终端尺寸变了（xterm 的 onResize）：去抖后发给服务端，同样的尺寸不重复发；没连上时连上再发 */
  resize(cols: number, rows: number): void {
    if (this.done) return
    this.size = { cols, rows }
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null
      this.sendSize()
    }, RESIZE_DEBOUNCE_MS)
  }

  dispose(): void {
    this.done = true
    this.stopTimers()
    const ws = this.ws
    this.ws = null
    ws?.close(1000)
  }

  private now(): number {
    return this.deps.now?.() ?? performance.now()
  }

  private connect(): void {
    if (this.done) return
    this.h.status(this.after < 0 && this.retries === 0 ? 'connecting' : 'reconnecting', this.lastEnd?.message)
    const url = terminalApi.socketUrl(this.target.pageId, this.target.agent, this.target.ptyId, this.after)
    const ws = this.deps.socket?.(url) ?? (new WebSocket(url) as unknown as Socket)
    this.ws = ws
    this.live = false
    this.sentSize = ''
    this.lastEnd = null
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      let msg: TermWire
      try {
        msg = JSON.parse(String(ev.data)) as TermWire
      } catch {
        return
      }
      this.handle(msg)
    }
    ws.onclose = (ev) => {
      if (this.ws === ws) this.onClose(ev.code)
    }
    ws.onerror = () => undefined // 随后一定有 close，按关闭码处理
  }

  private handle(msg: TermWire): void {
    switch (msg.t) {
      case 'ready':
        this.retries = 0
        this.live = true
        if (msg.snapshot) this.after = msg.snapshot.seq
        this.h.status('live')
        this.h.ready(msg.pty, msg.lost, msg.snapshot)
        this.sendSize()
        if (this.pending) {
          const queued = this.pending
          this.pending = ''
          this.sendInput(queued)
        }
        this.startPing()
        break
      case 'data':
        // seq 单调递增；快照 / 回放里已经有的不再写
        if (msg.seq > this.after) {
          this.after = msg.seq
          this.h.data(msg.data)
        }
        break
      case 'exit':
        this.h.exit(msg.code, msg.reason)
        this.finish()
        break
      case 'end':
        this.lastEnd = { error: msg.error, message: msg.message } // 关闭码随后就到
        break
      case 'pong': {
        const at = this.pings.get(msg.id)
        if (at === undefined) break
        this.pings.delete(msg.id)
        this.h.latency(this.now() - at, msg.relayMs)
        break
      }
    }
  }

  private onClose(code: number): void {
    this.ws = null
    this.live = false
    this.stopPing()
    if (this.done) return
    const verdict = closeVerdict(code, this.lastEnd?.error ?? '')
    if (verdict === 'done') return this.finish()
    if (verdict === 'permanent') return this.fail(this.lastEnd?.message || `连接被拒绝（${code}）`, code)
    this.retry(verdict === 'offline' ? OFFLINE_RETRY_MS : code === 4408 ? 0 : undefined)
  }

  private sendInput(data: string): void {
    for (let i = 0; i < data.length; i += INPUT_CHUNK_MAX) {
      this.ws?.send(JSON.stringify({ t: 'in', data: data.slice(i, i + INPUT_CHUNK_MAX) }))
    }
  }

  private sendSize(): void {
    if (!this.size || !this.live || this.ws?.readyState !== OPEN) return
    const key = `${this.size.cols}x${this.size.rows}`
    if (key === this.sentSize) return
    this.sentSize = key
    this.ws.send(JSON.stringify({ t: 'size', cols: this.size.cols, rows: this.size.rows }))
  }

  private startPing(): void {
    this.stopPing()
    const ping = (): void => {
      if (!this.live || this.ws?.readyState !== OPEN) return
      const id = this.nextPing++
      this.pings.set(id, this.now())
      // 回不来的（连接断了）别一直攒着
      for (const old of this.pings.keys()) if (old < id - 5) this.pings.delete(old)
      this.ws.send(JSON.stringify({ t: 'ping', id }))
    }
    ping()
    this.pingTimer = setInterval(ping, PING_MS)
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    this.pings.clear()
  }

  private stopTimers(): void {
    this.stopPing()
    if (this.timer) clearTimeout(this.timer)
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    this.timer = this.resizeTimer = null
  }

  private finish(): void {
    this.done = true
    this.pending = ''
    this.stopTimers()
    const ws = this.ws
    this.ws = null
    ws?.close(1000)
    this.h.status('ended')
  }

  private fail(message: string, code: number): void {
    this.finish()
    this.h.failed(message, code)
  }

  private retry(delay?: number): void {
    if (this.done) return
    const wait = delay ?? Math.min(RETRY_MIN_MS * 2 ** this.retries, RETRY_MAX_MS)
    this.retries += 1
    this.h.status('reconnecting', this.lastEnd?.message)
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect()
    }, wait)
  }
}
