/* ---------- 自定义块 toMarkdown 共用：降级成 mdast link 节点 ----------
 * 降级输出必须是合法 mdast：块级形态 = paragraph 包 link，行内 = 当前段内 link。
 * 根级裸 text 会击穿 mdast-util-to-markdown 的块间连接（整篇拍平成一行）；
 * 行内 text 的方括号会被转义成 \[..\]，重新解析不再是链接、升不回块。
 * state.schema.marks.link 依赖 commonmark（Editor/PublicPage 均已 .use）。
 * link mark attrs 只填 href（title 默认 null），与 preset linkSchema 一致。 */

import type { SerializerState } from '@milkdown/kit/transformer'

/** 序列化为 `[text](href)`；block=true 时独占一段（块级节点降级形态）。 */
export function mdLink(state: SerializerState, text: string, href: string, block: boolean): void {
  if (block) state.openNode('paragraph')
  const linkType = state.schema.marks.link
  // 实例没挂 commonmark 时退成裸文本（Editor/PublicPage 都挂了，理论上走不到）
  if (!linkType) {
    state.addNode('text', undefined, `[${text}](${href})`)
    return
  }
  const link = linkType.create({ href })
  state.withMark(link, 'link', undefined, { url: href, title: null })
  state.addNode('text', undefined, text)
  state.closeMark(link)
  if (block) state.closeNode()
}
