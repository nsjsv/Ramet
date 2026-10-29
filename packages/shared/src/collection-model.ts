// ---------- 集合的值模型（@ramet/shared/collection-model）：属性定义、视图、行值的编码与解读 ----------
// 集合页文档 page:<cid> 的 Y.Map('collection') 存属性定义与视图；行文档 page:<rowId> 的 Y.Map('props') 存这一行的值
// （键是属性 id，键不存在即为空，写 null 等于删键）。服务端、表格、看板、行页面属性区、筛选排序读的都是这一套口径。
//
// 不依赖 yjs（同一 bundle 里两份 yjs 会静默 CRDT 分叉）：这里只有 JSON 形状和纯函数，Y 结构由各端自己写，
// 读回一律先 toJSON() 再交给这里。成员能往协同文档里写进任何东西，所以：
//   parseCollection 容错：缺字段补默认、坏条目跳过、视图里引用了已删属性的设置自动忽略，绝不抛
//   readValue 是值的唯一解读入口：形状与当前类型的编码对不上、选项已删的一律读成 undefined；
//   原值不动，改回原类型就回来（不做智能转换）
//   从行取值经 rowValue：状态读不出值时补缺省选项（statusDefault），状态列不会是空白
//   validateValue 是写入前的唯一校验（服务端据此回 400，前端写协同文档前也过它）
// 解析结果里的字典一律只认自有属性：Y.Map.toJSON() 用赋值建对象，键叫 __proto__ 的条目会改原型而不是成为属性。

import { isColorName, type ColorName } from './md-dialect/colors.js'

/** 集合文档的格式版本（Y.Map('collection') 的 v） */
export const COLLECTION_VERSION = 1

export const PROP_TYPES = [
  'text',
  'number',
  'select',
  'multi_select',
  'status',
  'date',
  'checkbox',
  'url',
  'person',
  'created_time',
  'edited_time',
] as const
export type PropType = (typeof PROP_TYPES)[number]

/** 隐含的「名称」属性：id 固定，值就是行页面的标题。不在 props 里、不能删；筛选 / 排序按文本处理。
 *  属性 id 是 6 位随机串，与它撞不上；解析时也把叫这个 id 的属性条目当坏条目跳过 */
export const TITLE_PROP_ID = 'title'

/** 状态的三个固定组，数组顺序就是分组 / 排序顺序。name 是界面名，也是新「状态」属性三个默认选项的名字 */
export const STATUS_GROUPS = [
  { id: 'todo', name: '未开始', color: 'gray' },
  { id: 'doing', name: '进行中', color: 'blue' },
  { id: 'done', name: '已完成', color: 'green' },
] as const satisfies readonly { id: string; name: string; color: ColorName }[]
export type StatusGroup = (typeof STATUS_GROUPS)[number]['id']

export const COLLECTION_LAYOUTS = ['table', 'board'] as const
export type CollectionLayout = (typeof COLLECTION_LAYOUTS)[number]

/** 属性 / 选项 / 视图名最多这么多字（按码点；解析时截断，编辑入口照这个限） */
export const NAME_MAX = 100
/** 文本 / 链接值的上限（按码点） */
export const TEXT_MAX = 2000
/** 多选 / 人员一个值里最多几项 */
export const LIST_MAX = 100
/** 一个视图最多几条筛选条件、几级排序，超出的部分解析时丢掉 */
export const CONDITIONS_MAX = 50
export const SORTS_MAX = 10
/** 表格列宽（像素）的合法区间：解析时夹进来，拖宽入口照这个限 */
export const COLUMN_WIDTH_MIN = 40
export const COLUMN_WIDTH_MAX = 2000

/** 筛选条件的运算。各类型能用哪些见 FILTER_OPS */
export type FilterOp =
  | 'contains'
  | 'not_contains'
  | 'eq'
  | 'neq'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'is'
  | 'is_not'
  | 'in_group'
  | 'before'
  | 'after'
  | 'empty'
  | 'not_empty'
  | 'checked'
  | 'unchecked'

