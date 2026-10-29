// ---------- 机器授权仪式：创建 → 机器本地确认 → 收回 / 到期（+ 使用记录、使用申请）----------
// 判定「谁能用」的唯一实现在 machine-access.ts（读 machine_grants）；本模块是这张表的全部写入口：
//   createGrant  主人在网页上发起（重输密码等校验在路由），落一条待确认授权 + 一次性确认码（库里只存哈希）
//   peekGrant / confirmGrant  主人在机器上用确认码确认（走 connector token 认证的端点）；确认才生效，同时把同一人更早的有效授权并掉
//   revokeGrant / revokeUserGrants  收回；先置 revoked_at（判定立刻为假），再「当场断开」，最后置 ended_at
//   sweepGrants  到期清扫：到期 / 收回却没来得及断开的授权，执行同样的断开，只做一次
// 「断开」本身（取消在飞的轮次、作废 MCP 凭证、通知 connector）在 AgentManager.revokeMachineAccess，经 Disconnect 回调注入，
// 这里不依赖 manager。一人一机同一时刻只有一条有效授权：新的确认生效时旧的被收回（不断开，此人仍有权限）。
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { withTransaction } from '../db.js'
import type { ResolvedAgent } from './manager-types.js'
import type { MachineScope } from './machine-access.js'

export const MACHINE_SCOPES: readonly MachineScope[] = ['agent', 'machine']
/** 确认码有效期：够主人走到机器前敲命令，又不至于长期可用 */
export const CONFIRM_CODE_TTL_MS = 15 * 60_000
export const GRANT_DAYS_DEFAULT = 7
export const GRANT_DAYS_MAX = 30

/** 「当场断开」：此人在这台机器上不再有任何有效授权时调用（取消在飞轮次 / 作废凭证 / 通知 connector）。要幂等 */
export type Disconnect = (connectorId: string, userId: string) => void | Promise<void>

export type GrantStatus = 'pending' | 'active' | 'expired' | 'revoked'

// 32 个字符（去掉易混的 I O 0 1）：256 % 32 === 0，按字节取模没有偏差。16 位 = 80 bit
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** 展示形态 XXXX-XXXX-XXXX-XXXX */
export function newConfirmCode(): string {
  let raw = ''
  for (const byte of randomBytes(16)) raw += CODE_ALPHABET[byte % CODE_ALPHABET.length]
  return raw.match(/.{4}/g)!.join('-')
}

/** 敲命令时大小写、连字符、空格都不计 */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function hashCode(input: string): string {
  return createHash('sha256').update(normalizeCode(input)).digest('hex')
}

// ---------- 创建 / 确认 ----------

export class PendingGrantExists extends Error {
  constructor() {
    super('这个人在这台机器上已经有一条待确认的授权，请先取消它')
  }
}

/** 待确认 = 没确认、没收回、确认码与授权本身都没过期 */
const PENDING_EXISTS = `SELECT 1 FROM machine_grants
  WHERE connector_id = $1 AND user_id = $2 AND confirmed_at IS NULL AND revoked_at IS NULL
    AND COALESCE(confirm_expires_at, expires_at) > now() AND expires_at > now()`
const INSERT_GRANT = `INSERT INTO machine_grants (id, connector_id, user_id, scopes, granted_by, expires_at, confirm_code_hash, confirm_expires_at)
  VALUES ($1, $2, $3, $4, $5, now() + $6::int * interval '1 day', $7, now() + $8::double precision * interval '1 millisecond')
  RETURNING expires_at, confirm_expires_at`
// 申请只是「想用」的意向：主人为此人发起授权，就算处理了
const RESOLVE_REQUESTS = `UPDATE machine_access_requests SET resolved_at = now()
  WHERE connector_id = $1 AND user_id = $2 AND resolved_at IS NULL`

export type CreatedGrant = { id: string; code: string; expiresAt: Date; confirmExpiresAt: Date }

/** 建一条待确认授权。同一人已有待确认的 → PendingGrantExists（先取消）。
 *  expires_at 从创建时起算（不是确认时）：确认窗口只有 15 分钟，多出的误差不值得为它多存一列；
 *  机器上的本地名单抄的就是这个值，两边一致 */
