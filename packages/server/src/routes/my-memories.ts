/* ---------- 个人记忆的 REST（/ai/memory 的「你的个人记忆」、`/记住`；契约见 personal-memories.ts） ----------
 * GET    /api/me/memories          → { items, chars, limits }：只有本人
 * POST   /api/me/memories {text}   → 201 { memory }；空 400、超限 413（带 message）
 * DELETE /api/me/memories/:mid     → { ok }；不是我的 = 404
 * POST   /api/pages/:id/memories {text} → 201 { memory, target }：`/记住` 用，记到哪由页面定（前端不自己挑）：
 *   页在 Genet 子树里（Genet 页、任务页、过程页）→ 只有那个 Genet 的主人能记，记进他的个人记忆（target = 'personal'）；
 *   别的页 → 页面所在空间的公共记忆（同 /api/spaces/:id/memories 的闸：owner / member，viewer 403），target = { space: 名字 }。
 *   看不到这页 404。
 * 增删后同样经 control:global 广播一个不带内容的 'memories' 信号。每条路由自带 requireAuth，挂载顺序无影响。 */

import { Hono, type Context } from 'hono'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv } from '../auth.js'
import { genetOwnerOf } from '../agents/assistant-agent.js'
import { MEMORY_ITEM_MAX, MEMORY_SPACE_MAX, addMemory, type AddResult } from '../memories.js'
import { pageAccess } from '../page-visibility.js'
import { addPersonalMemory, deletePersonalMemory, listPersonalMemories, personalMemoryChars } from '../personal-memories.js'
import { roleInSpace, writable } from './pages.js'

export type RememberTarget = 'personal' | { space: string }

function failure(c: Context<AuthEnv>, res: Extract<AddResult, { ok: false }>): Response {
  const status = res.reason === 'empty' ? 400 : res.reason === 'no_space' ? 404 : res.reason === 'forbidden' ? 403 : 413
  return c.json({ error: res.reason, message: res.message }, status)
}

export function myMemoryRoutes(pool: Pool, notify?: () => void) {
  const app = new Hono<AuthEnv>()
  const auth = requireAuth(pool)

  app.get('/api/me/memories', auth, async (c) => {
    const me = c.get('user').id
    c.header('cache-control', 'no-store')
    return c.json({
      items: await listPersonalMemories(pool, me),
      chars: await personalMemoryChars(pool, me),
      limits: { item: MEMORY_ITEM_MAX, space: MEMORY_SPACE_MAX },
    })
  })

  app.post('/api/me/memories', auth, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null
    if (typeof body?.text !== 'string') return c.json({ error: 'text required' }, 400)
    const res = await addPersonalMemory(pool, c.get('user').id, body.text, null)
    if (!res.ok) return failure(c, res)
    notify?.()
    return c.json({ memory: res.memory }, 201)
  })

  app.delete('/api/me/memories/:mid', auth, async (c) => {
    if (!(await deletePersonalMemory(pool, c.get('user').id, c.req.param('mid')))) return c.json({ error: 'memory not found' }, 404)
    notify?.()
    return c.json({ ok: true })
  })

  app.post('/api/pages/:id/memories', auth, async (c) => {
    const user = c.get('user')
    const pageId = c.req.param('id')
    if (!(await pageAccess(pool, pageId, user))) return c.json({ error: 'page not found' }, 404)
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null
    if (typeof body?.text !== 'string') return c.json({ error: 'text required' }, 400)
    const owner = await genetOwnerOf(pool, pageId)
    if (owner !== null) {
      if (owner !== user.id) return c.json({ error: 'forbidden', message: '这是别人的 Genet 页，记不到你的个人记忆里' }, 403)
      const res = await addPersonalMemory(pool, user.id, body.text, pageId)
      if (!res.ok) return failure(c, res)
      notify?.()
      return c.json({ memory: res.memory, target: 'personal' satisfies RememberTarget }, 201)
    }
    const space = (await pool.query<{ id: string; name: string }>('SELECT s.id, s.name FROM live_pages p JOIN spaces s ON s.id = p.space_id WHERE p.id = $1', [pageId])).rows[0]
    if (!space) return c.json({ error: 'page not found' }, 404)
    if (!writable(await roleInSpace(pool, user, space.id))) return c.json({ error: 'forbidden', message: '只有这个空间的成员（非只读）能记下记忆' }, 403)
    const res = await addMemory(pool, space.id, body.text, user.id, pageId)
    if (!res.ok) return failure(c, res)
    notify?.()
    return c.json({ memory: res.memory, target: { space: space.name } satisfies RememberTarget }, 201)
  })

  return app
}
