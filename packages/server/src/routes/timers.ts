/* ---------- 定时器的网页端 REST（登录用户；时区上报 + 老「定时」分页的接口，规则的完整增删改在 automations.ts） ----------
 * PUT    /api/me/time-zone {timeZone}   浏览器的 IANA 时区；认不出 400。之后新建 / 改时间表的定时器按它算
 * GET    /api/me/timers                 → { timers: TimerView[] }：只有自己的，新的在前
 * PATCH  /api/me/timers/:id {enabled}   只收 enabled（新建 / 改时间表都经 Genet）；不是自己的 404
 * DELETE /api/me/timers/:id             不是自己的 404；还排着没发出去的指令一起拿掉
 * 每条路由自带 requireAuth（路径限定，不用 '*'），挂载序无影响。写入口与 Genet 端点同一份（triggers/store.ts）。 */

import { Hono } from 'hono'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv } from '../auth.js'
import { deleteTimer, listTimers, setUserTimeZone, TimerError, updateTimer } from '../triggers/store.js'
import type { TimerClock } from './timer-tools.js'

export function timerRoutes(pool: Pool, clock: TimerClock) {
  const app = new Hono<AuthEnv>()
  const auth = requireAuth(pool)

  app.put('/api/me/time-zone', auth, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { timeZone?: unknown } | null
    try {
      return c.json({ timeZone: await setUserTimeZone(pool, c.get('user').id, raw?.timeZone) })
    } catch (err) {
      if (err instanceof TimerError) return c.json({ error: err.message }, err.status)
      throw err
    }
  })

  app.get('/api/me/timers', auth, async (c) => {
    c.header('cache-control', 'no-store')
    return c.json({ timers: await listTimers(pool, { ownerId: c.get('user').id }) })
  })

  app.patch('/api/me/timers/:id', auth, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (typeof raw?.enabled !== 'boolean' || Object.keys(raw).some((k) => k !== 'enabled')) {
      return c.json({ error: '这里只能开关定时器（enabled: true / false）；改时间表请跟 Genet 说' }, 400)
    }
    try {
      const timer = await updateTimer(pool, { ownerId: c.get('user').id }, c.req.param('id'), { enabled: raw.enabled }, clock.now())
      clock.changed()
      return c.json({ timer })
    } catch (err) {
      if (err instanceof TimerError) return c.json({ error: err.message }, err.status)
      throw err
    }
  })

  app.delete('/api/me/timers/:id', auth, async (c) => {
    const removed = await deleteTimer(pool, { ownerId: c.get('user').id }, c.req.param('id'))
    if (!removed) return c.json({ error: '没有这个定时器' }, 404)
    await clock.removed(removed.queued)
    return c.json({ ok: true })
  })

  return app
}
