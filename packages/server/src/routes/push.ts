/* ---------- 浏览器推送 REST（登录用户；派发见 push/dispatch.ts）----------
 * GET  /api/push/key            → { publicKey }：VAPID 公钥，浏览器订阅时要
 * POST /api/push/subscriptions  { endpoint, keys: { p256dh, auth } }：登记这台设备。地址不在推送服务清单里 / 密钥不对 400
 * POST /api/push/unsubscribe    { endpoint }：注销（只删自己的，没有也 200）
 * POST /api/push/status         { endpoint } → { registered, error, failedAt }：这台设备推送通不通
 * POST /api/push/test           { endpoint } → { ok } | { ok: false, error }：立刻给这台设备发一条测试通知（不看人在不在跟前）
 * endpoint 很长，一律放 body，不进查询串。每条路由自带 requireAuth（路径限定），挂载顺序无影响。 */

import { Hono } from 'hono'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv } from '../auth.js'
import type { PushDispatcher } from '../push/dispatch.js'
import { deleteSubscription, loadVapidKeys, saveSubscription, subscriptionOf, subscriptionStatus } from '../push/store.js'
import { checkEndpoint, encryptPayload, pushHostsFromEnv } from '../push/webpush.js'

const KEY_MAX = 200

const endpointOf = async (c: { req: { json: () => Promise<unknown> } }): Promise<string | null> => {
  const body = (await c.req.json().catch(() => null)) as { endpoint?: unknown } | null
  return typeof body?.endpoint === 'string' && body.endpoint ? body.endpoint : null
}

/** 订阅时页面的源（VAPID 的 sub 用）：浏览器的 Origin 头，缺了用 RAMET_PUBLIC_URL */
function originOf(header: string | undefined): string {
  const raw = header || process.env.RAMET_PUBLIC_URL || ''
  try {
    return new URL(raw).origin
  } catch {
    return ''
  }
}

export function pushRoutes(pool: Pool, dispatcher: () => PushDispatcher, hosts: readonly string[] = pushHostsFromEnv()) {
  const app = new Hono<AuthEnv>()
  const auth = requireAuth(pool)

  app.get('/api/push/key', auth, async (c) => c.json({ publicKey: (await loadVapidKeys(pool)).publicKey }))

  app.post('/api/push/subscriptions', auth, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null
    const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : ''
    const p256dh = typeof body?.keys?.p256dh === 'string' ? body.keys.p256dh : ''
    const authKey = typeof body?.keys?.auth === 'string' ? body.keys.auth : ''
    if (!checkEndpoint(endpoint, hosts)) return c.json({ error: '这个浏览器的推送服务不在允许的清单里' }, 400)
    if (!p256dh || !authKey || p256dh.length > KEY_MAX || authKey.length > KEY_MAX) return c.json({ error: 'invalid keys' }, 400)
    try {
      // 试加密一次：公钥不在曲线上、长度不对的订阅永远发不出去，当场拒掉
      encryptPayload(Buffer.from('{}'), { p256dh, auth: authKey })
    } catch {
      return c.json({ error: 'invalid keys' }, 400)
    }
    const user = c.get('user')
    const first = await saveSubscription(pool, { endpoint, userId: user.id, p256dh, auth: authKey, origin: originOf(c.req.header('origin')) })
    // 开启前就在收件箱里的条目不补发
    if (first) await dispatcher().seed(user)
    return c.json({})
  })

  app.post('/api/push/unsubscribe', auth, async (c) => {
    const endpoint = await endpointOf(c)
    if (!endpoint) return c.json({ error: 'endpoint required' }, 400)
    await deleteSubscription(pool, c.get('user').id, endpoint)
    return c.json({})
  })

  app.post('/api/push/status', auth, async (c) => {
    const endpoint = await endpointOf(c)
    if (!endpoint) return c.json({ error: 'endpoint required' }, 400)
    c.header('cache-control', 'no-store')
    return c.json(await subscriptionStatus(pool, c.get('user').id, endpoint))
  })

  app.post('/api/push/test', auth, async (c) => {
    const endpoint = await endpointOf(c)
    if (!endpoint) return c.json({ error: 'endpoint required' }, 400)
    const sub = await subscriptionOf(pool, c.get('user').id, endpoint)
    if (!sub) return c.json({ ok: false, error: '这台设备还没登记，请重新开启通知' })
    const res = await dispatcher().deliver(sub, {
      title: 'Ramet 测试通知',
      body: '能看到这条，说明这台设备能收到通知',
      url: '/inbox',
      tag: 'ramet:test',
      urgent: false,
    })
    return c.json(res.ok ? { ok: true } : { ok: false, error: res.error })
  })

  return app
}
