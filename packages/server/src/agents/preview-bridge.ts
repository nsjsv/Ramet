// ---------- 端口预览的中心侧：共享登记 + HTTP / WebSocket 经 connector 的转发 ----------
// 一条预览 = 某页面上，某人把某台机器的某个端口共享给本页读者。登记在进程内存里（重启即失效，同票据 / 预览会话），
// connector 那边也只在内存里记（welcome 时清空，中心随后把还在的再登记一遍，两边始终一致）。
//
// 这里不判「谁能看」，那是 preview-server.ts 的事（每个请求重新确认预览还在共享、此人仍可读该页、共享人仍有 machine 授权）。
// 这里只管三件事：
//   1. 登记 / 撤销（share / unshare / dropUser）：撤销时在飞的请求与 WebSocket 当场掐断；
//   2. 一个请求一个 flight：http-req 帧发出去，connector 的 http-res / http-res-body / http-fail 回来，交给调用方的 sink 写给浏览器；
//   3. 一个 WebSocket 一个 link：ws-open 发出去，ws-ready 回来才算连上，之后双向转发。
// 所有帧都以共享人署名（预览里存着他的 MachinePass），connector 收到后按共享人再过一遍本机名单。

import { randomUUID } from 'node:crypto'
import type { ConnMsg, DrivenMsg } from './protocol.js'
import type { MachinePass } from './machine-access.js'
import { ProjectError } from './project-types.js'
import {
  PREVIEW_CENTER_GRACE_MS,
  PREVIEW_CHUNK_BYTES,
  PREVIEW_HEADER_TIMEOUT_MS,
  PREVIEW_IDLE_TIMEOUT_MS,
  PREVIEW_MAX_INFLIGHT,
  PREVIEW_MAX_PER_MACHINE,
  PREVIEW_MAX_WS,
  PREVIEW_RES_BODY_MAX,
  cleanPairs,
  isHopHeader,
  setsRametCookie,
  type HeaderPairs,
} from './preview-types.js'

export type Preview = {
  id: string
  pageId: string
  connectorId: string
  machineName: string
  port: number
  /** 打开预览时落在哪个路径（以 / 开头） */
  path: string
  /** 共享人 */
  sharedBy: string
  sharedByName: string
  createdAt: number
  /** 共享人的 machine 范围凭据：只用来给这条预览的流量帧署名（connector 按共享人再判一次） */
  pass: MachinePass
}

/** 桥需要的 hub 能力（hub 自己构造桥并传自己进来；用接口避免循环依赖） */
export interface PreviewHub {
  request(pass: MachinePass, build: (rid: string, actor: string) => Extract<DrivenMsg, { rid: string }>, timeoutMs?: number): Promise<ConnMsg>
  /** 发一个没有应答的驱动帧（预览的流量帧）：凭据 / 范围 / 能力校验同 request，机器不在线抛错 */
  frame(pass: MachinePass, build: (actor: string) => DrivenMsg): void
  online(connectorId: string): boolean
}

export class PreviewOfflineError extends Error {
  constructor() {
    super('这台机器现在不在线')
  }
}
export class PreviewBusyError extends Error {
  constructor() {
    super('这台机器上的预览正忙，请稍后再试')
  }
}
export class PreviewLimitError extends Error {
  constructor() {
    super(`这台机器最多同时共享 ${PREVIEW_MAX_PER_MACHINE} 个预览，先停掉一个再试`)
  }
}

/** 响应怎么写给浏览器（preview-server 实现） */
export type HttpSink = {
  head(status: number, headers: HeaderPairs): void
  body(chunk: Buffer): void
  end(): void
  /** 头已经发出去之后失败：调用方掐掉浏览器连接，不让它把截断的内容当成完整的 */
  broken(message: string): void
  /** 头还没发就失败：调用方渲染错误页 */
  fail(status: number, message: string): void
}
export type HttpFlight = { write(chunk: Buffer): void; end(): void; abort(): void }

export type WsSink = {
  /** 上游握手成功（protocol = 上游选定的子协议，可能是空串） */
  ready(protocol: string): void
  data(data: Buffer | string, binary: boolean): void
  /** 上游关了 / 握手失败（opened=false） */
  end(code: number, reason: string, opened: boolean): void
}
export type WsLink = { send(data: Buffer | string, binary: boolean): void; close(code?: number): void }

