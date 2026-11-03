// ---------- 集合的值模型（@ramet/shared/collection-model）：属性定义、视图、行值的编码与解读 ----------
// 集合页文档 page:<cid> 的 Y.Map('collection') 存属性定义与视图；行文档 page:<rowId> 的 Y.Map('props') 存这一行的值
// （键是属性 id，键不存在即为空，写 null 等于删键）。服务端、表格、看板、行页面属性区、筛选排序读的都是这一套口径。
//
// 不依赖 yjs（同一 bundle 里两份 yjs 会静默 CRDT 分叉）：这里只有 JSON 形状和纯函数，Y 结构由各端自己写，
// 读回一律先 toJSON() 再交给这里。成员能往协同文档里写进任何东西，所以：
//   parseCollection 容错：缺字段补默认、坏条目跳过、视图里引用了已删属性的设置自动忽略，绝不抛
//   readValue 是值的唯一解读入口：形状与当前类型的编码对不上、选项已删的一律读成 undefined；
//   原值不动，改回原类型就回来（不做智能转换）
//   从行取值经 rowValue，按类型分三层读：存储值（行文档 props，经 readValue；状态读不出值时补缺省选项 statusDefault，
//   状态列不会是空白）、行元数据（创建 / 编辑时间、创建者、最后编辑者、自动编号，服务端随行给）、计算值（关联解析后的行、
//   反向关联、汇总：要读别的集合的数据，只由服务端算好放进 row.computed；公式：两端各自算好放进 row.computed，见 collection-formula/）
//   validateValue 是写入前的唯一校验（服务端据此回 400，前端写协同文档前也过它）
// 解析结果里的字典一律只认自有属性：Y.Map.toJSON() 用赋值建对象，键叫 __proto__ 的条目会改原型而不是成为属性。

import { isColorName, type ColorName } from './md-dialect/colors.js'
import {
  codePointsOver,
  isCalendarDate,
  isPropId,
  isReverseRelation,
  isShortId,
  LINE_CONTROL_RE,
  parseCfg,
  readDate,
  readFiles,
  TEXT_MAX,
  TITLE_NAME,
  TITLE_PROP_ID,
  validateDate,
  validateEmail,
  validateFiles,
  validatePhone,
  wellFormed,
  type FileRef,
  type RollupFn,
} from './collection-values.js'
import { readRollup, rollupOutput } from './collection-rollup.js'
import { annotateFormulas, readFormula, rememberFormulas, type FormulaError, type FormulaType } from './collection-formula/index.js'

export {
  addDays,
  cleanPrefix,
  dateSpan,
  DAY_MS,
  daysBetween,
  EMAIL_MAX,
  epochDay,
  FILE_NAME_MAX,
  FILES_MAX,
  formatNumber,
  fromEpochDay,
  isCalendarDate,
  isComputedProp,
  isPropId,
  isReverseRelation,
  isRollupFn,
  isShortId,
  joinDate,
  NUMBER_PREFIX_MAX,
  parseCfg,
  PHONE_MAX,
  ROLLUP_FNS,
  TEXT_MAX,
  timeMs,
  TITLE_NAME,
  TITLE_PROP_ID,
  tzMinutes,
  weekdayOf,
  type DateSpan,
  type FileRef,
  type RollupFn,
} from './collection-values.js'
export {
  isRollupDate,
  isRollupTarget,
  rollupDateMs,
  rollupFns,
  rollupOutput,
  rollupValue,
  type RollupOutput,
} from './collection-rollup.js'
export {
  checkFormula,
  compileFormulas,
  complete,
  DELETED_PROP_NAME,
  DEPTH_MAX,
  FORMULA_MAX,
  FORMULA_TOTAL_MAX,
  FORMULA_TYPE_LABEL,
  FORMULA_TYPES,
  FORMULAS_MAX,
  formulaNeedsNames,
  formulaNumberText,
  formulaSig,
  FUNCTION_DOCS,
  propFormulaType,
  toDisplay,
  toStored,
  withFormula,
  type Compiled,
  type FormulaCheck,
  type FormulaError,
  type FormulaErrorCode,
  type FormulaType,
  type FunctionDoc,
  type FunctionGroup,
  type Suggestion,
} from './collection-formula/index.js'

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
  'email',
  'phone',
  'created_by',
  'edited_by',
  'unique_id',
  'files',
  'relation',
  'rollup',
  'formula',
] as const
export type PropType = (typeof PROP_TYPES)[number]

