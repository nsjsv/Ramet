// ---------- agent 改合集的定义：edit_collection 的 ops，create_collection 的初始结构 ----------
// 整批先在一份副本上演练（planOps）：按名字找属性、预先定好新 id、公式按演练到这一步的定义换成存储形、关联的另一端判可写 / 同空间，
// 每一步都写进副本，下一步看到的就是写过之后的定义（后面的公式 / 汇总能引用前面刚加的属性）；有一步不行就整批不写。
// 演练得到一串定好 id 的写入，再一次写进真文档（applyPlan：一个事务、记给 agent）；关联的反向属性写在对方合集里，先于本合集写。
// 删属性只摘定义（各行的值还在行文档里，恢复合集页的版本就回来），同界面；删关联连另一端一起删，同关联的 REST。

import type { Pool } from 'pg'
import * as Y from 'yjs'
import {
  isDateType,
  isReverseRelation,
  newShortId,
  newView,
  parseCollection,
  rollupFns,
  STATUS_GROUPS,
  TITLE_NAME,
  TITLE_PROP,
  toStored,
  type CollectionLayout,
  type CollectionProp,
  type CollectionSchema,
  type OptionJson,
  type PropType,
  type StatusGroup,
} from '@ramet/shared/collection-model'
import { COLOR_NAMES } from '@ramet/shared/md-dialect'
import { setDocTitle, type DocWriter } from '../collab.js'
import { collectionGate } from '../routes/collections.js'
import { SET_TITLE } from '../routes/pages.js'
import { LAYOUT_NAMES, TYPE_NAMES } from './ai-names.js'
import { AiQueryError, conditionsOf, propByName, sortsOf } from './ai-query.js'
import { listing, lookups } from './ai-write.js'
import { addOptionsIn, addPropIn, addViewIn, clipName, propMap, propsMap, relationPlan, takenIds, type PropWrite } from './schema-write.js'
import { readSchema, type CollectionPage } from './store.js'

/** 一批最多多少步（一次建一张表够用；再多分几次） */
export const OPS_MAX = 50
/** 新列表视图默认显示几个属性（同界面） */
const LIST_SHOWN = 3

type Step = (doc: Y.Doc) => void
export type Plan = { main: Step[]; others: Map<string, Step[]>; title?: string; changes: string[] }
type User = { id: string; role: string }
type Ctx = { pool: Pool; getLiveDoc: ((name: string) => Y.Doc | undefined) | undefined; user: User; collection: CollectionPage }

const OPS = ['add_prop', 'rename_prop', 'delete_prop', 'add_options', 'add_view', 'rename']
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
function fail(message: string): never {
  throw new AiQueryError(message)
}
const schemaOf = (doc: Y.Doc): CollectionSchema => parseCollection(doc.getMap<unknown>('collection').toJSON())

/** 类型按 id 或界面上的叫法认；按钮要配规则，agent 建不了 */
function typeOf(raw: unknown): PropType {
  const key = str(raw)
  const found = (Object.keys(TYPE_NAMES) as PropType[]).find((t) => t === key || TYPE_NAMES[t] === key)
  if (!found) fail(`不认识属性类型「${key}」，可选：${Object.entries(TYPE_NAMES).filter(([t]) => t !== 'button').map(([t, n]) => `${t}（${n}）`).join('、')}`)
  if (found === 'button') fail('按钮属性要配一条规则，在界面上建')
  return found
}

function layoutOf(raw: unknown): CollectionLayout {
  const key = str(raw) || 'table'
  const found = (Object.keys(LAYOUT_NAMES) as CollectionLayout[]).find((l) => l === key || LAYOUT_NAMES[l] === key)
  return found ?? fail(`不认识视图布局「${key}」，可选：${Object.entries(LAYOUT_NAMES).map(([l, n]) => `${l}（${n}）`).join('、')}`)
}

function nameFree(schema: CollectionSchema, name: string): string {
  const clipped = clipName(name)
  if (!clipped) fail('属性要有名字')
  if (clipped === TITLE_NAME || schema.props.some((p) => p.name.trim() === clipped)) fail(`已经有叫「${clipped}」的属性了`)
  return clipped
}

function existing(schema: CollectionSchema, raw: unknown): CollectionProp {
  const prop = propByName(schema, raw)
  if (prop === TITLE_PROP) fail(`「${TITLE_NAME}」是每个合集都有的标题列，不能改名或删除`)
  return prop
}

