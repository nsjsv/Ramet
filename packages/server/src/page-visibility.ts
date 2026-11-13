// ---------- 页面可见性：谁看得到哪页、是什么角色，这一页又有哪些人看得到（服务端唯一出口） ----------
// 规则：公共区的页（private_owner 为空）给页面所在空间的成员，按空间角色；私人区的页只给它的主人，而且主人得仍是这个空间的成员
// （人被移出空间，他的私人页就谁都看不到，回来又原样出现）。此外这页或某个祖先单独分享给了谁（page_shares，可编辑 / 只读），
// 谁就看得到这一页和它的子页，角色在区给的与分享给的之间取最宽。分享即权限，不要求对方是成员：不是成员的就是这个空间的访客，
// 只有分享给的那一档（移除成员时他在这个空间收到的分享一并删掉，见 routes/spaces.ts，不会因此变成访客）。
// 空间 owner、全局 admin 都没有例外；space_id 为空的遗留孤儿页谁都看不到。
// 回收站边界不在这里：要不要算回收站里的页由调用方选 live_pages 还是 pages。
// 凡是为「这页能不能看 / 看的人是什么角色 / 该通知谁」做的判断，一律经这里（单页、批量、SQL 片段，两个方向），不要在别处直接连 space_members：
// 访客也只改这一个文件，别处漏改一处就是泄露。page-visibility.guard.test.ts 数着全仓 space_members 的出现位置守住这一条。
// 空间级的成员判定（成员与邀请管理、空间记忆、skill 库、机器、空间 AI 的配置、用量、规则发通知的收件人）不是页面可见性，不经这里。
//
// 片段拼进调用方自己的查询（各处参数编号不同，所以传别名和占位的文字）：p = 页面行（pages / live_pages）的别名，
// user = 用户 id 的 SQL（参数占位 '$2' 或列 'f.user_id'）。内部别名一律 vm，避开调用方常用的 m。

import type { Pool } from 'pg'

export type PageRole = 'owner' | 'member' | 'viewer'

/** 这页的区放不放这个人进来：公共区谁都行（再看成员），私人区只有主人 */
function areaAdmits(p: string, user: string): string {
  return `(${p}.private_owner IS NULL OR ${p}.private_owner = ${user})`
}

/** 区给的角色：页面所在空间的成员角色，且区放他进来（标量子查询，没有 = NULL） */
function areaRoleSql(p: string, user: string): string {
  return `(SELECT vm.role FROM space_members vm WHERE vm.space_id = ${p}.space_id AND vm.user_id = ${user} AND ${areaAdmits(p, user)})`
}

/** 分享给他的范围：每个分享的根连同子树（level 给了就只要这一档）。由 page_share_reach（page-share-schema.ts）从根往下展开，
 *  user 是参数时整条查询只展开一次、按哈希判 */
function sharedReach(user: string, level?: 'edit'): string {
  return `SELECT shared_id FROM page_share_reach(${user})${level ? ` WHERE shared_level = '${level}'` : ''}`
}

/** 这页分享给了他（这页或某个祖先）。先判他在这页所在的空间里有没有被分享过页（子页恒与父页同空间，分享的范围出不了根所在的空间），
 *  再展开：user 是列（一行一个人）时函数每行调一次，前一步把绝大多数行挡在外面 */
function sharedSql(p: string, user: string): string {
  return `(EXISTS (SELECT 1 FROM page_shares g JOIN pages gp ON gp.id = g.page_id WHERE g.user_id = ${user} AND gp.space_id = ${p}.space_id)
    AND ${p}.id IN (${sharedReach(user)}))`
}

/** 分享给的角色：可编辑 = member，只读 = viewer，同一页上祖先、本页各给了一次取最宽；没有 = NULL */
function shareRoleSql(p: string, user: string): string {
  return `(CASE WHEN NOT ${sharedSql(p, user)} THEN NULL WHEN ${p}.id IN (${sharedReach(user, 'edit')}) THEN 'member' ELSE 'viewer' END)`
}

/** p 自己和它的祖先（沿父链往上，至多 64 层）。只用在「一页有哪些人看得到」这种单页查询上（多页的查询里它的估算会随全库页数暴涨）。
 *  CTE 名避开调用方常用的 up（盯页面规则自己就有一个） */
function selfAndAncestors(p: string): string {
  return `WITH RECURSIVE vis_up(id, parent_id, n) AS (SELECT ${p}.id, ${p}.parent_id, 0
    UNION ALL SELECT a.id, a.parent_id, vis_up.n + 1 FROM pages a JOIN vis_up ON a.id = vis_up.parent_id WHERE vis_up.n < 64) SELECT id FROM vis_up`
}

/** 这个人在这页上的角色（标量表达式，看不到 = NULL）：区给的与分享给的取最宽。
 *  区给了 owner / member 就不必再看分享（分享最多给到 member）；空间 owner 的 owner 角色只来自公共区：别人的私人页分享给他，他也只有分享的那一档 */
export function pageRoleSql(p: string, user: string): string {
  const area = areaRoleSql(p, user)
  return `(CASE WHEN ${area} IN ('owner', 'member') THEN ${area} ELSE COALESCE(${shareRoleSql(p, user)}, ${area}) END)`
}

