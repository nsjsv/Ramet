/* ---------- 斜杠菜单在光标处插一个顶层原子块（子页面块、集合块共用同一条落点规则） ----------
 * 光标在空段落里就整段替换成该块，否则插到当前块之后（块级插入，不切开文字）。
 * 光标在列表条目内（任意深度）时插到所在顶层列表块之后：这类块是顶层块，插进条目内容会变成条目里的子块，
 * 没有手柄粒度、拖不出去。
 * 光标落到块后；文档末尾没有可落点的文本块时补一个空段落承接（同官方 insertHr）。 */
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

/** 插入、派发并把焦点还给编辑器 */
export function insertBlockAtCursor(view: EditorView, node: PMNode): void {
  const paragraph = view.state.schema.nodes.paragraph
  const { $from } = view.state.selection
  const inListItem = $from.node(1)?.type.name === 'bullet_list' || $from.node(1)?.type.name === 'ordered_list'
  const emptyParagraph = $from.parent.type.name === 'paragraph' && $from.parent.content.size === 0
  let from: number
  let to: number
  if (inListItem) {
    const blockStart = $from.before(1)
    from = blockStart + view.state.doc.nodeAt(blockStart)!.nodeSize
    to = from
  } else if (emptyParagraph) {
    from = $from.before()
    to = $from.after()
  } else {
    from = $from.after()
    to = from
  }
  const tr = view.state.tr.replaceWith(from, to, node)
  const after = from + node.nodeSize
  let caret = TextSelection.findFrom(tr.doc.resolve(after), 1, true)
  if (!caret && paragraph) {
    tr.insert(after, paragraph.create())
    caret = TextSelection.findFrom(tr.doc.resolve(after), 1, true)
  }
  if (caret) tr.setSelection(caret)
  view.dispatch(tr)
  view.focus()
}
