// 网页书签卡：原子块，attrs 只有 url（与块 id）。标题 / 描述 / 预览图 / 站点图标不进文档，
// 卡片渲染时向服务端要（server link-preview.ts 现抓、只放内存），图片直接外链（no-referrer）。站点挂了就只显示链接。
// toDOM 是没有元信息的骨架卡（历史预览等只装 schema 的地方也能点开）；bookmarkView(fetchMeta) 补元信息：
// 编辑器传登录端点，公开页传带页面 id 的公开端点。取数与缓存在 link-meta.ts（与行内网页提及共用）。
// markdown：独占一段的 `<a href="…" data-bookmark>…</a>`，识别在方言层（@ramet/shared/md-dialect 的 BOOKMARK）。

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { $nodeSchema, $view } from '@milkdown/kit/utils'
import { BOOKMARK, safeBookmarkUrl } from '@ramet/shared/md-dialect'
import type { LinkMeta } from '../api'
import { el, hostOf, iconOf, metaOf, remoteImg, type FetchLinkMeta } from './link-meta'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const escapeAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

export const bookmarkSchema = $nodeSchema('bookmark', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  attrs: { id: { default: '' }, url: { default: '' } },
  parseDOM: [
    {
      tag: 'div[data-bookmark]',
      getAttrs: (dom) => (dom instanceof HTMLElement ? { url: dom.dataset.url ?? '' } : {}),
    },
  ],
  toDOM: (node) => {
    const url = str(node.attrs.url)
    const outer = { 'data-bookmark': '', 'data-url': url, class: 'bookmark', contenteditable: 'false' }
    if (!safeBookmarkUrl(url)) return ['div', outer, ['span', { class: 'bookmark-bad' }, url || '（空的书签）']]
    return [
      'div',
      outer,
      [
        'a',
        { class: 'bookmark-card', href: url, target: '_blank', rel: 'noopener noreferrer' },
        ['span', { class: 'bookmark-body' }, ['span', { class: 'bookmark-title' }, hostOf(url)], ['span', { class: 'bookmark-link' }, ['span', { class: 'bookmark-url' }, url]]],
      ],
    ]
  },
  parseMarkdown: {
    match: (node) => node.type === BOOKMARK,
    runner: (state, node, type) => {
      state.addNode(type, { url: str(node.url) })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'bookmark',
    runner: (state, node) => {
      const url = str(node.attrs.url)
      state.addNode('html', undefined, `<a href="${escapeAttr(url)}" data-bookmark>${escapeText(url)}</a>`)
    },
  },
}))

/** 画一张卡（meta = null：还没到 / 抓不到，只有域名与地址） */
function renderCard(dom: HTMLElement, url: string, meta: LinkMeta | null): void {
  dom.replaceChildren()
  dom.dataset.url = url
  if (!safeBookmarkUrl(url)) {
    dom.append(el('span', 'bookmark-bad', url || '（空的书签）'))
    return
  }
  const card = el('a', 'bookmark-card')
  card.href = url
  card.target = '_blank'
  card.rel = 'noopener noreferrer'
  const body = el('span', 'bookmark-body')
  body.append(el('span', 'bookmark-title', meta?.title || hostOf(url)))
  if (meta?.description) body.append(el('span', 'bookmark-desc', meta.description))
  const link = el('span', 'bookmark-link')
  const icon = meta ? iconOf(meta, url) : undefined
  if (icon) link.append(remoteImg(icon, 'bookmark-favicon', (img) => img.remove()))
  link.append(el('span', 'bookmark-url', url))
  body.append(link)
  card.append(body)
  if (meta?.image) {
    const cover = el('span', 'bookmark-cover')
    cover.append(remoteImg(meta.image, '', () => cover.remove()))
    card.append(cover)
  }
  dom.append(card)
}

/** 书签卡的 nodeView。scope 区分取数通道（缓存键用），fetchMeta 是该通道的取数函数 */
export function bookmarkView(scope: string, fetchMeta: FetchLinkMeta) {
  return $view(bookmarkSchema.node, () => (initial: PMNode) => {
    let url = str(initial.attrs.url)
    const dom = el('div', 'bookmark')
    dom.setAttribute('data-bookmark', '')
    dom.contentEditable = 'false'
    const load = (): void => {
      const want = url
      renderCard(dom, want, null)
      if (!safeBookmarkUrl(want)) return
      dom.classList.add('is-loading')
      void metaOf(scope, want, fetchMeta).then((meta) => {
        if (url !== want) return // 等待期间地址被改了：以新地址那次为准
        dom.classList.remove('is-loading')
        if (meta) renderCard(dom, want, meta)
      })
    }
    load()
    return {
      dom,
      update: (node: PMNode) => {
        if (node.type.name !== 'bookmark') return false
        const next = str(node.attrs.url)
        if (next !== url) {
          url = next
          load()
        }
        return true
      },
      // 卡片里的 DOM 全由这里画，PM 不必观察
      ignoreMutation: () => true,
    }
  })
}

/** 把 [from, to) 这一整块换成书签，光标落到书签后面（后面没有可落脚的文本块就补一个空段落） */
export function replaceWithBookmark(state: EditorState, from: number, to: number, url: string): Transaction | null {
  const type = state.schema.nodes.bookmark
  if (!type) return null
  const node = type.create({ url })
  const tr = state.tr.replaceWith(from, to, node)
  const after = from + node.nodeSize
  const $after = tr.doc.resolve(Math.min(after, tr.doc.content.size))
  let caret = TextSelection.findFrom($after, 1, true)
  if (!caret || caret.from > after + 2) {
    const para = state.schema.nodes.paragraph
    if (para) {
      tr.insert(after, para.create())
      caret = TextSelection.create(tr.doc, after + 1)
    }
  }
  if (caret) tr.setSelection(caret)
  return tr.scrollIntoView()
}

/** 在 pos（某个块的结束位置）后面插一张书签，选区不动 */
export function insertBookmarkAfter(state: EditorState, pos: number, url: string): Transaction | null {
  const type = state.schema.nodes.bookmark
  if (!type) return null
  return state.tr.insert(pos, type.create({ url }))
}

/** 悬停栏「转成书签」：链接独占一段 → 整段换成书签；在句中 → 文字留着，在该段下面插一张书签。
 * 非 http(s) 链接、所在容器放不下块（表格单元格之类）= null */
export function linkToBookmark(state: EditorState, from: number, to: number, href: string): Transaction | null {
  const type = state.schema.nodes.bookmark
  if (!type || !safeBookmarkUrl(href)) return null
  const $from = state.doc.resolve(from)
  if (!$from.parent.isTextblock || $from.depth < 1) return null
  const start = $from.before()
  const end = $from.after()
  const $start = state.doc.resolve(start)
  const whole = $from.parent.type.name === 'paragraph' && $from.parent.textContent.trim() === state.doc.textBetween(from, to).trim()
  if (whole && $start.parent.canReplaceWith($start.index(), $start.index() + 1, type)) return replaceWithBookmark(state, start, end, href)
  const $end = state.doc.resolve(end)
  if (!$end.parent.canReplaceWith($end.index(), $end.index(), type)) return null
  return insertBookmarkAfter(state, end, href)?.scrollIntoView() ?? null
}
