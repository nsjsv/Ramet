/* ---------- 转换成：单块与多块同一实现 ----------
 * 入口两个：块菜单的转换面板（作用于块选区，多块时全部转换）、框选工具栏的转换成（作用于文字选区盖住的全部块）。
 * 都落到 turnInto(view, from, to, action)：
 *   - 区间是单个节点（手柄点选 / 下钻的列表项 / AI 回复的子块）时只转它；
 *   - 区间跨几个顶层块时逐个转（从后往前，同一个 tr，前面的坐标不受影响）；目标是容器（引用 / 提示框 / 折叠块）时
 *     先把各块拆成正文，再整段包进一个容器（markdown 里多段引用本来就是一个引用块）。
 * 语义：
 *   - 文本块转正文 / 标题 / 代码块：setBlockType（自带清不兼容 mark；setNodeMarkup 遇 code_block 会抛）；
 *   - 列表 / 引用这类容器转文本类目标：先拍平（条目 / 引用解包，嵌套列表与原子块提升为兄弟），再改类型；
 *   - 列表项换列表类型只改壳；转正文 / 标题 / 代码块 / 引用时先拆出列表再转（list-ops.ts）；
 *   - 原子块（分隔线 / 子页面 / 附件 / 图片）、表格、消息块不参与。
 * 身份：块 id 跟着内容走，被转换的那一块的 id 落到转换后承担这一块的节点上（列表项 / 段落 / 引用）。 */

import { Fragment, type Attrs, type Node as PMNode, type NodeType, type Schema } from '@milkdown/kit/prose/model'
import { TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { IconName } from '../icons'
import { blockSelectKey } from './block-select-key'
import { attrsFor, isListNode, retypeListItem, unwrapListItem, type ListKind } from './list-ops'
import { addressableAt } from './text-anchor'

/** 容器类目标：把块包进去（多块时整段包进一个） */
export type ContainerKind = 'blockquote' | 'callout' | 'toggle'
export type WrapKind = ListKind | ContainerKind

const CONTAINERS: ReadonlySet<string> = new Set<ContainerKind>(['blockquote', 'callout', 'toggle'])
const isContainerKind = (wrap: WrapKind): wrap is ContainerKind => CONTAINERS.has(wrap)

export type TurnAction = { kind: 'text'; typeName: string; attrs: Attrs } | { kind: 'wrap'; wrap: WrapKind }

/** 菜单项图标：图标表里的名字，或一段短文字（标题 H1–H3，同斜杠菜单） */
export type TurnIcon = { svg: IconName } | { text: string }

export const TURN_INTO_ITEMS: Array<{ label: string; icon: TurnIcon; action: TurnAction }> = [
  { label: '正文', icon: { svg: 'text' }, action: { kind: 'text', typeName: 'paragraph', attrs: {} } },
  { label: '标题 1', icon: { text: 'H1' }, action: { kind: 'text', typeName: 'heading', attrs: { level: 1 } } },
  { label: '标题 2', icon: { text: 'H2' }, action: { kind: 'text', typeName: 'heading', attrs: { level: 2 } } },
  { label: '标题 3', icon: { text: 'H3' }, action: { kind: 'text', typeName: 'heading', attrs: { level: 3 } } },
  { label: '无序列表', icon: { svg: 'list-bullet' }, action: { kind: 'wrap', wrap: 'bullet_list' } },
  { label: '有序列表', icon: { svg: 'list-number' }, action: { kind: 'wrap', wrap: 'ordered_list' } },
  { label: '待办', icon: { svg: 'todo' }, action: { kind: 'wrap', wrap: 'todo' } },
  { label: '引用', icon: { svg: 'blockquote' }, action: { kind: 'wrap', wrap: 'blockquote' } },
  { label: '提示框', icon: { svg: 'callout-note' }, action: { kind: 'wrap', wrap: 'callout' } },
  { label: '折叠块', icon: { svg: 'toggle' }, action: { kind: 'wrap', wrap: 'toggle' } },
  { label: '代码块', icon: { svg: 'code-block' }, action: { kind: 'text', typeName: 'code_block', attrs: {} } },
]

/** 这个块能不能转换（原子块、表格、消息块等不出转换面板） */
export function canTurn(node: PMNode): boolean {
  return node.type.name === 'list_item' || node.isTextblock || isWrapper(node)
}

function isWrapper(node: PMNode): boolean {
  return isListNode(node) || CONTAINERS.has(node.type.name)
}

function typeOf(schema: Schema, name: string): NodeType {
  const type = schema.nodes[name]
  if (!type) throw new Error(`schema 里没有节点 ${name}`)
  return type
}

/** 节点换一个 id（目标类型没有 id attr 就原样返回） */
function withId(node: PMNode, id: unknown): PMNode {
  if (!('id' in (node.type.spec.attrs ?? {}))) return node
  return node.type.create({ ...node.attrs, id: typeof id === 'string' ? id : '' }, node.content, node.marks)
}

/** 容器拍平：列表项 / 引用解包递归，其余子块（文本块、嵌套列表、原子块）原样提升；第一个块继承容器 id */
function flatten(wrapper: PMNode): Fragment {
  const out: PMNode[] = []
  const walk = (frag: Fragment): void => {
    frag.forEach((child) => {
      if (child.type.name === 'list_item' || CONTAINERS.has(child.type.name)) walk(child.content)
      else out.push(child)
    })
  }
  walk(wrapper.content)
  if (out[0]) out[0] = withId(out[0], wrapper.attrs.id)
  return Fragment.fromArray(out)
}

/** 一个文本块包成单条目列表：条目继承文本块的 id，里面的段落不带 id（不可寻址）。
 *  代码类块的内容是纯文字（不带 mark），直接搬文字；其余搬行内内容 */
function listOf(schema: Schema, block: PMNode, kind: ListKind): PMNode {
  const listType = typeOf(schema, kind === 'ordered_list' ? 'ordered_list' : 'bullet_list')
  const itemType = typeOf(schema, 'list_item')
  const paragraph = typeOf(schema, 'paragraph')
  const inline = block.type.spec.code ? (block.textContent ? Fragment.from(schema.text(block.textContent)) : Fragment.empty) : block.content
  const para = paragraph.create(attrsFor(paragraph, {}), inline)
  const item = itemType.create(attrsFor(itemType, { id: block.attrs.id }, { checked: kind === 'todo' ? false : null }), para)
  return listType.create(attrsFor(listType, {}), item)
}

/** 把 [from, to) 里的文本块逐个包成单条目列表（从后往前） */
function wrapEachInList(tr: Transaction, from: number, to: number, kind: ListKind): void {
  const targets: Array<{ pos: number; node: PMNode }> = []
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (pos < from) return true
    if (node.isTextblock) targets.push({ pos, node })
    return false
  })
  for (let i = targets.length - 1; i >= 0; i--) {
    const { pos, node } = targets[i]!
    tr.replaceWith(pos, pos + node.nodeSize, listOf(tr.doc.type.schema, node, kind))
  }
}

