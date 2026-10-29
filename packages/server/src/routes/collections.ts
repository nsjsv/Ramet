/* ---------- 集合 ----------
 * POST  /api/collections                    建集合：{ id?, space_id, parent_id?, inline?, title? }（整页 / 内联；id 可由客户端给）
 * GET   /api/collections/:id/rows           窗口查询：?view=&group=&cursor=&limit=&tz=（tz = 比 UTC 快多少分钟，缺省 0）
 * POST  /api/collections/:id/rows           建行：{ title?, set?, after?, before? }
 * PATCH /api/collections/:id/rows/:rowId    改值 set / 改名 title / 手动顺序 after、before（相邻行 id）
 * POST  /api/collections/:id/rows/trash     删行（进回收站）：{ ids }
 * POST  /api/collections/:id/rows/set       批量改值：{ ids, set }（set 一次校验，任一非法整批不写）
 * POST  /api/collections/:id/rows/duplicate 复制行（连子页，副本紧跟原行）：{ ids }
 * POST  /api/collections/:id/rows/move      挪到同空间的另一个集合末尾：{ ids, to }（属性按同名同类型对应，collections/transfer.ts）
 * 闸门：集合页过 pageAccess（不存在 / 不是集合 / 非成员 → 404，viewer 写 → 403）；行端点再核对行是这个集合的活行。
 * 属性定义与视图不走 REST：客户端经集合文档的协同连接直接改（viewer 的连接只读，服务端天然拒写）。
 * 批量端点的 ids 只收本集合的活行，别的 id 静默忽略（同 trash）；每个端点有行数上限，客户端分批发。
 * 只有建集合、建行、删行、复制 / 挪走行、行改名广播 changed（它们改了页面列表），改值、拖动排序只发集合增量（collections/delta.ts）。
 * 每条路由各自挂 requireAuth，不挂 '*' 中间件（见 index.ts 的挂载序注释）。 */

import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import type { Pool } from 'pg'
import * as Y from 'yjs'
import { findProp, isPropId, pickView, validateValue, type CollectionSchema, type PropValue } from '@ramet/shared/collection-model'
import { queryWindow, type QueryCtx } from '@ramet/shared/collection-query'
import { requireAuth, type AuthEnv, type AuthUser } from '../auth.js'
import { collectSubtreeIds, resolveDocs } from '../clone.js'
import { loadDocForRead, pageAccess, setDocTitle, type DocWriter } from '../collab.js'
import { toApiPage } from '../page-icon.js'
import type { Projector } from '../collections/projector.js'
import { mapProps } from '../collections/transfer.js'
import {
  createCollection,
  createRow,
  duplicateRows,
  memberRow,
  memberRows,
  membersAmong,
  moveRow,
  moveRowsTo,
  readSchema,
  selectCollection,
  spaceMembers,
  type CollectionPage,
} from '../collections/store.js'
import { pageRole, parentOk, roleInSpace, SELECT_API_PAGE, SET_TITLE, trashPageSubtree, writable, type PageRow } from './pages.js'

export type CollectionDeps = {
  pool: Pool
  /** 写行文档（唯一实现 collab.ts 的 createDocWriter）：改值 / 改名记给发起的用户 */
  write: DocWriter
  /** 活文档查找：读集合的属性定义与视图优先用协同中的那份 */
  getLiveDoc: (docName: string) => Y.Doc | undefined
  /** 页面列表变了：广播 changed */
  notify: () => void
  projector: Pick<Projector, 'flushRow' | 'publish' | 'reset'>
}

/** 客户端给的集合 id：小写 uuid v4（与 crypto.randomUUID 同形，协同文档名只认小写） */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/** 建集合的父页：活的 doc 页 */
const SELECT_DOC_PAGE = `SELECT 1 FROM live_pages WHERE id = $1 AND kind = 'doc'`
/** 集合状态（含回收站里的）：读基表 */
const SELECT_COLLECTION_STATE = `SELECT p.parent_id, p.title, p.space_id, p.owner_id, (p.deleted_at IS NOT NULL) AS trashed, c.inline
  FROM pages p JOIN collections c ON c.page_id = p.id WHERE p.id = $1 AND p.kind = 'collection'`