/** 状态的三个固定组，数组顺序就是分组 / 排序顺序。name 是界面名，也是新「状态」属性三个默认选项的名字 */
export const STATUS_GROUPS = [
  { id: 'todo', name: '未开始', color: 'gray' },
  { id: 'doing', name: '进行中', color: 'blue' },
  { id: 'done', name: '已完成', color: 'green' },
] as const satisfies readonly { id: string; name: string; color: ColorName }[]
export type StatusGroup = (typeof STATUS_GROUPS)[number]['id']

export const COLLECTION_LAYOUTS = ['table', 'board', 'list', 'gallery', 'calendar', 'timeline'] as const
export type CollectionLayout = (typeof COLLECTION_LAYOUTS)[number]

/** 这种布局能不能分组。画廊 / 日历 / 时间线不分组：queryWindow 按 groupBy 排序，留着旧值会按组序排，
 *  所以解析时对它们一律读成 groupBy: null（服务端窗口与客户端增量同一口径） */
export function layoutGroups(layout: CollectionLayout): boolean {
  return layout !== 'gallery' && layout !== 'calendar' && layout !== 'timeline'
}

/** 能拿来排日历 / 时间线的属性类型：日期，以及按看的人的时区折成一天的创建 / 编辑时间 */
export function isDateType(type: PropType): boolean {
  return type === 'date' || type === 'created_time' || type === 'edited_time'
}

/** 画廊卡片大小：小 / 中 / 大 */
export const CARD_SIZES = ['s', 'm', 'l'] as const
export type CardSize = (typeof CARD_SIZES)[number]
/** 画廊卡片预览取行页面的封面 / 不画预览；其余取值是文件属性的 id */
export const COVER_PAGE = 'page'
export const COVER_NONE = 'none'

/** 属性 / 选项 / 视图名最多这么多字（按码点；解析时截断，编辑入口照这个限） */
export const NAME_MAX = 100
/** 多选 / 人员 / 关联一个值里最多几项 */
export const LIST_MAX = 100
/** 一个视图最多几条筛选条件、几级排序，超出的部分解析时丢掉 */
export const CONDITIONS_MAX = 50
export const SORTS_MAX = 10
/** 表格列宽（像素）的合法区间：解析时夹进来，拖宽入口照这个限 */
export const COLUMN_WIDTH_MIN = 40
export const COLUMN_WIDTH_MAX = 2000

/** 筛选条件的运算。一个属性能用哪些经 filterOps 取 */
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
const NUMBER_OPS = ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'empty'] as const satisfies readonly FilterOp[]
const PRESENCE_OPS = ['empty', 'not_empty'] as const satisfies readonly FilterOp[]
const BOOLEAN_OPS = ['checked', 'unchecked'] as const satisfies readonly FilterOp[]
/** 公式的列表输出：包含 = 列表里有一项的文字等于比较值 */
const FORMULA_LIST_OPS = ['contains', 'empty', 'not_empty'] as const satisfies readonly FilterOp[]

/** 各类型可用的筛选运算（第一个是新建条件时的缺省）。「名称」按 text。按属性取一律经 filterOps */
export const FILTER_OPS: Record<PropType, readonly FilterOp[]> = {
  text: TEXT_OPS,
  url: TEXT_OPS,
  email: TEXT_OPS,
  phone: TEXT_OPS,
  number: NUMBER_OPS,
  unique_id: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte'],
  select: ['is', 'is_not', 'empty'],
  status: ['is', 'is_not', 'in_group', 'empty'],
  multi_select: LIST_OPS,
  person: LIST_OPS,
  created_by: LIST_OPS,
  edited_by: LIST_OPS,
  date: DATE_OPS,
  created_time: DATE_OPS,
  edited_time: DATE_OPS,
  checkbox: BOOLEAN_OPS,
  files: PRESENCE_OPS,
  // 比较值是对方集合的一行
  relation: ['contains', 'not_contains', 'empty', 'not_empty'],
  // 汇总、公式按输出类型取（filterOps），这里是列表输出 / 公式有误时的那一组
  rollup: PRESENCE_OPS,
  formula: PRESENCE_OPS,
}

