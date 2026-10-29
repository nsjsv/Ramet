import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import * as Y from 'yjs'
import { withTransaction } from './db.js'
import { loadDocFromDb } from './collab.js'

// 页面克隆的共享核心:个人空间落点(公开页克隆用)与整棵页面树复制(公开克隆、模板、集合复制共用)。
// 纯 DB 写,不掺路由与鉴权;调用方在事务外先把涉及文档的全量状态解析进 Map,事务内只做落库。

// ---------- SQL 常量 ----------

// 个人空间唯一性由迁移保证,这里 ORDER BY + LIMIT 1 兜底(admin 删号转移可能让一人挂两个 is_personal)
export const SELECT_MY_PERSONAL = `SELECT id FROM spaces WHERE owner_id = $1 AND is_personal
  ORDER BY created_at, id LIMIT 1`
type PersonalSpaceRow = { id: string }
// 惰性补建个人空间(与 initDb 迁移同语义的单用户版):服务运行期新建的用户也要能立刻建页
const ENSURE_PERSONAL_SPACE = `INSERT INTO spaces (id, name, owner_id, is_personal)
  SELECT $1, u.username || ' 的空间', u.id, true FROM users u
  WHERE u.id = $1
    AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.owner_id = u.id AND s.is_personal)
  ON CONFLICT (id) DO NOTHING`
const ENSURE_PERSONAL_MEMBER = `INSERT INTO space_members (space_id, user_id, role)
  SELECT s.id, s.owner_id, 'owner' FROM spaces s
  WHERE s.owner_id = $1 AND s.is_personal
    AND NOT EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = s.id AND m.user_id = s.owner_id)
  ON CONFLICT DO NOTHING`

// 克隆只带用户文档(kind='doc'),根与子页同一条规则:过程页(kind='run')是 agent 的运行记录,克隆出去的副本没有意义;
// skill 页是 skills 表 + 附件 + 页面三者合一;集合页(kind='collection')的属性定义与行数据不随页面行走,
// 所以不复制集合。不是 doc 的页不复制,它下面的页(集合的行)也就不会被遍历到
const COPYABLE = `kind = 'doc'`
const SELECT_PAGE_TITLE_ONLY = `SELECT title, icon_emoji, icon_file_id, in_page_tree, full_width FROM live_pages
  WHERE id = $1 AND ${COPYABLE}`
const SELECT_CHILDREN_IDS = `SELECT id FROM live_pages WHERE parent_id = $1 AND ${COPYABLE}`
// 一组根下面全部要复制的页(含根):与 copyPageTree 的逐层遍历同一条规则。一条递归 CTE,
// UNION 去重,库里万一已有环也会终止(同 pages.ts 的 SELECT_SUBTREE_ALIVE)
const SELECT_COPYABLE_SUBTREE = `WITH RECURSIVE sub AS (
  SELECT id FROM live_pages WHERE id = ANY($1::text[]) AND ${COPYABLE}
  UNION
  SELECT p.id FROM live_pages p JOIN sub s ON p.parent_id = s.id WHERE ${COPYABLE}
) SELECT id FROM sub`
// 图标两列原样跟着克隆:emoji 是字面量,图片是对永不删除的 files 行的引用,复制引用即共用同一份派生版,不额外占磁盘。
// 全宽是版式,也跟着走(模板实例化同走这里)
const INSERT_PAGE =
  'INSERT INTO pages (id, parent_id, owner_id, space_id, title, icon_emoji, icon_file_id, in_page_tree, full_width) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)'
const INSERT_DOC = 'INSERT INTO yjs_documents (doc_name, state) VALUES ($1, $2)'

// docs 缺项(克隆 resolve 之后、事务之前页面才创建,尚无文档)时的合法空文档状态
const EMPTY_STATE = Y.encodeStateAsUpdate(new Y.Doc())

// 克隆者的个人空间 id,没有则惰性补建。空间行 + owner 成员行同一事务。
// 新空间不预建任何树注册行(页面树是派生视图;目录树行在首次写入时落)
export async function myPersonalSpaceId(pool: Pool, userId: string): Promise<string | null> {
  return withTransaction(pool, async (client) => {
    await client.query(ENSURE_PERSONAL_SPACE, [userId])
    await client.query(ENSURE_PERSONAL_MEMBER, [userId])
    const { rows } = await client.query<PersonalSpaceRow>(SELECT_MY_PERSONAL, [userId])
    return rows[0]?.id ?? null
  })
}

// 整棵子树克隆进用户个人空间(惰性补建),返回新根 id;拿不到个人空间或根页在事务前被
// 并发删除(实践中不可达)返回 null。公开克隆(POST /api/public/pages/:id/clone)
// 用;调用方负责鉴权/可见性闸门与成功后的 notify
export async function clonePageIntoPersonalSpace(
  pool: Pool,
  userId: string,
  rootId: string,
  getLiveDoc?: (docName: string) => Y.Doc | undefined,
): Promise<string | null> {
  // 事务外收集要复制的子树并解析它们的文档,事务内只做纯 DB 写
  const docs = await resolveDocs(pool, getLiveDoc, await collectSubtreeIds(pool, [rootId]))
  const spaceId = await myPersonalSpaceId(pool, userId)
  if (!spaceId) return null
  const { newRootIds } = await withTransaction(pool, (client) =>
    copyPageTree(client, [rootId], spaceId, userId, docs),
  )
  return newRootIds[0] ?? null
}

