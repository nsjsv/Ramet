// ---------- 集合的汇总：计算方式、适用的目标类型、输出类型与计算 ----------
// 汇总 = 沿本集合的一个关联，对关联到的那些行的某个属性做统计。值只由服务端算（要读别的集合的行，客户端没有），
// 放进 row.computed；两端读它、按输出类型筛选排序都走这里的同一套口径。对外经 collection-model 再导出。
//
// 输出类型只由计算方式决定（不看目标属性的类型）：解析视图时就要知道一个汇总能用哪些筛选运算、能不能排序，
// 那时手上只有本集合的定义，没有对方集合的。最早 / 最晚日期对日期属性给 'YYYY-MM-DD'、对创建 / 编辑时间给时间戳，
// 两种写法筛选（按天）与排序（按毫秒）都认，所以同属「日期」输出。
// 运行时只依赖 collection-values（不依赖 collection-model），collection-model 才能放心 import 这里。

import { DAY_MS, dateSpan, epochDay, isCalendarDate, timeMs, type RollupFn } from './collection-values.js'
import type { CollectionProp, PropType, PropValue, RollupItem } from './collection-model.js'

/** 汇总的输出：数字、日期（日历日或时间戳）、列表（逐个显示目标属性的值，只能筛选为空 / 不为空，不能排序） */
export type RollupOutput = 'number' | 'date' | 'list'

const ANY_FNS = [
  'show_original',
  'show_unique',
  'count',
  'count_values',
  'count_unique',
  'count_empty',
  'count_not_empty',
  'percent_empty',
  'percent_not_empty',
] as const satisfies readonly RollupFn[]
const NUMBER_FNS = [...ANY_FNS, 'sum', 'average', 'median', 'min', 'max', 'range'] as const satisfies readonly RollupFn[]
const DATE_FNS = [...ANY_FNS, 'earliest', 'latest', 'date_range'] as const satisfies readonly RollupFn[]
const CHECKBOX_FNS = [...ANY_FNS, 'checked', 'unchecked', 'percent_checked', 'percent_unchecked'] as const satisfies readonly RollupFn[]

/** 能当汇总目标的类型：关联、汇总、公式不行（不做跨集合的计算链与嵌套解析；公式的值按看的人的时区在两端各算，
 *  服务端汇总时拿不到一个确定的值） */
export function isRollupTarget(type: PropType): boolean {
  return type !== 'relation' && type !== 'rollup' && type !== 'formula'
}

/** 目标属性是这种类型时能用的计算方式（顺序即菜单顺序）；不能当目标 = 空 */
export function rollupFns(type: PropType): readonly RollupFn[] {
  if (!isRollupTarget(type)) return []
  if (type === 'number' || type === 'unique_id') return NUMBER_FNS
  if (type === 'date' || type === 'created_time' || type === 'edited_time') return DATE_FNS
  if (type === 'checkbox') return CHECKBOX_FNS
  return ANY_FNS
}

/** 计算方式 → 输出类型；还没选计算方式按列表（只能筛选为空 / 不为空、不排序，值恒为空） */
export function rollupOutput(fn: RollupFn | undefined): RollupOutput {
  switch (fn) {
    case undefined:
    case 'show_original':
    case 'show_unique':
      return 'list'
    case 'earliest':
    case 'latest':
      return 'date'
    default:
      return 'number'
  }
}

function isFileItem(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { id?: unknown }).id === 'string'
}

/** 日期输出的合法形状：日历日或认得出的时间戳 */
export function isRollupDate(value: unknown): value is string {
  return typeof value === 'string' && (isCalendarDate(value) || Number.isFinite(timeMs(value)))
}

/** 日期输出 → 毫秒（排序用）：日历日按那天的 UTC 零点；认不出 = undefined */
export function rollupDateMs(value: string): number | undefined {
  const ms = isCalendarDate(value) ? epochDay(value) * DAY_MS : timeMs(value)
  return Number.isFinite(ms) ? ms : undefined
}

/** row.computed 里汇总的那一项按输出类型规整：形状对不上 = undefined（同 readValue 的口径），空列表也是 undefined */
export function readRollup(prop: CollectionProp, raw: unknown): PropValue | undefined {
  switch (rollupOutput(prop.cfg.fn)) {
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
    case 'date':
      return isRollupDate(raw) ? raw : undefined
    case 'list': {
      if (!Array.isArray(raw)) return undefined
      const items = raw.filter(
        (item): item is RollupItem =>
          typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)) || isFileItem(item),
      )
      return items.length ? items : undefined
    }
  }
}

