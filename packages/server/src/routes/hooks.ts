/* ---------- 收到外部请求：POST /api/hooks/<密钥>（不登录、不看 cookie） ----------
 * 外面的服务（GitHub、告警、IFTTT、脚本）往地址 POST，就触发那条「收到外部请求」的规则（triggers/sources/webhook.ts）。
 * 依次判：不是 POST 405 → 声明的长度超 64 KB 413 → 按密钥的哈希找规则，没有 404、暂停了 409 → 同一个地址限流（20 / 分钟、200 / 小时）429
 * → 读请求体（边读边数，超了 413）→ 落事件并在后台跑动作（hub.background，不等）→ 202 { ok: true }。
 * 事件是外来的（没有触发者）：之后 Genet 动手先问主人。重复投递按 Idempotency-Key / X-GitHub-Delivery / X-Request-Id 只触发一次。
 * 必须挂在 `use('*', requireAuth)` 的子应用之前（index.ts）；csrf.ts 对这个前缀放行：它不碰登录态，跨来源的浏览器请求也收。 */

import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import type { TriggerHub } from '../triggers/hub.js'
import { deliveryId, HOOK_BODY_MAX, hookHash, HookLimiter, hookText } from '../triggers/sources/webhook.js'

export type HookDeps = {
  pool: Pool
  /** 触发器在后面才建好，惰性取 */
  hub: () => Pick<TriggerHub, 'emit' | 'background'>
  limiter?: HookLimiter
}

const TOO_BIG = { error: `请求体最大 ${HOOK_BODY_MAX / 1024} KB` }

/** 内容类型只认标准形状（对方写的，会出现在引用外面） */
function mimeOf(type: string | undefined): string {
  const mime = (type ?? '').split(';')[0]!.trim().toLowerCase()
  if (!mime) return '（没写）'
  return /^[a-z0-9][a-z0-9.+-]{0,40}\/[a-z0-9][a-z0-9.+-]{0,60}$/.test(mime) ? mime : '（认不出）'
}

/** 边读边数：超过 max 就停（取消读取）并返回 null；不先整段读进内存 */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

export function hookRoutes(deps: HookDeps) {
  const { pool } = deps
  const limiter = deps.limiter ?? new HookLimiter()
  const app = new Hono()

  app.all('/api/hooks/:token', async (c) => {
    if (c.req.method !== 'POST') return c.json({ error: '只收 POST' }, 405, { allow: 'POST' })
    const declared = Number(c.req.header('content-length') ?? 0)
    if (declared > HOOK_BODY_MAX) return c.json(TOO_BIG, 413)
    const rule = (
      await pool.query<{ id: string; owner_id: string; enabled: boolean }>(
        "SELECT id, owner_id, enabled FROM agent_triggers WHERE hook_hash = $1 AND source = 'webhook'",
        [hookHash(c.req.param('token'))],
      )
    ).rows[0]
    if (!rule) return c.json({ error: '没有这个地址' }, 404)
    if (!rule.enabled) return c.json({ error: '规则已暂停' }, 409)
    const wait = limiter.take(rule.id, Date.now())
    if (wait > 0) return c.json({ error: '请求太频繁，稍后再试' }, 429, { 'retry-after': String(wait) })
    const bytes = await readCapped(c.req.raw.body, HOOK_BODY_MAX)
    if (!bytes) return c.json(TOO_BIG, 413)
    const type = c.req.header('content-type')
    const delivery = deliveryId((name) => c.req.header(name))
    const hub = deps.hub()
    hub.background(() =>
      hub.emit({
        source: 'webhook',
        key: `webhook:${rule.id}:${delivery ?? randomUUID()}`,
        actorId: null,
        external: true,
        ownerId: rule.owner_id,
        match: (r) => r.id === rule.id,
        payload: {
          text: hookText(type, bytes),
          extra: [['内容类型', mimeOf(type)], ['大小', `${bytes.length} 字节`], ...(delivery ? ([['投递编号', delivery]] as Array<[string, string]>) : [])],
        },
      }),
    )
    return c.json({ ok: true }, 202)
  })

  return app
}
