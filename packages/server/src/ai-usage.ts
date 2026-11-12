// ---------- AI 使用量：记账与汇总（流水表见 ai-usage-schema.ts） ----------
// 记账（recordUsage）是唯一写入口，尽力而为：失败只记日志，不影响调用本身。记账点：
//   Genet / 空间 AI 一轮结束（drivers/assistant/driver.ts，含停止 / 出错时已经花掉的部分）、⌘J 站点通道一次（routes/quick.ts）、
//   AI 块 / AI 属性生成一次（ai-gen.ts 的 generateText）。
// 汇总只给两种人看：自己连接花了多少（payer = 我，含别人叫我当 owner 的空间 AI）；空间 owner 看这个空间的空间 AI 按成员分。
// 「一天」按看的人的时区切（users.time_zone，没上报过用服务器时区），窗口是含今天在内的最近 N 天，每天都有一行（没用就是 0）。

import type { Pool } from 'pg'

export const USAGE_SOURCES = ['genet', 'space_ai', 'quick', 'ai_gen', 'ai_prop'] as const
export type UsageSource = (typeof USAGE_SOURCES)[number]

export type UsageRecord = {
  payerId: string
  actorId: string | null
  spaceId?: string | null
  source: UsageSource
  model: string
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** 各家用量的共同形状（pi-ai 的 AssistantMessage.usage 就是它的超集） */
export type ModelUsage = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** 一次调用的用量是不是全 0（上游没报，或还没开始就失败了）：全 0 不记 */
export function emptyUsage(u: ModelUsage): boolean {
  return !u.input && !u.output && !u.cacheRead && !u.cacheWrite
}

const INSERT = `INSERT INTO ai_usage (payer_id, actor_id, space_id, source, model, requests, input, output, cache_read, cache_write)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`

/** 记一行。token 全 0 不记；写失败只记日志 */
export async function recordUsage(pool: Pick<Pool, 'query'>, r: UsageRecord): Promise<void> {
  if (r.requests <= 0 || emptyUsage(r)) return
  const n = (v: number): number => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0)
  await pool
    .query(INSERT, [r.payerId, r.actorId, r.spaceId ?? null, r.source, r.model, n(r.requests), n(r.input), n(r.output), n(r.cacheRead), n(r.cacheWrite)])
    .catch((err: unknown) => console.error(`[ai-usage] 记账失败：${err instanceof Error ? err.message : String(err)}`))
}

// ---------- 汇总 ----------

export type UsageSums = { calls: number; requests: number; input: number; output: number; cacheRead: number; cacheWrite: number }
export type UsageReport = {
  days: number
  timeZone: string
  totals: UsageSums
  byDay: Array<{ day: string } & UsageSums>
}
export type MyUsage = UsageReport & {
  bySource: Array<{ source: UsageSource } & UsageSums>
  byModel: Array<{ model: string } & UsageSums>
}
export type SpaceAiUsage = UsageReport & { byMember: Array<{ userId: string | null; name: string } & UsageSums> }

export const USAGE_DAYS_DEFAULT = 30
export const USAGE_DAYS_MAX = 90

/** ?days= 的取值：1–90 的整数，别的按缺省 30 */
export function usageDays(raw: string | undefined): number {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= USAGE_DAYS_MAX ? n : USAGE_DAYS_DEFAULT
}

// sum(bigint) 是 numeric，pg 驱动给字符串：一律转 float8 再交出去
const SUMS = `count(u.at)::int AS calls, coalesce(sum(u.requests), 0)::float8 AS requests,
  coalesce(sum(u.input), 0)::float8 AS input, coalesce(sum(u.output), 0)::float8 AS output,
  coalesce(sum(u.cache_read), 0)::float8 AS cache_read, coalesce(sum(u.cache_write), 0)::float8 AS cache_write`

type SumsRow = { calls: number; requests: number; input: number; output: number; cache_read: number; cache_write: number }

function sums(r: SumsRow): UsageSums {
  return { calls: r.calls, requests: r.requests, input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_write }
}

/** 窗口里的流水（$1 = 时区、$2 = 天数，过滤条件从 $3 起）：今天在内的最近 N 天，按那个时区的零点切 */
function windowed(filter: string): string {
  return `WITH bounds AS (SELECT (now() AT TIME ZONE $1)::date AS today),
    u AS (SELECT a.*, (a.at AT TIME ZONE $1)::date AS day FROM ai_usage a
      WHERE ${filter} AND a.at >= (((SELECT today FROM bounds) - ($2::int - 1))::timestamp AT TIME ZONE $1))`
}

function byDayQuery(filter: string): string {
  return `${windowed(filter)},
    d AS (SELECT generate_series((SELECT today FROM bounds) - ($2::int - 1), (SELECT today FROM bounds), interval '1 day')::date AS day)
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day, ${SUMS} FROM d LEFT JOIN u ON u.day = d.day GROUP BY d.day ORDER BY d.day`
}

/** 按 key 分组，用得多的在前 */
function groupQuery(filter: string, key: string): string {
  return `${windowed(filter)} SELECT ${key} AS key, ${SUMS} FROM u GROUP BY ${key} ORDER BY sum(u.input + u.output) DESC, ${key}`
}

async function report(pool: Pick<Pool, 'query'>, filter: string, params: unknown[], days: number, timeZone: string): Promise<UsageReport> {
  const args = [timeZone, days, ...params]
  const [totals, byDay] = await Promise.all([
    pool.query<SumsRow>(`${windowed(filter)} SELECT ${SUMS} FROM u`, args),
    pool.query<SumsRow & { day: string }>(byDayQuery(filter), args),
  ])
  return { days, timeZone, totals: sums(totals.rows[0]!), byDay: byDay.rows.map((r) => ({ day: r.day, ...sums(r) })) }
}

/** 我的连接花了多少（含我当 owner 的空间 AI 被成员叫的那部分） */
export async function myUsage(pool: Pick<Pool, 'query'>, userId: string, days: number, timeZone: string): Promise<MyUsage> {
  const filter = 'a.payer_id = $3'
  const args = [timeZone, days, userId]
  const [base, bySource, byModel] = await Promise.all([
    report(pool, filter, [userId], days, timeZone),
    pool.query<SumsRow & { key: UsageSource }>(groupQuery(filter, 'u.source'), args),
    pool.query<SumsRow & { key: string }>(groupQuery(filter, 'u.model'), args),
  ])
  return {
    ...base,
    bySource: bySource.rows.map((r) => ({ source: r.key, ...sums(r) })),
    byModel: byModel.rows.map((r) => ({ model: r.key, ...sums(r) })),
  }
}

/** 这个空间的空间 AI 花了多少，按叫它的成员分（删了号的成员名字写「已注销用户」） */
export async function spaceAiUsage(pool: Pick<Pool, 'query'>, spaceId: string, days: number, timeZone: string): Promise<SpaceAiUsage> {
  const filter = `a.space_id = $3 AND a.source = 'space_ai'`
  const args = [timeZone, days, spaceId]
  const [base, members] = await Promise.all([
    report(pool, filter, [spaceId], days, timeZone),
    pool.query<SumsRow & { key: string | null; username: string | null }>(
      `${windowed(filter)} SELECT u.actor_id AS key, max(us.username) AS username, ${SUMS}
        FROM u LEFT JOIN users us ON us.id = u.actor_id GROUP BY u.actor_id ORDER BY sum(u.input + u.output) DESC, u.actor_id`,
      args,
    ),
  ])
  return { ...base, byMember: members.rows.map((r) => ({ userId: r.key, name: r.username ?? '已注销用户', ...sums(r) })) }
}
