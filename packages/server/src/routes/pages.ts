import { Hono } from 'hono'
import type { Pool } from 'pg'
import * as Y from 'yjs'
import { withTransaction } from '../db.js'
import { purgePageRows } from '../page-purge.js'
import { requireAuth, type AuthEnv, type AuthUser } from '../auth.js'
import { extractTitle, insertSnapshot, loadDocFromDb, materializeSnapshot, writeDocState, type DocWriter } from '../collab.js'
import { linkInParent, needsEntry, unlinkFromParent } from '../page-entry.js'
import { newPageDoc } from '../agents/markdown.js'
import { myPersonalSpaceId } from '../clone.js'
import { iconParams, isIconSourceMime, parseIconInput, SELECT_ICON_SOURCE_MIME, SET_PAGE_ICON, apiPageColumns, rowIcon, toApiPage } from '../page-icon.js'
import { summarizeChange, summaryState, SUMMARY_ITEM_LIMIT, type SummaryItem, type SummaryState } from '../updates.js'
import { readEditMarks } from '../edit-marks.js'
import { restorePageSubtree, SELECT_SUBTREE_ALL, TRASH_ENTRY_PREDICATE, trashPageSubtree } from '../page-trash.js'
import { SELECT_ALL_MINE, syncPages } from '../page-sync.js'

// 用 type 而非 interface:pg 的 query<T> 约束要求隐式索引签名,interface 给不了
/** 页面闸门只看身份与角色（REST 的登录用户与 AI 凭证对应的用户都满足） */
export type Actor = Pick<AuthUser, 'id' | 'role'>

export type PageRow = {
  id: string
  parent_id: string | null
  owner_id: string | null
  space_id: string | null
  title: string
  published: boolean
  created_at: string
  // live_pages 视图里恒为 null(活页面);只有直接读基表的物理删除判据会带回回收时刻
  deleted_at: string | null
  // 页面图标:两列由 DB 约束保证至多一个非空;对外经 toApiPage 只呈 icon 单字段
  icon_emoji: string | null
  icon_file_id: string | null
  // 'doc' | 'run'(过程归档页,见 agents/runs.ts)| 'skill'(空间 skill,见 skills.ts)。后两者恒不 published
  kind: string
  /** 发布时是否连过程页一起公开(只对 doc 页有意义) */
  publish_includes_runs: boolean
  /** false = 目录树自建文档:属于空间,但不进页面树(子孙由祖先链跟着排除) */
  in_page_tree: boolean
  /** 全宽:正文铺满画面(不收 720 列) */
  full_width: boolean
}

type SpaceRole = 'owner' | 'member' | 'viewer'

// 回收站条目:被删子树的根(见 TRASH_ENTRY_PREDICATE);deleted_at = 回收时刻(now()::text)。
// parent_id = 原位置(条目的父必是活页面或空,前端按页面树现算路径);descendants = 子树里随它一起进来的
// doc 页数(过程页 / skill 页不算,只数用户看得见的页)
type TrashRow = {
  id: string
  title: string
  space_id: string | null
  parent_id: string | null
  kind: string
  deleted_at: string
  icon_emoji: string | null
  icon_file_id: string | null
  descendants: number
}

// 快照列表行(origin: 'auto'|'manual');详情多 data = 服务端物化后的 Yjs 全量 update 的 base64
type SnapshotRow = {
  id: string
  title: string
  origin: string
  created_at: string
}

// 更新流水条目:一条快照相对其上一条的块级差异摘要。
// author 两字段在未知编辑者时为 NULL。actor=agent 时展示名看 actor_agent,不看用户名。
// summary 截 SUMMARY_ITEM_LIMIT 项,total 记截断前项数
type UpdateEntry = {
  id: string
  title: string
  origin: string
  created_at: string
  author_id: string | null
  author_username: string | null
  actor: 'user' | 'agent'
  actor_agent: string | null
  summary: SummaryItem[]
  summary_total: number
}

// ---------- SQL 常量 ----------

// 活页面读路径一律走 live_pages 视图(唯一读边界,见 db.ts DDL),已回收页面天然不可见,不必每处再判 deleted_at。
// 页面列表的查询(SELECT_ALL_MINE,含隔离与排序口径)定义在 page-sync.ts:整表与增量同步共用一份
export const SELECT = 'SELECT * FROM live_pages WHERE id = $1'
/** 响应里的单个页面(建页 / 改页 / 建集合):对外字段,同 SELECT_ALL_MINE */
export const SELECT_API_PAGE = `SELECT ${apiPageColumns('p')} FROM live_pages p WHERE p.id = $1`
export const INSERT = 'INSERT INTO pages (id, parent_id, owner_id, space_id, in_page_tree) VALUES ($1, $2, $3, $4, $5)'
export const SET_TITLE = 'UPDATE pages SET title = $1 WHERE id = $2'
export const SET_PARENT = 'UPDATE pages SET parent_id = $1 WHERE id = $2'
const SET_PUBLISHED = 'UPDATE pages SET published = $1 WHERE id = $2'
const SET_PUBLISH_INCLUDES_RUNS = 'UPDATE pages SET publish_includes_runs = $1 WHERE id = $2'
const SELECT_MEMBER_ROLE = 'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2'
// 子树收集 / 条目谓词 / 回收与恢复动作的唯一定义在 page-trash.ts(存储钩子也要用,不能依赖本文件)
// 只看自己参与的空间里的条目:回收站列表是列举类读路径,与页面列表同一隔离口径
const SELECT_TRASH_MINE = `SELECT p.id, p.title, p.space_id, p.parent_id, p.kind, p.deleted_at, p.icon_emoji, p.icon_file_id,
    (WITH RECURSIVE sub AS (
        SELECT c.id, c.kind FROM pages c WHERE c.parent_id = p.id
        UNION ALL
        SELECT c.id, c.kind FROM pages c JOIN sub ON c.parent_id = sub.id)
      SELECT count(*)::int FROM sub WHERE sub.kind = 'doc') AS descendants
  FROM pages p
  WHERE ${TRASH_ENTRY_PREDICATE}
    AND p.space_id IN (SELECT space_id FROM space_members WHERE user_id = $1)
  ORDER BY p.deleted_at DESC, p.id`
