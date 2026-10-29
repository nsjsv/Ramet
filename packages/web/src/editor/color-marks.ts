/* ---------- 文字颜色 / 背景高亮 ----------
 * 两个 mark，attrs.color 是调色板名（@ramet/shared/md-dialect 的 COLOR_NAMES，9 色）；显示走 CSS 变量
 * （styles/colors.css，深色主题另一套），文档里不存色值。markdown 写成带 data-color 的 `<span>` / `<mark>`（html-marks.ts），
 * 解析由方言层认（含 Obsidian 的 `==…==`）。同类 mark 互斥，换颜色就是换掉旧的。两个宿主都要 .use 两个 schema。 */

import type { Mark, MarkType } from '@milkdown/kit/prose/model'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import { markRule } from '@milkdown/kit/prose'
import { $inputRule, $markSchema } from '@milkdown/kit/utils'
import { DEFAULT_HIGHLIGHT, isColorName, isRametMark, type Md } from '@ramet/shared/md-dialect'
import { htmlMarksToMarkdown } from './html-marks'

const colorOf = (mark: Mark): string => (isColorName(mark.attrs.color) ? mark.attrs.color : '')

export const textColorSchema = $markSchema('text_color', () => ({
  priority: 90,
  attrs: { color: { default: 'gray' } },
  parseDOM: [
    {
      tag: 'span[data-color]',
      getAttrs: (dom) => {
        const color = dom instanceof HTMLElement ? dom.dataset.color : undefined
        return isColorName(color) ? { color } : false
      },
    },
  ],
  toDOM: (mark) => ['span', { 'data-color': colorOf(mark), class: `tc-${colorOf(mark)}` }, 0],
  parseMarkdown: {
    match: (node) => isRametMark(node as Md) && node.mark === 'text_color',
    runner: (state, node, markType) => {
      state.openMark(markType, { color: node.color })
      state.next(node.children)
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'text_color',
    runner: htmlMarksToMarkdown,
  },
}))

export const highlightSchema = $markSchema('highlight', () => ({
  priority: 90,
  attrs: { color: { default: DEFAULT_HIGHLIGHT } },
  parseDOM: [
    {
      tag: 'mark',
      getAttrs: (dom) => {
        const color = dom instanceof HTMLElement ? dom.dataset.color : undefined
        return { color: isColorName(color) ? color : DEFAULT_HIGHLIGHT }
      },
    },
  ],
  toDOM: (mark) => ['mark', { 'data-color': colorOf(mark), class: `hl-${colorOf(mark)}` }, 0],
  parseMarkdown: {
    match: (node) => isRametMark(node as Md) && node.mark === 'highlight',
    runner: (state, node, markType) => {
      state.openMark(markType, { color: node.color })
      state.next(node.children)
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'highlight',
    runner: htmlMarksToMarkdown,
  },
}))

/** 打字输入 `==文字==`（Obsidian 写法）转黄色高亮；`==` 内侧首尾不能是空白（`a == b` 这种比较不转），同方言层的识别规则 */
export const highlightInputRule = $inputRule((ctx) => markRule(/(?<!=)==([^=\s](?:[^=]*?[^=\s])?)==$/, highlightSchema.type(ctx)))

/** 给选区设 / 清颜色（单事务），color 为空表示去掉这种 mark */
export function setColorMark(name: 'text_color' | 'highlight', color: string) {
  return (state: EditorState, dispatch?: (tr: Transaction) => void): boolean => {
    const type: MarkType | undefined = state.schema.marks[name]
    const { from, to, empty } = state.selection
    if (!type || empty) return false
    if (dispatch) {
      const tr = state.tr.removeMark(from, to, type)
      if (color) tr.addMark(from, to, type.create({ color }))
      dispatch(tr)
    }
    return true
  }
}

/** 选区里第一段字的颜色（菜单打勾用），没有返回 '' */
export function colorInSelection(state: EditorState, name: 'text_color' | 'highlight'): string {
  const type = state.schema.marks[name]
  if (!type) return ''
  let found = ''
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
    if (found) return false
    const mark = node.marks.find((m) => m.type === type)
    if (mark) found = colorOf(mark)
    return true
  })
  return found
}
