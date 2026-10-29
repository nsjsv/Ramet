/* ---------- 块选区上的动作 ----------
 * 块选区（block-select-key.ts）上的整块操作，键位在 block-keys.ts 分派：
 *   选择：Esc 选中光标所在块；↑↓ 换块（文档序，有子块先进子块）；Shift+↑↓ 按顶层块扩缩；Enter 回到块末编辑。
 *   剪贴板：复制 / 剪切整段块的 slice；块选状态下粘贴用剪贴板内容替换这几块。
 *   复制副本（Mod-D）、上下移动（Mod-Shift-↑↓）、列表批量缩进 / 反缩进（Tab / Shift-Tab）。
 *   拖拽：手柄拖起的块落在多块选区里时整段一起搬（rangeDrag 登记，handleDrop 接管）。
 * 没有块选时 Mod-D / Mod-Shift-↑↓ 作用于光标所在块（与块选单块同一实现）。
 * 光标所在块是最近的可寻址块（手柄能指到的那一块），顶层单条目列表的条目按整个列表块搬 / 复制。 */

import { Fragment, type Slice, type Node as PMNode } from '@milkdown/kit/prose/model'
import { Selection, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { liftListItem } from '@milkdown/kit/prose/schema-list'
import { dropPoint } from '@milkdown/kit/prose/transform'
import type { EditorView } from '@milkdown/kit/prose/view'
import { isAddressable } from '@ramet/shared/block-address'
import { blockSelectKey, CLEAR_BLOCK_SELECT, type BlockSelectState } from './block-select-key'
import { findBlockIdPos } from './block-id'
import { deleteBlockRange } from './block-delete'
import { indentItems } from './list-indent'
import { inlineAsLinks } from './collection-block'
import { isListNode } from './list-ops'

export type Range = { from: number; to: number }

export function activeRange(state: EditorState): (BlockSelectState & Range) | null {
  const sel = blockSelectKey.getState(state)
  return sel && sel.active && sel.from < sel.to ? sel : null
}

/** 文档序里能被块选的节点（同手柄能指到的集合；列表壳跳过，用它的条目） */
export function selectableBlocks(doc: PMNode): Array<{ pos: number; node: PMNode }> {
  const out: Array<{ pos: number; node: PMNode }> = []
  doc.descendants((node, pos, parent) => {
    if (!node.isBlock) return false
    const parentName = !parent || parent === doc ? null : parent.type.name
    if (!isListNode(node) && isAddressable(node.type.name, parentName)) out.push({ pos, node })
    return !node.isTextblock && !node.isAtom
  })
  return out
}

/** pos 所在的最近可寻址块的范围；顶层（容器直属）单条目列表的条目取整个列表块（搬 / 复制按块走） */
export function unitAt(doc: PMNode, pos: number): Range | null {
  const $pos = doc.resolve(pos)
  for (let d = $pos.depth; d >= 1; d--) {
    const node = $pos.node(d)
    if (!isAddressable(node.type.name, d === 1 ? null : $pos.node(d - 1).type.name) || isListNode(node)) continue
    const from = $pos.before(d)
    return { from, to: from + node.nodeSize }
  }
  return null
}

function expandSoleItem(doc: PMNode, range: Range): Range {
  const node = doc.nodeAt(range.from)
  if (node?.type.name !== 'list_item' || range.from + node.nodeSize !== range.to) return range
  const $pos = doc.resolve(range.from)
  if ($pos.parent.childCount !== 1) return range
  const listStart = $pos.before($pos.depth)
  return { from: listStart, to: listStart + $pos.parent.nodeSize }
}

/** 顶层块的 [起点, 终点) 列表 */
function topSpans(doc: PMNode): Range[] {
  const out: Range[] = []
  doc.forEach((node, offset) => out.push({ from: offset, to: offset + node.nodeSize }))
  return out
}

/* ---------- 选择 ---------- */

/** Esc：选中光标所在块（手柄口径：顶层列表选到条目） */
export function selectBlockAtCursor(state: EditorState): BlockSelectState | null {
  const $pos = state.selection.$from
  for (let d = $pos.depth; d >= 1; d--) {
    const node = $pos.node(d)
    if (isListNode(node) || !isAddressable(node.type.name, d === 1 ? null : $pos.node(d - 1).type.name)) continue
    const from = $pos.before(d)
    return { active: true, from, to: from + node.nodeSize }
  }
  return null
}

/** ↑↓：单块选区按文档序走（有子块先进子块）；多块选区从两端出去 */
export function stepBlockSelection(state: EditorState, dir: 1 | -1): BlockSelectState | null {
  const sel = activeRange(state)
  if (!sel) return null
  const blocks = selectableBlocks(state.doc)
  const node = state.doc.nodeAt(sel.from)
  const single = !!node && sel.from + node.nodeSize === sel.to
  const target =
    dir === 1
      ? blocks.find((b) => (single ? b.pos > sel.from : b.pos >= sel.to))
      : [...blocks].reverse().find((b) => b.pos < sel.from)
  if (!target) return { ...sel }
  return { active: true, from: target.pos, to: target.pos + target.node.nodeSize }
}

/** Shift+↑↓：按顶层块扩缩，head 端移动；越过锚点时换向 */
export function extendBlockSelection(state: EditorState, dir: 1 | -1): BlockSelectState | null {
  const sel = activeRange(state)
  if (!sel) return null
  const spans = topSpans(state.doc)
  const first = spans.findIndex((s) => sel.from >= s.from && sel.from < s.to)
  const last = spans.findIndex((s) => sel.to - 1 >= s.from && sel.to - 1 < s.to)
  if (first < 0 || last < 0) return null
  let a = first
  let b = last
  let head = sel.head ?? (dir === 1 ? 'end' : 'start')
  if (a === b) head = dir === 1 ? 'end' : 'start'
  if (head === 'end') {
    if (dir === 1) b = Math.min(b + 1, spans.length - 1)
    else b -= 1
  } else if (dir === -1) a = Math.max(a - 1, 0)
  else a += 1
  if (a > b) [a, b] = [b, a]
  return { active: true, from: spans[a]!.from, to: spans[b]!.to, head }
}

/** Enter：光标落到块里最后一个文字位，退出块选 */
export function enterBlock(state: EditorState): Transaction | null {
  const sel = activeRange(state)
  if (!sel) return null
  const end = Selection.findFrom(state.doc.resolve(sel.to), -1, true)
  const caret = end && end.from >= sel.from ? end : Selection.findFrom(state.doc.resolve(sel.from), 1, true)
  if (!caret) return null
  return state.tr.setSelection(caret).setMeta(blockSelectKey, CLEAR_BLOCK_SELECT).scrollIntoView()
}

/* ---------- 剪贴板 ---------- */

export function copyBlocks(view: EditorView, event: ClipboardEvent, cut: boolean): boolean {
  const sel = activeRange(view.state)
  if (!sel || !event.clipboardData) return false
  const slice = view.state.doc.slice(sel.from, sel.to)
  const { dom, text } = view.serializeForClipboard(slice)
  event.preventDefault()
  event.clipboardData.clearData()
  event.clipboardData.setData('text/html', dom.innerHTML)
  event.clipboardData.setData('text/plain', text)
  if (cut && view.editable) deleteBlockRange(view, sel.from, sel.to)
  return true
}

/** 块选状态下粘贴：先把这几块换成一个空段落（光标进去），再交给 PM 的粘贴把内容放进来；
 *  容器放不下段落（如选的是嵌套列表项）就直接删掉这几块，粘到删除后的光标处 */
export function prepareBlockPaste(view: EditorView): void {
  const sel = activeRange(view.state)
  if (!sel || !view.editable) return
  const doc = view.state.doc
  const paragraph = view.state.schema.nodes.paragraph
  const $from = doc.resolve(sel.from)
  const $to = doc.resolve(sel.to)
  if (paragraph && $from.parent === $to.parent && $from.parent.canReplace($from.index(), $to.index(), Fragment.from(paragraph.create()))) {
    const tr = view.state.tr.replaceWith(sel.from, sel.to, paragraph.create())
    tr.setSelection(TextSelection.create(tr.doc, sel.from + 1)).setMeta(blockSelectKey, CLEAR_BLOCK_SELECT)
    view.dispatch(tr)
    return
  }
  deleteBlockRange(view, sel.from, sel.to)
}

/* ---------- 副本 / 移动 ---------- */

/** 当前要操作的范围：块选区，或光标所在块 */
function workingRange(state: EditorState): { range: Range; block: boolean } | null {
  const sel = activeRange(state)
  if (sel) return { range: expandSoleItem(state.doc, sel), block: true }
  const unit = unitAt(state.doc, state.selection.from)
  return unit ? { range: expandSoleItem(state.doc, unit), block: false } : null
}

export function duplicateBlocks(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const hit = workingRange(state)
  if (!hit) return false
  if (!dispatch) return true
  const { from, to } = hit.range
  // 集合块的副本是链接视图，复制不产生新的所有者（collection-block.ts）；节点个数与大小不变，下面的选区算法照旧
  const content = inlineAsLinks(state.doc.slice(from, to).content, state.schema)
  const tr = state.tr.insert(to, content) // 副本的块 id 与原块重复，补 id 插件按先到者保留给副本换新
  const size = to - from
  if (hit.block) tr.setMeta(blockSelectKey, { active: true, from: to, to: to + size })
  else tr.setSelection(TextSelection.create(tr.doc, state.selection.anchor + size, state.selection.head + size))
  dispatch(tr.scrollIntoView())
  return true
}

export function moveBlocks(dir: 1 | -1) {
  return (state: EditorState, dispatch?: (tr: Transaction) => void): boolean => {
    const hit = workingRange(state)
    if (!hit) return false
    const { from, to } = hit.range
    const $from = state.doc.resolve(from)
    const $to = state.doc.resolve(to)
    if ($from.depth !== $to.depth || $from.parent !== $to.parent) return true
    const other = dir === -1 ? $from.nodeBefore : $to.nodeAfter
    if (!other) return true // 已到容器顶 / 底，吞键不动
    if (!dispatch) return true
    const tr = state.tr
    const delta = dir === -1 ? -other.nodeSize : other.nodeSize
    if (dir === -1) {
      tr.delete(from - other.nodeSize, from)
      tr.insert(to - other.nodeSize, other)
    } else {
      tr.delete(to, to + other.nodeSize)
      tr.insert(from, other)
    }
    if (hit.block) tr.setMeta(blockSelectKey, { ...activeRange(state)!, from: from + delta, to: to + delta })
    else tr.setSelection(TextSelection.create(tr.doc, state.selection.anchor + delta, state.selection.head + delta))
    dispatch(tr.scrollIntoView())
    return true
  }
}

/* ---------- 列表缩进 ---------- */

/** 块选区里的列表条目（单节点 = 它自己；跨顶层块 = 每个列表块的条目） */
function itemsInRange(doc: PMNode, range: Range): number[] {
  const node = doc.nodeAt(range.from)
  if (node && range.from + node.nodeSize === range.to) {
    if (node.type.name === 'list_item') return [range.from]
    if (isListNode(node)) return [range.from + 1]
    return []
  }
  const out: number[] = []
  doc.nodesBetween(range.from, range.to, (child, pos) => {
    if (child.type.name === 'list_item') {
      if (pos >= range.from) out.push(pos)
      return false
    }
    return true
  })
  return out
}

export function indentBlocks(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const sel = activeRange(state)
  if (!sel) return false
  const items = itemsInRange(state.doc, sel)
  if (!items.length || !dispatch) return true
  const tr = state.tr
  const moved = indentItems(tr, items).filter((m): m is { from: number; to: number } => m.to !== null)
  if (!moved.length) return true
  const starts = moved.map((m) => m.to)
  const from = Math.min(...starts)
  const lastStart = Math.max(...starts)
  const to = lastStart + (tr.doc.nodeAt(lastStart)?.nodeSize ?? 0)
  tr.setMeta(blockSelectKey, { active: true, from, to })
  dispatch(tr.scrollIntoView())
  return true
}

export function outdentBlocks(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const sel = activeRange(state)
  if (!sel) return false
  const node = state.doc.nodeAt(sel.from)
  const itemType = state.schema.nodes.list_item
  if (!node || node.type.name !== 'list_item' || !itemType || sel.from + node.nodeSize !== sel.to) return true
  const $item = state.doc.resolve(sel.from)
  if ($item.depth < 1 || $item.node($item.depth - 1).type.name !== 'list_item') return true
  if (!dispatch) return true
  // liftListItem 按 PM 选区工作：先把光标放进这一条再反缩进，块选按条目 id 跟到新位置
  const id: unknown = node.attrs.id
  const inside = state.apply(state.tr.setSelection(TextSelection.create(state.doc, sel.from + 2)))
  liftListItem(itemType)(inside, (tr) => {
    const merged = state.tr
    tr.steps.forEach((step) => merged.step(step))
    const pos = typeof id === 'string' && id ? findBlockIdPos(merged.doc, id) : null
    const now = pos !== null ? merged.doc.nodeAt(pos) : null
    if (pos !== null && now) merged.setMeta(blockSelectKey, { active: true, from: pos, to: pos + now.nodeSize })
    dispatch(merged.scrollIntoView())
  })
  return true
}

/* ---------- 多块拖拽 ---------- */

type RangeDrag = { slice: Slice; doc: PMNode; from: number; to: number; ids: string[] }
let rangeDrag: RangeDrag | null = null

/** 手柄 dragstart：拖起的块落在多块选区里时登记整段，返回要放进 dataTransfer / view.dragging 的 slice。
 *  不给 view.dragging 写 node：PM 原生 drop 与 list-drag 都只认单节点，整段搬运由 dropBlockRange 接管 */
export function beginRangeDrag(view: EditorView, handlePos: number): Slice | null {
  const sel = activeRange(view.state)
  if (!sel) return null
  const node = view.state.doc.nodeAt(sel.from)
  if (node && sel.from + node.nodeSize === sel.to) return null // 单块走单节点拖拽
  if (handlePos < sel.from || handlePos >= sel.to) return null
  const doc = view.state.doc
  const ids: string[] = []
  doc.nodesBetween(sel.from, sel.to, (child, pos) => {
    if (pos >= sel.from && typeof child.attrs.id === 'string' && child.attrs.id) ids.push(child.attrs.id)
    return false
  })
  const slice = doc.slice(sel.from, sel.to)
  rangeDrag = { slice, doc, from: sel.from, to: sel.to, ids }
  return slice
}

export function endRangeDrag(): void {
  rangeDrag = null
}

/** 源在当前文档里的位置：文档没变直接用；变了按首尾块 id 重找 */
function locateSource(drag: RangeDrag, doc: PMNode): Range | null {
  if (doc === drag.doc) return { from: drag.from, to: drag.to }
  const firstId = drag.ids[0]
  const lastId = drag.ids[drag.ids.length - 1]
  if (!firstId || !lastId) return null
  const from = findBlockIdPos(doc, firstId)
  const lastPos = findBlockIdPos(doc, lastId)
  const last = lastPos !== null ? doc.nodeAt(lastPos) : null
  if (from === null || lastPos === null || !last || lastPos < from) return null
  return { from, to: lastPos + last.nodeSize }
}

/** handleDrop：整段块搬到落点（落点算法同 PM 原生 drop 与落点横条的 dropPoint，看到哪里落哪里） */
export function dropBlockRange(view: EditorView, event: DragEvent): boolean {
  const drag = rangeDrag
  // 认 view.dragging 而不是 handleDrop 收到的 slice：PM 会先过 transformPasted，那份可能已是新对象
  if (!drag || view.dragging?.slice !== drag.slice) return false
  const slice = drag.slice
  rangeDrag = null
  event.preventDefault()
  const doc = view.state.doc
  const src = locateSource(drag, doc)
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
  if (!src || !at) return true
  const insertPos = dropPoint(doc, at.pos, slice) ?? at.pos
  if (insertPos >= src.from && insertPos <= src.to) return true // 落回原处
  const tr = view.state.tr.delete(src.from, src.to)
  const pos = tr.mapping.map(insertPos)
  tr.insert(pos, slice.content)
  tr.setMeta(blockSelectKey, { active: true, from: pos, to: pos + slice.content.size })
  view.dispatch(tr.setMeta('uiEvent', 'drop'))
  view.focus()
  return true
}
