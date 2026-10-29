/* ---------- 目录 toc ----------
 * 原子块（块 id 照常）。markdown：段落 `[TOC]`（用行内 html 写出，避免被转义成 `\[TOC]`）；识别在方言层。
 * nodeView 列出文档的顶层标题（与右轨同口径：只看顶层，doc-rail.tsx），点一条跳到那个标题。文档变了由 tocRefresh 插件
 * 通知本视图里的目录重算（标题清单没变不重画）。静态宿主（对话气泡、历史预览）只画 toDOM 的「目录」占位。 */

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $nodeSchema, $prose, $view } from '@milkdown/kit/utils'
import { TOC } from '@ramet/shared/md-dialect'

export const tocSchema = $nodeSchema('toc', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  attrs: { id: { default: '' } },
  parseDOM: [{ tag: 'div[data-toc]' }],
  toDOM: () => ['div', { 'data-toc': '', class: 'toc' }, '目录'],
  parseMarkdown: {
    match: (node) => node.type === TOC,
    runner: (state, _node, type) => {
      state.addNode(type)
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'toc',
    runner: (state) => {
      state.openNode('paragraph')
      state.addNode('html', undefined, '[TOC]')
      state.closeNode()
    },
  },
}))

type Heading = { pos: number; level: number; text: string }

function headings(doc: PMNode): Heading[] {
  const out: Heading[] = []
  doc.forEach((node, offset) => {
    if (node.type.name !== 'heading') return
    const text = node.textContent.trim()
    if (text) out.push({ pos: offset, level: Number(node.attrs.level) || 1, text: text.slice(0, 120) })
  })
  return out
}

const tocViews = new WeakMap<EditorView, Set<() => void>>()

export function createTocView(_node: PMNode, view: EditorView) {
  const dom = document.createElement('div')
  dom.className = 'toc'
  dom.contentEditable = 'false'
  let signature = ''
  const render = (): void => {
    const list = headings(view.state.doc)
    const sig = list.map((h) => `${h.level}:${h.text}`).join('\n')
    if (sig === signature && dom.childElementCount) return
    signature = sig
    if (!list.length) {
      const empty = document.createElement('div')
      empty.className = 'toc-empty'
      empty.textContent = '目录：文档里还没有标题'
      dom.replaceChildren(empty)
      return
    }
    const minLevel = Math.min(...list.map((h) => h.level))
    dom.replaceChildren(
      ...list.map((h, i) => {
        const row = document.createElement('a')
        row.className = 'toc-row'
        row.style.paddingLeft = `${(h.level - minLevel) * 16}px`
        row.textContent = h.text
        row.dataset.index = String(i)
        return row
      }),
    )
  }
  dom.addEventListener('mousedown', (e) => e.preventDefault())
  dom.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.toc-row')
    if (!row) return
    const target = headings(view.state.doc)[Number(row.dataset.index)]
    const el = target ? view.nodeDOM(target.pos) : null
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'start', behavior: 'smooth' })
  })
  let set = tocViews.get(view)
  if (!set) tocViews.set(view, (set = new Set()))
  set.add(render)
  render()
  return {
    dom,
    update: (next: PMNode) => next.type.name === 'toc',
    stopEvent: (event: Event) => event.type !== 'dragstart',
    ignoreMutation: () => true,
    destroy() {
      tocViews.get(view)?.delete(render)
    },
  }
}

export const tocView = $view(tocSchema.node, () => (node, view) => createTocView(node, view))

/** 文档变了：本视图里的目录重算（标题清单没变不重画） */
export const tocRefresh = $prose(
  () =>
    new Plugin({
      key: new PluginKey('RAMET_TOC_REFRESH'),
      view: () => ({
        update: (view, prev) => {
          if (view.state.doc.eq(prev.doc)) return
          for (const render of tocViews.get(view) ?? []) render()
        },
      }),
    }),
)
