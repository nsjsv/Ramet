// ---------- 块首退格：先去样式，再合并 ----------
// 块首退格在 PM 里只有「与上一块合并」一种语义（joinBackward），列表项是空的也掉不了样式，
// 想把序号变回正文只能走块转换。这里补上两段式：块首第一次退格去掉这一块的样式，第二次才合并。
//
// 命中条件：折叠光标、在文本块开头，且这一文本块是某个样式的第一个文字位置：
//   标题变正文；空代码块 / 空公式块变正文；
//   列表条目首段：嵌套条目退一级（list-ops / liftListItem），容器里的直接列表条目拆出成正文；
//   引用 / 提示框的首个子块移出容器（容器只剩它时整个解包）；折叠块的摘要使整个折叠块解包。
// 先看文本块自身（标题），再看它的直接容器，嵌套时由内向外一层一层去。
// 消息块（user_message / agent_reply）不是样式，它们的边界由 message-blocks.ts 的 messageDeleteKeymap 管。
// 不命中一律返回 false，放行后面的 keymap（消息块墙、PM 默认）。
//
// 第二段合并是 mergeIntoPrevious：正文段落 / 标题的块首退格、前一块是列表 / 引用这类容器时，
// PM 默认（joinBackward 的 deleteBarrier）会把这一段搬进前一个容器（变成新的列表项 / 引用的一段），
// 刚去掉样式的那一段再退格又变回列表项。正确语义是把字并到前一块最后一行的末尾。

import { Fragment, type Node as PMNode } from '@milkdown/kit/prose/model'
import { TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { liftListItem } from '@milkdown/kit/prose/schema-list'
import { attrsFor, unwrapListItem } from './list-ops'

/** 首子块移出容器的样式容器（容器里其余块留在容器里） */
const LIFT_FIRST = new Set(['blockquote', 'callout'])
/** 首段即摘要、退格整个解包的容器 */
const UNWRAP_ALL = new Set(['toggle'])
/** 内容是代码文本的块：空的时候退格变正文 */
const CODE_LIKE = new Set(['code_block', 'math_block'])

/** 文本块换成正文段落，保住块 id（引用 / 收藏跟着这一块走） */
function toParagraph(tr: Transaction, pos: number, node: PMNode): boolean {
  const paragraph = tr.doc.type.schema.nodes.paragraph
  if (!paragraph) return false
  tr.setBlockType(pos, pos + node.nodeSize, paragraph, attrsFor(paragraph, node.attrs))
  return true
}

/** 容器的第一个子块搬到容器前面；容器只有它一个时整个换成它（子块继承容器的 id） */
function liftFirstChild(tr: Transaction, containerPos: number, container: PMNode): number {
  const first = container.firstChild!
  const carried = 'id' in (first.type.spec.attrs ?? {}) && typeof container.attrs.id === 'string'
    ? first.type.create({ ...first.attrs, id: container.attrs.id }, first.content, first.marks)
    : first
  if (container.childCount === 1) {
    tr.replaceWith(containerPos, containerPos + container.nodeSize, carried)
    return containerPos
  }
  tr.delete(containerPos + 1, containerPos + 1 + first.nodeSize)
  tr.insert(containerPos, carried)
  return containerPos
}

/** 容器整个解包：子块原样成为容器所在层的兄弟块 */
function unwrapAll(tr: Transaction, containerPos: number, container: PMNode): number {
  tr.replaceWith(containerPos, containerPos + container.nodeSize, Fragment.from(container.content))
  return containerPos
}

export function stripBlockStyle(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const sel = state.selection
  if (!(sel instanceof TextSelection) || !sel.empty) return false
  const $from = sel.$from
  if ($from.parentOffset !== 0 || !$from.parent.isTextblock) return false
  const block = $from.parent
  const depth = $from.depth
  const blockPos = $from.before(depth)
  const tr = state.tr

  // 1. 文本块自身的样式
  if (block.type.name === 'heading' || (CODE_LIKE.has(block.type.name) && block.content.size === 0)) {
    if (!toParagraph(tr, blockPos, block)) return false
    if (dispatch) dispatch(tr.scrollIntoView())
    return true
  }

  // 2. 直接容器的样式：只认容器第一个子块的开头
  if (depth < 1 || $from.index(depth - 1) !== 0) return false
  const container = $from.node(depth - 1)
  const containerName = container.type.name
  if (depth - 1 === 0) return false // 容器是文档本身：普通段落，没有样式可去

  if (containerName === 'list_item') {
    // 列表挂在另一个条目里的嵌套条目退一级，容器里的直接列表拆出成正文
    const listOwner = depth >= 3 ? $from.node(depth - 3) : null
    if (listOwner?.type.name === 'list_item') {
      const itemType = state.schema.nodes.list_item
      return itemType ? liftListItem(itemType)(state, dispatch) : false
    }
    const start = unwrapListItem(tr, $from.before(depth - 1))
    tr.setSelection(TextSelection.create(tr.doc, start + 1))
    if (dispatch) dispatch(tr.scrollIntoView())
    return true
  }

  const containerPos = $from.before(depth - 1)
  let start: number
  if (LIFT_FIRST.has(containerName)) start = liftFirstChild(tr, containerPos, container)
  else if (UNWRAP_ALL.has(containerName)) start = unwrapAll(tr, containerPos, container)
  else return false
  tr.setSelection(TextSelection.create(tr.doc, start + 1))
  if (dispatch) dispatch(tr.scrollIntoView())
  return true
}

/** 前一块是这些容器时，第二次退格把字并进它最后一行（消息块不在内：它们的边界是墙，见 messageDeleteKeymap） */
const MERGE_INTO = new Set(['bullet_list', 'ordered_list', 'blockquote', 'callout', 'toggle']) // 分栏不在内：栏是 isolating，跨栏合并会坏结构
const MERGEABLE = new Set(['paragraph', 'heading'])

/** 节点里文档序最后一个文本块的内容末尾（相对节点起点的位置）；最后一个叶子不是文本块（图片 / 分隔线……）时返回 null */
function lastTextEnd(node: PMNode, pos: number): number | null {
  let cur = node
  let at = pos
  while (!cur.isTextblock) {
    const last = cur.lastChild
    if (!last) return null
    at = at + cur.nodeSize - 1 - last.nodeSize
    cur = last
  }
  return at + cur.nodeSize - 1
}

export function mergeIntoPrevious(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const sel = state.selection
  if (!(sel instanceof TextSelection) || !sel.empty) return false
  const $from = sel.$from
  if ($from.parentOffset !== 0 || !MERGEABLE.has($from.parent.type.name)) return false
  const depth = $from.depth
  const index = $from.index(depth - 1)
  if (index === 0) return false
  const prev = $from.node(depth - 1).child(index - 1)
  if (!MERGE_INTO.has(prev.type.name)) return false
  const blockStart = $from.before(depth)
  const end = lastTextEnd(prev, blockStart - prev.nodeSize)
  if (end === null) return false
  if (dispatch) {
    const tr = state.tr.delete(end, $from.pos)
    tr.setSelection(TextSelection.create(tr.doc, end))
    dispatch(tr.scrollIntoView())
  }
  return true
}
