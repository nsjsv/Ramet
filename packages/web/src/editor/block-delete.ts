// ---------- 删块（块菜单「删除」、块选区删除、对话气泡删除、消息块空块删除共用） ----------
// 独立成模块：块选键位、块操作、消息块 keymap 都要用它，放在 block-menu.ts 里会成环。

import { TextSelection } from '@milkdown/kit/prose/state'
import type { Node as ProsemirrorNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'

type Snapshot = { pos: number; node: ProsemirrorNode }

/** 删除：光标落到相邻可编辑位置（先向前，即退格语义，不行再向后）；删空文档补一个空段落
 * 保住 doc(block+) 合法（collab / 快照不炸）。
 * list_item 感知（同 list-drag moveListItem 删源规则）：父 list 只剩本条目时连壳删
 * （resolve(li 起点) 停在 list 层，$snap.parent 即父 list），否则只删条目本身。
 * 容器（AI 回复、分栏的栏、提示框、折叠块等，`block+`）里唯一的子块换成空段落：容器留着（AI 回复不连带删掉过程页）。 */
export function runDelete(view: EditorView, snap: Snapshot, cur: ProsemirrorNode): void {
  let from = snap.pos
  let to = snap.pos + cur.nodeSize
  const $snap = view.state.doc.resolve(snap.pos)
  if (cur.type.name === 'list_item') {
    if ($snap.parent.childCount === 1) {
      from = $snap.before($snap.depth)
      to = from + $snap.parent.nodeSize
    }
  }
  const paragraph = view.state.schema.nodes.paragraph
  const container = $snap.depth > 0 && $snap.parent.childCount === 1 && cur.type.name !== 'list_item'
  const tr = container && paragraph ? view.state.tr.replaceWith(from, to, paragraph.create()) : view.state.tr.delete(from, to)
  if (!tr.doc.childCount) {
    // 连壳删时 snap.pos（li 起点）已越过删空后的 doc 末尾，补段落恒插在 0
    if (paragraph) tr.insert(0, paragraph.create())
  }
  const $pos = tr.doc.resolve(Math.min(snap.pos, tr.doc.content.size)) // 钳回合法区间
  const caret = (TextSelection.findFrom($pos, -1, true) ?? TextSelection.findFrom($pos, 1, true)) as
    | TextSelection
    | null
  if (caret) tr.setSelection(caret)
  view.dispatch(tr)
  view.focus()
}

/** 块选区删除（Backspace / Delete 与菜单「删除」共用）。from / to 是块选区 [起点, 终点)：
 * - 单节点选区（手柄点选，含下钻的 list_item）交给 runDelete（li 连壳删、空文档补段落、光标吸附）；
 * - 跨块选区（gutter 框选 / Shift 扩选，两端恒为顶层块边界）整段删。
 * 返回是否真的删了内容，未删则调用方不要吞掉按键。 */
export function deleteBlockRange(view: EditorView, from: number, to: number): boolean {
  const doc = view.state.doc
  if (from < 0 || to <= from || to > doc.content.size) return false
  const single = doc.nodeAt(from)
  if (single && from + single.nodeSize === to) {
    runDelete(view, { pos: from, node: single }, single)
    return true
  }
  const tr = view.state.tr.delete(from, to)
  if (!tr.doc.childCount) {
    const paragraph = view.state.schema.nodes.paragraph
    if (paragraph) tr.insert(0, paragraph.create()) // doc(block+) 不能空（collab / 快照不炸）
  }
  const $pos = tr.doc.resolve(Math.min(from, tr.doc.content.size)) // 钳回合法区间
  const caret = (TextSelection.findFrom($pos, -1, true) ?? TextSelection.findFrom($pos, 1, true)) as
    | TextSelection
    | null
  if (caret) tr.setSelection(caret)
  view.dispatch(tr)
  view.focus()
  return true
}

