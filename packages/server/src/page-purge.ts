// ---------- 物理删除页面行 + 它的 Yjs 快照与增量 ----------
// pages 删除、清空回收站、删空间、过程页回收共用这一处。runs / page_snapshots 随 pages 外键级联。
// yjs 两表没有外键，必须跟页面行一起清，否则删掉的文档还能被重放出来。

import type { PoolClient } from 'pg'

const DELETE_PAGE = 'DELETE FROM pages WHERE id = $1'
const DELETE_DOC = 'DELETE FROM yjs_documents WHERE doc_name = $1'
const DELETE_UPDATES = 'DELETE FROM yjs_updates WHERE doc_name = $1'

export async function purgePageRows(client: PoolClient, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await client.query(DELETE_PAGE, [id])
    await client.query(DELETE_DOC, [`page:${id}`])
    await client.query(DELETE_UPDATES, [`page:${id}`])
  }
}

// 物理删除整个空间：删空间路由与删号时的单人空间清理共用。空间全部页面（刻意读基表，回收站里的行也要一起物理删掉，
// 空间没了就没有归属）连同正文与历史，再删空间行（成员 / 邀请 / 目录树外键级联）。调用方负责事务。
// 接入这个空间的机器显式删并返回 id：外键级联也会删掉它们，但那样调用方拿不到 id，在线连接就断不掉
const SELECT_SPACE_PAGES = 'SELECT id FROM pages WHERE space_id = $1'
const DELETE_SPACE_CONNECTORS = 'DELETE FROM connectors WHERE space_id = $1 RETURNING id'
const DELETE_SPACE = 'DELETE FROM spaces WHERE id = $1'

/** 返回被删掉的机器 id：提交后由调用方断开它们的在线连接 */
export async function purgeSpace(client: PoolClient, spaceId: string): Promise<string[]> {
  const pages = await client.query<{ id: string }>(SELECT_SPACE_PAGES, [spaceId])
  await purgePageRows(client, pages.rows.map((page) => page.id))
  const { rows } = await client.query<{ id: string }>(DELETE_SPACE_CONNECTORS, [spaceId])
  await client.query(DELETE_SPACE, [spaceId])
  return rows.map((r) => r.id)
}