const FORMULA_OPS: Record<FormulaType, readonly FilterOp[]> = {
  number: NUMBER_OPS,
  text: TEXT_OPS,
  boolean: BOOLEAN_OPS,
  date: DATE_OPS,
  list: FORMULA_LIST_OPS,
}

/** 这个属性能用哪些筛选运算（第一个是缺省）：解析条件、执行筛选、筛选菜单都只经这里，
 *  值按输出类型算的属性（运算跟着输出类型走，不跟着属性类型走）只改这一处 */
export function filterOps(prop: CollectionProp): readonly FilterOp[] {
  if (prop.type === 'formula') return prop.output ? FORMULA_OPS[prop.output] : PRESENCE_OPS
  if (prop.type !== 'rollup') return FILTER_OPS[prop.type]
  const output = rollupOutput(prop.cfg.fn)
  return output === 'number' ? NUMBER_OPS : output === 'date' ? DATE_OPS : PRESENCE_OPS
}

/** 这个属性能不能拿来排序：关联不排（一格多行，没有有意义的先后），列表输出的汇总、公式同理，有误的公式也不排。
 *  解析视图时排不了的排序丢掉 */
export function sortable(prop: CollectionProp): boolean {
  if (prop.type === 'relation') return false
  if (prop.type === 'formula') return !!prop.output && prop.output !== 'list'
  return prop.type !== 'rollup' || rollupOutput(prop.cfg.fn) !== 'list'
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
  /** 属性配置，按当前类型解析（parseCfg）；恒有值，没有配置的类型是 {} */
  cfg: PropCfg
  /** 公式的输出类型：parseCollection 按整份定义编译后填上（引用的属性、别的公式都要看），编译失败 = null。
   *  只有公式属性有；筛选运算、能否排序、computed 的规整都按它。不写回文档（restoreCollection 只同步存储的字段） */
  output?: FormulaType | null
  /** 公式编译失败的原因（位置是存储形里的）：只有编译失败的公式属性有，同 output 不写回文档 */
  formulaError?: FormulaError
}

/** 属性配置：每个字段只属于一种类型，别的类型解析出来恒没有 */
export type PropCfg = {
  /** 自动编号的前缀（显示成「前缀-编号」；空串 = 不带前缀） */
  prefix?: string
  /** 关联另一端的集合 id（正向 = 目标集合，反向 = 源集合）；没有 = 关联已失效 */
  target?: string
  /** 正向关联：对方集合里的反向属性 id；null = 单向 */
  reverse?: string | null
  /** 正向关联：只能关联一行 */
  single?: boolean
  /** 反向关联：镜像的是源集合里的哪个正向关联（有它就是反向关联，值不存、由服务端倒排算出） */
  mirror?: string
  /** 汇总：沿本集合的哪个关联（正向或反向） */
  relation?: string
  /** 汇总：关联另一端集合的哪个属性（TITLE_PROP_ID = 名称） */
  prop?: string
  /** 汇总：计算方式 */
  fn?: RollupFn
  /** 公式：表达式的存储形（属性引用写成 [@<属性 id>]，见 collection-formula/） */
  expr?: string
}