/** 这个人看得到这页（布尔表达式） */
export function pageVisibleSql(p: string, user: string): string {
  return `(EXISTS (SELECT 1 FROM space_members vm WHERE vm.space_id = ${p}.space_id AND vm.user_id = ${user} AND ${areaAdmits(p, user)})
    OR ${sharedSql(p, user)})`
}

/** 只留这个人看得到的页，并带出他的角色（alias.role）。接在 FROM 页面表之后 */
export function pageAccessJoin(p: string, user: string, alias: string): string {
  return `JOIN LATERAL (SELECT ${pageRoleSql(p, user)} AS role) ${alias} ON ${alias}.role IS NOT NULL`
}

/** 看得到这页的每个人一行（alias.user_id、alias.role）：通知、触发器的收件人。区给的成员与分享对象合起来，按人取最宽 */
export function pageViewersJoin(p: string, alias: string): string {
  return `JOIN LATERAL (SELECT x.user_id, (array_agg(x.r ORDER BY CASE x.r WHEN 'owner' THEN 0 WHEN 'member' THEN 1 ELSE 2 END))[1] AS role FROM (
      SELECT vm.user_id, vm.role AS r FROM space_members vm WHERE vm.space_id = ${p}.space_id AND ${areaAdmits(p, 'vm.user_id')}
      UNION ALL
      SELECT vs.user_id, CASE vs.level WHEN 'edit' THEN 'member' ELSE 'viewer' END FROM page_shares vs
        WHERE vs.page_id IN (${selfAndAncestors(p)})
    ) x GROUP BY x.user_id) ${alias} ON true`
}

/** 页面变更日志（page_changes，c = 别名）里这个人该收到的行。日志里的 space_id / private_owner 是变更时页面所在的空间与区：
 *  页搬出了他的空间、挪进了别人的私人区，搬走那一条他照样收到，客户端据此摘掉。
 *  分享给他的页（访客也是）按此刻的分享算（分享变了不改页面行、没有日志：同步的成员指纹带着「分享给我的」，变了整表重拉） */
export function changeVisibleSql(c: string, user: string): string {
  return `((${c}.space_id IN (SELECT vm.space_id FROM space_members vm WHERE vm.user_id = ${user}) AND ${areaAdmits(c, user)})
    OR ${c}.page_id IN (SELECT shared_id FROM page_share_reach(${user})))`
}

/** 这页在公共区（空间 AI 的范围只到公共区：私人页是某个人的，团队共用的 AI 碰不到） */
export function publicAreaSql(p: string): string {
  return `${p}.private_owner IS NULL`
}

const SELECT_ACCESS = `SELECT ${pageRoleSql('p', '$2')} AS role FROM live_pages p WHERE p.id = $1`
// 按页面行判：回收站里的页（恢复、永久删除前）也要知道角色，所以查 pages 而不是 live_pages
const SELECT_ROW_ROLE = `SELECT ${pageRoleSql('p', '$2')} AS role FROM pages p WHERE p.id = $1`
const SELECT_VISIBLE = `SELECT p.id, p.title, p.kind, p.space_id FROM live_pages p
  WHERE p.id = ANY($1::text[]) AND ${pageVisibleSql('p', '$2')}`
const SELECT_VIEWERS_AMONG = `SELECT v.user_id FROM pages p ${pageViewersJoin('p', 'v')}
  WHERE p.id = $1 AND v.user_id = ANY($2::text[])`

/** 页面访问角色：REST、ws 两道闸与 agent 凭证端点共用。不存在、在回收站、看不到都是 null（不泄露存在性）。
 *  入参只要 id + role：agent 凭证解出的用户没有 username 那一套，却要走同一条闸 */
export async function pageAccess(pool: Pool, pageId: string, user: { id: string; role: string }): Promise<PageRole | null> {
  const { rows } = await pool.query<{ role: PageRole | null }>(SELECT_ACCESS, [pageId, user.id])
  return rows[0]?.role ?? null
}

/** 调用方手里已经有页面行（可能在回收站里）时的角色；看不到 = null */
export async function pageRole(pool: Pool, user: { id: string }, page: { id: string }): Promise<PageRole | null> {
  const { rows } = await pool.query<{ role: PageRole | null }>(SELECT_ROW_ROLE, [page.id, user.id])
  return rows[0]?.role ?? null
}

export type VisiblePage = { id: string; title: string; kind: string; space_id: string }

/** 一批页面 id 里这个人看得见的活页（收藏、反链）。看不到的不出现在结果里，调用方不区分不存在、回收站和没权限 */
export async function visiblePages(pool: Pool, user: { id: string }, ids: string[]): Promise<Map<string, VisiblePage>> {
  if (ids.length === 0) return new Map()
  const { rows } = await pool.query<VisiblePage>(SELECT_VISIBLE, [ids, user.id])
  return new Map(rows.map((r) => [r.id, r]))
}

/** 候选人里看得到这页的那些（评论、正文里 @ 的人）：看不到的人不该收到提醒 */
export async function viewersAmong(db: Pick<Pool, 'query'>, pageId: string, userIds: readonly string[]): Promise<string[]> {
  if (userIds.length === 0) return []
  const { rows } = await db.query<{ user_id: string }>(SELECT_VIEWERS_AMONG, [pageId, [...userIds]])
  return rows.map((r) => r.user_id)
}
