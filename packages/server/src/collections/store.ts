// ---------- 集合的存取（SQL 常量与读写） ----------
// 集合页 = kind='collection' 的页面（名称、图标、位置、权限、回收站全走页面机制）+ collections 一行（是否内联）。
// 行 = 父页是集合的 kind='doc' 活页面：属于哪个集合永远按 pages.parent_id 现查，不另存。
// 行属性的真相在行文档的 Y.Map('props')；collection_rows.props 是它的可查询副本（派生，随时可由文档重建）：
// 写副本只经这里的 writeReplica（投影器 projector.ts 投影、建行时随页面行一起落），读的时候不反写文档。
// 这里放：建集合、建行、取成员行（live_pages ⋈ collection_rows）、读写副本、手动顺序（邻居中点与重编号）、批量复制 / 挪走。

import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type * as Y from 'yjs'
import {
  isPropId,
  parseCollection,
  type CollectionRow,
  type CollectionSchema,
  type PropValue,
} from '@ramet/shared/collection-model'
import { between, compareRows } from '@ramet/shared/collection-query'
import { copyPageTree } from '../clone.js'
import { loadDocForRead, writeDocState } from '../collab.js'
import { withTransaction } from '../db.js'
import { newPageDoc } from '../agents/markdown.js'
import { rowIcon } from '../page-icon.js'
import { newCollectionDoc } from './init-doc.js'

/** Pool 或事务里的 PoolClient */
type Db = Pick<Pool, 'query'>

export type CollectionPage = { id: string; space_id: string | null; title: string }

// ---------- SQL ----------

const SELECT_COLLECTION = `SELECT id, space_id, title FROM live_pages WHERE id = $1 AND kind = 'collection'`
// 客户端给的 id 是否已被占用：读基表，回收站里的页面也占着这个 id
const PAGE_ID_TAKEN = 'SELECT 1 FROM pages WHERE id = $1'
// 集合页与新行的文档由服务端整份写好、正文是空的：正文索引同时落成 ''（同 skills.ts 建页时写 content_text）。
// 留 NULL 的话，routes/search.ts 里 content_text ILIKE 得 NULL，「每个词都要命中」那条 NOT EXISTS 会把它算作命中，
// 没打开过的行会出现在每一次搜索里；空串也让「编辑时间」不因第一次存盘（NULL 变 ''）前移
const INSERT_COLLECTION_PAGE = `INSERT INTO pages (id, parent_id, owner_id, space_id, in_page_tree, kind, title, content_text)
  VALUES ($1, $2, $3, $4, true, 'collection', $5, '')`
// 内联集合建好时 ref_host 就是父页：块是「先插后建」的，宿主正文里已经有它（collections/inline.ts）
const INSERT_COLLECTION = 'INSERT INTO collections (page_id, inline, ref_host) VALUES ($1, $2, $3)'
// 建行时锁住集合页（基表行锁，同 collab.ts 快照写入守卫的写法）：与回收集合的 UPDATE 互斥，
// 不会在已进回收站的集合下长出活的行（活页面的父必然活着）
const LOCK_LIVE_COLLECTION = `SELECT 1 FROM pages WHERE id = $1 AND kind = 'collection' AND deleted_at IS NULL FOR SHARE`
const INSERT_ROW_PAGE = `INSERT INTO pages (id, parent_id, owner_id, space_id, in_page_tree, kind, title, position, content_text)
  VALUES ($1, $2, $3, $4, true, 'doc', $5, $6, '')`
const DELETE_DOC_STATE = 'DELETE FROM yjs_documents WHERE doc_name = $1'