/** 一次最多删多少行（一个集合按 5,000 行以内设计） */
const TRASH_MAX = 5000
/** 批量改值 / 挪走一次最多多少行（逐行写文档），复制更重（连子页整份复制）另算 */
const SET_MAX = 500
const MOVE_MAX = 500
const DUPLICATE_MAX = 100

type Gate = { ok: true; collection: CollectionPage } | { ok: false; status: 403 | 404 }
type SetResult = { ok: true; values: [string, PropValue | null][] } | { ok: false; error: Record<string, string> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 批量端点的 ids：1..max 个字符串，不合格返回 null */
function readIds(body: unknown, max: number): string[] | null {
  const ids = isRecord(body) ? body.ids : undefined
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > max || !ids.every((x) => typeof x === 'string')) return null
  return [...new Set(ids as string[])]
}

/** after / before：缺省或 null 表示那一侧没有邻居，其余必须是字符串（false 表示形状不对） */
function neighborId(raw: unknown): string | null | false {
  if (raw === undefined || raw === null) return null
  return typeof raw === 'string' && raw !== '' ? raw : false
}

/** 把校验过的值写进行文档的 Y.Map('props')：null 删键，与现值相同的不写（不产生没有内容变化的增量） */
function writeProps(doc: Y.Doc, values: [string, PropValue | null][]): void {
  const props = doc.getMap<unknown>('props')
  for (const [key, value] of values) {
    if (value === null) {
      props.delete(key)
      continue
    }
    const current = props.get(key)
    if (current instanceof Y.AbstractType || JSON.stringify(current) !== JSON.stringify(value)) props.set(key, value)
  }
}

