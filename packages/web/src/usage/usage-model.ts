/* ---------- AI 使用量的显示规则（纯函数，单测在 usage-model.test.ts） ---------- */

import type { UsageSource, UsageSums } from './usage-api'

/** 这一行一共多少 token（输入 + 输出 + 缓存读写） */
export function tokensOf(s: UsageSums): number {
  return s.input + s.output + s.cacheRead + s.cacheWrite
}

/** token 数的中文写法：一万以下照写（千分位），一亿以下写「x.x 万」，再往上写「x.x 亿」；小数是 0 就不写 */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(n))
  const short = (x: number, unit: string): string => `${x.toFixed(1).replace(/\.0$/, '')} ${unit}`
  if (v < 10_000) return v.toLocaleString('zh-CN')
  if (v < 100_000_000) return short(v / 10_000, '万')
  return short(v / 100_000_000, '亿')
}

/** '2026-11-09' → '11/9'（横轴与悬停提示用） */
export function shortDay(day: string): string {
  const [, m, d] = day.split('-')
  return m && d ? `${Number(m)}/${Number(d)}` : day
}

/** 每一天的柱高（0–100，按窗口里最多的那天算）：用过的哪怕很少也给一点高度，免得看着像没用过 */
export function barHeights(values: readonly number[]): number[] {
  const max = Math.max(0, ...values)
  if (max <= 0) return values.map(() => 0)
  return values.map((v) => (v > 0 ? Math.max(3, Math.round((v / max) * 100)) : 0))
}

/** 横轴只标三个日子：头、中、尾（每天都标会挤成一团） */
export function axisTicks(days: readonly string[]): Array<{ index: number; label: string }> {
  if (days.length === 0) return []
  const picks = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])]
  return picks.map((index) => ({ index, label: shortDay(days[index]!) }))
}

export const SOURCE_LABEL: Record<UsageSource, string> = {
  genet: 'Genet 对话',
  space_ai: '空间 AI',
  quick: '⌘J 快捷 AI',
  ai_gen: 'AI 块',
  ai_prop: 'AI 属性',
}

/** 认不出的来源（服务端新加了、前端还没更新）原样显示 */
export function sourceLabel(source: string): string {
  return (SOURCE_LABEL as Record<string, string>)[source] ?? source
}
