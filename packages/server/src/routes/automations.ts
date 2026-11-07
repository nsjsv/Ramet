/* ---------- 规则（自动化）的网页端 REST（登录用户；AI 页「自动」分页） ----------
 * GET    /api/me/automations            → { automations: AutomationView[], timeZone }：自己的全部（含 Genet 设的定时器），内置的两条在最前、其余新的在前
 * POST   /api/me/automations            { name, source, config, actions, scopePage? } → 201 { automation, hookPath? }
 *                                        （能建的来源：timer / page_watch / webhook；hookPath = 收到外部请求的地址，只给这一次）
 * POST   /api/me/automations/:id/hook   → { automation, hookPath }：收到外部请求的规则换地址，旧地址立刻失效
 * POST   /api/automations/:id/press     { page, row? } → { ok, name }：点按钮（能编辑那一页的人都能点，不只主人；triggers/sources/button.ts）
 * PATCH  /api/me/automations/:id        { name?, config?, actions?, enabled? } → { automation }；不是自己的 404
 * DELETE /api/me/automations/:id        → { ok }；还排着没发出去的指令一起拿掉；内置规则（评论找我 / 正文 @我）400，只能关
 * GET    /api/pages/:id/automations     → { automations }：挂在这一页上的规则（这一页的编辑者看得到，只读）；看不到 / 只读 404
 * 校验不过 400，原因是人话（表单照着显示）。写入口在 triggers/rules.ts；增删改后让时钟重排、AI 页与收件箱重拉（'inbox' 信号）。
 * /api/me/timers*（timers.ts）是给老页面的别名，读写的是同一批规则。每条路由自带 requireAuth（路径限定），挂载序无影响。 */

import { Hono, type Context } from 'hono'
import type { Pool } from 'pg'
import type * as Y from 'yjs'
import { requireAuth, type AuthEnv } from '../auth.js'
import type { AgentNameHost } from '../agents/agent-names.js'
import { createRule, deleteRule, listRules, listScoped, rotateHook, updateRule, type RuleDeps } from '../triggers/rules.js'
import type { TriggerHub } from '../triggers/hub.js'
import { pressButton } from '../triggers/sources/button.js'
import { TimerError, userTimeZone } from '../triggers/store.js'
import type { TimerClock } from './timer-tools.js'

export type AutomationRouteDeps = {
  pool: Pool
  clock: TimerClock
  names: AgentNameHost
  getLiveDoc?: (docName: string) => Y.Doc | undefined
  /** 点按钮要触发事件；不给 = 按钮点不了（503） */
  hub?: Pick<TriggerHub, 'emit' | 'background'>
}

async function body(c: Context): Promise<Record<string, unknown>> {
  const raw: unknown = await c.req.json().catch(() => null)
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

export function automationRoutes(deps: AutomationRouteDeps) {
  const { pool, clock } = deps
  const app = new Hono<AuthEnv>()
  const auth = requireAuth(pool)
  const rules: RuleDeps = { pool, names: deps.names, ...(deps.getLiveDoc ? { getLiveDoc: deps.getLiveDoc } : {}) }

  const failed = (c: Context<AuthEnv>, err: unknown): Response => {
    if (err instanceof TimerError) return c.json({ error: err.message }, err.status)
    throw err
  }

  app.get('/api/me/automations', auth, async (c) => {
    c.header('cache-control', 'no-store')
    const user = c.get('user')
    return c.json({ automations: await listRules(rules, user.id), timeZone: await userTimeZone(pool, user.id) })
  })

  app.post('/api/me/automations', auth, async (c) => {
    try {
      const { rule: automation, hookPath } = await createRule(rules, c.get('user'), await body(c), clock.now())
      clock.changed()
      return c.json({ automation, ...(hookPath ? { hookPath } : {}) }, 201)
    } catch (err) {
      return failed(c, err)
    }
  })

  app.patch('/api/me/automations/:id', auth, async (c) => {
    try {
      const automation = await updateRule(rules, c.get('user'), c.req.param('id'), await body(c), clock.now())
      clock.changed()
      return c.json({ automation })
    } catch (err) {
      return failed(c, err)
    }
  })

  app.post('/api/me/automations/:id/hook', auth, async (c) => {
    try {
      const out = await rotateHook(rules, c.get('user').id, c.req.param('id'))
      if (!out) return c.json({ error: '没有这条规则' }, 404)
      clock.changed()
      return c.json({ automation: out.rule, hookPath: out.hookPath })
    } catch (err) {
      return failed(c, err)
    }
  })

  app.delete('/api/me/automations/:id', auth, async (c) => {
    try {
      const removed = await deleteRule(pool, c.get('user').id, c.req.param('id'))
      if (!removed) return c.json({ error: '没有这条规则' }, 404)
      await clock.removed(removed.queued)
      return c.json({ ok: true })
    } catch (err) {
      return failed(c, err)
    }
  })

  app.post('/api/automations/:id/press', auth, async (c) => {
    if (!deps.hub) return c.json({ error: '按钮暂时用不了' }, 503)
    const out = await pressButton({ pool, hub: deps.hub, ...(deps.getLiveDoc ? { getLiveDoc: deps.getLiveDoc } : {}) }, c.get('user'), c.req.param('id'), await body(c))
    return out.status === 200 ? c.json({ ok: true, name: out.name }) : c.json({ error: out.error }, out.status)
  })

  app.get('/api/pages/:id/automations', auth, async (c) => {
    c.header('cache-control', 'no-store')
    const list = await listScoped(rules, c.get('user'), c.req.param('id'))
    if (!list) return c.json({ error: 'page not found' }, 404)
    return c.json({ automations: list })
  })

  return app
}