export function collectionRoutes(deps: CollectionDeps) {
  const { pool, write, getLiveDoc, notify, projector } = deps
  const app = new Hono<AuthEnv>()
  const auth = requireAuth(pool)

  async function gate(user: AuthUser, id: string, need: 'read' | 'write'): Promise<Gate> {
    const collection = await selectCollection(pool, id)
    const role = collection ? await pageAccess(pool, id, user) : null
    // 不存在、不是集合、非成员同响应：不泄露存在性
    if (!collection || role === null) return { ok: false, status: 404 }
    if (need === 'write' && !writable(role)) return { ok: false, status: 403 }
    return { ok: true, collection }
  }

  const denied = (c: Context<AuthEnv>, status: 403 | 404) =>
    c.json({ error: status === 404 ? 'collection not found' : 'forbidden' }, status)

  /** set 的每个键都必须是现有属性，值都要过 validateValue（人员只能选这个空间的成员）。有一个不行就整个不写 */
  async function readSet(raw: unknown, schema: CollectionSchema, spaceId: string | null): Promise<SetResult> {
    if (raw === undefined) return { ok: true, values: [] }
    if (!isRecord(raw)) return { ok: false, error: { error: 'set must be an object' } }
    const values: [string, PropValue | null][] = []
    let members: ReadonlySet<string> | undefined
    for (const [key, value] of Object.entries(raw)) {
      // 名称不在 set 里改（它是页面标题，走 title），created_time / edited_time 由 validateValue 拒绝
      const prop = isPropId(key) ? schema.props.find((p) => p.id === key) : undefined
      if (!prop) return { ok: false, error: { error: 'unknown property', prop: key } }
      if (prop.type === 'person' && !members) members = new Set((await spaceMembers(pool, spaceId)).keys())
      const checked = validateValue(prop, value, { members })
      if (!checked.ok) return { ok: false, error: { error: 'invalid value', prop: key, message: checked.error } }
      values.push([key, checked.value])
    }
    return { ok: true, values }
  }

  /** 邻居必须是这个集合的另一行（不能是自己，两侧不能是同一行） */
  async function neighborsOk(collectionId: string, after: string | null, before: string | null, self: string | null): Promise<boolean> {
    const ids = [after, before].filter((id): id is string => id !== null)
    if (ids.length === 0) return true
    if (after !== null && after === before) return false
    if (self !== null && ids.includes(self)) return false
    return (await membersAmong(pool, collectionId, ids)).length === ids.length
  }

  app.post('/api/collections', auth, async (c) => {
    const user = c.get('user')
    const body: unknown = await c.req.json().catch(() => null)
    if (!isRecord(body)) return c.json({ error: 'body must be an object' }, 400)
    const { id, space_id: spaceId, parent_id: parentRaw, inline, title } = body
    if (id !== undefined && !(typeof id === 'string' && UUID_V4.test(id))) return c.json({ error: 'id must be a lowercase uuid v4' }, 400)
    if (typeof spaceId !== 'string') return c.json({ error: 'space_id required' }, 400)
    if (parentRaw !== undefined && parentRaw !== null && typeof parentRaw !== 'string') return c.json({ error: 'parent_id must be a string' }, 400)
    if (inline !== undefined && typeof inline !== 'boolean') return c.json({ error: 'inline must be a boolean' }, 400)
    if (title !== undefined && typeof title !== 'string') return c.json({ error: 'title must be a string' }, 400)
    const parentId = typeof parentRaw === 'string' ? parentRaw : null
    // 内联集合归父页正文里的集合块所有，没有父页就没有主人
    if (inline === true && parentId === null) return c.json({ error: 'inline collection needs parent_id' }, 400)
    // 空间：不存在与非成员同响应（不泄露存在性），viewer 403。父页的口径同 POST /api/pages（可见且同空间）
    if (!(await pool.query('SELECT 1 FROM spaces WHERE id = $1', [spaceId])).rows[0]) return c.json({ error: 'space not found' }, 404)
    const role = await roleInSpace(pool, user, spaceId)
    if (role === null) return c.json({ error: 'space not found' }, 404)
    if (!writable(role)) return c.json({ error: 'forbidden' }, 403)
    if (!(await parentOk(pool, user, parentId, spaceId))) return c.json({ error: 'parent_id not found' }, 400)
    // 父页只能是 doc 页：挂在集合 / 过程页 / skill 页下的集合，侧栏（集合是叶子）和视图（行只认 doc）里都找不到
    if (parentId !== null && !(await pool.query(SELECT_DOC_PAGE, [parentId])).rows[0]) {
      return c.json({ error: 'parent_id not found' }, 400)
    }
    const pageId = typeof id === 'string' ? id : randomUUID()
    const created = await createCollection(pool, {
      id: pageId,
      spaceId,
      parentId,
      ownerId: user.id,
      inline: inline === true,
      title: (title ?? '').trim(),
    })
    if (!created) return c.json({ error: 'id already exists' }, 409)
    notify()
    const page = (await pool.query<PageRow>(SELECT_API_PAGE, [pageId])).rows[0]
    if (!page) return denied(c, 404)
    return c.json({ ...toApiPage(page), inline: inline === true }, 201)
  })

  // 集合块的渲染判定用（collection-embed）：活着还是在回收站，父页是谁。按 id 直达，含回收站里的，
  // 块要分得清集合在回收站（给恢复按钮，恢复走 POST /api/pages/:id/restore）与无法加载。
  // 权限同恢复路由（pageRole：空间成员任意角色可读），非成员 / 不存在 / 不是集合同 404
  app.get('/api/collections/:id/state', auth, async (c) => {
    const row = (
      await pool.query<{ parent_id: string | null; title: string; space_id: string | null; owner_id: string | null; trashed: boolean; inline: boolean }>(
        SELECT_COLLECTION_STATE,
        [c.req.param('id')],
      )
    ).rows[0]
    if (!row || (await pageRole(pool, c.get('user'), row)) === null) return denied(c, 404)
    return c.json({ state: row.trashed ? 'trashed' : 'live', parent_id: row.parent_id, title: row.title, inline: row.inline })
  })

  app.get('/api/collections/:id/rows', auth, async (c) => {
    const id = c.req.param('id')
    const g = await gate(c.get('user'), id, 'read')
    if (!g.ok) return denied(c, g.status)
    const schema = await readSchema(pool, id, getLiveDoc)
    const view = pickView(schema, c.req.query('view'))
    const rows = await memberRows(pool, id)
    const tz = Number(c.req.query('tz'))
    const ctx: QueryCtx = { tzOffset: Number.isFinite(tz) ? tz : 0 }
    // 人员排序按用户名比，只有这个视图真按人员排序时才查成员名单
    if (view.sorts.some((sort) => findProp(schema, sort.prop)?.type === 'person')) {
      const names = await spaceMembers(pool, g.collection.space_id)
      ctx.nameOf = (userId) => names.get(userId)
    }
    const window = queryWindow(
      rows,
      view,
      schema,
      { group: c.req.query('group'), cursor: c.req.query('cursor') ?? null, limit: c.req.query('limit') ?? null },
      ctx,
    )
    return c.json(window)
  })

  app.post('/api/collections/:id/rows', auth, async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const g = await gate(user, id, 'write')
    if (!g.ok) return denied(c, g.status)
    const body: unknown = await c.req.json().catch(() => ({}))
    if (!isRecord(body)) return c.json({ error: 'body must be an object' }, 400)
    // 行 id 可由客户端给（乐观新建），口径同建集合
    const rowId = body.id
    if (rowId !== undefined && !(typeof rowId === 'string' && UUID_V4.test(rowId))) return c.json({ error: 'id must be a lowercase uuid v4' }, 400)
    if (body.title !== undefined && typeof body.title !== 'string') return c.json({ error: 'title must be a string' }, 400)
    const after = neighborId(body.after)
    const before = neighborId(body.before)
    if (after === false || before === false || !(await neighborsOk(id, after, before, null))) {
      return c.json({ error: 'after / before must be rows of this collection' }, 400)
    }
    const set = body.set === undefined ? null : await readSet(body.set, await readSchema(pool, id, getLiveDoc), g.collection.space_id)
    if (set && !set.ok) return c.json(set.error, 400)
    const props: Record<string, PropValue> = {}
    for (const [key, value] of set?.values ?? []) if (value !== null) props[key] = value
    const created = await createRow(pool, {
      ...(typeof rowId === 'string' ? { id: rowId } : {}),
      collectionId: id,
      spaceId: g.collection.space_id,
      ownerId: user.id,
      title: typeof body.title === 'string' ? body.title.trim() : '',
      props,
      after,
      before,
    })
    // null 表示集合在这期间进了回收站
    if (!created) return denied(c, 404)
    if (created === 'taken') return c.json({ error: 'id already exists' }, 409)
    // 新行是页面：页面列表变了。行进集合不另发集合增量，客户端从重拉到的页面列表感知；
    // 但定位置时重编号了，别的行的 position 全换了，要让观看者重取
    notify()
    if (created.renumbered) projector.reset(id)
    const found = await memberRow(pool, created.id)
    if (!found) return denied(c, 404)
    return c.json(found.row, 201)
  })

  app.patch('/api/collections/:id/rows/:rowId', auth, async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const rowId = c.req.param('rowId')
    const g = await gate(user, id, 'write')
    if (!g.ok) return denied(c, g.status)
    if ((await membersAmong(pool, id, [rowId])).length === 0) return c.json({ error: 'row not found' }, 404)
    const body: unknown = await c.req.json().catch(() => ({}))
    if (!isRecord(body)) return c.json({ error: 'body must be an object' }, 400)
    if (body.title !== undefined && typeof body.title !== 'string') return c.json({ error: 'title must be a string' }, 400)
    const after = neighborId(body.after)
    const before = neighborId(body.before)
    if (after === false || before === false || !(await neighborsOk(id, after, before, rowId))) {
      return c.json({ error: 'after / before must be other rows of this collection' }, 400)
    }
    // 全部校验完才动手：非法值整个请求 400，文档一个字都不改
    const set = body.set === undefined ? null : await readSet(body.set, await readSchema(pool, id, getLiveDoc), g.collection.space_id)
    if (set && !set.ok) return c.json(set.error, 400)
    const values = set?.values ?? []
    const title = typeof body.title === 'string' ? body.title.trim() : undefined

    // 值与标题一次写进行文档，记给发起的用户（快照作者和更新流水的改动人由此而来）
    if (values.length > 0 || title !== undefined) {
      await write(
        `page:${rowId}`,
        user,
        (doc, origin) => {
          doc.transact(() => {
            writeProps(doc, values)
            if (title !== undefined) setDocTitle(doc, title)
          }, origin)
        },
        'user',
      )
    }
    // 副本当场落库再响应（不等投影器的去抖），写的人随后查询一定看得到。增量照常由投影器发
    if (values.length > 0) await projector.flushRow(rowId)
    // 改名同普通页面：文档标题片段和 pages.title 双写，页面列表变了（广播 changed，不另发集合增量）
    if (title !== undefined) {
      await pool.query(SET_TITLE, [title, rowId])
      notify()
    }
    let moved: Awaited<ReturnType<typeof memberRow>> = null
    if (after !== null || before !== null) {
      const renumbered = await moveRow(pool, id, rowId, after, before)
      // 手动顺序只发集合增量（属性没变，prev 为空），不广播 changed：拖一下不该让全站重拉页面列表。
      // 重编号了（所有行的 position 都换了）只发 reset，不逐行下发
      moved = await memberRow(pool, rowId)
      if (renumbered) projector.reset(id)
      else if (moved) projector.publish(id, { row: moved.row, prev: {} })
    }
    const found = moved ?? (await memberRow(pool, rowId))
    if (!found) return c.json({ error: 'row not found' }, 404)
    return c.json(found.row)
  })

  app.post('/api/collections/:id/rows/trash', auth, async (c) => {
    const id = c.req.param('id')
    const g = await gate(c.get('user'), id, 'write')
    if (!g.ok) return denied(c, g.status)
    const ids = readIds(await c.req.json().catch(() => ({})), TRASH_MAX)
    if (!ids) return c.json({ error: `ids must be 1..${TRASH_MAX} row ids` }, 400)
    // 只收这个集合的活行，别的 id（不存在、别的集合、已在回收站）一律当不存在，不理
    const rows = await membersAmong(pool, id, ids)
    // 删行是把行页面（连同子页）移进回收站，页面列表变了，客户端经它感知行出了集合
    return c.json({ trashed: await trashPageSubtree(pool, rows, notify) })
  })

  app.post('/api/collections/:id/rows/set', auth, async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const g = await gate(user, id, 'write')
    if (!g.ok) return denied(c, g.status)
    const body: unknown = await c.req.json().catch(() => ({}))
    const ids = readIds(body, SET_MAX)
    if (!ids) return c.json({ error: `ids must be 1..${SET_MAX} row ids` }, 400)
    const raw = isRecord(body) ? body.set : undefined
    if (!isRecord(raw) || Object.keys(raw).length === 0) return c.json({ error: 'set must be a non-empty object' }, 400)
    // 一次校验全部值，非法整批 400，一行都不写
    const set = await readSet(raw, await readSchema(pool, id, getLiveDoc), g.collection.space_id)
    if (!set.ok) return c.json(set.error, 400)
    const rows = []
    for (const rowId of await membersAmong(pool, id, ids)) {
      // 逐行同 PATCH：先写行文档（记给发起人）再让副本当场落库，增量由投影器照常发，不广播 changed
      await write(`page:${rowId}`, user, (doc, origin) => doc.transact(() => writeProps(doc, set.values), origin), 'user')
      await projector.flushRow(rowId)
      const found = await memberRow(pool, rowId)
      if (found) rows.push(found.row)
    }
    return c.json({ rows })
  })

  app.post('/api/collections/:id/rows/duplicate', auth, async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const g = await gate(user, id, 'write')
    if (!g.ok) return denied(c, g.status)
    const ids = readIds(await c.req.json().catch(() => ({})), DUPLICATE_MAX)
    if (!ids) return c.json({ error: `ids must be 1..${DUPLICATE_MAX} row ids` }, 400)
    if (g.collection.space_id === null) return denied(c, 404)
    const members = new Set(await membersAmong(pool, id, ids))
    const sources = ids.filter((rowId) => members.has(rowId))
    if (sources.length === 0) return c.json({ created: [] }, 201)
    // 事务外解析整棵子树的文档（clone.ts 的契约：事务内只做纯 DB 写）
    const docs = await resolveDocs(pool, getLiveDoc, await collectSubtreeIds(pool, sources))
    const rows = sources.map((rowId) => {
      const state = docs.get(`page:${rowId}`)
      const doc = new Y.Doc()
      if (state) Y.applyUpdate(doc, state)
      return { id: rowId, props: doc.getMap<unknown>('props').toJSON() }
    })
    const done = await duplicateRows(pool, { collectionId: id, spaceId: g.collection.space_id, ownerId: user.id, rows, docs })
    if (!done) return denied(c, 404)
    // 新行是页面：页面列表变了（客户端经它重取窗口），重编号了也要让观看者重取
    if (done.created.length > 0) notify()
    if (done.renumbered) projector.reset(id)
    return c.json({ created: done.created }, 201)
  })

  app.post('/api/collections/:id/rows/move', auth, async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const g = await gate(user, id, 'write')
    if (!g.ok) return denied(c, g.status)
    const body: unknown = await c.req.json().catch(() => ({}))
    const ids = readIds(body, MOVE_MAX)
    if (!ids) return c.json({ error: `ids must be 1..${MOVE_MAX} row ids` }, 400)
    const to = isRecord(body) ? body.to : undefined
    if (typeof to !== 'string' || to === '') return c.json({ error: 'to must be a collection id' }, 400)
    if (to === id) return c.json({ error: 'to must be another collection' }, 400)
    const target = await gate(user, to, 'write')
    if (!target.ok) return c.json({ error: target.status === 404 ? 'target collection not found' : 'forbidden' }, target.status)
    // 跨空间移动一律拒绝（同 PATCH /api/pages/:id 的 parent_id）
    if (target.collection.space_id !== g.collection.space_id) return c.json({ error: 'target must be in the same space' }, 400)
    const [from, dest, people] = await Promise.all([
      readSchema(pool, id, getLiveDoc),
      readSchema(pool, to, getLiveDoc),
      spaceMembers(pool, g.collection.space_id),
    ])
    const members = new Set(people.keys())
    const rows = []
    for (const rowId of await membersAmong(pool, id, ids)) {
      const doc = await loadDocForRead(pool, `page:${rowId}`, getLiveDoc)
      rows.push({ id: rowId, mapped: mapProps(from, dest, doc.getMap<unknown>('props').toJSON(), members) })
    }
    const moved = await moveRowsTo(pool, id, to, rows)
    if (!moved) return c.json({ error: 'target collection not found' }, 404)
    const mapped = new Map(rows.map((r) => [r.id, r.mapped]))
    for (const rowId of moved) {
      // 行已属目标集合：整份换成改写后的值（旧集合的属性 id 在这里没有意义），投影器的增量发给目标集合
      const values = mapped.get(rowId) ?? {}
      await write(
        `page:${rowId}`,
        user,
        (doc, origin) => {
          const props = doc.getMap<unknown>('props')
          doc.transact(() => {
            for (const key of [...props.keys()]) if (!(key in values)) props.delete(key)
            writeProps(doc, Object.entries(values))
          }, origin)
        },
        'user',
      )
      await projector.flushRow(rowId)
    }
    if (moved.length > 0) notify()
    return c.json({ moved })
  })

  return app
}
