// ---------- 集合的查询：筛选、排序、分组、窗口与增量 ----------
// 服务端用它算窗口（GET /api/collections/:id/rows），客户端用同一组函数把增量套到已加载的窗口上。
// 两端口径必须一模一样，否则增量会漂：客户端以为某行在窗口里，服务端翻页时却按另一种顺序跳过了它。
//
// 顺序是确定的全序：[分组（不按组取窗口时，组序在前）]、视图的多级排序、手动顺序（position NULLS LAST, created_at, id）。
// 空值不论升降序都排最后；文本用固定参数的 Collator，相等再按码点；最后按行 id，任何两行都分得出先后。
// 窗口是排好序的列表的一段前缀，游标是末行的序号 + 行 id；客户端套增量时维持前缀这一性质，游标就一直对得上。

import {
  conditionValue,
  FILTER_OPS,
  findOption,
  findProp,
  isShortId,
  opNeedsValue,
  rowValue,
  timeMs,
  TITLE_PROP_ID,
  type CollectionProp,
  type CollectionRow,
  type CollectionSchema,
  type CollectionView,
  type Condition,
  type Filter,
  type FilterOp,
  type PropValue,
  type RowsDelta,
  type Sort,
} from './collection-model.js'

export type QueryCtx = {
  /** 用户所在时区比 UTC 快多少分钟（东八区 480）：创建 / 编辑时间按它折成日期再和条件比。缺省 0（UTC）；
   *  服务端由请求带来，两端给同一个值才算得一样 */
  tzOffset?: number
  /** 人员排序用的显示名（没给或查不到就按用户 id） */
  nameOf?: (userId: string) => string | undefined
}

/** 一个窗口：服务端窗口查询的结果，也是客户端维护的已加载状态（applyRowsDelta 的入参与返回） */
export type RowsWindow = {
  /** 已按视图顺序排好的行：排好序的全部命中行的一段前缀 */
  rows: CollectionRow[]
  /** 续取游标（原样传回 cursor 取下一页）；null = 已经取完 */
  next: string | null
  /** 命中筛选的行数（按组取时只数这一组） */
  total: number
  /** 视图有分组时：各组命中筛选的行数，键是选项 id，'' 是「无值」组；每个组都有键 */
  groups?: Record<string, number>
  /** 按组取的窗口（看板的一列）：是哪一组 */
  group?: string
}

export type WindowOpts = {
  /** 只取这一组（视图有分组时才生效；'' = 无值组） */
  group?: string
  cursor?: string | null
  /** 缺省 WINDOW_LIMIT，上限 WINDOW_LIMIT_MAX（数字或查询串里的字符串都收） */
  limit?: number | string | null
}

export const WINDOW_LIMIT = 50
export const WINDOW_LIMIT_MAX = 100

export function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
  if (!Number.isFinite(n)) return WINDOW_LIMIT
  return Math.min(WINDOW_LIMIT_MAX, Math.max(1, Math.floor(n)))
}

// ---------- 取值 ----------

type RowTest = (row: CollectionRow) => boolean

const str = (value: PropValue | undefined): string | undefined => (typeof value === 'string' ? value : undefined)
const num = (value: PropValue | undefined): number | undefined => (typeof value === 'number' ? value : undefined)
const list = (value: PropValue | undefined): string[] | undefined => (Array.isArray(value) ? value : undefined)

