// ---------- 各原生驱动共用的步骤文字处理：按字段读原生载荷、去终端控制序列、体积上限 ----------
// 上限与过程详情（run-record）同口径：超了留预览并标 truncated，绝不静默裁。步骤视图的各家来源（claude / codex …）都经这里，
// 同一条规则只写一处。

import type { ToolDiff } from '@ramet/shared/run-model'

/** 单个字段的体积上限：超了留预览并标 truncated */
export const VALUE_MAX = 1_000_000
export const PREVIEW = 2_000
/** 一行标题 / 路径的上限（标题进过程页的一行字，完整内容在视图里） */
export const TITLE_MAX = 200
export const NOTE_MAX = 120

/** 原生载荷按字段读、不信类型：CLI 版本漂移时缺字段不能抛 */
export const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
export const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// 终端控制序列：CSI（颜色 / 光标）、OSC（标题 / 超链接，BEL 或 ST 结尾）、其余两字节转义
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/** 长文字：超过上限留前 PREVIEW 字 */
export function clipText(text: string): { text: string; truncated: boolean } {
  if (text.length <= VALUE_MAX) return { text, truncated: false }
  return { text: `${text.slice(0, PREVIEW)}…`, truncated: true }
}

/** 原样载荷：序列化超过上限就换成可见的截断标记（保留预览） */
export function clipValue(value: unknown): { value: unknown; truncated: boolean } {
  const json = JSON.stringify(value)
  if (json === undefined || json.length <= VALUE_MAX) return { value, truncated: false }
  return { value: { truncated: true, chars: json.length, preview: json.slice(0, PREVIEW) }, truncated: true }
}

/** 第一行非空文字，超长截断（标题 / 失败说明用） */
export function oneLine(text: string, max = TITLE_MAX): string {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** diff 里的大段文字一样受单字段上限约束 */
export function clipDiffs(diffs: ToolDiff[]): { diffs: ToolDiff[]; truncated: boolean } {
  let truncated = false
  const out = diffs.map((d) => {
    const o = clipText(d.old)
    const n = clipText(d.new)
    if (o.truncated || n.truncated) truncated = true
    return { path: d.path, old: o.text, new: n.text }
  })
  return { diffs: out, truncated }
}
