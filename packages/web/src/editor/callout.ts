/* ---------- 提示框 callout ----------
 * attrs：kind（原样小写保存，GitHub 五种加 Obsidian 的其它类型）、fold（'' / '+' / '-'，Obsidian 的可折叠标记）、
 * title（纯文字，空则按外观取默认名）。content block+，整个提示框是一个块，里面的块不单独寻址（同引用）。
 * markdown：`> [!NOTE]± 标题` 开头的引用（标记行用行内 html 写出，避免被转义成 `\[`），识别在方言层。
 * 外观按 family 归成五种（note / tip / important / warning / caution），Obsidian 其它类型落到最近的一种。
 * nodeView：头部外壳（图标用来换类型、标题输入、可折叠时的箭头）加正文（contentDOM）。折叠状态只在本机（fold-state.ts）。 */

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $nodeSchema, $view } from '@milkdown/kit/utils'
import { CALLOUT } from '@ramet/shared/md-dialect'
import { iconSvg, type IconName } from '../icons'
import { isFolded, setFolded } from './fold-state'

export type CalloutFamily = 'note' | 'tip' | 'important' | 'warning' | 'caution'

const FAMILY_OF: Record<string, CalloutFamily> = {
  note: 'note', info: 'note', todo: 'note', abstract: 'note', summary: 'note', tldr: 'note', quote: 'note', cite: 'note', example: 'note',
  tip: 'tip', hint: 'tip', success: 'tip', check: 'tip', done: 'tip',
  important: 'important', question: 'important', help: 'important', faq: 'important',
  warning: 'warning', attention: 'warning',
  caution: 'caution', danger: 'caution', error: 'caution', bug: 'caution', failure: 'caution', fail: 'caution', missing: 'caution',
}

export const CALLOUT_LABEL: Record<CalloutFamily, string> = {
  note: '说明',
  tip: '提示',
  important: '重要',
  warning: '警告',
  caution: '危险',
}