// restore 守卫:目标必须(此刻)是条目本身 —— 已回收页面的子孙不是条目,不能单独恢复(会还原成孤儿)
const SELECT_TRASH_ENTRY = `SELECT p.* FROM pages p
  WHERE p.id = $1 AND ${TRASH_ENTRY_PREDICATE}`
// 物理删活的子树前,把其中的回收条目摘成顶层:父行被删时外键级联不能把它们(及其正文与历史)一起吞掉。
// 只摘"父不是回收行"的那些(真正的条目根),条目内部的子孙保持原父子关系 —— 回收站里仍是一个条目
const DETACH_TRASHED = `UPDATE pages SET parent_id = NULL
  WHERE deleted_at IS NOT NULL AND id = ANY($1::text[]) AND NOT EXISTS (
    SELECT 1 FROM pages a WHERE a.id = pages.parent_id AND a.deleted_at IS NOT NULL)`
// 物理删除的目标判据:活页面(link-watcher 的自动清理)或回收站条目(UI「永久删除」)。
// 已回收页面的子孙不是条目 —— 直接物理删它等于绕过条目销毁子树的一部分,一律 404
const SELECT_PURGE_TARGET = `SELECT p.* FROM pages p
  WHERE p.id = $1 AND (p.deleted_at IS NULL OR NOT EXISTS (
    SELECT 1 FROM pages a WHERE a.id = p.parent_id AND a.deleted_at IS NOT NULL))`
const SELECT_SPACE_TRASH = 'SELECT id FROM pages WHERE space_id = $1 AND deleted_at IS NOT NULL'
// 页面快照三端点:列表/详情任意角色可见,POST 手动存版需可写;倒序 = 链序倒排(created_at 页内严格递增)
// 分页:before 游标 = 上一页最后一条的 created_at(页内严格递增且唯一,不必再拿 id 兜 tie);
// 不传游标 = 首页(最新 limit 条)
const SELECT_SNAPSHOTS_HEAD = `SELECT id, title, origin, created_at FROM page_snapshots
  WHERE page_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`
const SELECT_SNAPSHOTS_PAGE = `SELECT id, title, origin, created_at FROM page_snapshots
  WHERE page_id = $1 AND created_at < $2::text ORDER BY created_at DESC, id DESC LIMIT $3`
// around=<sid>:以该快照为中心各取 limit 条(更新流水的时钟跳转要能定位到任意历史条目),
// 目标本身落在「≤ 目标」那一侧,所以必然带回它的前一条(前端 diff 需要上一版)
const SELECT_SNAPSHOTS_LE = `SELECT id, title, origin, created_at FROM page_snapshots
  WHERE page_id = $1 AND created_at <= (SELECT created_at FROM page_snapshots WHERE id = $2 AND page_id = $1)
  ORDER BY created_at DESC, id DESC LIMIT $3`
const SELECT_SNAPSHOTS_GT = `SELECT id, title, origin, created_at FROM page_snapshots
  WHERE page_id = $1 AND created_at > (SELECT created_at FROM page_snapshots WHERE id = $2 AND page_id = $1)
  ORDER BY created_at ASC, id ASC LIMIT $3`
const SELECT_SNAPSHOT = `SELECT id, title, origin, created_at FROM page_snapshots
  WHERE id = $1 AND page_id = $2`
// 更新流水的有界窗口:最新 limit 条(可选 before 游标限定更早范围),倒序取。
// LEFT JOIN users 出作者名(未知编辑者 author_id NULL → username 也 NULL)
const SELECT_UPDATES_WINDOW = `SELECT s.id, s.title, s.origin, s.created_at, s.data, s.author_id,
  u.username AS author_username, s.actor, s.actor_agent
  FROM page_snapshots s LEFT JOIN users u ON u.id = s.author_id
  WHERE s.page_id = $1 AND ($2::text IS NULL OR s.created_at < $2::text)
  ORDER BY s.created_at DESC, s.id DESC LIMIT $3`