function tzOffsetOf(ctx: QueryCtx): number {
  const offset = ctx.tzOffset
  return typeof offset === 'number' && Number.isFinite(offset) ? Math.max(-14 * 60, Math.min(14 * 60, offset)) : 0
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0')

/** 时间戳在给定时区里是哪一天（'YYYY-MM-DD'）；认不出 = undefined */
function dayOf(stamp: string, offset: number): string | undefined {
  const ms = timeMs(stamp)
  if (!Number.isFinite(ms)) return undefined
  const date = new Date(ms + offset * 60_000)
  const year = date.getUTCFullYear()
  if (!(year >= 1 && year <= 9999)) return undefined
  return `${pad(year, 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`
}

/** 日期类属性在一行上的「哪一天」：日期就是值本身，创建 / 编辑时间按时区折算 */
function dayGetter(prop: CollectionProp, ctx: QueryCtx): (row: CollectionRow) => string | undefined {
  if (prop.type === 'date') return (row) => str(rowValue(row, prop))
  const offset = tzOffsetOf(ctx)
  return (row) => {
    const stamp = str(rowValue(row, prop))
    return stamp === undefined ? undefined : dayOf(stamp, offset)
  }
}

// ---------- 筛选 ----------

/** 一条条件 → 行判定；运算不适用于属性当前类型、或该带值却没值（还没填完）的条件不参与筛选，返回 null */
function conditionTest(cond: Condition, prop: CollectionProp, ctx: QueryCtx): RowTest | null {
  const op = cond.op
  if (!(FILTER_OPS[prop.type] as readonly FilterOp[]).includes(op)) return null
  const value = conditionValue(prop, op, cond.value)
  if (opNeedsValue(op) && value === undefined) return null
  switch (prop.type) {
    case 'text':
    case 'url': {
      const get = (row: CollectionRow): string | undefined => str(rowValue(row, prop))?.toLowerCase()
      const q = typeof value === 'string' ? value.toLowerCase() : ''
      if (op === 'contains') return (row) => get(row)?.includes(q) === true
      if (op === 'eq') return (row) => get(row) === q
      if (op === 'empty') return (row) => get(row) === undefined
      return (row) => get(row) !== undefined
    }
    case 'number': {
      const get = (row: CollectionRow): number | undefined => num(rowValue(row, prop))
      if (op === 'empty') return (row) => get(row) === undefined
      const n = value as number
      if (op === 'eq') return (row) => get(row) === n
      if (op === 'neq') return (row) => get(row) !== n
      const cmp = (row: CollectionRow, test: (v: number) => boolean): boolean => {
        const v = get(row)
        return v !== undefined && test(v)
      }
      if (op === 'gt') return (row) => cmp(row, (v) => v > n)
      if (op === 'lt') return (row) => cmp(row, (v) => v < n)
      if (op === 'gte') return (row) => cmp(row, (v) => v >= n)
      return (row) => cmp(row, (v) => v <= n)
    }
    case 'select':
    case 'status': {
      const get = (row: CollectionRow): string | undefined => str(rowValue(row, prop))
      if (op === 'is') return (row) => get(row) === value
      if (op === 'is_not') return (row) => get(row) !== value
      if (op === 'in_group')
        return (row) => {
          const v = get(row)
          return v !== undefined && findOption(prop, v)?.group === value
        }
      return (row) => get(row) === undefined
    }
    case 'multi_select':
    case 'person': {
      const get = (row: CollectionRow): string[] | undefined => list(rowValue(row, prop))
      const id = value as string
      if (op === 'contains') return (row) => get(row)?.includes(id) === true
      if (op === 'not_contains') return (row) => get(row)?.includes(id) !== true
      return (row) => get(row) === undefined
    }
    case 'date':
    case 'created_time':
    case 'edited_time': {
      const get = dayGetter(prop, ctx)
      if (op === 'empty') return (row) => get(row) === undefined
      const day = value as string
      if (op === 'eq') return (row) => get(row) === day
      if (op === 'before')
        return (row) => {
          const d = get(row)
          return d !== undefined && d < day
        }
      return (row) => {
        const d = get(row)
        return d !== undefined && d > day
      }
    }
    case 'checkbox':
      // 复选框没有「空」：没勾就是否
      return op === 'checked' ? (row) => rowValue(row, prop) === true : (row) => rowValue(row, prop) !== true
  }
}

function compileFilter(filter: Filter, schema: CollectionSchema, ctx: QueryCtx): RowTest {
  const tests: RowTest[] = []
  for (const cond of Array.isArray(filter?.all) ? filter.all : []) {
    const prop = findProp(schema, cond.prop)
    const test = prop ? conditionTest(cond, prop, ctx) : null
    if (test) tests.push(test)
  }
  if (tests.length === 0) return () => true
  return (row) => tests.every((test) => test(row))
}

/** 一行是否满足筛选（全部条件同时满足；引用已删属性 / 没填完的条件不参与） */
export function matchFilter(row: CollectionRow, filter: Filter, schema: CollectionSchema, ctx: QueryCtx = {}): boolean {
  return compileFilter(filter, schema, ctx)(row)
}

// ---------- 排序 ----------

/** 排序键：undefined = 空（恒排最后）；数组逐项比，前缀短的在前 */
type Key = number | string | (number | string)[] | undefined
type Part = { key: (row: CollectionRow) => Key; dir: 1 | -1 }

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true })

function compareText(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)
}

function compareKey(a: Key, b: Key): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'string' && typeof b === 'string') return compareText(a, b)
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < a.length && i < b.length; i++) {
      const c = compareKey(a[i], b[i])
      if (c) return c
    }
    return a.length - b.length
  }
  return 0
}

function comparePart(a: Key, b: Key, dir: 1 | -1): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1
  return dir * compareKey(a, b)
}

