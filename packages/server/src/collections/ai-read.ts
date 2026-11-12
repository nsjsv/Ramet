// ---------- 给 agent 读合集：read_collection 的内核（routes/collection-tools.ts），read_page 读到合集行时的属性也走这里 ----------
// 取数与表格的窗口查询同一条路（memberRows → computeRows → queryWindow）：筛选、排序、公式、关联与汇总都同口径，不另算一套。
// 不点名视图时用一个空视图（不筛、不分组、按手动顺序）：agent 要看的是整个合集，不是某个人存下的筛选，漏了行它也不知道。
// 值一律写成文字再交出去（人名、选项名、关联行的标题、算好的公式 / 汇总），agent 不必认属性 id 和选项 id。
// 名字只取本空间成员和服务端算好的 ref_titles（关联已去掉不在目标集合的行），不按 id 现查标题：关联失效后可能指到别的空间。

import type { Pool } from 'pg'
import type * as Y from 'yjs'
import {
  dateSpan,
  formatNumber,
  formulaNumberText,
  isReverseRelation,
  newView,
  rollupOutput,
  rowValue,
  timeMs,
  TITLE_PROP_ID,
  type CollectionLayout,
  type CollectionProp,
  type CollectionRefs,
  type CollectionRow,
  type CollectionSchema,
  type CollectionView,
  type FormulaType,
  type PropType,
  type PropValue,
  type RollupItem,
} from '@ramet/shared/collection-model'
import { fillFormulas, queryWindow } from '@ramet/shared/collection-query'
import { computeRows } from './computed.js'
import { ensureNumbers, memberRows, memberRowsAmong, readSchema, spaceMembers, type CollectionPage } from './store.js'
import { numbered } from './write-row.js'
import { shownText, type TextCtx } from './value-text.js'

/** 类型的叫法（同界面上属性类型菜单的说法，agent 转述给用户时对得上） */
export const TYPE_NAMES: Record<PropType, string> = {
  text: '文本',
  number: '数字',
  select: '单选',
  multi_select: '多选',
  status: '状态',
  date: '日期',
  checkbox: '复选框',
  url: '链接',
  person: '人员',
  created_time: '创建时间',
  edited_time: '编辑时间',
  email: '邮箱',
  phone: '电话',
  created_by: '创建者',
  edited_by: '最后编辑者',
  unique_id: '自动编号',
  files: '文件与媒体',
  relation: '关联',
  rollup: '汇总',
  formula: '公式',
  button: '按钮',
  ai: 'AI 属性',
}

const LAYOUT_NAMES: Record<CollectionLayout, string> = { table: '表格', board: '看板', list: '列表', gallery: '画廊', calendar: '日历', timeline: '时间线' }

/** 一个值最多给这么多字：长文本属性整列铺开会吃掉 agent 的上下文，要细看就读那一行的页面 */
const VALUE_MAX = 300

export type AiProp = { name: string; type: string; options?: string[]; note?: string }
export type AiView = { id: string; name: string; layout: string }
/** 一行：值按属性顺序排好，[属性名, 文字]；空值不列 */
export type AiRow = { id: string; title: string; values: Array<[string, string]> }
export type AiCollection = {
  id: string
  title: string
  props: AiProp[]
  views: AiView[]
  /** 按哪个视图取的；null = 全部行、手动顺序 */
  view: AiView | null
  total: number
  next: string | null
  rows: AiRow[]
}

/** limit 缺省与上限同表格的窗口（50 / 100），数字或查询串里的字符串都收 */
export type AiReadOpts = { view?: string; cursor?: string | null; limit?: number | string | null; tzOffset: number }

/** 值要写进行文字的属性：按钮没有值，名称已经是行的标题 */
const listed = (prop: CollectionProp): boolean => prop.type !== 'button' && prop.id !== TITLE_PROP_ID

function clip(text: string): string {
  const chars = [...text.replace(/\s*\n\s*/g, ' ')]
  return chars.length > VALUE_MAX ? `${chars.slice(0, VALUE_MAX).join('')}…` : chars.join('')
}

/** 时间戳 → 看的人那个时区的「YYYY-MM-DD HH:mm」；认不出原样 */
function stampText(stamp: string, tzOffset: number): string {
  const ms = timeMs(stamp)
  return Number.isFinite(ms) ? new Date(ms + tzOffset * 60_000).toISOString().slice(0, 16).replace('T', ' ') : stamp
}

