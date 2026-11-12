/* ---------- agent 读写合集的中心端点（Bearer，注册在 ramet-tools.ts 的 app 上，沿用它的凭证闸门与挂载位置） ----------
 * GET  /api/ramet/collections/:id?view=&where=&sort=&query=&cursor=&limit= → 属性定义、视图清单与一段行，值都已写成文字（collections/ai-read.ts）；
 *      where / sort 是 JSON 列表（写法见 collections/ai-query.ts），query 是关键词
 * POST /api/ramet/rows/set { rowIds, props?, title? } → { count, collection }：改一个合集里若干行的属性（title 只能改一行）
 * POST /api/ramet/collections { title, parentId?, ops? } → { id, title, parentId, changes }：建一个整页合集（父页同 create_page，只能是普通页）
 * POST /api/ramet/collections/:id/schema { ops } → { changes }：改属性 / 选项 / 视图 / 合集名（ops 的写法与演练见 collections/ai-schema.ts）
 * create_page 的父页是合集时建行走 rowCreator（ramet-tools.ts 调）：与界面建行同一条 insertRow（排在末尾、取号、副本同事务）。
 * 闸门同合集的 REST（collectionGate）：不存在 / 不是合集 / 非成员 / 在回收站同一个 404，写要可写（viewer 403）；
 * 空间 AI 的凭证碰到别的空间的合集也是这个 404。精简档在 ramet-tools.ts 的闸门里就 403 了；空间 AI 白名单里读是读、写是写。
 * 写值先整批换算、校验（collections/ai-write.ts → write-row.ts 的 readSet），有一个不行就一行都不写；写进行文档记给 agent（同 edit_page）。
 * 写有副作用：读到过外来事件的 Genet 先问主人（guard）。时间（创建时间、公式里的 TODAY()）按发起这一轮的用户的时区。 */

import type { Context, Hono } from 'hono'
import type { Pool } from 'pg'
import type * as Y from 'yjs'
import { readCollectionForAi } from '../collections/ai-read.js'
import { AiQueryError } from '../collections/ai-query.js'
import { aiSet, aiWriteError } from '../collections/ai-write.js'
import { applyPlan, planNewCollection, planOps, scratchOf } from '../collections/ai-schema.js'
import { newCollectionDoc } from '../collections/init-doc.js'
import { randomUUID } from 'node:crypto'
import type { Projector } from '../collections/projector.js'
import { createCollection, memberRow, readSchema, type CollectionPage } from '../collections/store.js'
import { insertRow, isRecord, readSet, writeRow, type RowWriteDeps } from '../collections/write-row.js'
import { loadDocForRead, type DocWriter } from '../collab.js'
import { parseNew } from '../page-write.js'
import { tzOffset, userTimeZone } from '../triggers/store.js'
import { collectionGate } from './collections.js'
import type { Outcome } from './ramet-consent.js'

type User = { id: string; role: string }

export type CollectionToolDeps = {
  pool: Pool
  getLiveDoc?: (docName: string) => Y.Doc | undefined
  /** 写行文档（collab.ts 的 DocWriter）与副本落库；不给 = 写端点 503 */
  write?: DocWriter
  projector?: Pick<Projector, 'flushRow'>
  /** Bearer → 发起的用户 + 凭证收窄到的空间（空间 AI）+ 有副作用时的审批（ramet-consent.ts）+ 新建东西放在哪（同 create_page：
   *  给了父页要可写且同空间，缺省 = 当前页下，没绑页面 = 空间顶层）；坏凭证 = null */
  granted(c: Context): Promise<{
    user: User
    space?: string
    guard(what: string, run: () => Promise<Outcome>): Promise<Response>
    parent(raw: unknown): Promise<{ spaceId: string; parentId: string | null } | { status: 400 | 403 | 404; error: string }>
  } | null>
  /** 行改了名：页面列表变了，广播 changed */
  notify?: () => void
}

/** 一次最多改多少行（逐行写文档，同集合 REST 的批量改值） */
const SET_ROWS_MAX = 100

type Gate = { collection: CollectionPage } | { status: 403 | 404; error: string }

/** 合集闸门 + 空间 AI 的空间判定：不在这个空间与不存在同一个 404 */
async function gateFor(pool: Pool, user: User, space: string | undefined, id: string, need: 'read' | 'write'): Promise<Gate> {
  const gate = await collectionGate(pool, user, id, need)
  if (!gate.ok) return gate.status === 403 ? { status: 403, error: '你在这个合集里只能看，不能改' } : { status: 404, error: '没有这个合集' }
  if (space !== undefined && gate.collection.space_id !== space) return { status: 404, error: '没有这个合集' }
  return { collection: gate.collection }
}

function rowDeps(deps: CollectionToolDeps): RowWriteDeps | null {
  if (!deps.write || !deps.projector) return null
  return { pool: deps.pool, write: deps.write, getLiveDoc: deps.getLiveDoc ?? (() => undefined), projector: deps.projector }
}

