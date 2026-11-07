// ---------- 服务端替某人建页（agent 的 create_page、从模板新建、自动化的「新建页」共用） ----------
// 闸门（父页可写、同空间、模板读得到）由调用方按发起人先判，这里只做写入：
//   createDocPage：建页时没有活连接，直接写整份文档状态（同过程页归档）；不往父页正文里补入口（同 agent 建页）。
//   instantiatePage：把一页（连子页）复制到目标空间 / 父页下，排在父页现有子页之后（clone.ts 的 copyPageTree，与公开页克隆同一套）；
//     文档在事务外解析（clone.ts 的契约：事务内只做纯 DB 写）。

import type { Pool } from 'pg'
import type * as Y from 'yjs'
import { collectSubtreeIds, copyPageTree, resolveDocs } from './clone.js'
import { writeDocState } from './collab.js'
import { withTransaction } from './db.js'
import { newPageDoc } from './agents/markdown.js'
import { parseNew } from './page-write.js'
import { INSERT, SET_TITLE } from './routes/pages.js'

/** 父页下现有子页的最大排序号（复制出来的页排在它们后面） */
const MAX_POSITION = `SELECT coalesce(max(position), -1) AS max FROM live_pages WHERE parent_id IS NOT DISTINCT FROM $1 AND space_id = $2`

/** 在 parentId 下（没有 = 空间顶层）建一页：标题 + markdown 正文 */
export async function createDocPage(
  pool: Pool,
  user: { id: string },
  page: { id: string; parentId: string | null; spaceId: string; title: string; text?: string },
): Promise<void> {
  await pool.query(INSERT, [page.id, page.parentId, user.id, page.spaceId, true])
  await pool.query(SET_TITLE, [page.title, page.id])
  await writeDocState(pool, `page:${page.id}`, newPageDoc(page.title, page.text ? parseNew(page.text) : []))
}

/** 从 sourceId 复制一棵新页到 spaceId / parentId 下，返回新根页 id（源页没了 = null）。新页不是模板 */
export async function instantiatePage(
  pool: Pool,
  getLiveDoc: ((docName: string) => Y.Doc | undefined) | undefined,
  user: { id: string },
  sourceId: string,
  spaceId: string,
  parentId: string | null,
): Promise<string | null> {
  const docs = await resolveDocs(pool, getLiveDoc, await collectSubtreeIds(pool, [sourceId]))
  const base = Number((await pool.query<{ max: number }>(MAX_POSITION, [parentId, spaceId])).rows[0]?.max ?? -1) + 1
  const id = await withTransaction(pool, async (client) => {
    const { newRootIds } = await copyPageTree(client, [sourceId], spaceId, user.id, docs)
    const root = newRootIds[0]
    if (root) await client.query('UPDATE pages SET parent_id = $1, position = $2 WHERE id = $3', [parentId, base, root])
    return root
  })
  return id ?? null
}