/** 新选项：名字去重、颜色轮着取（灰色留给「未开始」）；状态的选项按名字认组，认不出的头一个算未开始、最后一个算已完成、其余进行中 */
function optionsOf(type: PropType, raw: unknown, taken: Set<string>, skip: Set<string> = new Set()): Record<string, OptionJson> {
  if (raw === undefined) return {}
  if (!Array.isArray(raw)) fail('options 要写成选项名的列表')
  const list = (raw as unknown[]).map((item) => (isRecord(item) ? { name: str(item.name), group: str(item.group) } : { name: str(item), group: '' })).filter((o) => o.name && !skip.has(o.name))
  const out: Record<string, OptionJson> = {}
  const seen = new Set<string>()
  list.forEach((item, i) => {
    const name = clipName(item.name)
    if (seen.has(name)) return
    seen.add(name)
    const id = newShortId(taken)
    taken.add(id)
    const option: OptionJson = { name, color: COLOR_NAMES[(i % (COLOR_NAMES.length - 1)) + 1]!, pos: i }
    if (type === 'status') {
      const group = STATUS_GROUPS.find((g) => g.id === item.group || g.name === item.group || g.name === name)?.id
      option.group = group ?? statusGuess(i, list.length)
      if (option.group === 'todo') option.color = 'gray'
    }
    out[id] = option
  })
  return out
}

const statusGuess = (i: number, n: number): StatusGroup => (i === 0 ? 'todo' : i === n - 1 && n > 1 ? 'done' : 'doing')

/** 关联 / 汇总要读的另一个合集：本合集（自关联）读副本，别的合集要可写（关联要在对方那里加反向属性）且同空间 */
async function otherCollection(ctx: Ctx, scratch: Y.Doc, raw: unknown, need: 'read' | 'write'): Promise<{ collection: CollectionPage; schema: CollectionSchema; self: boolean }> {
  const id = str(raw).replace(/^(collection|page):/, '')
  if (!id) fail('关联要给 target（对方合集的 collection:<id>）')
  if (id === ctx.collection.id) return { collection: ctx.collection, schema: schemaOf(scratch), self: true }
  const gate = await collectionGate(ctx.pool, ctx.user, id, need)
  if (!gate.ok) fail(gate.status === 403 ? `你在合集 ${id} 里只能看，不能在那边加反向关联` : `没有合集 ${id}`)
  if (gate.collection.space_id !== ctx.collection.space_id) fail(`合集 ${id} 不在这个空间里`)
  return { collection: gate.collection, schema: await readSchema(ctx.pool, id, ctx.getLiveDoc), self: false }
}

async function addProp(ctx: Ctx, scratch: Y.Doc, op: Record<string, unknown>, plan: Plan, push: (step: Step) => void): Promise<void> {
  const schema = schemaOf(scratch)
  const name = nameFree(schema, str(op.name))
  const type = typeOf(op.type)
  if (type === 'relation') {
    const other = await otherCollection(ctx, scratch, op.target, 'write')
    const self = { collection: ctx.collection, schema }
    const rel = relationPlan(self, other.self ? self : other, {
      name,
      twoWay: op.two_way === true,
      ...(str(op.reverse_name) ? { reverseName: str(op.reverse_name) } : {}),
      single: op.single === true,
    })
    rel.forward.name = name
    push((doc) => addPropIn(doc, rel.propId, rel.forward))
    if (rel.reverseId) {
      const reverseId = rel.reverseId
      const step: Step = (doc) => addPropIn(doc, reverseId, rel.reverse)
      if (other.self) push(step)
      else plan.others.set(other.collection.id, [...(plan.others.get(other.collection.id) ?? []), step])
    }
    plan.changes.push(`加了关联「${name}」→ 合集「${other.collection.title || '无标题'}」${rel.reverseId ? `（对方多了反向关联「${rel.reverse.name}」）` : ''}`)
    return
  }
  const taken = takenIds(schema)
  const id = newShortId(taken)
  taken.add(id)
  const json: PropWrite = { name, type }
  if (type === 'select' || type === 'multi_select' || type === 'status') {
    const options = optionsOf(type, op.options, taken)
    json.options = type === 'status' && Object.keys(options).length === 0 ? optionsOf('status', STATUS_GROUPS.map((g) => g.name), taken) : options
  }
  if (type === 'unique_id' && str(op.prefix)) json.cfg = { prefix: str(op.prefix) }
  if (type === 'ai') json.cfg = { prompt: str(op.prompt) }
  if (type === 'formula') {
    const expr = str(op.formula)
    if (!expr) fail(`公式属性「${name}」要给 formula（如 [单价] * [数量]）`)
    const stored = toStored(expr, schema)
    if (!stored.ok) fail(`公式「${expr}」写错了：${stored.error.message}`)
    json.cfg = { expr: stored.expr }
  }
  if (type === 'rollup') {
    const relation = propByName(schema, op.relation)
    if (relation.type !== 'relation') fail(`汇总要沿一个关联属性（relation），「${str(op.relation)}」不是关联`)
    const other = await otherCollection(ctx, scratch, relation.cfg.target, 'read')
    const target = propByName(other.schema, op.of)
    const fns = rollupFns(target.type)
    const fn = str(op.fn)
    if (!(fns as readonly string[]).includes(fn)) fail(`汇总「${target.name || TITLE_NAME}」能用的计算方式：${fns.join('、')}`)
    json.cfg = { relation: relation.id, prop: target.id, fn }
  }
  push((doc) => addPropIn(doc, id, json))
  // 公式按整份定义编译：引用对了但类型对不上（文字乘数字之类）在这里才看得出
  const added = schemaOf(scratch).props.find((p) => p.id === id)
  if (type === 'formula' && added?.output === null) fail(`公式「${str(op.formula)}」算不出来：${added.formulaError?.message ?? '类型对不上'}`)
  plan.changes.push(`加了${TYPE_NAMES[type]}属性「${name}」`)
}

