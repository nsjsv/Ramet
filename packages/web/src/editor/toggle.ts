/* ---------- 折叠块 toggle ----------
 * content `paragraph block*`：第一段是摘要行（永远显示），其余是可收起的子块。块 id 照常（整个折叠块是一个块）。
 * markdown：`<details>` + `<summary>摘要</summary>` + 正文 + `</details>`（GitHub 能渲染）；摘要只写纯文字，
 * 因为 `<summary>` 里的 markdown 不会被渲染，所以摘要的行内格式不进 markdown。识别在方言层（拆开的 html 与一整块 html 都认）。
 * 展开状态只在本机（fold-state.ts），默认展开。收起时在摘要行末尾按 Enter 是在折叠块后面开一段（不往看不见的地方写）。
 * 块首退格（摘要行开头）整个解包，见 block-backspace.ts。 */

import { keymap } from '@milkdown/kit/prose/keymap'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $nodeSchema, $prose, $view } from '@milkdown/kit/utils'
import { TOGGLE } from '@ramet/shared/md-dialect'
import { iconSvg } from '../icons'
import { isFolded, setFolded } from './fold-state'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const toggleSchema = $nodeSchema('toggle', () => ({
  group: 'block',
  content: 'paragraph block*',
  defining: true,
  attrs: { id: { default: '' } },
  parseDOM: [{ tag: 'div[data-toggle]', contentElement: '.toggle-content' }],
  toDOM: () => ['div', { 'data-toggle': '', class: 'toggle is-open' }, ['div', { class: 'toggle-content' }, 0]],
  parseMarkdown: {
    match: (node) => node.type === TOGGLE,
    runner: (state, node, type) => {
      state.openNode(type)
      const paragraph = state.schema.nodes.paragraph!
      state.openNode(paragraph)
      const summary = str(node.summary)
      if (summary) state.addText(summary)
      state.closeNode()
      state.next(node.children)
      state.closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'toggle',
    runner: (state, node) => {
      const summary = node.firstChild?.textContent ?? ''
      state.addNode('html', undefined, `<details>\n<summary>${escapeHtml(summary)}</summary>`)
      if (node.firstChild) state.next(node.content.cut(node.firstChild.nodeSize))
      state.addNode('html', undefined, '</details>')
    },
  },
}))

// 折叠块的收起状态按块 id 读，nodeView 与 Enter 规则共用
function folded(node: PMNode): boolean {
  return isFolded(str(node.attrs.id), false)
}

export function createToggleView(initial: PMNode, view: EditorView) {
  let node = initial
  const dom = document.createElement('div')
  dom.className = 'toggle'
  const caret = document.createElement('button')
  caret.type = 'button'
  caret.className = 'toggle-caret'
  caret.contentEditable = 'false'
  caret.innerHTML = iconSvg('chevron', 14)
  const content = document.createElement('div')
  content.className = 'toggle-content'
  dom.append(caret, content)

  const paint = (): void => {
    const open = !folded(node)
    dom.classList.toggle('is-open', open)
    caret.setAttribute('aria-expanded', String(open))
    caret.title = open ? '收起' : '展开'
  }
  caret.addEventListener('mousedown', (e) => e.preventDefault())
  caret.addEventListener('click', () => {
    setFolded(str(node.attrs.id), !folded(node), false)
    paint()
    view.dispatch(view.state.tr) // 让依赖收起状态的键位（Enter）与装饰按新状态算
  })
  paint()
  return {
    dom,
    contentDOM: content,
    update(next: PMNode) {
      if (next.type !== node.type) return false
      node = next
      paint()
      return true
    },
    stopEvent: (event: Event) => caret.contains(event.target as Node),
    ignoreMutation(mutation: { type: string; target: Node }) {
      if (mutation.type === 'selection') return false
      return !content.contains(mutation.target) || mutation.target === content && mutation.type === 'attributes'
    },
  }
}

export const toggleView = $view(toggleSchema.node, () => (node, view) => createToggleView(node, view))

/** 收起的折叠块：摘要行末尾按 Enter，在折叠块后面开一段新段落 */
function enterOnFoldedSummary(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const { $from, empty } = state.selection
  if (!empty || $from.depth < 2 || $from.parentOffset !== $from.parent.content.size) return false
  const toggle = $from.node($from.depth - 1)
  if (toggle.type.name !== 'toggle' || $from.index($from.depth - 1) !== 0 || !folded(toggle)) return false
  const paragraph = state.schema.nodes.paragraph
  if (!paragraph) return false
  if (dispatch) {
    const after = $from.after($from.depth - 1)
    const tr = state.tr.insert(after, paragraph.create())
    tr.setSelection(TextSelection.create(tr.doc, after + 1))
    dispatch(tr.scrollIntoView())
  }
  return true
}

export const toggleKeys = $prose(() => keymap({ Enter: enterOnFoldedSummary }))
