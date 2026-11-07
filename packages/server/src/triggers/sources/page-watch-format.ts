// ---------- 盯页面：配置与改动摘要（纯函数） ----------
// 配置：盯哪一页、含不含子页、别人停手多久算改完。摘要：这阵改动里每一页「谁改的、改成了什么」，拿改之前的样子（窗口的 base）
// 与最后一次存盘的样子比（updates.ts 的 summarizeChange，与更新流水同一个口径）；读得见的东西都没变（只改了格式、改了又改回去）的页不写，
// 全都没变就不汇报。页数、每页条数有上限，超了写「还有几处」，整段再由 cleanPayload 限长。

import { SUMMARY_ITEM_LIMIT, summarizeChange, type SchemaOp, type SummaryItem, type SummaryState } from '../../updates.js'

export type WatchConfig = {
  /** 盯的那一页 */
  page: string
  /** 连子页一起盯 */
  subtree: boolean
  /** 别人停手这么多分钟算改完 */
  quiet: number
}

export const QUIET_MIN = 1
export const QUIET_MAX = 120
export const QUIET_DEFAULT = 10
/** 一直有人在改也最多攒这么久就汇报一次 */
export const WINDOW_MAX_MS = 3 * 60 * 60_000
/** 摘要里最多写这么多页 */
export const WATCH_PAGES_MAX = 20

const PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** { page, subtree?, quiet? }；page 可带 page: 前缀。subtree 缺省 true、quiet 缺省 10 分钟 */
export function parseWatchConfig(raw: unknown): WatchConfig | { error: string } {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const page = typeof r.page === 'string' ? r.page.replace(/^page:/, '') : ''
  if (!PAGE_ID.test(page)) return { error: '要盯哪一页？（page 填页面 id）' }
  if (r.subtree !== undefined && typeof r.subtree !== 'boolean') return { error: 'subtree 要写成 true / false' }
  const quiet = r.quiet ?? QUIET_DEFAULT
  if (typeof quiet !== 'number' || !Number.isInteger(quiet) || quiet < QUIET_MIN || quiet > QUIET_MAX) {
    return { error: `停手多久算改完：${QUIET_MIN} 到 ${QUIET_MAX} 之间的整数分钟` }
  }
  return { page, subtree: r.subtree ?? true, quiet }
}

/** 「《预算》及子页 · 别人改完 10 分钟后」；title = null 表示主人看不到那一页了 */
export function describeWatch(raw: unknown, title: string | null): string {
  const c = parseWatchConfig(raw)
  if ('error' in c) return '（盯哪一页认不出来）'
  const where = title === null ? '（看不到的页）' : `《${title || '无标题'}》`
  return `${where}${c.subtree ? '及子页' : ''} · 别人改完 ${c.quiet} 分钟后`
}

/** 汇报时的一页 */
export type WatchedPage = {
  title: string
  /** 进了回收站 */
  trashed: boolean
  /** 这阵改动里新建的页（调用方按建页时刻判）：抬头标「新页」、不另写标题改了 */
  fresh: boolean
  /** 第一次被别人改之前的样子 */
  base: SummaryState
  /** 最后一次存盘的样子；进了回收站的不比 */
  now: SummaryState | null
  /** 这阵里动过手的别人（名字） */
  editors: string[]
  /** 属性 id → 名字（行的父合集的定义）；查不到 = undefined */
  propName(id: string): string | undefined
}

const SCHEMA_TEXT: Record<SchemaOp, string> = {
  prop_add: '加了属性',
  prop_del: '删了属性',
  prop_edit: '改了属性',
  view_add: '加了视图',
  view_del: '删了视图',
  view_edit: '改了视图',
}

/** 没有标题、没有字（新建的页在第一次被写之前就是这样） */
export function isBlank(s: SummaryState): boolean {
  return !s.title.trim() && s.blocks.every((b) => !b.trim())
}

/** 摘要项 → 一行；属性项由调用方合成一行 */
function itemLine(item: SummaryItem): string | null {
  switch (item.kind) {
    case 'edit':
      return `改成：${item.text}`
    case 'add':
      return `新增：${item.text}`
    case 'del':
      return `删掉：${item.text}`
    case 'title':
      return `标题改成：${item.text || '（空）'}`
    case 'schema':
      return `${SCHEMA_TEXT[item.op]}「${item.text}」`
    default:
      return null
  }
}

/** 一页的一段（抬头 + 每处一行）；读得见的都没变 = null */
export function pageSection(p: WatchedPage): string[] | null {
  const fresh = p.fresh
  const who = p.editors.length > 0 ? ` · ${p.editors.join('、')}` : ''
  if (p.trashed) return [`《${p.title || '无标题'}》（进了回收站）${who}`]
  if (!p.now) return null
  const items = summarizeChange(p.base, p.now)
  const lines: string[] = []
  const props: string[] = []
  for (const item of items) {
    if (item.kind === 'prop') {
      const name = p.propName(item.prop) ?? '某个属性'
      if (!props.includes(name)) props.push(name)
      continue
    }
    // 新页的标题已经写在抬头里
    if (item.kind === 'title' && fresh) continue
    const line = itemLine(item)
    if (line) lines.push(line)
  }
  if (props.length > 0) lines.push(`属性：${props.join('、')}`)
  if (lines.length === 0 && (!fresh || isBlank(p.now))) return null
  const shown = lines.slice(0, SUMMARY_ITEM_LIMIT).map((l) => `· ${l}`)
  if (lines.length > SUMMARY_ITEM_LIMIT) shown.push(`· 还有 ${lines.length - SUMMARY_ITEM_LIMIT} 处`)
  return [`《${p.title || '无标题'}》${fresh ? '（新页）' : ''}${who}`, ...shown]
}

/** 整段摘要：按传进来的顺序一页一段，最多 WATCH_PAGES_MAX 页。读得见的都没变的页不写；一页都没有 = null（不汇报） */
export function watchSummary(pages: readonly WatchedPage[]): { text: string; changed: number[] } | null {
  const sections: string[][] = []
  const changed: number[] = []
  pages.forEach((p, i) => {
    const s = pageSection(p)
    if (!s) return
    sections.push(s)
    changed.push(i)
  })
  if (sections.length === 0) return null
  const out = sections.slice(0, WATCH_PAGES_MAX).map((s) => s.join('\n'))
  if (sections.length > WATCH_PAGES_MAX) out.push(`还有 ${sections.length - WATCH_PAGES_MAX} 页也改了`)
  return { text: out.join('\n'), changed }
}