// 正文里有没有字：content_text 由 collab.ts 的 syncContentText 在每次存文档时刷新（不含标题）；
// NULL = 正文索引之前就有、之后再没存过的老页面，算有（宁可多画一个图标）
const HAS_BODY = (alias: string): string => `COALESCE(${alias}.content_text ~ '\\S', true)`
// 行的对外形状（窗口查询与增量共用）。编辑时间 = 正文 / 属性最后一次变化，与创建时间取最晚：
// 三列类型不同（created_at / content_updated_at 是 now()::text，props_updated_at 是 timestamptz），统一按 timestamptz 比
const ROW_COLUMNS = `p.id, p.title, p.icon_emoji, p.icon_file_id, p.position, p.created_at,
  GREATEST(p.created_at::timestamptz, p.content_updated_at::timestamptz, r.props_updated_at)::text AS edited_at,
  r.props, ${HAS_BODY('p')} AS has_body`
// 一个集合的全部行（走 idx_pages_parent）；没有副本行的按空属性（LEFT JOIN）
const SELECT_MEMBERS = `SELECT ${ROW_COLUMNS} FROM live_pages p
  LEFT JOIN collection_rows r ON r.page_id = p.id
  WHERE p.parent_id = $1 AND p.kind = 'doc'`
// 一行 + 它所在的集合（不是活集合的行 = 没有结果）
const SELECT_MEMBER_ROW = `SELECT ${ROW_COLUMNS}, c.id AS collection_id FROM live_pages p
  JOIN live_pages c ON c.id = p.parent_id AND c.kind = 'collection'
  LEFT JOIN collection_rows r ON r.page_id = p.id
  WHERE p.id = $1 AND p.kind = 'doc'`
const SELECT_MEMBERS_AMONG = `SELECT id FROM live_pages WHERE parent_id = $1 AND kind = 'doc' AND id = ANY($2::text[])`
const SELECT_SPACE_MEMBERS = `SELECT m.user_id, u.username FROM space_members m JOIN users u ON u.id = m.user_id
  WHERE m.space_id = $1`

// 副本。页面行必须还在（同 collab.ts 的 APPEND_UPDATE：FOR SHARE 把写入定在物理删页之后，删了就不写，不撞外键）；
// 回收站里的页面照写，恢复以后副本要和文档对得上。stamp = 这次是属性变了（前移 props_updated_at）
const UPSERT_REPLICA = `INSERT INTO collection_rows (page_id, props, props_updated_at)
  SELECT $1::text, $2::jsonb, CASE WHEN $3::boolean THEN now() END
  WHERE EXISTS (SELECT 1 FROM pages WHERE id = $1::text FOR SHARE)
  ON CONFLICT (page_id) DO UPDATE SET props = EXCLUDED.props,
    props_updated_at = COALESCE(EXCLUDED.props_updated_at, collection_rows.props_updated_at)
  RETURNING page_id`
// 集合的行还没有副本：补一行空的（已有就不动）
const INSERT_EMPTY_REPLICA = `INSERT INTO collection_rows (page_id)
  SELECT $1::text WHERE EXISTS (SELECT 1 FROM pages WHERE id = $1::text FOR SHARE)
  ON CONFLICT (page_id) DO NOTHING`
// 校准用：副本（没有 = null）+ 这一页此刻是不是某个活集合的行
const SELECT_REPLICA = `SELECT r.props, (c.id IS NOT NULL AND p.kind = 'doc' AND p.deleted_at IS NULL) AS member, ${HAS_BODY('p')} AS body
  FROM pages p
  LEFT JOIN collection_rows r ON r.page_id = p.id
  LEFT JOIN live_pages c ON c.id = p.parent_id AND c.kind = 'collection'
  WHERE p.id = $1`

// 手动顺序。同一集合的排序在事务级 advisory 锁下串行：重编号不会和别的移动 / 建行交错
const LOCK_ORDER = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))'
const SELECT_POSITIONS = `SELECT id, position FROM live_pages WHERE parent_id = $1 AND kind = 'doc' AND id = ANY($2::text[])`
const SELECT_TAIL = `SELECT bool_or(position IS NULL) AS unplaced, max(position) AS max FROM live_pages
  WHERE parent_id = $1 AND kind = 'doc' AND id <> $2`
