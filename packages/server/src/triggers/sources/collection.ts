// ---------- 来源：合集里有变化（source = 'collection'，规则挂在合集上：scope_page = 合集） ----------
// 两种：新增了一行（on = 'added'）、属性改了（on = 'edited'，可选只看哪些属性 + 改成满足哪些条件）。到点的那种是挂在合集上的定时规则（source = 'timer'）。
// 属性改了：投影器（collections/projector.ts）写副本、发增量时交来 { 行, 改之前的值, 是谁改的 }；认不出是谁改的（加载时的校准补写、
//   没有归属的内部写入）不触发。条件 = 视图筛选同一套（matchFilter）：「改之前不满足、改之后满足」才算，满足之后再改别的属性不重复触发。
//   主人自己的 agent / Genet 改的不触发主人自己的规则：「属性改了 → 叫 Genet 整理这一行」不然会自己叫醒自己（自动化动作的改动另由连锁深度兜住）。
// 新增了一行：建行的各条写路径（表格建行、复制 / 挪进、REST / agent / 自动化在合集下建页）调 rowsAdded。
// 谁改的都算（主人自己改的也算，不是外来的）；主人不再是合集所在空间的成员、合集进了回收站就不触发。
// 都在热路径之后：调用方交给 hub.background，不等。没有这种规则的合集只多一条按 scope_page 的查询。

import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type * as Y from 'yjs'
import {
  CONDITIONS_MAX,
  conditionValue,
  filterOps,
  findProp,
  isShortId,
  opNeedsValue,
  TITLE_NAME,
  TITLE_PROP_ID,
  type CollectionRow,
  type CollectionSchema,
  type Condition,
  type FilterOp,
} from '@ramet/shared/collection-model'
import { matchFilter } from '@ramet/shared/collection-query'
import { pageAccess } from '../../collab.js'
import { memberRowsAmong, readSchema } from '../../collections/store.js'
import { rawText, referenced, rowTexts, type TextCtx } from '../../collections/value-text.js'
import type { Editor } from '../../edit-marks.js'
import type { TriggerHub } from '../hub.js'
import { pageVisibleSql } from '../../page-visibility.js'
import { tzOffset } from '../store.js'
import type { EventPayload } from '../payload.js'

export type CollectionOn = 'added' | 'edited'
export type CollectionConfig = { collection: string; on: CollectionOn; props: string[]; filter: { all: Condition[] } }

const PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PROPS_MAX = 50

const isPropRef = (v: unknown): v is string => v === TITLE_PROP_ID || isShortId(v)

/** 形状：合集 id、on、props（属性 id，空 = 任意）、filter.all（条件；属性在不在定义里由 check 判） */
export function parseCollectionConfig(raw: unknown): CollectionConfig | { error: string } {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const collection = typeof r.collection === 'string' ? r.collection.replace(/^page:/, '') : ''
  if (!PAGE_ID.test(collection)) return { error: '是哪个合集？（collection 填合集的页面 id）' }
  if (r.on !== 'added' && r.on !== 'edited') return { error: 'on 只能是 added（新增了一行）或 edited（属性改了）' }
  const props = r.props ?? []
  if (!Array.isArray(props) || props.length > PROPS_MAX || !props.every(isPropRef)) return { error: `props 要写成属性 id 的列表（最多 ${PROPS_MAX} 个）` }
  const all = (r.filter as { all?: unknown } | undefined)?.all ?? []
  if (!Array.isArray(all) || all.length > CONDITIONS_MAX) return { error: `条件最多 ${CONDITIONS_MAX} 个` }
  const conds: Condition[] = []
  for (const c of all) {
    const item = c && typeof c === 'object' ? (c as Record<string, unknown>) : {}
    const value = item.value
    if (!isPropRef(item.prop) || typeof item.op !== 'string' || (value !== undefined && typeof value !== 'string' && typeof value !== 'number')) {
      return { error: '条件要写成 { prop, op, value? }' }
    }
    conds.push(value === undefined ? { prop: item.prop, op: item.op as FilterOp } : { prop: item.prop, op: item.op as FilterOp, value })
  }
  // 「新增了一行」不带属性与条件
  return r.on === 'added'
    ? { collection, on: 'added', props: [], filter: { all: [] } }
    : { collection, on: 'edited', props: [...new Set(props)], filter: { all: conds } }
}

