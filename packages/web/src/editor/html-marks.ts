// html 类 mark（下划线 / 文字颜色 / 背景高亮）共用的 markdown 序列化。markdown 没有这三种语法，写成行内 html 包住内容
// （开闭标签在 @ramet/shared/md-dialect 的 colors.ts，识别在 INLINE_TAGS）。
// runner 必须 return true 自己消化节点（html 是叶子装不下子节点），而 return true 之后同一个节点上的其它 mark runner
// 不再跑，所以三种 mark 共用这一个 runner：一次把这个节点上全部 html 类 mark 的开标签按序写出、内容、再倒序闭合。
// 三者 priority 都是 90：strong / link（50）先开成外层；inlineCode（100）的 runner 也 return true，排在它前面会被截断，
// 所以行内码由这里代发；行内原子（block_ref 等）调它自己的 toMarkdown runner，否则原子被丢。

import type { Mark as PMMark, Node as PMNode } from '@milkdown/kit/prose/model'
import type { SerializerState } from '@milkdown/kit/transformer'
import { markCloseTag, markOpenTag } from '@ramet/shared/md-dialect'

export type HtmlMarkName = 'underline' | 'text_color' | 'highlight'
const HTML_MARKS: ReadonlySet<string> = new Set<HtmlMarkName>(['underline', 'text_color', 'highlight'])

export function htmlMarksToMarkdown(state: SerializerState, _mark: PMMark, node: PMNode): boolean {
  const marks = node.marks.filter((m) => HTML_MARKS.has(m.type.name))
  for (const m of marks) state.addNode('html', undefined, markOpenTag(m.type.name as HtmlMarkName, m.attrs.color))
  if (node.isText) {
    if (node.marks.some((m) => m.type.name === 'inlineCode')) state.addNode('inlineCode', undefined, node.text)
    else state.addNode('text', undefined, node.text)
  } else if (node.content.size) {
    state.next(node.content) // 行内容器（link）：子节点照常跑，落进已开的 link 元素
  } else {
    node.type.spec.toMarkdown?.runner?.(state, node)
  }
  for (let i = marks.length - 1; i >= 0; i--) state.addNode('html', undefined, markCloseTag(marks[i]!.type.name as HtmlMarkName))
  return true
}
