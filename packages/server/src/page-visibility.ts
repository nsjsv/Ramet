// ---------- 批量判页面可见性 ----------
// 收藏列表、反链这类一批页面 id 里哪些此人看得见的读路径共用：活页面（回收站里的不算）且是页面所属空间的成员，admin 也不例外。
// 不可见的不出现在结果里，调用方不区分不存在、回收站和没权限，不泄露存在性。

import type { Pool } from 'pg'

export type VisiblePage = { id: string; title: string; kind: string; space_id: string }

const SELECT_VISIBLE = `SELECT p.id, p.title, p.kind, p.space_id FROM live_pages p
  JOIN space_members m ON m.space_id = p.space_id AND m.user_id = $2
  WHERE p.id = ANY($1::text[])`

export async function visiblePages(pool: Pool, user: { id: string }, ids: string[]): Promise<Map<string, VisiblePage>> {
  if (ids.length === 0) return new Map()
  const { rows } = await pool.query<VisiblePage>(SELECT_VISIBLE, [ids, user.id])
  return new Map(rows.map((r) => [r.id, r]))
}
