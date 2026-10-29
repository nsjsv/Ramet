/* 页面列表的增量同步
 *
 * 收到 control:global 的 changed 后，客户端带上次的游标来取从那以后变过的页，不再整表重拉。
 * 变更的唯一采集点是 pages 上的触发器（db.ts 的 page_changes_log）：写路径几十处，一处都不挂回调。
 *
 * 游标 = 读取时快照的 xmin（pg_snapshot_xmin(pg_current_snapshot())），下次取 xid >= 它的日志。为什么不漏：
 *   - 本次读取在一个 REPEATABLE READ 事务里，日志、页面现状、游标都出自同一个快照 S。
 *   - xid < xmin(S) 的事务在取得 S 时都已结束，它的页面改动与日志行 S 都看得见，本次已按现状下发（或更早的同步已下发过）。
 *   - S 看不见的事务（取快照时还在跑、或之后才拿到 xid）xid 必然 >= xmin(S)，下次「xid >= 游标」一定取到。
 *   所以序号先分配、后提交不会漏；代价是长事务期间同几条会重复下发，响应按页面现状算，重复无害。
 *
 * 不泄露：只取日志 space_id 属于我所在空间的行，别的空间的页面 id 不会出现在 up / rm 里。
 * 成员关系（加入 / 退出空间、空间被删）不走日志：响应带成员指纹，客户端带回来对不上就整表。 */

import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { apiPageColumns, toApiPage, type ApiPage } from './page-icon.js'

// 页面列表（整表）：所有人（含 admin）只看自己是成员的空间里的页面，@ 候选、侧栏、搜索都吃这份列表。
// JOIN 打不上的行（space_id NULL 的孤儿页）天然被排除。
// 排序：position（侧栏拖拽排序，小数可插中间）优先，NULLS LAST 兜底 created_at（后建页排最后），
// 客户端合并增量后按同一口径重排（@ramet/shared/page-tree 的 comparePages）。两个文本列按 COLLATE "C"（逐字节）比：
// 库的默认排序规则（en_US 等）比较时忽略标点，整秒的 created_at（没有小数部分）与同一秒带小数的会和 JS 的码元比较排反。
// 只取对外字段（page-icon.ts 的 API_PAGE_FIELDS），不为列表读全文
export const SELECT_ALL_MINE = `SELECT ${apiPageColumns('p')} FROM live_pages p
  JOIN space_members m ON m.space_id = p.space_id AND m.user_id = $1
  ORDER BY p.position ASC NULLS LAST, p.created_at COLLATE "C", p.id COLLATE "C"`
// 增量里的现状：同一可见口径，只查日志里出现过的 id
const SELECT_MINE_BY_IDS = `SELECT ${apiPageColumns('p')} FROM live_pages p
  JOIN space_members m ON m.space_id = p.space_id AND m.user_id = $1
  WHERE p.id = ANY($2::text[])`
// 第一条语句定下事务快照，同时取游标与清理水位（floor 行不存在 = 从没清理过）
const SELECT_HEAD = `SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS cursor,
  (SELECT xid::text FROM page_changes_floor) AS floor`
const SELECT_MY_SPACES = 'SELECT space_id FROM space_members WHERE user_id = $1 ORDER BY space_id'
const SELECT_CHANGED_IDS = `SELECT DISTINCT c.page_id FROM page_changes c
  WHERE c.xid >= $1::xid8 AND c.space_id IN (SELECT space_id FROM space_members WHERE user_id = $2)`

/** 日志保留期：更久没开过的客户端带着旧游标来，整表一次 */
export const PAGE_CHANGES_RETAIN = '7 days'
export const PAGE_CHANGES_PRUNE_MS = 60 * 60 * 1000

