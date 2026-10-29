// ---------- AI 回复块消失 → 它的过程页一起物理删除 ----------
// 过程页的存在理由是父文档里那条 agent_reply 的 run 属性，块没了，页不该留在树上。
// 只收仍挂在本文档下的 kind=run，拖去别的父页的不动。挂在过程页下的活子孙一并清
// （页面行级联删，Yjs 没有外键，要单独清）。已在回收站里的子孙先摘掉父级，避免被级联吞掉。

import type { Pool } from 'pg'
import type * as Y from 'yjs'
import { withTransaction } from '../db.js'
import { purgePageRows } from '../page-purge.js'
import { referencedRunIds } from './run-doc.js'

const SELECT_CHILD_RUNS = `SELECT id FROM live_pages WHERE parent_id = $1 AND kind = 'run'`
const SELECT_ALIVE_SUB = `WITH RECURSIVE sub AS (
  SELECT id FROM live_pages WHERE id = ANY($1::text[])
  UNION
  SELECT p.id FROM live_pages p JOIN sub ON p.parent_id = sub.id
) SELECT id FROM sub`
const SELECT_TRASHED_UNDER = `WITH RECURSIVE sub AS (
  SELECT id, deleted_at FROM pages WHERE id = ANY($1::text[])
  UNION
  SELECT p.id, p.deleted_at FROM pages p JOIN sub ON p.parent_id = sub.id
) SELECT id FROM sub WHERE deleted_at IS NOT NULL`
const DETACH_TRASHED = 'UPDATE pages SET parent_id = NULL WHERE id = ANY($1::text[])'

/** 删掉本文档下、已经没有任何回复块指向的过程页。返回被删的页面 id（含活子孙） */
export async function reapUnreferencedRuns(pool: Pool, pageId: string, doc: Y.Doc): Promise<string[]> {
  const keep = referencedRunIds(doc)
  const children = (await pool.query<{ id: string }>(SELECT_CHILD_RUNS, [pageId])).rows.map((r) => r.id)
  const roots = children.filter((id) => !keep.has(id))
  if (roots.length === 0) return []
  return withTransaction(pool, async (client) => {
    const alive = (await client.query<{ id: string }>(SELECT_ALIVE_SUB, [roots])).rows.map((r) => r.id)
    if (alive.length === 0) return []
    const trashed = (await client.query<{ id: string }>(SELECT_TRASHED_UNDER, [roots])).rows.map((r) => r.id)
    if (trashed.length > 0) await client.query(DETACH_TRASHED, [trashed])
    await purgePageRows(client, alive)
    return alive
  })
}