// copyPageTree(client, rootIds, …) 会复制哪些页:同一组根、同一条规则(COPYABLE)收集,含根自身、顺序不定。
// 调用方拿它决定事务外先解析哪些文档 ——「解析哪些」与「复制哪些」只能是同一个定义,
// 否则不复制的页(集合页与它下面成千上万的行)也会被逐个解析
export async function collectSubtreeIds(pool: Pool, rootIds: string[]): Promise<string[]> {
  if (rootIds.length === 0) return []
  return (await pool.query<{ id: string }>(SELECT_COPYABLE_SUBTREE, [rootIds])).rows.map((r) => r.id)
}

// 批量把页面文档解析成全量状态(活文档优先,否则 DB 重建 = 快照+重放,含标题播种)
// → Map(doc_name → update)。调用方在事务外调,事务内只做纯 DB 写(copyPageTree 契约)
export async function resolveDocs(
  pool: Pool,
  getLiveDoc: ((docName: string) => Y.Doc | undefined) | undefined,
  pageIds: string[],
): Promise<Map<string, Uint8Array>> {
  const docs = new Map<string, Uint8Array>()
  for (const pageId of pageIds) {
    const docName = `page:${pageId}`
    const doc = getLiveDoc?.(docName) ?? (await loadDocFromDb(pool, docName))
    docs.set(docName, Y.encodeStateAsUpdate(doc))
  }
  return docs
}

// 克隆树内正文里的 /page/<旧id> 内链不重映射,仍指向源页面 id(公开预览内可达源树;
// 站内点旧链接按权限自然 404 / 打开源页),重映射要做文档级正文遍历。

// 复制 rootIds 对应的每棵子树到 targetSpaceId,新页面 owner=newOwnerId。根与子页同一条规则(COPYABLE):
// 只复制 doc 页,不可复制的根整棵跳过、不出现在 newRootIds 里(调用方拿不到新根即按不存在处理)。
// 返回 { newRootIds: 新根 id 列表(与入参同序), idMap: 旧页面 id → 新页面 id }。
// idMap 供调用方重映射引用(集合复制);clonePageIntoPersonalSpace 只用新根。
// docs:旧 doc_name(`page:<旧id>`)→ 该文档全量状态(调用方在事务外用活文档或 loadDocFromDb 组好,
// 事务内只做纯 DB 写,避免 Yjs 重建拖长锁窗口)。只写 yjs_documents 快照,不写 yjs_updates
// (全量即完整状态,无增量可重放)。
// 树遍历:逐层 BFS 取子页面,visited 防环(与 pages.ts 删页同款,库里万一有环不能死循环);
// title 原样复制;published 归默认 false(克隆出的页面不继承公开态,避免意外对外暴露)。
// 入参各根互不为祖后代(两个调用方天然满足:空间克隆传顶层页,公开克隆传单根);
// 若真传入祖后代对,后代根会落在顶层而非其新祖下,只影响挂载点,不丢数据。
export async function copyPageTree(
  client: PoolClient,
  rootIds: string[],
  targetSpaceId: string,
  newOwnerId: string,
  docs: Map<string, Uint8Array>,
  /** 新根挂在哪个父页下：缺省 null(顶层);集合复制行时给集合 id(routes/collections.ts 的 rows/duplicate) */
  opts: { rootParentId?: string | null } = {},
): Promise<{ newRootIds: string[]; idMap: Map<string, string> }> {
  // 旧页面 id → 新页面 id:子页面按映射挂父;键集兼作 visited 防环
  const idMap = new Map<string, string>()
  const newRootIds: string[] = []
  const queue: { oldId: string; newParentId: string | null }[] = []
  for (const oldId of rootIds) {
    // 新根缺省落目标空间顶层(parent=null)
    if (!idMap.has(oldId)) queue.push({ oldId, newParentId: opts.rootParentId ?? null })
  }
  for (let i = 0; i < queue.length; i++) {
    const { oldId, newParentId } = queue[i]!
    if (idMap.has(oldId)) continue // 同一页面被两棵子树共祖(脏数据环)时只复制一次
    const page = (
      await client.query<{
        title: string
        icon_emoji: string | null
        icon_file_id: string | null
        in_page_tree: boolean
        full_width: boolean
      }>(SELECT_PAGE_TITLE_ONLY, [oldId])
    ).rows[0]
    // 不可复制的根(集合页等,见 COPYABLE)、resolve 与事务之间被并发删除的页面:跳过,不炸整个克隆
    if (!page) continue
    const newId = randomUUID()
    idMap.set(oldId, newId)
    await client.query(INSERT_PAGE, [
      newId,
      newParentId,
      newOwnerId,
      targetSpaceId,
      page.title,
      page.icon_emoji,
      page.icon_file_id,
      page.in_page_tree,
      page.full_width,
    ])
    await client.query(INSERT_DOC, [
      `page:${newId}`,
      Buffer.from(docs.get(`page:${oldId}`) ?? EMPTY_STATE),
    ])
    const children = await client.query<{ id: string }>(SELECT_CHILDREN_IDS, [oldId])
    for (const child of children.rows) {
      if (!idMap.has(child.id)) queue.push({ oldId: child.id, newParentId: newId })
    }
  }
  for (const oldId of rootIds) {
    const newId = idMap.get(oldId)
    if (newId) newRootIds.push(newId)
  }
  return { newRootIds, idMap }
}