const TEXT_OPS = ['contains', 'eq', 'empty', 'not_empty'] as const satisfies readonly FilterOp[]
const LIST_OPS = ['contains', 'not_contains', 'empty'] as const satisfies readonly FilterOp[]
const DATE_OPS = ['eq', 'before', 'after', 'empty'] as const satisfies readonly FilterOp[]

/** 各类型可用的筛选运算（第一个是新建条件时的缺省）。「名称」按 text */
export const FILTER_OPS: Record<PropType, readonly FilterOp[]> = {
  text: TEXT_OPS,
  url: TEXT_OPS,
  number: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'empty'],
  select: ['is', 'is_not', 'empty'],
  status: ['is', 'is_not', 'in_group', 'empty'],
  multi_select: LIST_OPS,
  person: LIST_OPS,
  date: DATE_OPS,
  created_time: DATE_OPS,
  edited_time: DATE_OPS,
  checkbox: ['checked', 'unchecked'],
}

/** 这些运算不带比较值（其余的缺值 = 条件还没填完，不参与筛选） */
const VALUELESS_OPS: ReadonlySet<FilterOp> = new Set(['empty', 'not_empty', 'checked', 'unchecked'])
export function opNeedsValue(op: FilterOp): boolean {
  return !VALUELESS_OPS.has(op)
}

export type CollectionOption = {
  id: string
  name: string
  color: ColorName
  pos: number
  /** 只有状态的选项有，且恒有（缺了按「未开始」） */
  group?: StatusGroup
}

export type CollectionProp = {
  id: string
  name: string
  type: PropType
  pos: number
  /** 单选 / 多选 / 状态的选项，已排好序（状态先按组、再按 pos；其余按 pos）；别的类型恒为空 */
  options: CollectionOption[]
}

/** 条件的比较值：文本 / 选项 id / 用户 id / 状态组 / 'YYYY-MM-DD' 是字符串，数字是 number */
export type Condition = { prop: string; op: FilterOp; value?: string | number }
/** 全部条件同时满足（暂不支持「或」条件组） */
export type Filter = { all: Condition[] }
export type Sort = { prop: string; dir: 'asc' | 'desc' }

export type CollectionView = {
  id: string
  name: string
  layout: CollectionLayout
  pos: number
  filter: Filter
  sorts: Sort[]
  /** 按哪个属性分组（只认状态 / 单选）；看板按它分列 */
  groupBy: string | null
  /** 显示哪些属性、按什么顺序（不含恒显示的「名称」）；null = 全部按属性 pos 显示 */
  shown: string[] | null
  /** 表格列宽，键是属性 id（含「名称」的 title） */
  widths: Record<string, number>
}

/** parseCollection 的结果：属性与视图都已按 pos 排好 */
export type CollectionSchema = { v: number; props: CollectionProp[]; views: CollectionView[] }

/** 写进集合文档的形状（各端照它写 Y 结构，props / views / options / widths 是 Y.Map，其余是普通值） */
export type OptionJson = { name: string; color: ColorName; pos: number; group?: StatusGroup }
export type PropJson = { name: string; type: PropType; pos: number; options?: Record<string, OptionJson> }
export type ViewJson = Omit<CollectionView, 'id'>

/** 解读后的属性值（created_time / edited_time 的值是行元数据里的时间戳字符串） */
export type PropValue = string | number | boolean | string[]

/** 页面图标（结构同服务端 page-icon.ts 的对外形状） */
export type RowIcon = { kind: 'emoji' | 'image'; value: string } | null

/** 视图里的一行（服务端窗口查询返回、增量里携带）。props 是行文档 Y.Map('props') 的原样 JSON，读值一律经 readValue。
 *  created_at / edited_at 是时间戳字符串（ISO 8601 或 Postgres now()::text 的格式都行，比较时经 timeMs），
 *  edited_at 是正文或属性最后一次变化的时间 */
