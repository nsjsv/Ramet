/* ---------- 表格操作 ----------
 * 表格菜单（table-view.ts）和斜杠「表格」都调这里的纯命令（(state, dispatch) 形状，单事务可撤销）。
 * 形状约束来自 gfm 预设：table = table_header_row + table_row+，表头行恒为第 0 行、格是 table_header，
 * 正文行的格是 table_cell，格里恰一个段落。所以表头行不能删、不能被移走、上方不能再插行；只剩一行正文不能删；
 * 只剩一列不能删。列宽（colwidths，table-widths.ts）随加 / 删 / 移列同一事务调整，个数始终与列数一致。
 * 行列底层用 prosemirror-tables（selectedRect / moveTableRow / moveTableColumn / addColumn* / deleteColumn）。 */

import type { Node as PMNode, Schema } from '@milkdown/kit/prose/model'
import { TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import {
  addColumn,
  addColumnAfter,
  addColumnBefore,
  deleteColumn,
  deleteTable,
  isInTable,
  moveTableColumn,
  moveTableRow,
  removeColumn,
  selectedRect,
  TableMap,
  type TableRect,
} from '@milkdown/kit/prose/tables'
import type { EditorView } from '@milkdown/kit/prose/view'
import { formatColWidths, parseColWidths } from './table-widths'

type Dispatch = (tr: Transaction) => void
type Command = (state: EditorState, dispatch?: Dispatch) => boolean
type Align = 'left' | 'center' | 'right'

/** 新列默认宽度（表格调过列宽时，新加的列用它） */
export const NEW_COL_WIDTH = 120

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

/** rows 行（含表头）× cols 列的空表格 */
export function tableNode(schema: Schema, rows = 3, cols = 3): PMNode {
  const n = schema.nodes
  const cell = (name: string): PMNode => n[name]!.create(null, n.paragraph!.create())
  const header = n.table_header_row!.create(null, range(cols).map(() => cell('table_header')))
  const body = range(Math.max(rows - 1, 1)).map(() => n.table_row!.create(null, range(cols).map(() => cell('table_cell'))))
  return n.table!.create(null, [header, ...body])
}

/** 斜杠「表格」：光标所在段落是空的就换掉它，否则插在它后面；光标落进第一个表头格 */
export function insertTable(view: EditorView, rows = 3, cols = 3): void {
  const { state } = view
  const { $from } = state.selection
  const table = tableNode(state.schema, rows, cols)
  const block = $from.parent
  const tr = state.tr
  let at: number
  if (block.type.name === 'paragraph' && block.content.size === 0 && $from.depth >= 1) {
    at = $from.before()
    tr.replaceWith(at, $from.after(), table)
  } else {
    at = $from.depth >= 1 ? $from.after() : state.selection.to
    tr.insert(at, table)
  }
  const caret = TextSelection.findFrom(tr.doc.resolve(at + 1), 1, true)
  if (caret) tr.setSelection(caret)
  view.dispatch(tr.scrollIntoView())
  view.focus()
}

export type TableInfo = { rect: TableRect; row: number; col: number; rows: number; cols: number; tablePos: number }

export function tableInfo(state: EditorState): TableInfo | null {
  if (!isInTable(state)) return null
  const rect = selectedRect(state)
  return { rect, row: rect.top, col: rect.left, rows: rect.map.height, cols: rect.map.width, tablePos: rect.tableStart - 1 }
}

export type TableAvailability = Record<
  'rowAbove' | 'rowBelow' | 'rowUp' | 'rowDown' | 'rowDelete' | 'colLeft' | 'colRight' | 'colMoveLeft' | 'colMoveRight' | 'colDelete',
  boolean
>

export function availability(info: TableInfo): TableAvailability {
  const body = info.row >= 1
  return {
    rowAbove: body,
    rowBelow: true,
    rowUp: info.row > 1,
    rowDown: body && info.row < info.rows - 1,
    rowDelete: body && info.rows > 2,
    colLeft: true,
    colRight: true,
    colMoveLeft: info.col > 0,
    colMoveRight: info.col < info.cols - 1,
    colDelete: info.cols > 1,
  }
}

/** 在第 index 行（≥ 1，表头之后）插入一行正文；各格对齐抄表头同列 */
function insertBodyRow(tr: Transaction, rect: TableRect, index: number): void {
  const schema = tr.doc.type.schema
  let pos = rect.tableStart
  for (let i = 0; i < index; i++) pos += rect.table.child(i).nodeSize
  const cells = range(rect.map.width).map((col) => {
    const head = rect.table.nodeAt(rect.map.map[col]!)
    return schema.nodes.table_cell!.createAndFill({ alignment: head?.attrs.alignment ?? 'left' })!
  })
  tr.insert(pos, schema.nodes.table_row!.create(null, cells))
}

export function addRow(where: 'above' | 'below'): Command {
  return (state, dispatch) => {
    const info = tableInfo(state)
    if (!info) return false
    const ok = where === 'above' ? availability(info).rowAbove : availability(info).rowBelow
    if (!ok) return false
    if (dispatch) {
      const tr = state.tr
      insertBodyRow(tr, info.rect, where === 'above' ? info.row : info.row + 1)
      dispatch(tr.scrollIntoView())
    }
    return true
  }
}

export function moveRow(dir: 1 | -1): Command {
  return (state, dispatch) => {
    const info = tableInfo(state)
    if (!info || !availability(info)[dir === -1 ? 'rowUp' : 'rowDown']) return false
    return moveTableRow({ from: info.row, to: info.row + dir, select: false, pos: state.selection.from })(state, dispatch)
  }
}

/** 删当前正文行：光标落到相邻行同一列 */
export const deleteRow: Command = (state, dispatch) => {
  const info = tableInfo(state)
  if (!info || !availability(info).rowDelete) return false
  if (dispatch) {
    const { rect } = info
    let pos = rect.tableStart
    for (let i = 0; i < info.row; i++) pos += rect.table.child(i).nodeSize
    const row = rect.table.child(info.row)
    const tr = state.tr.delete(pos, pos + row.nodeSize)
    const caret = TextSelection.findFrom(tr.doc.resolve(Math.min(pos, tr.doc.content.size)), info.row < info.rows - 1 ? 1 : -1, true)
    if (caret) tr.setSelection(caret)
    dispatch(tr.scrollIntoView())
  }
  return true
}

/* ---------- 末尾增减（表格底部 / 右侧的「+」条，table-grow.ts） ----------
 * 不看选区（点条不进表格），按表格位置定位；一次拖动一个事务，一步撤销。
 * 往回收只删末尾连续的空行 / 列（格里只有空段落，图片等行内原子算内容），有内容的不删；
 * 至少留一行正文、一列。 */

function rectAt(doc: PMNode, tablePos: number): TableRect | null {
  const table = doc.nodeAt(tablePos)
  if (table?.type.name !== 'table') return null
  const map = TableMap.get(table)
  return { map, table, tableStart: tablePos + 1, left: 0, top: 0, right: map.width, bottom: map.height }
}

function isEmptyCell(cell: PMNode): boolean {
  let empty = true
  cell.forEach((child) => {
    if (!child.isTextblock || child.content.size > 0) empty = false
  })
  return empty
}

/** 末尾能收掉的空正文行数（第 1 行正文要留着） */
export function shrinkableRows(table: PMNode): number {
  let k = 0
  for (let i = table.childCount - 1; i >= 2; i--) {
    let empty = true
    table.child(i).forEach((cell) => {
      if (!isEmptyCell(cell)) empty = false
    })
    if (!empty) break
    k += 1
  }
  return k
}

/** 末尾能收掉的空列数（整列连表头格都空才算；第 0 列要留着） */
export function shrinkableCols(table: PMNode): number {
  const map = TableMap.get(table)
  let k = 0
  for (let col = map.width - 1; col >= 1; col--) {
    const empty = range(map.height).every((row) => {
      const cell = table.nodeAt(map.map[row * map.width + col]!)
      return !!cell && isEmptyCell(cell)
    })
    if (!empty) break
    k += 1
  }
  return k
}

/** delta > 0 末尾加 delta 行正文（格抄表头同列对齐）；delta < 0 收掉末尾 -delta 个空行，超出 shrinkableRows 不执行 */
export function growRows(tablePos: number, delta: number): Command {
  return (state, dispatch) => {
    const rect = rectAt(state.doc, tablePos)
    if (!rect || delta === 0 || -delta > shrinkableRows(rect.table)) return false
    if (dispatch) {
      const tr = state.tr
      if (delta > 0) {
        for (let i = 0; i < delta; i++) {
          const now = rectAt(tr.doc, tablePos)!
          insertBodyRow(tr, now, now.map.height)
        }
      } else {
        let from = rect.tableStart
        for (let i = 0; i < rect.table.childCount + delta; i++) from += rect.table.child(i).nodeSize
        tr.delete(from, rect.tableStart + rect.table.content.size)
      }
      dispatch(tr)
    }
    return true
  }
}

/**
 * 同 growRows，按列。新列的格类型抄左邻（表头行是 table_header）；调过列宽的表补 / 删对应宽度。
 * measured 是 nodeView 量出的各列现宽（table-widths 的 measureColWidths），没调过列宽的表格加列时拿它当底，见 baseWidths。
 */
export function growCols(tablePos: number, delta: number, measured: number[] = []): Command {
  return (state, dispatch) => {
    const start = rectAt(state.doc, tablePos)
    if (!start || delta === 0 || -delta > shrinkableCols(start.table)) return false
    if (dispatch) {
      const tr = state.tr
      if (delta > 0) {
        // addColumn 按原文档的 rect 算位置、自己经 tr.mapping 映射：每次都传起始 rect，同一处插入依次排在后面
        for (let i = 0; i < delta; i++) addColumn(tr, start, start.map.width)
      } else {
        // removeColumn 只映射它自己这一步：每次按当前文档重算 rect
        for (let i = 0; i < -delta; i++) {
          const now = rectAt(tr.doc, tablePos)!
          removeColumn(tr, now, now.map.width - 1)
        }
      }
      const widths = baseWidths(start.table, start.map.width, delta > 0 ? measured : [])
      const table = tr.doc.nodeAt(tablePos)
      if (widths && table) {
        const next = delta > 0 ? [...widths, ...range(delta).map(() => NEW_COL_WIDTH)] : widths.slice(0, delta)
        tr.setNodeMarkup(tablePos, undefined, { ...table.attrs, colwidths: formatColWidths(next) })
      }
      dispatch(tr)
    }
    return true
  }
}

/** 改列宽串的底：调过列宽用存的；没调过（自动布局、宽 100%）但带了量出的现宽就用现宽，
 * 否则加列时新列只能从原有各列里挤宽度，整表一起缩，缩到每格最小宽才开始横向滚动。都没有就不写宽度 */
function baseWidths(table: PMNode, cols: number, measured: number[] = []): number[] | null {
  const widths = parseColWidths(table.attrs.colwidths)
  if (widths.length === cols) return widths
  return measured.length === cols ? measured : null
}

/** 跑一个表格命令，再在同一个事务里改列宽串（个数与列数保持一致） */
function withWidths(command: Command, edit: (widths: number[], info: TableInfo) => number[] | null, measured?: number[]): Command {
  return (state, dispatch) => {
    const info = tableInfo(state)
    if (!info) return false
    let out: Transaction | null = null
    if (!command(state, (tr) => (out = tr))) return false
    if (!dispatch || !out) return true
    const tr: Transaction = out
    const widths = baseWidths(info.rect.table, info.cols, measured)
    const next = widths ? edit(widths, info) : null
    const table = tr.doc.nodeAt(tr.mapping.map(info.tablePos))
    if (next && table?.type.name === 'table') {
      tr.setNodeMarkup(tr.mapping.map(info.tablePos), undefined, { ...table.attrs, colwidths: formatColWidths(next) })
    }
    dispatch(tr.scrollIntoView())
    return true
  }
}

/** measured 同 growCols */
export function addCol(where: 'left' | 'right', measured?: number[]): Command {
  return withWidths(
    where === 'left' ? addColumnBefore : addColumnAfter,
    (widths, info) => {
      const at = where === 'left' ? info.col : info.col + 1
      return [...widths.slice(0, at), NEW_COL_WIDTH, ...widths.slice(at)]
    },
    measured,
  )
}

export function moveCol(dir: 1 | -1): Command {
  const move: Command = (state, dispatch) => {
    const info = tableInfo(state)
    if (!info || !availability(info)[dir === -1 ? 'colMoveLeft' : 'colMoveRight']) return false
    return moveTableColumn({ from: info.col, to: info.col + dir, select: false, pos: state.selection.from })(state, dispatch)
  }
  return withWidths(move, (widths, info) => {
    const next = [...widths]
    const [w] = next.splice(info.col, 1)
    next.splice(info.col + dir, 0, w!)
    return next
  })
}

export const deleteCol: Command = (state, dispatch) => {
  const info = tableInfo(state)
  if (!info || !availability(info).colDelete) return false
  return withWidths(deleteColumn, (widths) => widths.filter((_, i) => i !== info.col))(state, dispatch)
}

/** 整列对齐（markdown 的对齐本来就是按列的） */
export function alignColumn(align: Align): Command {
  return (state, dispatch) => {
    const info = tableInfo(state)
    if (!info) return false
    if (dispatch) {
      const tr = state.tr
      for (let row = 0; row < info.rows; row++) {
        const pos = info.rect.tableStart + info.rect.map.map[row * info.cols + info.col]!
        const cell = tr.doc.nodeAt(pos)
        if (cell && cell.attrs.alignment !== align) tr.setNodeMarkup(pos, undefined, { ...cell.attrs, alignment: align })
      }
      dispatch(tr)
    }
    return true
  }
}

export const removeTable: Command = (state, dispatch) => (isInTable(state) ? deleteTable(state, dispatch) : false)

/** 当前格所在列的对齐（菜单打勾用） */
export function columnAlign(state: EditorState): Align | null {
  const info = tableInfo(state)
  if (!info) return null
  const cell = info.rect.table.nodeAt(info.rect.map.map[info.row * info.cols + info.col]!)
  const align: unknown = cell?.attrs.alignment
  return align === 'center' || align === 'right' ? align : 'left'
}
