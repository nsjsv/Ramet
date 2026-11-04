/* ---------- 数字输入的解析与夹取（纯函数）----------
 * React 的 NumberInput 与提问表单（editor/ask-form.ts，纯 DOM）共用；集合的数字值（collection/prop-meta.ts）也用这里的解析。
 * 不用 <input type=number>：系统画的步进箭头跟不了主题，滚轮会悄悄改值，非法输入读出来是空串（分不清没填和填错）。 */

export interface NumberRule {
  min?: number
  max?: number
  integer?: boolean
}

/** 用户敲的数字 → 数；空 = null，不是数字 = undefined。允许千分位逗号、正负号、小数与科学计数 */
export function parseNumberText(text: string): number | null | undefined {
  const t = text.trim().replace(/,/g, '')
  if (t === '') return null
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(t)) return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

/** 按规则收进范围：整数先四舍五入，再夹到 [min, max] */
export function clampNumber(n: number, rule: NumberRule): number {
  let v = rule.integer ? Math.round(n) : n
  if (rule.min !== undefined && v < rule.min) v = rule.min
  if (rule.max !== undefined && v > rule.max) v = rule.max
  return v
}

/** 失焦 / Enter 时草稿该提交成什么：合法 → 收进范围的数；空 → null（允许清空时）；其余 → undefined（回退原值） */
export function commitNumber(text: string, rule: NumberRule & { nullable?: boolean }): number | null | undefined {
  const n = parseNumberText(text)
  if (n === null) return rule.nullable ? null : undefined
  if (n === undefined) return undefined
  return clampNumber(n, rule)
}

/** ↑↓ 步进：从草稿（读不出就从原值，都没有就从 0）走 delta，再收进范围 —— 空框带正的 min 时第一下落在 min 上，同系统数字框。
 *  浮点步长按步长的小数位取整，免得 0.1 + 0.2 显示成 0.30000000000000004 */
export function stepNumber(text: string, fallback: number | null, delta: number, rule: NumberRule): number {
  const parsed = parseNumberText(text)
  const base = typeof parsed === 'number' ? parsed : (fallback ?? 0)
  const digits = decimals(delta)
  const next = digits > 0 ? Number((base + delta).toFixed(Math.max(digits, decimals(base)))) : base + delta
  return clampNumber(next, rule)
}

function decimals(n: number): number {
  const s = String(n)
  const e = s.indexOf('e-')
  if (e >= 0) return Number(s.slice(e + 2))
  const dot = s.indexOf('.')
  return dot >= 0 ? s.length - dot - 1 : 0
}

/** 数 → 文本框里显示的样子（null = 空） */
export function formatNumber(n: number | null): string {
  return n === null ? '' : String(n)
}