export type CollectionRow = {
  id: string
  title: string
  icon: RowIcon
  props: Record<string, unknown>
  position: number | null
  created_at: string
  edited_at: string
  /** 正文里有字（pages.content_text 含非空白；没存过正文的老页面算有）。没有自定义图标时，有正文才画通用文档图标 */
  has_body: boolean
}

/** 一行的改动。row 是改后的整行。
 *  prev 在：这一行在本批之前就在集合里，值是改之前与现在不同的那些（属性 id 对应旧值，null 表示当时没有这个键，
 *  键 title 是旧标题）；prev 不在：这一行本批才进集合（新建 / 挪进 / 恢复）。客户端靠它还原旧行，精确增减计数 */
export type RowUpdate = { row: CollectionRow; prev?: Record<string, unknown> }
/** 集合增量（经集合文档的 stateless 只发给正看着它的连接）。同一批里一行至多出现一次（服务端按行合并）。
 *  reset 表示顺序基准变了（手动顺序重编号改了这个集合所有行的 position）：已加载的窗口作废，由客户端重取；
 *  带 reset 的批次不带 up / rm（逐行下发最多 5,000 行，窗口里新旧 position 混用又会排错） */
export type RowsDelta = { t: 'collection.rows'; up: RowUpdate[]; rm: { row: CollectionRow }[]; reset?: true }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/** 只读自有属性（继承来的 constructor / toString 之类不算值） */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

const ID_RE = /^[0-9a-z]{1,32}$/

/** 属性 / 选项 / 视图 id 的合法形状（newShortId 产 6 位；放宽到 32 位小写字母数字，挡住 __proto__ 之类的键） */
export function isShortId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value)
}

/** 合法的属性 id：「名称」的 title 是保留 id，不能是真实属性 */
export function isPropId(value: unknown): value is string {
  return isShortId(value) && value !== TITLE_PROP_ID
}

export function isPropType(value: unknown): value is PropType {
  return typeof value === 'string' && (PROP_TYPES as readonly string[]).includes(value)
}

export function isStatusGroup(value: unknown): value is StatusGroup {
  return value === 'todo' || value === 'doing' || value === 'done'
}

/** 状态组的顺序下标（todo 0、doing 1、done 2） */
export function statusGroupIndex(group: StatusGroup): number {
  return group === 'todo' ? 0 : group === 'doing' ? 1 : 2
}

/** 有选项的类型 */
export function typeHasOptions(type: PropType): boolean {
  return type === 'select' || type === 'multi_select' || type === 'status'
}

function codePointsOver(text: string, max: number): boolean {
  if (text.length <= max) return false
  if (text.length > max * 2) return true
  return [...text].length > max
}

function clipName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return codePointsOver(raw, NAME_MAX) ? [...raw].slice(0, NAME_MAX).join('') : raw
}

