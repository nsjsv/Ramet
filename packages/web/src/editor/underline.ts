/* ---------- underline mark：下划线（markdown 无原生语法，序列化降级 <u> 行内 HTML） ----------
 * - mark 本体：parseDOM 只认 `<u>` 标签，不认 text-decoration 样式（外链天然带下划线会误判）；
 * - toMarkdown：`<u>` / `</u>` 两个 html 叶子包住内容，runner 与文字颜色 / 背景高亮共用（html-marks.ts：
 *   同一段字上的几种 html 类 mark 一次写全，return true 自己消化节点、代发行内码与行内原子）；
 * - 逆路径（markdown 到 mark）：方言层（@ramet/shared/md-dialect 的 INLINE_TAGS）在 mdast 上把成对的
 *   `<u>…</u>` 包成 rametMark{mark:'underline'}，这里的 parseMarkdown 直接认领。服务端 parseBlocks 同一份识别；
 * - priority 90（commonmark 默认 50、inlineCode 100）：序列化时 orderMarks 升序跑，strong/link(50)
 *   先开（外层 spanning），下划线的 <u> 落进已开的 mark 元素里，<u>x</u> 的嵌套顺序稳定；inlineCode(100)
 *   排在后面，但它的 runner return true 会截断 mark 链，所以下划线必须先跑、代发行内码（见上）。 */
import { keymap } from '@milkdown/kit/prose/keymap'
import { toggleMark } from '@milkdown/kit/prose/commands'
import { isRametMark, type Md } from '@ramet/shared/md-dialect'
import { htmlMarksToMarkdown } from './html-marks'
import { $markSchema, $prose } from '@milkdown/kit/utils'

export const underlineSchema = $markSchema('underline', () => ({
  priority: 90,
  parseDOM: [{ tag: 'u' }],
  toDOM: () => ['u', 0],
  parseMarkdown: {
    match: (node) => isRametMark(node as Md) && node.mark === 'underline',
    runner: (state, node, markType) => {
      state.openMark(markType)
      state.next(node.children)
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'underline',
    runner: htmlMarksToMarkdown,
  },
}))

/** Mod-u 切下划线（commonmark / gfm 无此键位） */
export const underlineKeymap = $prose((ctx) => keymap({ 'Mod-u': toggleMark(underlineSchema.type(ctx)) }))
