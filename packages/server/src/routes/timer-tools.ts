/* ---------- Genet 管定时器的中心端点（Bearer，注册在 ramet-tools.ts 的 app 上，沿用它的凭证闸门与挂载位置） ----------
 * GET    /api/ramet/timers       → { timers, timeZone, now }：目标在这个 Genet 页名下的定时器（now = 用户时区的当地时间）
 * POST   /api/ramet/timers       { name, instruction, schedule, target? } → { timer }
 * PATCH  /api/ramet/timers/:id   { name?, instruction?, schedule?, enabled? } → { timer }
 * DELETE /api/ramet/timers/:id   → { ok, name }：还排着没发出去的指令一起拿掉
 * 只有 Genet 凭证、且凭证绑的是本人的 Genet 页才行（同 dispatch_task 的闸门），否则 403；只看得到 / 改得了自己的、目标在这个 Genet 页名下的，
 * 别人的 / 不存在统一 404；参数不合法 400，原因是人话（Genet 照着改或问用户）。设好就生效，不弹审批：
 * 上限（启用中的个数、间隔、每日次数）兜住费用。只有 Genet 读到过外来事件（别人的评论、外部请求）、主人还没亲自说话时，
 * 增删改先弹审批（guard，ramet-consent.ts）。增删改后让时钟重排、AI 页与收件箱重拉。 */

import type { Context, Hono } from 'hono'
import type { Pool } from 'pg'
import { localStamp } from '../triggers/schedule.js'
import { createTimer, deleteTimer, getTimer, listTimers, TimerError, updateTimer, userTimeZone } from '../triggers/store.js'
import type { Outcome } from './ramet-consent.js'

/** 时钟与「变了」的通知（triggers/hub.ts 的 TriggerHub）；removed = 删掉了，连同它还排着的指令（store.deleteTimer 的 queued） */
export type TimerClock = { now(): Date; changed(): void; removed(queued: readonly string[]): Promise<void> }

export type TimerToolDeps = {
  pool: Pool
  /** Bearer 凭证 → 发起人 + 他的 Genet 页；401 = 没有凭证，403 = 不是 Genet 页上的 Genet 凭证。
   *  guard = 有副作用的改动先过「外来事件之后先问主人」（ramet-consent.ts） */
  genet(c: Context): Promise<{ userId: string; home: string; guard(what: string, run: () => Promise<Outcome>): Promise<Response> } | 401 | 403>
  clock(): TimerClock
}

const FORBIDDEN = '只有 Genet 能管定时器'

async function body(c: Context): Promise<Record<string, unknown>> {
  const raw: unknown = await c.req.json().catch(() => null)
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

/** 增删改的结果：TimerError 是给 Genet 的人话原因，别的照常抛 */
async function attempt(run: () => Promise<Record<string, unknown>>): Promise<Outcome> {
  try {
    return { status: 200, body: await run() }
  } catch (err) {
    if (err instanceof TimerError) return { status: err.status, body: { error: err.message } }
    throw err
  }
}

export function timerToolRoutes(app: Hono, deps: TimerToolDeps): void {
  const { pool } = deps

  async function gate(c: Context): Promise<{ ownerId: string; home: string; guard: (what: string, run: () => Promise<Outcome>) => Promise<Response> } | Response> {
    const g = await deps.genet(c)
    if (g === 401) return c.json({ error: 'unauthorized' }, 401)
    if (g === 403) return c.json({ error: FORBIDDEN }, 403)
    return { ownerId: g.userId, home: g.home, guard: g.guard }
  }

  app.get('/api/ramet/timers', async (c) => {
    const scope = await gate(c)
    if (scope instanceof Response) return scope
    const tz = await userTimeZone(pool, scope.ownerId)
    return c.json({ timers: await listTimers(pool, scope), timeZone: tz, now: localStamp(deps.clock().now(), tz) })
  })

  app.post('/api/ramet/timers', async (c) => {
    const scope = await gate(c)
    if (scope instanceof Response) return scope
    const input = await body(c)
    return scope.guard(`设定时器「${typeof input.name === 'string' ? input.name : ''}」`, () =>
      attempt(async () => {
        const timer = await createTimer(pool, scope, input, deps.clock().now())
        deps.clock().changed()
        return { timer }
      }),
    )
  })

  app.patch('/api/ramet/timers/:id', async (c) => {
    const scope = await gate(c)
    if (scope instanceof Response) return scope
    const id = c.req.param('id')
    const cur = await getTimer(pool, scope, id)
    if (!cur) return c.json({ error: '没有这个定时器' }, 404)
    const patch = await body(c)
    return scope.guard(`改定时器「${cur.name}」`, () =>
      attempt(async () => {
        const timer = await updateTimer(pool, scope, id, patch, deps.clock().now())
        deps.clock().changed()
        return { timer }
      }),
    )
  })

  app.delete('/api/ramet/timers/:id', async (c) => {
    const scope = await gate(c)
    if (scope instanceof Response) return scope
    const id = c.req.param('id')
    const cur = await getTimer(pool, scope, id)
    if (!cur) return c.json({ error: '没有这个定时器' }, 404)
    return scope.guard(`删掉定时器「${cur.name}」`, async () => {
      const removed = await deleteTimer(pool, scope, id)
      if (!removed) return { status: 404, body: { error: '没有这个定时器' } }
      await deps.clock().removed(removed.queued)
      return { status: 200, body: { ok: true, name: removed.name } }
    })
  })
}