function finiteOr(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

function byPos<T extends { id: string; pos: number }>(a: T, b: T): number {
  if (a.pos !== b.pos) return a.pos < b.pos ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

type RandomSource = { getRandomValues<T extends Uint8Array>(array: T): T }

/** 新的属性 / 选项 / 视图 id：6 位 base36（Yjs 键和 JSONB 键都省空间）。
 *  给了 taken 就避开已有的 id，同一集合里撞号会覆盖别的条目。crypto.getRandomValues 在 Node 与非安全上下文的浏览器里都有 */
export function newShortId(taken?: { has(id: string): boolean }): string {
  const random = (globalThis as unknown as { crypto: RandomSource }).crypto
  for (;;) {
    let id = ''
    while (id.length < 6) {
      const bytes = random.getRandomValues(new Uint8Array(8))
      // 拒绝采样：252 = 36 × 7，丢掉 252..255 才没有取模偏差
      for (const byte of bytes) if (byte < 252 && id.length < 6) id += (byte % 36).toString(36)
    }
    if (!taken?.has(id)) return id
  }
}

/** 新「状态」属性的三个默认选项：每组一个，名字同组名（新集合与新建状态属性共用） */
export function newStatusOptions(): Record<string, OptionJson> {
  const options: Record<string, OptionJson> = {}
  const ids = new Set<string>()
  STATUS_GROUPS.forEach((group, pos) => {
    const id = newShortId(ids)
    ids.add(id)
    options[id] = { name: group.name, color: group.color, pos, group: group.id }
  })
  return options
}

/** 新视图的设置：无筛选、无排序、全部属性按 pos 显示（看板要给 groupBy） */
export function newView(name: string, layout: CollectionLayout, pos: number, groupBy: string | null = null): ViewJson {
  return { name, layout, pos, filter: { all: [] }, sorts: [], groupBy, shown: null, widths: {} }
}

/** 隐含的「名称」属性（筛选 / 排序引用 title 时按它解读；只读，别改它） */
export const TITLE_PROP: CollectionProp = { id: TITLE_PROP_ID, name: '名称', type: 'text', pos: -1, options: [] }

/** Y.Map('collection').toJSON() → 属性定义与视图。入参可以是任何东西，坏的部分跳过或补默认，绝不抛 */
export function parseCollection(json: unknown): CollectionSchema {
  const root = asRecord(json)
  const props = parseProps(own(root, 'props'))
  const byId = new Map(props.map((prop) => [prop.id, prop]))
  const lookup = (id: unknown): CollectionProp | undefined =>
    id === TITLE_PROP_ID ? TITLE_PROP : typeof id === 'string' ? byId.get(id) : undefined
  const views: CollectionView[] = []
  for (const [id, raw] of Object.entries(asRecord(own(root, 'views')))) {
    if (isShortId(id) && isRecord(raw)) views.push(parseView(id, raw, lookup))
  }
  const v = own(root, 'v')
  return {
    v: typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : COLLECTION_VERSION,
    props,
    views: views.sort(byPos),
  }
}

function parseProps(raw: unknown): CollectionProp[] {
  const props: CollectionProp[] = []
  for (const [id, item] of Object.entries(asRecord(raw))) {
    if (!isPropId(id) || !isRecord(item)) continue
    const type = own(item, 'type')
    // 不认识的类型（比如更新的客户端写的）整条跳过，画不出也筛不了
    if (!isPropType(type)) continue
    props.push({
      id,
      name: clipName(own(item, 'name')),
      type,
      pos: finiteOr(own(item, 'pos'), 0),
      options: typeHasOptions(type) ? parseOptions(own(item, 'options'), type === 'status') : [],
    })
  }
  return props.sort(byPos)
}

function parseOptions(raw: unknown, status: boolean): CollectionOption[] {
  const options: CollectionOption[] = []
  for (const [id, item] of Object.entries(asRecord(raw))) {
    if (!isShortId(id) || !isRecord(item)) continue
    const color = own(item, 'color')
    const option: CollectionOption = {
      id,
      name: clipName(own(item, 'name')),
      color: isColorName(color) ? color : 'gray',
      pos: finiteOr(own(item, 'pos'), 0),
    }
    if (status) {
      const group = own(item, 'group')
      option.group = isStatusGroup(group) ? group : 'todo'
    }
    options.push(option)
  }
  if (!status) return options.sort(byPos)
  return options.sort((a, b) => statusGroupIndex(a.group ?? 'todo') - statusGroupIndex(b.group ?? 'todo') || byPos(a, b))
}

type PropLookup = (id: unknown) => CollectionProp | undefined

function parseView(id: string, raw: Record<string, unknown>, lookup: PropLookup): CollectionView {
  const groupProp = lookup(own(raw, 'groupBy'))
  return {
    id,
    name: clipName(own(raw, 'name')),
    layout: own(raw, 'layout') === 'board' ? 'board' : 'table',
    pos: finiteOr(own(raw, 'pos'), 0),
    filter: { all: parseConditions(own(asRecord(own(raw, 'filter')), 'all'), lookup) },
    sorts: parseSorts(own(raw, 'sorts'), lookup),
    groupBy: groupProp && (groupProp.type === 'status' || groupProp.type === 'select') ? groupProp.id : null,
    shown: parseShown(own(raw, 'shown'), lookup),
    widths: parseWidths(own(raw, 'widths'), lookup),
  }
}

/** 留下属性还在、运算适用于它当前类型的条件。值不合用的照样留着（条件还没填完，界面要能接着编辑），只是不参与筛选 */
function parseConditions(raw: unknown, lookup: PropLookup): Condition[] {
  const out: Condition[] = []
  if (!Array.isArray(raw)) return out
  for (const item of raw) {
    if (out.length >= CONDITIONS_MAX) break
    if (!isRecord(item)) continue
    const prop = lookup(own(item, 'prop'))
    const op = own(item, 'op')
    if (!prop || typeof op !== 'string' || !(FILTER_OPS[prop.type] as readonly string[]).includes(op)) continue
    const value = conditionValue(prop, op as FilterOp, own(item, 'value'))
    out.push(value === undefined ? { prop: prop.id, op: op as FilterOp } : { prop: prop.id, op: op as FilterOp, value })
  }
  return out
}

/** 条件的比较值按属性类型与运算归一，不合用（形状不对、选项已删）返回 undefined。
 *  matchFilter 也用它判断条件是否生效，所以手写的 Filter 和解析出来的走同一套口径 */
export function conditionValue(prop: CollectionProp, op: FilterOp, raw: unknown): string | number | undefined {
  if (!opNeedsValue(op)) return undefined
  switch (prop.type) {
    case 'text':
    case 'url':
      return typeof raw === 'string' && raw !== '' && !codePointsOver(raw, TEXT_MAX) ? raw : undefined
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
    case 'status':
      if (op === 'in_group') return isStatusGroup(raw) ? raw : undefined
      return typeof raw === 'string' && findOption(prop, raw) ? raw : undefined
    case 'select':
    case 'multi_select':
      return typeof raw === 'string' && findOption(prop, raw) ? raw : undefined
    case 'person':
      return typeof raw === 'string' && raw !== '' ? raw : undefined
    case 'date':
    case 'created_time':
    case 'edited_time':
      return typeof raw === 'string' && isCalendarDate(raw) ? raw : undefined
    case 'checkbox':
      return undefined
  }
}

function parseSorts(raw: unknown, lookup: PropLookup): Sort[] {
  const out: Sort[] = []
  if (!Array.isArray(raw)) return out
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= SORTS_MAX) break
    if (!isRecord(item)) continue
    const prop = lookup(own(item, 'prop'))
    // 同一属性排两次没有意义，留第一级
    if (!prop || seen.has(prop.id)) continue
    seen.add(prop.id)
    out.push({ prop: prop.id, dir: own(item, 'dir') === 'desc' ? 'desc' : 'asc' })
  }
  return out
}

