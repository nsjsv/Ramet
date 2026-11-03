// ---------- 公式的运行时：值、转换、比较与各函数的实现 ----------
// 值只有几种：数字、文本、是否、日期（FormulaDate）、列表（数字 / 文本 / 是否的数组）、空（null）。
// 空在算术里当 0、在文本里当 ""，比较时只等于空；日期函数遇到空、除以零、开负数平方根、日期越界这类运行时错误
// 抛 FormulaRuntimeError，由求值入口接住，这一格整个为空（不是半截结果）。
// 只用确定的算法（码点比较、固定的大小写转换、自己算的日历），服务端与浏览器才算得一模一样。
// 工作量：服务端每次窗口查询给每行算全部公式，表达式长度有上限，但每一步处理的文字 / 列表可以很长
// （LEN([备注]) 连写几百遍、对几千项的反向关联逐项转文字），只限表达式长度时一行能算出几十毫秒、几千行就把进程拖住几分钟。
// 所以每行有一份工作量（WORK_MAX，大致按处理的字数与项数记，一行的全部公式共用），用完算运行时错误：
// 记法只看值本身，两端对同样的行记出同样的数，哪几格为空也一样。

import { DAY_MS, fromEpochDay } from '../collection-values.js'

/** 日期值：天序号（自 1970-01-01 起，按看的人的时区折好）起止；带时刻的（创建 / 编辑时间、NOW()）另有毫秒 */
export type FormulaDate = { start: number; end: number; ms?: number }
export type Scalar = number | string | boolean
export type FormulaValue = Scalar | FormulaDate | Scalar[] | null

export type EvalEnv = {
  /** 本行某个属性在公式里的值 */
  ref: (id: string) => FormulaValue
  /** 此刻（毫秒） */
  now: number
  /** 看的人的时区比 UTC 快多少分钟 */
  tz: number
  /** 这一行还剩多少工作量（一行的全部公式共用，见文件头） */
  work: { left: number }
}

export class FormulaRuntimeError extends Error {}

export const oops = (): never => {
  throw new FormulaRuntimeError()
}

/** 求值中间的文本最多多少字：SUBSTITUTE 套几层就能指数级变长，超出算运行时错误 */
export const STRING_MAX = 10_000

/** 一行全部公式的工作量上限：正常的公式一行记几百；对着 2,000 字的文本做五十次文字处理才到顶。
 *  与 FORMULA_TOTAL_MAX 一起决定一次窗口查询最坏要算多久 */
export const WORK_MAX = 100_000

/** 记 n 份工作量，用完算运行时错误（这一格为空，这一行后面的公式也很快为空） */
export function spend(env: EvalEnv, n: number): void {
  env.work.left -= n
  if (env.work.left < 0) oops()
}

/** 0001-01-01 与 9999-12-31 的天序号：日期越界算运行时错误 */
const MIN_DAY = -719_162
const MAX_DAY = 2_932_896

export function isDate(v: FormulaValue): v is FormulaDate {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ---------- 取值（静态类型已保证形状，这里只兜底：形状不对按运行时错误） ----------

export function num(v: FormulaValue): number {
  if (v === null) return 0
  return typeof v === 'number' ? v : oops()
}

export function str(v: FormulaValue): string {
  if (v === null) return ''
  return typeof v === 'string' ? v : oops()
}

/** 要逐字处理的文本参数：按长度记工作量 */
export function text(v: FormulaValue, env: EvalEnv): string {
  const s = str(v)
  spend(env, s.length)
  return s
}

export function bool(v: FormulaValue): boolean {
  if (v === null) return false
  return typeof v === 'boolean' ? v : oops()
}

export function date(v: FormulaValue): FormulaDate {
  return isDate(v) ? v : oops()
}

export function list(v: FormulaValue): Scalar[] {
  if (v === null) return []
  return Array.isArray(v) ? v : oops()
}

export function finite(n: number): number {
  return Number.isFinite(n) ? (n === 0 ? 0 : n) : oops()
}

export function capped(s: string): string {
  return s.length > STRING_MAX ? oops() : s
}

export function validDay(day: number): boolean {
  return Number.isInteger(day) && day >= MIN_DAY && day <= MAX_DAY
}

export function checkDay(day: number): number {
  return validDay(day) ? day : oops()
}

/** 毫秒 → 看的人那一天的天序号 */
export function dayOfMs(ms: number, tz: number): number {
  return Math.floor((ms + tz * 60_000) / DAY_MS)
}

// ---------- 显示文字 ----------

/** 数字的文字：最多 15 位有效数字（0.1 + 0.2 写成 0.3，与表格软件一致） */
export function numText(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n)
  return String(Number(n.toPrecision(15)))
}