type Flight = {
  reqId: string
  previewId: string
  connectorId: string
  sink: HttpSink
  headSent: boolean
  resBytes: number
  timer: NodeJS.Timeout | null
}

type Link = {
  wsId: string
  previewId: string
  connectorId: string
  sink: WsSink
  opened: boolean
  timer: NodeJS.Timeout | null
}

export type PreviewEvent = { type: 'added' | 'removed'; preview: Preview }

export class PreviewBridge {
  private previews = new Map<string, Preview>()
  private flights = new Map<string, Flight>()
  private links = new Map<string, Link>()
  /** 登记 / 撤销时通知（preview-server 失效会话、index.ts 广播给在线客户端） */
  onEvent: ((ev: PreviewEvent) => void) | null = null

  constructor(private hub: PreviewHub) {}

  // ---------- 登记 ----------

  get(id: string): Preview | undefined {
    return this.previews.get(id)
  }

  list(pageId: string): Preview[] {
    return [...this.previews.values()].filter((p) => p.pageId === pageId).sort((a, b) => a.createdAt - b.createdAt)
  }

  ofMachine(connectorId: string): Preview[] {
    return [...this.previews.values()].filter((p) => p.connectorId === connectorId)
  }

  countOf(connectorId: string): number {
    let n = 0
    for (const p of this.previews.values()) if (p.connectorId === connectorId) n += 1
    return n
  }

  /** 共享：先让 connector 登记（它会按署名人再判一次本机名单），成功才进中心的登记表。同页同机同端口已经有了就返回现成的 */
  async share(input: {
    pageId: string
    pass: MachinePass
    sharedByName: string
    machineName: string
    port: number
    path: string
  }): Promise<Preview> {
    const connectorId = input.pass.machine
    for (const p of this.previews.values()) {
      if (p.pageId === input.pageId && p.connectorId === connectorId && p.port === input.port) return p
    }
    if (this.countOf(connectorId) >= PREVIEW_MAX_PER_MACHINE) throw new PreviewLimitError()
    if (!this.hub.online(connectorId)) throw new PreviewOfflineError()
    const id = randomUUID()
    const msg = await this.hub.request(input.pass, (rid, actor) => ({ t: 'port-share', rid, actor, previewId: id, port: input.port }), 15_000)
    if (msg.t === 'err') throw new ProjectError(msg.message, msg.code === 'forbidden', msg.code === 'not_found')
    if (msg.t !== 'res' || msg.project?.op !== 'port-share') throw new ProjectError('connector 没有返回预期的内容')
    const preview: Preview = {
      id,
      pageId: input.pageId,
      connectorId,
      machineName: input.machineName,
      port: input.port,
      path: input.path,
      sharedBy: input.pass.userId,
      sharedByName: input.sharedByName,
      createdAt: Date.now(),
      pass: input.pass,
    }
    // 等应答期间别的共享把名额占满了：撤掉刚在 connector 上登记的，别留孤儿
    if (this.countOf(connectorId) >= PREVIEW_MAX_PER_MACHINE) {
      this.tellUnshare(preview, input.pass)
      throw new PreviewLimitError()
    }
    this.previews.set(id, preview)
    this.onEvent?.({ type: 'added', preview })
    return preview
  }

  /** 停止共享：中心登记当场删（在飞的请求 / WebSocket 掐断），再尽力通知 connector（它不在线也无妨，重连时 welcome 会清空它的登记）。
   *  pass 是谁来停（共享人或机器主人；connector 按署名人判：自己或本机主人） */
  unshare(id: string, pass?: MachinePass): Preview | undefined {
    const preview = this.previews.get(id)
    if (!preview) return undefined
    this.remove(preview, '这个预览已停止共享')
    this.tellUnshare(preview, pass ?? preview.pass)
    return preview
  }

  /** 共享人在这台机器上的 machine 授权没了（收回 / 到期 / 收窄）：他共享的预览全部停止（connector 那边由 grant-revoked / access-reduced 帧收） */
  dropUser(connectorId: string, userId: string): number {
    let n = 0
    for (const p of [...this.previews.values()]) {
      if (p.connectorId !== connectorId || p.sharedBy !== userId) continue
      this.remove(p, '共享人对这台机器的使用授权已收回，预览已停止')
      n += 1
    }
    return n
  }