/** 关联 / 汇总属性指向哪里：服务端随窗口给（它知道对方集合在不在、在不在同一个空间），前端据此显示「已失效」与汇总的样子 */
export type PropRef = {
  state: 'ok' | 'broken'
  /** 另一端的集合（只在 ok 时给：失效的关联可能指到了别的空间，名字不能透出去） */
  target?: { id: string; title: string }
  /** 汇总的目标属性（显示原值 / 去重值要按它的类型、选项、配置画） */
  prop?: { type: PropType; options: CollectionOption[]; cfg: PropCfg }
}
/** 键是本集合关联 / 汇总属性的 id */
export type CollectionRefs = Record<string, PropRef>

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
  /** 画廊卡片的预览：COVER_PAGE = 行页面的封面，COVER_NONE = 不画，其余 = 文件属性 id（取第一张图片） */
  cover: string
  /** 画廊卡片大小 */
  cardSize: CardSize
  /** 日历 / 时间线按哪个属性排布（只认 isDateType 的类型）；null = 还没选 */
  dateBy: string | null
}

/** parseCollection 的结果：属性与视图都已按 pos 排好 */
export type CollectionSchema = { v: number; props: CollectionProp[]; views: CollectionView[] }

/** 写进集合文档的形状（各端照它写 Y 结构，props / views / options / widths 是 Y.Map，其余是普通值） */
export type OptionJson = { name: string; color: ColorName; pos: number; group?: StatusGroup }
/** cfg 是一个普通 JSON 值（不是 Y.Map）：改配置整份替换，读时按当前类型解析、原值不动 */
export type PropJson = { name: string; type: PropType; pos: number; options?: Record<string, OptionJson>; cfg?: Record<string, unknown> }
export type ViewJson = Omit<CollectionView, 'id'>

/** 汇总「显示原值 / 去重值」列表里的一项：目标属性的一个值（多值的类型逐项摊平） */
export type RollupItem = string | number | boolean | FileRef

/** 解读后的属性值（created_time / edited_time 的值是行元数据里的时间戳字符串；创建者 / 最后编辑者与人员同形，是用户 id 列表；
 *  自动编号是数字；文件是 FileRef 列表；关联是对方行的 id 列表；汇总按输出类型是数字、日期或 RollupItem 列表）。
 *  列表值不会是空数组（空即 undefined），分辨是哪种列表看 idList / fileList */
export type PropValue = string | number | boolean | string[] | FileRef[] | RollupItem[]

/** 用户 id / 选项 id 的列表值；别的形状 = undefined */
export function idList(value: PropValue | undefined): string[] | undefined {
  return Array.isArray(value) && typeof value[0] === 'string' ? (value as string[]) : undefined
}

/** 文件列表值；别的形状 = undefined */
export function fileList(value: PropValue | undefined): FileRef[] | undefined {
  return Array.isArray(value) && typeof value[0] === 'object' ? (value as FileRef[]) : undefined
}

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
  // 以下元数据只由服务端给（窗口、增量同一口径）。老服务端、乐观新建的行、历史快照里的行都没有，一律按缺失 = 空读
  /** 建行的人（pages.owner_id） */
  created_by?: string | null
  /** 最后改正文或属性的用户 id */
  edited_by?: string | null
  /** 最后一次是 agent 改的：agent 的目录 id；人改的 = null */
  edited_agent?: string | null
  /** 本集合里的自动编号；集合没有编号属性 / 还没取号 = null */
  number?: number | null
  /** 服务端算好的值，键是属性 id（rowValue 的计算值层）：关联是去掉已不在目标集合的行、按目标集合手动顺序排好的 id 列表
   *  （正向关联恒有这一项，空的是 []），反向关联同形，汇总按输出类型 */
  computed?: Record<string, unknown>
  /** 本行关联到的行的标题（行 id → 标题），集合有关联属性时才有 */
  ref_titles?: Record<string, string>
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

/** 新视图的设置：无筛选、无排序、全部属性按 pos 显示（看板要给 groupBy，日历 / 时间线要给 dateBy）；画廊预览缺省用页面封面、中号卡片 */
export function newView(name: string, layout: CollectionLayout, pos: number, groupBy: string | null = null, dateBy: string | null = null): ViewJson {
  return { name, layout, pos, filter: { all: [] }, sorts: [], groupBy, shown: null, widths: {}, cover: COVER_PAGE, cardSize: 'm', dateBy }
}

