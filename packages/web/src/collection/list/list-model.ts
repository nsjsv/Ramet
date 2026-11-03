// ---------- 列表视图的纯计算：看得见的行、拖行落点、段底新建带的分组值 ----------
// 分段直接用表格的 sectionsOf（窗口已按「组序 → 排序 → 手动顺序」排好）；拖行口径同表格：只能在同一段里拖，
// 落点换成前后邻居（table-model 的 dropNeighbors），落回原处什么都不发。
import type { CollectionRow, CollectionView } from '@ramet/shared/collection-model'
import type { RowSet } from '../collection-api'
import { dropNeighbors, type Section } from '../table/table-model'

/** 看得见的行（折叠的段不算）：Shift 连选按这个顺序 */
export function visibleRows(sections: readonly Section[], folded: ReadonlySet<string>): CollectionRow[] {
  return sections.flatMap((s) => (s.key !== null && folded.has(s.key) ? [] : s.rows))
}

/** 在这一段底部新建：带上这一段的分组值；不分组、无值段不带 */
export function newRowSet(view: CollectionView, section: Section): RowSet | undefined {
  return section.key && view.groupBy ? { [view.groupBy]: section.key } : undefined
}

/** 正在拖的行：哪一行、从哪一段来（null = 不分组） */
export type ListDrag = { id: string; section: string | null }

/** 拖到 section 里 targetId 的上 / 下半 → 新邻居。跨段 / 没挪动 = null */
export function listDrop(
  drag: ListDrag,
  section: Section,
  targetId: string,
  below: boolean,
): { after: string | null; before: string | null } | null {
  if (drag.section !== section.key) return null
  return dropNeighbors(section.rows, drag.id, targetId, below)
}
