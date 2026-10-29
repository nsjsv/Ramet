/* ---------- 表格视图的纯计算：列、网格模板、分组分段、拖行落点、单元格光标 ----------
 * 分段只是把窗口里的行按组切开：窗口本身已按「组序 → 排序 → 手动顺序」排好（@ramet/shared/collection-query），
 * 所以同组的行是连着的；计数用服务端给的 groups（窗口外的行也算在内）。 */
import {
  findOption,
  findProp,
  TITLE_PROP,
  type CollectionOption,
  type CollectionProp,
  type CollectionRow,
  type CollectionSchema,
  type CollectionView,
} from '@ramet/shared/collection-model'
import { groupKey, groupOrder, type RowsWindow } from '@ramet/shared/collection-query'
import { columnWidth } from '../prop-meta'

/** 拖行 / 拖卡片的 dataTransfer 类型：不用 text/plain，拖出集合落进正文时不会把行 id 当文字插进去 */
export const ROW_DRAG_TYPE = 'application/x-ramet-row'

/** 行尾「＋ 属性」格的最小宽度 */
export const ADD_W = 44

/** 表格的列：「名称」恒为第一列，其余按视图的显示顺序（已删的属性不画） */
export function columnsOf(schema: CollectionSchema, view: CollectionView): CollectionProp[] {
  const shown = view.shown ?? schema.props.map((p) => p.id)
  const cols: CollectionProp[] = [TITLE_PROP]
  for (const id of shown) {
    const prop = findProp(schema, id)
    if (prop && prop.id !== TITLE_PROP.id) cols.push(prop)
  }
  return cols
}

/** CSS grid 的列模板（不含行首的手柄 + 勾选框格：它的宽度由 CSS 的 --cl-gutter-w 定）；override = 正在拖宽的那一列（拖动中只改本地样式，松手才写文档） */
export function gridTemplate(cols: CollectionProp[], view: CollectionView, override?: { id: string; width: number } | null): string {
  const widths = cols.map((p) => (override && override.id === p.id ? override.width : columnWidth(view, p)))
  return [...widths.map((w) => `${w}px`), `minmax(${ADD_W}px, 1fr)`].join(' ')
}

export type Section = {
  /** 组键（选项 id，'' = 无值组）；null = 视图不分组 */
  key: string | null
  option?: CollectionOption
  rows: CollectionRow[]
  /** 这一组命中筛选的总行数（含没加载的） */
  count: number
}

/** 窗口 → 分段。不分组 = 一段；分组时按组序，已加载的组都出现，窗口已到底时空组也出现（可以往里建行） */
export function sectionsOf(window: RowsWindow, schema: CollectionSchema, view: CollectionView): Section[] {
  const order = groupOrder(schema, view.groupBy)
  const prop = view.groupBy ? findProp(schema, view.groupBy) : undefined
  if (!prop || order.length === 0) return [{ key: null, rows: window.rows, count: window.total }]
  const buckets = new Map<string, CollectionRow[]>()
  for (const row of window.rows) {
    const key = groupKey(row, view.groupBy, schema)
    const list = buckets.get(key)
    if (list) list.push(row)
    else buckets.set(key, [row])
  }
  const complete = window.next === null
  const out: Section[] = []
  for (const key of order) {
    const rows = buckets.get(key) ?? []
    if (rows.length === 0 && !complete) continue
    const count = window.groups?.[key] ?? rows.length
    out.push({ key, ...(key ? { option: findOption(prop, key) } : {}), rows, count: Math.max(count, rows.length) })
  }
  return out
}

/** 插到 rows 里 targetId 的前面 / 后面（rows 里不含被拖的行）：落下后紧挨着它的两行。目标不在 = null。
 *  看板把卡片拖进别的列也用它（那一列里本来没有这张卡片） */
export function insertNeighbors(
  rows: readonly CollectionRow[],
  targetId: string,
  below: boolean,
): { after: string | null; before: string | null } | null {
  const t = rows.findIndex((r) => r.id === targetId)
  if (t < 0) return null
  const index = t + (below ? 1 : 0)
  return { after: rows[index - 1]?.id ?? null, before: rows[index]?.id ?? null }
}

/** 拖行落点 → 新邻居（after = 落下后在它前面的行，before = 在它后面的行）。没挪动 = null */
export function dropNeighbors(
  rows: readonly CollectionRow[],
  dragged: string,
  targetId: string,
  below: boolean,
): { after: string | null; before: string | null } | null {
  const from = rows.findIndex((r) => r.id === dragged)
  if (from < 0) return null
  const next = insertNeighbors(rows.filter((r) => r.id !== dragged), targetId, below)
  // 新邻居就是原来的邻居 = 没挪动
  if (!next || (next.after === (rows[from - 1]?.id ?? null) && next.before === (rows[from + 1]?.id ?? null))) return null
  return next
}

export type CellPos = { row: number; col: number }

/** 方向键 / Home / End 移动单元格光标（夹在表格范围内）；不是导航键 = null。
 *  jump（⌘ / Ctrl）：方向键直达那一侧的边，Home / End 直达首格 / 末格（同表格软件） */
export function moveCursor(cur: CellPos, key: string, rows: number, cols: number, jump = false): CellPos | null {
  const clamp = (n: number, max: number): number => Math.max(0, Math.min(n, max - 1))
  const lastRow = rows - 1
  const lastCol = cols - 1
  if (key === 'ArrowUp') return { row: jump ? 0 : clamp(cur.row - 1, rows), col: cur.col }
  if (key === 'ArrowDown') return { row: jump ? Math.max(0, lastRow) : clamp(cur.row + 1, rows), col: cur.col }
  if (key === 'ArrowLeft') return { row: cur.row, col: jump ? 0 : clamp(cur.col - 1, cols) }
  if (key === 'ArrowRight') return { row: cur.row, col: jump ? Math.max(0, lastCol) : clamp(cur.col + 1, cols) }
  if (key === 'Tab') return { row: cur.row, col: clamp(cur.col + 1, cols) }
  if (key === 'Home') return { row: jump ? 0 : cur.row, col: 0 }
  if (key === 'End') return { row: jump ? Math.max(0, lastRow) : cur.row, col: Math.max(0, lastCol) }
  return null
}
