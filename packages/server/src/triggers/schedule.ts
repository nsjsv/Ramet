// ---------- 定时器的时间表（纯函数，只用 Intl，不加依赖） ----------
// 四种：一次 / 每天 / 每周 / 每隔。墙上时间一律按定时器自己记下的 IANA 时区算：创建时记下，用户换了时区不悄悄挪已有的定时器。
// 墙上时间 → 绝对时刻：先把它当成 UTC 的那一刻，再用那附近的时区偏移校正。夏令时往前跳过的时刻（不存在）顺延到跳变之后
// （按跳变前的偏移换算，落在跳变后同样的距离）；往回拨时重复的那一段取第一次。
// 不用 cron 表达式：模型填结构化的四种比写 cron 稳，个人助手的常见说法也就这几种。

export type Schedule =
  /** 本地墙上时间 'YYYY-MM-DDTHH:MM' */
  | { kind: 'once'; at: string }
  /** 'HH:MM' */
  | { kind: 'daily'; time: string }
  /** 1 = 周一 … 7 = 周日，去重排序，非空 */
  | { kind: 'weekly'; days: number[]; time: string }
  /** 按绝对时长，不按墙上时间（跨夏令时也是这么多分钟） */
  | { kind: 'every'; minutes: number }

/** 每隔多久的上下限（分钟）：太密花用户的模型额度，太疏就该用每天 / 每周 */
export const EVERY_MINUTES = { min: 60, max: 7 * 24 * 60 } as const

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const WEEK = ['一', '二', '三', '四', '五', '六', '日']

type Day = { y: number; mo: number; d: number }
type Wall = Day & { h: number; mi: number }

const pad = (n: number): string => String(n).padStart(2, '0')

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    // h23：有的 ICU 在 hour12:false 下把午夜写成 24
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(tz, f)
  }
  return f
}

/** 某一刻在 tz 里的墙上时间（到秒） */
function wallOf(t: number, tz: string): Wall & { s: number } {
  const parts = formatter(tz).formatToParts(new Date(t))
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') }
}

/** 某一刻 tz 相对 UTC 的偏移（毫秒，东边为正） */
function offsetAt(t: number, tz: string): number {
  const w = wallOf(t, tz)
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000
}

const sameWall = (a: Wall, b: Wall): boolean => a.y === b.y && a.mo === b.mo && a.d === b.d && a.h === b.h && a.mi === b.mi

/** 墙上时间 → 绝对时刻（毫秒）。偏移取前后一天与当天的：夏令时跳变不会一天之内来两次 */
export function wallToInstant(w: Wall, tz: string): number {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi)
  const before = offsetAt(guess - DAY, tz)
  let best: number | null = null
  for (const o of new Set([before, offsetAt(guess, tz), offsetAt(guess + DAY, tz)])) {
    const t = guess - o
    if (sameWall(wallOf(t, tz), w) && (best === null || t < best)) best = t
  }
  // 没有一个对得上 = 这个时刻被夏令时跳过了：按跳变前的偏移换算，正好落在跳变之后
  return best ?? guess - before
}

function addDays(day: Day, n: number): Day {
  const x = new Date(Date.UTC(day.y, day.mo - 1, day.d + n))
  return { y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate() }
}

/** 1 = 周一 … 7 = 周日（纯日历，与时区无关） */
function weekday(day: Day): number {
  return ((new Date(Date.UTC(day.y, day.mo - 1, day.d)).getUTCDay() + 6) % 7) + 1
}

function parseTime(raw: unknown): { h: number; mi: number } | null {
  const m = typeof raw === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(raw.trim()) : null
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  return h <= 23 && mi <= 59 ? { h, mi } : null
}

function parseAt(raw: unknown): Wall | null {
  const m = typeof raw === 'string' ? /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::00)?$/.exec(raw.trim()) : null
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number]
  // 2 月 30 日之类：Date.UTC 会悄悄进位，换算回来对不上就是不存在的日期
  const back = addDays({ y, mo, d }, 0)
  if (back.y !== y || back.mo !== mo || back.d !== d || h > 23 || mi > 59) return null
  return { y, mo, d, h, mi }
}

const TIME_ERROR = 'time 要写成 24 小时制的 HH:MM（如 09:00）'

