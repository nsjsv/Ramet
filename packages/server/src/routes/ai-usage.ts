/* ---------- AI 使用量（设置里的「AI 使用量」、空间设置「空间 AI」卡里 owner 的用量） ----------
 * GET /api/me/ai-usage?days=30 → MyUsage：我的连接花了多少（含我当 owner 的空间 AI 被成员叫的那部分），按天 / 来源 / 模型分。
 * GET /api/spaces/:id/ai/usage?days=30 → SpaceAiUsage：这个空间的空间 AI 花了多少，按天 / 叫它的成员分。
 *   只有空间 owner 能看（成员 403，全局 admin 不是 owner 也不例外）；非成员 / 不存在同一个 404。
 * days：1–90，别的按 30；「一天」按看的人的时区切。只有 token 与次数，不折算金额。每条路由自带 requireAuth，挂载顺序无影响。 */

import { Hono } from 'hono'
import type { Pool } from 'pg'
import { myUsage, spaceAiUsage, usageDays } from '../ai-usage.js'
import { requireAuth, type AuthEnv } from '../auth.js'
import { userTimeZone } from '../triggers/store.js'

const SELECT_SPACE = `SELECT s.owner_id FROM spaces s
  JOIN space_members m ON m.space_id = s.id AND m.user_id = $2 WHERE s.id = $1`

export function aiUsageRoutes(pool: Pool) {
  const app = new Hono<AuthEnv>()
  const auth = requireAuth(pool)

  app.get('/api/me/ai-usage', auth, async (c) => {
    const user = c.get('user')
    const report = await myUsage(pool, user.id, usageDays(c.req.query('days')), await userTimeZone(pool, user.id))
    c.header('cache-control', 'no-store')
    return c.json(report)
  })

  app.get('/api/spaces/:id/ai/usage', auth, async (c) => {
    const user = c.get('user')
    const spaceId = c.req.param('id')
    const space = (await pool.query<{ owner_id: string }>(SELECT_SPACE, [spaceId, user.id])).rows[0]
    if (!space) return c.json({ error: 'space not found' }, 404)
    // 花的是 owner 的额度，用量只给 owner 看
    if (space.owner_id !== user.id) return c.json({ error: 'forbidden', message: '只有空间所有者能看空间 AI 的用量' }, 403)
    const report = await spaceAiUsage(pool, spaceId, usageDays(c.req.query('days')), await userTimeZone(pool, user.id))
    c.header('cache-control', 'no-store')
    return c.json(report)
  })

  return app
}
