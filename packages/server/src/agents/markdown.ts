// ---------- 块结构 → Yjs（AI 回复收尾落文档） ----------
// 解析（markdown → Block[]）在共享包 `@ramet/shared/markdown-blocks`：前端实时渲染用同一份，
// 收尾那一刻外观不跳。这里只负责把块树写成 Y.XmlElement。
//   · 行内 mark 在 Yjs 侧是 Y.XmlText 的格式属性（y-prosemirror 的 marksToAttributes），不是嵌套元素，
//     所以 strong / emphasis / inlineCode / link 走 text.format(index, len, attrs)，
//     值就是 mark 的 attrs（strong / emphasis 带 marker，link 带 href / title）
//   · 软换行落 hardbreak 节点（updates.ts 的文本抽取会把它还原成 '\n'）

import * as Y from 'yjs'
import type { Attrs, Block, Inline, MarkSpec } from '@ramet/shared/markdown-blocks'
import { isAddressable } from '@ramet/shared/block-address'
import { newBlockId } from '../block-ids.js'

/** Yjs 的 attr 类型签名只收 string，但运行期原样存值（y-prosemirror 的 spread/order/level
 *  要的是真布尔与数字，存成字符串会让前端 equality 判定为「不同」而重写文档） */
function setAttrs(element: Y.XmlElement, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value as string)
}

/** 同格式判定：mark 的 attrs 也要一致。两个相邻链接的 href 不同，只看名字会把后一个的
 *  文字并进前一个的链接区间，地址就错了 */
function sameAttrs(a: Attrs, b: Attrs): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

/** 行内内容写进父节点（文本合并成 Y.XmlText + 格式区间，hardbreak / 图片另起节点）。
 *  `at` 给定则整段插在该下标上，缺省追加到末尾；返回插入结束后的下一个下标。 */
export function materializeInlines(parent: Y.XmlElement, inlines: Inline[], at = parent.length): number {
  let buffer = ''
  let marks: MarkSpec[] = []
  const flush = (): void => {
    if (!buffer) return
    const node = new Y.XmlText()
    parent.insert(at, [node])
    at += 1
    node.insert(0, buffer) // 必须先并入文档再写：detached 的 Y.XmlText 上 insert 是空操作
    for (const mark of marks) node.format(0, buffer.length, { [mark.name]: mark.attrs })
    buffer = ''
    marks = []
  }
  for (const inline of inlines) {
    if ('br' in inline) {
      flush()
      const br = new Y.XmlElement('hardbreak')
      parent.insert(at, [br])
      at += 1
      setAttrs(br, { isInline: false })
      continue
    }
    if ('atom' in inline) {
      flush()
      const atom = new Y.XmlElement(inline.atom)
      parent.insert(at, [atom])
      at += 1
      setAttrs(atom, inline.attrs)
      continue
    }
    // 相邻同格式的文本合并成一段（少几个节点、少几条增量）
    if (
      inline.marks.length === marks.length &&
      inline.marks.every((m, i) => m.name === marks[i]!.name && sameAttrs(m.attrs, marks[i]!.attrs))
    ) {
      buffer += inline.text
      continue
    }
    flush()
    buffer = inline.text
    marks = inline.marks
  }
  flush()
  return at
}

/** 块树写进父节点（fragment 或元素，必须已在文档里）。调用方负责包一个事务。
 *  `at` 给定则整段插在该下标上，缺省追加到末尾。
 *  插入位置在写之前算好并逐个后移（不能中途再读父节点长度：那是刚插进去的块自己的下标）。
 *  可寻址块（顶层块、任意深度的列表项、AI 回复的直接子块，判定见 @ramet/shared/block-address）建出来就带 id（block-ids.ts）。
 *  Y.XmlElement 继承 Y.XmlFragment，「是不是顶层」要用「不是元素」判。 */
export function materialize(parent: Y.XmlFragment | Y.XmlElement, blocks: Block[], at = parent.length): void {
  const parentName = parent instanceof Y.XmlElement ? parent.nodeName : null
  for (const block of blocks) {
    const element = new Y.XmlElement(block.name)
    parent.insert(at, [element])
    at += 1
    setAttrs(element, block.attrs)
    if (isAddressable(block.name, parentName)) element.setAttribute('id', newBlockId())
    if (block.text !== undefined) {
      const node = new Y.XmlText()
      element.insert(0, [node])
      node.insert(0, block.text)
    }
    if (block.inlines) materializeInlines(element, block.inlines)
    if (block.blocks) materialize(element, block.blocks)
  }
}

/** 服务端凭空建一份页面文档：title 片段放标题、正文片段放块。建页时文档不可能有活连接，
 *  所以直接生成整份状态（调用方 appendDocUpdate / writeDocState 落盘），不走协同会话。
 *  create_page 工具与 skill 导入共用这个形状。 */
export function newPageDoc(title: string, blocks: Block[]): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => {
    const heading = new Y.XmlElement('paragraph')
    doc.getXmlFragment('title').insert(0, [heading])
    const text = new Y.XmlText()
    heading.insert(0, [text])
    text.insert(0, title)
    materialize(doc.getXmlFragment('prosemirror'), blocks)
  })
  return doc
}