/** 一个块转换（不 dispatch），返回结果起点，不能转返回 null */
function turnUnit(tr: Transaction, pos: number, action: TurnAction): number | null {
  const node = tr.doc.nodeAt(pos)
  if (!node) return null
  const schema = tr.doc.type.schema
  if (node.type.name === 'list_item') {
    if (action.kind === 'wrap' && !isContainerKind(action.wrap)) {
      retypeListItem(tr, pos, action.wrap, schema)
      return pos
    }
    const start = unwrapListItem(tr, pos)
    const first = tr.doc.nodeAt(start)
    if (first?.isTextblock) return turnUnit(tr, start, action) ?? start
    return start
  }
  if (node.isTextblock) {
    if (action.kind === 'text') {
      const type = typeOf(schema, action.typeName)
      const attrs = attrsFor(type, node.attrs, action.attrs)
      if (node.type === type && Object.keys(action.attrs).every((k) => node.attrs[k] === action.attrs[k])) return pos
      tr.setBlockType(pos, pos + node.nodeSize, type, attrs)
      return pos
    }
    if (isContainerKind(action.wrap)) {
      wrapSpanIn(tr, pos, pos + node.nodeSize, action.wrap)
      return pos
    }
    tr.replaceWith(pos, pos + node.nodeSize, listOf(schema, node, action.wrap))
    return pos
  }
  if (!isWrapper(node)) return null
  if (action.kind === 'wrap' && action.wrap === node.type.name) return pos
  const flat = flatten(node)
  tr.replaceWith(pos, pos + node.nodeSize, flat)
  const end = pos + flat.size
  if (action.kind === 'text') {
    const type = typeOf(schema, action.typeName)
    tr.setBlockType(pos, end, type, (old) => attrsFor(type, old.attrs, action.attrs))
  } else if (isContainerKind(action.wrap)) {
    wrapSpanIn(tr, pos, end, action.wrap)
  } else {
    wrapEachInList(tr, pos, end, action.wrap)
  }
  return pos
}

/** [from, to) 这一段块整个包进一个容器（引用 / 提示框 / 折叠块），容器继承第一块的 id。
 *  折叠块的第一个子块必须是段落（摘要）：第一块是标题 / 代码这类文本块就换成段落（字不变），不是文本块就补一个空摘要 */
