// ---------- /connector/pair 与 /connector 的升级处理 ----------
// connector 主动出站连接（NAT 友好），中心只在 upgrade 阶段做认证：
//   /connector/pair  无凭据，交给配对台（pairing.ts）：发一次性链接，浏览器确认后经这条连接下发长期 token
//   /connector       header `x-ramet-connector: <token>` → 查 connectors → 进 Hub
// 认证失败一律 4403（connector 收到即停重连，区别于网络抖动的 1006）。

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WebSocketServer, WebSocket } from 'ws'
import type { Pool } from 'pg'
import { connectorByToken, saveAgents } from './connectors.js'
import type { ConnectorHub } from './hub.js'
import type { PairingDesk } from './pairing.js'
import { keepAlive } from './ws-heartbeat.js'
import {
  CONNECTOR_PATH,
  CONNECTOR_PAIR_PATH,
  CONNECTOR_REVOKED_CODE,
  CONNECTOR_TOKEN_HEADER,
  type ConnMsg,
} from './protocol.js'

export function isConnectorPath(pathname: string): boolean {
  return pathname === CONNECTOR_PATH || pathname === CONNECTOR_PAIR_PATH
}

function parse(data: unknown): ConnMsg | null {
  try {
    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && typeof (parsed as { t?: unknown }).t === 'string'
      ? (parsed as ConnMsg)
      : null
  } catch {
    return null
  }
}

/** 正式连接：hello 之后才进 Hub（先有身份与 agent 清单，才可能被 catalog 选中） */
function handleConnectorSocket(
  ws: WebSocket,
  pool: Pool,
  hub: ConnectorHub,
  connectorId: string,
  spaceId: string,
  ownerId: string | null,
): void {
  let attached = false
  ws.on('message', (data) => {
    const msg = parse(data)
    if (!msg) return
    if (!attached) {
      if (msg.t !== 'hello') {
        ws.close(CONNECTOR_REVOKED_CODE, '需要 hello')
        return
      }
      attached = true
      const conn = hub.attach({
        id: connectorId,
        spaceId,
        ownerId,
        name: msg.name,
        defaultCwd: msg.defaultCwd,
        agents: msg.agents,
        caps: Array.isArray(msg.caps) ? msg.caps.filter((c): c is string => typeof c === 'string') : [],
        ws,
      })
      void saveAgents(pool, connectorId, msg.agents).catch(() => undefined)
      // resume/drop 由 hub 按 hello.inflight 问认领方再发出；这里只把 inflight 交进去
      void hub.welcomeFor(conn.id, msg.inflight ?? [])
      return
    }
    hub.handle(connectorId, msg)
  })
  // 只注销这条连接：同一台机器重连后旧连接才关（半开连接超时 / 心跳判死）时，不能把新连接一起注销，
  // 否则设置里显示离线，而 connector 的新连接好好的、不会重连
  const gone = (reason: string): void => {
    if (hub.get(connectorId)?.ws === ws) hub.detach(connectorId, reason)
  }
  ws.on('close', () => gone('已断开'))
  ws.on('error', () => gone('连接出错'))
  keepAlive(ws, () => console.warn(`[connector] ${connectorId} 心跳超时，断开`), {
    onRtt: (ms) => {
      if (hub.get(connectorId)?.ws === ws) hub.noteRtt(connectorId, ms)
    },
  })
}

/** 升级入口（index.ts 的 server.on('upgrade') 分发到这里） */
export function connectorUpgrade(
  wss: WebSocketServer,
  pool: Pool,
  hub: ConnectorHub,
  desk: PairingDesk,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost')
  if (pathname === CONNECTOR_PAIR_PATH) {
    wss.handleUpgrade(request, socket, head, (ws) => desk.open(ws))
    return
  }
  const token = request.headers[CONNECTOR_TOKEN_HEADER]
  const raw = Array.isArray(token) ? token[0] : token
  if (!raw) {
    socket.destroy()
    return
  }
  connectorByToken(pool, raw)
    .then((conn) => {
      if (!conn) {
        // 撤销/失效：先握手再 4403，connector 能区分"被撤销"与"网络抖动"
        wss.handleUpgrade(request, socket, head, (ws) => ws.close(CONNECTOR_REVOKED_CODE, 'token 无效'))
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) =>
        handleConnectorSocket(ws, pool, hub, conn.id, conn.spaceId, conn.ownerId),
      )
    })
    .catch(() => socket.destroy())
}
