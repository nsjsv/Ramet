// ---------- agent 临时筛选合集：read_collection 的 where / sort，edit_collection 建视图的筛选与排序 ----------
// where / sort 换成视图的 filter / sorts（形状同界面存下的），交给同一个 queryWindow：条件的判定与表格的筛选同一份（matchFilter），
// 不另写一套。比较值按人话认（选项名、用户名、关联行的标题、状态组名），换成 conditionValue 要的形状；
// 运算收筛选运算的 id（filterOps 里有的），也收 = != > < >= <= 与几个中文说法，按属性类型换成对应的运算。

import {
  filterOps,
  findProp,
  isDateType,
  opNeedsValue,
  conditionValue,
  rollupOutput,
  sortable,
  STATUS_GROUPS,
  TITLE_NAME,
  TITLE_PROP,
  type CollectionProp,
  type CollectionSchema,
  type Condition,
  type FilterOp,
  type Sort,
} from '@ramet/shared/collection-model'
import { TYPE_NAMES } from './ai-names.js'
import { listing, optionOf, personOf, rowOf, type Lookups } from './ai-write.js'

/** 写法 → 依次试的运算（取第一个这个属性能用的） */
const ALIASES: Record<string, FilterOp[]> = {
  '=': ['is', 'eq', 'contains'],
  '==': ['is', 'eq', 'contains'],
  '是': ['is', 'eq', 'contains'],
  '等于': ['is', 'eq', 'contains'],
  '!=': ['is_not', 'neq', 'not_contains'],
  '<>': ['is_not', 'neq', 'not_contains'],
  '不是': ['is_not', 'neq', 'not_contains'],
  '不等于': ['is_not', 'neq', 'not_contains'],
  '>': ['gt', 'after'],
  '<': ['lt', 'before'],
  '>=': ['gte'],
  '<=': ['lte'],
  '包含': ['contains'],
  '不包含': ['not_contains'],
  '为空': ['empty'],
  '不为空': ['not_empty'],
  '早于': ['before'],
  '晚于': ['after'],
  '在组': ['in_group'],
}

const OP_TEXT: Record<FilterOp, string> = {
  contains: '包含',
  not_contains: '不包含',
  eq: '=',
  neq: '!=',
  gt: '>',
  lt: '<',
  gte: '>=',
  lte: '<=',
  is: '是',
  is_not: '不是',
  in_group: '在组',
  before: '早于',
  after: '晚于',
  empty: '为空',
  not_empty: '不为空',
  checked: '已勾选',
  unchecked: '未勾选',
}

export class AiQueryError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 属性按名字（trim 后全等）或 id 认；「名称」是行的标题 */
export function propByName(schema: CollectionSchema, raw: unknown): CollectionProp {
  const key = String(raw ?? '').trim()
  if (key === TITLE_NAME) return TITLE_PROP
  const prop = schema.props.find((p) => p.name.trim() === key) ?? findProp(schema, key)
  if (prop) return prop
  throw new AiQueryError(`合集里没有叫「${key}」的属性；有：${listing([TITLE_NAME, ...schema.props.map((p) => p.name || TYPE_NAMES[p.type])])}`)
}

function opOf(prop: CollectionProp, raw: unknown, hasValue: boolean): FilterOp {
  const allowed = filterOps(prop)
  const name = prop.name || TITLE_NAME
  if (allowed.length === 0) throw new AiQueryError(`「${name}」不能拿来筛选`)
  const key = raw === undefined || raw === null || raw === '' ? (hasValue ? '=' : 'not_empty') : String(raw).trim().toLowerCase()
  const found = (allowed as readonly string[]).includes(key) ? (key as FilterOp) : ALIASES[key]?.find((op) => allowed.includes(op))
  if (found) return found
  throw new AiQueryError(`「${name}」不能用「${String(raw)}」筛选，能用：${allowed.map((op) => `${op}（${OP_TEXT[op]}）`).join('、')}`)
}

