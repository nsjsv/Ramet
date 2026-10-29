// ---------- 一轮 run 的展示口径（状态条、回复标签、过程页共用） ----------
// 数字格式、动作文案、条目类型对应的图标只在这里定义一次（图形本身在 icons.tsx）。
import { stepLabel, stepVerb, type RunEntry, type StepKind } from '@ramet/shared/run-model'
import type { ReplyStats } from '@ramet/shared/reply-stats'
import { iconSvg, type IconName } from '../icons'

/** 9.7k / 13.2k / 139k / 1.50M */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** 用时：0.7s / 21s / 1:05 */
export function fmtDuration(ms: number): string {
  if (ms < 10_000) return `${Math.max(0.1, ms / 1000).toFixed(1).replace(/\.0$/, '')}s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** 时间线上的相对时刻：0:12 */
export function fmtClock(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** 动作词与「一行里的对象」只在 shared 定义一次（server 写块 / 拼提示词也用同一份） */
export const entryVerb = (e: RunEntry): string => stepVerb(e.k, e.k === 'tool' ? e.kind : undefined)
export const entryObject = stepLabel

/** 工具类型 → 图标；没有专属图的类型画通用圆点 */
const KIND_ICON: Partial<Record<StepKind, IconName>> = {
  read: 'read',
  search: 'search',
  edit: 'edit',
  execute: 'terminal',
  fetch: 'globe',
}

/** 14px 线条图标（currentColor），返回 SVG 字符串。块（attrs 里是任意字符串）与 record 条目共用 */
export function stepIcon(k: string, kind?: string): string {
  const name = k === 'tool' ? (KIND_ICON[kind as StepKind] ?? 'step') : k === 'thought' ? 'think' : 'say'
  return iconSvg(name, 14)
}

export const entryIcon = (e: RunEntry): string => stepIcon(e.k, e.k === 'tool' ? e.kind : undefined)

const n = (v: number): string => v.toLocaleString('en-US')

/** 悬停明细（多行纯文本）；没报的项不出现 */
export function statsTip(s: ReplyStats, clickable: boolean): string {
  const lines: string[] = []
  if (s.tk !== undefined) lines.push(`本轮 ${n(s.tk)} tokens`)
  const io = [
    s.in !== undefined ? `输入 ${n(s.in)}` : '',
    s.out !== undefined ? `输出 ${n(s.out)}` : '',
    s.th !== undefined ? `思考 ${n(s.th)}` : '',
  ].filter(Boolean)
  if (io.length) lines.push(io.join(' · '))
  const cache = [s.cr !== undefined ? `缓存读 ${n(s.cr)}` : '', s.cw !== undefined ? `缓存写 ${n(s.cw)}` : ''].filter(Boolean)
  if (cache.length) lines.push(cache.join(' · '))
  if (s.cu !== undefined && s.cs) lines.push(`上下文 ${fmtTokens(s.cu)} / ${fmtTokens(s.cs)}`)
  if (clickable) lines.push('点击查看过程 ›')
  return lines.join('\n')
}

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/** 详情是否变了的稳定指纹：acp 按引用身份 + 关键字段，避免只比预览长度而漏掉等长更新 */
const acpRefs = new WeakMap<object, number>()
let acpSeq = 0
function acpRef(acp: unknown): number {
  if (!acp || typeof acp !== 'object') return 0
  let id = acpRefs.get(acp as object)
  if (id === undefined) acpRefs.set(acp as object, (id = ++acpSeq))
  return id
}

export function detailKey(e: RunEntry): string {
  if (e.k !== 'tool') return ''
  return [
    e.status,
    e.parentId ?? '',
    acpRef(e.acp),
    e.truncated ? 1 : 0,
    e.thought?.length ?? 0,
    e.output?.length ?? 0,
    (e.thought ?? '').slice(-40),
    (e.output ?? '').slice(-40),
  ].join('|')
}
