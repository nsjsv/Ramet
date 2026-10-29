// ---------- 导出：一页（及其子页）的文档状态 ----------
// 导出的 markdown 由编辑器自己的序列化产出（前端用活编辑器的 serializerCtx，见 web/src/export/），服务端不另写一套：
// 这里只把子树里每一页的 Yjs 全量状态（base64）连同标题 / 父子关系一次给出去，前端在浏览器里解码、序列化、打包。
// 权限：目标页必须看得见（非成员与不存在同响应 404），子页与它同空间，成员角色一致。只导出活的 doc 页（过程页 / skill 页 / 回收站不带）。

import { Hono } from 'hono'
import type { Pool } from 'pg'
import * as Y from 'yjs'
import { requireAuth, type AuthEnv } from '../auth.js'
import { loadDocForRead, pageAccess } from '../collab.js'

/** 一次最多带多少页（再大的子树请分开导出） */
const MAX_PAGES = 300

// UNION 去重：库里万一有环也会终止
const SELECT_SUBTREE = `WITH RECURSIVE sub AS (
    SELECT id, parent_id, title, created_at FROM live_pages WHERE id = $1 AND kind = 'doc'
    UNION
    SELECT p.id, p.parent_id, p.title, p.created_at FROM live_pages p JOIN sub s ON p.parent_id = s.id WHERE p.kind = 'doc'
  ) SELECT id, parent_id, title, created_at FROM sub ORDER BY created_at, id LIMIT $2`

type Row = { id: string; parent_id: string | null; title: string; created_at: string }

export function exportRoutes(pool: Pool, getLiveDoc?: (docName: string) => Y.Doc | undefined) {
  const app = new Hono<AuthEnv>()
  app.use('/api/pages/:id/export', requireAuth(pool))

  app.get('/api/pages/:id/export', async (c) => {
    const id = c.req.param('id')
    if (!(await pageAccess(pool, id, c.get('user')))) return c.json({ error: 'page not found' }, 404)
    const rows = (await pool.query<Row>(SELECT_SUBTREE, [id, MAX_PAGES + 1])).rows
    if (rows.length === 0) return c.json({ error: 'page not found' }, 404) // 不是 doc 页（过程页 / skill 页）
    const pages = []
    for (const row of [...rows.filter((r) => r.id === id), ...rows.filter((r) => r.id !== id)].slice(0, MAX_PAGES)) {
      const doc = await loadDocForRead(pool, `page:${row.id}`, getLiveDoc)
      pages.push({
        id: row.id,
        parentId: row.parent_id,
        title: row.title,
        createdAt: row.created_at,
        state: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
      })
    }
    return c.json({ pages, truncated: rows.length > MAX_PAGES })
  })

  return app
}
