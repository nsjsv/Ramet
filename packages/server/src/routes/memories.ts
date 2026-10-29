/* ---------- 空间公共记忆的 REST（记忆面板与输入卡 `/记住` 用，契约见 memories.ts）----------
 * GET    /api/spaces/:id/memories        → { items, chars, limits }：空间任意成员（含 viewer）可读；非成员 / 不存在同响应 404
 * POST   /api/spaces/:id/memories {text} → 201 { memory }：owner / member 可写，viewer 403；空 400、超限 413（带 message）
 * DELETE /api/spaces/:id/memories/:mid   → { ok }：owner / member；记忆必须属于这个空间，否则 404（跨空间的 id 当不存在）
 * 增删后经 control:global 广播一个不带内容的 'memories' 信号，在线端据此重拉。
 * 每条路由自带 requireAuth（路径限定），挂载顺序无影响。 */

import { Hono, type Context } from 'hono'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv } from '../auth.js'
import { MEMORY_ITEM_MAX, MEMORY_SPACE_MAX, addMemory, deleteMemory, listMemories, memoryChars } from '../memories.js'
import { writable } from './pages.js'

export function memoryRoutes(pool: Pool, notify?: () => void) {
  const app = new Hono<AuthEnv>()
  const auth = requireAuth(pool)

  /** 空间闸门：必须是成员（不是则 404，与空间不存在同响应），需要写时还要有写权（viewer 403）。
   *  只认成员行（全局 admin 也一样）：记忆会进这个空间里每一轮 agent（包括跑在别人机器上的），
   *  不是成员的人不能往里写，也不该读到 */
  async function gate(c: Context<AuthEnv>, needWrite: boolean): Promise<Response | null> {
    const { rows } = await pool.query<{ role: 'owner' | 'member' | 'viewer' }>(
      'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
      [c.req.param('id') ?? '', c.get('user').id],
    )
    const role = rows[0]?.role ?? null
    if (role === null) return c.json({ error: 'space not found' }, 404)
    if (needWrite && !writable(role)) return c.json({ error: 'forbidden' }, 403)
    return null
  }

  app.get('/api/spaces/:id/memories', auth, async (c) => {
    const denied = await gate(c, false)
    if (denied) return denied
    const spaceId = c.req.param('id')
    c.header('cache-control', 'no-store')
    const items = await listMemories(pool, spaceId)
    return c.json({ items, chars: await memoryChars(pool, spaceId), limits: { item: MEMORY_ITEM_MAX, space: MEMORY_SPACE_MAX } })
  })

  app.post('/api/spaces/:id/memories', auth, async (c) => {
    const denied = await gate(c, true)
    if (denied) return denied
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null
    if (typeof body?.text !== 'string') return c.json({ error: 'text required' }, 400)
    const res = await addMemory(pool, c.req.param('id'), body.text, c.get('user').id, null)
    if (!res.ok) return c.json({ error: res.reason, message: res.message }, res.reason === 'empty' ? 400 : res.reason === 'no_space' ? 404 : res.reason === 'forbidden' ? 403 : 413)
    notify?.()
    return c.json({ memory: res.memory }, 201)
  })

  app.delete('/api/spaces/:id/memories/:mid', auth, async (c) => {
    const denied = await gate(c, true)
    if (denied) return denied
    if (!(await deleteMemory(pool, c.req.param('id'), c.req.param('mid')))) return c.json({ error: 'memory not found' }, 404)
    notify?.()
    return c.json({ ok: true })
  })

  return app
}
