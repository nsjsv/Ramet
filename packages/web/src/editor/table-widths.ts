/* ---------- 表格列宽的编码 ----------
 * 列宽存在表格节点的 `colwidths` attr：逗号分隔的像素整数（'120,80,200'），空串表示没调过（自动布局）。
 * 不用 prosemirror-tables 的 `colwidth`（每个格一个数组 attr），因为 Yjs 里的节点 attrs 必须是字符串。
 * 宽度个数与列数对不上（加 / 删了列而没同步宽度）时一律按没调过画，不画错位的宽度。 */

export const MIN_COL_WIDTH = 48

export function parseColWidths(raw: unknown): number[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  const out = raw.split(',').map((x) => Math.round(Number(x)))
  return out.every((w) => Number.isFinite(w) && w > 0) ? out : []
}

export function formatColWidths(widths: number[]): string {
  return widths.map((w) => Math.max(MIN_COL_WIDTH, Math.round(w))).join(',')
}

/** 能用的列宽，个数与列数一致才算 */
export function usableWidths(raw: unknown, columns: number): number[] {
  const widths = parseColWidths(raw)
  return widths.length === columns && columns > 0 ? widths : []
}

/** 画出来的各列宽（量 nodeView 的 tbody 里表头行的格）：拖列宽的起点，也用于没调过列宽的表格加列时定下现宽（table-ops 的 growCols / addCol） */
export function measureColWidths(tbody: Element): number[] {
  return [...(tbody.firstElementChild?.children ?? [])].map((cell) => cell.getBoundingClientRect().width)
}
