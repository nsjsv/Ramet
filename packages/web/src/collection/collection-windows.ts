// ---------- 集合 store 的窗口：取数范围、键、范围判定、查询签名、冷缓存里的形状 ----------
// 一个窗口 = 一个视图在一个范围里的行：不限范围（表格 / 列表 / 画廊）、按组（看板的一列）、按日期范围（日历 / 时间线）。
// 行在不在范围里只问 shared 的 matchScope（服务端窗口与客户端增量同一口径），这里不另写判定。
// collection-store.ts 只接线：窗口怎么取、怎么套增量在 store，「是哪个窗口」「该不该重取」的规则在这里。
import { compileFormulas, formulaSig, pickView, TITLE_PROP_ID, type CollectionRow, type CollectionSchema } from '@ramet/shared/collection-model'
import { matchScope, WINDOW_LIMIT, WINDOW_LIMIT_MAX, type QueryCtx } from '@ramet/shared/collection-query'
import type { RowsQuery, WindowState } from './collection-store'

/** 窗口的范围：group = 只取这一组（看板的一列，'' = 无值组）；range = 只取这段日期（写法见 shared 的 parseRange） */
export type WindowScope = { group?: string; range?: string }

/** 按日期范围取的窗口要全拿到才能排版（日历 / 时间线），续取到这么多行就停，界面提示只显示了前这么多条 */
export const RANGE_ROWS_CAP = 1000

export const EMPTY_WINDOW: WindowState = { window: null, loading: true, loadingMore: false, error: null }

export type Win = {
  viewId: string
  scope: WindowScope
  refs: number
  state: WindowState
  /** 发起取数时视图的查询签名：筛选 / 排序 / 分组 / 日期属性或它们引用的属性定义变了就重取 */
  sig: string | null
  seq: number
  fetching: boolean
  /** 取数期间来了增量：取完再取一次（取回的窗口不知道包没包含那次改动） */
  dirty: boolean
  /** 没人看时该重取了：再看时才取（空闲窗口不发请求） */
  stale: boolean
  /** 最近一次变成没人看的先后（越大越晚，只在 refs = 0 时有意义）；从没被人看过又放下 = 0 */
  idleSince: number
}

/** 只留有值的键：请求参数与冷缓存里不出现 undefined，同一个范围也只有一种写法 */
export function cleanScope(scope: WindowScope = {}): WindowScope {
  return {
    ...(scope.group !== undefined ? { group: scope.group } : {}),
    ...(scope.range !== undefined ? { range: scope.range } : {}),
  }
}

export const scopeKey = (viewId: string, scope: WindowScope = {}): string =>
  `${viewId}\u0000${scope.group ?? '\u0001'}\u0000${scope.range ?? '\u0001'}`

export function newWin(viewId: string, scope: WindowScope, state: WindowState = EMPTY_WINDOW, stale = false): Win {
  return { viewId, scope: cleanScope(scope), refs: 0, state, sig: null, seq: 0, fetching: false, dirty: false, stale, idleSince: 0 }
}

/** 没人看的日期范围窗口最多留几个。翻月、横向滚动每到一段新的时间就多一个窗口，全留着的话每条增量都要在每个窗口上套一遍、
 *  冷缓存也跟着涨；按组 / 不限范围的窗口个数有限（视图 × 组），照旧全留 */
export const IDLE_RANGE_MAX = 12

/** 超出 IDLE_RANGE_MAX 的空闲日期范围窗口的键，最早没人看的先丢（丢了再看就是重新取） */
export function idleRangeOverflow(wins: ReadonlyMap<string, Win>): string[] {
  const idle = [...wins].filter(([, w]) => w.refs === 0 && w.scope.range !== undefined).sort(([, a], [, b]) => a.idleSince - b.idleSince)
  return idle.slice(0, Math.max(0, idle.length - IDLE_RANGE_MAX)).map(([key]) => key)
}

/** 行在不在这个窗口的范围里（筛选 ∧ 组 ∧ 日期范围） */
export function fitsScope(row: CollectionRow, schema: CollectionSchema, viewId: string, scope: WindowScope, ctx: QueryCtx): boolean {
  return matchScope(row, pickView(schema, viewId), schema, scope, ctx)
}

