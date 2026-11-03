// ---------- 时间线的排版（纯函数）：刻度、取数分块、表头、横条位置、拖动改起止、换刻度时的视口 ----------
// 横轴按天线性排布：一天多少像素由刻度定（SCALES）。画出来的轴是有限长的一段（从 origin 起 AXIS_DAYS 天），
// 滚到快到头时换一个 origin、把 scrollLeft 补回同样的位置（视口不动），所以能一直滚下去。
// 取数按固定边界的块：日 → 按月、周 → 按季、月 / 季 → 按年；取视口覆盖到的块再左右各多一块，每块一个按日期范围取的窗口。
// 块的边界与滚动位置无关：来回滚动不会产生新的窗口键（窗口与冷缓存都复用）。
import { addDays, daysBetween, joinDate, weekdayOf, type CollectionRow, type DateSpan } from '@ramet/shared/collection-model'
import { joinRange } from '@ramet/shared/collection-query'

/** 每天多少像素 */
export const SCALES = { day: 48, week: 24, month: 8, quarter: 3 } as const
export type Scale = keyof typeof SCALES
export const SCALE_ORDER: readonly Scale[] = ['day', 'week', 'month', 'quarter']

export function isScale(raw: unknown): raw is Scale {
  return typeof raw === 'string' && (SCALE_ORDER as readonly string[]).includes(raw)
}

/** 画出来的轴有多少天：各刻度都约 8,700px，宽屏也够滚一阵才换 origin */
export const AXIS_DAYS: Record<Scale, number> = { day: 180, week: 365, month: 1095, quarter: 2920 }

type Unit = 'day' | 'week' | 'month' | 'quarter' | 'year'

/** 包含 day 的那个单位的第一天（周从周一起） */
function unitStart(unit: Unit, day: string): string {
  switch (unit) {
    case 'day':
      return day
    case 'week':
      return addDays(day, -weekdayOf(day))
    case 'month':
      return `${day.slice(0, 7)}-01`
    case 'quarter': {
      const month = Math.floor((Number(day.slice(5, 7)) - 1) / 3) * 3 + 1
      return `${day.slice(0, 4)}-${String(month).padStart(2, '0')}-01`
    }
    case 'year':
      return `${day.slice(0, 4)}-01-01`
  }
}

