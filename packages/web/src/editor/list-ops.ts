// 列表条目的事务级操作（拆出 / 换类型 / 缩进 / 反缩进）。
// 都只改调用方给的 tr（不 dispatch），位置一律按 tr.doc 现算。块首退格、「转换成」、Tab 缩进、
// 块选区批量操作共用这一份，不各写一套拆列表逻辑。
// 顶层（容器的直接子代）列表恰含一个条目是常态（list-blocks.ts 的不变量），但这里不依赖它：
// 多条目列表先在条目两侧切开再动，结果形状对两种输入都对。

import { Fragment, type Attrs, type Node as PMNode, type NodeType, type Schema } from '@milkdown/kit/prose/model'
import type { Transaction } from '@milkdown/kit/prose/state'

export function isListNode(node: PMNode | null | undefined): boolean {
  const name = node?.type.name
  return name === 'bullet_list' || name === 'ordered_list'
}

/** 只给目标类型声明过的 attrs 赋值（测试 schema 与真实 schema 的 attrs 集合不同，多给的键 create 会忽略，
 *  但 `id` 这类键要按类型有没有决定写不写，免得把 id 抄到不可寻址的节点上） */
export function attrsFor(type: NodeType, base: Attrs, over: Attrs = {}): Attrs {
  const spec = type.spec.attrs ?? {}
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(spec)) {
    if (key in over) out[key] = over[key]
    else if (key in base) out[key] = base[key]
  }
  return out
}

/** 把 itemPos 处的条目在父列表里切出来，让它独占一个列表；返回条目的新起点。 */
export function isolateListItem(tr: Transaction, itemPos: number): number {
  const $item = tr.doc.resolve(itemPos)
  const item = tr.doc.nodeAt(itemPos)
  if (!item) return itemPos
  const index = $item.index()
  const siblings = $item.parent.childCount
  let pos = itemPos
  if (index < siblings - 1) tr.split(pos + item.nodeSize, 1) // 后面有兄弟：在条目之后切
  if (index > 0) {
    tr.split(pos, 1) // 前面有兄弟：在条目之前切（条目右移一个「列表闭合 + 列表开启」）
    pos += 2
  }
  return pos
}

/** 条目 → 拆出列表：条目内容换掉它所在的列表（先切成独占），第一个块（条目自己那段字）带上条目的 id，
 *  子列表等其余子块原样跟在后面。返回换出内容的起点。 */
export function unwrapListItem(tr: Transaction, itemPos: number): number {
  const pos = isolateListItem(tr, itemPos)
  const item = tr.doc.nodeAt(pos)
  if (!item) return pos
  const $pos = tr.doc.resolve(pos)
  const listStart = $pos.before($pos.depth)
  const listEnd = listStart + $pos.parent.nodeSize
  const first = item.firstChild
  let content = item.content
  // 身份跟着「这一条」走：拆出来的那段字继承条目的块 id（条目本身没了）
  if (first && first.type.spec.attrs && 'id' in first.type.spec.attrs && typeof item.attrs.id === 'string') {
    content = content.replaceChild(0, first.type.create({ ...first.attrs, id: item.attrs.id }, first.content, first.marks))
  }
  tr.replaceWith(listStart, listEnd, content)
  return listStart
}

export type ListKind = 'bullet_list' | 'ordered_list' | 'todo'

/** 条目换列表类型（无序 / 有序 / 待办）：先切成独占再改壳；待办 = checked:false，其余清成 null */
export function retypeListItem(tr: Transaction, itemPos: number, kind: ListKind, schema: Schema): void {
  const pos = isolateListItem(tr, itemPos)
  const $pos = tr.doc.resolve(pos)
  const listPos = $pos.before($pos.depth)
  const list = $pos.parent
  const listType = kind === 'ordered_list' ? schema.nodes.ordered_list! : schema.nodes.bullet_list!
  if (list.type !== listType) tr.setNodeMarkup(listPos, listType, attrsFor(listType, list.attrs))
  const now = tr.doc.nodeAt(pos)
  if (now) tr.setNodeMarkup(pos, undefined, { ...now.attrs, checked: kind === 'todo' ? (now.attrs.checked ?? false) : null })
}

/** 包含 pos 的最内层列表条目的起点；不在条目里 = null */
export function listItemAround(doc: PMNode, pos: number): number | null {
  const $pos = doc.resolve(pos)
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'list_item') return $pos.before(d)
  }
  return null
}

/** 缩进：itemPos 处的条目挂到前一个条目下面。
 *  - 同列表里有前一条目 → 挂到它的子列表末尾（没有同类型子列表就新建）；
 *  - 是列表第一条（顶层单条目列表恒如此）且列表前面紧挨着另一个列表 → 挂到那个列表最后一条下面。
 *  返回条目的新起点；挂不上 = null（tr 不动）。条目的子列表、勾选状态、id 原样跟着走。 */
export function indentListItem(tr: Transaction, itemPos: number): number | null {
  const doc = tr.doc
  const item = doc.nodeAt(itemPos)
  if (!item || item.type.name !== 'list_item') return null
  const $item = doc.resolve(itemPos)
  const list = $item.parent
  const index = $item.index()
  const listStart = $item.before($item.depth)
  let host: { pos: number; node: PMNode } | null = null // 新父条目
  if (index > 0) {
    const prev = list.child(index - 1)
    host = { pos: itemPos - prev.nodeSize, node: prev }
  } else if ($item.depth >= 1) {
    const $list = doc.resolve(listStart)
    const before = $list.nodeBefore
    if (before && isListNode(before) && before.lastChild) {
      host = { pos: listStart - 1 - before.lastChild.nodeSize, node: before.lastChild }
    }
  }
  if (!host) return null
  // 删源：列表只剩这一条 → 连列表壳删；否则只删条目。源恒在 host 之后，删除不影响 host 的坐标
  if (list.childCount === 1) tr.delete(listStart, listStart + list.nodeSize)
  else tr.delete(itemPos, itemPos + item.nodeSize)
  const hostEnd = host.pos + host.node.nodeSize // host 闭合标记之后
  const last = host.node.lastChild
  if (last && last.type === list.type) {
    const at = hostEnd - 2 // 子列表闭合 + host 闭合之前
    tr.insert(at, item)
    return at
  }
  const nested = list.type.create(attrsFor(list.type, list.attrs, { id: '', order: 1 }), Fragment.from(item))
  const at = hostEnd - 1
  tr.insert(at, nested)
  return at + 1
}
