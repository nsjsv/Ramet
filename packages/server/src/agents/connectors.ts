// ---------- connector 注册表（中心侧持久化）----------
// 一条 connector 归属一个空间；长期 token 只存 sha256，明文只在配对响应里出现一次（经发起配对的那条 ws，见 pairing.ts）。
// 在线态不在这里（进程内 Hub 是唯一事实源，见 hub.ts）。

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { ConnectorAgentInfo } from './protocol.js'

/** pending = 成员接入、等空间 owner 批准（任何人都用不了，见 machine-access.ts）；approved = 已在空间里生效 */
export type ConnectorStatus = 'pending' | 'approved'

export type ConnectorRow = {
  id: string
  space_id: string
  name: string
  agents: ConnectorAgentInfo[]
  created_at: string
  last_seen_at: string | null
  status: ConnectorStatus
  owner_id: string | null
  /** 接入人的用户名；老 connector / 账号已删 = null */
  owner: string | null
}

// 状态按确认配对的人此刻在该空间的角色定：owner → approved，member → pending，其余（不是成员 / viewer）
// 查不到成员行，不插入。成员行带 FOR SHARE：与「移出空间 / 降为 viewer」的写成员行互斥，要么这里先插入（随后的清理能删到它），
// 要么对方先提交（这里看到的就是新角色），不会漏出一台无主的 pending / approved 机器
const INSERT_CONNECTOR = `INSERT INTO connectors (id, space_id, owner_id, name, token_hash, agents, status, last_seen_at)
  SELECT $1::text, $2::text, m.user_id, $3::text, $4::text, $5::jsonb,
         CASE m.role WHEN 'owner' THEN 'approved' ELSE 'pending' END, now()
  FROM space_members m
  WHERE m.space_id = $2::text AND m.user_id = $6::text AND m.role IN ('owner', 'member')
  FOR SHARE OF m
  RETURNING status`
const SELECT_BY_TOKEN = 'SELECT id, space_id, owner_id, name, agents FROM connectors WHERE token_hash = $1'
const SELECT_BY_ID = 'SELECT id, space_id, name, agents FROM connectors WHERE id = $1'
// 可见性：已批准的空间成员都看得到；pending 只有接入人本人（$2）和空间 owner（$3）看得到，其他人整行不返回
const SELECT_BY_SPACE = `SELECT c.id, c.space_id, c.name, c.agents, c.created_at, c.last_seen_at, c.status, c.owner_id, u.username AS owner
  FROM connectors c LEFT JOIN users u ON u.id = c.owner_id
  WHERE c.space_id = $1 AND (c.status = 'approved' OR c.owner_id = $2 OR $3::boolean)
  ORDER BY c.created_at, c.id`
const DELETE_CONNECTOR = 'DELETE FROM connectors WHERE id = $1'
// 只对 pending 生效：返回是否真的改了 / 删了（对 approved 的批准 / 拒绝由调用方回 409）
const APPROVE_CONNECTOR = "UPDATE connectors SET status = 'approved' WHERE id = $1 AND status = 'pending'"
const REJECT_CONNECTOR = "DELETE FROM connectors WHERE id = $1 AND status = 'pending'"
const DELETE_MEMBER_CONNECTORS = 'DELETE FROM connectors WHERE space_id = $1 AND owner_id = $2 RETURNING id'
const SAVE_AGENTS = 'UPDATE connectors SET agents = $2, last_seen_at = now() WHERE id = $1'
const TOUCH = 'UPDATE connectors SET last_seen_at = now() WHERE id = $1'

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export type CreatedConnector = { connectorId: string; token: string; status: ConnectorStatus }

/** 建一条 connector 行，返回长期 token（明文只此一次）。确认配对的人就是这台机器的主人（owner_id）。
 *  状态按他此刻在该空间的角色定（空间 owner → approved，member → pending）；不是 owner / member → null，不建行 */
export async function createConnector(
  pool: Pool,
  spaceId: string,
  ownerId: string,
  name: string,
  agents: ConnectorAgentInfo[],
): Promise<CreatedConnector | null> {
  const id = randomUUID()
  const token = randomBytes(32).toString('hex')
  const { rows } = await pool.query<{ status: ConnectorStatus }>(INSERT_CONNECTOR, [
    id, spaceId, name, hashToken(token), JSON.stringify(agents), ownerId,
  ])
  const status = rows[0]?.status
  return status ? { connectorId: id, token, status } : null
}

export async function connectorByToken(
  pool: Pool,
  token: string,
): Promise<{ id: string; spaceId: string; ownerId: string | null; name: string; agents: ConnectorAgentInfo[] } | null> {
  const { rows } = await pool.query<{
    id: string
    space_id: string
    owner_id: string | null
    name: string
    agents: ConnectorAgentInfo[]
  }>(SELECT_BY_TOKEN, [hashToken(token)])
  const row = rows[0]
  return row
    ? { id: row.id, spaceId: row.space_id, ownerId: row.owner_id, name: row.name, agents: row.agents ?? [] }
    : null
}

export async function connectorById(pool: Pool, id: string): Promise<{ id: string; spaceId: string } | null> {
  const { rows } = await pool.query<{ id: string; space_id: string }>(SELECT_BY_ID, [id])
  const row = rows[0]
  return row ? { id: row.id, spaceId: row.space_id } : null
}

/** 该空间的 connector 列表，按 viewer 过滤：pending 的只返回给接入人本人和空间 owner（spaceOwner），其余人整行看不到 */
export async function listConnectors(
  pool: Pool,
  spaceId: string,
  viewer: { id: string; spaceOwner: boolean },
): Promise<ConnectorRow[]> {
  const { rows } = await pool.query<ConnectorRow>(SELECT_BY_SPACE, [spaceId, viewer.id, viewer.spaceOwner])
  return rows
}

/** 批准一台 pending 的机器；不是 pending（已批准 / 不存在）→ false */
export async function approveConnector(pool: Pool, id: string): Promise<boolean> {
  return ((await pool.query(APPROVE_CONNECTOR, [id])).rowCount ?? 0) > 0
}

/** 拒绝一台 pending 的机器 = 删除；不是 pending → false（调用方据此回 409，不误删已批准的） */
export async function rejectConnector(pool: Pool, id: string): Promise<boolean> {
  return ((await pool.query(REJECT_CONNECTOR, [id])).rowCount ?? 0) > 0
}

/** 删掉某人在某空间接入的全部 connector（他被移出空间 / 降为只读时），返回被删的 id —— 调用方要断开这些在线连接。
 *  db 可以是 Pool 或事务里的 client：要和「改成员行」放同一个事务，才与兑换时的 FOR SHARE 配合得严丝合缝 */
export async function deleteMemberConnectors(db: Pool | PoolClient, spaceId: string, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(DELETE_MEMBER_CONNECTORS, [spaceId, userId])
  return rows.map((r) => r.id)
}

export async function saveAgents(pool: Pool, id: string, agents: ConnectorAgentInfo[]): Promise<void> {
  await pool.query(SAVE_AGENTS, [id, JSON.stringify(agents)])
}

export async function touchConnector(pool: Pool, id: string): Promise<void> {
  await pool.query(TOUCH, [id])
}

export async function deleteConnector(pool: Pool, id: string): Promise<void> {
  await pool.query(DELETE_CONNECTOR, [id])
}
