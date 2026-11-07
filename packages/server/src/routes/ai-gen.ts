/* ---------- AI 块与 AI 属性：页面上点「生成」/ 属性设置里点「填充」 ----------
 * POST /api/pages/:id/ai-gen/:blockId → 202 { ok }：判过（看不到 404、只读 403、块不在 404、提示词空 400、没模型连接 / 正在生成 409）
 *   就在后台生成，状态写在节点上（ai-gen.ts）。
 * POST /api/collections/:id/ai-props/:propId/fill { scope: 'empty' | 'all' } → 202 { count }：判过（合集看不到 404、只读 403、
 *   不是 AI 属性 404、要求空 400、没模型连接 / 这一列正在填 409）就在后台逐行填（ai-prop.ts）。
 * 每条路由自带 requireAuth（路径限定），挂载序无影响。 */

import { Hono } from 'hono'
import { requireAuth, type AuthEnv } from '../auth.js'
import { AiGenError, startAiGen, type AiGenDeps } from '../ai-gen.js'
import { AiPropError, startFill, type AiPropDeps } from '../ai-prop.js'

export function aiGenRoutes(deps: AiGenDeps & AiPropDeps & { background: (work: () => Promise<unknown>) => void }) {
  const app = new Hono<AuthEnv>()
  app.post('/api/pages/:id/ai-gen/:blockId', requireAuth(deps.pool), async (c) => {
    try {
      await startAiGen(deps, c.get('user'), c.req.param('id'), c.req.param('blockId'), deps.background)
      return c.json({ ok: true }, 202)
    } catch (err) {
      if (err instanceof AiGenError) return c.json({ error: err.message }, err.status)
      throw err
    }
  })
  app.post('/api/collections/:id/ai-props/:propId/fill', requireAuth(deps.pool), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { scope?: unknown }
    try {
      const count = await startFill(deps, c.get('user'), c.req.param('id'), c.req.param('propId'), body.scope === 'all' ? 'all' : 'empty', deps.background)
      return c.json({ ok: true, count }, 202)
    } catch (err) {
      if (err instanceof AiPropError) return c.json({ error: err.message }, err.status)
      throw err
    }
  })
  return app
}