async function addView(ctx: Ctx, scratch: Y.Doc, op: Record<string, unknown>, plan: Plan, push: (step: Step) => void): Promise<void> {
  const schema = schemaOf(scratch)
  const layout = layoutOf(op.layout)
  const name = clipName(str(op.name)) || LAYOUT_NAMES[layout]
  let groupBy: string | null = null
  if (layout === 'board' || ((layout === 'table' || layout === 'list') && op.group_by !== undefined)) {
    const prop = op.group_by !== undefined ? propByName(schema, op.group_by) : schema.props.find((p) => p.type === 'status' || p.type === 'select')
    if (!prop) fail('看板要按单选或状态属性分列，合集里还没有，先加一个')
    if (prop.type !== 'status' && prop.type !== 'select') fail(`只能按单选或状态分组，「${prop.name}」是${TYPE_NAMES[prop.type]}`)
    groupBy = prop.id
  }
  let dateBy: string | null = null
  if (layout === 'calendar' || layout === 'timeline') {
    const prop = op.date_by !== undefined ? propByName(schema, op.date_by) : schema.props.find((p) => isDateType(p.type))
    if (!prop || !isDateType(prop.type)) fail(`${LAYOUT_NAMES[layout]}要按日期类属性排，${prop ? `「${prop.name}」不是日期` : '合集里还没有，先加一个'}`)
    dateBy = prop.id
  }
  const json = newView(name, layout, 0, groupBy, dateBy)
  json.filter = { all: await conditionsOf(schema, op.where, lookups(ctx.pool, ctx.collection)) }
  json.sorts = sortsOf(schema, op.sort)
  if (layout === 'list') json.shown = schema.props.slice(0, LIST_SHOWN).map((p) => p.id)
  const id = newShortId(takenIds(schema))
  push((doc) => addViewIn(doc, id, json))
  plan.changes.push(`加了${LAYOUT_NAMES[layout]}视图「${name}」`)
}

async function deleteProp(ctx: Ctx, scratch: Y.Doc, op: Record<string, unknown>, plan: Plan, push: (step: Step) => void): Promise<void> {
  const prop = existing(schemaOf(scratch), op.prop)
  push((doc) => propsMap(doc).delete(prop.id))
  // 关联连另一端一起删（同关联的 REST）；另一端不可写 / 不在了就只删这边
  const pair = prop.type === 'relation' ? (isReverseRelation(prop) ? prop.cfg.mirror : prop.cfg.reverse) : undefined
  const target = prop.cfg.target
  if (pair && target) {
    const step: Step = (doc) => propsMap(doc).delete(pair)
    if (target === ctx.collection.id) push(step)
    else {
      const gate = await collectionGate(ctx.pool, ctx.user, target, 'write')
      if (gate.ok && gate.collection.space_id === ctx.collection.space_id) plan.others.set(target, [...(plan.others.get(target) ?? []), step])
    }
  }
  plan.changes.push(`删了属性「${prop.name}」`)
}