const SELECT_ORDER = `SELECT id, position, created_at FROM live_pages WHERE parent_id = $1 AND kind = 'doc' AND id <> $2`
const RENUMBER = `UPDATE pages SET position = v.pos FROM unnest($1::text[], $2::float8[]) AS v(id, pos) WHERE pages.id = v.id`
const SET_POSITION = 'UPDATE pages SET position = $1 WHERE id = $2'

// ---------- 读 ----------

type RowRecord = {
  id: string
  title: string
  icon_emoji: string | null
  icon_file_id: string | null
  position: number | null
  created_at: string
  edited_at: string
  props: Record<string, unknown> | null
  has_body: boolean
}

function toRow(r: RowRecord): CollectionRow {
  return {
    id: r.id,
    title: r.title,
    icon: rowIcon(r),
    props: r.props ?? {},
    position: r.position,
    created_at: r.created_at,
    edited_at: r.edited_at,
    has_body: r.has_body,
  }
}

/** 活的集合页；不存在 / 已回收 / 不是集合 = null */
export async function selectCollection(db: Db, id: string): Promise<CollectionPage | null> {
  return (await db.query<CollectionPage>(SELECT_COLLECTION, [id])).rows[0] ?? null
}

/** 属性定义与视图：集合文档的 Y.Map('collection')（活文档优先，否则从库里加载），解析容错见 parseCollection */
export async function readSchema(
  pool: Pool,
  collectionId: string,
  getLiveDoc?: (docName: string) => Y.Doc | undefined,
): Promise<CollectionSchema> {
  const doc = await loadDocForRead(pool, `page:${collectionId}`, getLiveDoc)
  return parseCollection(doc.getMap('collection').toJSON())
}

export async function memberRows(db: Db, collectionId: string): Promise<CollectionRow[]> {
  return (await db.query<RowRecord>(SELECT_MEMBERS, [collectionId])).rows.map(toRow)
}

/** 一行 + 它所在的集合；不是活集合的活行 = null */
export async function memberRow(db: Db, rowId: string): Promise<{ collectionId: string; row: CollectionRow } | null> {
  const r = (await db.query<RowRecord & { collection_id: string }>(SELECT_MEMBER_ROW, [rowId])).rows[0]
  return r ? { collectionId: r.collection_id, row: toRow(r) } : null
}

/** ids 里哪些是这个集合的活行 */
export async function membersAmong(db: Db, collectionId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []
  return (await db.query<{ id: string }>(SELECT_MEMBERS_AMONG, [collectionId, ids])).rows.map((r) => r.id)
}

/** 空间成员：用户 id → 用户名（人员属性只能选他们；人员排序按用户名比） */
export async function spaceMembers(db: Db, spaceId: string | null): Promise<Map<string, string>> {
  if (spaceId === null) return new Map()
  const { rows } = await db.query<{ user_id: string; username: string }>(SELECT_SPACE_MEMBERS, [spaceId])
  return new Map(rows.map((r) => [r.user_id, r.username]))
}

// ---------- 副本 ----------

/** 清洗时最多下钻几层（协同连接能写进任意深的嵌套值；副本只要存得下） */
const CLEAN_DEPTH = 16

function cleanText(text: string): string {
  // JSONB 存不了 \u0000，也不收孤立的代理项（半个 emoji）
  return text.replace(/\u0000/g, '').toWellFormed()
}

function cleanJson(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return cleanText(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean' || value === null) return value
  if (typeof value !== 'object' || depth >= CLEAN_DEPTH) return undefined
  if (Array.isArray(value)) return value.map((item) => cleanJson(item, depth + 1) ?? null)
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const clean = cleanJson(item, depth + 1)
    if (clean !== undefined) out[cleanText(key)] = clean
  }
  return out
}

