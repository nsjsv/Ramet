// ---------- 页面回收站的核心动作：整棵子树进回收站 / 从回收站恢复 ----------
// REST 的回收 / 恢复、目录树删除、集合删行，以及正文存储钩子里的内联集合生命周期（collections/inline.ts，挂在 collab.ts 上）共用。
// 不依赖 collab.ts：存储钩子要用它，放在 routes/pages.ts 里会形成 collab → pages → collab 的循环引用。

import type { Pool } from 'pg'

type Db = Pick<Pool, 'query'>

// 子树收集：单条递归 CTE（UNION 去重，库里已有环也终止，与 validParent 同款），两个口径：
//   _ALL   读基表，连已回收子孙一起收（物理删除要分流删活行 / 保留已回收行，恢复要连子孙一起清标记）
//   _ALIVE 读 live_pages，只收活页面（回收页的子孙必然全已回收，所以回收只盖章活子树）
export const SELECT_SUBTREE_ALL = `WITH RECURSIVE sub AS (
  SELECT id, deleted_at FROM pages WHERE id = ANY($1::text[])
  UNION
  SELECT p.id, p.deleted_at FROM pages p JOIN sub s ON p.parent_id = s.id
) SELECT id, deleted_at FROM sub`
// 入参是 id 集，一次可收多棵子树
const SELECT_SUBTREE_ALIVE = `WITH RECURSIVE sub AS (
  SELECT id FROM live_pages WHERE id = ANY($1::text[])
  UNION
  SELECT p.id FROM live_pages p JOIN sub s ON p.parent_id = s.id
) SELECT id FROM sub`
// 回收站条目 = 被删子树的根（父页面仍活着或没有父）。列表、restore 守卫、内联集合的候选共用这一个谓词，被判定的页面行别名要是 p
export const TRASH_ENTRY_PREDICATE = `p.deleted_at IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM pages a WHERE a.id = p.parent_id AND a.deleted_at IS NOT NULL)`
const TRASH_SUBTREE = `UPDATE pages SET deleted_at = now()::text WHERE id = ANY($1::text[]) RETURNING id`
const RESTORE_SUBTREE = `UPDATE pages SET deleted_at = NULL WHERE id = ANY($1::text[])`

// 活子树整棵移入回收站，POST /api/pages/:id/trash 与目录 / 目录树删除共用。
// 调用方负责可见性和可写闸门；db 可以是 Pool 或事务里的 PoolClient（boards.ts 在同一事务内回收）；notify 注入树广播。
// 入参是 id 集，一次可盖章多棵子树；返回被回收的活页面 id 集
export async function trashPageSubtree(db: Db, pageIds: string[], notify?: () => void): Promise<string[]> {
  if (pageIds.length === 0) return []
  const trashed = (await db.query<{ id: string }>(SELECT_SUBTREE_ALIVE, [pageIds])).rows.map((r) => r.id)
  if (trashed.length > 0) await db.query(TRASH_SUBTREE, [trashed])
  notify?.()
  return trashed
}

// 恢复一个回收站条目：清整棵子树的 deleted_at（行从未离开 pages，父子关系与空间归属原地保留）。
// 调用方负责确认它是条目本身（TRASH_ENTRY_PREDICATE，已回收页面的子孙单独恢复会还原成孤儿）并做权限闸门。
// 返回被恢复的页面 id 集（含条目自身）
export async function restorePageSubtree(db: Db, entryId: string, notify?: () => void): Promise<string[]> {
  const ids = (await db.query<{ id: string }>(SELECT_SUBTREE_ALL, [[entryId]])).rows.map((r) => r.id)
  await db.query(RESTORE_SUBTREE, [ids])
  notify?.()
  return ids
}