export function calloutFamily(kind: unknown): CalloutFamily {
  return FAMILY_OF[typeof kind === 'string' ? kind.toLowerCase() : ''] ?? 'note'
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

export const calloutSchema = $nodeSchema('callout', () => ({
  group: 'block',
  content: 'block+',
  defining: true,
  attrs: { id: { default: '' }, kind: { default: 'note' }, fold: { default: '' }, title: { default: '' } },
  parseDOM: [
    {
      tag: 'div[data-callout]',
      contentElement: '.callout-body',
      getAttrs: (dom) =>
        dom instanceof HTMLElement
          ? { kind: dom.dataset.callout || 'note', fold: dom.dataset.fold ?? '', title: dom.dataset.title ?? '' }
          : {},
    },
  ],
  toDOM: (node) => {
    const family = calloutFamily(node.attrs.kind)
    return [
      'div',
      { 'data-callout': str(node.attrs.kind), 'data-fold': str(node.attrs.fold), 'data-title': str(node.attrs.title), class: `callout callout-${family}` },
      ['div', { class: 'callout-head', contenteditable: 'false' }, str(node.attrs.title) || CALLOUT_LABEL[family]],
      ['div', { class: 'callout-body' }, 0],
    ]
  },
  parseMarkdown: {
    match: (node) => node.type === CALLOUT,
    runner: (state, node, type) => {
      state.openNode(type, { kind: str(node.kind) || 'note', fold: str(node.fold), title: str(node.title) })
      state.next(node.children)
      state.closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'callout',
    runner: (state, node) => {
      const title = str(node.attrs.title)
      state.openNode('blockquote')
      state.openNode('paragraph')
      state.addNode('html', undefined, `[!${(str(node.attrs.kind) || 'note').toUpperCase()}]${str(node.attrs.fold)}${title ? ` ${escapeHtml(title)}` : ''}`)
      state.closeNode()
      state.next(node.content)
      state.closeNode()
    },
  },
}))

/* ---------- nodeView ---------- */

let closeKindMenu: (() => void) | null = null

function openKindMenu(anchor: HTMLElement, current: CalloutFamily, pick: (family: CalloutFamily) => void): void {
  closeKindMenu?.()
  const box = document.createElement('div')
  box.className = 'pop-card callout-kind-menu'
  for (const family of Object.keys(CALLOUT_LABEL) as CalloutFamily[]) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = `pop-row callout-${family}` + (family === current ? ' is-current' : '')
    row.innerHTML = `<span class="callout-ic">${iconSvg(`callout-${family}` as IconName, 16)}</span><span class="pop-t">${CALLOUT_LABEL[family]}</span>`
    row.addEventListener('mousedown', (e) => e.preventDefault())
    row.addEventListener('click', () => {
      close()
      pick(family)
    })
    box.append(row)
  }
  const close = (): void => {
    box.remove()
    document.removeEventListener('mousedown', onOutside, true)
    if (closeKindMenu === close) closeKindMenu = null
  }
  function onOutside(e: MouseEvent): void {
    if (!box.contains(e.target as Node) && !anchor.contains(e.target as Node)) close()
  }
  document.body.append(box)
  const rect = anchor.getBoundingClientRect()
  box.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - box.offsetWidth - 8))}px`
  box.style.top = `${rect.bottom + 4 + box.offsetHeight > window.innerHeight - 8 ? Math.max(8, rect.top - box.offsetHeight - 4) : rect.bottom + 4}px`
  document.addEventListener('mousedown', onOutside, true)
  closeKindMenu = close
}

export function createCalloutView(initial: PMNode, view: EditorView, getPos: () => number | undefined) {
  let node = initial
  const dom = document.createElement('div')
  const head = document.createElement('div')
  head.className = 'callout-head'
  head.contentEditable = 'false'
  const icon = document.createElement('button')
  icon.type = 'button'
  icon.className = 'callout-ic'
  const title = document.createElement('input')
  title.className = 'callout-title'
  title.spellcheck = false
  const caret = document.createElement('button')
  caret.type = 'button'
  caret.className = 'callout-fold'
  caret.innerHTML = iconSvg('chevron', 12)
  head.append(icon, title, caret)
  const body = document.createElement('div')
  body.className = 'callout-body'
  dom.append(head, body)

  const setAttrs = (patch: Record<string, string>): void => {
    const pos = getPos()
    if (pos === undefined || !view.editable) return
    const current = view.state.doc.nodeAt(pos)
    if (!current || current.type !== node.type) return
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, ...patch }))
  }
  const paint = (): void => {
    const family = calloutFamily(node.attrs.kind)
    const fold = str(node.attrs.fold)
    dom.className = `callout callout-${family}`
    dom.dataset.callout = str(node.attrs.kind)
    icon.innerHTML = iconSvg(`callout-${family}` as IconName, 16)
    icon.title = view.editable ? '换类型' : CALLOUT_LABEL[family]
    title.placeholder = CALLOUT_LABEL[family]
    if (document.activeElement !== title) title.value = str(node.attrs.title)
    title.readOnly = !view.editable
    caret.hidden = !fold
    const folded = fold !== '' && isFolded(str(node.attrs.id), fold === '-')
    dom.classList.toggle('is-folded', folded)
  }

  head.addEventListener('mousedown', (e) => {
    if (e.target !== title) e.preventDefault() // 外壳按钮不抢焦点，标题输入框要能拿焦点
  })
  icon.addEventListener('click', () => {
    if (!view.editable) return
    openKindMenu(icon, calloutFamily(node.attrs.kind), (family) => setAttrs({ kind: family }))
  })
  let titleTimer: number | undefined
  title.addEventListener('input', () => {
    window.clearTimeout(titleTimer)
    titleTimer = window.setTimeout(() => setAttrs({ title: title.value.trim() }), 300)
  })
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      window.clearTimeout(titleTimer)
      setAttrs({ title: title.value.trim() })
      view.focus()
    }
  })
  title.addEventListener('blur', () => {
    window.clearTimeout(titleTimer)
    if (title.value.trim() !== str(node.attrs.title)) setAttrs({ title: title.value.trim() })
  })
  caret.addEventListener('click', () => {
    const fold = str(node.attrs.fold)
    setFolded(str(node.attrs.id), !dom.classList.contains('is-folded'), fold === '-')
    paint()
  })
  paint()

  return {
    dom,
    contentDOM: body,
    update(next: PMNode) {
      if (next.type !== node.type) return false
      node = next
      paint()
      return true
    },
    stopEvent: (event: Event) => head.contains(event.target as Node),
    ignoreMutation(mutation: { type: string; target: Node }) {
      if (mutation.type === 'selection') return false
      return !body.contains(mutation.target) || mutation.target === body && mutation.type === 'attributes'
    },
    destroy() {
      window.clearTimeout(titleTimer)
    },
  }
}

export const calloutView = $view(calloutSchema.node, () => createCalloutView)
