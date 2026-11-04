// ---------- 日历的排版（纯函数）：月历网格、每周的车道、放不下的「+N」、拖动换天 ----------
// 一屏是 6 × 7 的日期格（周一开头），网格的第一格到最后一格就是这一屏取数的日期范围（窗口的 range）。
// 条目按 [开始, 结束] 截到每一周、各周各自分车道：开始早的、跨度长的先放（同样的按窗口顺序），放进第一条空着的车道；
// 区间跨周就在换行处断开，下一周从行首接着画（clippedLeft / clippedRight 标出断口）。
// 一格放不下的车道收进「+N」：前 capacity - 1 条车道总显示，最后一条车道只在它覆盖的每一天都放得下时显示，其余的数进当天的 N。
import { addDays, dateSpan, daysBetween, joinDate, type CollectionRow, type DateSpan } from '@ramet/shared/collection-model'
import { joinRange } from '@ramet/shared/collection-query'
import { monthGrid, WEEKS, type MonthGrid } from '../../ui/date-model'

/** 日历视图的一屏：月格（ui/date-model，日期选择器同一份）+ 取数用的日期范围（第一格到最后一格） */
export type CalendarGrid = MonthGrid & { range: string }

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

/** 'YYYY-MM'（年份 0001–9999） */
export function isMonth(raw: unknown): raw is string {
  return typeof raw === 'string' && MONTH_RE.test(raw) && raw.slice(0, 4) !== '0000'
}

export function calendarGrid(month: string): CalendarGrid {
  const grid = monthGrid(month)
  return { ...grid, range: joinRange(grid.from, grid.to) }
}

/** 一个要排进日历的条目：行 + 它在日期属性上占的日子 */
export type CalItem = { row: CollectionRow; span: DateSpan }

/** 排进某一周的条目：列（0 = 周一）是截到这一周之后的起止，lane 是第几条车道 */
export type Placed = CalItem & {
  week: number
  colStart: number
  colEnd: number
  lane: number
  /** 区间从上一周延续过来 / 延续到下一周（画断口） */
  clippedLeft: boolean
  clippedRight: boolean
}

/** 开始早的在前、跨度长的在前，再按传入的顺序（窗口顺序） */
function byStartThenLength<T extends { start: number; end: number; order: number }>(a: T, b: T): number {
  return a.start - b.start || b.end - b.start - (a.end - a.start) || a.order - b.order
}

/** 每周一组（WEEKS 组），组内按车道分好 */
export function layoutWeeks(items: readonly CalItem[], grid: MonthGrid): Placed[][] {
  const weeks: Placed[][] = []
  for (let week = 0; week < WEEKS; week++) {
    const first = grid.days[week * 7]!
    const last = grid.days[week * 7 + 6]!
    const here = items
      .map((item, order) => ({ item, order, start: daysBetween(first, item.span.start), end: daysBetween(first, item.span.end) }))
      .filter((x) => x.item.span.start <= last && x.item.span.end >= first)
      .map((x) => ({ ...x, start: Math.max(0, x.start), end: Math.min(6, x.end) }))
      .sort(byStartThenLength)
    /** 每条车道最后占到哪一列 */
    const laneEnd: number[] = []
    const placed: Placed[] = []
    for (const x of here) {
      let lane = laneEnd.findIndex((end) => end < x.start)
      if (lane < 0) lane = laneEnd.push(x.end) - 1
      else laneEnd[lane] = x.end
      placed.push({
        ...x.item,
        week,
        colStart: x.start,
        colEnd: x.end,
        lane,
        clippedLeft: x.item.span.start < first,
        clippedRight: x.item.span.end > last,
      })
    }
    weeks.push(placed)
  }
  return weeks
}

/** 一条车道的高度、日期号那一行的高度（像素，与 collection-calendar.css 的 --cal-lane / --cal-head 一致） */
export const LANE_H = 22
export const DAY_HEAD = 28

/** 一格放得下几条车道（至少一条） */
export function fitLanes(cellHeight: number): number {
  return Math.max(1, Math.floor((cellHeight - DAY_HEAD) / LANE_H))
}

/** 一周里显示哪些条目、每天收起了几条（「+N」） */
export type WeekFit = { shown: Placed[]; more: number[] }

export function fitWeek(placed: readonly Placed[], capacity: number): WeekFit {
  const count = Array.from({ length: 7 }, () => 0)
  for (const p of placed) for (let c = p.colStart; c <= p.colEnd; c++) count[c]!++
  const overflows = (p: Placed): boolean => {
    for (let c = p.colStart; c <= p.colEnd; c++) if (count[c]! > capacity) return true
    return false
  }
  // 最后一条车道让给「+N」：只有它覆盖的每一天都放得下才画
  const shown = placed.filter((p) => p.lane < capacity - 1 || (p.lane === capacity - 1 && !overflows(p)))
  const more = count.slice()
  for (const p of shown) for (let c = p.colStart; c <= p.colEnd; c++) more[c]!--
  return { shown, more }
}

/** 某一天的全部条目（「+N」弹层里列的），顺序同车道的放法 */
export function itemsOn(items: readonly CalItem[], day: string): CalItem[] {
  return items
    .map((item, order) => ({ item, order, start: -daysBetween(item.span.start, day), end: daysBetween(day, item.span.end) }))
    .filter((x) => x.start <= 0 && x.end >= 0)
    .sort(byStartThenLength)
    .map((x) => x.item)
}

/** 日期值整体挪 days 天：区间两端一起挪（长度不变），单日只挪那一天；认不出的值 = null */
export function shiftSpan(value: unknown, days: number): string | null {
  const span = dateSpan(value)
  if (!span) return null
  return joinDate(addDays(span.start, days), addDays(span.end, days))
}