export async function createGrant(
  pool: Pool,
  input: { connectorId: string; userId: string; scopes: MachineScope[]; days: number; grantedBy: string },
): Promise<CreatedGrant> {
  return withTransaction(pool, async (db) => {
    // 同一台机器的授权创建串行化：否则两个并发请求都读到「没有待确认」，各插一条
    await db.query('SELECT 1 FROM connectors WHERE id = $1 FOR UPDATE', [input.connectorId])
    if ((await db.query(PENDING_EXISTS, [input.connectorId, input.userId])).rowCount) throw new PendingGrantExists()
    const id = randomUUID()
    const code = newConfirmCode()
    const { rows } = await db.query<{ expires_at: Date; confirm_expires_at: Date }>(INSERT_GRANT, [
      id, input.connectorId, input.userId, input.scopes, input.grantedBy, input.days, hashCode(code), CONFIRM_CODE_TTL_MS,
    ])
    await db.query(RESOLVE_REQUESTS, [input.connectorId, input.userId])
    return { id, code, expiresAt: rows[0]!.expires_at, confirmExpiresAt: rows[0]!.confirm_expires_at }
  })
}

/** 机器上确认时展示给人看的、也是写进本地名单的那些字段 */
export type GrantInfo = {
  grantId: string
  userId: string
  username: string
  scopes: MachineScope[]
  expiresAt: string
  /** 发起授权的人（必须是机器主人，connector 会核对） */
  grantedById: string
  grantedBy: string
  machineName: string
}

type GrantInfoRow = {
  id: string
  user_id: string
  username: string
  scopes: MachineScope[]
  expires_at: Date
  granted_by: string
  granted_by_name: string | null
  machine_name: string
}

const INFO_SELECT = `SELECT g.id, g.user_id, u.username, g.scopes, g.expires_at, g.granted_by, gb.username AS granted_by_name, c.name AS machine_name
  FROM machine_grants g
  JOIN users u ON u.id = g.user_id
  JOIN connectors c ON c.id = g.connector_id
  LEFT JOIN users gb ON gb.id = g.granted_by`
// 码必须属于这台机器（connector token 对应的那台）、没确认、没收回、码与授权都没过期。统一一个条件，peek 与 confirm 共用
const CONFIRMABLE = `g.connector_id = $1 AND g.confirm_code_hash = $2 AND g.confirmed_at IS NULL AND g.revoked_at IS NULL
  AND g.confirm_expires_at > now() AND g.expires_at > now()`
const CONFIRM = `UPDATE machine_grants g SET confirmed_at = now(), confirm_code_hash = NULL, confirm_expires_at = NULL
  WHERE ${CONFIRMABLE} RETURNING g.id, g.user_id`
// 同一人更早的有效授权并掉（不断开：此人仍有权限，只是换成了新的那条）
const SUPERSEDE = `UPDATE machine_grants SET revoked_at = now(), ended_at = now()
  WHERE connector_id = $1 AND user_id = $2 AND id <> $3 AND confirmed_at IS NOT NULL AND revoked_at IS NULL AND expires_at > now()`

function toInfo(row: GrantInfoRow): GrantInfo {
  return {
    grantId: row.id,
    userId: row.user_id,
    username: row.username,
    scopes: row.scopes,
    expiresAt: row.expires_at.toISOString(),
    grantedById: row.granted_by,
    grantedBy: row.granted_by_name ?? '',
    machineName: row.machine_name,
  }
}

/** 看一眼这个码对应什么授权（不改任何东西）；不属于这台机器 / 已确认 / 过期 / 已收回 / 不存在一律 null */
export async function peekGrant(pool: Pool, connectorId: string, code: string): Promise<GrantInfo | null> {
  const { rows } = await pool.query<GrantInfoRow>(`${INFO_SELECT} WHERE ${CONFIRMABLE}`, [connectorId, hashCode(code)])
  return rows[0] ? toInfo(rows[0]) : null
}

