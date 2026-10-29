// ---------- 网页终端的 WebSocket（/term）：订阅（就绪 / 快照 / 输出 / 退出 / 结束）+ 输入 + 改尺寸 + 测往返 ----------
// 一条连接：按键收到就转，靠连接本身保序。
// 中心不运行任何 shell，只鉴权 + 经 PtyBridge 扇出 connector 推来的输出；pty 的归属仍由 connector 判（带 actor 的驱动帧）。
//
// URL：/term?page=<pageId>&agent=<catalogId>&pty=<ptyId>&after=<浏览器已写入的最大 seq，全新打开 = -1>
// 浏览器 → 中心（JSON）：{t:'in', data} · {t:'size', cols, rows} · {t:'ping', id}
// 中心 → 浏览器（JSON）：
//   {t:'ready', pty, lost, snapshot?}  pty 是对外形状（mine / owner，与 REST 列表同一个 toPublic）；snapshot = 屏幕快照（老 connector 没有）
//   {t:'data', seq, data}              实时输出 / 短暂断线的补差量（seq 去重在 PtyBridge）
//   {t:'exit', code, reason}           随后 1000 关闭，浏览器不再重连
//   {t:'end', error, message}          随后以 4000 + HTTP 状态关闭（与 REST 同一套 classifyFailure）
//   {t:'pong', id, relayMs}            relayMs = 中心 ↔ connector 最近一次心跳往返（没测到 = null）
//
// 关闭码（浏览器据此决定重连还是放弃，见 web/src/project/terminal-session.ts）：
//   4401 没登录 · 4403 没有 machine 授权 / 不是你的终端 / 授权被收回 · 4404 页面或终端不存在 · 4400 参数 / connector 侧失败
//   4409 机器离线（error = 'machine offline'，稍后重试）或 connector 不支持 / 太旧（永久） · 4408 浏览器收得太慢（立即重连拿快照）
//
// 安全：
//   - 升级前校验 Origin（同 /collab）：别的站点的页面（含预览页）不能带着登录 cookie 连进来。来源不对直接断开 socket。
//   - 先完成升级、再鉴权：浏览器的 WebSocket API 拿不到握手的 HTTP 状态，失败原因只能以 end 消息告诉它。鉴权完成前收到的消息先攒着
//     （保序），鉴权失败就丢掉，一个帧也不会发到机器上。
//   - 判定与 REST 守卫一致：会话 → 页面可读（pageAccess）→ machine 授权（projectContext / assertCanUse）→ 机器在线 →
//     订阅（connector 判归属）。之后每条输入不再查库：归属与本机授权名单由 connector 对每个驱动帧再判一次；
//     授权收回 / 到期 / 收窄时 PtyBridge.dropUser 结束订阅 → 这里以 4403 关闭。

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Pool } from 'pg'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { userFromRequest } from '../auth.js'
import { pageAccess } from '../collab.js'
import { originAllowed } from '../csrf.js'
import type { ConnectorHub } from '../agents/hub.js'
import type { PtyEvent } from '../agents/pty-bridge.js'
import { askProject, MachineOfflineError, projectContext, sendProject, type ProjectCtx } from '../agents/project.js'
import { PTY_COLS_MAX, PTY_INPUT_MAX, PTY_ROWS_MAX } from '../agents/pty-types.js'
import { classifyFailure } from './project-common.js'
import { toPublic } from './project-pty.js'

export const TERM_PATH = '/term'
/** 往浏览器的积压超过它就断开（4408）：慢客户端遇上海量输出时，与其在中心堆内存，不如让它重连拿一份快照 */
const BACKLOG_MAX = 8 * 1024 * 1024

const END_MESSAGE = { revoked: '你对这台机器的使用授权已收回，终端已关闭', offline: '这台机器断开了连接' } as const

/** 终端专用的 WebSocketServer：开 permessage-deflate（输出是文本，压缩比高；差网络下省带宽），1KB 以下的消息不压 */
export function createTermWss(): WebSocketServer {
  return new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024 }, maxPayload: 4 * PTY_INPUT_MAX })
}

/** index.ts 的 upgrade 分发把 /term 交到这里 */
export function ptySocketUpgrade(
  wss: WebSocketServer,
  pool: Pool,
  hub: ConnectorHub,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  if (!originAllowed(request.headers.origin, request.headers.host)) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    serve(ws, pool, hub, request).catch((err: unknown) => {
      console.error('[term] 连接处理失败:', err)
      ws.close(4400, 'failed')
    })
  })
}

function parseAfter(raw: string | null): number {
  const n = Number(raw ?? '-1')
  return Number.isFinite(n) ? Math.max(-1, Math.floor(n)) : -1
}

const isSize = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max

