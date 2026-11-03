// ---------- 集合的值：邮箱、电话、文件、日期（含区间）、自动编号、属性配置的编码与校验 ----------
// collection-model.ts 的 readValue / validateValue / conditionValue 在对应类型的分支里调这里，对外经 collection-model 再导出。
// 这里只 import collection-model 的类型（编译后即消失）：两个模块互相引用，只要这边不在求值时用到对方的值就没有顺序问题。
// collection-rollup.ts 在运行时只依赖这里（不依赖 collection-model），所以属性 id、时间戳这些两边都要的底层工具放在这里。
//
// 文字类的底层工具（按码点计长、控制字符、半个代理项）也在这里，collection-model 的文本 / 链接校验与名字截断共用它们。

import type { CollectionProp, PropCfg, PropType, ValidateResult } from './collection-model.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只读自有属性（Y.Map.toJSON() 用赋值建对象，键叫 __proto__ 的条目会改原型而不是成为属性） */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

const valid = (value: string | FileRef[] | null): ValidateResult => ({ ok: true, value })
const bad = (error: string): ValidateResult => ({ ok: false, error })

// ---------- 属性 id ----------

/** 隐含的「名称」属性：id 固定，值就是行页面的标题。不在 props 里、不能删；筛选 / 排序按文本处理。
 *  属性 id 是 6 位随机串，与它撞不上；解析时也把叫这个 id 的属性条目当坏条目跳过 */
export const TITLE_PROP_ID = 'title'
/** 「名称」的界面名（公式里写 [名称] 引用标题） */
export const TITLE_NAME = '名称'

const ID_RE = /^[0-9a-z]{1,32}$/

/** 属性 / 选项 / 视图 id 的合法形状（newShortId 产 6 位；放宽到 32 位小写字母数字，挡住 __proto__ 之类的键） */
export function isShortId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value)
}

/** 合法的属性 id：「名称」的 title 是保留 id，不能是真实属性 */
export function isPropId(value: unknown): value is string {
  return isShortId(value) && value !== TITLE_PROP_ID
}

/** 页面 / 文件 id 的形状：小写 uuid（协同文档名只认小写） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// ---------- 文字的底层工具 ----------

/** 按码点数是否超过 max（先按 UTF-16 长度快速判掉绝大多数情况，免得每次都展开成数组） */
export function codePointsOver(text: string, max: number): boolean {
  if (text.length <= max) return false
  if (text.length > max * 2) return true
  return [...text].length > max
}

/** 所有控制字符（含换行、制表）：单行的值（链接、邮箱、电话、文件名）里不能有 */
export const LINE_CONTROL_RE = /[\u0000-\u001f\u007f]/