/** 列表值逐项摊平（多选 / 人员 / 文件的一格是多个值），单值就是一项 */
function itemsOf(values: readonly PropValue[]): RollupItem[] {
  const out: RollupItem[] = []
  for (const value of values) {
    if (Array.isArray(value)) out.push(...value)
    else out.push(value)
  }
  return out
}

function unique(items: readonly RollupItem[]): RollupItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = JSON.stringify(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const ratio = (part: number, whole: number): number | undefined => (whole > 0 ? part / whole : undefined)

function numberStat(fn: RollupFn, nums: number[]): number | undefined {
  if (nums.length === 0) return undefined
  const sum = nums.reduce((a, b) => a + b, 0)
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  switch (fn) {
    case 'sum':
      return sum
    case 'average':
      return sum / nums.length
    case 'median': {
      const sorted = [...nums].sort((a, b) => a - b)
      const mid = sorted.length >> 1
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2
    }
    case 'min':
      return min
    case 'max':
      return max
    default:
      return max - min
  }
}

/** 最早 / 最晚 / 日期范围。日期属性取区间的开始 / 结束（范围按天）；创建 / 编辑时间原样取时间戳（范围按毫秒折成天） */
function dateStat(fn: RollupFn, target: CollectionProp, values: readonly PropValue[]): string | number | undefined {
  if (target.type === 'date') {
    const spans = values.map(dateSpan).filter((span): span is NonNullable<typeof span> => span !== undefined)
    if (spans.length === 0) return undefined
    const first = spans.reduce((a, b) => (b.start < a ? b.start : a), spans[0]!.start)
    const last = spans.reduce((a, b) => (b.end > a ? b.end : a), spans[0]!.end)
    if (fn === 'earliest') return first
    if (fn === 'latest') return last
    return epochDay(last) - epochDay(first)
  }
  const stamps = values
    .filter((value): value is string => typeof value === 'string')
    .map((stamp) => ({ stamp, ms: timeMs(stamp) }))
    .filter((item) => Number.isFinite(item.ms))
  if (stamps.length === 0) return undefined
  const first = stamps.reduce((a, b) => (b.ms < a.ms ? b : a))
  const last = stamps.reduce((a, b) => (b.ms > a.ms ? b : a))
  if (fn === 'earliest') return first.stamp
  if (fn === 'latest') return last.stamp
  return (last.ms - first.ms) / DAY_MS
}

/** 汇总的值：values 是关联到的每一行在目标属性上的值（经 rowValue 读出，空 = undefined），按关联的顺序。
 *  计算方式不适用于目标类型 = undefined。空集合：计数类 0，占比 / 统计 / 日期类 undefined（不是 0），显示原值 undefined（空列表）。
 *  返回的是写进 row.computed 的 JSON 值（undefined = 不写这一项） */
export function rollupValue(fn: RollupFn, target: CollectionProp, values: readonly (PropValue | undefined)[]): unknown {
  if (!rollupFns(target.type).includes(fn)) return undefined
  const all = values.length
  const present = values.filter((value): value is PropValue => value !== undefined)
  switch (fn) {
    case 'show_original': {
      const items = itemsOf(present)
      return items.length ? items : undefined
    }
    case 'show_unique': {
      const items = unique(itemsOf(present))
      return items.length ? items : undefined
    }
    case 'count':
      return all
    case 'count_values':
      return itemsOf(present).length
    case 'count_unique':
      return unique(itemsOf(present)).length
    case 'count_empty':
      return all - present.length
    case 'count_not_empty':
      return present.length
    case 'percent_empty':
      return ratio(all - present.length, all)
    case 'percent_not_empty':
      return ratio(present.length, all)
    case 'sum':
    case 'average':
    case 'median':
    case 'min':
    case 'max':
    case 'range':
      return numberStat(
        fn,
        present.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)),
      )
    case 'earliest':
    case 'latest':
    case 'date_range':
      return dateStat(fn, target, present)
    case 'checked':
      return present.filter((value) => value === true).length
    case 'unchecked':
      return all - present.filter((value) => value === true).length
    case 'percent_checked':
      return ratio(present.filter((value) => value === true).length, all)
    case 'percent_unchecked':
      return ratio(all - present.filter((value) => value === true).length, all)
  }
}
