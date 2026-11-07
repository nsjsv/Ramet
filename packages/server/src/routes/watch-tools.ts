/* ---------- Genet 盯页面的中心端点（Bearer，注册在 ramet-tools.ts 的 app 上，沿用它的凭证闸门与挂载位置） ----------
 * GET    /api/ramet/watches       → { watches: AutomationView[] }：主人的全部盯页面规则（含在 AI 页上建的）
 * POST   /api/ramet/watches       { page, subtree?, quiet?, instruction? } → { watch }：动作 = 叫 Genet（指令缺省见 DEFAULT_WATCH）
 * DELETE /api/ramet/watches/:id   → { ok, name }：只删盯页面的规则；还排着没发出去的指令一起拿掉
 * 闸门同 timer-tools.ts：只有 Genet 凭证、且绑的是本人的 Genet 页，否则 403；别人的 / 不存在 / 不是盯页面的统一 404；参数不合法 400（人话）。
 * 建好就生效、不弹审批（上限兜住费用）；读到过外来事件、主人还没亲自说话时增删先问（guard，ramet-consent.ts）。写入口同 AI 页（triggers/rules.ts）。 */

import type { Context, Hono } from 'hono'
import type { Pool } from 'pg'
import type * as Y from 'yjs'
import type { AgentNameHost } from '../agents/agent-names.js'
import { createRule, deleteRule, getRule, listRules, type RuleDeps } from '../triggers/rules.js'
import { TIMER_LIMITS, TimerError } from '../triggers/store.js'
import type { Outcome } from './ramet-consent.js'
import type { TimerClock } from './timer-tools.js'

/** Genet 自己盯页面时的缺省指令 */
export const DEFAULT_WATCH = '看看改了什么：值得我知道的简要告诉我；不用管的就标记不用处理'

export type WatchToolDeps = {
  pool: Pool
  /** 同 TimerToolDeps.genet，另带主人的角色（建规则时按他此刻的身份判动作） */
  genet(c: Context): Promise<{ user: { id: string; role: string }; home: string; guard(what: string, run: () => Promise<Outcome>): Promise<Response> } | 401 | 403>
  clock(): TimerClock
  names: AgentNameHost
  getLiveDoc?: (docName: string) => Y.Doc | undefined
}

const FORBIDDEN = '只有 Genet 能盯页面'
const NOT_FOUND = '没有这条盯页面的规则'

async function body(c: Context): Promise<Record<string, unknown>> {
  const raw: unknown = await c.req.json().catch(() => null)
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

/** 「盯《预算》」：标题太长截短，凑进名字的上限 */
function watchName(title: string): string {
  const room = TIMER_LIMITS.name - 3
  const t = [...(title || '无标题')]
  return `盯《${t.length > room ? `${t.slice(0, room - 1).join('')}…` : t.join('')}》`
}

export function watchToolRoutes(app: Hono, deps: WatchToolDeps): void {
  const { pool } = deps
  const rules: RuleDeps = { pool, names: deps.names, ...(deps.getLiveDoc ? { getLiveDoc: deps.getLiveDoc } : {}) }

  async function gate(c: Context) {
    const g = await deps.genet(c)
    if (g === 401) return c.json({ error: 'unauthorized' }, 401)
    if (g === 403) return c.json({ error: FORBIDDEN }, 403)
    return g
  }

  app.get('/api/ramet/watches', async (c) => {
    const g = await gate(c)
    if (g instanceof Response) return g
    return c.json({ watches: (await listRules(rules, g.user.id)).filter((r) => r.source === 'page_watch') })
  })

  app.post('/api/ramet/watches', async (c) => {
    const g = await gate(c)
    if (g instanceof Response) return g
    const input = await body(c)
    const page = typeof input.page === 'string' ? input.page.replace(/^page:/, '') : ''
    // 只取主人看得到的页的标题：看不到的由 createRule 的校验拒掉，名字里不漏标题
    const title =
      (
        await pool.query<{ title: string }>(
          'SELECT p.title FROM live_pages p JOIN space_members m ON m.space_id = p.space_id AND m.user_id = $2 WHERE p.id = $1',
          [page, g.user.id],
        )
      ).rows[0]?.title ?? ''
    const instruction = typeof input.instruction === 'string' && input.instruction.trim() ? input.instruction : DEFAULT_WATCH
    return g.guard(`盯《${title || '无标题'}》`, async () => {
      try {
        const { rule: watch } = await createRule(
          rules,
          g.user,
          { name: watchName(title), source: 'page_watch', config: { page, subtree: input.subtree, quiet: input.quiet }, actions: [{ type: 'genet', instruction }] },
          deps.clock().now(),
        )
        deps.clock().changed()
        return { status: 200, body: { watch } }
      } catch (err) {
        if (err instanceof TimerError) return { status: err.status, body: { error: err.message } }
        throw err
      }
    })
  })

  app.delete('/api/ramet/watches/:id', async (c) => {
    const g = await gate(c)
    if (g instanceof Response) return g
    const id = c.req.param('id')
    const cur = await getRule(rules, g.user.id, id)
    if (!cur || cur.source !== 'page_watch') return c.json({ error: NOT_FOUND }, 404)
    return g.guard(`不再盯「${cur.name}」`, async () => {
      const removed = await deleteRule(pool, g.user.id, id)
      if (!removed) return { status: 404, body: { error: NOT_FOUND } }
      await deps.clock().removed(removed.queued)
      return { status: 200, body: { ok: true, name: removed.name } }
    })
  })
}