/** 换算 + 校验一份 props（不写）：可以写 = set，不行 = 人话的原因 */
async function checkedSet(deps: RowWriteDeps, collection: CollectionPage, props: unknown): Promise<{ set: Record<string, unknown> } | { error: string }> {
  const schema = await readSchema(deps.pool, collection.id, deps.getLiveDoc)
  const mapped = await aiSet(deps.pool, collection, schema, props)
  if (!mapped.ok) return { error: mapped.error }
  const checked = await readSet(deps, mapped.set, schema, collection)
  return checked.ok ? { set: mapped.set } : { error: aiWriteError(checked.error, schema) }
}

export type RowCreator = (
  user: User,
  space: string | undefined,
  collectionId: string,
  props: unknown,
) => Promise<{ status: 400 | 403 | 404 | 503; error: string } | { collection: CollectionPage; create(title: string, text: string): Promise<string | null> }>

/** create_page 的父页是合集：先判闸门、换算校验 props（不写），返回真正建行的 create（调用方放进审批里）。
 *  create 返回新行 id；合集在这期间进了回收站 = null */
export function rowCreator(deps: CollectionToolDeps): RowCreator {
  return async (user, space, collectionId, props) => {
    const write = rowDeps(deps)
    if (!write) return { status: 503, error: '没有文档写入通道' }
    const gate = await gateFor(deps.pool, user, space, collectionId, 'write')
    if (!('collection' in gate)) return gate
    const checked = props === undefined ? { set: undefined } : await checkedSet(write, gate.collection, props)
    if ('error' in checked) return { status: 400, error: checked.error }
    return {
      collection: gate.collection,
      create: async (title, text) => {
        const blocks = text ? parseNew(text) : []
        const created = await insertRow(write, user, gate.collection, { title, ...(checked.set ? { set: checked.set } : {}), blocks, after: null, before: null })
        if (!created) return null
        // 校验过了才建，这里还失败只可能是校验之后合集定义又变了
        if (created === 'taken' || !created.ok) throw new Error(created === 'taken' ? '行 id 冲突了' : aiWriteError(created.error, await readSchema(deps.pool, gate.collection.id, deps.getLiveDoc)))
        return created.id
      },
    }
  }
}

const BAD = Symbol('bad json')

/** 查询串里的 JSON 参数（where / sort）：没给 = undefined，解析不了 = BAD */
function jsonParam(raw: string | undefined): unknown {
  if (raw === undefined || raw === '') return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return BAD
  }
}