/** 孤立的代理项（半个 emoji）：JSON 能写出来，Postgres 的 JSONB 不收 */
export function wellFormed(text: string): boolean {
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

/** 文本 / 链接值的上限（按码点）；公式的文本结果也截到它 */
export const TEXT_MAX = 2000

// ---------- 邮箱 / 电话 ----------

export const EMAIL_MAX = 320
export const PHONE_MAX = 50
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// 分机（x / 转）、拨号停顿（, ;）、* # 都是电话号码里常见的写法，其余字符一律不收
const PHONE_RE = /^[0-9+\-(). #*,;xX转]+$/

export function validateEmail(value: unknown): ValidateResult {
  if (typeof value !== 'string') return bad('要填邮箱')
  const email = value.trim()
  if (email === '') return valid(null)
  if (codePointsOver(email, EMAIL_MAX)) return bad(`邮箱不能超过 ${EMAIL_MAX} 字`)
  if (LINE_CONTROL_RE.test(email) || !wellFormed(email) || !EMAIL_RE.test(email)) return bad('邮箱格式不对')
  return valid(email)
}

export function validatePhone(value: unknown): ValidateResult {
  if (typeof value !== 'string') return bad('要填电话')
  const phone = value.trim()
  if (phone === '') return valid(null)
  if (codePointsOver(phone, PHONE_MAX)) return bad(`电话不能超过 ${PHONE_MAX} 字`)
  if (!PHONE_RE.test(phone) || (phone.match(/\d/g)?.length ?? 0) < 3) return bad('电话格式不对')
  return valid(phone)
}

// ---------- 文件与媒体 ----------

/** 一格里的一个文件（上传后 /api/files 给的元数据；内容按 id 取，服务端不核对 files 表，取不到显示「文件不可用」） */
export type FileRef = { id: string; name: string; mime: string; size: number }

/** 一格最多几个文件 */
export const FILES_MAX = 20
/** 文件名上限（按码点） */
export const FILE_NAME_MAX = 255
const MIME_MAX = 100

/** 原始值读成文件列表：没有合法 id 的项、重复的 id 跳过，其余字段形状不对按空补（显示得出来就行，原值不动）；一项都没有 = undefined */
export function readFiles(raw: unknown): FileRef[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: FileRef[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= FILES_MAX) break
    if (!isRecord(item)) continue
    const id = own(item, 'id')
    if (typeof id !== 'string' || !UUID_RE.test(id) || seen.has(id)) continue
    seen.add(id)
    const name = own(item, 'name')
    const mime = own(item, 'mime')
    const size = own(item, 'size')
    out.push({
      id,
      name: typeof name === 'string' ? name : '',
      mime: typeof mime === 'string' ? mime : '',
      size: typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : 0,
    })
  }
  return out.length ? out : undefined
}

function checkFile(item: unknown): FileRef | string {
  if (!isRecord(item)) return '要填文件'
  const id = own(item, 'id')
  const name = own(item, 'name')
  const mime = own(item, 'mime')
  const size = own(item, 'size')
  if (typeof id !== 'string' || !UUID_RE.test(id)) return '文件 id 不对'
  if (typeof name !== 'string' || name === '' || codePointsOver(name, FILE_NAME_MAX)) return `文件名要有 1–${FILE_NAME_MAX} 字`
  if (LINE_CONTROL_RE.test(name) || !wellFormed(name)) return '文件名里有无法保存的字符'
  if (typeof mime !== 'string' || mime.length > MIME_MAX || LINE_CONTROL_RE.test(mime) || !wellFormed(mime)) return '文件类型不对'
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return '文件大小不对'
  // 只留这四个字段：客户端多带的键不进行文档
  return { id, name, mime, size }
}

export function validateFiles(value: unknown): ValidateResult {
  if (!Array.isArray(value)) return bad('要填文件列表')
  const files: FileRef[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const file = checkFile(item)
    if (typeof file === 'string') return bad(file)
    if (seen.has(file.id)) continue
    seen.add(file.id)
    files.push(file)
  }
  if (files.length > FILES_MAX) return bad(`一格最多放 ${FILES_MAX} 个文件`)
  return valid(files.length ? files : null)
}

// ---------- 日期（单日或区间） ----------

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

/** 日期值的起止（单日 start = end）。'YYYY-MM-DD' 定长、零填充，字符串比较就是日期先后 */
export type DateSpan = { start: string; end: string }

/** 日期值：单日 'YYYY-MM-DD'，区间 'YYYY-MM-DD/YYYY-MM-DD'（ISO 8601 的区间写法）。
 *  区间编码成字符串而不是对象：还没更新的客户端用 isCalendarDate 认不出，读成空、原值不动，不会把它当成别的东西写坏。
 *  两端都要是真实日历日，否则 undefined；开始晚于结束按交换后的读 */
export function dateSpan(value: unknown): DateSpan | undefined {
  if (typeof value !== 'string') return undefined
  const sep = value.indexOf('/')
  const a = sep < 0 ? value : value.slice(0, sep)
  const b = sep < 0 ? value : value.slice(sep + 1)
  if (!isCalendarDate(a) || !isCalendarDate(b)) return undefined
  return a <= b ? { start: a, end: b } : { start: b, end: a }
}

/** 起止 → 规范的日期值：开始 = 结束写成单日，开始晚于结束交换（调用方保证两端都是日历日） */
export function joinDate(start: string, end: string): string {
  if (start === end) return start
  return start < end ? `${start}/${end}` : `${end}/${start}`
}

/** 原始值读成规范的日期值（同一段日期只有一种写法，显示、筛选、排序都按它）；认不出 = undefined */
export function readDate(raw: unknown): string | undefined {
  const span = dateSpan(raw)
  return span ? joinDate(span.start, span.end) : undefined
}

export function validateDate(value: unknown): ValidateResult {
  const date = readDate(value)
  return date === undefined ? bad('日期要写成 YYYY-MM-DD 或 YYYY-MM-DD/YYYY-MM-DD') : valid(date)
}

export const DAY_MS = 86_400_000

/** 时区偏移（比 UTC 快多少分钟）的规范值：不是有限数按 0（UTC），夹在 ±14 小时里。
 *  筛选折日期与公式的 TODAY() / 时间戳都按它，两处用同一个夹法才算得一样 */
export function tzMinutes(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(-14 * 60, Math.min(14 * 60, raw)) : 0
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

/** 日历日 → 自 1970-01-01 起的天数（之前为负）。按 UTC 算，与时区无关；调用方保证是日历日 */
export function epochDay(day: string): number {
  // setUTCFullYear 而不是 Date.UTC：后者把 0–99 年当成 1900 年代
  const date = new Date(0)
  date.setUTCFullYear(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))
  return Math.round(date.getTime() / DAY_MS)
}

/** epochDay 的逆：天数 → 'YYYY-MM-DD' */
export function fromEpochDay(n: number): string {
  const date = new Date(n * DAY_MS)
  const pad = (v: number, width: number): string => String(v).padStart(width, '0')
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`
}

/** 往后（n < 0 往前）数 n 天 */
export function addDays(day: string, n: number): string {
  return fromEpochDay(epochDay(day) + n)
}

/** b 比 a 晚几天（a 晚于 b 为负） */
export function daysBetween(a: string, b: string): number {
  return epochDay(b) - epochDay(a)
}

/** 星期几，周一 = 0 … 周日 = 6 */
export function weekdayOf(day: string): number {
  return (((epochDay(day) + 3) % 7) + 7) % 7
}

// ---------- 属性配置与自动编号 ----------

/** 自动编号前缀的上限（字符数，只收 [A-Za-z0-9_-]） */
export const NUMBER_PREFIX_MAX = 10

/** 前缀的规范形状：其余字符丢掉，再截到上限（编辑入口与解析同一条规则） */
export function cleanPrefix(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, NUMBER_PREFIX_MAX) : ''
}

/** 汇总的计算方式（cfg.fn 的取值，也是设置菜单里的顺序）。哪种目标类型能用哪些、输出什么见 collection-rollup.ts */
export const ROLLUP_FNS = [
  'show_original',
  'show_unique',
  'count',
  'count_values',
  'count_unique',
  'count_empty',
  'count_not_empty',
  'percent_empty',
  'percent_not_empty',
  'sum',
  'average',
  'median',
  'min',
  'max',
  'range',
  'earliest',
  'latest',
  'date_range',
  'checked',
  'unchecked',
  'percent_checked',
  'percent_unchecked',
] as const
export type RollupFn = (typeof ROLLUP_FNS)[number]

export function isRollupFn(value: unknown): value is RollupFn {
  return typeof value === 'string' && (ROLLUP_FNS as readonly string[]).includes(value)
}

/** 关联的配置：有合法的 mirror 就是反向关联（值由源集合的正向关联倒排算出，不存），否则是正向关联（值存在行文档里）。
 *  target 认不出就不给 —— 关联读成已失效，原值不动 */
function relationCfg(raw: Record<string, unknown>): PropCfg {
  const target = own(raw, 'target')
  const at = typeof target === 'string' && UUID_RE.test(target) ? { target } : {}
  const mirror = own(raw, 'mirror')
  if (isPropId(mirror)) return { ...at, mirror }
  const reverse = own(raw, 'reverse')
  return { ...at, reverse: isPropId(reverse) ? reverse : null, single: own(raw, 'single') === true }
}

/** 汇总的配置：三项各自认不出就不给（汇总读成未配置，值为空） */
function rollupCfg(raw: Record<string, unknown>): PropCfg {
  const relation = own(raw, 'relation')
  const prop = own(raw, 'prop')
  const fn = own(raw, 'fn')
  return {
    ...(isPropId(relation) ? { relation } : {}),
    ...(isPropId(prop) || prop === TITLE_PROP_ID ? { prop: prop as string } : {}),
    ...(isRollupFn(fn) ? { fn } : {}),
  }
}

/** 属性定义里的 cfg 按当前类型读出认得的字段，其余忽略、绝不抛。改类型不清 cfg：改回原类型配置还在。
 *  公式的表达式原样留着（存储形，属性引用写成 [@id]）：长度与语法由编译器判，超长 / 写坏的在那里报错，这里不截断 */
export function parseCfg(type: PropType, raw: unknown): PropCfg {
  const record = isRecord(raw) ? raw : {}
  if (type === 'unique_id') return { prefix: cleanPrefix(own(record, 'prefix')) }
  if (type === 'relation') return relationCfg(record)
  if (type === 'rollup') return rollupCfg(record)
  if (type === 'formula') {
    const expr = own(record, 'expr')
    return { expr: typeof expr === 'string' ? expr : '' }
  }
  return {}
}

/** 自动编号的显示：有前缀写成「前缀-编号」 */
export function formatNumber(prop: CollectionProp, n: number): string {
  return prop.cfg.prefix ? `${prop.cfg.prefix}-${n}` : String(n)
}

/** 反向关联：值由源集合里它镜像的正向关联倒排算出，不在行文档里 */
export function isReverseRelation(prop: Pick<CollectionProp, 'type' | 'cfg'>): boolean {
  return prop.type === 'relation' && typeof prop.cfg.mirror === 'string'
}

const COMPUTED_TYPES: ReadonlySet<PropType> = new Set(['created_time', 'edited_time', 'created_by', 'edited_by', 'unique_id', 'rollup', 'formula'])

/** 值不在行文档里的属性：系统生成的（行元数据）、汇总、公式、反向关联。行文档 props 不写它们，不进更新流水、不随行搬走。
 *  反向关联虽不存值，却能经 REST 改（服务端换算成源集合各行正向关联的增删），编辑入口要单独放行 */
export function isComputedProp(prop: Pick<CollectionProp, 'type' | 'cfg'>): boolean {
  return COMPUTED_TYPES.has(prop.type) || isReverseRelation(prop)
}
