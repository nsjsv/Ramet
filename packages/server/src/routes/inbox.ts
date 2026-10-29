/* ---------- 收件箱 REST（登录用户；聚合与可见性规则见 inbox.ts）----------
 * GET  /api/inbox               → { items }：只含当前用户自己的条目（审批 / 机器接入 / 使用申请 / 首次使用 / 做完待看 / 在跑）
 * POST /api/inbox/seen {pageId} 打开了这个对话页（做完待你看据此消掉）。页面对我不可读 404，不写行
 * POST /api/inbox/dismiss {key} 点知道了。key 形如 first_use:<授权 id>，只认收件箱里本来就给我的那类：格式不对 400，不是我的 404
 * 收件箱只是视图，不带来新权限：条目上的按钮调的是已有接口（permission / connectors approve|reject），判定在那些接口上。
 * 每条路由自带 requireAuth（路径限定），挂载顺序无影响。 */

import { Hono } from 'hono'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv } from '../auth.js'
import { collectInbox, dismissItem, markSeen, type InboxHost } from '../inbox.js'

export function inboxRoutes(pool: Pool, host: InboxHost) {
  const app = new Hono<AuthEnv>()
  const auth = requireAuth(pool)

  app.get('/api/inbox', auth, async (c) => {
    // 现算的视图，不能被缓存
    c.header('cache-control', 'no-store')
    return c.json({ items: await collectInbox(pool, c.get('user'), host) })
  })

  app.post('/api/inbox/seen', auth, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { pageId?: unknown } | null
    if (typeof body?.pageId !== 'string' || !body.pageId) return c.json({ error: 'pageId required' }, 400)
    if (!(await markSeen(pool, c.get('user'), body.pageId))) return c.json({ error: 'page not found' }, 404)
    return c.json({})
  })

  app.post('/api/inbox/dismiss', auth, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { key?: unknown } | null
    if (typeof body?.key !== 'string' || !body.key) return c.json({ error: 'key required' }, 400)
    const result = await dismissItem(pool, c.get('user'), body.key)
    if (result === 'invalid') return c.json({ error: 'invalid key' }, 400)
    if (result === 'not-found') return c.json({ error: 'item not found' }, 404)
    return c.json({})
  })

  return app
}