/** 行文档 props 的 JSON → 写进副本的样子。经协同连接直接写进来的值没过 validateValue，存进 JSONB 前要清洗；
 *  只留属性 id 的键（readValue 只按属性 id 取值，别的键永远读不到），值为 null 的键按「不存在」去掉。只影响副本，不改文档 */
export function replicaProps(json: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return out
  for (const [key, value] of Object.entries(json)) {
    if (!isPropId(key)) continue
    const clean = cleanJson(value, 0)
    if (clean !== undefined && clean !== null) out[key] = clean
  }
  return out
}

/** 与键序无关的 JSON 文本（JSONB 读回来键序会变） */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function sameProps(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return canonical(a) === canonical(b)
}

/** 增量的 prev：这次变了的键 → 改之前的值（null = 当时没有这个键） */
export function propsDiff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const prev: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const old = Object.hasOwn(before, key) ? before[key] : undefined
    const now = Object.hasOwn(after, key) ? after[key] : undefined
    if (canonical(old) !== canonical(now)) prev[key] = old === undefined ? null : old
  }
  return prev
}

/** 写副本（唯一写入口）。返回是否写了（页面行已不在 = false） */
export async function writeReplica(db: Db, rowId: string, props: unknown, stamp: boolean): Promise<boolean> {
  const { rows } = await db.query(UPSERT_REPLICA, [rowId, JSON.stringify(replicaProps(props)), stamp])
  return rows.length > 0
}

/** 集合的行还没有副本：补一行空的。副本行的存在本身就是「投影过」的标记 */
export async function writeEmptyReplica(db: Db, rowId: string): Promise<void> {
  await db.query(INSERT_EMPTY_REPLICA, [rowId])
}

/** 副本现状（校准用）：props 为 null = 还没有副本行；member = 此刻是不是某个活集合的行。页面行不在 = null */
type Replica = { props: Record<string, unknown> | null; member: boolean; body: boolean }
export async function readReplica(db: Db, rowId: string): Promise<Replica | null> {
  return (await db.query<Replica>(SELECT_REPLICA, [rowId])).rows[0] ?? null
}

const SELECT_BODY = `SELECT ${HAS_BODY('p')} AS body FROM pages p WHERE p.id = $1`
/** 这一页正文里有没有字（口径同行的 has_body）；页面已不在 = null */
export async function readHasBody(db: Db, rowId: string): Promise<boolean | null> {
  return (await db.query<{ body: boolean }>(SELECT_BODY, [rowId])).rows[0]?.body ?? null
}

// ---------- 手动顺序 ----------

const NO_SCHEMA: CollectionSchema = { v: 1, props: [], views: [] }
const orderKey = (collectionId: string): string => `collection-order:${collectionId}`

type OrderRow = { id: string; position: number | null }

/** 集合里除 rowId 外的行，按当前手动顺序排好（带各自的 position）。
 *  顺序与窗口查询是同一个比较（@ramet/shared/collection-query 的 compareRows，无排序 = position NULLS LAST、创建时间、id）：
 *  在 SQL 里另写一份 ORDER BY，两边对时间戳的精度一不一样，找邻居 / 重编号就可能和客户端看到的顺序对不上 */
async function currentOrder(client: PoolClient, collectionId: string, rowId: string): Promise<OrderRow[]> {
  const { rows } = await client.query<{ id: string; position: number | null; created_at: string }>(SELECT_ORDER, [collectionId, rowId])
  return rows
    .map((r): CollectionRow => ({ id: r.id, title: '', icon: null, props: {}, position: r.position, created_at: r.created_at, edited_at: r.created_at, has_body: false }))
    .sort((a, b) => compareRows(a, b, [], NO_SCHEMA))
    .map((r) => ({ id: r.id, position: r.position }))
}

/** 按 order 的顺序把这些行重编号为 0..n-1（顺序不变），返回排好的 id */
async function renumber(client: PoolClient, order: OrderRow[]): Promise<string[]> {
  const ids = order.map((r) => r.id)
  await client.query(RENUMBER, [ids, ids.map((_, i) => i)])
  return ids
}