function wrapSpanIn(tr: Transaction, from: number, to: number, kind: ContainerKind): void {
  const schema = tr.doc.type.schema
  const type = typeOf(schema, kind)
  const slice = tr.doc.slice(from, to)
  const first = slice.content.firstChild
  let content = first ? slice.content.replaceChild(0, withId(first, '')) : slice.content
  if (kind === 'toggle') {
    const paragraph = typeOf(schema, 'paragraph')
    const head = content.firstChild
    if (!head || !head.isTextblock) content = Fragment.from(paragraph.create()).append(content)
    else if (head.type !== paragraph) {
      const inline = head.type.spec.code ? (head.textContent ? Fragment.from(schema.text(head.textContent)) : Fragment.empty) : head.content
      content = content.replaceChild(0, paragraph.create(attrsFor(paragraph, {}), inline))
    }
  }
  tr.replaceWith(from, to, type.create(attrsFor(type, { id: first?.attrs.id }), content))
}

/** 区间里要逐个转换的单位：单节点区间就是它自己，否则每个顶层块（列表下钻到条目） */
export function turnUnits(doc: PMNode, from: number, to: number): number[] {
  const single = doc.nodeAt(from)
  if (single && from + single.nodeSize === to) return canTurn(single) ? [from] : []
  const out: number[] = []
  doc.forEach((node, offset) => {
    if (offset + node.nodeSize <= from || offset >= to) return
    if (isListNode(node)) node.forEach((_item, itemOffset) => out.push(offset + 1 + itemOffset))
    else if (canTurn(node)) out.push(offset)
  })
  return out
}

/** 区间转换（不 dispatch）。返回结果区间（多块时用来重设块选），什么都没转返回 null */
export function turnRangeTr(tr: Transaction, from: number, to: number, action: TurnAction): { from: number; to: number } | null {
  const units = turnUnits(tr.doc, from, to)
  if (units.length === 0) return null
  const container = units.length > 1 && action.kind === 'wrap' && isContainerKind(action.wrap) ? action.wrap : null
  for (let i = units.length - 1; i >= 0; i--) {
    if (container) unwrapForContainer(tr, units[i]!)
    else turnUnit(tr, units[i]!, action)
  }
  const start = tr.mapping.map(from, -1)
  const end = tr.mapping.map(to, 1)
  if (container) wrapSpanIn(tr, start, end, container)
  return { from: start, to: container ? start + (tr.doc.nodeAt(start)?.nodeSize ?? 0) : end }
}

/** 包进同一个容器之前：列表项拆成正文、容器拍平，文本块原样 */
function unwrapForContainer(tr: Transaction, pos: number): void {
  const node = tr.doc.nodeAt(pos)
  if (!node) return
  if (node.type.name === 'list_item') unwrapListItem(tr, pos)
  else if (CONTAINERS.has(node.type.name)) tr.replaceWith(pos, pos + node.nodeSize, flatten(node))
}

/** 执行转换：单块落光标进结果，多块保持块选（覆盖转换后的整段） */
export function turnInto(view: EditorView, from: number, to: number, action: TurnAction): void {
  const tr = view.state.tr
  const multi = turnUnits(view.state.doc, from, to).length > 1
  const range = turnRangeTr(tr, from, to, action)
  if (!range || !tr.docChanged) return
  if (multi) {
    tr.setMeta(blockSelectKey, { active: true, from: range.from, to: range.to })
  } else {
    const caret = TextSelection.findFrom(tr.doc.resolve(range.from), 1, true)
    if (caret) tr.setSelection(caret)
  }
  view.dispatch(tr.scrollIntoView())
  view.focus()
}

/** 文字选区（或光标）要转换的范围：在一个可寻址块里就是这一块（node 给出），跨了几个顶层块就是这一段（node 为 null）。
 *  框选工具栏的转换成与块类型快捷键（Mod-Alt-0…9 等）共用 */
export function selectionTurnRange(state: EditorState, range: { from: number; to: number } = state.selection): { from: number; to: number; node: PMNode | null } | null {
  const doc = state.doc
  const hit = addressableAt(doc, range.from, false)
  if (!hit) return null
  if (range.to <= hit.end) return { from: hit.pos, to: hit.pos + hit.node.nodeSize, node: hit.node }
  const $from = doc.resolve(range.from)
  const $to = doc.resolve(range.to)
  if ($from.depth < 1 || $to.depth < 1) return null
  return { from: $from.before(1), to: $to.after(1), node: null }
}