// 回放起点:窗口首行之前最近的一个检查点(全量行)。NULL = 窗口已含链首行(无前驱,摘要按"创建了")
const SELECT_UPDATES_BASE = `SELECT max(created_at) AS at FROM page_snapshots
  WHERE page_id = $1 AND is_base AND created_at < $2::text`
// 回放片段:[起点, 窗口首行) 的链序行,只为把状态推进到窗口首行的前一行(不产摘要),
// 行数 ≤ 检查点间隔;title 要取,它是窗口首条摘要的标题基线
const SELECT_UPDATES_SLICE = `SELECT title, data FROM page_snapshots
  WHERE page_id = $1 AND created_at >= $2::text AND created_at < $3::text
  ORDER BY created_at ASC, id ASC`

// 可见 = 有任意角色;可写 = owner|member,viewer 只能看。boards.ts 目录树写门共用(勿另写一份)
export function writable(role: SpaceRole | null): boolean {
  return role === 'owner' || role === 'member'
}

// 回收动作的唯一实现在 page-trash.ts;这里转出,boards.ts / 集合 / ramet-tools 从本文件取
export { trashPageSubtree }

// 历史窗口大小:缺省 50(一屏够用),上限 200 —— 窗口越大服务端要回放的状态越多
// (≤ 检查点间隔 + limit),上限是回放成本的闸门
const HISTORY_LIMIT_DEFAULT = 50
const HISTORY_LIMIT_MAX = 200
// 历史分页参数(历史版本列表与更新流水共用同一套契约):limit 缺省/非法取默认、超上限截断,
// before 游标缺省为 null(取第一页)。版本永不删除,所以不能有「无界历史响应」这条路,
// 客户端要全量,服务端也只给窗口
function historyPage(limitRaw: string | undefined, beforeRaw: string | undefined): { limit: number; before: string | null } {
  const n = Number(limitRaw)
  return {
    limit: Number.isInteger(n) && n > 0 ? Math.min(n, HISTORY_LIMIT_MAX) : HISTORY_LIMIT_DEFAULT,
    before: beforeRaw ?? null,
  }
}

// 请求者在某空间的有效角色:按成员行给,非成员/无空间(null)一律 null = 不可见。
// 全局 admin 没有例外。
// 模块级:boards.ts 的目录树门型也要判空间角色(共用同一份定义)
export async function roleInSpace(
  pool: Pool,
  user: Actor,
  spaceId: string | null,
): Promise<SpaceRole | null> {
  if (spaceId === null) return null
  const { rows } = await pool.query<{ role: SpaceRole }>(SELECT_MEMBER_ROLE, [spaceId, user.id])
  return rows[0]?.role ?? null
}

/** 页面可见性闸门（页面读写的唯一不变量，所有页面闸门经此）：
 *  页面恒属一个空间 → 按空间成员角色，admin 也不例外。返回 null = 不可见（与不存在同响应）；
 *  没有空间的迁移前遗留行谁都看不到。 */
export async function pageRole(
  pool: Pool,
  user: Actor,
  page: { space_id: string | null },
): Promise<SpaceRole | null> {
  return roleInSpace(pool, user, page.space_id)
}