/** 算出来的日期（汇总 / 公式）：日历日与区间同日期属性的写法，带时刻的是时间戳 */
function dateText(value: string, tzOffset: number): string {
  const span = dateSpan(value)
  if (!span) return stampText(value, tzOffset)
  return span.start === span.end ? span.start : `${span.start} → ${span.end}`
}

/** 汇总「显示原值」列表里的一项按目标属性写：多值类型的一格被摊成了单项，包回列表才能复用 shownText */
function itemText(target: CollectionProp | null, item: RollupItem, ctx: TextCtx): string {
  if (typeof item === 'object') return item.name
  if (!target) return String(item)
  const multi = target.type === 'multi_select' || target.type === 'person' || target.type === 'created_by' || target.type === 'edited_by'
  return shownText(target, multi && typeof item === 'string' ? [item] : item, ctx)
}

function rollupText(prop: CollectionProp, value: PropValue, refs: CollectionRefs, ctx: TextCtx, tzOffset: number): string {
  const ref = refs[prop.id]?.prop
  const target: CollectionProp | null = ref ? { id: TITLE_PROP_ID, name: '', type: ref.type, pos: 0, options: ref.options, cfg: ref.cfg } : null
  const fn = prop.cfg.fn
  switch (rollupOutput(fn)) {
    case 'number': {
      if (typeof value !== 'number') return ''
      if (fn === 'percent_empty' || fn === 'percent_not_empty' || fn === 'percent_checked' || fn === 'percent_unchecked') {
        return `${(Math.round(value * 1000) / 10).toFixed(1)}%`
      }
      if (fn === 'date_range') return `${Math.round(value * 100) / 100} 天`
      if (target?.type === 'unique_id' && (fn === 'min' || fn === 'max')) return formatNumber(target, value)
      return String(Math.round(value * 100) / 100)
    }
    case 'date':
      return typeof value === 'string' ? dateText(value, tzOffset) : ''
    case 'list':
      return Array.isArray(value) ? (value as RollupItem[]).map((item) => itemText(target, item, ctx)).join('、') : ''
  }
}

/** 公式结果（同表格格子的口径）：数字最多 15 位有效数字，是否写是 / 否，列表逐项用「、」连 */
function formulaText(output: FormulaType | null | undefined, value: PropValue, tzOffset: number): string {
  if (typeof value === 'number') return formulaNumberText(value)
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value)) return value.map((item) => (typeof item === 'object' ? item.name : formulaText(null, item, tzOffset))).join('、')
  return output === 'date' ? dateText(value, tzOffset) : value
}

/** 一个读出来的值 → 文字：存储类同自动化的口径（value-text.ts），时间按看的人的时区，算出来的按输出类型 */
function valueText(prop: CollectionProp, value: PropValue, refs: CollectionRefs, ctx: TextCtx, tzOffset: number): string {
  switch (prop.type) {
    case 'created_time':
    case 'edited_time':
      return typeof value === 'string' ? stampText(value, tzOffset) : String(value)
    case 'formula':
      return formulaText(prop.output, value, tzOffset)
    case 'rollup':
      return rollupText(prop, value, refs, ctx, tzOffset)
    default:
      return shownText(prop, value, ctx)
  }
}

function rowOf(schema: CollectionSchema, row: CollectionRow, refs: CollectionRefs, ctx: TextCtx, tzOffset: number): AiRow {
  const values: Array<[string, string]> = []
  for (const prop of schema.props) {
    if (!listed(prop)) continue
    const value = rowValue(row, prop)
    const text = value === undefined ? '' : clip(valueText(prop, value, refs, ctx, tzOffset))
    if (text) values.push([prop.name || TYPE_NAMES[prop.type], text])
  }
  return { id: row.id, title: row.title, values }
}

