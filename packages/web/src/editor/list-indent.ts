// Tab / Shift-Tab：列表缩进、代码行缩进。
// 列表：顶层列表恒为单条目（list-blocks.ts），PM 的 sinkListItem 找不到「同列表的前一条」，顶层条目按 Tab
// 缩不进去（焦点还会被浏览器移出编辑器）。这里自己挂：条目挂到前一条下面，前一条在另一个列表里也行
// （list-ops.ts 的 indentListItem）。反缩进：嵌套条目走 PM liftListItem（提到外层后多出来的条目由
// listNormalize 拆成单条目），容器里的直接条目不动但吞键。选区盖住多条时按文档序逐条缩进（单事务）。
// 代码：代码 / 公式块里 Tab 在选中各行行首加两个空格，Shift-Tab 去掉至多两个；折叠光标的 Tab 就地插两个空格。
// 表格里的 Tab 不归这里（选区不在条目 / 代码里时返回 false，交给 gfm 跳格与 table-nav）。

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { liftListItem } from '@milkdown/kit/prose/schema-list'
import { indentListItem, listItemAround } from './list-ops'

const INDENT = '  '

/** 选区落在同一个代码类文本块里（code_block / math_block） */
function codeBlockOf(state: EditorState): { pos: number; node: PMNode } | null {
  const { $from, $to } = state.selection
  if (!$from.sameParent($to) || !$from.parent.type.spec.code) return null
  return { pos: $from.before(), node: $from.parent }
}

/** 选区触及的各行行首（块内偏移，升序）：首行总算；之后的行要在选区终点之前开始（选到下一行行首不算那一行） */
function lineStarts(text: string, from: number, to: number): number[] {
  const starts = [text.lastIndexOf('\n', from - 1) + 1]
  let next = text.indexOf('\n', starts[0])
  while (next >= 0 && next + 1 < to) {
    starts.push(next + 1)
    next = text.indexOf('\n', next + 1)
  }
  return starts
}

export function indentCode(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const hit = codeBlockOf(state)
  if (!hit) return false
  if (!dispatch) return true
  const base = hit.pos + 1
  const { from, to, empty } = state.selection
  if (empty) {
    dispatch(state.tr.insertText(INDENT, from).scrollIntoView())
    return true
  }
  const tr = state.tr
  const starts = lineStarts(hit.node.textContent, from - base, to - base)
  for (let i = starts.length - 1; i >= 0; i--) tr.insertText(INDENT, base + starts[i]!)
  dispatch(tr.scrollIntoView())
  return true
}

export function outdentCode(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const hit = codeBlockOf(state)
  if (!hit) return false
  if (!dispatch) return true
  const base = hit.pos + 1
  const text = hit.node.textContent
  const { from, to } = state.selection
  const tr = state.tr
  const starts = lineStarts(text, from - base, to - base)
  for (let i = starts.length - 1; i >= 0; i--) {
    const at = starts[i]!
    let n = 0
    while (n < INDENT.length && text[at + n] === ' ') n += 1
    if (n === 0 && text[at] === '\t') n = 1
    if (n > 0) tr.delete(base + at, base + at + n)
  }
  if (tr.docChanged) dispatch(tr.scrollIntoView())
  return true
}

/** 选区盖住的最外层条目起点（文档序）：只认「首段与选区相交」的条目，盖住父条目时不再单列它的子条目；
 *  一个都没有（光标在条目的续段里）= 光标所在的那条 */
export function itemsInSelection(doc: PMNode, from: number, to: number): number[] {
  const out: number[] = []
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name !== 'list_item') return true
    const firstEnd = pos + 1 + (node.firstChild?.nodeSize ?? 0)
    if (firstEnd > from) {
      out.push(pos)
      return false
    }
    return true
  })
  if (out.length === 0) {
    const around = listItemAround(doc, from)
    if (around !== null) out.push(around)
  }
  return out
}

/** 一组条目逐个缩进（同一个 tr）。返回每个条目缩进后的起点（挂不上的为 null），已按后续步骤映射到最终文档 */
export function indentItems(tr: Transaction, itemPositions: number[]): Array<{ from: number; to: number | null }> {
  const results: Array<{ from: number; to: number | null }> = []
  for (const orig of itemPositions) {
    const before = tr.steps.length
    const now = tr.mapping.map(orig)
    const moved = indentListItem(tr, now)
    const steps = tr.mapping.slice(before)
    for (const r of results) if (r.to !== null) r.to = steps.map(r.to, 1)
    results.push({ from: orig, to: moved })
  }
  return results
}

export function indentList(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const { from, to } = state.selection
  if (listItemAround(state.doc, from) === null) return false
  const items = itemsInSelection(state.doc, from, to)
  if (items.length === 0) return true
  const tr = state.tr
  const moved = indentItems(tr, items)
  if (!tr.docChanged) return true // 挂不上（第一条、前面不是列表）：吞键，不让焦点跑出编辑器
  if (dispatch) {
    // 选区两端跟着所在条目走（delete + insert 的映射会把它们压到删除点上）
    const place = (pos: number): number => {
      for (const m of moved) {
        const item = state.doc.nodeAt(m.from)
        if (m.to !== null && item && pos >= m.from && pos <= m.from + item.nodeSize) return m.to + (pos - m.from)
      }
      return tr.mapping.map(pos)
    }
    const { anchor, head } = state.selection
    tr.setSelection(TextSelection.create(tr.doc, place(anchor), place(head)))
    dispatch(tr.scrollIntoView())
  }
  return true
}

export function outdentList(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const itemPos = listItemAround(state.doc, state.selection.from)
  if (itemPos === null) return false
  const $item = state.doc.resolve(itemPos)
  // 条目所在列表挂在另一个条目里 = 嵌套条目 → 退一级；否则（容器里的直接列表）吞键不动
  const owner = $item.depth >= 1 ? $item.node($item.depth - 1) : null
  const itemType = state.schema.nodes.list_item
  if (owner?.type.name === 'list_item' && itemType) return liftListItem(itemType)(state, dispatch) || true
  return true
}

export function indentCommand(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  return indentCode(state, dispatch) || indentList(state, dispatch)
}

export function outdentCommand(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  return outdentCode(state, dispatch) || outdentList(state, dispatch)
}
