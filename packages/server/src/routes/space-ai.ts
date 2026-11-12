/* ---------- 空间 AI 的配置（团队空间设置里的「空间 AI」卡） ----------
 * GET /api/spaces/:id/ai → 成员：{ enabled, name }；owner 另有 connectionId（他选的、此刻还属于他的那个连接，否则 null）。
 *   非成员 / 不存在 / 个人空间同一个 404（个人空间没有空间 AI，就用 Genet）。
 * PUT /api/spaces/:id/ai { connectionId?: string | null, name?: string } → 同 GET 的 owner 形状。只给的那项改，没给的不动。
 *   只有空间 owner 能改（成员 403，全局 admin 也不例外）；连接必须是 owner 自己的（别人的 / 不存在的 400）；名字 trim 后 1–20 字（400）。
 *   改完经 notify 广播，在线端重拉空间列表（列表里带 ai，@ 菜单与回复抬头用它）。
 * owner 在设置里删 / 改了自己的连接也会让空间 AI 停用或恢复（删掉的连接被 SET NULL），watchSpaceAiConnections 同样广播。
 * 生效与否的判定只有 agents/space-ai.ts 的 SPACE_AI_JOIN 一份。每条路由自带 requireAuth，挂载顺序无影响。 */

import { Hono, type Context } from 'hono'
import type { Pool } from 'pg'
import { getConnection, onConnectionsChanged } from '../ai-connections.js'
import { requireAuth, type AuthEnv } from '../auth.js'
import { normalizeSpaceAiName, SPACE_AI_DEFAULT_NAME, SPACE_AI_JOIN, SPACE_AI_NAME_MAX } from '../agents/space-ai.js'

type ConfigRow = { owner_id: string; is_personal: boolean; my_role: string | null; name: string | null; connection_id: string | null }

const SELECT_CONFIG = `SELECT s.owner_id, s.is_personal, m.role AS my_role, sa.name, sc.id AS connection_id
  FROM spaces s LEFT JOIN space_members m ON m.space_id = s.id AND m.user_id = $2
  ${SPACE_AI_JOIN} WHERE s.id = $1`
const UPSERT = `INSERT INTO space_ai (space_id, connection_id, name) VALUES ($1, $2, $3)
  ON CONFLICT (space_id) DO UPDATE SET connection_id = EXCLUDED.connection_id, name = EXCLUDED.name, updated_at = now()`
const SELECT_STORED = 'SELECT connection_id, name FROM space_ai WHERE space_id = $1'

// 这个人是不是哪个空间的 owner、配过空间 AI（停用的也算：连接删了之后 connection_id 已经是 NULL）
const OWNS_SPACE_AI = 'SELECT 1 FROM space_ai sa JOIN spaces s ON s.id = sa.space_id WHERE s.owner_id = $1 LIMIT 1'

/** 有人增删改了自己的模型连接：他配过空间 AI 就广播，不然在线端的空间列表要到下一次重拉才知道它停用了。返回取消订阅 */
export function watchSpaceAiConnections(pool: Pool, notify: () => void): () => void {
  return onConnectionsChanged((userId) => {
    pool
      .query(OWNS_SPACE_AI, [userId])
      .then((r) => {
        if (r.rowCount) notify()
      })
      .catch((err: unknown) => console.error('[space-ai] 连接变更后广播失败', err))
  })
}

export type SpaceAiView = { enabled: boolean; name: string; connectionId?: string | null }

export function spaceAiRoutes(pool: Pool, notify?: () => void) {
  const app = new Hono<AuthEnv>()
  const auth = requireAuth(pool)

  /** 空间 + 我的角色；非成员 / 不存在 / 个人空间 = null（同一个 404） */
  async function load(c: Context<AuthEnv>): Promise<ConfigRow | null> {
    const row = (await pool.query<ConfigRow>(SELECT_CONFIG, [c.req.param('id') ?? '', c.get('user').id])).rows[0]
    return row && row.my_role !== null && !row.is_personal ? row : null
  }

  function view(row: ConfigRow, userId: string): SpaceAiView {
    const base = { enabled: row.connection_id !== null, name: row.name ?? SPACE_AI_DEFAULT_NAME }
    return row.owner_id === userId ? { ...base, connectionId: row.connection_id } : base
  }

  app.get('/api/spaces/:id/ai', auth, async (c) => {
    const row = await load(c)
    if (!row) return c.json({ error: 'space not found' }, 404)
    c.header('cache-control', 'no-store')
    return c.json(view(row, c.get('user').id))
  })

  app.put('/api/spaces/:id/ai', auth, async (c) => {
    const user = c.get('user')
    const spaceId = c.req.param('id')
    const row = await load(c)
    if (!row) return c.json({ error: 'space not found' }, 404)
    if (row.owner_id !== user.id) return c.json({ error: 'forbidden', message: '只有空间所有者能设置空间 AI' }, 403)
    const body = (await c.req.json().catch(() => null)) as { connectionId?: unknown; name?: unknown } | null
    if (!body || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400)
    const stored = (await pool.query<{ connection_id: string | null; name: string }>(SELECT_STORED, [spaceId])).rows[0]
    let connectionId = stored?.connection_id ?? null
    if (body.connectionId !== undefined) {
      if (body.connectionId !== null && typeof body.connectionId !== 'string') return c.json({ error: 'invalid connectionId' }, 400)
      // 只能选自己的连接：空间 AI 花的是 owner 的额度，别人的连接 key 用不了也不该被选
      if (body.connectionId !== null && !(await getConnection(pool, user.id, body.connectionId))) {
        return c.json({ error: 'invalid connectionId', message: '只能选你自己在设置里添加的模型连接' }, 400)
      }
      connectionId = body.connectionId
    }
    let name = stored?.name ?? SPACE_AI_DEFAULT_NAME
    if (body.name !== undefined) {
      const normalized = normalizeSpaceAiName(body.name)
      if (!normalized) return c.json({ error: 'invalid name', message: `名字要有 1–${SPACE_AI_NAME_MAX} 个字` }, 400)
      name = normalized
    }
    await pool.query(UPSERT, [spaceId, connectionId, name])
    notify?.()
    const updated = await load(c)
    return updated ? c.json(view(updated, user.id)) : c.json({ error: 'space not found' }, 404)
  })

  return app
}