/** 比较值按属性类型换成 conditionValue 要的形状 */
async function valueOf(prop: CollectionProp, op: FilterOp, raw: unknown, look: Lookups): Promise<string | number> {
  const name = prop.name || TITLE_NAME
  const text = String(raw ?? '').trim()
  let value: unknown = text
  if (op === 'in_group') {
    value = STATUS_GROUPS.find((g) => g.id === text || g.name === text)?.id ?? text
  } else if (prop.type === 'select' || prop.type === 'status' || prop.type === 'multi_select') {
    const id = optionOf(prop, text)
    if (typeof id !== 'string') throw new AiQueryError(id.error)
    value = id
  } else if (prop.type === 'person' || prop.type === 'created_by' || prop.type === 'edited_by') {
    const id = await personOf(prop, text, look)
    if (typeof id !== 'string') throw new AiQueryError(id.error)
    value = id
  } else if (prop.type === 'relation') {
    const id = prop.cfg.target ? await rowOf(prop, prop.cfg.target, text, look) : { error: `「${name}」的关联已失效` }
    if (typeof id !== 'string') throw new AiQueryError(id.error)
    value = id
  } else if (numeric(prop)) {
    value = typeof raw === 'number' ? raw : Number(text)
  }
  const checked = conditionValue(prop, op, value)
  if (checked !== undefined) return checked
  const want = numeric(prop) ? '一个数字' : isDateType(prop.type) || dateOutput(prop) ? '一天（YYYY-MM-DD）' : '一个值'
  throw new AiQueryError(`「${name}」${OP_TEXT[op]}后面要跟${want}，「${text}」不行`)
}

function numeric(prop: CollectionProp): boolean {
  if (prop.type === 'number' || prop.type === 'unique_id') return true
  if (prop.type === 'formula') return prop.output === 'number'
  return prop.type === 'rollup' && rollupOutput(prop.cfg.fn) === 'number'
}

function dateOutput(prop: CollectionProp): boolean {
  if (prop.type === 'formula') return prop.output === 'date'
  return prop.type === 'rollup' && rollupOutput(prop.cfg.fn) === 'date'
}

/** where（[{ prop, op?, value? }]）→ 条件；不对 = AiQueryError */
export async function conditionsOf(schema: CollectionSchema, raw: unknown, look: Lookups): Promise<Condition[]> {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new AiQueryError('where 要写成 [{ prop, op, value }] 的列表')
  const out: Condition[] = []
  for (const item of raw) {
    if (!isRecord(item)) throw new AiQueryError('where 的每一项要写成 { prop, op, value }')
    const prop = propByName(schema, item.prop)
    const hasValue = item.value !== undefined && item.value !== null && item.value !== ''
    const op = opOf(prop, item.op, hasValue)
    out.push(opNeedsValue(op) ? { prop: prop.id, op, value: await valueOf(prop, op, item.value, look) } : { prop: prop.id, op })
  }
  return out
}

/** sort（[{ prop, dir? }]）→ 排序；不对 = AiQueryError */
export function sortsOf(schema: CollectionSchema, raw: unknown): Sort[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new AiQueryError('sort 要写成 [{ prop, dir }] 的列表')
  return raw.map((item) => {
    const prop = propByName(schema, isRecord(item) ? item.prop : item)
    if (!sortable(prop)) throw new AiQueryError(`「${prop.name || TITLE_NAME}」不能拿来排序`)
    const dir = isRecord(item) ? String(item.dir ?? 'asc').trim().toLowerCase() : 'asc'
    return { prop: prop.id, dir: dir === 'desc' || dir === '降序' || dir === '倒序' ? 'desc' : 'asc' }
  })
}

/** 条件写回人话（返回给 agent，让它知道这一次实际按什么筛的） */
export function conditionText(schema: CollectionSchema, c: Condition): string {
  const prop = findProp(schema, c.prop)
  const name = prop?.name || TITLE_NAME
  if (c.value === undefined) return `${name} ${OP_TEXT[c.op]}`
  const option = prop?.options.find((o) => o.id === c.value)?.name
  const group = c.op === 'in_group' ? STATUS_GROUPS.find((g) => g.id === c.value)?.name : undefined
  return `${name} ${OP_TEXT[c.op]} ${option ?? group ?? String(c.value)}`
}