/** 新行排到末尾：集合里还有没排过的行（position 为空，按创建时间排在所有排过的行之后）就留空 ——
 *  新行创建得最晚，留空自然排在最后；否则 max + 1 */
async function tailPosition(client: PoolClient, collectionId: string, rowId: string): Promise<number | null> {
  const tail = (await client.query<{ unplaced: boolean | null; max: number | null }>(SELECT_TAIL, [collectionId, rowId])).rows[0]
  if (tail?.unplaced) return null
  return (tail?.max ?? -1) + 1
}

/** 夹在两个相邻行之间的位置：after / before = 客户端看到的相邻行 id（null = 那一侧没有邻居）。
 *  只给了一侧时（客户端窗口没取完：拖到已加载末行之后只知道 after），另一侧按全局手动顺序找实际相邻的那一行 ——
 *  直接取 ±1 会撞上或越过没加载的下一行；真的在首 / 尾才是 ±1。
 *  通常就是邻居中点（只写这一行）；邻居没排过或中点精度用尽时，同一事务里先按当前顺序重编号再取 ——
 *  renumbered = 这个集合所有行的 position 都换了（调用方据此让观看者重取窗口，见 RowsDelta.reset）。
 *  at 为 undefined = 给的邻居都不在了（校验之后被并发删掉 / 挪走） */
async function slotBetween(
  client: PoolClient,
  collectionId: string,
  rowId: string,
  after: string | null,
  before: string | null,
): Promise<{ at: number | undefined; renumbered: boolean }> {
  let order: OrderRow[] | undefined
  const known = new Map<string, number | null>()
  if ((after === null) !== (before === null)) {
    order = await currentOrder(client, collectionId, rowId)
    const i = order.findIndex((r) => r.id === (after ?? before))
    if (i < 0) return { at: undefined, renumbered: false }
    if (after !== null) before = order[i + 1]?.id ?? null
    else after = order[i - 1]?.id ?? null
    for (const r of order) known.set(r.id, r.position)
  } else {
    const ids = [after, before].filter((id): id is string => id !== null)
    if (ids.length > 0) {
      for (const r of (await client.query<{ id: string; position: number | null }>(SELECT_POSITIONS, [collectionId, ids])).rows) {
        known.set(r.id, r.position)
      }
    }
  }
  const lo = after === null ? undefined : known.get(after)
  const hi = before === null ? undefined : known.get(before)
  if (lo === undefined && hi === undefined) return { at: undefined, renumbered: false }
  const at = between(lo, hi)
  if (at !== null) return { at, renumbered: false }
  const ids = await renumber(client, order ?? (await currentOrder(client, collectionId, rowId)))
  const a = after === null ? -1 : ids.indexOf(after)
  let b = before === null ? -1 : ids.indexOf(before)
  if (a < 0 && b < 0) return { at: undefined, renumbered: true }
  // 邻居次序反了（客户端看到的顺序已过时，别人刚挪过）：以 after 为准，放在它和它的下一行之间
  if (a >= 0 && b >= 0 && b <= a) b = a + 1 < ids.length ? a + 1 : -1
  // 重编号后位置是互不相同的整数，中点一定取得到
  return { at: between(a >= 0 ? a : undefined, b >= 0 ? b : undefined) ?? undefined, renumbered: true }
}

/** 改一行的手动顺序（PATCH after / before）。两个邻居都已不在 = 不动。返回是否重编号了整个集合 */
export async function moveRow(pool: Pool, collectionId: string, rowId: string, after: string | null, before: string | null): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    await client.query(LOCK_ORDER, [orderKey(collectionId)])
    const { at, renumbered } = await slotBetween(client, collectionId, rowId, after, before)
    if (at !== undefined) await client.query(SET_POSITION, [at, rowId])
    return renumbered
  })
}

