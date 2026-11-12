// ---------- 浏览器推送的库读写（表见 schema.ts）----------
import type { Pool } from 'pg'
import { generateVapidKeys, type VapidKeys } from './webpush.js'

/** 这台服务器的 VAPID 密钥：没有就生成一对（并发启动时只有一对落库，大家读同一行） */
export async function loadVapidKeys(pool: Pool): Promise<VapidKeys> {
  const read = async (): Promise<VapidKeys | null> => {
    const { rows } = await pool.query<{ public_key: string; private_key: string }>('SELECT public_key, private_key FROM push_keys WHERE id = 1')
    const row = rows[0]
    return row ? { publicKey: row.public_key, privateKey: row.private_key } : null
  }
  const have = await read()
  if (have) return have
  const fresh = generateVapidKeys()
  await pool.query('INSERT INTO push_keys (id, public_key, private_key) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING', [fresh.publicKey, fresh.privateKey])
  return (await read()) ?? fresh
}

export type Subscription = { endpoint: string; userId: string; p256dh: string; auth: string; origin: string }

/** 按 endpoint 写入；同一个浏览器换号登录后归新的人，上一个人的推送结局清掉。
 *  返回 true = 这个人第一次有这条订阅（新行或从别人那里转过来），调用方要给他种基线 */
export async function saveSubscription(pool: Pool, sub: Subscription): Promise<boolean> {
  const { rows } = await pool.query<{ prev: string | null }>(
    `WITH prev AS (SELECT user_id FROM push_subscriptions WHERE endpoint = $1)
     INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, origin) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, origin = EXCLUDED.origin,
       ok_at = CASE WHEN push_subscriptions.user_id = EXCLUDED.user_id THEN push_subscriptions.ok_at END,
       failed_at = CASE WHEN push_subscriptions.user_id = EXCLUDED.user_id THEN push_subscriptions.failed_at END,
       last_error = CASE WHEN push_subscriptions.user_id = EXCLUDED.user_id THEN push_subscriptions.last_error END
     RETURNING (SELECT user_id FROM prev) AS prev`,
    [sub.endpoint, sub.userId, sub.p256dh, sub.auth, sub.origin],
  )
  return rows[0]?.prev !== sub.userId
}

/** 只删自己的（别人的 endpoint 当没有） */
export async function deleteSubscription(pool: Pool, userId: string, endpoint: string): Promise<void> {
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, userId])
}

/** 推送服务说这条订阅没了（404 / 410），或密钥坏了 */
export async function dropEndpoint(pool: Pool, endpoint: string): Promise<void> {
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint])
}

export type SubscriptionStatus = { registered: boolean; error: string | null; failedAt: string | null }

/** 设置页看这台设备：不是自己的订阅一律当没注册 */
export async function subscriptionStatus(pool: Pool, userId: string, endpoint: string): Promise<SubscriptionStatus> {
  const { rows } = await pool.query<{ last_error: string | null; failed_at: Date | null }>(
    'SELECT last_error, failed_at FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2',
    [endpoint, userId],
  )
  const row = rows[0]
  if (!row) return { registered: false, error: null, failedAt: null }
  return { registered: true, error: row.last_error, failedAt: row.failed_at?.toISOString() ?? null }
}

const SELECT_SUBS = 'SELECT endpoint, p256dh, auth, origin FROM push_subscriptions WHERE user_id = $1'
type SubRow = { endpoint: string; p256dh: string; auth: string; origin: string }
const toSub = (userId: string, r: SubRow): Subscription => ({ endpoint: r.endpoint, userId, p256dh: r.p256dh, auth: r.auth, origin: r.origin })

export async function subscriptionOf(pool: Pool, userId: string, endpoint: string): Promise<Subscription | null> {
  const { rows } = await pool.query<SubRow>(`${SELECT_SUBS} AND endpoint = $2`, [userId, endpoint])
  return rows[0] ? toSub(userId, rows[0]) : null
}

export async function subscriptionsOf(pool: Pool, userId: string): Promise<Subscription[]> {
  const { rows } = await pool.query<SubRow>(`${SELECT_SUBS} ORDER BY created_at`, [userId])
  return rows.map((r) => toSub(userId, r))
}

/** 有订阅的人（派发只为他们算收件箱） */
export async function subscribers(pool: Pool): Promise<{ id: string; role: string }[]> {
  const { rows } = await pool.query<{ id: string; role: string }>(
    'SELECT DISTINCT u.id, u.role FROM push_subscriptions s JOIN users u ON u.id = s.user_id',
  )
  return rows
}

export async function markDelivered(pool: Pool, endpoint: string): Promise<void> {
  await pool.query('UPDATE push_subscriptions SET ok_at = now(), failed_at = NULL, last_error = NULL WHERE endpoint = $1', [endpoint])
}

export async function markFailed(pool: Pool, endpoint: string, error: string): Promise<void> {
  await pool.query('UPDATE push_subscriptions SET failed_at = now(), last_error = $2 WHERE endpoint = $1', [endpoint, error])
}

/** 记下这些身份，返回其中这次才第一次出现的（并发的两次派发只有一次拿得到同一个身份） */
export async function claimIdents(pool: Pool, userId: string, idents: string[]): Promise<Set<string>> {
  if (idents.length === 0) return new Set()
  const { rows } = await pool.query<{ ident: string }>(
    `INSERT INTO push_sent (user_id, ident) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING RETURNING ident`,
    [userId, idents],
  )
  return new Set(rows.map((r) => r.ident))
}

/** 收件箱里已经没有的身份清掉；留 1 小时余量，免得某一次查询的瞬时抖动让条目「消失又出现」被再通知一遍 */
export async function pruneIdents(pool: Pool, userId: string, keep: string[]): Promise<void> {
  await pool.query(
    `DELETE FROM push_sent WHERE user_id = $1 AND ident <> ALL($2::text[]) AND sent_at < now() - interval '1 hour'`,
    [userId, keep],
  )
}