// null 表示"顶层";其余必须指向存在的页面,且不能是自己或自己的子孙(成环)。
// WITH RECURSIVE 沿 parent 链一次取全祖先;UNION 去重保证库里已有环时递归也会终止。
// 与 parentOk 一起是页面树写入的闸门（REST 与 AI 的知识中枢工具共用，勿另写一份）
export async function validParent(pool: Pool, pageId: string, parentId: string | null): Promise<boolean> {
  if (parentId === null) return true
  const { rows } = await pool.query(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id FROM live_pages WHERE id = $2
       UNION
       SELECT p.id, p.parent_id FROM live_pages p JOIN ancestors a ON p.id = a.parent_id
     )
     SELECT 1 FROM ancestors WHERE id = $1 LIMIT 1`,
    [pageId, parentId],
  )
  return rows.length === 0
}

// parent 闸门(创建/移动共用):parent 必须可见,且与页面同属一个空间;违规与"不存在"同响应
export async function parentOk(
  pool: Pool,
  user: Actor,
  parentId: string | null,
  pageSpaceId: string | null,
): Promise<boolean> {
  if (parentId === null) return true
  if (typeof parentId !== 'string') return false
  const parent = (await pool.query<PageRow>(SELECT, [parentId])).rows[0]
  if (!parent) return false
  const role = await roleInSpace(pool, user, parent.space_id)
  return role !== null && parent.space_id === pageSpaceId
}

// notify:树变更广播回调(注入 notifyPagesChanged,测试可不传保持原签名)。
// 只在写库成功的端点调,GET 不通知 —— 广播给 control:global 让各端免刷新跟树。
// getLiveDoc:内存活文档查找(注入 hocuspocus.documents.get,测试可不传走 DB 重建分支),
// 手动快照取当前内容时优先用活文档,避免重放增量。
// notifyBoards:恢复的页面可能挂在目录里,而目录树列表不含回收站里的页,得让各端重拉一次
export function pagesRoutes(
  pool: Pool,
  notify?: () => void,
  getLiveDoc?: (docName: string) => Y.Doc | undefined,
  notifyBoards?: () => void,
  /** 改父子关系时在父页正文补 / 摘子页面块（page-entry.ts）；缺省 = 不维护入口（只有不走这类写的测试才缺省） */
  write?: DocWriter,
) {
  // 该子应用只有 /api/pages 一族路由,鉴权统一挂全量,未登录一律 401
  const app = new Hono<AuthEnv>()
  app.use('*', requireAuth(pool))

  // 快照三端点共用的可见性闸门:页面不存在/非成员一律 404(不泄露存在性,与现有风格一致)
  async function visiblePage(user: AuthUser, id: string): Promise<PageRow | null> {
    const page = (await pool.query<PageRow>(SELECT, [id])).rows[0]
    if (!page) return null
    const role = await pageRole(pool, user, page)
    return role === null ? null : page
  }

  // 取页面当前内容:内存有活文档(协同中)直接用;否则从 DB 重建(快照+重放增量,与 onLoadDocument 同构)。
  // 标题用 extractTitle(与列表展示同源)
  async function captureDoc(docName: string): Promise<{ doc: Y.Doc; title: string }> {
    const live = getLiveDoc?.(docName)
    const doc = live ?? (await loadDocFromDb(pool, docName))
    return { doc, title: extractTitle(doc) }
  }

  // 增量同步:带上次的 cursor / members 只拉变过的页;缺省、过旧或成员关系变了给整表(见 page-sync.ts)。
  // GET /api/pages 仍返回整表数组
  app.get('/api/pages/sync', async (c) => {
    const user = c.get('user')
    return c.json(await syncPages(pool, user.id, c.req.query('since'), c.req.query('members')))
  })

  app.get('/api/pages', async (c) => {
    const user = c.get('user')
    // 列表按空间成员关系隔离(见 SELECT_ALL_MINE)
    const rows = (await pool.query<PageRow>(SELECT_ALL_MINE, [user.id])).rows
    // 图标两列只以派生的 icon 单字段出去(唯一定义处 page-icon.ts)
    return c.json(rows.map(toApiPage))
  })

  app.post('/api/pages', async (c) => {
    const user = c.get('user')
    const body = (await c.req.json().catch(() => ({}))) as {
      parent_id?: string | null
      space_id?: string | null
      in_page_tree?: unknown
      title?: unknown
      link_in_parent?: unknown
    }
    const parentId = body.parent_id ?? null
    // 带标题建页（`[[新名字` 直接建页）：标题同时写进 pages.title 与文档的 title 片段 —— 编辑器以文档为准，
    // 只写其一，打开页面标题会被空文档冲掉。缺省 = 空页（标题由用户在编辑器里打）
    if (body.title !== undefined && typeof body.title !== 'string') return c.json({ error: 'title must be a string' }, 400)
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    // 缺省 true = 页面树成员。目录树「创建文档」显式传 false:页仍落本空间,只是不进页面树
    let inPageTree = true
    if (body.in_page_tree !== undefined) {
      if (typeof body.in_page_tree !== 'boolean') return c.json({ error: 'in_page_tree must be a boolean' }, 400)
      inPageTree = body.in_page_tree
    }
    // 目标空间:页面恒属一个空间,缺省落我个人空间;给了就校验(存在 + 可写)。
    // 不接受 `space_id: null`,无空间页面在模型上不可达
    let spaceId: string
    if (body.space_id !== undefined) {
      if (typeof body.space_id !== 'string') return c.json({ error: 'space_id must be a string' }, 400)
      if (!(await pool.query('SELECT 1 FROM spaces WHERE id = $1', [body.space_id])).rows[0]) {
        return c.json({ error: 'space_id not found' }, 400)
      }
      const role = await roleInSpace(pool, user, body.space_id)
      // viewer 只能看 403;非成员与"空间不存在"同响应,不泄露存在性
      if (role === 'viewer') return c.json({ error: 'forbidden' }, 403)
      if (role === null) return c.json({ error: 'space_id not found' }, 400)
      spaceId = body.space_id
    } else {
      const personal = await myPersonalSpaceId(pool, user.id)
      if (!personal) return c.json({ error: 'personal space unavailable' }, 500)
      spaceId = personal
    }
    // parent 必须可见且与页面同空间
    if (!(await parentOk(pool, user, parentId, spaceId))) {
      return c.json({ error: 'parent_id not found' }, 400)
    }
    const id = crypto.randomUUID()
    // owner_id 照旧写入,但不参与可见性判定
    await pool.query(INSERT, [id, parentId, user.id, spaceId, inPageTree])
    if (title) {
      await pool.query(SET_TITLE, [title, id])
      await writeDocState(pool, `page:${id}`, newPageDoc(title, []))
    }
    // 子页入口：缺省由服务端补在父页正文末尾。斜杠「创建页面」/ `[[新名字` 自己在光标处插入口（子页面块 / 提及），
    // 传 link_in_parent: false，否则父页里会多出一个。补不上就把刚建的页删掉再报错，不留父页里找不到的子页
    if (body.link_in_parent !== false && write && (await needsEntry(pool, parentId, 'doc'))) {
      try {
        await linkInParent(pool, { write, user }, parentId!, id)
      } catch (err) {
        console.error('[pages] link new child into parent failed, dropping it', err)
        await withTransaction(pool, (client) => purgePageRows(client, [id]))
        return c.json({ error: 'failed to link page into parent' }, 500)
      }
    }
    notify?.()
    return c.json(toApiPage((await pool.query<PageRow>(SELECT_API_PAGE, [id])).rows[0]!), 201)
  })

  app.patch('/api/pages/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const page = (await pool.query<PageRow>(SELECT, [id])).rows[0]
    const role = page ? await pageRole(pool, user, page) : null
    // 非成员与不存在同响应 404,不泄露存在性
    if (!page || role === null) return c.json({ error: 'page not found' }, 404)
    // 可见但只读(viewer)403
    if (!writable(role)) return c.json({ error: 'forbidden' }, 403)
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string
      parent_id?: string | null
      icon?: unknown
      index?: unknown
      is_template?: unknown
      full_width?: unknown
    }
    let written = false
    // 全宽：页面属性，写了就广播（协作者的列宽跟着变）
    if (body.full_width !== undefined) {
      if (typeof body.full_width !== 'boolean') return c.json({ error: 'full_width must be a boolean' }, 400)
      await pool.query('UPDATE pages SET full_width = $1 WHERE id = $2', [body.full_width, id])
      written = true
    }
    // 设为模板 / 取消模板：只是让它出现在「从模板新建」列表里
    if (body.is_template !== undefined) {
      if (typeof body.is_template !== 'boolean') return c.json({ error: 'is_template must be a boolean' }, 400)
      await pool.query('UPDATE pages SET is_template = $1 WHERE id = $2', [body.is_template, id])
      written = true
    }
    if (body.title !== undefined) {
      if (typeof body.title !== 'string') return c.json({ error: 'title must be a string' }, 400)
      await pool.query(SET_TITLE, [body.title, id])
      written = true
    }
    // 图标:undefined = 不动;null = 清除;{kind,value} = 设置。
    // 格式校验在 page-icon.ts,图片源必须是已存在的图片文件(否则必然破图);
    // 两道都过了才写,一条 UPDATE 同时写两列,DB 互斥约束不会被中间态触发
    if (body.icon !== undefined) {
      const parsed = parseIconInput(body.icon)
      if (!parsed.ok) return c.json({ error: parsed.error }, 400)
      if (parsed.icon?.kind === 'image') {
        const mime = (await pool.query<{ mime: string }>(SELECT_ICON_SOURCE_MIME, [parsed.icon.value])).rows[0]?.mime
        if (!isIconSourceMime(mime)) return c.json({ error: 'icon file not found' }, 400)
      }
      await pool.query(SET_PAGE_ICON, [...iconParams(parsed.icon), id])
      written = true
    }
    if (body.parent_id !== undefined) {
      const parentId = body.parent_id ?? null
      // 空间顶层页(parent_id NULL)是合法状态,所以允许置 null;parent 合法性只由 parentOk / validParent 两道校验定义。
      // parent 必须可见,且与页面同属一个空间(跨空间移动一律拒绝)
      if (!(await parentOk(pool, user, parentId, page.space_id))) {
        return c.json({ error: 'parent_id not found' }, 400)
      }
      if (!(await validParent(pool, id, parentId))) return c.json({ error: 'parent_id would create a cycle' }, 400)
      await pool.query(SET_PARENT, [parentId, id])
      written = true
      // 换了父页：新父页正文补入口（补不上把父子关系改回去再报错），旧父页的入口摘掉
      const oldParent = page.parent_id ?? null
      if (write && oldParent !== parentId) {
        if (await needsEntry(pool, parentId, page.kind)) {
          try {
            await linkInParent(pool, { write, user }, parentId!, id)
          } catch (err) {
            console.error('[pages] link moved page into new parent failed, reverting', err)
            await pool.query(SET_PARENT, [oldParent, id])
            return c.json({ error: 'failed to link page into parent' }, 500)
          }
        }
        if (page.kind === 'doc') await unlinkFromParent(pool, { write, user }, oldParent, id)
      }
    }
    // 同级排序(侧栏拖拽插入线):index = 该页在目标父页子列表(按展示序)里的落点下标。
    // 摘除自身后钳制插入,整列重写 position 0..n-1(单事务);不传 index 不动排序。
    // 只传 index 不传 parent_id = 同父内重排
    if (body.index !== undefined) {
      if (typeof body.index !== 'number' || !Number.isInteger(body.index) || body.index < 0) {
        return c.json({ error: 'index must be a non-negative integer' }, 400)
      }
      const targetParent = body.parent_id !== undefined ? body.parent_id ?? null : page.parent_id ?? null
      if (page.space_id === null) return c.json({ error: 'page has no space' }, 400)
      // 兄弟列表必须限同一空间(同级=同空间,服务端约束;缺过滤会把别的用户的同级页一起重排!)。
      // 只算页面树成员:前端下标按页面树算,根级的目录树文档算进来落点就错位
      const kids = (
        await pool.query<{ id: string }>(
          `SELECT id FROM live_pages WHERE parent_id IS NOT DISTINCT FROM $1 AND space_id = $2 AND in_page_tree AND id <> $3
           ORDER BY position ASC NULLS LAST, created_at, id`,
          [targetParent, page.space_id, id],
        )
      ).rows.map((r) => r.id)
      const at = Math.min(body.index, kids.length)
      kids.splice(at, 0, id)
      console.log('[reindex] targetParent=', targetParent, 'kids=', kids.map((k, i) => `${i}:${k.slice(0, 8)}`).join(','))
      await withTransaction(pool, async (client) => {
        for (let i = 0; i < kids.length; i++) {
          await client.query('UPDATE pages SET position = $1 WHERE id = $2', [i, kids[i]!])
        }
      })
      written = true
    }
    // 实际写库才广播,空 body 的 PATCH 静默
    if (written) notify?.()
    return c.json(toApiPage((await pool.query<PageRow>(SELECT_API_PAGE, [id])).rows[0]!))
  })

  // 公开/取消公开:发布页面即发布整棵子树(匿名经 /api/public 可达),取消发布整棵收回。
  // 仅空间 owner 可切换;member/viewer 403,非成员与不存在同响应 404 不泄露存在性
  app.patch('/api/pages/:id/publish', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => null)) as { published?: unknown; includeRuns?: unknown } | null
    if (typeof body?.published !== 'boolean') return c.json({ error: 'published must be a boolean' }, 400)
    if (body.includeRuns !== undefined && typeof body.includeRuns !== 'boolean') {
      return c.json({ error: 'includeRuns must be a boolean' }, 400)
    }
    const page = (await pool.query<PageRow>(SELECT, [id])).rows[0]
    const role = page ? await pageRole(pool, user, page) : null
    if (!page || role === null) return c.json({ error: 'page not found' }, 404)
    if (role !== 'owner') return c.json({ error: 'forbidden' }, 403)
    // 公开态只有 doc 页承载(身份由 kind 表达,DB 约束是兜底):过程页只能跟着父文档的
    // includeRuns 开关走,skill 页是空间内部的做事方法 —— 都不给单独发布的入口
    if (page.kind !== 'doc') return c.json({ error: `${page.kind} page cannot be published` }, 400)
    await pool.query(SET_PUBLISHED, [body.published, id])
    // 「连过程一起公开」随同一次操作写入:发布开关与发布态是同一个意图的两个字段
    if (typeof body.includeRuns === 'boolean') await pool.query(SET_PUBLISH_INCLUDES_RUNS, [body.includeRuns, id])
    // 公开态影响匿名可达性,广播树变更(在线端刷新分享弹层状态)
    notify?.()
    return c.json(toApiPage((await pool.query<PageRow>(SELECT_API_PAGE, [id])).rows[0]!))
  })

  // 删页拆成两个语义,由端点显式区分:
  //   POST /:id/trash    用户删页 = 移入回收站(可恢复,正文与版本历史原地保留)
  //   DELETE /:id        彻底删除 = 物理清 pages/yjs 两表(快照外键级联)—— 回收站 UI 的"永久删除"
  //                      与 link-watcher 的自动清理走这里

  // 回收站列表:一条 = 一次删除搬进来的整棵子树的根(谓词唯一定义在 TRASH_ENTRY_PREDICATE)。
  // 只在自己参与的空间里(与页面列表同一隔离口径)
  app.get('/api/pages/trash', async (c) => {
    const user = c.get('user')
    // 条目同样带图标(回收站列表显示页面图标)
    const rows = (await pool.query<TrashRow>(SELECT_TRASH_MINE, [user.id])).rows
    // 回收站条目不是页面形状(多 deleted_at / descendants):不过 toApiPage 的白名单,图标两列自己折成 icon
    return c.json(rows.map(({ icon_emoji, icon_file_id, ...rest }) => ({ ...rest, icon: rowIcon({ icon_emoji, icon_file_id }) })))
  })

  // 移入回收站(软删):只盖章活的子树 —— 回收页面的子孙必然全已回收,
  // 正文(yjs 两表)与版本历史一律不动(历史只在彻底删除时清)。
  // 已回收页面对 SELECT(live_pages)不可见 → 与"不存在"同响应 404,重复调用天然幂等
  app.post('/api/pages/:id/trash', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const page = (await pool.query<PageRow>(SELECT, [id])).rows[0]
    const role = page ? await pageRole(pool, user, page) : null
    if (!page || role === null) return c.json({ error: 'page not found' }, 404)
    if (!writable(role)) return c.json({ error: 'forbidden' }, 403)
    const trashed = await trashPageSubtree(pool, [id], notify)
    return c.json({ trashed })
  })

  // 恢复:目标必须是回收站条目本身(已回收页面的子孙不是条目 —— 单独恢复会还原成孤儿,404)。
  // 恢复整棵子树(清 deleted_at):行从未离开 pages,父子关系与空间归属原地保留,历史照旧
  app.post('/api/pages/:id/restore', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const entry = (await pool.query<PageRow>(SELECT_TRASH_ENTRY, [id])).rows[0]
    const role = entry ? await pageRole(pool, user, entry) : null
    if (!entry || role === null) return c.json({ error: 'page not found' }, 404)
    if (!writable(role)) return c.json({ error: 'forbidden' }, 403)
    const restored = await restorePageSubtree(pool, id, notify)
    notifyBoards?.()
    return c.json({ restored })
  })

  // 清空回收站:一次清掉某个空间回收站里的全部条目(空间是回收站的归属维度)。
  // 这是物理删除 —— 页面及其正文、版本历史一并清掉(允许清历史的时刻之一)
  app.delete('/api/pages/trash', async (c) => {
    const user = c.get('user')
    const spaceId = c.req.query('space_id')
    if (!spaceId) return c.json({ error: 'space_id is required' }, 400)
    if (!(await pool.query('SELECT 1 FROM spaces WHERE id = $1', [spaceId])).rows[0]) {
      return c.json({ error: 'space not found' }, 404)
    }
    // 非成员与空间不存在同响应(不泄露存在性);viewer 只读 403
    const role = await roleInSpace(pool, user, spaceId)
    if (role === null) return c.json({ error: 'space not found' }, 404)
    if (!writable(role)) return c.json({ error: 'forbidden' }, 403)
    const ids = (await pool.query<{ id: string }>(SELECT_SPACE_TRASH, [spaceId])).rows.map((r) => r.id)
    if (ids.length > 0) {
      await withTransaction(pool, async (client) => {
        await purgePageRows(client, ids)
      })
      notify?.()
    }
    return c.json({ purged: ids })
  })

  app.delete('/api/pages/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    // 目标 = 活页面或回收站条目(见 SELECT_PURGE_TARGET);已回收页面的子孙一律 404
    const page = (await pool.query<PageRow>(SELECT_PURGE_TARGET, [id])).rows[0]
    const role = page ? await pageRole(pool, user, page) : null
    // 非成员与不存在同响应 404;viewer 可见但只读 403
    if (!page || role === null) return c.json({ error: 'page not found' }, 404)
    if (!writable(role)) return c.json({ error: 'forbidden' }, 403)
    // 子树一次收全:目标本身的状态决定两种语义 ——
    //   目标活着(link-watcher 自动清理):删它和它的活子树;子树里已回收的条目摘顶层保留,
    //     否则父行被物理删除时外键级联会把用户放在回收站里的正文与历史一起吞掉
    //   目标是回收站条目(UI「永久删除」):条目及其整棵子树本就是同一次删除搬进来的,全删
    // 越权面只在被删页面本身(上面已校验);同空间约束下子树全在同一空间,子孙沿树级联。
    const subtree = (await pool.query<{ id: string; deleted_at: string | null }>(SELECT_SUBTREE_ALL, [[id]])).rows
    const purgeAll = page.deleted_at !== null
    const alive = purgeAll ? subtree.map((r) => r.id) : subtree.filter((r) => r.deleted_at === null).map((r) => r.id)
    const trashed = purgeAll ? [] : subtree.filter((r) => r.deleted_at !== null).map((r) => r.id)
    // 三张表一起清放同一事务:pages 行 + yjs_documents 快照 + yjs_updates 增量
    await withTransaction(pool, async (client) => {
      if (trashed.length > 0) await client.query(DETACH_TRASHED, [trashed])
      await purgePageRows(client, alive)
    })
    notify?.()
    return c.json({ deleted: alive })
  })

  // 历史版本列表:倒序分页。?limit=&before=<上一页最后一条 created_at>;?around=<sid> 取
  // 以该快照为中心的窗口(更新流水时钟跳转用,目标可能远在已加载窗口之外)
  app.get('/api/pages/:id/snapshots', async (c) => {
    const page = await visiblePage(c.get('user'), c.req.param('id'))
    if (!page) return c.json({ error: 'page not found' }, 404)
    const { limit, before } = historyPage(c.req.query('limit'), c.req.query('before'))
    const around = c.req.query('around')
    if (around !== undefined) {
      const [older, newer] = await Promise.all([
        pool.query<SnapshotRow>(SELECT_SNAPSHOTS_LE, [page.id, around, limit]),
        pool.query<SnapshotRow>(SELECT_SNAPSHOTS_GT, [page.id, around, limit]),
      ])
      // 两侧都倒序:更晚的一段在前(倒序),再拼 ≤ 目标的那一段(倒序,目标在首位)
      return c.json([...newer.rows.reverse(), ...older.rows])
    }
    const sql = before === null ? SELECT_SNAPSHOTS_HEAD : SELECT_SNAPSHOTS_PAGE
    const params = before === null ? [page.id, limit] : [page.id, before, limit]
    return c.json((await pool.query<SnapshotRow>(sql, params)).rows)
  })

  app.get('/api/pages/:id/snapshots/:sid', async (c) => {
    const page = await visiblePage(c.get('user'), c.req.param('id'))
    if (!page) return c.json({ error: 'page not found' }, 404)
    // 存储侧是增量链:服务端物化出目标版本的完整 Y.Doc,再编码成全量 update 的 base64,
    // 客户端拿到的 data 仍是全量。目标不在链上 → null → 404
    // (版本永不删除,行只会随页面本身被删而级联消失)
    const doc = await materializeSnapshot(pool, page.id, c.req.param('sid'))
    if (!doc) return c.json({ error: 'snapshot not found' }, 404)
    const row = (await pool.query<SnapshotRow>(SELECT_SNAPSHOT, [c.req.param('sid'), page.id])).rows[0]
    if (!row) return c.json({ error: 'snapshot not found' }, 404)
    // data 走 base64:Yjs update 是二进制,JSON 只能带字符串
    return c.json({ ...row, data: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') })
  })

  // 上次编辑：整页 + 全部块（前端进页面预取，⋮ 菜单与块手柄菜单打开即画）。任意角色可读，非成员 / 不存在 404
  app.get('/api/pages/:id/edit-marks', async (c) => {
    const page = await visiblePage(c.get('user'), c.req.param('id'))
    if (!page) return c.json({ error: 'page not found' }, 404)
    return c.json(await readEditMarks(pool, page))
  })

  app.get('/api/pages/:id/updates', async (c) => {
    const page = await visiblePage(c.get('user'), c.req.param('id'))
    if (!page) return c.json({ error: 'page not found' }, 404)
    // 更新 = 快照链相邻对的块级 diff,零新表:把状态从某个检查点回放到窗口末条,
    // 每行 apply 完即该时刻的中间状态,相邻对算摘要。
    // ?limit=N(缺省 50,上限 200)只产最新 N 条(顶部栏「最近编辑」拉 1 条);
    // ?before=<created_at> 续拉更早一页。回放行数 ≤ 检查点间隔 + limit,与历史长度无关 ——
    // 版本永不删除,所以「每次请求全链回放」这条路必须堵死
    const { limit, before } = historyPage(c.req.query('limit'), c.req.query('before'))
    const { rows } = await pool.query<{
      id: string
      title: string
      origin: string
      created_at: string
      data: Buffer
      author_id: string | null
      author_username: string | null
      actor: string
      actor_agent: string | null
    }>(SELECT_UPDATES_WINDOW, [page.id, before, limit])
    const doc = new Y.Doc()
    // 每步的摘要状态:正文块 + 标题 + 行属性(普通页面恒空);集合页另解析属性定义与视图(collection-history)
    const isCollection = page.kind === 'collection'
    // 窗口首行的前一行 = diff 基线。回放起点取它的最近检查点,切片只为把状态推进到它
    let prev: SummaryState | null = null
    const oldest = rows[rows.length - 1]?.created_at
    if (oldest !== undefined) {
      const base = (await pool.query<{ at: string | null }>(SELECT_UPDATES_BASE, [page.id, oldest])).rows[0]?.at
      if (base != null) {
        const slice = await pool.query<{ title: string; data: Buffer }>(SELECT_UPDATES_SLICE, [page.id, base, oldest])
        for (const row of slice.rows) Y.applyUpdate(doc, row.data)
        // 片段最后一行就是窗口首行的前一行;片段为空只可能是脏链,退化成"无前驱"
        const last = slice.rows[slice.rows.length - 1]
        if (last) prev = summaryState(doc, last.title, isCollection)
      }
    }
    const entries: UpdateEntry[] = []
    // 链序(created_at 升序)= 物化应用序:倒着遍历窗口行即升序回放
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!
      Y.applyUpdate(doc, row.data)
      const cur = summaryState(doc, row.title, isCollection)
      const summary = summarizeChange(prev, cur)
      entries.push({
        id: row.id,
        title: row.title,
        origin: row.origin,
        created_at: row.created_at,
        author_id: row.author_id,
        author_username: row.author_username,
        actor: row.actor === 'agent' ? 'agent' : 'user',
        actor_agent: row.actor === 'agent' ? row.actor_agent : null,
        // 每条上限 SUMMARY_ITEM_LIMIT 项,total 记截断前项数(前端据此展示「查看其余 N 项」)
        summary: summary.slice(0, SUMMARY_ITEM_LIMIT),
        summary_total: summary.length,
      })
      prev = cur
    }
    // 回放必须升序,展示按时间倒序(最新在前,同快照列表)
    return c.json(entries.reverse())
  })

  app.post('/api/pages/:id/snapshots', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const page = (await pool.query<PageRow>(SELECT, [id])).rows[0]
    const role = page ? await pageRole(pool, user, page) : null
    // 非成员与不存在同响应 404;可见但只读(viewer)403 —— 手动存版是写操作,列表/详情不拦
    if (!page || role === null) return c.json({ error: 'page not found' }, 404)
    if (!writable(role)) return c.json({ error: 'forbidden' }, 403)
    const { doc, title } = await captureDoc(`page:${id}`)
    // 插入 + 检查点判定同事务(collab.insertSnapshot);内容零变化(空增量 / 改了又撤销)返回现有最新行,仍 201。
    // 作者 = 触发的登录用户。不改树,无需广播。null = 校验后页面被并发删除,与不存在同响应
    const row = await insertSnapshot(pool, id, title, 'manual', doc, user.id)
    if (!row) return c.json({ error: 'page not found' }, 404)
    return c.json(row, 201)
  })

  return app
}
