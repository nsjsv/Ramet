/* ---------- 表格键盘流：末格 Tab 自动加行（Typora 式） ----------
 * gfm preset 的 tableKeymap 已绑 Tab / Mod-] 跳格（goToNextCell），但末格 Tab 什么也不做。
 * 这里只拦末行末格的 Tab：加一行并把光标放进新行首格；其余 Tab 返回 false 放行给 gfm。
 * 单事务，一步撤销。 */
import { addRow, selectedRect } from '@milkdown/kit/prose/tables'
import { keymap } from '@milkdown/kit/prose/keymap'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { TableRect } from '@milkdown/kit/prose/tables'
import { $prose } from '@milkdown/kit/utils'

/** 光标所在格是否全表最后一格（末行末格），不在表格里返回 false */
function inLastCell(state: EditorState): boolean {
  const $from = state.selection.$from
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'table_cell' || $from.node(d).type.name === 'table_header') {
      const row = $from.node(d - 1)
      const table = $from.node(d - 2)
      return row === table.lastChild && $from.node(d) === row.lastChild
    }
  }
  return false
}

function tabAtLastCell(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  if (!inLastCell(state)) return false
  let rect: TableRect
  try {
    rect = selectedRect(state)
  } catch {
    return false // 选区形态 selectedRect 拿不到（异常选区）：放行默认
  }
  if (dispatch) {
    const tr = state.tr
    addRow(tr, rect, rect.bottom)
    // 新行追加在原表格内容之后：首格内容位 = tableStart + 原内容宽 + 行开 + 格开 + 段开
    const caret = TextSelection.near(tr.doc.resolve(rect.tableStart + rect.table.content.size + 3), 1)
    tr.setSelection(caret)
    dispatch(tr.scrollIntoView())
  }
  return true
}

export const tableTabKeymap = $prose(() => keymap({ Tab: tabAtLastCell }))
