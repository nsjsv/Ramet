// ---------- 提问（ACP elicitation/create，form 模式）----------
// 执行端（AcpAgent：本机与 connector 同一份）把 agent 发来的 requestedSchema 归一成 AskForm，挂成一条带 form 的审批；
// 中心在 POST /permission 时按同一份 AskForm 校验答案（checkAskAnswer），并生成「问题 → 答：…」（askSummary，
// 写进那一步工具调用的 activity 与审计）。
// 只认 ACP 标准，不按 agent 分支。各家的实际形状（全落在下面几类字段里）：
//   claude   AskUserQuestion：question_<n>（oneOf 单选 / array+anyOf 多选）+ question_<n>_custom 自由文本，带 toolCallId
//   codex    request_user_input：必填 string（oneOf，含「None of the above」）+ <id>_note；_meta.codex.isSecret = 密码类
//   opencode question：oneOf 单选 / 多选 + <key>_custom，带 required 与 toolCallId
//   omp      ask：q<n> + q<n>__other；select / confirm / input / editor 包成必填的 { value }（无标题 enum / boolean / string）；
//            计划审批与工具审批也是单字段的 select
// 「补充文本」配对（companionOf）：紧跟在选择题 K 后面、键名以 `K_` 开头的文本字段（_custom / _note / __other）。前端同口径一份。
import type { AskContent, AskField, AskForm, AskOption, AskValue, PermissionOption } from './types.js'

/** 提问的两个选项：答案走 accept + content，跳过走 decline；停止该会话等结束路径是 null（= cancel） */
export const ASK_OPTIONS: PermissionOption[] = [
  { optionId: 'accept', name: '提交' },
  { optionId: 'decline', name: '跳过' },
]

const MESSAGE_MAX = 4_000
const TEXT_MAX = 1_000
const LABEL_MAX = 300
const MAX_FIELDS = 40
const MAX_OPTIONS = 100
/** 一个文本答案的上限（omp 的 editor 是整段预填文字，给足） */
const ANSWER_MAX = 100_000
const SUMMARY_MAX = 300
const FORMATS = new Set(['email', 'uri', 'date', 'date-time'])

type Rec = Record<string, unknown>
const obj = (v: unknown): Rec | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined)
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v ? v.slice(0, max) : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** 可选键只在有值时出现（exactOptionalPropertyTypes 之外也让事件体积小一点） */
function defined<T extends Rec>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]
  return o
}

/** oneOf / anyOf（{const,title,description}）或无标题 enum（字符串数组）→ 选项；去重，空 = 不是选择题 */
function optionsOf(titled: unknown, plain: unknown): AskOption[] {
  const out: AskOption[] = []
  const seen = new Set<string>()
  const push = (value: unknown, label: unknown, description: unknown): void => {
    if (typeof value !== 'string' || seen.has(value) || out.length >= MAX_OPTIONS) return
    seen.add(value)
    out.push(defined({ value, label: str(label, LABEL_MAX) ?? value.slice(0, LABEL_MAX), description: str(description, TEXT_MAX) }))
  }
  if (Array.isArray(titled)) for (const o of titled) push(obj(o)?.const, obj(o)?.title, obj(o)?.description)
  else if (Array.isArray(plain)) for (const v of plain) push(v, v, undefined)
  return out
}