/** 建 / 改配置时：合集是活的、主人能编辑它；属性与条件对得上现在的定义（条件的值要填完整） */
export async function checkCollectionConfig(
  deps: { pool: Pool; getLiveDoc?: (docName: string) => Y.Doc | undefined },
  owner: { id: string; role: string },
  config: CollectionConfig,
): Promise<string | null> {
  const page = (await deps.pool.query<{ kind: string }>('SELECT kind FROM live_pages WHERE id = $1', [config.collection])).rows[0]
  const role = page ? await pageAccess(deps.pool, config.collection, owner) : null
  if (!page || page.kind !== 'collection' || role === null) return '那个合集不在了，或者你看不到它'
  if (role === 'viewer') return '你不能编辑这个合集'
  const schema = await readSchema(deps.pool, config.collection, deps.getLiveDoc)
  for (const id of config.props) if (!findProp(schema, id)) return '要看的属性有的已经不在了'
  for (const c of config.filter.all) {
    const prop = findProp(schema, c.prop)
    if (!prop) return '条件里的属性有的已经不在了'
    if (!(filterOps(prop) as readonly string[]).includes(c.op)) return `条件「${prop.name}」的比较方式不适用于这种属性`
    if (opNeedsValue(c.op) && conditionValue(prop, c.op, c.value) === undefined) return `条件「${prop.name}」的值没填好`
  }
  return null
}

/** 「《任务》新增了一行」/「《任务》的属性改了（2 个属性 · 1 个条件）」；title = null 表示主人看不到那个合集了 */
export function describeCollection(raw: unknown, title: string | null): string {
  const c = parseCollectionConfig(raw)
  if ('error' in c) return '（合集的触发认不出来）'
  const where = title === null ? '（看不到的合集）' : `《${title || '无标题'}》`
  if (c.on === 'added') return `${where}新增了一行`
  const bits = [c.props.length > 0 ? `${c.props.length} 个属性` : '', c.filter.all.length > 0 ? `${c.filter.all.length} 个条件` : ''].filter(Boolean)
  return `${where}的属性改了${bits.length > 0 ? `（${bits.join(' · ')}）` : ''}`
}

export type CollectionEventDeps = {
  pool: Pool
  hub: Pick<TriggerHub, 'emit' | 'causedBy'>
  getLiveDoc?: (docName: string) => Y.Doc | undefined
}

type Candidate = { id: string; owner_id: string; config: CollectionConfig; time_zone: string; member: boolean }

/** 挂在这个合集上、启用中、这种 on 的规则（附带主人还看不看得到这个合集） */
async function candidates(pool: Pool, collectionId: string, on: CollectionOn): Promise<Candidate[]> {
  const { rows } = await pool.query<{ id: string; owner_id: string; config: unknown; time_zone: string; member: boolean }>(
    `SELECT t.id, t.owner_id, t.config, t.time_zone,
        EXISTS (SELECT 1 FROM live_pages p WHERE p.id = $1 AND p.kind = 'collection' AND ${pageVisibleSql('p', 't.owner_id')}) AS member
       FROM agent_triggers t WHERE t.source = 'collection' AND t.enabled AND t.scope_page = $1 AND t.config->>'on' = $2`,
    [collectionId, on],
  )
  return rows.flatMap((r) => {
    const config = parseCollectionConfig(r.config)
    return 'error' in config ? [] : [{ ...r, config }]
  })
}

/** 名字与标题一次查齐（人员、创建者 / 最后编辑者、关联行）；按钮列的载荷也用 */
export async function textCtx(pool: Pool, schema: CollectionSchema, rows: CollectionRow[], extraProps: Array<Record<string, unknown>> = []): Promise<TextCtx> {
  const { users, pages } = referenced(schema, [...rows.map((r) => r.props), ...extraProps])
  for (const r of rows) for (const id of [r.created_by, r.edited_by]) if (id) users.add(id)
  const names = new Map(
    (await pool.query<{ id: string; username: string }>('SELECT id, username FROM users WHERE id = ANY($1::text[])', [[...users]])).rows.map((r) => [
      r.id,
      r.username,
    ]),
  )
  const titles = new Map(
    (await pool.query<{ id: string; title: string }>('SELECT id, title FROM live_pages WHERE id = ANY($1::text[])', [[...pages]])).rows.map((r) => [
      r.id,
      r.title,
    ]),
  )
  return { name: (id) => names.get(id), title: (id) => titles.get(id) }
}

async function collectionTitle(pool: Pool, id: string): Promise<string> {
  return (await pool.query<{ title: string }>('SELECT title FROM pages WHERE id = $1', [id])).rows[0]?.title ?? ''
}