/** 属性的说明：选项列出名字，关联写目标合集，公式写不出值时说原因 */
function propOf(prop: CollectionProp, refs: CollectionRefs): AiProp {
  const out: AiProp = { name: prop.name || TYPE_NAMES[prop.type], type: TYPE_NAMES[prop.type] }
  if (prop.options.length > 0) out.options = prop.options.map((o) => o.name || '（未命名）')
  if (prop.type === 'relation') {
    const target = refs[prop.id]?.target
    out.note = target ? `${isReverseRelation(prop) ? '被关联自' : '关联到'}合集「${target.title || '无标题'}」 collection:${target.id}` : '关联已失效'
  }
  if (prop.type === 'formula' && prop.output === null) out.note = '公式写错了，算不出值'
  if (prop.type === 'ai' && prop.cfg.prompt) out.note = `AI 按要求填：${clip(prop.cfg.prompt)}`
  return out
}

const viewOf = (view: CollectionView): AiView => ({ id: view.id, name: view.name || '未命名视图', layout: LAYOUT_NAMES[view.layout] })

/** 视图：按 id 或名字找；没给 = 全部行。找不到 = null */
function chooseView(schema: CollectionSchema, wanted: string | undefined): CollectionView | 'all' | null {
  const key = wanted?.trim()
  if (!key) return 'all'
  return schema.views.find((v) => v.id === key) ?? schema.views.find((v) => v.name.trim() === key) ?? null
}

/** 本空间成员的名字（人员类）+ 每行自带的关联标题 */
async function textCtx(pool: Pool, collection: CollectionPage, rows: CollectionRow[]): Promise<TextCtx> {
  const names = await spaceMembers(pool, collection.space_id)
  const titles = new Map<string, string>()
  for (const row of rows) for (const [id, title] of Object.entries(row.ref_titles ?? {})) titles.set(id, title)
  return { name: (id) => names.get(id), title: (id) => titles.get(id) }
}

export class UnknownViewError extends Error {}

/** 读一段行（调用方判过可读）。view 对不上抛 UnknownViewError，信息里列出有哪些视图 */
export async function readCollectionForAi(
  pool: Pool,
  getLiveDoc: ((docName: string) => Y.Doc | undefined) | undefined,
  collection: CollectionPage,
  opts: AiReadOpts,
): Promise<AiCollection> {
  const schema = await readSchema(pool, collection.id, getLiveDoc)
  const chosen = chooseView(schema, opts.view)
  if (chosen === null) {
    const names = schema.views.map((v) => `「${v.name || '未命名视图'}」`).join('、')
    throw new UnknownViewError(`合集里没有视图「${opts.view}」${names ? `，有：${names}` : ''}`)
  }
  const view = chosen === 'all' ? { id: '', ...newView('', 'table', 0) } : chosen
  if (numbered(schema)) await ensureNumbers(pool, collection.id)
  const rows = await memberRows(pool, collection.id)
  const refs = await computeRows(pool, getLiveDoc, collection, schema, rows, true)
  const window = queryWindow(rows, view, schema, { cursor: opts.cursor ?? null, limit: opts.limit ?? null }, { tzOffset: opts.tzOffset, refs })
  const ctx = await textCtx(pool, collection, window.rows)
  return {
    id: collection.id,
    title: collection.title,
    props: schema.props.filter(listed).map((p) => propOf(p, refs)),
    views: schema.views.map(viewOf),
    view: chosen === 'all' ? null : viewOf(chosen),
    total: window.total,
    next: window.next,
    rows: window.rows.map((row) => rowOf(schema, row, refs, ctx, opts.tzOffset)),
  }
}

/** 单独一行的属性（read_page 读到合集行时附上）：同 read_collection 的口径。行已不在这个合集 = null */
export async function rowForAi(
  pool: Pool,
  getLiveDoc: ((docName: string) => Y.Doc | undefined) | undefined,
  collection: CollectionPage,
  rowId: string,
  tzOffset: number,
): Promise<AiRow | null> {
  const schema = await readSchema(pool, collection.id, getLiveDoc)
  if (numbered(schema)) await ensureNumbers(pool, collection.id)
  const [row] = await memberRowsAmong(pool, collection.id, [rowId])
  if (!row) return null
  // 关联 / 汇总同单行取数的口径（computeRows 自己去取另一端），公式在它们之后算（公式可以引用汇总）
  const refs = await computeRows(pool, getLiveDoc, collection, schema, [row])
  const [filled] = fillFormulas([row], schema, { tzOffset, refs })
  return rowOf(schema, filled ?? row, refs, await textCtx(pool, collection, [row]), tzOffset)
}
