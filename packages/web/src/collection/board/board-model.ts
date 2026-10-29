// ---------- 看板视图的纯计算：列、卡片显示的属性、拖放落点 ----------
// 列 = 分组属性的组序：'' =「无值」在最前（状态有选项时没有这一列，空值读成缺省选项），其余按选项顺序，与表格分段同序
// （见 @ramet/shared/collection-query 的 groupOrder）。每列是一个按组取的窗口，列里的卡片已按「排序 → 手动顺序」排好。
// 落点：跨列改分组属性的值；无排序时再带上落点的邻居（口径同表格拖行，table-model 的 dropNeighbors / insertNeighbors）；
// 有排序时列内不能拖、跨列只改值；落回原处什么都不发。
import {
  findOption,
  findProp,
  rowValue,
  TITLE_PROP_ID,
  type CollectionOption,
  type CollectionProp,
  type CollectionRow,
  type CollectionSchema,
  type CollectionView,
} from '@ramet/shared/collection-model'
import { groupOrder } from '@ramet/shared/collection-query'
import type { RowSet } from '../collection-api'
import { shownProps } from '../schema-ops'
import { dropNeighbors, insertNeighbors } from '../table/table-model'

export type BoardColumnDef = { key: string; option?: CollectionOption }

/** 看板的分组属性与列；不能分列（没分组，或分组属性已不是状态 / 单选）= null */
export function boardColumns(schema: CollectionSchema, view: CollectionView): { prop: CollectionProp; columns: BoardColumnDef[] } | null {
  const prop = view.groupBy ? findProp(schema, view.groupBy) : undefined
  const order = groupOrder(schema, view.groupBy)
  if (!prop || order.length === 0) return null
  const columns = order.map((key): BoardColumnDef => {
    const option = key ? findOption(prop, key) : undefined
    return option ? { key, option } : { key }
  })
  return { prop, columns }
}

/** 卡片上显示的属性：视图的显示顺序，去掉恒显示的「名称」和分组属性本身（列已经说明了） */
export function cardProps(schema: CollectionSchema, view: CollectionView): CollectionProp[] {
  const out: CollectionProp[] = []
  for (const id of shownProps(schema, view)) {
    const prop = findProp(schema, id)
    if (prop && prop.id !== TITLE_PROP_ID && prop.id !== view.groupBy) out.push(prop)
  }
  return out
}

/** 卡片上这一格有没有可画的值（空值不画：空、没勾、空列表） */
export function hasValue(row: CollectionRow, prop: CollectionProp): boolean {
  const value = rowValue(row, prop)
  if (value === undefined || value === false || value === '') return false
  return !Array.isArray(value) || value.length > 0
}

/** 正在拖的卡片：哪一行、从哪一列来 */
export type BoardDrag = { rowId: string; from: string }
/** 落点：哪一列、落在哪张卡片的前 / 后；targetId = null = 列的空白处（插在已加载的末尾） */
export type BoardDropAt = { key: string; targetId: string | null; below: boolean }
/** 落下后要做的写：set = 改分组属性（null = 不改），neighbors = 新的前后邻居（null = 不挪手动顺序） */
export type BoardDropPlan = { set: RowSet | null; neighbors: { after: string | null; before: string | null } | null }

/** 这一列能不能接住正在拖的卡片：有排序时列内不能拖（手动顺序只在没有排序时生效） */
export function canDrop(view: CollectionView, drag: BoardDrag, key: string): boolean {
  return drag.from !== key || view.sorts.length === 0
}

/** 落点 → 写什么。rows = 目标列已加载的卡片（按显示顺序）。什么都不用做 = null */
export function dropPlan(view: CollectionView, drag: BoardDrag, at: BoardDropAt, rows: readonly CollectionRow[]): BoardDropPlan | null {
  if (!canDrop(view, drag, at.key)) return null
  const cross = drag.from !== at.key
  const set: RowSet | null = cross && view.groupBy ? { [view.groupBy]: at.key || null } : null
  if (view.sorts.length > 0) return set ? { set, neighbors: null } : null
  const others = rows.filter((r) => r.id !== drag.rowId)
  // 空白处 = 接在已加载的最后一张后面；列没取完时服务端按全局手动顺序补上真正的下一张
  const target = at.targetId ?? others.at(-1)?.id ?? null
  const below = at.targetId === null ? true : at.below
  const neighbors = target === null ? null : cross ? insertNeighbors(others, target, below) : dropNeighbors(rows, drag.rowId, target, below)
  if (!set && !neighbors) return null
  return { set, neighbors }
}