  /** 连接断了：在飞的请求都失败（502）。终态断开（4403 撤销）连预览一起清；普通掉线保留登记，请求回 502，重连后再登记 */
  connectorGone(connectorId: string, terminal: boolean): void {
    const why = '这台机器断开了连接'
    for (const f of [...this.flights.values()]) if (f.connectorId === connectorId) this.failFlight(f, 502, why)
    for (const l of [...this.links.values()]) if (l.connectorId === connectorId) this.endLink(l, 1011, why)
    if (!terminal) return
    for (const p of [...this.previews.values()]) if (p.connectorId === connectorId) this.remove(p, why)
  }

  /** connector（重新）连上后：它在 welcome 时清空了登记，把还在共享的再登记一遍。登记被它拒绝（共享人已不在它的本机名单里）就撤掉 */
  resync(connectorId: string): void {
    for (const p of [...this.previews.values()]) {
      if (p.connectorId !== connectorId) continue
      this.hub.request(p.pass, (rid, actor) => ({ t: 'port-share', rid, actor, previewId: p.id, port: p.port }), 15_000).then(
        (msg) => {
          if (msg.t === 'err' && msg.code === 'forbidden') this.remove(p, '共享人对这台机器的使用授权已收回，预览已停止')
        },
        () => undefined, // 又掉线了：下一次 welcome 再来
      )
    }
  }

  private remove(preview: Preview, why: string): void {
    if (this.previews.get(preview.id) !== preview) return
    this.previews.delete(preview.id)
    for (const f of [...this.flights.values()]) {
      if (f.previewId !== preview.id) continue
      this.abortUpstream(f, preview)
      this.failFlight(f, 410, why)
    }
    for (const l of [...this.links.values()]) if (l.previewId === preview.id) this.endLink(l, 1001, why, preview)
    this.onEvent?.({ type: 'removed', preview })
  }

  private tellUnshare(preview: Preview, pass: MachinePass): void {
    this.hub.request(pass, (rid, actor) => ({ t: 'port-unshare', rid, actor, previewId: preview.id }), 10_000).catch(() => undefined)
  }

  // ---------- HTTP ----------

  private flightsOf(connectorId: string): number {
    let n = 0
    for (const f of this.flights.values()) if (f.connectorId === connectorId) n += 1
    return n
  }

  /** 发起一个请求。机器不在线抛 PreviewOfflineError；这台机器上在飞的太多抛 PreviewBusyError（调用方回 502 / 503 页） */
  openHttp(
    preview: Preview,
    req: { method: string; path: string; headers: HeaderPairs; hasBody: boolean },
    sink: HttpSink,
  ): HttpFlight {
    if (!this.hub.online(preview.connectorId)) throw new PreviewOfflineError()
    if (this.flightsOf(preview.connectorId) >= PREVIEW_MAX_INFLIGHT) throw new PreviewBusyError()
    const reqId = randomUUID()
    const flight: Flight = { reqId, previewId: preview.id, connectorId: preview.connectorId, sink, headSent: false, resBytes: 0, timer: null }
    this.flights.set(reqId, flight)
    try {
      this.hub.frame(preview.pass, (actor) => ({ t: 'http-req', actor, previewId: preview.id, reqId, ...req }))
    } catch (err) {
      this.flights.delete(reqId)
      throw isOffline(err) ? new PreviewOfflineError() : err
    }
    this.arm(flight, PREVIEW_HEADER_TIMEOUT_MS + PREVIEW_CENTER_GRACE_MS)
    const send = (body: { chunk?: string; end?: true; abort?: true }): void => {
      try {
        this.hub.frame(preview.pass, (actor) => ({ t: 'http-body', actor, previewId: preview.id, reqId, ...body }))
      } catch {
        this.failFlight(flight, 502, '这台机器断开了连接')
      }
    }
    return {
      write: (chunk) => {
        for (let at = 0; at < chunk.length; at += PREVIEW_CHUNK_BYTES) {
          if (!this.flights.has(reqId)) return
          send({ chunk: chunk.subarray(at, at + PREVIEW_CHUNK_BYTES).toString('base64') })
        }
      },
      end: () => {
        if (this.flights.has(reqId)) send({ end: true })
      },
      abort: () => {
        if (!this.flights.has(reqId)) return
        this.finish(flight)
        this.abortUpstream(flight)
      },
    }
  }