// ---------- 建 ----------

export type NewCollection = { id: string; spaceId: string; parentId: string | null; ownerId: string; inline: boolean; title: string }

/** 建集合：先写整份文档（标题 + 「状态」属性 + 默认表格视图），再建页面行与 collections 行（同一事务）——
 *  建页时不可能有活连接，「先写内容、再让页面可被发现」才没有竞态（同 writeDocState 的约定）。
 *  id 可由客户端给（内联集合先插块后建）；已被占用（含回收站里的）返回 false */
export async function createCollection(pool: Pool, input: NewCollection): Promise<boolean> {
  if ((await pool.query(PAGE_ID_TAKEN, [input.id])).rows.length > 0) return false
  await writeDocState(pool, `page:${input.id}`, newCollectionDoc(input.title))
  try {
    await withTransaction(pool, async (client) => {
      await client.query(INSERT_COLLECTION_PAGE, [input.id, input.parentId, input.ownerId, input.spaceId, input.title])
      await client.query(INSERT_COLLECTION, [input.id, input.inline, input.inline ? input.parentId : null])
    })
  } catch (err) {
    // 同一个 id 并发建了两次：后到的这次算占用
    if ((err as { code?: string }).code === '23505') return false
    throw err
  }
  return true
}

export type NewRow = {
  /** 客户端生成的 uuid v4（乐观新建：点了就插行、进入命名，不等这一趟）；缺省由服务端生成 */
  id?: string
  collectionId: string
  spaceId: string | null
  ownerId: string
  title: string
  /** 已校验、已去掉 null 的初始值 */
  props: Record<string, PropValue>
  after: string | null
  before: string | null
}

/** 建行：文档（标题 + Y.Map('props')）先整份写好，再在一个事务里建页面行、定位置、落副本 —— 行文档还没被加载过，
 *  投影器没机会投影它，副本就用写进文档的同一份值。renumbered = 定位置时重编号了整个集合（见 slotBetween）。
 *  集合在这期间进了回收站 = null（文档状态一并删掉）；客户端给的 id 已被占用（含回收站里的）= 'taken'（同 createCollection） */
export async function createRow(pool: Pool, input: NewRow): Promise<{ id: string; renumbered: boolean } | null | 'taken'> {
  const id = input.id ?? randomUUID()
  // 先查占用再写文档状态：占用的 id 写下去会覆盖别人页面的正文
  if (input.id !== undefined && (await pool.query(PAGE_ID_TAKEN, [id])).rows.length > 0) return 'taken'
  const doc = newPageDoc(input.title, [])
  const props = doc.getMap<unknown>('props')
  doc.transact(() => {
    for (const [key, value] of Object.entries(input.props)) props.set(key, value)
  })
  const docName = `page:${id}`
  await writeDocState(pool, docName, doc)
  let created: { id: string; renumbered: boolean } | null
  try {
    created = await withTransaction(pool, async (client) => {
      if ((await client.query(LOCK_LIVE_COLLECTION, [input.collectionId])).rows.length === 0) return null
      await client.query(LOCK_ORDER, [orderKey(input.collectionId)])
      const slot =
        input.after === null && input.before === null
          ? { at: undefined, renumbered: false }
          : await slotBetween(client, input.collectionId, id, input.after, input.before)
      const at = slot.at ?? (await tailPosition(client, input.collectionId, id))
      await client.query(INSERT_ROW_PAGE, [id, input.collectionId, input.ownerId, input.spaceId, input.title, at])
      await writeReplica(client, id, props.toJSON(), false)
      return { id, renumbered: slot.renumbered }
    })
  } catch (err) {
    // 同一个 id 并发建了两次：后到的这次算占用（文档状态归先到的那次，不删）
    if (input.id !== undefined && (err as { code?: string }).code === '23505') return 'taken'
    throw err
  }
  if (created) return created
  await pool.query(DELETE_DOC_STATE, [docName])
  return null
}

