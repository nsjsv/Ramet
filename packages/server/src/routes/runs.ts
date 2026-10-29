/**
 * GET /api/runs/:id → 这一轮的结构化 record(用量、条目)。页面正文是协同文档,不从这里读。
 * 可见性与读页面一致(pageAccess:不存在 / 非成员 / 已回收一律 404)。
 * 列表/树等页面行查询从不选 record —— 只有这个端点读它。
 */
import { Hono } from 'hono'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv } from '../auth.js'
import { pageAccess } from '../collab.js'

const SELECT_RUN = `SELECT r.record, p.id, p.title, p.parent_id
  FROM runs r JOIN live_pages p ON p.id = r.page_id WHERE r.page_id = $1`
const SELECT_PARENT = 'SELECT id, title FROM live_pages WHERE id = $1'

export function runsRoutes(pool: Pool) {
  const app = new Hono<AuthEnv>()
  app.use('/api/runs/*', requireAuth(pool))

  app.get('/api/runs/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    if (!(await pageAccess(pool, id, user))) return c.json({ error: 'page not found' }, 404)
    const { rows } = await pool.query<{ record: unknown; id: string; title: string; parent_id: string | null }>(SELECT_RUN, [id])
    const row = rows[0]
    if (!row) return c.json({ error: 'page not found' }, 404)
    let parent: { id: string; title: string } | null = null
    if (row.parent_id && (await pageAccess(pool, row.parent_id, user))) {
      parent = (await pool.query<{ id: string; title: string }>(SELECT_PARENT, [row.parent_id])).rows[0] ?? null
    }
    return c.json({ record: row.record, page: { id: row.id, title: row.title }, parent })
  })

  return app
}
