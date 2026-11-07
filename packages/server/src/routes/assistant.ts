/* ---------- Genet：Genet 页 + 任务状态 ----------
 * POST /api/me/assistant                  → {pageId}：这个人的 Genet 页；没有、或进了回收站，就在个人空间顶层新建一页（标题「Genet」）
 * GET  /api/pages/run-status?ids=a,b,c    → {statuses: {<pageId>: running | approval | failed | done | idle}}，最多 50 个；
 *                                            看不到的页不出现（不泄露存在性）。判定见 agents/run-status.ts
 * 每条路由自带 requireAuth（路径限定，不用 '*'），挂载序无影响。Genet 这个 agent 的判定都在 agents/assistant-agent.ts。 */

import { Hono } from 'hono'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv } from '../auth.js'
import { ensureAssistantPage } from '../agents/assistant-agent.js'
import { RUN_STATUS_MAX, runStatuses, type RunStatusHost } from '../agents/run-status.js'

export function assistantRoutes(pool: Pool, host: { status: RunStatusHost; notifyPagesChanged?: () => void }) {
  const app = new Hono<AuthEnv>()
  const auth = requireAuth(pool)

  app.post('/api/me/assistant', auth, async (c) => {
    const { pageId, created } = await ensureAssistantPage(pool, c.get('user'))
    if (created) host.notifyPagesChanged?.()
    return c.json({ pageId })
  })

  app.get('/api/pages/run-status', auth, async (c) => {
    const ids = (c.req.query('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    if (ids.length > RUN_STATUS_MAX) return c.json({ error: `一次最多问 ${RUN_STATUS_MAX} 个页面` }, 400)
    return c.json({ statuses: await runStatuses(host.status, c.get('user'), ids) })
  })

  return app
}