function normalizeField(key: string, raw: unknown): AskField | null {
  const p = obj(raw)
  if (!p) return null
  const base = { key, title: str(p.title, LABEL_MAX), description: str(p.description, TEXT_MAX) }
  switch (p.type) {
    case 'string': {
      const options = optionsOf(p.oneOf, p.enum)
      if (options.length > 0) {
        const d = typeof p.default === 'string' && options.some((o) => o.value === p.default) ? p.default : undefined
        return defined({ ...base, kind: 'choice' as const, options, multi: false, default: d })
      }
      const format = typeof p.format === 'string' && FORMATS.has(p.format) ? (p.format as 'email' | 'uri' | 'date' | 'date-time') : undefined
      const secret = obj(obj(p._meta)?.codex)?.isSecret === true ? true : undefined
      return defined({
        ...base,
        kind: 'text' as const,
        format,
        minLength: num(p.minLength),
        maxLength: num(p.maxLength),
        pattern: str(p.pattern, TEXT_MAX),
        // 密码类的默认值不往外带：提问事件会广播给页面上所有人
        default: typeof p.default === 'string' && !secret ? p.default.slice(0, ANSWER_MAX) : undefined,
        secret,
      })
    }
    case 'array': {
      const items = obj(p.items)
      const options = optionsOf(items?.anyOf, items?.enum)
      if (options.length === 0) return null
      const d = Array.isArray(p.default) ? p.default.filter((v): v is string => options.some((o) => o.value === v)) : undefined
      return defined({ ...base, kind: 'choice' as const, options, multi: true, min: num(p.minItems), max: num(p.maxItems), default: d })
    }
    case 'number':
    case 'integer':
      return defined({ ...base, kind: 'number' as const, integer: p.type === 'integer', min: num(p.minimum), max: num(p.maximum), default: num(p.default) })
    case 'boolean':
      return defined({ ...base, kind: 'boolean' as const, default: typeof p.default === 'boolean' ? p.default : undefined })
    default:
      return null
  }
}

/** ACP CreateElicitationRequest（form 模式）→ AskForm。认不出的字段：可选的丢掉，必填的整条不认（null → 执行端回 cancel） */
export function normalizeAskForm(params: Rec): AskForm | null {
  const schema = obj(params.requestedSchema) ?? {}
  const props = obj(schema.properties) ?? {}
  const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === 'string') : []
  const fields: AskField[] = []
  for (const [key, raw] of Object.entries(props)) {
    const field = normalizeField(key, raw)
    if (!field) {
      if (required.includes(key)) return null
      continue
    }
    if (fields.length >= MAX_FIELDS) return null
    fields.push(field)
  }
  return defined({
    message: str(params.message, MESSAGE_MAX) ?? '',
    fields,
    required: required.filter((k) => fields.some((f) => f.key === k)),
    toolCallId: str(params.toolCallId, LABEL_MAX),
  })
}

/** 补充文本 → 它所属的选择题：紧跟在选择题 K 后面、键名以 `K_` 开头的文本字段 */
export function companionOf(form: AskForm): Map<string, string> {
  const out = new Map<string, string>()
  form.fields.forEach((f, i) => {
    const prev = form.fields[i - 1]
    if (f.kind === 'text' && prev?.kind === 'choice' && f.key.startsWith(`${prev.key}_`)) out.set(f.key, prev.key)
  })
  return out
}

const empty = (v: AskValue | undefined): boolean => v === undefined || v === '' || (Array.isArray(v) && v.length === 0)