// ---------- 批量：复制、挪到别的集合（routes/collections.ts 的 rows/duplicate、rows/move） ----------

// 复制出来的页面抄源页的正文索引：copyPageTree 不写它，留 NULL 会命中每一次搜索（见 INSERT_COLLECTION_PAGE 的注释）
const COPY_CONTENT_TEXT = `UPDATE pages n SET content_text = o.content_text
  FROM unnest($1::text[], $2::text[]) AS v(new_id, old_id) JOIN pages o ON o.id = v.old_id
  WHERE n.id = v.new_id`
// 只挪仍是源集合活行的那些（校验之后可能被并发删 / 挪走）
const REPARENT_ROW = `UPDATE pages SET parent_id = $1 WHERE id = $2 AND parent_id = $3 AND kind = 'doc' AND deleted_at IS NULL RETURNING id`

export type DuplicateInput = {
  collectionId: string
  spaceId: string
  ownerId: string
  /** 源行（按这个顺序复制）与各自的属性值（行文档 props 的 JSON，副本用） */
  rows: { id: string; props: Record<string, unknown> }[]
  /** 子树全部文档的全量状态（clone.ts 的 resolveDocs，事务外组好） */
  docs: Map<string, Uint8Array>
}

/** 每个源行复制一份（连子页，规则同 clone.ts 的 COPYABLE），副本紧跟在原行之后；一个事务。
 *  集合进了回收站 = null。renumbered 同 slotBetween */
export async function duplicateRows(
  pool: Pool,
  input: DuplicateInput,
): Promise<{ created: { from: string; id: string }[]; renumbered: boolean } | null> {
  return withTransaction(pool, async (client) => {
    if ((await client.query(LOCK_LIVE_COLLECTION, [input.collectionId])).rows.length === 0) return null
    await client.query(LOCK_ORDER, [orderKey(input.collectionId)])
    const created: { from: string; id: string }[] = []
    let renumbered = false
    for (const row of input.rows) {
      const { newRootIds, idMap } = await copyPageTree(client, [row.id], input.spaceId, input.ownerId, input.docs, {
        rootParentId: input.collectionId,
      })
      const id = newRootIds[0]
      // 源行在解析之后被并发删了：跳过
      if (!id) continue
      await client.query(COPY_CONTENT_TEXT, [[...idMap.values()], [...idMap.keys()]])
      const slot = await slotBetween(client, input.collectionId, id, row.id, null)
      renumbered ||= slot.renumbered
      await client.query(SET_POSITION, [slot.at ?? (await tailPosition(client, input.collectionId, id)), id])
      // 副本文档还没被加载过，投影器看不到：副本用源文档里的同一份值（同 createRow）
      await writeReplica(client, id, row.props, false)
      created.push({ from: row.id, id })
    }
    return { created, renumbered }
  })
}

/** 把行挪到集合 to 的末尾，副本同时换成按目标定义改写好的值（mapped，collections/transfer.ts）；一个事务。
 *  行文档里的 props 由调用方随后经 DocWriter 写（快照记给发起人）。目标进了回收站 = null；返回实际挪了的行 */
export async function moveRowsTo(
  pool: Pool,
  from: string,
  to: string,
  rows: { id: string; mapped: Record<string, PropValue> }[],
): Promise<string[] | null> {
  return withTransaction(pool, async (client) => {
    if ((await client.query(LOCK_LIVE_COLLECTION, [to])).rows.length === 0) return null
    await client.query(LOCK_ORDER, [orderKey(to)])
    const moved: string[] = []
    for (const row of rows) {
      if ((await client.query(REPARENT_ROW, [to, row.id, from])).rows.length === 0) continue
      await client.query(SET_POSITION, [await tailPosition(client, to, row.id), row.id])
      await writeReplica(client, row.id, row.mapped, true)
      moved.push(row.id)
    }
    return moved
  })
}