function payloadOf(
  row: CollectionRow,
  texts: Record<string, string>,
  collection: string,
  collectionId: string,
  actor: { id: string; name: string },
): Omit<EventPayload, 'source'> {
  return {
    actor,
    page: { id: row.id, title: row.title },
    row: { id: row.id, props: texts },
    extra: [
      ['合集', `《${collection || '无标题'}》（page:${collectionId}）`],
      ['链接', `/page/${row.id}`],
    ],
  }
}

/** 一行的属性改了（投影器写完副本之后）：prev = 改之前与现在不同的那些（null = 当时没有这个键；键 title 是旧标题） */
export async function rowChanged(
  deps: CollectionEventDeps,
  e: { collectionId: string; row: CollectionRow; prev: Record<string, unknown>; editor: Editor },
): Promise<void> {
  const { pool, hub } = deps
  const rules = await candidates(pool, e.collectionId, 'edited')
  if (rules.length === 0) return
  const changed = Object.keys(e.prev)
  const schema = await readSchema(pool, e.collectionId, deps.getLiveDoc)
  const beforeProps = { ...e.row.props }
  for (const [k, v] of Object.entries(e.prev)) {
    if (k === TITLE_PROP_ID) continue
    if (v === null) delete beforeProps[k]
    else beforeProps[k] = v
  }
  const before: CollectionRow = { ...e.row, props: beforeProps, title: typeof e.prev.title === 'string' ? e.prev.title : e.row.title }
  const now = new Date()
  const fire = new Set<string>()
  for (const r of rules) {
    if (!r.member) continue
    if (r.owner_id === e.editor.userId && e.editor.actor === 'agent') continue
    if (r.config.props.length > 0 && !r.config.props.some((p) => changed.includes(p))) continue
    if (r.config.filter.all.length > 0) {
      const ctx = { tzOffset: tzOffset(r.time_zone, now) }
      if (!matchFilter(e.row, r.config.filter, schema, ctx) || matchFilter(before, r.config.filter, schema, ctx)) continue
    }
    fire.add(r.id)
  }
  if (fire.size === 0) return
  const ctx = await textCtx(pool, schema, [e.row], [beforeProps])
  const changes = changed.flatMap((key) => {
    if (key === TITLE_PROP_ID) return [{ prop: TITLE_NAME, from: before.title, to: e.row.title }]
    const prop = findProp(schema, key)
    return prop ? [{ prop: prop.name, from: rawText(prop, e.prev[key], ctx), to: rawText(prop, e.row.props[key], ctx) }] : []
  })
  const actor = { id: e.editor.userId, name: ctx.name(e.editor.userId) ?? (await userName(pool, e.editor.userId)) }
  await hub.emit({
    source: 'collection',
    key: `collection_edit:${e.row.id}:${randomUUID()}`,
    scopePage: e.collectionId,
    actorId: e.editor.userId,
    depth: hub.causedBy(e.row.id),
    payload: { ...payloadOf(e.row, rowTexts(schema, e.row, ctx), await collectionTitle(pool, e.collectionId), e.collectionId, actor), changes },
    match: (rule) => fire.has(rule.id),
  })
}

async function userName(pool: Pool, id: string): Promise<string> {
  return (await pool.query<{ username: string }>('SELECT username FROM users WHERE id = $1', [id])).rows[0]?.username ?? '已注销用户'
}

/** 这些页刚建在 / 挪到 parentId 下：parentId 是合集就按「新增了一行」触发（不是合集什么都不做）。每行只触发一次（幂等键按行） */
export async function rowsAdded(deps: CollectionEventDeps, parentId: string, rowIds: readonly string[], actorId: string): Promise<void> {
  const { pool, hub } = deps
  if (rowIds.length === 0) return
  const rules = (await candidates(pool, parentId, 'added')).filter((r) => r.member)
  if (rules.length === 0) return
  const rows = await memberRowsAmong(pool, parentId, [...rowIds])
  if (rows.length === 0) return
  const schema = await readSchema(pool, parentId, deps.getLiveDoc)
  const ctx = await textCtx(pool, schema, rows)
  const collection = await collectionTitle(pool, parentId)
  const actor = { id: actorId, name: ctx.name(actorId) ?? (await userName(pool, actorId)) }
  const ids = new Set(rules.map((r) => r.id))
  for (const row of rows) {
    await hub.emit({
      source: 'collection',
      key: `collection_add:${row.id}`,
      scopePage: parentId,
      actorId,
      depth: hub.causedBy(row.id),
      payload: payloadOf(row, rowTexts(schema, row, ctx), collection, parentId, actor),
      match: (rule) => ids.has(rule.id),
    })
  }
}
