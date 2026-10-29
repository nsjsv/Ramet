// ---------- 机器所有权：谁能让一台机器动起来（唯一判定）----------
// connector 接入的机器只归接入人（connectors.owner_id）。空间 owner、全局 admin、同空间成员默认都用不了，
// 要用必须有一条 machine_grants 授权（经授权仪式、机器本地确认、未过期、未收回、scope 匹配），没有第三条路，
// 不认空间角色，也不认全局 admin。
//
// 本模块是这条规则在中心侧的唯一实现：canUse / usableConnectors 回答「能不能」（目录过滤用），
// assertCanUse 不能就抛 ForbiddenError，能就签出一张 MachinePass（凭据）。
// MachinePass 是类型层的闸：agents/ 里所有会让机器动起来的函数（ensureAdapter、Hub 下发帧、RemoteAgent 的驱动方法）
// 都要求持有它，而它只能由 assertCanUse / assertLocalOwner 构造；新增入口不先过这里就拿不到适配器，编译不过。
//
// 中心本机 agent（RAMET_LOCAL_AGENTS=1 时才存在）没有 connector：主人是全局 admin，不支持授权，非 admin 一律拒绝。
import type { Pool } from 'pg'
import { ForbiddenError } from './posture.js'

/** agent = 用这台机器上的 agent（发起 / 继续 / 答审批 / 改配置 / 列目录选工作区）；
 *  machine = 用这台机器的终端 / 文件。两者互不蕴含：只授权 agent 时终端仍不可用，反之亦然 */
export type MachineScope = 'agent' | 'machine'

/** 中心本机 agent 的机器标识。connector id 是 uuid，不会撞 */
export const LOCAL_MACHINE = 'local'

/** 凭据：「userId 有权以 scope 使用 machine」。只能由本模块签发（private 构造器 + 模块内的 issue）。
 *  hub 在真正发帧前还会 instanceof 校验，防止用 `as` 伪造一个结构相同的对象。 */
export class MachinePass {
  private constructor(
    readonly userId: string,
    /** connector id，或 LOCAL_MACHINE */
    readonly machine: string,
    readonly scope: MachineScope,
  ) {}
}

function issue(userId: string, machine: string, scope: MachineScope): MachinePass {
  const make = MachinePass as unknown as new (userId: string, machine: string, scope: MachineScope) => MachinePass
  return new make(userId, machine, scope)
}

// 可用条件只写在这一处，单条与批量查询共用，不会各写一份而漂移。
// 已批准：status = 'approved'，放在整个 OR 外面（AND）。成员接入的机器在空间 owner 批准前是 pending：
//   它还没被允许在这个空间里出现，跑 agent 会写这个空间的页面，所以任何人都用不了，包括接入人自己。别处不许另写一份 status 判断。
// 有主人：owner_id IS NOT NULL，同样在 OR 外面。老 connector 没有主人；主人删号后外键把 owner_id 置空，
//   此时没人能再管这台机器（收回授权、看使用记录），它上面残留的授权也一并作废，不能让被授权人继续用一台无主的机器。
// 接入人：owner_id = $1（`NULL = $1` 为 NULL 即假 → 谁都不是）
// 授权：scope 匹配 ∧ 已在机器上确认 ∧ 未收回 ∧ 未过期
const USABLE = `(
  c.status = 'approved' AND c.owner_id IS NOT NULL AND (
    c.owner_id = $1
    OR EXISTS (
      SELECT 1 FROM machine_grants g
      WHERE g.connector_id = c.id AND g.user_id = $1 AND $2 = ANY(g.scopes)
        AND g.confirmed_at IS NOT NULL AND g.revoked_at IS NULL AND g.expires_at > now()
    )
  )
)`
const CAN_USE = `SELECT 1 FROM connectors c WHERE c.id = $3 AND ${USABLE}`
const USABLE_IDS = `SELECT c.id FROM connectors c WHERE ${USABLE}`
const OWNER_NAME = `SELECT u.username, c.status FROM connectors c LEFT JOIN users u ON u.id = c.owner_id WHERE c.id = $1`

/** 该用户能否以 scope 使用这台 connector。不存在的 connector = 不能 */
export async function canUse(pool: Pool, userId: string, connectorId: string, scope: MachineScope): Promise<boolean> {
  const { rowCount } = await pool.query(CAN_USE, [userId, scope, connectorId])
  return (rowCount ?? 0) > 0
}

/** 该用户能以 scope 使用的全部 connector id（目录过滤：看不到就点不到） */
export async function usableConnectors(pool: Pool, userId: string, scope: MachineScope): Promise<Set<string>> {
  const { rows } = await pool.query<{ id: string }>(USABLE_IDS, [userId, scope])
  return new Set(rows.map((r) => r.id))
}

// 这台 connector 所在的空间里有没有这个人（任意角色）。看不到这台机器的人，连「被拒」都不告诉他
const IN_CONNECTOR_SPACE = `SELECT 1 FROM connectors c JOIN space_members m ON m.space_id = c.space_id AND m.user_id = $2 WHERE c.id = $1`

/** 该用户是不是这台 connector 所在空间的成员。manager.resolve 的第一道、收件箱的审批可见性共用这一处 */
export async function inConnectorSpace(pool: Pool, userId: string, connectorId: string): Promise<boolean> {
  const { rowCount } = await pool.query(IN_CONNECTOR_SPACE, [connectorId, userId])
  return (rowCount ?? 0) > 0
}

/** 能就签出凭据，不能抛 ForbiddenError（HTTP 403；run 时本轮失败并带原因）。失败文案带主人名，让人知道找谁要授权 */
export async function assertCanUse(
  pool: Pool,
  user: { id: string },
  connectorId: string,
  scope: MachineScope,
): Promise<MachinePass> {
  if (await canUse(pool, user.id, connectorId, scope)) return issue(user.id, connectorId, scope)
  const { rows } = await pool.query<{ username: string | null; status: string }>(OWNER_NAME, [connectorId])
  if (rows.length === 0) throw new ForbiddenError('找不到这台机器')
  // 还没被空间 owner 批准：对谁都一样（含接入人自己），文案直接说明在等什么
  if (rows[0]!.status === 'pending') throw new ForbiddenError('这台机器还在等空间管理员批准')
  const owner = rows[0]!.username
  throw new ForbiddenError(
    owner
      ? `这台机器属于 ${owner}，需要他授权`
      : '这台机器没有主人（旧配对），请重新配对后再使用',
  )
}

/** 中心本机 agent：主人是全局 admin，不支持授权 */
export function assertLocalOwner(user: { id: string; role: string }, scope: MachineScope): MachinePass {
  if (user.role !== 'admin') throw new ForbiddenError('服务器本机的 agent 只有管理员能用')
  return issue(user.id, LOCAL_MACHINE, scope)
}
