// ---------- 删号善后（admin 删号不接手被删用户的任何空间 / 页面） ----------
// 被删用户 owner 的空间：
//   还有别的成员：owner 转给剩余成员里角色最高（owner > member > viewer）、加入最早的一位，并不再算个人空间
//   （继任者自己的个人空间还在，一人挂两个 is_personal 会让 initDb 的补建迁移出错）
//   只有他一个人：与删空间同口径物理删除（page-purge.ts 的 purgeSpace：页面、正文、版本历史）
// 他作为成员加入的空间：成员行随外键级联删掉，空间不动。他建的页面（pages.owner_id，外键无级联）改记到所在空间的
// （新）owner，没有空间的遗留行置空。上传文件不删：全局按内容去重，可能被别处引用（同删空间）。
// 删号预览（数量）与真删共用同一条继任者判定，确认框里的数字就是实际会发生的。

import type { Pool, PoolClient } from 'pg'
import { purgeSpace } from './page-purge.js'

export type DeleteImpact = { transferSpaces: number; purgeSpaces: number; purgePages: number }

type OwnedSpace = { id: string; successor: string | null; pages: number }

// 被删用户 owner 的每个空间 + 继任者（没有则 NULL）+ 活页面数（只用于预览里的数字）
const SELECT_OWNED_SPACES = `SELECT s.id,
  (SELECT m.user_id FROM space_members m WHERE m.space_id = s.id AND m.user_id <> $1
    ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, m.created_at, m.user_id
    LIMIT 1) AS successor,
  (SELECT count(*)::int FROM live_pages p WHERE p.space_id = s.id) AS pages
  FROM spaces s WHERE s.owner_id = $1 ORDER BY s.id`
const TRANSFER_SPACE = 'UPDATE spaces SET owner_id = $2, is_personal = false WHERE id = $1'
const PROMOTE_SUCCESSOR = `UPDATE space_members SET role = 'owner' WHERE space_id = $1 AND user_id = $2`
const REASSIGN_PAGES = `UPDATE pages p SET owner_id = s.owner_id FROM spaces s
  WHERE p.space_id = s.id AND p.owner_id = $1`
const CLEAR_ORPHAN_PAGES = 'UPDATE pages SET owner_id = NULL WHERE owner_id = $1'
// 机器只归接入人：人没了机器不能变成无主还挂着授权；返回 id 供提交后断开在线连接
const DELETE_OWNED_CONNECTORS = 'DELETE FROM connectors WHERE owner_id = $1 RETURNING id'
// sessions / space_members / invites / 收藏等走外键级联
const DELETE_USER = 'DELETE FROM users WHERE id = $1'

async function ownedSpaces(db: Pool | PoolClient, userId: string): Promise<OwnedSpace[]> {
  return (await db.query<OwnedSpace>(SELECT_OWNED_SPACES, [userId])).rows
}

/** 删掉这个用户会发生什么（只给数量，不给空间名 / 页面名，admin 看不到别人的内容） */
export async function deleteImpact(pool: Pool, userId: string): Promise<DeleteImpact> {
  const spaces = await ownedSpaces(pool, userId)
  const purged = spaces.filter((s) => s.successor === null)
  return {
    transferSpaces: spaces.length - purged.length,
    purgeSpaces: purged.length,
    purgePages: purged.reduce((n, s) => n + s.pages, 0),
  }
}

/** 删号，调用方开事务。返回被删掉的机器 id（他接入的 + 被删空间里别人接入的），提交后由调用方断开在线连接 */
export async function deleteUserAccount(client: PoolClient, userId: string): Promise<string[]> {
  // 先锁住他名下的空间行：从判定继任者到转交 / 删除之间，别的请求改不了这些空间的归属
  await client.query('SELECT id FROM spaces WHERE owner_id = $1 FOR UPDATE', [userId])
  const dropped: string[] = []
  for (const space of await ownedSpaces(client, userId)) {
    if (space.successor === null) {
      dropped.push(...(await purgeSpace(client, space.id)))
    } else {
      await client.query(TRANSFER_SPACE, [space.id, space.successor])
      await client.query(PROMOTE_SUCCESSOR, [space.id, space.successor])
    }
  }
  await client.query(REASSIGN_PAGES, [userId])
  await client.query(CLEAR_ORPHAN_PAGES, [userId])
  const { rows } = await client.query<{ id: string }>(DELETE_OWNED_CONNECTORS, [userId])
  await client.query(DELETE_USER, [userId])
  return [...dropped, ...rows.map((r) => r.id)]
}