function parseShown(raw: unknown, lookup: PropLookup): string[] | null {
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  for (const id of raw) {
    const prop = lookup(id)
    // 「名称」恒显示、恒在第一列，不在这张表里
    if (prop && prop.id !== TITLE_PROP_ID && !out.includes(prop.id)) out.push(prop.id)
  }
  return out
}

function parseWidths(raw: unknown, lookup: PropLookup): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [id, width] of Object.entries(asRecord(raw))) {
    if (!lookup(id) || typeof width !== 'number' || !Number.isFinite(width)) continue
    out[id] = Math.round(Math.min(COLUMN_WIDTH_MAX, Math.max(COLUMN_WIDTH_MIN, width)))
  }
  return out
}

/** 按 id 找属性；title 给隐含的「名称」 */
export function findProp(schema: CollectionSchema, id: string): CollectionProp | undefined {
  return id === TITLE_PROP_ID ? TITLE_PROP : schema.props.find((prop) => prop.id === id)
}

export function findOption(prop: CollectionProp, id: string): CollectionOption | undefined {
  return prop.options.find((option) => option.id === id)
}

/** 取视图：给的 id 在就用它，否则第一个视图，一个都没有就是一个空白表格视图（id 为空串） */
export function pickView(schema: CollectionSchema, viewId?: string | null): CollectionView {
  return (
    schema.views.find((view) => view.id === viewId) ??
    schema.views[0] ?? { id: '', ...newView('', 'table', 0) }
  )
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** 'YYYY-MM-DD' 且是真实的日历日（2 月 30 日、平年 2 月 29 日都不算；年份 0001–9999） */
export function isCalendarDate(value: string): boolean {
  const m = DATE_RE.exec(value)
  if (!m) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31
  return day <= days
}

/** 去重后的非空字符串列表（多选 / 人员的值），不是数组返回 undefined */
function stringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  // Set 去重并保持首次出现的顺序。不用 includes：数组可能很长（协同文档 / 请求体里什么都能有），平方级会卡住进程
  const seen = new Set<string>()
  for (const item of raw) if (typeof item === 'string' && item !== '') seen.add(item)
  return [...seen]
}