// 同一人更早的有效授权（要被并掉的那些）覆盖了哪些范围：新授权的范围比它们小，差额就是「收窄」丢掉的使用权
const PREVIOUS_SCOPES = `SELECT scopes FROM machine_grants
  WHERE connector_id = $1 AND user_id = $2 AND id <> $3 AND confirmed_at IS NOT NULL AND revoked_at IS NULL AND expires_at > now()`

/** 确认：置 confirmed_at 并清掉码（同一个码第二次就是 null）。条件与 peek 同一份，并发确认只有一个赢家。
 *  lost = 此人更早的有效授权里有、新授权里没有的范围（收窄）：调用方据此当场收掉他已经在用的那部分（终端等），
 *  见 AgentManager.reduceMachineAccess */
export async function confirmGrant(
  pool: Pool,
  connectorId: string,
  code: string,
): Promise<{ info: GrantInfo; lost: MachineScope[] } | null> {
  return withTransaction(pool, async (db) => {
    const done = await db.query<{ id: string; user_id: string }>(CONFIRM, [connectorId, hashCode(code)])
    const row = done.rows[0]
    if (!row) return null
    const before = await db.query<{ scopes: MachineScope[] }>(PREVIOUS_SCOPES, [connectorId, row.user_id, row.id])
    await db.query(SUPERSEDE, [connectorId, row.user_id, row.id])
    const { rows } = await db.query<GrantInfoRow>(`${INFO_SELECT} WHERE g.id = $1`, [row.id])
    if (!rows[0]) return null
    const info = toInfo(rows[0])
    const had = new Set(before.rows.flatMap((r) => r.scopes))
    return { info, lost: MACHINE_SCOPES.filter((s) => had.has(s) && !info.scopes.includes(s)) }
  })
}

export type GrantListItem = {
  id: string
  userId: string
  username: string
  scopes: MachineScope[]
  status: GrantStatus
  expiresAt: string
  confirmedAt: string | null
  revokedAt: string | null
  firstUsedAt: string | null
  createdAt: string
}

type GrantListRow = {
  id: string
  user_id: string
  username: string | null
  scopes: MachineScope[]
  status: GrantStatus
  expires_at: Date
  confirmed_at: Date | null
  revoked_at: Date | null
  first_used_at: Date | null
  created_at: Date
}

// 状态只在这一处算：收回 > (没确认 ? 码过期则已过期 : 待确认) > (到期则已过期 : 生效)
const LIST_GRANTS = `SELECT g.id, g.user_id, u.username, g.scopes, g.expires_at, g.confirmed_at, g.revoked_at, g.first_used_at, g.created_at,
    CASE WHEN g.revoked_at IS NOT NULL THEN 'revoked'
         WHEN g.confirmed_at IS NULL THEN CASE WHEN COALESCE(g.confirm_expires_at, g.expires_at) > now() AND g.expires_at > now() THEN 'pending' ELSE 'expired' END
         WHEN g.expires_at > now() THEN 'active' ELSE 'expired' END AS status
  FROM machine_grants g LEFT JOIN users u ON u.id = g.user_id
  WHERE g.connector_id = $1 ORDER BY g.created_at DESC, g.id LIMIT 200`

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)

export async function listGrants(pool: Pool, connectorId: string): Promise<GrantListItem[]> {
  const { rows } = await pool.query<GrantListRow>(LIST_GRANTS, [connectorId])
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    username: r.username ?? '',
    scopes: r.scopes,
    status: r.status,
    expiresAt: r.expires_at.toISOString(),
    confirmedAt: iso(r.confirmed_at),
    revokedAt: iso(r.revoked_at),
    firstUsedAt: iso(r.first_used_at),
    createdAt: r.created_at.toISOString(),
  }))
}

/** 这条授权属于哪台机器、哪个人（路由判权限用） */
export async function grantOwnerOf(pool: Pool, grantId: string, connectorId: string): Promise<{ userId: string } | null> {
  const { rows } = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM machine_grants WHERE id = $1 AND connector_id = $2',
    [grantId, connectorId],
  )
  return rows[0] ? { userId: rows[0].user_id } : null
}