function sortPart(prop: CollectionProp, dir: 1 | -1, ctx: QueryCtx): Part {
  const get = (row: CollectionRow): PropValue | undefined => rowValue(row, prop)
  switch (prop.type) {
    case 'text':
    case 'url':
      return { dir, key: (row) => str(get(row)) }
    case 'number':
      return { dir, key: (row) => num(get(row)) }
    case 'select':
    case 'status':
    case 'multi_select': {
      // 选项按定义里的顺序比（状态已是 组 → pos），不按名字
      const index = new Map(prop.options.map((option, i) => [option.id, i]))
      return {
        dir,
        key: (row) => {
          const v = get(row)
          if (typeof v === 'string') return index.get(v)
          return Array.isArray(v) ? v.map((id) => index.get(id) ?? 0) : undefined
        },
      }
    }
    case 'person':
      return { dir, key: (row) => list(get(row))?.map((id) => ctx.nameOf?.(id) ?? id) }
    case 'date':
      // 'YYYY-MM-DD' → 20261025：数字比较即日期先后
      return {
        dir,
        key: (row) => {
          const day = str(get(row))
          return day === undefined ? undefined : Number(day.slice(0, 4) + day.slice(5, 7) + day.slice(8, 10))
        },
      }
    case 'checkbox':
      return { dir, key: (row) => (get(row) === true ? 1 : 0) }
    case 'created_time':
    case 'edited_time':
      return {
        dir,
        key: (row) => {
          const stamp = str(get(row))
          const ms = stamp === undefined ? NaN : timeMs(stamp)
          return Number.isFinite(ms) ? ms : undefined
        },
      }
  }
}

function sortParts(sorts: Sort[], schema: CollectionSchema, ctx: QueryCtx): Part[] {
  const parts: Part[] = []
  const seen = new Set<string>()
  for (const sort of Array.isArray(sorts) ? sorts : []) {
    const prop = findProp(schema, sort.prop)
    if (!prop || seen.has(prop.id)) continue
    seen.add(prop.id)
    parts.push(sortPart(prop, sort.dir === 'desc' ? -1 : 1, ctx))
  }
  return parts
}

/** 预先算好排序键的行：排序时每行只取一次值 */
type Keyed = { row: CollectionRow; keys: Key[]; position: number; created: number }
type Ordering = { keyed: (row: CollectionRow) => Keyed; compare: (a: Keyed, b: Keyed) => number }

function ordering(parts: Part[]): Ordering {
  return {
    keyed: (row) => {
      const created = typeof row.created_at === 'string' ? timeMs(row.created_at) : NaN
      return {
        row,
        keys: parts.map((part) => part.key(row)),
        // 手动顺序：没排过的（position 为 NULL）在后，再按创建时间、行 id
        position: typeof row.position === 'number' && Number.isFinite(row.position) ? row.position : Infinity,
        created: Number.isFinite(created) ? created : Infinity,
      }
    },
    compare: (a, b) => {
      for (let i = 0; i < parts.length; i++) {
        const c = comparePart(a.keys[i], b.keys[i], parts[i]!.dir)
        if (c) return c
      }
      if (a.position !== b.position) return a.position < b.position ? -1 : 1
      if (a.created !== b.created) return a.created < b.created ? -1 : 1
      return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0
    },
  }
}

/** 两行按多级排序比先后（排序键都相同、或没有排序时按手动顺序）。确定的全序：不同的行永不相等 */
export function compareRows(
  a: CollectionRow,
  b: CollectionRow,
  sorts: Sort[],
  schema: CollectionSchema,
  ctx: QueryCtx = {},
): number {
  const order = ordering(sortParts(sorts, schema, ctx))
  return order.compare(order.keyed(a), order.keyed(b))
}

// ---------- 分组 ----------

type Grouping = { order: string[]; keyOf: (row: CollectionRow) => string }

function groupingOf(groupBy: string | null, schema: CollectionSchema): Grouping | null {
  const prop = groupBy ? findProp(schema, groupBy) : undefined
  if (!prop || (prop.type !== 'status' && prop.type !== 'select')) return null
  const options = prop.options.map((option) => option.id)
  // 状态有选项时空值读成缺省选项（rowValue），「无值」组恒为空，不列
  const order = prop.type === 'status' && options.length > 0 ? options : ['', ...options]
  return { order, keyOf: (row) => str(rowValue(row, prop)) ?? '' }
}

/** 一行落在哪一组：选项 id，空值（含选项已删）是 ''（状态有选项时读成缺省选项，不落空组）。groupBy 不是状态 / 单选时恒为 '' */
export function groupKey(row: CollectionRow, groupBy: string | null, schema: CollectionSchema): string {
  return groupingOf(groupBy, schema)?.keyOf(row) ?? ''
}

