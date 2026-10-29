// ---------- 收藏 / 反向链接的 REST ----------
// 收藏只有自己可见（GET 只返回自己的、DELETE 只能删自己的），反链按页面可见性过滤。
// 列表 / 反链都只读库（块文字随每次存页面刷新），只有收藏这一下要读一次当前正文来校验块存在、存档（loadDocForRead：内存有活文档就用那份）。

import { Hono } from 'hono'
import type { Pool } from 'pg'
import type * as Y from 'yjs'
import { requireAuth, type AuthEnv } from '../auth.js'
import { loadDocForRead, pageAccess } from '../collab.js'
import { addFavorite, listFavorites, removeFavorite } from '../favorites.js'
import { backlinksOf } from '../page-links.js'

export function favoriteRoutes(pool: Pool, getLiveDoc?: (docName: string) => Y.Doc | undefined) {
  const app = new Hono<AuthEnv>()
  // 只管自己的路径：这个子应用挂在公开路由之后，用 '*' 会把别人的路径也拦成 401
  app.use('/api/favorites', requireAuth(pool))
  app.use('/api/favorites/*', requireAuth(pool))
  app.use('/api/pages/:id/backlinks', requireAuth(pool))

  const readBody = async (pageId: string): Promise<Y.XmlFragment> =>
    (await loadDocForRead(pool, `page:${pageId}`, getLiveDoc)).getXmlFragment('prosemirror')

  app.get('/api/favorites', async (c) => c.json(await listFavorites(pool, c.get('user'))))

  // 收藏 {pageId, blockId?}（缺 blockId 即整页），幂等。目标必须看得见，不存在和没权限同响应 404
  app.post('/api/favorites', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { pageId?: unknown; blockId?: unknown }
    if (typeof body.pageId !== 'string' || !body.pageId) return c.json({ error: 'pageId required' }, 400)
    if (body.blockId !== undefined && body.blockId !== null && typeof body.blockId !== 'string') return c.json({ error: 'blockId must be a string' }, 400)
    const result = await addFavorite(pool, c.get('user'), body.pageId, typeof body.blockId === 'string' ? body.blockId : '', readBody)
    return result.ok ? c.json({ id: result.id }, 201) : c.json({ error: result.error }, result.status)
  })

  app.delete('/api/favorites/:id', async (c) => {
    return (await removeFavorite(pool, c.get('user').id, c.req.param('id'))) ? c.json({}) : c.json({ error: 'favorite not found' }, 404)
  })

  // 哪些页面 / 块引用了本页：目标页必须看得见（非成员与不存在同响应 404）
  app.get('/api/pages/:id/backlinks', async (c) => {
    const id = c.req.param('id')
    if (!(await pageAccess(pool, id, c.get('user')))) return c.json({ error: 'page not found' }, 404)
    return c.json(await backlinksOf(pool, c.get('user'), id))
  })

  return app
}