const pad = (n: number): string => String(n).padStart(2, '0')

function dateText(d: FormulaDate, tz: number): string {
  if (d.ms !== undefined) {
    const local = new Date(d.ms + tz * 60_000)
    return `${fromEpochDay(d.start)} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
  }
  return d.start === d.end ? fromEpochDay(d.start) : `${fromEpochDay(d.start)} → ${fromEpochDay(d.end)}`
}

/** 任何值的显示文字（TEXT()、& 与 CONCAT 都用它）：空是 ""，是否是 TRUE / FALSE，列表用「, 」连起来 */
export function toText(v: FormulaValue, env: EvalEnv): string {
  if (v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return numText(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (Array.isArray(v)) return joined(v, ', ', env)
  return dateText(v, env.tz)
}

/** 几段文字接起来：先算总长，超出 STRING_MAX 不拼（几千项 × 长分隔符拼出来再判，内存早就吃进去了） */
function concat(texts: readonly string[], sep: string, env: EvalEnv): string {
  let size = texts.length > 1 ? (texts.length - 1) * sep.length : 0
  for (const t of texts) size += t.length
  if (size > STRING_MAX) return oops()
  spend(env, size)
  return texts.join(sep)
}

/** 列表逐项的文字用 sep 连起来（按项数记工作量） */
function joined(items: readonly Scalar[], sep: string, env: EvalEnv): string {
  spend(env, items.length)
  return concat(
    items.map((item) => toText(item, env)),
    sep,
    env,
  )
}

/** 相等（列表逐项比，按项数记工作量） */
export function same(a: FormulaValue, b: FormulaValue, env: EvalEnv): boolean {
  if (Array.isArray(a)) spend(env, a.length)
  return equal(a, b)
}

// ---------- 比较 ----------

/** 相等：空只等于空；日期两边都带时刻按毫秒比，否则按起止日比；列表逐项比；类型不同不相等 */
export function equal(a: FormulaValue, b: FormulaValue): boolean {
  if (a === null || b === null) return a === b
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => item === b[i])
  }
  if (isDate(a) || isDate(b)) {
    if (!isDate(a) || !isDate(b)) return false
    return a.ms !== undefined && b.ms !== undefined ? a.ms === b.ms : a.start === b.start && a.end === b.end
  }
  return a === b
}

/** 大小：-1 / 0 / 1；有一边是空或类型不同 = null（比较结果为否）。
 *  文本按码点比，不用排序那个 Collator：比较的结果是值本身（会被筛选、被别的公式引用、决定窗口里有哪些行），
 *  Collator 的结果随 ICU 版本与运行环境而变，服务端与浏览器可能比出不同的是否；按公式列排序只影响先后，
 *  那里用与文本属性同一个 Collator（collection-query 的 compareText） */
export function order(a: FormulaValue, b: FormulaValue): number | null {
  if (a === null || b === null) return null
  const cmp = (x: number | string, y: number | string): number => (x < y ? -1 : x > y ? 1 : 0)
  if (typeof a === 'number' && typeof b === 'number') return cmp(a, b)
  if (typeof a === 'string' && typeof b === 'string') return cmp(a, b)
  if (typeof a === 'boolean' && typeof b === 'boolean') return cmp(Number(a), Number(b))
  if (isDate(a) && isDate(b)) {
    if (a.ms !== undefined && b.ms !== undefined) return cmp(a.ms, b.ms)
    return cmp(a.start, b.start) || cmp(a.end, b.end)
  }
  return null
}

// ---------- 日历 ----------

/** 年月日 → 天序号（月、日超出范围时顺延，同表格软件的 DATE：13 月 = 下一年 1 月，0 日 = 上个月最后一天） */
function makeDay(year: number, month: number, day: number): number {
  if (Math.abs(year) > 100_000 || Math.abs(month) > 1_200_000 || Math.abs(day) > 40_000_000) return oops()
  const d = new Date(0)
  d.setUTCFullYear(year, month - 1, day)
  const ms = d.getTime()
  return Number.isFinite(ms) ? checkDay(Math.round(ms / DAY_MS)) : oops()
}

function parts(day: number): [number, number, number] {
  const s = fromEpochDay(day)
  return [Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10))]
}

/** 加 n 个月：日子超过目标月的天数时落到月末（1 月 31 日加一个月是 2 月最后一天） */
function addMonths(day: number, n: number): number {
  const [y, m, d] = parts(day)
  const total = y * 12 + (m - 1) + n
  const ny = Math.floor(total / 12)
  const nm = total - ny * 12 + 1
  const last = makeDay(ny, nm + 1, 1) - makeDay(ny, nm, 1)
  return makeDay(ny, nm, Math.min(d, last))
}

/** a 到 b 之间满几个月（b 早于 a 为负） */
function monthsBetween(a: number, b: number): number {
  if (a > b) return -monthsBetween(b, a)
  const [ay, am, ad] = parts(a)
  const [by, bm, bd] = parts(b)
  const months = (by - ay) * 12 + (bm - am)
  return bd < ad ? months - 1 : months
}

/** 整段平移 n 天（带时刻的连时刻一起挪） */
export function shiftDays(d: FormulaDate, n: number): FormulaDate {
  const days = Math.trunc(finite(n))
  const out: FormulaDate = { start: checkDay(d.start + days), end: checkDay(d.end + days) }
  if (d.ms !== undefined) out.ms = d.ms + days * DAY_MS
  return out
}

function dateAdd(d: FormulaDate, n: number, unit: string): FormulaDate {
  const count = Math.trunc(finite(n))
  if (Math.abs(count) > 10_000_000) return oops()
  switch (unit.toUpperCase()) {
    case 'D':
      return shiftDays(d, count)
    case 'W':
      return shiftDays(d, count * 7)
    case 'M':
    case 'Y': {
      const months = unit.toUpperCase() === 'Y' ? count * 12 : count
      const start = addMonths(d.start, months)
      const out: FormulaDate = { start, end: addMonths(d.end, months) }
      if (d.ms !== undefined) out.ms = d.ms + (start - d.start) * DAY_MS
      return out
    }
    default:
      return oops()
  }
}

function dateDif(a: FormulaDate, b: FormulaDate, unit: string): number {
  switch (unit.toUpperCase()) {
    case 'D':
      return b.start - a.start
    case 'M':
      return monthsBetween(a.start, b.start)
    case 'Y':
      return Math.trunc(monthsBetween(a.start, b.start) / 12)
    default:
      return oops()
  }
}

// ---------- 数学 ----------

/** 10 的 n 次方倍（借指数写法，免得 1.005 * 100 = 100.49999…） */
function scale(v: number, n: number): number {
  const text = String(v)
  return text.includes('e') ? v * 10 ** n : Number(`${text}e${n}`)
}

/** 按小数位取整：先规整到 15 位有效数字（0.1 + 0.2 当 0.3），再四舍五入 / 远离零 / 朝零 */
function roundTo(x: number, digits: number, how: 'round' | 'up' | 'down'): number {
  const n = Math.max(-15, Math.min(15, Math.trunc(finite(digits))))
  const abs = Number(Math.abs(x).toPrecision(15))
  const shifted = scale(abs, n)
  const whole = how === 'round' ? Math.round(shifted) : how === 'up' ? Math.ceil(shifted) : Math.floor(shifted)
  return finite((x < 0 ? -1 : 1) * scale(whole, -n))
}

/** 参数里的数字（列表逐项，非数字的项跳过，空参数跳过；按项数记工作量） */
function numbersOf(args: FormulaValue[], env: EvalEnv): number[] {
  const out: number[] = []
  for (const arg of args) {
    if (typeof arg === 'number') out.push(arg)
    else if (Array.isArray(arg)) {
      spend(env, arg.length)
      for (const item of arg) if (typeof item === 'number') out.push(item)
    }
  }
  return out
}

/** 最小 / 最大：一个数字都没有算运行时错误（不是 0：空不该比出一个值来） */
function extreme(args: FormulaValue[], env: EvalEnv, pick: (a: number, b: number) => number): number {
  const nums = numbersOf(args, env)
  return nums.length ? finite(nums.reduce((a, b) => pick(a, b))) : oops()
}

// ---------- 文本 ----------

// 按码点数（emoji 算一个字）。不展开成数组：没有代理项的文字（绝大多数）直接用 UTF-16 下标，有的逐个码元走一遍，
// 展开成数组每个字要分配一次，长文本上慢一个数量级
const SURROGATE_RE = /[\uD800-\uDFFF]/

/** 从 UTF-16 下标 i 起的那个码点占几个码元（成对的代理项 2，其余 1） */
function unitsAt(s: string, i: number): number {
  const c = s.charCodeAt(i)
  if (c < 0xd800 || c > 0xdbff || i + 1 >= s.length) return 1
  const d = s.charCodeAt(i + 1)
  return d >= 0xdc00 && d <= 0xdfff ? 2 : 1
}

/** 码点数（同 [...s].length） */
function cpLength(s: string): number {
  if (!SURROGATE_RE.test(s)) return s.length
  let n = 0
  for (let i = 0; i < s.length; i += unitsAt(s, i)) n++
  return n
}

/** 第 k 个码点（从 0 起）的 UTF-16 下标；超出末尾 = 文本长度 */
export function cpIndex(s: string, k: number): number {
  if (k <= 0) return 0
  if (!SURROGATE_RE.test(s)) return Math.min(k, s.length)
  let i = 0
  for (let n = 0; n < k && i < s.length; n++) i += unitsAt(s, i)
  return i
}

/** 按码点取 [from, to)（同 [...s].slice(from, to).join('')，from ≤ to） */
function cpSlice(s: string, from: number, to: number): string {
  return s.slice(cpIndex(s, from), cpIndex(s, to))
}

function valueOf(s: string): number {
  const t = s.trim().replace(/,/g, '')
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(t)) return oops()
  return finite(Number(t))
}

function substitute(s: string, from: string, to: string, env: EvalEnv): string {
  if (from === '') return s
  const pieces = s.split(from)
  // 先估长度再拼：拼出来再判，几层套下来早把内存吃光了
  return concat(pieces, to, env)
}

type Impl = (args: FormulaValue[], env: EvalEnv) => FormulaValue

const unary = (fn: (x: number) => number): Impl => (args) => finite(fn(num(args[0]!)))
const rounding = (how: 'round' | 'up' | 'down'): Impl => (args) => roundTo(num(args[0]!), args.length > 1 ? num(args[1]!) : 0, how)

/** 立即求值的函数（IF / IFS / SWITCH / AND / OR 要按需求值分支，在 evaluate.ts 里）。键是大写函数名 */
export const IMPLS: ReadonlyMap<string, Impl> = new Map<string, Impl>([
  ['NOT', (args) => !bool(args[0]!)],
  ['ISBLANK', ([x]) => x === null || x === '' || (Array.isArray(x) && x.length === 0)],

  ['SUM', (args, env) => finite(numbersOf(args, env).reduce((a, b) => a + b, 0))],
  [
    'AVERAGE',
    (args, env) => {
      const nums = numbersOf(args, env)
      return nums.length ? finite(nums.reduce((a, b) => a + b, 0) / nums.length) : oops()
    },
  ],
  ['MIN', (args, env) => extreme(args, env, Math.min)],
  ['MAX', (args, env) => extreme(args, env, Math.max)],
  ['ROUND', rounding('round')],
  ['ROUNDUP', rounding('up')],
  ['ROUNDDOWN', rounding('down')],
  ['CEILING', unary(Math.ceil)],
  ['FLOOR', unary(Math.floor)],
  ['INT', unary(Math.floor)],
  ['ABS', unary(Math.abs)],
  ['SQRT', unary((x) => (x < 0 ? oops() : Math.sqrt(x)))],
  [
    'MOD',
    (args) => {
      const a = num(args[0]!)
      const b = num(args[1]!)
      // 结果与除数同号（表格软件的口径）
      return b === 0 ? oops() : finite(a - b * Math.floor(a / b))
    },
  ],
  ['POWER', (args) => finite(num(args[0]!) ** num(args[1]!))],

  ['CONCAT', (args, env) => concat(args.map((arg) => toText(arg, env)), '', env)],
  ['LEN', (args, env) => cpLength(text(args[0]!, env))],
  [
    'LEFT',
    (args, env) => {
      const n = args.length > 1 ? Math.trunc(num(args[1]!)) : 1
      return n < 0 ? oops() : cpSlice(text(args[0]!, env), 0, n)
    },
  ],
  [
    'RIGHT',
    (args, env) => {
      const n = args.length > 1 ? Math.trunc(num(args[1]!)) : 1
      if (n < 0) return oops()
      const s = text(args[0]!, env)
      return s.slice(cpIndex(s, Math.max(0, cpLength(s) - n)))
    },
  ],
  [
    'MID',
    (args, env) => {
      const start = Math.trunc(num(args[1]!))
      const n = Math.trunc(num(args[2]!))
      if (start < 1 || n < 0) return oops()
      return cpSlice(text(args[0]!, env), start - 1, start - 1 + n)
    },
  ],
  ['UPPER', (args, env) => capped(text(args[0]!, env).toUpperCase())],
  ['LOWER', (args, env) => capped(text(args[0]!, env).toLowerCase())],
  ['TRIM', (args, env) => text(args[0]!, env).trim().replace(/ {2,}/g, ' ')],
  ['SUBSTITUTE', (args, env) => substitute(text(args[0]!, env), text(args[1]!, env), text(args[2]!, env), env)],
  ['CONTAINS', (args, env) => text(args[0]!, env).includes(text(args[1]!, env))],
  ['TEXT', (args, env) => toText(args[0]!, env)],
  ['VALUE', (args, env) => valueOf(text(args[0]!, env))],

  ['TODAY', (_args, env) => {
    const day = checkDay(dayOfMs(env.now, env.tz))
    return { start: day, end: day }
  }],
  ['NOW', (_args, env) => {
    const day = checkDay(dayOfMs(env.now, env.tz))
    return { start: day, end: day, ms: env.now }
  }],
  [
    'DATE',
    (args) => {
      const day = makeDay(Math.trunc(num(args[0]!)), Math.trunc(num(args[1]!)), Math.trunc(num(args[2]!)))
      return { start: day, end: day }
    },
  ],
  ['YEAR', (args) => parts(date(args[0]!).start)[0]],
  ['MONTH', (args) => parts(date(args[0]!).start)[1]],
  ['DAY', (args) => parts(date(args[0]!).start)[2]],
  // 周一 = 1 … 周日 = 7（1970-01-01 是周四）
  ['WEEKDAY', (args) => ((((date(args[0]!).start + 3) % 7) + 7) % 7) + 1],
  ['DATEDIF', (args, env) => dateDif(date(args[0]!), date(args[1]!), text(args[2]!, env))],
  ['DATEADD', (args, env) => dateAdd(date(args[0]!), num(args[1]!), text(args[2]!, env))],
  [
    'START',
    (args) => {
      const d = date(args[0]!)
      return d.ms !== undefined && d.start === d.end ? d : { start: d.start, end: d.start }
    },
  ],
  [
    'END',
    (args) => {
      const d = date(args[0]!)
      return d.ms !== undefined && d.start === d.end ? d : { start: d.end, end: d.end }
    },
  ],

  ['COUNT', (args) => list(args[0]!).length],
  ['JOIN', (args, env) => joined(list(args[0]!), args.length > 1 ? text(args[1]!, env) : ', ', env)],
  ['FIRST', (args, env) => {
    const items = list(args[0]!)
    return items.length ? toText(items[0]!, env) : null
  }],
  ['LAST', (args, env) => {
    const items = list(args[0]!)
    return items.length ? toText(items[items.length - 1]!, env) : null
  }],
  [
    'INCLUDES',
    (args, env) => {
      const want = toText(args[1]!, env)
      const items = list(args[0]!)
      spend(env, items.length)
      return items.some((item) => toText(item, env) === want)
    },
  ],
])