/** 隐含的「名称」属性（筛选 / 排序引用 title 时按它解读；只读，别改它） */
export const TITLE_PROP: CollectionProp = { id: TITLE_PROP_ID, name: TITLE_NAME, type: 'text', pos: -1, options: [], cfg: {} }

/** Y.Map('collection').toJSON() → 属性定义与视图。入参可以是任何东西，坏的部分跳过或补默认，绝不抛 */
export function parseCollection(json: unknown): CollectionSchema {
  const root = asRecord(json)
  const props = parseProps(own(root, 'props'))
  // 公式的输出类型要在解析视图之前定下：筛选条件、排序按它取舍
  const formulas = annotateFormulas(props)
  const byId = new Map(props.map((prop) => [prop.id, prop]))
  const lookup = (id: unknown): CollectionProp | undefined =>
    id === TITLE_PROP_ID ? TITLE_PROP : typeof id === 'string' ? byId.get(id) : undefined
  const views: CollectionView[] = []
  for (const [id, raw] of Object.entries(asRecord(own(root, 'views')))) {
    if (isShortId(id) && isRecord(raw)) views.push(parseView(id, raw, lookup))
  }
  const v = own(root, 'v')
  const schema: CollectionSchema = {
    v: typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : COLLECTION_VERSION,
    props,
    views: views.sort(byPos),
  }
  rememberFormulas(schema, formulas)
  return schema
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
      cfg: parseCfg(type, own(item, 'cfg')),
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
  const rawLayout = own(raw, 'layout')
  // 不认识的布局（更新的客户端写的）按表格画
  const layout: CollectionLayout = (COLLECTION_LAYOUTS as readonly unknown[]).includes(rawLayout) ? (rawLayout as CollectionLayout) : 'table'
  const groupProp = layoutGroups(layout) ? lookup(own(raw, 'groupBy')) : undefined
  const dateProp = lookup(own(raw, 'dateBy'))
  const cardSize = own(raw, 'cardSize')
  return {
    id,
    name: clipName(own(raw, 'name')),
    layout,
    pos: finiteOr(own(raw, 'pos'), 0),
    filter: { all: parseConditions(own(asRecord(own(raw, 'filter')), 'all'), lookup) },
    sorts: parseSorts(own(raw, 'sorts'), lookup),
    groupBy: groupProp && (groupProp.type === 'status' || groupProp.type === 'select') ? groupProp.id : null,
    shown: parseShown(own(raw, 'shown'), lookup),
    widths: parseWidths(own(raw, 'widths'), lookup),
    cover: parseCover(own(raw, 'cover'), lookup),
    cardSize: (CARD_SIZES as readonly unknown[]).includes(cardSize) ? (cardSize as CardSize) : 'm',
    // 按引用属性的当前类型校验（同 groupBy）：属性删了 / 改成了别的类型就当没选；换布局不清，换回日历还在
    dateBy: dateProp && isDateType(dateProp.type) ? dateProp.id : null,
  }
}

