/* ---------- 块文本端点（块链接提及取快照用） ----------
 * GET /api/pages/:pageId/blocks/:blockId → { text }：读源块文本快照，前端插成 block_ref 行内 chip
 * （文本是插入时刻的快照，不实时跟随，实时跟随走 block_sync 同步块）。
 * 权限走 collab.pageAccess（与 pages.ts 同源）：同空间成员任意角色可读，viewer 也行；
 * 非成员 / 页面不存在一律 404，不泄露存在性。 */

import { Hono } from 'hono'
import * as Y from 'yjs'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv } from '../auth.js'
import { loadDocFromDb, pageAccess } from '../collab.js'
// 文本抽取口径只在 updates.ts 定义（摘要 diff、块提及、搜索索引共用）
import { textOf } from '../updates.js'
import { findBlockElement } from '../block-ids.js'

/** 正文里 id 命中的块（任意深度，列表项也可链接）的文本快照。找不到返回 null，空段落等空内容块返回空串（算命中） */
export function blockText(fragment: Y.XmlFragment, blockId: string): string | null {
  const el = findBlockElement(fragment, blockId)
  return el ? textOf(el) : null
}

// getLiveDoc 查内存里的活文档（与 pages / public 路由同语义，测试可不传，走 DB 重建）。
// 块 id 常是刚由前端补 id 插件写入、还没压缩进快照的，活文档优先才能保证复制链接后立即在他端提及也能命中
export function blocksRoutes(pool: Pool, getLiveDoc?: (docName: string) => Y.Doc | undefined) {
  // 这个子应用只有块相关路由，鉴权统一挂全量，未登录一律 401
  const app = new Hono<AuthEnv>()
  app.use('*', requireAuth(pool))

  app.get('/api/pages/:pageId/blocks/:blockId', async (c) => {
    const user = c.get('user')
    const pageId = c.req.param('pageId')
    const blockId = c.req.param('blockId')
    const role = await pageAccess(pool, pageId, user)
    if (!role) return c.json({ error: 'page not found' }, 404)
    const docName = `page:${pageId}`
    const doc = getLiveDoc?.(docName) ?? (await loadDocFromDb(pool, docName))
    const text = blockText(doc.getXmlFragment('prosemirror'), blockId)
    if (text === null) return c.json({ error: 'block not found' }, 404)
    return c.json({ text })
  })

  return app
}
