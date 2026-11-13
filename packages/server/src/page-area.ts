// ---------- 换区：页面挪进 / 挪出私人区（PATCH /api/pages/:id 用） ----------
// 区跟着落点走（page-area-schema.ts 的触发器）：挪到父页下 = 父页的区；落在顶层 = 请求里的 private（缺省不变）。
// 这里只算「这次之后在哪一区」、判能不能挪、挪完收尾；写库由路由做（顶层用 SET_TOP_LEVEL，一条语句带着子树）。
// 公共 → 私人等于收回所有人对这一页和它子页的权限，别人也没法从回收站找回：只有页面创建人和空间 owner 能做，落进做的人的私人区。
// 私人区里的页（挪出私人区、挪进别人的私人区）只有主人能换区：分享给别人的可编辑只管内容和区内的位置，不能把主人的页带出他的私人区。
// 换区时清掉这一页上单独给的分享（公共页挪进私人区 = 收回所有人的权限；子页上单独给的保留）。

import type { Pool } from 'pg'
import { pageRole } from './page-visibility.js'
import { SELECT_SUBTREE_ALL } from './page-trash.js'

export const SET_TOP_LEVEL = 'UPDATE pages SET parent_id = NULL, private_owner = $1 WHERE id = $2'
const SELECT_AREA = 'SELECT private_owner FROM pages WHERE id = $1'
const SELECT_SPACE_OWNER = 'SELECT owner_id FROM spaces WHERE id = $1'
// 目录树是公共结构：页挪进私人区就从里面摘掉
const UNMOUNT = "DELETE FROM folder_items WHERE kind = 'page' AND item_id = ANY($1::text[])"

export const PRIVATE_ONLY_TOP = '子页跟着父页的区：要单独换区，先把它挪到顶层'
export const SKILL_NOT_PRIVATE = 'skill 页属于空间，不能放进私人区'
export const PRIVATIZE_FORBIDDEN = '只有页面的创建人和空间 owner 能把公共页挪进私人区'
export const AREA_OWNER_ONLY = '别人私人区里的页只有主人能换区'
const CLEAR_SHARES = 'DELETE FROM page_shares WHERE page_id = $1'

type AreaPage = { id: string; parent_id: string | null; owner_id: string | null; space_id: string | null; kind: string; private_owner: string | null }
type AreaBody = { parent_id?: string | null; private?: unknown }

/** 这次 PATCH 之后这页在哪一区（owner = 私人区主人，null = 公共）、变没变；不许的给原因。
 *  落点父页看不到时不在这里判（路由随后的 parentOk 统一回 400），区按不变算，免得 403 / 400 的差别泄露那一页存在 */
export async function nextArea(
  pool: Pool,
  user: { id: string },
  page: AreaPage,
  body: AreaBody,
): Promise<{ owner: string | null; changed: boolean } | { status: 400 | 403; error: string }> {
  if (body.private !== undefined && typeof body.private !== 'boolean') return { status: 400, error: 'private must be a boolean' }
  // 不挪父页也不换区（改标题、图标、排序……）：区不变，不必查库
  if (body.parent_id === undefined && body.private === undefined) return { owner: page.private_owner, changed: false }
  const parentId = body.parent_id !== undefined ? (body.parent_id ?? null) : page.parent_id
  let owner: string | null
  if (parentId !== null) {
    if (body.private !== undefined && body.parent_id === undefined) return { status: 400, error: PRIVATE_ONLY_TOP }
    if ((await pageRole(pool, user, { id: parentId })) === null) return { owner: page.private_owner, changed: false }
    owner = (await pool.query<{ private_owner: string | null }>(SELECT_AREA, [parentId])).rows[0]?.private_owner ?? null
  } else {
    owner = body.private === undefined ? page.private_owner : body.private ? user.id : null
  }
  if (owner === page.private_owner) return { owner, changed: false }
  if (page.private_owner !== null && page.private_owner !== user.id) return { status: 403, error: AREA_OWNER_ONLY }
  if (owner !== null) {
    if (page.kind === 'skill') return { status: 400, error: SKILL_NOT_PRIVATE }
    const spaceOwner = page.space_id ? (await pool.query<{ owner_id: string }>(SELECT_SPACE_OWNER, [page.space_id])).rows[0]?.owner_id : undefined
    if (page.owner_id !== user.id && spaceOwner !== user.id) return { status: 403, error: PRIVATIZE_FORBIDDEN }
  }
  return { owner, changed: true }
}

/** 换区写进库之后：挪进了私人区，清掉这一页上的分享、整棵子树从目录树里摘掉、断开这些页上的协同连接（看得到的人自动重连，看不到的在 onConnect 被拒） */
export async function areaChanged(pool: Pool, pageId: string, owner: string | null, dropAccess?: (pageIds: string[]) => void): Promise<void> {
  if (owner === null) return
  await pool.query(CLEAR_SHARES, [pageId])
  const ids = (await pool.query<{ id: string }>(SELECT_SUBTREE_ALL, [[pageId]])).rows.map((r) => r.id)
  await pool.query(UNMOUNT, [ids])
  dropAccess?.(ids)
}