/** 画廊预览来源：引用的属性已删 / 不是文件类型就回到页面封面（同 groupBy 按当前类型校验的口径） */
function parseCover(raw: unknown, lookup: PropLookup): string {
  if (raw === COVER_NONE || raw === COVER_PAGE) return raw
  const prop = lookup(raw)
  return prop?.type === 'files' ? prop.id : COVER_PAGE
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
    if (!prop || typeof op !== 'string' || !(filterOps(prop) as readonly string[]).includes(op)) continue
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
    case 'email':
    case 'phone':
      return typeof raw === 'string' && raw !== '' && !codePointsOver(raw, TEXT_MAX) ? raw : undefined
    case 'number':
    case 'unique_id':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
    case 'status':
      if (op === 'in_group') return isStatusGroup(raw) ? raw : undefined
      return typeof raw === 'string' && findOption(prop, raw) ? raw : undefined
    case 'select':
    case 'multi_select':
      return typeof raw === 'string' && findOption(prop, raw) ? raw : undefined
    case 'person':
    case 'created_by':
    case 'edited_by':
    case 'relation':
      return typeof raw === 'string' && raw !== '' ? raw : undefined
    case 'rollup': {
      const output = rollupOutput(prop.cfg.fn)
      if (output === 'number') return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
      return output === 'date' && typeof raw === 'string' && isCalendarDate(raw) ? raw : undefined
    }
    case 'formula':
      if (prop.output === 'number') return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
      if (prop.output === 'text') return typeof raw === 'string' && raw !== '' && !codePointsOver(raw, TEXT_MAX) ? raw : undefined
      if (prop.output === 'date') return typeof raw === 'string' && isCalendarDate(raw) ? raw : undefined
      // 列表的「包含」比的是一项的文字
      return prop.output === 'list' && typeof raw === 'string' && raw !== '' ? raw : undefined
    // 比较值是一天（区间值与它的关系见 collection-query 的日期筛选）
    case 'date':
    case 'created_time':
    case 'edited_time':
      return typeof raw === 'string' && isCalendarDate(raw) ? raw : undefined
    case 'checkbox':
    case 'files':
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
    // 同一属性排两次没有意义，留第一级；排不了的（关联、列表输出的汇总）丢掉
    if (!prop || seen.has(prop.id) || !sortable(prop)) continue
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

/** 去重后的非空字符串列表（多选 / 人员的值），不是数组返回 undefined */
function stringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  // Set 去重并保持首次出现的顺序。不用 includes：数组可能很长（协同文档 / 请求体里什么都能有），平方级会卡住进程
  const seen = new Set<string>()
  for (const item of raw) if (typeof item === 'string' && item !== '') seen.add(item)
  return [...seen]
}

/** 原始值按属性当前类型解读：形状对不上或选项已删返回 undefined（多选只滤掉已删的项，剩下为空才是 undefined）。
 *  日期读成规范写法（区间开始晚于结束的按交换后的读、起止同一天读成单日）。
 *  行元数据类（创建 / 编辑时间、创建者、最后编辑者、自动编号）不存储，这里恒为 undefined，从行取值用 rowValue */
export function readValue(prop: CollectionProp, raw: unknown): PropValue | undefined {
  switch (prop.type) {
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
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
      return readDate(raw)
    case 'checkbox':
      return typeof raw === 'boolean' ? raw : undefined
    case 'files':
      return readFiles(raw)
    case 'relation': {
      // 只有正向关联存值（对方行的 id 列表）；「只能关联一行」时多出来的（协同连接写进来的）只认第一个
      if (isReverseRelation(prop)) return undefined
      const ids = stringList(raw)
      return ids?.length ? ids.slice(0, prop.cfg.single ? 1 : LIST_MAX) : undefined
    }
    case 'created_time':
    case 'edited_time':
    case 'created_by':
    case 'edited_by':
    case 'unique_id':
    case 'rollup':
    case 'formula':
      return undefined
  }
}

/** 状态的缺省值：选项已按组序排好，取第一个（通常是「未开始」），一个选项都没有则 undefined。
 *  不写进行文档：新行、老行、刚加的状态列都靠读时补，删掉的选项也落回它 */
export function statusDefault(prop: CollectionProp): string | undefined {
  return prop.type === 'status' ? prop.options[0]?.id : undefined
}

/** 人员同形的行元数据（创建者 / 最后编辑者）：包成一项的用户 id 列表，筛选、排序、显示都复用人员那套 */
function userOf(id: unknown): string[] | undefined {
  return typeof id === 'string' && id !== '' ? [id] : undefined
}

/** 算好的值（row.computed 里这个属性的那一项）按属性的类型规整形状：关联是 id 列表（反向关联不封顶），
 *  汇总按输出类型（collection-rollup.ts 的 readRollup），公式按编译出的输出类型（readFormula），其余同存储值 */
export function readComputed(prop: CollectionProp, raw: unknown): PropValue | undefined {
  if (prop.type === 'rollup') return readRollup(prop, raw)
  if (prop.type === 'formula') return readFormula(prop.output, raw)
  if (prop.type !== 'relation') return readValue(prop, raw)
  const ids = stringList(raw)
  return ids?.length ? ids : undefined
}