/** 一页取多少行：按日期范围取的窗口要取全，按上限取，少跑几趟 */
export function pageLimit(scope: WindowScope): number {
  return scope.range !== undefined ? WINDOW_LIMIT_MAX : WINDOW_LIMIT
}

/** GET rows 的查询串（REST 客户端用）。范围参数漏带的话服务端按不限范围回：日历一屏会排进整个集合的行 */
export function rowsSearch(q: RowsQuery): string {
  const params = new URLSearchParams({ view: q.view, limit: String(q.limit), tz: String(q.tz) })
  if (q.group !== undefined) params.set('group', q.group)
  if (q.range !== undefined) params.set('range', q.range)
  if (q.cursor) params.set('cursor', q.cursor)
  return params.toString()
}

/** 本集合关联 / 汇总属性的定义（不含名字、位置）：它们的值由服务端算，定义一变（换目标、换计算方式、新加一个）
 *  行里的 computed 就旧了。服务端只给依赖它的别的集合发 reset，自己的观看者靠这个签名重取。
 *  公式的定义（表达式与它引用的属性的类型 / 选项 / 配置）也算进来：已加载的行里的公式值是取窗口时算的，
 *  改了表达式、引用的单选改了选项名，重取一次（服务端按新定义算、按新结果筛选排序）。没有公式时签名与之前一样 */
export function computedSig(schema: CollectionSchema): string {
  const computed = schema.props.filter((p) => p.type === 'relation' || p.type === 'rollup').map((p) => [p.id, p.type, p.cfg])
  const formulas = formulaSig(schema)
  return JSON.stringify(formulas ? [...computed, formulas] : computed)
}

/** 视图的查询签名：决定窗口内容的只有筛选、排序、分组、日期属性，以及它们引用的属性当前的定义（类型、选项）；
 *  外加集合有没有自动编号属性 —— 有了服务端才在取窗口时给行补号，刚加上编号属性要重取才看得到号码；
 *  以及关联 / 汇总的定义（computedSig） */
export function querySig(schema: CollectionSchema, viewId: string): string {
  const view = pickView(schema, viewId)
  const used = new Set<string>([...view.filter.all.map((c) => c.prop), ...view.sorts.map((s) => s.prop)])
  if (view.groupBy) used.add(view.groupBy)
  if (view.dateBy) used.add(view.dateBy)
  const numbered = schema.props.some((p) => p.type === 'unique_id')
  return JSON.stringify([view.id, view.filter, view.sorts, view.groupBy, view.dateBy, schema.props.filter((p) => used.has(p.id)), numbered, computedSig(schema)])
}

/** 这个属性的值跟着行标题变：「名称」本身，或（经别的公式）引用了「名称」的公式 */
function followsTitle(schema: CollectionSchema, propId: string): boolean {
  const compiled = compileFormulas(schema)
  const seen = new Set<string>()
  const stack = [propId]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === TITLE_PROP_ID) return true
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...(compiled.get(id)?.deps ?? []))
  }
  return false
}

/** 视图的筛选 / 排序用到了「名称」（含引用了名称的公式）：别的行改名可能让它进出窗口、换位置 */
export function viewUsesTitle(schema: CollectionSchema, viewId: string): boolean {
  const view = pickView(schema, viewId)
  return [...view.filter.all.map((c) => c.prop), ...view.sorts.map((s) => s.prop)].some((id) => followsTitle(schema, id))
}

/** 冷缓存里的一个窗口（集合连接拆掉时留下，再开时打底） */
export type ColdWin = { viewId: string; scope: WindowScope; state: WindowState }

/** 拆掉时留下取到过内容的窗口 */
export function coldWins(wins: Iterable<Win>): ColdWin[] {
  return [...wins].filter((w) => w.state.window).map((w) => ({ viewId: w.viewId, scope: w.scope, state: w.state }))
}

/** 冷缓存打底的窗口：旧内容先给，记 stale，同步后重取 */
export function warmWin(cold: ColdWin): Win {
  return newWin(cold.viewId, cold.scope, { ...cold.state, loading: false, loadingMore: false, error: null }, true)
}