async function serve(ws: WebSocket, pool: Pool, hub: ConnectorHub, request: IncomingMessage): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const pageId = url.searchParams.get('page') ?? ''
  const agent = url.searchParams.get('agent') ?? ''
  const ptyId = url.searchParams.get('pty') ?? ''
  const after = parseAfter(url.searchParams.get('after'))

  let closed = false
  let unsubscribe: (() => void) | null = null
  ws.on('close', () => {
    closed = true
    unsubscribe?.()
  })
  // 鉴权 / 订阅完成之前收到的消息先攒着：浏览器一连上就会发尺寸，敲得快的话还有按键
  const early: RawData[] = []
  let onMessage: (data: RawData) => void = (data) => {
    if (early.length < 256) early.push(data)
  }
  ws.on('message', (data) => onMessage(data))

  const send = (msg: Record<string, unknown>): void => {
    if (closed || ws.readyState !== ws.OPEN) return
    if (ws.bufferedAmount > BACKLOG_MAX) {
      ws.close(4408, 'slow')
      return
    }
    ws.send(JSON.stringify(msg))
  }
  const end = (status: number, error: string, message: string): void => {
    send({ t: 'end', error, message })
    ws.close(4000 + status, error)
  }
  const fail = (err: unknown): void => {
    const f = classifyFailure(err)
    end(f.status, f.error, f.message)
  }

  const user = await userFromRequest(pool, request)
  if (!user) return end(401, 'unauthorized', '登录已失效，请重新登录')
  if (!pageId || !agent || !ptyId) return end(400, 'bad request', '缺少 page / agent / pty 参数')
  // 页面不存在 / 非成员 / 已回收：统一 404，不泄露存在性（与 REST 守卫一致）
  if (!(await pageAccess(pool, pageId, user))) return end(404, 'page not found', '页面不存在')
  let ctx: ProjectCtx
  try {
    ctx = await projectContext(pool, hub, pageId, agent, user)
  } catch (err) {
    return fail(err)
  }
  if (!ctx.machine.online) return fail(new MachineOfflineError())
  if (closed) return

  const onEvent = (ev: PtyEvent): void => {
    if (ev.type === 'data') return send({ t: 'data', seq: ev.seq, data: ev.data })
    if (ev.type === 'exit') {
      send({ t: 'exit', code: ev.code, reason: ev.reason })
      ws.close(1000, 'exit')
      return
    }
    // 中心结束了订阅：授权没了（永久）/ 机器掉线了（稍后重试）
    if (ev.reason === 'revoked') end(403, 'revoked', END_MESSAGE.revoked)
    else end(409, 'machine offline', END_MESSAGE.offline)
  }
  try {
    const sub = await hub.ptys.subscribe(ctx.pass, ptyId, after, {
      ready: (meta) =>
        send({ t: 'ready', pty: toPublic(meta.pty, user.id, new Map()), lost: meta.lost, ...(meta.snapshot ? { snapshot: meta.snapshot } : {}) }),
      event: onEvent,
    })
    unsubscribe = sub.unsubscribe
  } catch (err) {
    return fail(err)
  }
  if (closed) return unsubscribe()

  const handle = (raw: RawData): void => {
    let msg: { t?: unknown; data?: unknown; cols?: unknown; rows?: unknown; id?: unknown }
    try {
      msg = JSON.parse(String(raw)) as typeof msg
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    if (msg.t === 'in') {
      const data = msg.data
      if (typeof data !== 'string' || !data || data.length > PTY_INPUT_MAX) return
      try {
        // 发给 connector 就算，不等应答：顺序由这条连接 + 中心按到达顺序写进同一条 connector ws 保证
        sendProject(hub, ctx, (rid, actor) => ({ t: 'pty-input', rid, actor, ptyId, data }), (err) =>
          console.warn(`[pty] 输入没写进终端 ${ptyId}（${user.username}）：${err.message}`),
        )
      } catch (err) {
        // 发帧前就被拒（机器刚掉线等）：订阅会随之结束，这里只记一笔
        console.warn(`[pty] 输入没发出去 ${ptyId}：${err instanceof Error ? err.message : String(err)}`)
      }
    } else if (msg.t === 'size') {
      const { cols, rows } = msg
      if (!isSize(cols, PTY_COLS_MAX) || !isSize(rows, PTY_ROWS_MAX)) return
      askProject(hub, ctx, 'pty-resize', (rid, actor) => ({ t: 'pty-resize', rid, actor, ptyId, cols, rows })).catch(() => undefined)
    } else if (msg.t === 'ping' && typeof msg.id === 'number') {
      send({ t: 'pong', id: msg.id, relayMs: hub.rtt(ctx.machine.id) })
    }
  }
  onMessage = handle
  for (const raw of early.splice(0)) handle(raw)
}
