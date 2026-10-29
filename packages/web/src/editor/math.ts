/* ---------- 数学公式节点 ----------
 * math_inline 是行内原子（attr `latex`），对应 markdown `$…$`（mdast inlineMath）；
 * math_block 是代码类块，内容就是 LaTeX，对应 `$$…$$`（mdast math）。
 * 解析靠方言层（@ramet/shared/md-dialect 的 remark 插件），这里的 parseMarkdown 只认领；
 * 序列化产出标准 mdast，由同一插件注册的 toMarkdown 扩展写成 `$` / `$$`。
 * toDOM 是静态骨架，nodeView / rich-render.ts 用 KaTeX 画；两个宿主都要 .use 两个 schema。
 * 输入：`$x$` 打完收尾 `$` 转行内公式（内侧不能是空白，「$5 和 $」不转）；段首 `$$ ` 转公式块。 */

import { InputRule, textblockTypeInputRule } from '@milkdown/kit/prose/inputrules'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $inputRule, $nodeSchema } from '@milkdown/kit/utils'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export const mathInlineSchema = $nodeSchema('math_inline', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  attrs: { latex: { default: '' } },
  leafText: (node: PMNode) => `$${str(node.attrs.latex)}$`,
  parseDOM: [
    {
      tag: 'span[data-math-inline]',
      getAttrs: (dom) => ({ latex: dom instanceof HTMLElement ? (dom.dataset.latex ?? dom.textContent ?? '') : '' }),
    },
  ],
  toDOM: (node) => ['span', { 'data-math-inline': '', 'data-latex': str(node.attrs.latex), class: 'math-inline' }, str(node.attrs.latex)],
  parseMarkdown: {
    match: (node) => node.type === 'inlineMath',
    runner: (state, node, type) => {
      state.addNode(type, { latex: str(node.value) })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'math_inline',
    runner: (state, node) => {
      state.addNode('inlineMath', undefined, str(node.attrs.latex))
    },
  },
}))

export const mathBlockSchema = $nodeSchema('math_block', () => ({
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  attrs: { id: { default: '' } },
  parseDOM: [{ tag: 'div[data-math-block]', preserveWhitespace: 'full' as const, contentElement: 'pre' }],
  toDOM: () => ['div', { 'data-math-block': '', class: 'math-block' }, ['pre', 0]],
  parseMarkdown: {
    match: (node) => node.type === 'math',
    runner: (state, node, type) => {
      state.openNode(type)
      const value = str(node.value)
      if (value) state.addText(value)
      state.closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'math_block',
    runner: (state, node) => {
      state.addNode('math', undefined, node.textContent)
    },
  },
}))

/** 行内：收尾 `$` 时把 `$…$` 换成公式（前面不是 `$` / 反斜杠，内侧首尾不是空白） */
export const mathInlineInputRule = $inputRule(
  (ctx) =>
    new InputRule(/(?<![$\\])\$([^\s$](?:[^$]*[^\s$])?)\$$/, (state, match, start, end) => {
      const latex = match[1]
      if (!latex) return null
      return state.tr.replaceWith(start, end, mathInlineSchema.type(ctx).create({ latex }))
    }),
)

/** 块：段首 `$$ ` → 公式块 */
export const mathBlockInputRule = $inputRule((ctx) => textblockTypeInputRule(/^\$\$\s$/, mathBlockSchema.type(ctx)))

/** 斜杠「公式」：光标所在段落是空的就变成公式块，否则在它后面插一个；光标进公式块 */
export function insertMathBlock(view: EditorView): void {
  const type = view.state.schema.nodes.math_block
  if (!type) return
  const { $from } = view.state.selection
  const tr = view.state.tr
  let at: number
  if ($from.parent.type.name === 'paragraph' && $from.parent.content.size === 0 && $from.depth >= 1) {
    at = $from.before()
    tr.setBlockType(at, at, type)
  } else {
    at = $from.depth >= 1 ? $from.after() : view.state.selection.to
    tr.insert(at, type.create())
  }
  tr.setSelection(TextSelection.create(tr.doc, at + 1))
  view.dispatch(tr.scrollIntoView())
  view.focus()
}

/** 斜杠「行内公式」：在光标处插一个空行内公式，返回它的位置（调用方随即打开编辑弹层） */
export function insertMathInline(view: EditorView): number | null {
  const type = view.state.schema.nodes.math_inline
  const { $from, from, to } = view.state.selection
  if (!type || !$from.parent.inlineContent || $from.parent.type.spec.code) return null
  view.dispatch(view.state.tr.replaceWith(from, to, type.create({ latex: '' })))
  return from
}