/** 原始值按属性当前类型解读：形状对不上或选项已删返回 undefined（多选只滤掉已删的项，剩下为空才是 undefined）。
 *  created_time / edited_time 不存储，这里恒为 undefined，从行取值用 rowValue */
export function readValue(prop: CollectionProp, raw: unknown): PropValue | undefined {
  switch (prop.type) {
    case 'text':
    case 'url':
      return typeof raw === 'string' && raw !== '' ? raw : undefined
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
    case 'select':
    case 'status':
      return typeof raw === 'string' && findOption(prop, raw) ? raw : undefined
    case 'multi_select': {
      const ids = stringList(raw)?.filter((id) => findOption(prop, id))
      return ids?.length ? ids.slice(0, LIST_MAX) : undefined
    }
    case 'person': {
      const ids = stringList(raw)
      return ids?.length ? ids.slice(0, LIST_MAX) : undefined
    }
    case 'date':
      return typeof raw === 'string' && isCalendarDate(raw) ? raw : undefined
    case 'checkbox':
      return typeof raw === 'boolean' ? raw : undefined
    case 'created_time':
    case 'edited_time':
      return undefined
  }
}

/** 状态的缺省值：选项已按组序排好，取第一个（通常是「未开始」），一个选项都没有则 undefined。
 *  不写进行文档：新行、老行、刚加的状态列都靠读时补，删掉的选项也落回它 */
export function statusDefault(prop: CollectionProp): string | undefined {
  return prop.type === 'status' ? prop.options[0]?.id : undefined
}

/** 一行在某个属性上的值：名称取标题，创建 / 编辑时间取行元数据，其余经 readValue 读行的 props（状态读不出补 statusDefault） */
export function rowValue(row: CollectionRow, prop: CollectionProp): PropValue | undefined {
  if (prop.id === TITLE_PROP_ID) return typeof row.title === 'string' && row.title !== '' ? row.title : undefined
  if (prop.type === 'created_time') return row.created_at || undefined
  if (prop.type === 'edited_time') return row.edited_at || undefined
  return readValue(prop, isRecord(row.props) ? own(row.props, prop.id) : undefined) ?? statusDefault(prop)
}

const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i

/** 时间戳字符串转毫秒（ISO 8601 与 Postgres 的 'YYYY-MM-DD HH:MM:SS.ffffff+00' 都认；没写时区按 UTC，
 *  两端才算得一样），认不出返回 NaN。手写解析：Safari 的 Date.parse 不认 Postgres 的格式 */
export function timeMs(stamp: string): number {
  const m = STAMP_RE.exec(stamp)
  if (!m) return Date.parse(stamp)
  const zone = m[8]
  let offset = 0
  if (zone && zone.toUpperCase() !== 'Z') {
    const digits = zone.slice(1).replace(':', '')
    offset = (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0)) * (zone[0] === '-' ? -1 : 1)
  }
  const ms = Number(((m[7] ?? '') + '000').slice(0, 3))
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), ms)
  return utc - offset * 60_000
}