  private arm(flight: Flight, ms: number): void {
    if (flight.timer) clearTimeout(flight.timer)
    flight.timer = setTimeout(() => {
      // 超时：头还没到回 504，已经在流了就掐断。同时通知 connector 放弃
      this.abortUpstream(flight)
      this.failFlight(flight, 504, flight.headSent ? '预览响应中断（太久没有数据）' : '这台机器上的网站太久没有响应')
    }, ms)
    flight.timer.unref()
  }

  /** 让 connector 放弃这个请求（掐断上游）：尽力而为，机器离线就没有上游可掐 */
  private abortUpstream(flight: Flight, known?: Preview): void {
    const preview = known ?? this.previews.get(flight.previewId)
    if (!preview) return
    try {
      this.hub.frame(preview.pass, (actor) => ({ t: 'http-body', actor, previewId: preview.id, reqId: flight.reqId, abort: true }))
    } catch {
      // 已离线
    }
  }

  private finish(flight: Flight): void {
    if (flight.timer) clearTimeout(flight.timer)
    flight.timer = null
    this.flights.delete(flight.reqId)
  }

  /** 失败收尾：头没发走 fail（错误页），发了走 broken（掐连接） */
  private failFlight(flight: Flight, status: number, message: string): void {
    if (!this.flights.has(flight.reqId)) return
    this.finish(flight)
    try {
      if (flight.headSent) flight.sink.broken(message)
      else flight.sink.fail(status, message)
    } catch {
      // 浏览器那头已经没了
    }
  }

  // ---------- WebSocket ----------

  private linksOf(connectorId: string): number {
    let n = 0
    for (const l of this.links.values()) if (l.connectorId === connectorId) n += 1
    return n
  }

  openWs(preview: Preview, req: { path: string; headers: HeaderPairs; protocols: string[] }, sink: WsSink): WsLink {
    if (!this.hub.online(preview.connectorId)) throw new PreviewOfflineError()
    if (this.linksOf(preview.connectorId) >= PREVIEW_MAX_WS) throw new PreviewBusyError()
    const wsId = randomUUID()
    const link: Link = { wsId, previewId: preview.id, connectorId: preview.connectorId, sink, opened: false, timer: null }
    this.links.set(wsId, link)
    try {
      this.hub.frame(preview.pass, (actor) => ({ t: 'ws-open', actor, previewId: preview.id, wsId, ...req }))
    } catch (err) {
      this.links.delete(wsId)
      throw isOffline(err) ? new PreviewOfflineError() : err
    }
    // 上游握手最多等这么久（connector 自己 10s 超时会先带着原因回来）
    link.timer = setTimeout(() => this.endLink(link, 1011, '上游没有响应'), 10_000 + PREVIEW_CENTER_GRACE_MS)
    link.timer.unref()
    return {
      send: (data, binary) => {
        if (!this.links.has(wsId)) return
        try {
          this.hub.frame(preview.pass, (actor) => ({
            t: 'ws-msg', actor, previewId: preview.id, wsId, binary, data: typeof data === 'string' ? data : data.toString('base64'),
          }))
        } catch {
          this.endLink(link, 1011, '这台机器断开了连接')
        }
      },
      close: (code) => {
        if (!this.links.has(wsId)) return
        this.dropLink(link)
        try {
          this.hub.frame(preview.pass, (actor) => ({ t: 'ws-close', actor, previewId: preview.id, wsId, ...(code ? { code } : {}) }))
        } catch {
          // 已离线
        }
      },
    }
  }

  private dropLink(link: Link): void {
    if (link.timer) clearTimeout(link.timer)
    link.timer = null
    this.links.delete(link.wsId)
  }