// ---------- 收回 / 到期 ----------

// 有效 = 已确认、未收回、未到期（与 machine-access.ts 的 USABLE 里授权那半同口径，少一个 scope 条件）
const EFFECTIVE = `connector_id = $1 AND user_id = $2 AND confirmed_at IS NOT NULL AND revoked_at IS NULL AND expires_at > now()`
// 可收回 = 没收回，且（没确认 → 取消待确认的；确认了 → 还没到期的）
const REVOCABLE = `revoked_at IS NULL AND (confirmed_at IS NULL OR expires_at > now())`
const MARK_ENDED = `UPDATE machine_grants SET ended_at = now()
  WHERE connector_id = $1 AND user_id = $2 AND ended_at IS NULL AND (revoked_at IS NOT NULL OR expires_at <= now())`

// 此人此刻还有权限：是这台机器的主人（主人没有授权也能用；收回命令敲错成主人的名字，不能把主人自己断开），或有有效授权
const STILL_HAS_ACCESS = `SELECT 1 FROM connectors WHERE id = $1 AND owner_id = $2
  UNION ALL SELECT 1 FROM machine_grants WHERE ${EFFECTIVE}`

/** 此人在这台机器上的授权都已无效 → 断开，再标记「已断开」。断开抛错则不标记：清扫下一轮会重试 */
async function finishAccess(pool: Pool, connectorId: string, userId: string, disconnect: Disconnect): Promise<void> {
  const stillHas = await pool.query(STILL_HAS_ACCESS, [connectorId, userId])
  if (!stillHas.rowCount) await disconnect(connectorId, userId)
  await pool.query(MARK_ENDED, [connectorId, userId])
}

/** 收回一条授权（主人收回 / 被授权人放弃 / 取消待确认的）。先置 revoked_at（判定立刻为假）再断开。找不到可收回的 → false */
export async function revokeGrant(pool: Pool, connectorId: string, grantId: string, disconnect: Disconnect): Promise<boolean> {
  const { rows } = await pool.query<{ user_id: string; confirmed_at: Date | null }>(
    `UPDATE machine_grants SET revoked_at = now() WHERE id = $1 AND connector_id = $2 AND ${REVOCABLE} RETURNING user_id, confirmed_at`,
    [grantId, connectorId],
  )
  const row = rows[0]
  if (!row) return false
  // 取消一条还没确认的：此人本来就没有因它获得过任何权限，没什么可断开
  if (row.confirmed_at) await finishAccess(pool, connectorId, row.user_id, disconnect)
  else await pool.query(MARK_ENDED, [connectorId, row.user_id])
  return true
}

/** 机器上的「收回」命令：收回此人在这台机器上的全部授权。返回收回了几条（0 也会走一遍断开：本机名单里有而中心已无的人） */
export async function revokeUserGrants(pool: Pool, connectorId: string, userId: string, disconnect: Disconnect): Promise<number> {
  const { rows } = await pool.query(
    `UPDATE machine_grants SET revoked_at = now() WHERE connector_id = $1 AND user_id = $2 AND ${REVOCABLE} RETURNING id`,
    [connectorId, userId],
  )
  await finishAccess(pool, connectorId, userId, disconnect)
  return rows.length
}

// 已确认且还没断开的授权，到期了或已被收回：该断开了（正常收回路径在收回时就断开并标记了；这里兜到期、以及断开中途失败的）
const SWEEP_CANDIDATES = `SELECT DISTINCT connector_id, user_id FROM machine_grants
  WHERE ended_at IS NULL AND confirmed_at IS NOT NULL AND (revoked_at IS NOT NULL OR expires_at <= now())`