// 删旧日志和推进 floor 是一条语句（同一事务）：floor = 删掉的最大 xid + 1，只升不降。
// 游标 < floor 说明它之后的日志可能被删过，只能整表；>= floor 时被删的行全在游标之前，增量照常。
// xid8 没有算术运算，经 numeric 加一
const PRUNE = `WITH gone AS (
    DELETE FROM page_changes WHERE at < now() - $1::interval RETURNING xid
  ), top AS (
    SELECT max(xid::text::numeric) AS x FROM gone
  ), bump AS (
    INSERT INTO page_changes_floor (one, xid)
    SELECT true, (x + 1)::text::xid8 FROM top WHERE x IS NOT NULL
    ON CONFLICT (one) DO UPDATE SET xid = EXCLUDED.xid WHERE page_changes_floor.xid < EXCLUDED.xid
    RETURNING 1
  )
  SELECT count(*)::int AS n FROM gone`

export type PageSync =
  | { cursor: string; members: string; full: ApiPage[] }
  | { cursor: string; members: string; up: ApiPage[]; rm: string[] }

// xid8 是无符号 64 位，十进制至多 20 位；19 位以内恒在范围里
const CURSOR_RE = /^\d{1,19}$/

/** 成员指纹：我所在空间 id 排序后的短哈希。不一致 = 加入 / 退出过空间（或空间被删），整表 */
export function membersKey(spaceIds: readonly string[]): string {
  return createHash('sha256').update(spaceIds.join('\n')).digest('hex').slice(0, 16)
}

/** 能不能从 since 增量：格式对、不比清理水位旧、也不比现在的游标新（库被重建 / 从备份恢复后事务号会回到更小的值，
 * 拿着更大的旧游标会永远漏）。不行就 null 走整表而不是 400，客户端缓存坏了也能自愈 */
function deltaFrom(since: string | undefined, cursor: string, floor: string | null): string | null {
  if (!since || !CURSOR_RE.test(since)) return null
  const from = BigInt(since)
  if (from > BigInt(cursor)) return null
  if (floor !== null && from < BigInt(floor)) return null
  return from.toString()
}

/** 页面列表同步：since / members 是上一次响应带回的游标与成员指纹，缺一个或对不上就整表 */
export async function syncPages(
  pool: Pool,
  userId: string,
  since: string | undefined,
  members: string | undefined,
): Promise<PageSync> {
  const client = await pool.connect()
  try {
    // REPEATABLE READ：整个读取共用一个快照，游标与读到的日志、页面现状对得上（见文件头）
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const head = (await client.query<{ cursor: string; floor: string | null }>(SELECT_HEAD)).rows[0]!
    const spaces = (await client.query<{ space_id: string }>(SELECT_MY_SPACES, [userId])).rows
    const fingerprint = membersKey(spaces.map((r) => r.space_id))
    const from = members === fingerprint ? deltaFrom(since, head.cursor, head.floor) : null
    let out: PageSync
    if (from === null) {
      const rows = (await client.query(SELECT_ALL_MINE, [userId])).rows
      out = { cursor: head.cursor, members: fingerprint, full: rows.map(toApiPage) }
    } else {
      const ids = (await client.query<{ page_id: string }>(SELECT_CHANGED_IDS, [from, userId])).rows.map((r) => r.page_id)
      const rows = ids.length ? (await client.query<{ id: string }>(SELECT_MINE_BY_IDS, [userId, ids])).rows : []
      // 日志里有、现在看不见的：回收、物理删除、换到我不在的空间
      const alive = new Set(rows.map((r) => r.id))
      out = { cursor: head.cursor, members: fingerprint, up: rows.map(toApiPage), rm: ids.filter((id) => !alive.has(id)) }
    }
    await client.query('COMMIT')
    return out
  } catch (err) {
    // 连接已坏时 ROLLBACK 本身会抛，不能让它顶掉原始错误
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** 清理旧日志并推进 floor，返回删掉的行数。retain 缺省 7 天（测试传更短的） */
export async function prunePageChanges(pool: Pool, retain: string = PAGE_CHANGES_RETAIN): Promise<number> {
  return (await pool.query<{ n: number }>(PRUNE, [retain])).rows[0]?.n ?? 0
}
