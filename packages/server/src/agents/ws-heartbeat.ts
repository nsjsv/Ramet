// ---------- connector ↔ 中心这条 ws 的心跳（两端各跑一份） ----------
// 经代理 / VPN 切换 / 休眠唤醒时，对端没了这边可能收不到任何关闭通知，ws 就一直挂着一条死连接：
// 设置里显示机器离线，connector 进程还以为连着、不重连，只能手动 stop / start。
// 只能自己探：每隔 HEARTBEAT_MS ping 一次，一个周期内没有任何回音（pong 或消息）就判死、terminate，
// 由各自的 close 处理收尾（connector 随后重连，中心注销这条连接）。ws 库收到 ping 会自动回 pong，对端不用配合。

import type { WebSocket } from 'ws'

export const HEARTBEAT_MS = 25_000

/** onRtt：每次 pong 回来报一次往返时间（ping 发出到 pong 回来）。中心用它算中心 ↔ connector 那一段，
 *  网页终端的延迟标签是浏览器 ↔ 中心加上这一段（routes/pty-socket.ts） */
export function keepAlive(ws: WebSocket, onDead: () => void, opts: { intervalMs?: number; onRtt?: (ms: number) => void } = {}): void {
  let alive = true
  let pingAt = 0
  const mark = (): void => {
    alive = true
  }
  ws.on('pong', () => {
    mark()
    if (pingAt) opts.onRtt?.(Date.now() - pingAt)
    pingAt = 0
  })
  ws.on('message', mark)
  const timer = setInterval(() => {
    if (!alive) {
      clearInterval(timer)
      onDead()
      ws.terminate()
      return
    }
    alive = false
    try {
      ws.ping()
      pingAt = Date.now()
    } catch {
      // 已经在关了：close 处理会收尾
    }
  }, opts.intervalMs ?? HEARTBEAT_MS)
  timer.unref()
  ws.on('close', () => clearInterval(timer))
}
