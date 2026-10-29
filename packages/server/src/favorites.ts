// ---------- 收藏：每个用户私有的「页面或块」书签 ----------
// 对象 = 整页，或页面里的一个可寻址块（含 AI 回复、用户消息、过程页的步骤，它们都是带块 id 的块）。
// 列表不加载任何文档：块的文字（archive）和「原块还在不在」（gone）都由 collab 存储钩子在每次存页面时刷新
// （refreshFavoriteArchives，改后约 2 秒内跟上），所以改了跟着变、「改完马上删」也留着改后的样子，
// 而且列表的代价只是一次 SQL，不随收藏分布在多少页面上增长（侧栏每次挂载 / 回到前台都会拉它）。
// 原块没了，或原页看不到了（删了、回收站、被移出空间，不区分原因，不泄露存在性）就展示存档并标 gone。
// 只有自己可见：所有查询都带 user_id。本模块不依赖 collab.ts（collab 在存储钩子里调它），文档由调用方给。

import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type * as Y from 'yjs'
import { findBlockElement } from './block-ids.js'
import { visiblePages } from './page-visibility.js'
import { textOf } from './updates.js'

export type FavoriteView = {
  id: string
  pageId: string
  /** 所在页的空间：侧栏只列当前空间的收藏。原页已物理删除且加列前就收藏的为 null */
  spaceId: string | null
  /** null = 收藏的是整页 */
  blockId: string | null
  /** 块的节点类型（paragraph / agent_reply / run_step / user_message / list_item …），整页为 '' */
  blockType: string
  /** 块的当前文字（整页 = 页面标题）；gone 时是存档 */
  text: string
  /** 所在页标题；gone 时是存档 */
  title: string
  /** 原块 / 原页已经看不到了 */
  gone: boolean
  createdAt: string
}

type Row = {
  id: string
  page_id: string
  space_id: string | null
  block_id: string
  archive: string
  block_type: string
  title: string
  gone: boolean
  created_at: Date
}

/** 这页上此刻仍有权限的人的收藏（空间成员，admin 不例外，与收藏列表的 visiblePages 同口径；
 *  回收站里的页不刷新，存档停住） */
const REFRESHABLE = `SELECT f.* FROM favorites f
  JOIN live_pages p ON p.id = f.page_id
  JOIN space_members m ON m.space_id = p.space_id AND m.user_id = f.user_id
  WHERE f.page_id = $1`

const TEXT_MAX = 200
const LIST_MAX = 500

/** 块的展示文字：折叠空白、截断 */
export const blockSnippet = (el: Y.XmlElement): string => textOf(el).replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX)

/** 此人的全部收藏（新的在前）。一次 SQL + 一次批量可见性判断，不碰文档 */
export async function listFavorites(pool: Pool, user: { id: string; role: string }): Promise<FavoriteView[]> {
  const { rows } = await pool.query<Row>('SELECT * FROM favorites WHERE user_id = $1 ORDER BY created_at DESC, id LIMIT $2', [user.id, LIST_MAX])
  const visible = await visiblePages(pool, user, [...new Set(rows.map((r) => r.page_id))])
  return rows.map((r) => {
    const page = visible.get(r.page_id)
    const base = { id: r.id, pageId: r.page_id, spaceId: r.space_id, blockId: r.block_id || null, createdAt: r.created_at.toISOString() }
    if (!page) return { ...base, blockType: r.block_type, text: r.archive, title: r.title, gone: true }
    if (!r.block_id) return { ...base, blockType: '', text: page.title, title: page.title, gone: false }
    return { ...base, blockType: r.block_type, text: r.archive, title: page.title, gone: r.gone }
  })
}

export type AddResult = { ok: true; id: string } | { ok: false; status: 404; error: string }

/** 收藏一页或一个块（已收藏则幂等返回同一条并刷新存档）。目标必须此人看得见；块必须在当前正文里 */
export async function addFavorite(
  pool: Pool,
  user: { id: string; role: string },
  pageId: string,
  blockId: string,
  readBody: (pageId: string) => Promise<Y.XmlFragment>,
): Promise<AddResult> {
  const page = (await visiblePages(pool, user, [pageId])).get(pageId)
  if (!page) return { ok: false, status: 404, error: 'page not found' }
  let archive = page.title
  let blockType = ''
  if (blockId) {
    const el = findBlockElement(await readBody(pageId), blockId)
    if (!el) return { ok: false, status: 404, error: 'block not found' }
    archive = blockSnippet(el)
    blockType = el.nodeName
  }
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO favorites (id, user_id, page_id, space_id, block_id, archive, block_type, title) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, page_id, block_id) DO UPDATE SET space_id = EXCLUDED.space_id, archive = EXCLUDED.archive, block_type = EXCLUDED.block_type, title = EXCLUDED.title, gone = false
     RETURNING id`,
    [randomUUID(), user.id, pageId, page.space_id, blockId, archive, blockType, page.title],
  )
  return { ok: true, id: rows[0]!.id }
}

/** 取消收藏（只能删自己的） */
export async function removeFavorite(pool: Pool, userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM favorites WHERE id = $1 AND user_id = $2', [id, userId])
  return Boolean(rowCount)
}

/** 存页面时刷新这页上（仍有权限的人的）收藏：块还在 → 存档换成它现在的文字、gone 清掉；块没了 → gone 置上、存档不动（那正是存档要留着的东西）。
 *  整页收藏的存档是标题。没有收藏时只是一次带索引的空查询 */
export async function refreshFavoriteArchives(pool: Pool, pageId: string, body: Y.XmlFragment, title: string): Promise<void> {
  // 只刷新此刻还看得见这页的人的收藏：被移出空间的人，存档停在他最后能看见的时候，之后原块再怎么改都不能漏给他
  const { rows } = await pool.query<Row>(REFRESHABLE, [pageId])
  for (const r of rows) {
    let archive = r.archive
    let blockType = r.block_type
    let gone = false
    if (r.block_id) {
      const el = findBlockElement(body, r.block_id)
      if (el) {
        archive = blockSnippet(el)
        blockType = el.nodeName
      } else gone = true
    } else archive = title
    if (archive !== r.archive || blockType !== r.block_type || title !== r.title || gone !== r.gone) {
      await pool.query('UPDATE favorites SET archive = $2, block_type = $3, title = $4, gone = $5 WHERE id = $1', [r.id, archive, blockType, title, gone])
    }
  }
}