function checkText(f: Extract<AskField, { kind: 'text' }>, v: string): string | null {
  if (v.length > ANSWER_MAX) return '太长了'
  if (f.minLength !== undefined && v.length < f.minLength) return `至少 ${f.minLength} 个字`
  if (f.maxLength !== undefined && v.length > f.maxLength) return `最多 ${f.maxLength} 个字`
  if (f.format === 'email' && !/^[^\s@]+@[^\s@]+$/.test(v)) return '不是邮箱地址'
  if (f.format === 'uri' && !URL.canParse(v)) return '不是网址'
  if (f.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return '日期格式应为 YYYY-MM-DD'
  if (f.format === 'date-time' && Number.isNaN(Date.parse(v))) return '不是日期时间'
  if (f.pattern) {
    let re: RegExp | null = null
    try {
      re = new RegExp(f.pattern, 'u')
    } catch {
      // agent 给了坏的正则：不拿它卡用户
    }
    if (re && !re.test(v)) return '格式不对'
  }
  return null
}

/** 一个字段的值：类型不对 / 不在候选里 / 越界 → 原因 */
function checkValue(f: AskField, v: unknown): string | null {
  switch (f.kind) {
    case 'choice': {
      const allowed = (x: unknown): boolean => typeof x === 'string' && f.options.some((o) => o.value === x)
      if (!f.multi) return allowed(v) ? null : '不在可选项里'
      if (!Array.isArray(v) || !v.every(allowed) || new Set(v).size !== v.length) return '不在可选项里'
      if (f.min !== undefined && v.length < f.min) return `至少选 ${f.min} 项`
      if (f.max !== undefined && v.length > f.max) return `最多选 ${f.max} 项`
      return null
    }
    case 'text':
      return typeof v === 'string' ? checkText(f, v) : '应为文字'
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return '应为数字'
      if (f.integer && !Number.isInteger(v)) return '应为整数'
      if (f.min !== undefined && v < f.min) return `不能小于 ${f.min}`
      if (f.max !== undefined && v > f.max) return `不能大于 ${f.max}`
      return null
    case 'boolean':
      return typeof v === 'boolean' ? null : '应为是 / 否'
  }
}

const fieldName = (f: AskField): string => f.title ?? f.description ?? f.key

/** 中心对答案的权威校验：只收表单里有的键、类型对、必填不空、候选 / 范围 / 个数 / 格式满足。
 *  空值（'' / []）当作没填，从答案里去掉。不通过 → 人话原因（路由回 400） */
export function checkAskAnswer(form: AskForm, raw: unknown): { ok: true; content: AskContent } | { ok: false; error: string } {
  const given = raw === undefined || raw === null ? {} : obj(raw)
  if (!given) return { ok: false, error: '答案应为对象' }
  const content: AskContent = {}
  for (const [key, v] of Object.entries(given)) {
    const field = form.fields.find((f) => f.key === key)
    if (!field) return { ok: false, error: `表单里没有「${key}」` }
    if (empty(v as AskValue)) continue
    const why = checkValue(field, v)
    if (why) return { ok: false, error: `「${fieldName(field)}」${why}` }
    content[key] = v as AskValue
  }
  for (const key of form.required) {
    if (empty(content[key])) {
      const field = form.fields.find((f) => f.key === key)
      return { ok: false, error: `「${field ? fieldName(field) : key}」必填` }
    }
  }
  return { ok: true, content }
}

function valueText(f: AskField, v: AskValue): string {
  if (f.kind === 'text' && f.secret) return '••••'
  if (f.kind === 'choice') {
    const label = (x: string): string => f.options.find((o) => o.value === x)?.label ?? x
    return Array.isArray(v) ? v.map(label).join('、') : label(String(v))
  }
  if (f.kind === 'boolean') return v ? '是' : '否'
  return String(v).replace(/\s+/g, ' ').trim()
}

/** 「问题 → 答：…」：写进那一步工具调用的 activity（运行条 / 过程页 / 过程摘要都显示它）与审计。
 *  只有一道主题目时不带题名；补充文本写成「补充」；密码类打码 */
export function askSummary(form: AskForm, optionId: string | null, content: AskContent | undefined): string {
  const head = form.message.split('\n').find((l) => l.trim())?.trim() ?? '提问'
  if (optionId !== 'accept') return clip(`${head} → 跳过`)
  const companions = companionOf(form)
  const labelled = form.fields.filter((f) => !companions.has(f.key)).length > 1
  const parts: string[] = []
  for (const f of form.fields) {
    const v = content?.[f.key]
    if (v === undefined || empty(v)) continue
    const text = valueText(f, v)
    if (companions.has(f.key)) parts.push(`补充：${text}`)
    else parts.push(labelled ? `${fieldName(f)}：${text}` : text)
  }
  return clip(`${head} → 答：${parts.length > 0 ? parts.join('；') : '（未填）'}`)
}

function clip(s: string): string {
  return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1)}…` : s
}