/** 组的顺序：「无值」组 '' 在最前，其余按选项顺序（状态先按组 未开始 → 进行中 → 已完成，再按 pos）。不能分组 = [] */
export function groupOrder(schema: CollectionSchema, groupBy: string | null): string[] {
  return groupingOf(groupBy, schema)?.order ?? []
}

function countGroups(rows: CollectionRow[], grouping: Grouping): Record<string, number> {
  const groups: Record<string, number> = {}
  for (const key of grouping.order) groups[key] = 0
  for (const row of rows) bump(groups, grouping.keyOf(row), 1)
  return groups
}

function bump(groups: Record<string, number>, key: string, delta: number): void {
  groups[key] = Math.max(0, (Object.hasOwn(groups, key) ? (groups[key] ?? 0) : 0) + delta)
}

// ---------- 窗口 ----------

/** 视图的完整顺序：不按组取时组序在前（同组的行连在一起，表格能直接分段），再是排序与手动顺序 */
function viewOrdering(view: CollectionView, schema: CollectionSchema, ctx: QueryCtx, grouping: Grouping | null, scoped: boolean): Ordering {
  const parts: Part[] = []
  if (grouping && !scoped) {
    const index = new Map(grouping.order.map((key, i) => [key, i]))
    parts.push({ dir: 1, key: (row) => index.get(grouping.keyOf(row)) ?? 0 })
  }
  return ordering(parts.concat(sortParts(view.sorts, schema, ctx)))
}

const encodeCursor = (index: number, id: string): string => `${index}:${id}`

/** 游标 = 上一页末行在排好序的列表里的序号 + 行 id。序号上的行还是它才接着取，否则从头取：
 *  最坏是窗口错位一屏（客户端按 id 去重、靠增量修正），不会漏行 */
function cursorStart(sorted: CollectionRow[], cursor: unknown): number {
  if (typeof cursor !== 'string') return 0
  const sep = cursor.indexOf(':')
  if (sep <= 0) return 0
  const index = Number(cursor.slice(0, sep))
  if (!Number.isInteger(index) || index < 0) return 0
  return sorted[index]?.id === cursor.slice(sep + 1) ? index + 1 : 0
}

/** 窗口查询：筛选 → 分组计数 →（按组取时只留这一组）→ 排序 → 从游标处截 limit 行 */
export function queryWindow(
  rows: CollectionRow[],
  view: CollectionView,
  schema: CollectionSchema,
  opts: WindowOpts = {},
  ctx: QueryCtx = {},
): RowsWindow {
  const test = compileFilter(view.filter, schema, ctx)
  const grouping = groupingOf(view.groupBy, schema)
  const scope = grouping && typeof opts.group === 'string' ? opts.group : undefined
  const matched = rows.filter(test)
  const inScope = scope === undefined ? matched : matched.filter((row) => grouping!.keyOf(row) === scope)
  const order = viewOrdering(view, schema, ctx, grouping, scope !== undefined)
  const sorted = inScope
    .map(order.keyed)
    .sort(order.compare)
    .map((keyed) => keyed.row)
  const start = cursorStart(sorted, opts.cursor)
  const page = sorted.slice(start, start + clampLimit(opts.limit))
  const last = page.at(-1)
  const end = start + page.length
  return {
    rows: page,
    next: last && end < sorted.length ? encodeCursor(end - 1, last.id) : null,
    total: sorted.length,
    ...(grouping ? { groups: countGroups(matched, grouping) } : {}),
    ...(scope !== undefined ? { group: scope } : {}),
  }
}

/** 夹在 lo、hi 之间的位置（手动顺序写邻居中点）。undefined = 那一侧没有邻居（取 hi - 1 / lo + 1）；null = 邻居没排过（position 为空）。
 *  夹不进去（邻居没排过、次序反了、双精度用尽）= null，调用方重编号后再取。
 *  服务端据此定位置，客户端据此乐观显示：两端同一个算法，乐观位置才与服务端写下的一致 */
export function between(lo: number | null | undefined, hi: number | null | undefined): number | null {
  if (lo === null || hi === null) return null
  const at = lo === undefined ? (hi === undefined ? 0 : hi - 1) : hi === undefined ? lo + 1 : lo + (hi - lo) / 2
  if (!Number.isFinite(at)) return null
  if ((lo !== undefined && !(lo < at)) || (hi !== undefined && !(at < hi))) return null
  return at
}

// ---------- 增量 ----------