/** 校验并规整（补零、去重排序）。不认的形状给一句能照着改的原因 */
export function parseSchedule(raw: unknown): Schedule | { error: string } {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  if (!r) return { error: '时间表要写成 {kind, …}，kind 是 once / daily / weekly / every 之一' }
  if (r.kind === 'once') {
    const w = parseAt(r.at)
    if (!w) return { error: 'once 的 at 要写成本地时间 YYYY-MM-DDTHH:MM（如 2026-11-07T09:00）' }
    return { kind: 'once', at: `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}` }
  }
  if (r.kind === 'daily' || r.kind === 'weekly') {
    const t = parseTime(r.time)
    if (!t) return { error: TIME_ERROR }
    const time = `${pad(t.h)}:${pad(t.mi)}`
    if (r.kind === 'daily') return { kind: 'daily', time }
    const days = Array.isArray(r.days) ? r.days : []
    if (days.length === 0 || !days.every((d) => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 7)) {
      return { error: 'weekly 的 days 要列出星期几：1 = 周一 … 7 = 周日（工作日就是 [1,2,3,4,5]）' }
    }
    return { kind: 'weekly', days: [...new Set(days as number[])].sort((a, b) => a - b), time }
  }
  if (r.kind === 'every') {
    const m = r.minutes
    if (typeof m !== 'number' || !Number.isInteger(m)) return { error: 'every 的 minutes 要写成整数分钟' }
    if (m < EVERY_MINUTES.min) return { error: `间隔最短 ${EVERY_MINUTES.min} 分钟` }
    if (m > EVERY_MINUTES.max) return { error: `间隔最长 7 天（${EVERY_MINUTES.max} 分钟）` }
    return { kind: 'every', minutes: m }
  }
  return { error: 'kind 只能是 once / daily / weekly / every' }
}

/** 严格晚于 after 的下一次；once 已经过了 = null。every 从 anchor 起按步长对齐（创建 / 恢复时 anchor = 那一刻，
 *  认领时 anchor = 刚到的那次预定时刻：它本来就在格点上）。错过了几次都只给 after 之后的那一次 */
export function nextAt(s: Schedule, tz: string, after: Date, anchor: Date): Date | null {
  const a = after.getTime()
  if (s.kind === 'once') {
    const w = parseAt(s.at)
    const t = w ? wallToInstant(w, tz) : NaN
    return t > a ? new Date(t) : null
  }
  if (s.kind === 'every') {
    const step = s.minutes * MINUTE
    const k = Math.max(Math.floor((a - anchor.getTime()) / step) + 1, 0)
    return new Date(anchor.getTime() + k * step)
  }
  const t = parseTime(s.time)
  if (!t) return null
  const start = wallOf(a, tz)
  // 每周最多隔 7 天；多看一天兜住「今天这个点已经过了」
  for (let i = 0; i <= 8; i++) {
    const day = addDays(start, i)
    if (s.kind === 'weekly' && !s.days.includes(weekday(day))) continue
    const at = wallToInstant({ ...day, ...t }, tz)
    if (at > a) return new Date(at)
  }
  return null
}

/** 人话：「每天 09:00」「工作日 09:00」「每周一、三 09:00」「每 2 小时」「11 月 7 日 09:00（一次）」 */
export function describeSchedule(s: Schedule): string {
  if (s.kind === 'once') {
    const w = parseAt(s.at)
    return w ? `${w.mo} 月 ${w.d} 日 ${pad(w.h)}:${pad(w.mi)}（一次）` : s.at
  }
  if (s.kind === 'every') {
    const m = s.minutes
    if (m % (24 * 60) === 0) return `每 ${m / (24 * 60)} 天`
    if (m % 60 === 0) return `每 ${m / 60} 小时`
    return `每 ${m} 分钟`
  }
  if (s.kind === 'daily') return `每天 ${s.time}`
  const key = s.days.join(',')
  if (key === '1,2,3,4,5') return `工作日 ${s.time}`
  if (key === '6,7') return `周末 ${s.time}`
  if (s.days.length === 7) return `每天 ${s.time}`
  return `每周${s.days.map((d) => WEEK[d - 1]).join('、')} ${s.time}`
}

/** 「2026-11-06 周五 14:03」：Genet 的时间行、工具回显、定时通知的抬头 */
export function localStamp(d: Date, tz: string): string {
  const w = wallOf(d.getTime(), tz)
  return `${w.y}-${pad(w.mo)}-${pad(w.d)} 周${WEEK[weekday(w) - 1]} ${pad(w.h)}:${pad(w.mi)}`
}

/** 「09:42」；跟 ref 不在同一个本地日期时写成「11 月 7 日 09:42」（定时通知里的「本应 / 延后到」，两个互为 ref） */
export function shortStamp(d: Date, tz: string, ref: Date): string {
  const w = wallOf(d.getTime(), tz)
  const r = wallOf(ref.getTime(), tz)
  const time = `${pad(w.h)}:${pad(w.mi)}`
  return w.y === r.y && w.mo === r.mo && w.d === r.d ? time : `${w.mo} 月 ${w.d} 日 ${time}`
}

/** Intl 认得的 IANA 时区才收（返回规范写法）；偏移量写法（+08:00）不收：换夏令时它不会跟着变 */
export function validTimeZone(tz: unknown): string | null {
  if (typeof tz !== 'string') return null
  const name = tz.trim()
  if (!name || name.length > 64 || /^[+-]/.test(name)) return null
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone
    return /^[+-]/.test(resolved) ? null : resolved
  } catch {
    return null
  }
}

/** 没上报过时区的用户按服务器的时区 */
export function serverTimeZone(): string {
  return validTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC'
}
