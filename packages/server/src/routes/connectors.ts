// ---------- 本地 connector 的管理路由 ----------
// GET    /api/connect/:code                配对确认页：待确认机器的信息（名称 / 默认目录 / agent）；链接无效 / 已用 / 机器已断开 → 404
// POST   /api/connect/:code/confirm        确认接入 {spaceId}：确认人成为机器主人（空间 owner / member；viewer 403，非成员 404，
//                                          全局 admin 不是成员也不行）。token 只经 connector 发起的那条 ws 下发，响应里没有（agents/pairing.ts）
// POST   /api/connect/:code/reject         拒绝：connector 收到后退出
// GET    /api/connectors?space=<id>        该空间的 connector 列表（在线态 + 上报的 agent + status / owner / mine；成员可读）
//                                          已批准的对空间成员可见；pending 的只对空间 owner 和接入人本人可见，别人整行不返回
// POST   /api/connectors/:id/approve       批准成员接入的机器（pending → approved）：只有该空间的 owner
// POST   /api/connectors/:id/reject        拒绝（= 删除并断开在线连接）：同上门槛
// DELETE /api/connectors/:id               撤销：空间 owner 或接入人本人（非成员 404）→ 在线连接立即 4403 断开
// 在线态以进程内 Hub 为准，库里只存 last_seen_at 供离线展示。
// 谁能用一台机器只看 agents/machine-access.ts，这里管的是机器在不在空间里，
// 全局 admin 在这里没有任何特权，除非他本人就是该空间的 owner / 接入人。

import { Hono, type Context } from 'hono'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv } from '../auth.js'
import { approveConnector, deleteConnector, listConnectors, rejectConnector, type ConnectorStatus } from '../agents/connectors.js'
import type { ConnectorHub } from '../agents/hub.js'
import type { PairingDesk } from '../agents/pairing.js'

type SpaceRole = 'owner' | 'member' | 'viewer'

const SELECT_CONNECTOR = 'SELECT space_id, owner_id, status FROM connectors WHERE id = $1'

const LINK_GONE = { error: 'pair link not found', message: '配对链接无效或已失效：请在机器上重新执行 start' }