/** 下一个单位的第一天（start 是某个单位的第一天） */
function unitNext(unit: Unit, start: string): string {
  if (unit === 'day') return addDays(start, 1)
  if (unit === 'week') return addDays(start, 7)
  const months = unit === 'month' ? 1 : unit === 'quarter' ? 3 : 12
  const index = Number(start.slice(0, 4)) * 12 + Number(start.slice(5, 7)) - 1 + months
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}-01`
}

const CHUNK_UNIT: Record<Scale, Unit> = { day: 'month', week: 'quarter', month: 'year', quarter: 'year' }

/** 取数的一块：起止（两端含）与对应的日期范围写法 */
export type Chunk = { from: string; to: string; range: string }

export function chunkOf(scale: Scale, day: string): Chunk {
  const unit = CHUNK_UNIT[scale]
  const from = unitStart(unit, day)
  const to = addDays(unitNext(unit, from), -1)
  return { from, to, range: joinRange(from, to) }
}

/** 覆盖 [from, to] 的块，左右各多一块（滚一点不至于露出没取的空白） */
export function chunksFor(scale: Scale, from: string, to: string): Chunk[] {
  const first = chunkOf(scale, addDays(chunkOf(scale, from).from, -1))
  const last = chunkOf(scale, addDays(chunkOf(scale, to).to, 1))
  const out: Chunk[] = [first]
  while (out[out.length - 1]!.from < last.from) out.push(chunkOf(scale, addDays(out[out.length - 1]!.to, 1)))
  return out
}

/** 表头的一格：从哪天起、占几天（截到 [from, to] 里）；文字由界面按 start 与层级写 */
export type Tick = { start: string; days: number }
export type Header = { top: Tick[]; bottom: Tick[]; topUnit: Unit; bottomUnit: Unit }

const TICK_UNITS: Record<Scale, [Unit, Unit]> = { day: ['month', 'day'], week: ['month', 'week'], month: ['year', 'month'], quarter: ['year', 'quarter'] }

function ticks(unit: Unit, from: string, to: string): Tick[] {
  const out: Tick[] = []
  for (let start = unitStart(unit, from); start <= to; start = unitNext(unit, start)) {
    const a = start < from ? from : start
    const end = addDays(unitNext(unit, start), -1)
    const b = end > to ? to : end
    out.push({ start: a, days: daysBetween(a, b) + 1 })
  }
  return out
}

/** 两层表头：上层 年 / 月，下层 日 / 周（从周一起） / 月 / 季 */
export function headerTicks(scale: Scale, from: string, to: string): Header {
  const [topUnit, bottomUnit] = TICK_UNITS[scale]
  return { top: ticks(topUnit, from, to), bottom: ticks(bottomUnit, from, to), topUnit, bottomUnit }
}

/** 横条在轴上的位置（像素，轴从 origin 那天的左缘起）：单日也占一整天 */
export function barOf(span: DateSpan, origin: string, scale: Scale): { left: number; width: number } {
  const px = SCALES[scale]
  return { left: daysBetween(origin, span.start) * px, width: (daysBetween(span.start, span.end) + 1) * px }
}

/** 轴上 x 像素处是哪一天 */
export function dayAt(x: number, origin: string, scale: Scale): string {
  return addDays(origin, Math.floor(x / SCALES[scale]))
}

export type DragMode = 'move' | 'start' | 'end'

/** 拖动 days 天之后的起止：整条平移；拖开始 / 结束时开始不晚于结束（最少一天），单日拖一端就成了区间 */
export function dragSpan(span: DateSpan, mode: DragMode, days: number): DateSpan {
  if (mode === 'move') return { start: addDays(span.start, days), end: addDays(span.end, days) }
  if (mode === 'start') {
    const start = addDays(span.start, days)
    return { start: start > span.end ? span.end : start, end: span.end }
  }
  const end = addDays(span.end, days)
  return { start: span.start, end: end < span.start ? span.start : end }
}

/** 起止写回日期值（同一天写成单日） */
export const spanValue = (span: DateSpan): string => joinDate(span.start, span.end)

/** 视口左缘是 left 时轴从哪天画起：左边留出三分之一，往回滚也有余地 */
export function axisOrigin(scale: Scale, left: string): string {
  return addDays(left, -Math.floor(AXIS_DAYS[scale] / 3))
}

/** 没记过位置时的视口左缘：今天落在视口的三分之一处 */
export function defaultLeft(scale: Scale, today: string, viewportPx: number): string {
  return addDays(today, -Math.floor(viewportPx / SCALES[scale] / 3))
}

/** 今天居中时的视口左缘 */
export function centerLeft(scale: Scale, day: string, viewportPx: number): string {
  return addDays(day, -Math.floor(viewportPx / SCALES[scale] / 2))
}

/** 换刻度后的视口左缘：今天在视口里就以今天为锚、否则以视口中间那天为锚，锚点留在视口里同样的比例位置 —— 换完今天仍在视口内 */
export function zoomLeft(from: Scale, to: Scale, left: string, viewportPx: number, today: string): string {
  const fromDays = viewportPx / SCALES[from]
  const offset = daysBetween(left, today)
  const anchor = offset >= 0 && offset < fromDays ? today : addDays(left, Math.floor(fromDays / 2))
  const ratio = Math.min(1, Math.max(0, daysBetween(left, anchor) / fromDays))
  return addDays(anchor, -Math.floor(ratio * (viewportPx / SCALES[to])))
}

/** 几块窗口的行合在一起：跨块的区间在每块里都有，按行 id 去重（留先出现的那份） */
export function mergeRows(lists: readonly (readonly CollectionRow[])[]): CollectionRow[] {
  const seen = new Set<string>()
  const out: CollectionRow[] = []
  for (const list of lists) {
    for (const row of list) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      out.push(row)
    }
  }
  return out
}

/** 竖向只画看得见的行（上下各多画 overscan 行）：[first, end) */
export function visibleRange(scrollTop: number, height: number, rowHeight: number, count: number, overscan = 6): [number, number] {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + overscan)
  return [first, Math.max(first, end)]
}
