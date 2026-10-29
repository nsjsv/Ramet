// 公式的 nodeView 与行内公式编辑弹层。
// 行内（math_inline）：span 外壳，KaTeX 画；可编辑视图里点一下（或选中后按 Enter）打开编辑弹层：输入框 + 实时预览，
// Enter 确认、Shift+Enter 换行、Esc 取消；确认时清空 = 删掉这个公式。弹层挂 body，一次只开一个。
// 块（math_block）：上面是 KaTeX 画的结果（外壳），下面是源码（contentDOM，code 类块照常编辑）；源码只在光标在块里
// （active-block.ts 的 is-active）或公式为空时显示。点画出来的结果 = 把光标放进源码末尾。
// 编辑器 / 公开页经 mathInlineView / mathBlockView 注册；历史预览直接用 createMathInlineView / createMathBlockView。

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $view } from '@milkdown/kit/utils'
import { mathBlockSchema, mathInlineSchema } from './math'
import { renderMath } from './math-render'
import { shellMutationFilter } from './shell-mutation'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

let closeEditor: (() => void) | null = null

export function openInlineMathEditor(view: EditorView, pos: number): void {
  closeEditor?.()
  const node = view.state.doc.nodeAt(pos)
  if (!node || node.type.name !== 'math_inline' || !view.editable) return
  const box = document.createElement('div')
  box.className = 'pop-card math-editor'
  const input = document.createElement('textarea')
  input.className = 'math-editor-input'
  input.rows = 1
  input.spellcheck = false
  input.placeholder = '输入 LaTeX，例如 E = mc^2'
  input.value = str(node.attrs.latex)
  const preview = document.createElement('div')
  preview.className = 'math-editor-preview'
  const hint = document.createElement('div')
  hint.className = 'math-editor-hint'
  hint.textContent = 'Enter 确认 · Shift+Enter 换行 · Esc 取消'
  box.append(input, preview, hint)

  const fit = (): void => {
    input.style.height = 'auto'
    input.style.height = `${input.scrollHeight}px`
    renderMath(preview, input.value, false)
  }
  let done = false
  const finish = (commit: boolean): void => {
    if (done) return
    done = true
    box.remove()
    document.removeEventListener('mousedown', onOutside, true)
    if (closeEditor === cancel) closeEditor = null
    if (view.isDestroyed) return
    const current = view.state.doc.nodeAt(pos)
    if (!current || current.type.name !== 'math_inline') return
    const latex = commit ? input.value.trim() : str(current.attrs.latex)
    const tr = view.state.tr
    if (!latex) tr.delete(pos, pos + current.nodeSize)
    else if (latex !== str(current.attrs.latex)) tr.setNodeMarkup(pos, undefined, { ...current.attrs, latex })
    const after = latex ? pos + current.nodeSize : pos
    tr.setSelection(TextSelection.create(tr.doc, Math.min(after, tr.doc.content.size)))
    view.dispatch(tr)
    view.focus()
  }
  const cancel = (): void => finish(false)
  function onOutside(e: MouseEvent): void {
    if (!box.contains(e.target as Node)) finish(true)
  }
  input.addEventListener('input', fit)
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish(false)
    }
  })

  document.body.append(box)
  const anchor = view.nodeDOM(pos)
  const rect = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : view.coordsAtPos(pos)
  const left = 'left' in rect ? rect.left : 0
  const bottom = rect.bottom
  box.style.left = `${Math.max(8, Math.min(left, window.innerWidth - box.offsetWidth - 8))}px`
  box.style.top = `${bottom + 6 + box.offsetHeight > window.innerHeight - 8 ? Math.max(8, rect.top - box.offsetHeight - 6) : bottom + 6}px`
  document.addEventListener('mousedown', onOutside, true)
  closeEditor = cancel
  fit()
  input.focus()
  input.select()
}

export function createMathInlineView(initial: PMNode, view: EditorView, getPos: () => number | undefined) {
  let node = initial
  const dom = document.createElement('span')
  dom.className = 'math-inline'
  dom.contentEditable = 'false'
  renderMath(dom, str(node.attrs.latex), false)
  dom.addEventListener('mousedown', (e) => {
    if (!view.editable) return
    e.preventDefault()
    const pos = getPos()
    if (pos !== undefined) openInlineMathEditor(view, pos)
  })
  return {
    dom,
    update(next: PMNode) {
      if (next.type !== node.type) return false
      if (str(next.attrs.latex) !== str(node.attrs.latex)) renderMath(dom, str(next.attrs.latex), false)
      node = next
      return true
    },
    selectNode() {
      dom.classList.add('is-selected')
    },
    deselectNode() {
      dom.classList.remove('is-selected')
    },
    stopEvent: (event: Event) => event.type === 'mousedown',
    ignoreMutation: () => true,
  }
}

export function createMathBlockView(initial: PMNode, view: EditorView, getPos: () => number | undefined) {
  let node = initial
  const dom = document.createElement('div')
  dom.className = 'math-block'
  const rendered = document.createElement('div')
  rendered.className = 'math-render'
  rendered.contentEditable = 'false'
  const pre = document.createElement('pre')
  pre.className = 'math-src'
  const code = document.createElement('code')
  pre.append(code)
  dom.append(rendered, pre)

  let timer: number | undefined
  let shown: string | null = null
  const paint = (immediate = false): void => {
    const latex = node.textContent
    dom.classList.toggle('is-empty', !latex.trim())
    if (latex === shown) return
    window.clearTimeout(timer)
    const run = (): void => {
      shown = latex
      renderMath(rendered, latex, true)
    }
    if (immediate) run()
    else timer = window.setTimeout(run, 150) // 打字时稍等一下再画，不每个键都排版
  }
  rendered.addEventListener('mousedown', (e) => {
    if (!view.editable) return
    e.preventDefault()
    const pos = getPos()
    if (pos === undefined) return
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1 + node.content.size)))
    view.focus()
  })
  paint(true)
  return {
    dom,
    contentDOM: code,
    update(next: PMNode) {
      if (next.type !== node.type) return false
      node = next
      paint()
      return true
    },
    stopEvent: (event: Event) => rendered.contains(event.target as Node),
    ignoreMutation: shellMutationFilter(dom, code, [rendered]),
    destroy() {
      window.clearTimeout(timer)
    },
  }
}

export const mathInlineView = $view(mathInlineSchema.node, () => createMathInlineView)
export const mathBlockView = $view(mathBlockSchema.node, () => createMathBlockView)