/** 关联的值：row.computed 有这一项就以它为准（服务端已去掉不在目标集合的行、排好序）；还没有（乐观写之后、回声之前）
 *  时正向关联退回行文档里存的 id 列表，反向关联为空 */
function relationValue(row: CollectionRow, prop: CollectionProp): PropValue | undefined {
  if (isRecord(row.computed) && Object.hasOwn(row.computed, prop.id)) return readComputed(prop, row.computed[prop.id])
  return readValue(prop, isRecord(row.props) ? own(row.props, prop.id) : undefined)
}

/** 一行在某个属性上的值（唯一取值入口）：名称取标题；行元数据类读行字段（字段缺失 = 空，老服务端不给）；
 *  计算值读 row.computed；其余经 readValue 读行的 props（状态读不出补 statusDefault） */
export function rowValue(row: CollectionRow, prop: CollectionProp): PropValue | undefined {
  if (prop.id === TITLE_PROP_ID) return typeof row.title === 'string' && row.title !== '' ? row.title : undefined
  switch (prop.type) {
    case 'created_time':
      return row.created_at || undefined
    case 'edited_time':
      return row.edited_at || undefined
    case 'created_by':
      return userOf(row.created_by)
    case 'edited_by':
      return userOf(row.edited_by)
    case 'unique_id':
      return typeof row.number === 'number' && Number.isInteger(row.number) && row.number > 0 ? row.number : undefined
    case 'relation':
      return relationValue(row, prop)
    case 'rollup':
    case 'formula':
      return readComputed(prop, isRecord(row.computed) ? own(row.computed, prop.id) : undefined)
  }
  return readValue(prop, isRecord(row.props) ? own(row.props, prop.id) : undefined) ?? statusDefault(prop)
}

export type ValidateCtx = {
  /** 空间成员的用户 id（人员属性只能选他们；agent 不是成员） */
  members?: ReadonlySet<string>
  /** 正向关联能选的行（目标集合的活行）；关联已失效时为空，只能清空 */
  rows?: ReadonlySet<string>
}

/** ok 时 value 是规范化后要写进 props 的值，null 表示删掉这个键；否则 error 是给人看的原因 */
export type ValidateResult = { ok: true; value: PropValue | null } | { ok: false; error: string }

const ok = (value: PropValue | null): ValidateResult => ({ ok: true, value })
const bad = (error: string): ValidateResult => ({ ok: false, error })

/** 文本里不能有的字符：换行 / 制表 / 回车之外的控制字符（JSONB 存不了 \u0000） */
const TEXT_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
/** 渲染成链接时会执行脚本的协议 */
const UNSAFE_SCHEME_RE = /^(?:javascript|vbscript|data):/i

/** 链接值能不能渲染成可点的链接（写入校验与界面渲染同一条规则；协同连接写进来的值没过 validateValue） */
export function isUnsafeUrl(url: string): boolean {
  return UNSAFE_SCHEME_RE.test(url.trim())
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
      if (LINE_CONTROL_RE.test(url) || !wellFormed(url)) return bad('链接里有无法保存的字符')
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
    case 'relation': {
      // 反向关联不存值，写入只收增删（服务端 collections/relation-set.ts 换算成源集合各行正向关联的改动），不走这里
      if (isReverseRelation(prop)) return bad('反向关联只能逐个加减')
      const checked = listResult(value, (id) => ctx.rows?.has(id) === true, '行', '只能选关联的集合里的行')
      if (checked.ok && prop.cfg.single && Array.isArray(checked.value) && checked.value.length > 1) return bad('只能关联一行')
      return checked
    }
    case 'email':
      return validateEmail(value)
    case 'phone':
      return validatePhone(value)
    case 'files':
      return validateFiles(value)
    case 'date':
      return validateDate(value)
    case 'checkbox':
      if (typeof value !== 'boolean') return bad('要填是或否')
      return ok(value ? true : null)
    case 'created_time':
    case 'edited_time':
    case 'created_by':
    case 'edited_by':
    case 'unique_id':
    case 'rollup':
    case 'formula':
      return bad('这个属性自动生成，不能改')
  }
}
