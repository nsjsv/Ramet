// ---------- 机器上的授权确认 / 本机收回（connector token 认证）----------
// GET  /api/connector/grants/:code          确认前看一眼：这个码授权给谁、什么范围、到期多久（码必须属于这台机器的 token）
// POST /api/connector/grants/:code/confirm  确认：置 confirmed_at、清掉码，授权才生效
// POST /api/connector/grants/revoke {userId} 机器上的收回命令：收回此人在这台机器上的全部授权（收回即断）
// 认证用 header `x-ramet-connector: <token>`（同 /connector 的 ws 升级），不是登录 cookie，调用方是机器上的命令行。
// 必须挂在 requireAuth 子应用之前（index.ts 里紧跟 authRoutes）：Hono 按注册序组链，未登录的 /api/* 会先被它们 401 掉。
// 码不存在、不属于这台机器、已确认、已过期、已收回一律同一个 404，不区分。

import { Hono } from 'hono'
import type { Pool } from 'pg'
import { connectorByToken } from '../agents/connectors.js'
import { confirmGrant, peekGrant, revokeUserGrants, type Disconnect } from '../agents/machine-grants.js'
import type { MachineScope } from '../agents/machine-access.js'
import { CONNECTOR_TOKEN_HEADER } from '../agents/protocol.js'

type ConnEnv = { Variables: { connectorId: string } }

export function connectorGrantRoutes(
  pool: Pool,
  deps: {
    disconnect: Disconnect
    /** 授权收窄（换成了范围更小的新授权，此人仍有权限）：当场收掉丢掉的那部分（终端等） */
    reduce?: (connectorId: string, userId: string, lost: MachineScope[]) => void
    notify?: () => void
  },
) {
  const app = new Hono<ConnEnv>()

  app.use('/api/connector/*', async (c, next) => {
    const token = c.req.header(CONNECTOR_TOKEN_HEADER) ?? ''
    const conn = token ? await connectorByToken(pool, token) : null
    if (!conn) return c.json({ error: 'unauthorized' }, 401)
    c.set('connectorId', conn.id)
    await next()
  })

  app.get('/api/connector/grants/:code', async (c) => {
    const info = await peekGrant(pool, c.get('connectorId'), c.req.param('code'))
    return info ? c.json(info) : c.json({ error: 'grant not found' }, 404)
  })

  app.post('/api/connector/grants/:code/confirm', async (c) => {
    const done = await confirmGrant(pool, c.get('connectorId'), c.req.param('code'))
    if (!done) return c.json({ error: 'grant not found' }, 404)
    // 收窄：此人原来有的范围（比如 machine）新授权里没了，他已经开着的终端当场关（授权判定在确认那一刻就已为假）
    if (done.lost.length > 0) deps.reduce?.(c.get('connectorId'), done.info.userId, done.lost)
    deps.notify?.()
    return c.json(done.info)
  })

  app.post('/api/connector/grants/revoke', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { userId?: unknown } | null
    if (typeof body?.userId !== 'string' || !body.userId) return c.json({ error: 'userId required' }, 400)
    const revoked = await revokeUserGrants(pool, c.get('connectorId'), body.userId, deps.disconnect)
    deps.notify?.()
    return c.json({ revoked })
  })

  return app
}
