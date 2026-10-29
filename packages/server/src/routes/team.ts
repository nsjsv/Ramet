/* ---------- 带队计划 REST（/带队）----------
 * GET   /api/pages/:id/team/:planId         → TeamPlanView：计划 + 每个任务（草稿时带 usable = 发起人此刻能不能用这个负责人）+ 谁发起的 + mine。
 *                                            执行中取实时状态（任务状态 / 时段 / 结果摘要），收尾后取收尾时存下的结果。页面任意可读角色可读
 * PATCH /api/pages/:id/team/:planId         {title?, tasks?: [{id, title?, assignee?, cwd?: string|null}]} → TeamPlanView
 *                                            只改标题 / 负责人 / 工作目录（组长给的 cwd 在提交时就被忽略，目录只能在这里设）。
 *                                            负责人必须是发起人此刻 resolve 得通的 agent；换负责人时旧目录作废；目录必须是那台机器上 agent-dirs 列得出来的目录
 * POST  /api/pages/:id/team/:planId/cancel  → TeamPlanView：取消草稿（已开工的用页面的 stop）
 * 开工不在这里：POST /api/pages/:id/continue {team: planId}（routes/agents.ts；先预检再 202）。
 * 门槛（三个写操作同一套）：页面可写，否则 404（viewer / 非成员不泄露存在性）→ 计划属于这一页，否则 404 → 只有发起人，否则 403
 *   → 必须还是 draft，否则 409。错误体 {error: code, message}。
 * 改动 / 取消后广播页面 SSE `team_plan`（整份视图），并触发收件箱刷新。每条路由自带 requireAuth，挂载顺序无影响。 */

import { Hono, type Context } from 'hono'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv } from '../auth.js'
import { pageAccess } from '../collab.js'
import type { AgentManager } from '../agents/manager.js'
import { TeamPlanError } from '../agents/team-plan.js'

export function teamRoutes(pool: Pool, manager: AgentManager) {
  const app = new Hono<AuthEnv>()
  const auth = requireAuth(pool)

  const planErr = (c: Context<AuthEnv>, err: unknown): Response => {
    if (err instanceof TeamPlanError) return c.json({ error: err.code, message: err.message }, err.status)
    throw err
  }

  app.get('/api/pages/:id/team/:planId', auth, async (c) => {
    const user = c.get('user')
    const pageId = c.req.param('id')
    if (!(await pageAccess(pool, pageId, user))) return c.json({ error: 'page not found' }, 404)
    try {
      c.header('cache-control', 'no-store')
      return c.json(await manager.plans.get(pageId, c.req.param('planId'), user.id))
    } catch (err) {
      return planErr(c, err)
    }
  })

  /** 写操作的页面门槛：可写（owner / member），viewer 与非成员一样 404 */
  async function writableUser(c: Context<AuthEnv>): Promise<boolean> {
    const role = await pageAccess(pool, c.req.param('id') ?? '', c.get('user'))
    return role !== null && role !== 'viewer'
  }

  app.patch('/api/pages/:id/team/:planId', auth, async (c) => {
    if (!(await writableUser(c))) return c.json({ error: 'page not found' }, 404)
    try {
      return c.json(await manager.plans.patch(c.req.param('id'), c.req.param('planId'), c.get('user'), await c.req.json().catch(() => null)))
    } catch (err) {
      return planErr(c, err)
    }
  })

  app.post('/api/pages/:id/team/:planId/cancel', auth, async (c) => {
    if (!(await writableUser(c))) return c.json({ error: 'page not found' }, 404)
    try {
      return c.json(await manager.plans.cancel(c.req.param('id'), c.req.param('planId'), c.get('user')))
    } catch (err) {
      return planErr(c, err)
    }
  })

  return app
}