export type ValidateCtx = {
  /** 空间成员的用户 id（人员属性只能选他们；agent 不是成员） */
  members?: ReadonlySet<string>
}

/** ok 时 value 是规范化后要写进 props 的值，null 表示删掉这个键；否则 error 是给人看的原因 */
export type ValidateResult = { ok: true; value: PropValue | null } | { ok: false; error: string }

const ok = (value: PropValue | null): ValidateResult => ({ ok: true, value })
const bad = (error: string): ValidateResult => ({ ok: false, error })

/** 文本里不能有的字符：换行 / 制表 / 回车之外的控制字符（JSONB 存不了 \u0000） */
const TEXT_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const URL_CONTROL_RE = /[\u0000-\u001f\u007f]/
/** 渲染成链接时会执行脚本的协议 */
const UNSAFE_SCHEME_RE = /^(?:javascript|vbscript|data):/i

/** 链接值能不能渲染成可点的链接（写入校验与界面渲染同一条规则；协同连接写进来的值没过 validateValue） */
export function isUnsafeUrl(url: string): boolean {
  return UNSAFE_SCHEME_RE.test(url.trim())
}

/** 孤立的代理项（半个 emoji）：JSON 能写出来，Postgres 的 JSONB 不收 */
function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xdc00 && c <= 0xdfff) return false
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1)
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false
      i++
    }
  }
  return true
}

function listResult(raw: unknown, check: (id: string) => boolean, what: string, missing: string): ValidateResult {
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string' || item === '')) return bad(`要填${what}列表`)
  const list = stringList(raw) ?? []
  if (list.length > LIST_MAX) return bad(`最多选 ${LIST_MAX} 个`)
  if (!list.every(check)) return bad(missing)
  return ok(list.length ? list : null)
}

/** 写进行文档 props 之前的唯一校验。null 恒合法（删键）；空文本、空列表、未勾选也规范化成 null，因为键不存在即为空 */
export function validateValue(prop: CollectionProp, value: unknown, ctx: ValidateCtx = {}): ValidateResult {
  if (value === null) return ok(null)
  switch (prop.type) {
    case 'text':
      if (typeof value !== 'string') return bad('要填文本')
      if (value === '') return ok(null)
      if (codePointsOver(value, TEXT_MAX)) return bad(`文本不能超过 ${TEXT_MAX} 字`)
      if (TEXT_CONTROL_RE.test(value) || !wellFormed(value)) return bad('文本里有无法保存的字符')
      return ok(value)
    case 'url': {
      if (typeof value !== 'string') return bad('要填链接')
      const url = value.trim()
      if (url === '') return ok(null)
      if (codePointsOver(url, TEXT_MAX)) return bad(`链接不能超过 ${TEXT_MAX} 字`)
      if (URL_CONTROL_RE.test(url) || !wellFormed(url)) return bad('链接里有无法保存的字符')
      if (isUnsafeUrl(url)) return bad('不支持这种链接')
      return ok(url)
    }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return bad('要填数字')
      return ok(value === 0 ? 0 : value) // -0 归一成 0
    case 'select':
    case 'status':
      if (typeof value !== 'string') return bad('要填选项')
      return findOption(prop, value) ? ok(value) : bad('没有这个选项')
    case 'multi_select':
      return listResult(value, (id) => !!findOption(prop, id), '选项', '没有这个选项')
    case 'person':
      return listResult(value, (id) => ctx.members?.has(id) === true, '成员', '只能选这个空间的成员')
    case 'date':
      return typeof value === 'string' && isCalendarDate(value) ? ok(value) : bad('日期要写成 YYYY-MM-DD')
    case 'checkbox':
      if (typeof value !== 'boolean') return bad('要填是或否')
      return ok(value ? true : null)
    case 'created_time':
    case 'edited_time':
      return bad('这个属性自动生成，不能改')
  }
}
