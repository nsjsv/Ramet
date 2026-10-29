// ---------- agent 品牌 mark ----------
// 图（掩膜 data URI）在 styles/agent-marks.css 的 --mark-* 里。这里负责按 agent id / label 里的词认厂商（整词匹配，
// "Sample" 不会撞上 "amp"），以及渲染 icon 位（mark 用掩膜描形，text 是部署方配置的文本 logo）。
// 单色 + background-color: var(--ink)，一套图适配浅 / 深主题。新增品牌：agent-marks.css 加一行 --mark-<key>，这里匹配表加词。

import type { CSSProperties } from 'react'

/** 认不出厂商时的通用 AI 星标 key（自绘四角星） */
export const GENERIC_MARK = 'generic'

/** 词 → mark key。短词（amp/omp/gpt）只能整词命中，调用方按非字母数字切词 */
const WORD_MARKS: Record<string, string> = {
  claude: 'claude', anthropic: 'claude', opus: 'claude', sonnet: 'claude', haiku: 'claude',
  gemini: 'gemini', googlegemini: 'gemini',
  openai: 'openai', codex: 'openai', gpt: 'openai', chatgpt: 'openai',
  cursor: 'cursor',
  copilot: 'copilot', githubcopilot: 'copilot',
  opencode: 'opencode',
  qwen: 'qwen', qwencode: 'qwen',
  cline: 'cline',
  windsurf: 'windsurf', codeium: 'windsurf',
  amp: 'amp', sourcegraph: 'amp',
  omp: 'omp',
}

/** 文本（agent id 或 label）里的词 → mark key；认不出 null */
export function brandMark(text: string): string | null {
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    const hit = WORD_MARKS[word]
    if (hit) return hit
  }
  return null
}

/** 一个 AI 块/下拉项要显示的 icon 位：品牌 mark（key），或部署方配置的文本 logo */
export type AgentBadge = { kind: 'mark'; key: string } | { kind: 'text'; text: string }

/** mask 图引用：自定义属性套自定义属性，组件侧只写这一小串，不重复 2KB 的 data URI */
export function markVarStyle(key: string): CSSProperties {
  return { '--agent-mark': `var(--mark-${key})` } as CSSProperties
}

/** React icon 位（设置面板行、聊天输入卡） */
export function AgentBadgeView({ badge, className }: { badge: AgentBadge; className?: string }) {
  if (badge.kind === 'mark') {
    return <span className={`agent-mark${className ? ' ' + className : ''}`} style={markVarStyle(badge.key)} />
  }
  return <span className={className}>{badge.text}</span>
}
