// 网页提及：行内原子胶囊「站点图标 + 网页标题」，attrs 只有 url。标题与图标不进文档，渲染时现取（link-meta.ts，
// 与书签卡共用取数和缓存）；取不到就显示域名。整颗是一个链接：编辑器里点击走 link-nav 的外链打开，公开页原生新标签。
// toDOM 是只有域名的骨架（历史预览等只装 schema 的地方也能点开）；linkMentionView(scope, fetchMeta) 补标题和图标。
// markdown：行内的 `<a href="…" data-mention>…</a>`，识别在方言层（@ramet/shared/md-dialect 的 LINK_MENTION），
// 别的 markdown 渲染器里就是一个普通链接。

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { $nodeSchema, $view } from '@milkdown/kit/utils'
import { LINK_MENTION, safeBookmarkUrl } from '@ramet/shared/md-dialect'
import type { LinkMeta } from '../api'
import { el, hostOf, iconOf, metaOf, remoteImg, type FetchLinkMeta } from './link-meta'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const escapeAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

export const LINK_MENTION_ATTR = 'data-link-mention'

export const linkMentionSchema = $nodeSchema('link_mention', () => ({
  inline: true,
  group: 'inline',
  atom: true, // 光标进不去，Backspace 一次删整颗
  attrs: { url: { default: '' } },
  parseDOM: [
    {
      tag: `span[${LINK_MENTION_ATTR}]`,
      getAttrs: (dom) => (dom instanceof HTMLElement ? { url: dom.getAttribute(LINK_MENTION_ATTR) ?? '' } : {}),
    },
  ],
  toDOM: (node) => {
    const url = str(node.attrs.url)
    const outer = { class: 'link-mention', [LINK_MENTION_ATTR]: url }
    if (!safeBookmarkUrl(url)) return ['span', outer, url]
    return ['span', outer, ['a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, ['span', { class: 'link-mention-title' }, hostOf(url)]]]
  },
  parseMarkdown: {
    match: (node) => node.type === LINK_MENTION,
    runner: (state, node, type) => {
      state.addNode(type, { url: str(node.url) })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'link_mention',
    runner: (state, node) => {
      const url = str(node.attrs.url)
      state.addNode('html', undefined, `<a href="${escapeAttr(url)}" data-mention>${escapeText(url)}</a>`)
    },
  },
}))

/** 画一颗（meta = null：还没到 / 取不到，只有域名） */
function render(dom: HTMLElement, url: string, meta: LinkMeta | null): void {
  dom.replaceChildren()
  dom.setAttribute(LINK_MENTION_ATTR, url)
  if (!safeBookmarkUrl(url)) {
    dom.textContent = url
    return
  }
  const a = el('a', '')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  a.title = url
  const icon = meta ? iconOf(meta, url) : undefined
  if (icon) a.append(remoteImg(icon, 'link-mention-icon', (img) => img.remove()))
  a.append(el('span', 'link-mention-title', meta?.title || meta?.site || hostOf(url)))
  dom.append(a)
}

/** 网页提及的 nodeView。scope / fetchMeta 同书签卡（bookmarkView） */
export function linkMentionView(scope: string, fetchMeta: FetchLinkMeta) {
  return $view(linkMentionSchema.node, () => (initial: PMNode) => {
    let url = str(initial.attrs.url)
    const dom = el('span', 'link-mention')
    const load = (): void => {
      const want = url
      render(dom, want, null)
      if (!safeBookmarkUrl(want)) return
      void metaOf(scope, want, fetchMeta).then((meta) => {
        if (url === want && meta) render(dom, want, meta)
      })
    }
    load()
    return {
      dom,
      update: (node: PMNode) => {
        if (node.type.name !== 'link_mention') return false
        const next = str(node.attrs.url)
        if (next !== url) {
          url = next
          load()
        }
        return true
      },
      ignoreMutation: () => true,
    }
  })
}