export function connectorsRoutes(pool: Pool, hub: ConnectorHub, desk: PairingDesk, notify?: () => void) {
  const app = new Hono<AuthEnv>()
  app.use('*', requireAuth(pool))

  /** 空间角色，不存在 / 非成员返回 null */
  async function roleInSpace(c: Context<AuthEnv>, spaceId: string): Promise<SpaceRole | null> {
    const user = c.get('user')
    const { rows } = await pool.query<{ role: SpaceRole }>(
      'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, user.id],
    )
    return rows[0]?.role ?? null
  }


  /** 批准 / 拒绝的闸门：该空间的 owner（不含全局 admin）。机器不存在或你不在这个空间里返回 404（不泄露存在性），
   *  是成员但不是 owner 返回 403，通过则返回机器的当前状态 */
  async function asSpaceOwner(
    c: Context<AuthEnv>,
  ): Promise<{ id: string; spaceId: string; status: ConnectorStatus } | Response> {
    const id = c.req.param('id') ?? ''
    const { rows } = await pool.query<{ space_id: string; status: ConnectorStatus }>(SELECT_CONNECTOR, [id])
    const row = rows[0]
    if (!row) return c.json({ error: 'connector not found' }, 404)
    const role = await roleInSpace(c, row.space_id)
    if (!role) return c.json({ error: 'connector not found' }, 404)
    if (role !== 'owner') return c.json({ error: 'forbidden', message: '只有空间所有者能批准或拒绝机器接入' }, 403)
    return { id, spaceId: row.space_id, status: row.status }
  }

  app.get('/api/connect/:code', (c) => {
    const info = desk.peek(c.req.param('code'))
    return info ? c.json(info) : c.json(LINK_GONE, 404)
  })

  app.post('/api/connect/:code/confirm', async (c) => {
    const code = c.req.param('code')
    const body = (await c.req.json().catch(() => ({}))) as { spaceId?: unknown }
    const spaceId = typeof body.spaceId === 'string' ? body.spaceId : ''
    if (!desk.peek(code)) return c.json(LINK_GONE, 404)
    const role = await roleInSpace(c, spaceId)
    // 不是这个空间的成员（全局 admin 也一样）：看不到这个空间，与不存在同响应
    if (!role) return c.json({ error: 'space not found' }, 404)
    // 只读成员不能接入机器：接入的 agent 会写这个空间的页面
    if (role === 'viewer') return c.json({ error: 'forbidden', message: '只读成员不能接入机器' }, 403)
    // 确认人就是机器主人，状态按他此刻的角色定（owner 直接生效，member 等批准）
    const res = await desk.confirm(code, spaceId, c.get('user').id)
    if (!res.ok) {
      return res.reason === 'gone'
        ? c.json(LINK_GONE, 404)
        : c.json({ error: 'forbidden', message: '你在这个空间的角色刚变了，不能接入机器' }, 403)
    }
    return c.json({ connectorId: res.connectorId, spaceId, status: res.status })
  })

  app.post('/api/connect/:code/reject', (c) => (desk.reject(c.req.param('code')) ? c.json({}) : c.json(LINK_GONE, 404)))

  app.get('/api/connectors', async (c) => {
    const spaceId = c.req.query('space') ?? ''
    const user = c.get('user')
    const role = await roleInSpace(c, spaceId)
    if (!role) return c.json({ error: 'space not found' }, 404)
    // pending 只给空间 owner 和接入人本人看
    const rows = await listConnectors(pool, spaceId, { id: user.id, spaceOwner: role === 'owner' })
    const online = new Map(hub.onlineOfSpace(spaceId).map((conn) => [conn.id, conn]))
    return c.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        // 在线时以 Hub 的实时清单为准，库里的 agents 是上一次上报的快照
        agents: online.get(r.id)?.agents ?? r.agents ?? [],
        online: online.has(r.id),
        created_at: r.created_at,
        last_seen_at: r.last_seen_at,
        status: r.status,
        // 接入人用户名（账号已删 / 老 connector 为 null），不返回 user id
        owner: r.owner,
        mine: r.owner_id === user.id,
      })),
    )
  })

  app.post('/api/connectors/:id/approve', async (c) => {
    const gate = await asSpaceOwner(c)
    if (gate instanceof Response) return gate
    if (gate.status !== 'pending') return c.json({ error: 'not pending', message: '这台机器已经批准过了' }, 409)
    // 条件更新，并发的拒绝 / 重复批准只有一个赢家
    if (!(await approveConnector(pool, gate.id))) return c.json({ error: 'not pending', message: '这台机器已经批准过了' }, 409)
    // 在线的人重拉 agent 目录：接入人（和被授权的人）此刻起能看到它
    notify?.()
    return c.json({})
  })

  app.post('/api/connectors/:id/reject', async (c) => {
    const gate = await asSpaceOwner(c)
    if (gate instanceof Response) return gate
    if (gate.status !== 'pending') return c.json({ error: 'not pending', message: '这台机器已经批准过了，要移除请用撤销' }, 409)
    // 只删 pending，条件删除不会因竞争误删刚被批准的
    if (!(await rejectConnector(pool, gate.id))) return c.json({ error: 'not pending', message: '这台机器已经批准过了，要移除请用撤销' }, 409)
    hub.closeOne(gate.id, '接入被拒绝')
    notify?.()
    return c.json({})
  })

  app.delete('/api/connectors/:id', async (c) => {
    const id = c.req.param('id')
    const { rows } = await pool.query<{ space_id: string; owner_id: string | null }>(SELECT_CONNECTOR, [id])
    const row = rows[0]
    if (!row) return c.json({ error: 'connector not found' }, 404)
    // 接入人可以随时撤销自己的接入（owner_id 为空的老 connector 没有接入人）
    const mine = row.owner_id !== null && row.owner_id === c.get('user').id
    if (!mine) {
      // 不是这个空间的成员与机器不存在同响应 404（不泄露存在性）；是成员但不是空间 owner 403
      const role = await roleInSpace(c, row.space_id)
      if (role === null) return c.json({ error: 'connector not found' }, 404)
      if (role !== 'owner') return c.json({ error: 'forbidden' }, 403)
    }
    await deleteConnector(pool, id)
    hub.closeOne(id, '已被撤销')
    notify?.()
    return c.json({})
  })

  return app
}