  /** 这条 WebSocket 结束：告诉浏览器那头；notify 表示还要让 connector 放弃（撤销时 connector 自己也会收，这里再发一次无害） */
  private endLink(link: Link, code: number, reason: string, notify?: Preview): void {
    if (!this.links.has(link.wsId)) return
    this.dropLink(link)
    if (notify) {
      try {
        this.hub.frame(notify.pass, (actor) => ({ t: 'ws-close', actor, previewId: notify.id, wsId: link.wsId }))
      } catch {
        // 已离线
      }
    }
    try {
      link.sink.end(code, reason, link.opened)
    } catch {
      // 浏览器那头已经没了
    }
  }

  // ---------- connector → 中心 ----------

  /** hub.handle 把 connector 推来的预览帧交进来。reqId / wsId 必须属于这台 connector（别的机器不能回这台的请求） */
  ingest(
    connectorId: string,
    msg: Extract<ConnMsg, { t: 'http-res' | 'http-res-body' | 'http-fail' | 'ws-ready' | 'ws-data' | 'ws-end' }>,
  ): void {
    if (msg.t === 'ws-ready' || msg.t === 'ws-data' || msg.t === 'ws-end') {
      const link = this.links.get(msg.wsId)
      if (!link || link.connectorId !== connectorId) return
      if (msg.t === 'ws-ready') {
        if (link.opened) return
        link.opened = true
        if (link.timer) clearTimeout(link.timer)
        link.timer = null
        link.sink.ready(typeof msg.protocol === 'string' ? msg.protocol : '')
      } else if (msg.t === 'ws-data') {
        if (!link.opened || typeof msg.data !== 'string') return
        link.sink.data(msg.binary ? Buffer.from(msg.data, 'base64') : msg.data, msg.binary === true)
      } else {
        this.endLink(link, typeof msg.code === 'number' ? msg.code : 1011, typeof msg.reason === 'string' ? msg.reason : '')
      }
      return
    }
    const flight = this.flights.get(msg.reqId)
    if (!flight || flight.connectorId !== connectorId) return
    if (msg.t === 'http-fail') {
      this.failFlight(flight, msg.status >= 400 && msg.status <= 599 ? msg.status : 502, typeof msg.message === 'string' ? msg.message : '预览失败')
      return
    }
    if (msg.t === 'http-res') {
      const headers = cleanPairs(msg.headers)
      if (flight.headSent || !headers || !Number.isInteger(msg.status) || msg.status < 200 || msg.status > 599) {
        this.failFlight(flight, 502, '这台机器上的网站返回了不认识的响应')
        return
      }
      flight.headSent = true
      this.arm(flight, PREVIEW_IDLE_TIMEOUT_MS)
      flight.sink.head(msg.status, safeResponseHeaders(headers))
      return
    }
    // http-res-body
    if (!flight.headSent) {
      this.failFlight(flight, 502, '这台机器上的网站返回了不认识的响应')
      return
    }
    if (typeof msg.error === 'string') {
      this.failFlight(flight, 502, msg.error)
      return
    }
    if (typeof msg.chunk === 'string' && msg.chunk) {
      const buf = Buffer.from(msg.chunk, 'base64')
      flight.resBytes += buf.length
      if (flight.resBytes > PREVIEW_RES_BODY_MAX) {
        // 没声明长度的流式响应超了上限：掐断上游，浏览器那头也掐断，免得它把截断的文件当完整的
        this.abortUpstream(flight)
        this.failFlight(flight, 502, `预览响应超过 ${PREVIEW_RES_BODY_MAX / 1024 / 1024} MB 的上限`)
        return
      }
      this.arm(flight, PREVIEW_IDLE_TIMEOUT_MS)
      flight.sink.body(buf)
    }
    if (msg.end) {
      this.finish(flight)
      flight.sink.end()
    }
  }
}

/** hub 发帧时「机器不在线 / socket 不可写」的错 */
const isOffline = (err: unknown): boolean => err instanceof Error && (err.message.includes('不在线') || err.message.includes('未连接'))

/** 响应头进浏览器之前：去掉逐跳头；预览想设 Ramet 自己的 cookie（覆盖登录态 / 会话固定）一律丢掉 */
export function safeResponseHeaders(headers: HeaderPairs): HeaderPairs {
  return headers.filter(([name, value]) => !isHopHeader(name) && !(name.toLowerCase() === 'set-cookie' && setsRametCookie(value)))
}
