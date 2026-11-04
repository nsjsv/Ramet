/* ---------- 日期的纯逻辑（日期选择器、集合的日期单元格 / 日历视图 / 时间线、表格粘贴共用）----------
 * 同一个日期在日历视图、单元格、选择器里认法和排法都一样，所以只有这一份：
 *   月格（周一开头 6 × 7）、翻月、本地「今天」、人敲的日期文字（含区间）→ 日期值；
 *   选择器自己的键盘移动、HH:MM、日期与时间的拼合拆分。
 * 带时间的值是 'YYYY-MM-DDTHH:MM'（本地时间、不带时区，同原生 datetime-local 的值），要不要换成带偏移的 ISO 由调用方定。 */
import { addDays, isCalendarDate, joinDate, weekdayOf } from '@ramet/shared/collection-model'

/** 一屏月历有几周 */
export const WEEKS = 6

/** 一屏月历：days 是 42 个日期（周一开头），from / to 是第一格 / 最后一格 */
export type MonthGrid = { month: string; days: string[]; from: string; to: string }

export const monthOf = (day: string): string => day.slice(0, 7)

/** 往后（n < 0 往前）翻 n 个月（'YYYY-MM'） */
export function shiftMonth(month: string, n: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n
  const year = Math.floor(index / 12)
  return `${String(year).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`
}

export function monthGrid(month: string): MonthGrid {
  const first = `${month}-01`
  const from = addDays(first, -weekdayOf(first))
  const days = Array.from({ length: WEEKS * 7 }, (_, i) => addDays(from, i))
  return { month, days, from, to: days[days.length - 1]! }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** 本地时区的今天（'YYYY-MM-DD'） */
export function localDay(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 一天的文字 → 'YYYY-MM-DD'：认 2026-1-2、2026/1/2、2026.1.2、2026年1月2日；区间、不存在的日子、认不出 = undefined */
export function parseDay(text: string): string | undefined {
  const m = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/.exec(text.trim())
  if (!m) return undefined
  const iso = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`
  return isCalendarDate(iso) ? iso : undefined
}

/** 日期（含区间）的文字 → 日期值；认不出 = undefined。区间认「开始 → 结束」「开始/结束」「开始 ~ 结束」「开始 至 结束」，
 *  「/」只认两侧都是 YYYY-MM-DD 的写法（2026/1/2 是一天，不是区间） */
export function parseDateInput(text: string): string | undefined {
  const t = text.trim()
  const iso = /^(\d{4}-\d{1,2}-\d{1,2})\s*\/\s*(\d{4}-\d{1,2}-\d{1,2})$/.exec(t)
  const parts = iso ? [iso[1]!, iso[2]!] : t.split(/\s*(?:→|->|~|～|至)\s*/)
  if (parts.length === 1) return parseDay(t)
  if (parts.length !== 2) return undefined
  const start = parseDay(parts[0]!)
  const end = parseDay(parts[1]!)
  return start && end ? joinDate(start, end) : undefined
}

/** 这个月有几天（'YYYY-MM'） */
export function daysInMonth(month: string): number {
  return Number(addDays(`${shiftMonth(month, 1)}-01`, -1).slice(8, 10))
}

/** 往后（n < 0 往前）翻 n 个月，日子夹到那个月的最后一天：1 月 31 日往后一个月是 2 月 28（29）日，不会跳进 3 月 */
export function addMonths(day: string, n: number): string {
  const month = shiftMonth(monthOf(day), n)
  const d = Math.min(Number(day.slice(8, 10)), daysInMonth(month))
  return `${month}-${String(d).padStart(2, '0')}`
}

/** 日历格上的按键 → 移到哪一天；不是移动键 = null。翻出公元 1–9999 年就原地不动（选不了的日子不给焦点） */
export function moveDay(day: string, key: string, shiftKey = false): string | null {
  let next: string
  switch (key) {
    case 'ArrowLeft':
      next = addDays(day, -1)
      break
    case 'ArrowRight':
      next = addDays(day, 1)
      break
    case 'ArrowUp':
      next = addDays(day, -7)
      break
    case 'ArrowDown':
      next = addDays(day, 7)
      break
    // Shift 一次翻一年（同 WAI-ARIA 日期选择器的约定）
    case 'PageUp':
      next = addMonths(day, shiftKey ? -12 : -1)
      break
    case 'PageDown':
      next = addMonths(day, shiftKey ? 12 : 1)
      break
    case 'Home':
      next = addDays(day, -weekdayOf(day))
      break
    case 'End':
      next = addDays(day, 6 - weekdayOf(day))
      break
    default:
      return null
  }
  return isCalendarDate(next) ? next : day
}

const TIME_RE = /^(\d{1,2})\s*[:：]\s*(\d{2})$/

/** 'H:MM' / 'HH:MM'（全角冒号也认）→ 'HH:MM'。分钟必须两位（「9:5」读不出是 9:05 还是 9:50）；越界、认不出 = undefined */
export function parseTime(text: string): string | undefined {
  const m = TIME_RE.exec(text.trim())
  if (!m) return undefined
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return undefined
  return `${pad(h)}:${m[2]}`
}

/** 选了日子但还没给时间时用的时间 */
export const DEFAULT_TIME = '00:00'

export const joinDateTime = (day: string, time: string): string => `${day}T${time}`

/** 'YYYY-MM-DDTHH:MM' → 日子与时间；形状不对 = undefined */
export function splitDateTime(value: string): { day: string; time: string } | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value)
  if (!m || !isCalendarDate(m[1]!) || parseTime(m[2]!) !== m[2]) return undefined
  return { day: m[1]!, time: m[2]! }
}

/** 日期加时间的文字 → 'YYYY-MM-DDTHH:MM'：两段之间用空格或 T；只写了日期 = 当天 DEFAULT_TIME；认不出 = undefined */
export function parseDateTime(text: string): string | undefined {
  const t = text.trim()
  const m = /^(.*?\S)(?:\s+|T)(\d{1,2}\s*[:：]\s*\d{2})$/.exec(t)
  if (m) {
    const day = parseDay(m[1]!)
    const time = parseTime(m[2]!)
    return day && time ? joinDateTime(day, time) : undefined
  }
  const day = parseDay(t)
  return day ? joinDateTime(day, DEFAULT_TIME) : undefined
}

/** 外来的日期时间（JSON Schema 的 date-time 缺省值：'2026-11-03T06:30:00Z'、带 +08:00 偏移、带秒）→ 本地的 'YYYY-MM-DDTHH:MM'。
 *  不能直接截前 16 位：带 Z / 偏移的是别的时区的钟点，当本地时间显示再交回去，值就差了一个时区。
 *  人写的形状（只有日期、本地 HH:MM）走 parseDateTime（Date.parse 会把只有日期的当成 UTC 零点）；认不出 = undefined */
export function localDateTimeOf(text: string): string | undefined {
  const own = parseDateTime(text)
  if (own) return own
  const ms = Date.parse(text.trim())
  if (!Number.isFinite(ms)) return undefined
  const d = new Date(ms)
  return joinDateTime(localDay(d), `${pad(d.getHours())}:${pad(d.getMinutes())}`)
}

/** 框里显示的样子：日期与时间之间是空格（比 T 好认） */
export const formatDateTime = (value: string): string => value.replace('T', ' ')

/** 日格的年、月、日、星期几（0 = 周一），给读屏名称用 */
export function dayParts(day: string): { year: number; month: number; date: number; weekday: number } {
  return { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)), date: Number(day.slice(8, 10)), weekday: weekdayOf(day) }
}
