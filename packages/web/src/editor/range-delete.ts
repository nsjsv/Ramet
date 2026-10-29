// ---------- 跨块文字选区的删除 ----------
// Backspace / Delete / 剪切都走 deleteAcrossBlocks（键位装配在 editing-keys.ts），收口两个问题：
// 1. 选区正好盖住几个整块（首块第一个字到末块最后一个字）时，PM 默认删空内容后会留下首块的壳
//    （空列表项、空标题、空引用等）。这里整块删掉，原地留一个空段落。
// 2. 选区跨过消息块（user_message / agent_reply）边界时，PM 默认会把两边剩下的内容并成一块，
//    AI 回复的后半截并进用户消息就坏了结构。与 messageDeleteKeymap 同一不变量：删除不穿消息块边界，
//    所以逐个顶层块删交集，不做跨块合并。
// 其余跨段删除（普通段落 / 列表之间）合并是对的，放行默认。

import { Fragment, type Node as PMNode, type ResolvedPos } from '@milkdown/kit/prose/model'
import { Selection, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

const MESSAGE = new Set(['user_message', 'agent_reply'])

/** pos 所在、但选区另一端不在里面的消息块：选区跨过了它的边界 */
function crossesMessage($a: ResolvedPos, other: number): boolean {
  for (let d = 1; d <= $a.depth; d++) {
    if (!MESSAGE.has($a.node(d).type.name)) continue
    if (other < $a.start(d) || other > $a.end(d)) return true
  }
  return false
}

/** 选区盖住共同容器里 [i, j] 这几个整块：起点是 i 块的第一个文字位、终点是 j 块的最后一个文字位 */
function wholeBlocks(state: EditorState): { from: number; to: number; container: PMNode; i: number; j: number } | null {
  const { $from, $to } = state.selection
  const depth = $from.sharedDepth($to.pos)
  const container = $from.node(depth)
  if (container.isTextblock) return null
  const i = $from.index(depth)
  const j = $to.index(depth)
  if (i === j) return null
  const from = $from.posAtIndex(i, depth)
  const to = $to.posAtIndex(j, depth) + container.child(j).nodeSize
  const first = Selection.findFrom(state.doc.resolve(from), 1, true)
  const last = Selection.findFrom(state.doc.resolve(to), -1, true)
  if (!first || !last || first.from !== $from.pos || last.to !== $to.pos) return null
  return { from, to, container, i, j }
}

/** 删除选区（不 dispatch）；不需要特殊处理时返回 null，调用方走默认 */
export function deleteAcrossBlocks(state: EditorState): Transaction | null {
  const sel = state.selection
  if (!(sel instanceof TextSelection) || sel.empty) return null
  const { $from, $to } = sel
  if ($from.sameParent($to)) return null
  const paragraph = state.schema.nodes.paragraph
  const whole = wholeBlocks(state)
  if (whole && paragraph && whole.container.canReplace(whole.i, whole.j + 1, Fragment.from(paragraph.create()))) {
    const tr = state.tr.replaceWith(whole.from, whole.to, paragraph.create())
    tr.setSelection(TextSelection.create(tr.doc, whole.from + 1))
    return tr.scrollIntoView()
  }
  if (!crossesMessage($from, $to.pos) && !crossesMessage($to, $from.pos)) return null
  // 逐个顶层块删交集（从后往前，前面的坐标不受影响）：整块落在选区里的删整块，其余只删块内那一段
  const tr = state.tr
  const spans: Array<{ start: number; end: number }> = []
  state.doc.forEach((node, offset) => {
    const end = offset + node.nodeSize
    if (end > $from.pos && offset < $to.pos) spans.push({ start: offset, end })
  })
  for (let k = spans.length - 1; k >= 0; k--) {
    const { start, end } = spans[k]!
    if ($from.pos <= start + 1 && $to.pos >= end - 1) tr.delete(start, end)
    else tr.delete(Math.max($from.pos, start + 1), Math.min($to.pos, end - 1))
  }
  if (!tr.doc.childCount && paragraph) tr.insert(0, paragraph.create())
  const at = Math.min(tr.mapping.map($from.pos, -1), tr.doc.content.size)
  const caret = Selection.findFrom(tr.doc.resolve(at), -1, true) ?? Selection.findFrom(tr.doc.resolve(at), 1, true)
  if (caret) tr.setSelection(caret)
  return tr.scrollIntoView()
}

export function deleteSelectionCommand(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const tr = deleteAcrossBlocks(state)
  if (!tr) return false
  if (dispatch) dispatch(tr)
  return true
}

/** 剪切：剪贴板内容照 PM 默认序列化，删除走同一个口径（editing-keys.ts 的 cut 处理器调） */
export function cutAcrossBlocks(view: EditorView, event: ClipboardEvent): boolean {
  const tr = deleteAcrossBlocks(view.state)
  if (!tr || !event.clipboardData) return false
  const { dom, text } = view.serializeForClipboard(view.state.selection.content())
  event.preventDefault()
  event.clipboardData.clearData()
  event.clipboardData.setData('text/html', dom.innerHTML)
  event.clipboardData.setData('text/plain', text)
  view.dispatch(tr.setMeta('uiEvent', 'cut'))
  return true
}