/** 演练一批 ops（scratch 会被改掉，调用方给一份副本）。不行抛 AiQueryError */
export async function planOps(ctx: Ctx, scratch: Y.Doc, ops: unknown): Promise<Plan> {
  if (!Array.isArray(ops) || ops.length === 0) fail('ops 要是一个非空列表')
  if ((ops as unknown[]).length > OPS_MAX) fail(`一次最多 ${OPS_MAX} 步，分几次改`)
  const plan: Plan = { main: [], others: new Map(), changes: [] }
  const push = (step: Step): void => {
    scratch.transact(() => step(scratch))
    plan.main.push(step)
  }
  for (const [i, raw] of (ops as unknown[]).entries()) {
    try {
      if (!isRecord(raw)) fail('每一步要写成 { op, ... }')
      const op = raw as Record<string, unknown>
      const kind = str(op.op)
      if (kind === 'add_prop') await addProp(ctx, scratch, op, plan, push)
      else if (kind === 'add_view') await addView(ctx, scratch, op, plan, push)
      else if (kind === 'delete_prop') await deleteProp(ctx, scratch, op, plan, push)
      else if (kind === 'rename_prop') {
        const schema = schemaOf(scratch)
        const prop = existing(schema, op.prop)
        const name = nameFree(schema, str(op.name))
        push((doc) => propMap(doc, prop.id)?.set('name', name))
        plan.changes.push(`属性「${prop.name}」改名为「${name}」`)
      } else if (kind === 'add_options') {
        const schema = schemaOf(scratch)
        const prop = existing(schema, op.prop)
        if (prop.type !== 'select' && prop.type !== 'multi_select' && prop.type !== 'status') fail(`「${prop.name}」是${TYPE_NAMES[prop.type]}，没有选项`)
        const options = optionsOf(prop.type, op.options, takenIds(schema), new Set(prop.options.map((o) => o.name)))
        push((doc) => addOptionsIn(doc, prop.id, options))
        plan.changes.push(`属性「${prop.name}」加了选项 ${listing(Object.values(options).map((o) => o.name)) || '（都已经有了）'}`)
      } else if (kind === 'rename') {
        const title = clipName(str(op.title))
        if (!title) fail('rename 要给 title')
        plan.title = title
        plan.changes.push(`合集改名为「${title}」`)
      } else fail(`不认识的操作「${kind}」，可选：${OPS.join('、')}`)
    } catch (err) {
      if (err instanceof AiQueryError) throw new AiQueryError(`第 ${i + 1} 步：${err.message}`)
      throw err
    }
  }
  return plan
}

/** 演练过的写入落到真文档：对方合集的反向属性先写，再写本合集（一个事务）；记给 agent */
export async function applyPlan(deps: { pool: Pool; write: DocWriter }, user: User, collectionId: string, plan: Plan, skipMain = false): Promise<void> {
  const run = (steps: Step[], title?: string) => (doc: Y.Doc, origin: unknown) =>
    doc.transact(() => {
      for (const step of steps) step(doc)
      if (title !== undefined) setDocTitle(doc, title)
    }, origin)
  for (const [id, steps] of plan.others) await deps.write(`page:${id}`, user, run(steps), 'agent')
  if (!skipMain && (plan.main.length > 0 || plan.title !== undefined)) await deps.write(`page:${collectionId}`, user, run(plan.main, plan.title), 'agent')
  if (plan.title !== undefined) await deps.pool.query(SET_TITLE, [plan.title, collectionId])
}

/** create_collection 的初始结构：在新合集的文档上演练（它就是要写下去的那份），ops 里自己定义了「状态」就先去掉自带的那个 */
export async function planNewCollection(ctx: Ctx, doc: Y.Doc, ops: unknown): Promise<Plan> {
  if (ops === undefined || (Array.isArray(ops) && ops.length === 0)) return { main: [], others: new Map(), changes: [] }
  const names = new Set(Array.isArray(ops) ? ops.filter((op) => isRecord(op) && op.op === 'add_prop').map((op) => str((op as Record<string, unknown>).name)) : [])
  doc.transact(() => {
    for (const prop of schemaOf(doc).props) if (names.has(prop.name)) propsMap(doc).delete(prop.id)
  })
  return planOps(ctx, doc, ops)
}

/** 一份文档的副本（演练用，不碰活文档） */
export function scratchOf(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  return copy
}
