// ---------- 关联与汇总的界面口径（纯函数）：行的标题与图标从页面列表取、选择器的候选、能关联的集合、汇总值的文字 ----------
// 关联格里 chip 的标题不用服务端给的 ref_titles（那份只给公式 / 汇总在两端算出同样的结果）：同空间的页面都在页面列表里，
// 别人改名后列表随 changed 重拉，chip 跟着变，不用为此重取窗口。
// 汇总的样子按输出类型（只看计算方式，collection-rollup.ts）：数字（占比是百分数）、日期、列表（按目标属性的样子逐项显示）。
import {
  formatNumber,
  isCalendarDate,
  isReverseRelation,
  TITLE_PROP_ID,
  type CollectionProp,
  type CollectionSchema,
  type PropRef,
  type PropValue,
  type RollupFn,
  type RollupItem,
} from '@ramet/shared/collection-model'
import type { Page } from '../api'
import { formatDate, formatStamp } from './prop-meta'

const EMPTY_INDEX: ReadonlyMap<string, Page> = new Map()
const indexCache = new WeakMap<readonly Page[], Map<string, Page>>()

/** 页面列表的 id 索引：按列表对象缓存，一屏几百个关联格共用一份（列表每次重拉都是新对象） */
export function pageIndex(pages: readonly Page[] | null): ReadonlyMap<string, Page> {
  if (!pages) return EMPTY_INDEX
  let index = indexCache.get(pages)
  if (!index) {
    index = new Map(pages.map((p) => [p.id, p]))
    indexCache.set(pages, index)
  }
  return index
}

/** 是不是对方集合（target）的行：父页是它的活 doc 页 */
const isRowOf = (page: Page | undefined, target: string | undefined): page is Page =>
  page !== undefined && target !== undefined && page.parent_id === target && page.kind === 'doc'

/** 关联格里画得出来的行（按值的顺序）：页面列表里是对方集合的行的。computed 已经服务端过滤过，这里再滤一遍是给
 *  乐观写之后、回声之前退回存储值的情况（存的 id 可能已不在对方集合），以及页面列表比窗口先知道那一行进了回收站 */
export function linkedPages(ids: readonly string[], target: string | undefined, pages: readonly Page[] | null): Page[] {
  const index = pageIndex(pages)
  return ids.map((id) => index.get(id)).filter((page): page is Page => isRowOf(page, target))
}

export type Candidate = { page: Page; on: boolean }

/** 选择器的候选：对方集合的行，按标题搜（不分大小写），已选的排在前面（按选的顺序）；最多 limit 个
 *  （集合按 5,000 行设计，全画出来太重），more = 没画出来的命中数 */
export function relationCandidates(
  pages: readonly Page[] | null,
  target: string | undefined,
  selected: readonly string[],
  query: string,
  limit: number,
): { items: Candidate[]; more: number } {
  const q = query.trim().toLowerCase()
  const hit = (page: Page): boolean => !q || page.title.toLowerCase().includes(q)
  const on = new Set(selected)
  const picked = linkedPages(selected, target, pages).filter(hit)
  const rest = (pages ?? []).filter((page) => isRowOf(page, target) && !on.has(page.id) && hit(page))
  const all = [...picked.map((page) => ({ page, on: true })), ...rest.map((page) => ({ page, on: false }))]
  return { items: all.slice(0, limit), more: Math.max(0, all.length - limit) }
}

/** 选择器里点一行之后的新值：只能关联一行时换成它（再点一次 = 清空），否则切换 */
export function toggleLink(selected: readonly string[], id: string, single: boolean): string[] {
  if (single) return selected.includes(id) ? [] : [id]
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
}

/** 能关联的集合：同一个空间的活集合（含本集合），按标题排 */
export function relatableCollections(pages: readonly Page[] | null, spaceId: string | null): Page[] {
  if (!pages || spaceId === null) return []
  return pages.filter((p) => p.kind === 'collection' && p.space_id === spaceId).sort((a, b) => a.title.localeCompare(b.title))
}

/** 关联值的文字（复制、历史流水）：标题用「、」连；不是对方集合的行（进了回收站、挪走了）写 missing */
export function relationText(ids: readonly string[], pages: readonly Page[] | null, missing: string, untitled: string): string {
  const index = pageIndex(pages)
  return ids.map((id) => {
    const page = index.get(id)
    return page ? page.title || untitled : missing
  }).join('、')
}

/** 汇总目标属性的定义（refs 里给的）当成一个属性用：列表输出的每一项按它的样子显示 */
export function rollupTarget(ref: PropRef | undefined): CollectionProp | null {
  if (!ref?.prop) return null
  return { id: TITLE_PROP_ID, name: '', type: ref.prop.type, pos: 0, options: ref.prop.options, cfg: ref.prop.cfg }
}

/** 列表输出的一项 → 目标属性的一个值：多值类型的一格被摊成了单项，包回列表才能复用它们的显示 */
export function itemValue(target: CollectionProp, item: RollupItem): PropValue {
  if (typeof item === 'object') return [item]
  switch (target.type) {
    case 'multi_select':
    case 'person':
    case 'created_by':
    case 'edited_by':
      return typeof item === 'string' ? [item] : item
    default:
      return item
  }
}

/** 数字输出的文字：占比是百分数（1 位小数），日期范围带「天」，其余最多 2 位小数；自动编号的最小 / 最大带前缀 */
export function rollupNumber(fn: RollupFn | undefined, n: number, target: CollectionProp | null, days: (n: string) => string): string {
  if (fn === 'percent_empty' || fn === 'percent_not_empty' || fn === 'percent_checked' || fn === 'percent_unchecked') {
    return `${(Math.round(n * 1000) / 10).toFixed(1)}%`
  }
  const text = String(Math.round(n * 100) / 100)
  if (fn === 'date_range') return days(text)
  if (target?.type === 'unique_id' && (fn === 'min' || fn === 'max')) return formatNumber(target, n)
  return text
}

/** 日期输出的文字：日期属性是日历日，创建 / 编辑时间是时间戳 */
export function rollupDate(value: string): string {
  return isCalendarDate(value) ? formatDate(value) : formatStamp(value)
}

/** 行页面属性区用的计算值：去掉正向关联那几项。正向关联在属性区直接读行文档（协同直写，改了立刻看到），
 *  单独取的那一行里的 computed 要等服务端回声才跟上 */
export function withoutForward(computed: Record<string, unknown> | undefined, schema: CollectionSchema): Record<string, unknown> {
  const forward = new Set(schema.props.filter((p) => p.type === 'relation' && !isReverseRelation(p)).map((p) => p.id))
  return Object.fromEntries(Object.entries(computed ?? {}).filter(([key]) => !forward.has(key)))
}
