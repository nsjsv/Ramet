// ---------- 网页书签元信息（登录用户）----------
// GET /api/link-preview?url=<http(s) 绝对地址>  → 200 { url, title?, description?, image?, icon?, site? }
// 抓不到也是 200 { url }（前端只显示链接）；地址形状不对 400。抓取与缓存在 link-preview.ts。
// 匿名访客看公开页走 /api/public/pages/:id/link-preview（routes/public.ts，只抓该页里真有的书签地址）。
// 路由级 requireAuth：本子应用挂在哪都不会拦别人的请求。

import { Hono } from 'hono'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv } from '../auth.js'
import { bookmarkUrl, type LinkMeta, type LinkPreview } from '../link-preview.js'

/** 浏览器私有缓存：拿到了元信息存一小时（来回切页不重复请求）；只有地址（没抓到）只存十分钟，
 * 与服务端失败缓存同长，站点恢复 / 换了抓取通道后不至于一小时都看不到内容 */
export function linkPreviewCache(meta: LinkMeta): string {
  return Object.keys(meta).length > 1 ? 'private, max-age=3600' : 'private, max-age=600'
}

export function linkPreviewRoutes(pool: Pool, preview: LinkPreview) {
  const app = new Hono<AuthEnv>()
  app.get('/api/link-preview', requireAuth(pool), async (c) => {
    const url = bookmarkUrl(c.req.query('url'))
    if (!url) return c.json({ error: 'url must be an http(s) url' }, 400)
    const meta = await preview.get(url)
    c.header('cache-control', linkPreviewCache(meta))
    return c.json(meta)
  })
  return app
}