/** 到期清扫（server 每分钟跑一次；测试直接调）。每个（机器, 人）只断开一次，之后 ended_at 挡住。返回处理了几个 */
export async function sweepGrants(pool: Pool, disconnect: Disconnect): Promise<number> {
  const { rows } = await pool.query<{ connector_id: string; user_id: string }>(SWEEP_CANDIDATES)
  let done = 0
  for (const row of rows) {
    try {
      await finishAccess(pool, row.connector_id, row.user_id, disconnect)
      done += 1
    } catch (err) {
      console.error(`[grants] 断开 ${row.user_id}@${row.connector_id} 失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return done
}

// connector 重连时补发「收回」：本机名单里可能还留着这些人（收回时它不在线）。只要授权还没到期本机条目就还活着，
// 到期的本机条目自己会失效；此人现在又有有效授权的不发（别把新授权的本机条目删了）
const REVOKED_USERS = `SELECT DISTINCT g.user_id FROM machine_grants g
  WHERE g.connector_id = $1 AND g.expires_at > now() AND g.confirmed_at IS NOT NULL AND g.revoked_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM machine_grants e WHERE e.connector_id = g.connector_id AND e.user_id = g.user_id
      AND e.confirmed_at IS NOT NULL AND e.revoked_at IS NULL AND e.expires_at > now())`

export async function revokedUsersOf(pool: Pool, connectorId: string): Promise<string[]> {
  const { rows } = await pool.query<{ user_id: string }>(REVOKED_USERS, [connectorId])
  return rows.map((r) => r.user_id)
}

// ---------- 使用记录 ----------

/** files = 项目面板（打开面板、读文件、看 diff；文件树与清单只是导航，不记）；
 *  terminal = 终端（打开 / 关闭，detail.op；每一行输入不记，太多）；
 *  preview = 端口预览（共享 / 停止共享，detail.op = share / stop；预览请求本身不记，太多）；
 *  quick = 随手 AI 的本地通道（用这台机器上的 agent 做一次改写，detail.kind = 任务类型；不记正文）；
 *  write = 写文件（项目面板代码查看器里收下随手 AI 的改写，detail.path；不记内容） */
export type UsageAction = 'run' | 'answer' | 'config' | 'files' | 'terminal' | 'preview' | 'quick' | 'write'

const INSERT_USAGE = `INSERT INTO machine_usage_log (connector_id, user_id, action, page_id, detail) VALUES ($1, $2, $3, $4, $5::jsonb)`
// 第一次使用：只设一次（日后收件箱据此提醒主人「有人开始用了」）
const MARK_FIRST_USE = `UPDATE machine_grants SET first_used_at = now()
  WHERE ${EFFECTIVE} AND first_used_at IS NULL`

// 被授权人第一次真正用这台机器：收件箱要提醒主人。记录使用的入口遍布各路由，这里留一个进程级的回调（index.ts 注入；
// 返回的函数撤销注册，只撤自己那一份，别把后起的服务的注册也撤了）
let firstUseHook: (() => void) | null = null
export function onMachineFirstUse(fn: () => void): () => void {
  firstUseHook = fn
  return () => {
    if (firstUseHook === fn) firstUseHook = null
  }
}

/** 记一次非主人对这台机器的使用；主人自己用 / 中心本机 agent 不记。在动作之前调用并 await：写不进审计就不让动作发生
 *  （入口都是 agent 已通过 assertCanUse 之后，所以非主人在这里一定持有有效授权） */
export async function recordMachineUse(
  pool: Pool,
  agent: Pick<ResolvedAgent, 'remote'>,
  userId: string,
  action: UsageAction,
  pageId: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  const remote = agent.remote
  if (!remote || remote.ownerId === userId) return
  const firstUse = await withTransaction(pool, async (db) => {
    await db.query(INSERT_USAGE, [remote.connectorId, userId, action, pageId, JSON.stringify(detail)])
    return ((await db.query(MARK_FIRST_USE, [remote.connectorId, userId])).rowCount ?? 0) > 0
  })
  if (firstUse) firstUseHook?.()
}

export type UsageItem = {
  id: string
  userId: string
  username: string
  action: UsageAction
  pageId: string | null
  detail: Record<string, unknown>
  createdAt: string
}

type UsageRow = {
  id: string
  user_id: string
  username: string | null
  action: UsageAction
  page_id: string | null
  detail: Record<string, unknown>
  created_at: Date
}

export const USAGE_LIMIT_DEFAULT = 50
export const USAGE_LIMIT_MAX = 200

/** 使用记录，新 → 旧。before = 上一页最后一条的 id（游标）；limit 缺省 50、上限 200 */
export async function listUsage(pool: Pool, connectorId: string, before: string | null, limit: number): Promise<UsageItem[]> {
  const { rows } = await pool.query<UsageRow>(
    `SELECT l.id, l.user_id, u.username, l.action, l.page_id, l.detail, l.created_at
     FROM machine_usage_log l LEFT JOIN users u ON u.id = l.user_id
     WHERE l.connector_id = $1 AND ($2::bigint IS NULL OR l.id < $2::bigint)
     ORDER BY l.id DESC LIMIT $3`,
    [connectorId, before, Math.min(Math.max(limit, 1), USAGE_LIMIT_MAX)],
  )
  return rows.map((r) => ({
    id: String(r.id),
    userId: r.user_id,
    username: r.username ?? '',
    action: r.action,
    pageId: r.page_id,
    detail: r.detail,
    createdAt: r.created_at.toISOString(),
  }))
}

// ---------- 使用申请 ----------

export class RequestExists extends Error {
  constructor() {
    super('你已经向这台机器的主人提交过申请，等他处理')
  }
}

export type AccessRequest = { id: string; userId: string; username: string; scopes: MachineScope[]; note: string; createdAt: string }

type RequestRow = { id: string; user_id: string; username: string | null; scopes: MachineScope[]; note: string; created_at: Date }

const toRequest = (r: RequestRow): AccessRequest => ({
  id: r.id,
  userId: r.user_id,
  username: r.username ?? '',
  scopes: r.scopes,
  note: r.note,
  createdAt: r.created_at.toISOString(),
})

/** 申请使用；同一人对同一台机器已有未处理的申请 → RequestExists（唯一索引兜底，并发也只有一条） */
export async function createRequest(
  pool: Pool,
  input: { connectorId: string; userId: string; scopes: MachineScope[]; note: string },
): Promise<AccessRequest> {
  const id = randomUUID()
  try {
    const { rows } = await pool.query<RequestRow>(
      `INSERT INTO machine_access_requests (id, connector_id, user_id, scopes, note) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, NULL::text AS username, scopes, note, created_at`,
      [id, input.connectorId, input.userId, input.scopes, input.note],
    )
    return toRequest(rows[0]!)
  } catch (err) {
    // 23505 = unique_violation（idx_machine_requests_open）
    if ((err as { code?: string }).code === '23505') throw new RequestExists()
    throw err
  }
}

export async function listRequests(pool: Pool, connectorId: string): Promise<AccessRequest[]> {
  const { rows } = await pool.query<RequestRow>(
    `SELECT r.id, r.user_id, u.username, r.scopes, r.note, r.created_at
     FROM machine_access_requests r LEFT JOIN users u ON u.id = r.user_id
     WHERE r.connector_id = $1 AND r.resolved_at IS NULL ORDER BY r.created_at, r.id`,
    [connectorId],
  )
  return rows.map(toRequest)
}

/** 申请是谁提的、是否还没处理（路由判权限用；处理过的也查得到，好区分「没权限」与「已处理」） */
export async function requestOwnerOf(pool: Pool, requestId: string, connectorId: string): Promise<{ userId: string; open: boolean } | null> {
  const { rows } = await pool.query<{ user_id: string; resolved_at: Date | null }>(
    'SELECT user_id, resolved_at FROM machine_access_requests WHERE id = $1 AND connector_id = $2',
    [requestId, connectorId],
  )
  return rows[0] ? { userId: rows[0].user_id, open: rows[0].resolved_at === null } : null
}

/** 处理掉一条申请（主人拒绝 / 申请人撤回）。找不到未处理的 → false */
export async function resolveRequest(pool: Pool, requestId: string, connectorId: string): Promise<boolean> {
  const done = await pool.query(
    'UPDATE machine_access_requests SET resolved_at = now() WHERE id = $1 AND connector_id = $2 AND resolved_at IS NULL',
    [requestId, connectorId],
  )
  return (done.rowCount ?? 0) > 0
}