/** 用 prev 还原改之前的行（prev 只带变了的键：属性 id → 旧值，null = 当时没有；title = 旧标题） */
function restoreRow(row: CollectionRow, prev: Record<string, unknown>): CollectionRow {
  const props: Record<string, unknown> = { ...row.props }
  let title = row.title
  for (const [key, value] of Object.entries(prev)) {
    if (key === TITLE_PROP_ID) {
      if (typeof value === 'string') title = value
    } else if (isShortId(key)) {
      if (value === null) delete props[key]
      else props[key] = value
    }
  }
  return { ...row, title, props }
}

function insertSorted(rows: CollectionRow[], row: CollectionRow, compare: (a: CollectionRow, b: CollectionRow) => number): void {
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (compare(rows[mid]!, row) <= 0) lo = mid + 1
    else hi = mid
  }
  rows.splice(lo, 0, row)
}

/** 把一批增量套到已加载的窗口上，返回新窗口（不改入参）。
 *  · 改之前的行：在窗口里就用窗口里那份（最准），否则按 prev 还原；没有 prev 说明本批才进集合
 *  · 行在窗口里就摘掉再按新值判定：还命中、且没排到已加载末行之后（或窗口已到底）就插回排好的位置
 *  · 不在窗口里的：命中且排在已加载末行之前（或窗口已到底）就插入；排在后面的等翻页时取
 *  · total 与各组计数按旧行、新行精确增减；已到底的窗口直接按行数校正
 *  这样窗口始终是服务端排好序的列表的前缀，游标接着对得上。
 *  乐观更新也要经这里（合成一条增量），计数才不会重复增减。各列（按组取的窗口）各套一次。
 *  已知余量：prev 里没有旧的编辑时间，按编辑时间筛选时，不在窗口里的行计数可能偏一，下次查询自然校正 */
export function applyRowsDelta(
  window: RowsWindow,
  delta: RowsDelta,
  view: CollectionView,
  schema: CollectionSchema,
  ctx: QueryCtx = {},
): RowsWindow {
  // 顺序基准变了：窗口里的 position 全是旧的，套不上 —— 原样返回，由调用方丢掉窗口重取（见 RowsDelta.reset）
  if (delta.reset) return window
  const test = compileFilter(view.filter, schema, ctx)
  const grouping = groupingOf(view.groupBy, schema)
  const scope = grouping && typeof window.group === 'string' ? window.group : undefined
  const order = viewOrdering(view, schema, ctx, grouping, scope !== undefined)
  const compare = (a: CollectionRow, b: CollectionRow): number => order.compare(order.keyed(a), order.keyed(b))
  const inScope = (row: CollectionRow): boolean => test(row) && (scope === undefined || grouping!.keyOf(row) === scope)
  const complete = window.next === null
  const rows = window.rows.slice()
  let groups = grouping ? { ...window.groups } : undefined
  let total = window.total

  const tally = (row: CollectionRow, sign: 1 | -1): void => {
    if (!test(row)) return
    const key = grouping ? grouping.keyOf(row) : ''
    if (groups) bump(groups, key, sign)
    if (scope === undefined || key === scope) total += sign
  }

  for (const { row } of Array.isArray(delta.rm) ? delta.rm : []) {
    const i = rows.findIndex((r) => r.id === row.id)
    tally(i >= 0 ? rows[i]! : row, -1)
    if (i >= 0) rows.splice(i, 1)
  }

  for (const { row, prev } of Array.isArray(delta.up) ? delta.up : []) {
    const i = rows.findIndex((r) => r.id === row.id)
    const last = rows.at(-1)
    const old = i >= 0 ? rows[i] : prev && typeof prev === 'object' ? restoreRow(row, prev) : undefined
    if (i >= 0) rows.splice(i, 1)
    if (old) tally(old, -1)
    tally(row, 1)
    // 末行就是它自己时，比的是它改之前的位置：没往后挪就留着
    if (inScope(row) && (complete || (last !== undefined && compare(row, last) <= 0))) insertSorted(rows, row, compare)
  }

  if (complete) {
    total = rows.length
    if (groups && grouping) {
      // 不按组取、又已到底：窗口里就是全部命中行，计数直接重数（顺带清掉已删选项的旧键）
      if (scope === undefined) groups = countGroups(rows, grouping)
      else groups[scope] = rows.length
    }
  }
  total = Math.max(total, rows.length)
  const last = rows.at(-1)
  return {
    rows,
    next: rows.length < total ? encodeCursor(rows.length - 1, last?.id ?? '') : null,
    total,
    ...(groups ? { groups } : {}),
    ...(scope !== undefined ? { group: scope } : {}),
  }
}