function rowIdsOf(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > SET_ROWS_MAX || !raw.every((x) => typeof x === 'string' && x.trim())) return null
  return [...new Set((raw as string[]).map((x) => x.trim().replace(/^page:/, '').replace(/[「#].*$/, '')))]
}

export function collectionToolRoutes(app: Hono, deps: CollectionToolDeps): void {
  const { pool } = deps

  app.get('/api/ramet/collections/:id', async (c) => {
    const g = await deps.granted(c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    const gate = await gateFor(pool, g.user, g.space, c.req.param('id'), 'read')
    if (!('collection' in gate)) return c.json({ error: gate.error }, gate.status)
    const offset = tzOffset(await userTimeZone(pool, g.user.id), new Date())
    const where = jsonParam(c.req.query('where'))
    const sort = jsonParam(c.req.query('sort'))
    if (where === BAD || sort === BAD) return c.json({ error: 'where / sort 要是 JSON 列表' }, 400)
    try {
      const read = await readCollectionForAi(pool, deps.getLiveDoc, gate.collection, {
        view: c.req.query('view'),
        where,
        sort,
        query: c.req.query('query'),
        cursor: c.req.query('cursor') ?? null,
        limit: c.req.query('limit') ?? null,
        tzOffset: offset,
      })
      return c.json(read)
    } catch (err) {
      if (err instanceof AiQueryError) return c.json({ error: err.message }, 400)
      throw err
    }
  })

  app.post('/api/ramet/rows/set', async (c) => {
    const g = await deps.granted(c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    const write = rowDeps(deps)
    if (!write) return c.json({ error: '没有文档写入通道' }, 503)
    const body: unknown = await c.req.json().catch(() => null)
    if (!isRecord(body)) return c.json({ error: '要给 { rowIds, props?, title? }' }, 400)
    const ids = rowIdsOf(body.rowIds)
    if (!ids) return c.json({ error: `rowIds 要是 1–${SET_ROWS_MAX} 个行 id` }, 400)
    const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : undefined
    if (body.title !== undefined && title === undefined) return c.json({ error: 'title 要是文字' }, 400)
    if (title !== undefined && ids.length > 1) return c.json({ error: 'title 一次只能改一行' }, 400)
    if (body.props === undefined && title === undefined) return c.json({ error: '要给 props 或 title' }, 400)
    // 行都要是同一个合集的活行；不在合集里的与不存在同一个 404
    let collectionId: string | null = null
    for (const id of ids) {
      const found = await memberRow(pool, id)
      if (!found) return c.json({ error: `没有这一行：page:${id}（不存在，或者不是合集里的行）` }, 404)
      if (collectionId !== null && found.collectionId !== collectionId) return c.json({ error: '这些行不在同一个合集里，分开改' }, 400)
      collectionId = found.collectionId
    }
    const gate = await gateFor(pool, g.user, g.space, collectionId!, 'write')
    if (!('collection' in gate)) return c.json({ error: gate.error }, gate.status)
    const checked = body.props === undefined ? { set: undefined } : await checkedSet(write, gate.collection, body.props)
    if ('error' in checked) return c.json({ error: checked.error }, 400)
    const what = `改合集「${gate.collection.title || '无标题'}」里 ${ids.length} 行${title !== undefined ? '的标题' : '的属性'}`
    return g.guard(what, async () => {
      let count = 0
      for (const id of ids) {
        const written = await writeRow(write, g.user, gate.collection, id, { ...(checked.set ? { set: checked.set } : {}), ...(title !== undefined ? { title } : {}), as: 'agent' })
        if (!written.ok) {
          const schema = await readSchema(pool, gate.collection.id, deps.getLiveDoc)
          return { status: 400, body: { error: `${aiWriteError(written.error, schema)}（已改了前 ${count} 行）` } }
        }
        count++
      }
      if (title !== undefined) deps.notify?.()
      return { status: 200, body: { count, collection: { id: gate.collection.id, title: gate.collection.title } } }
    })
  })

  app.post('/api/ramet/collections', async (c) => {
    const g = await deps.granted(c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    if (!deps.write) return c.json({ error: '没有文档写入通道' }, 503)
    const write = deps.write
    const body: unknown = await c.req.json().catch(() => null)
    if (!isRecord(body)) return c.json({ error: '要给 { title, parentId?, ops? }' }, 400)
    const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : ''
    if (!title) return c.json({ error: '合集要有名字（title）' }, 400)
    const where = await g.parent(body.parentId)
    if ('error' in where) return c.json({ error: where.error }, where.status)
    // 合集只能挂在普通页下（挂在合集 / 过程页 / skill 页下，侧栏和视图里都找不到它），同建合集的 REST
    if (where.parentId && !(await pool.query("SELECT 1 FROM live_pages WHERE id = $1 AND kind = 'doc'", [where.parentId])).rowCount) {
      return c.json({ error: '合集只能建在普通页面下' }, 400)
    }
    const id = randomUUID()
    const doc = newCollectionDoc(title)
    const collection: CollectionPage = { id, space_id: where.spaceId, title }
    let plan
    try {
      plan = await planNewCollection({ pool, getLiveDoc: deps.getLiveDoc, user: g.user, collection }, doc, body.ops)
    } catch (err) {
      if (err instanceof AiQueryError) return c.json({ error: err.message }, 400)
      throw err
    }
    return g.guard(`新建合集「${title}」`, async () => {
      if (!(await createCollection(pool, { id, spaceId: where.spaceId, parentId: where.parentId, ownerId: g.user.id, inline: false, title, doc }))) {
        return { status: 409, body: { error: '合集 id 冲突了，再试一次' } }
      }
      // 本合集的结构已经演练进 doc 里一起写下去了，这里只补对方合集的反向关联
      await applyPlan({ pool, write }, g.user, id, plan, true)
      deps.notify?.()
      return { status: 200, body: { id, title, parentId: where.parentId, changes: plan.changes } }
    })
  })

  app.post('/api/ramet/collections/:id/schema', async (c) => {
    const g = await deps.granted(c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    if (!deps.write) return c.json({ error: '没有文档写入通道' }, 503)
    const write = deps.write
    const gate = await gateFor(pool, g.user, g.space, c.req.param('id'), 'write')
    if (!('collection' in gate)) return c.json({ error: gate.error }, gate.status)
    const body: unknown = await c.req.json().catch(() => null)
    if (!isRecord(body)) return c.json({ error: '要给 { ops }' }, 400)
    const scratch = scratchOf(await loadDocForRead(pool, `page:${gate.collection.id}`, deps.getLiveDoc))
    let plan
    try {
      plan = await planOps({ pool, getLiveDoc: deps.getLiveDoc, user: g.user, collection: gate.collection }, scratch, body.ops)
    } catch (err) {
      if (err instanceof AiQueryError) return c.json({ error: err.message }, 400)
      throw err
    }
    return g.guard(`改合集「${gate.collection.title || '无标题'}」的结构`, async () => {
      await applyPlan({ pool, write }, g.user, gate.collection.id, plan)
      if (plan.title !== undefined) deps.notify?.()
      return { status: 200, body: { changes: plan.changes } }
    })
  })
}
