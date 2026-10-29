// 嵌入块（网页 / 视频 / 音频）：原子块，attrs：kind（iframe / video / audio）、src（能直接放进 iframe / <video> 的地址，
// 插入时已由 embed-url.ts 转好）、height（像素串，空 = 默认：视频网站 16:9、其它网页 420px）。
// 没有 nodeView：toDOM 直接画播放器（编辑器、公开页、对话气泡、历史预览同一份）。
// 带宽：iframe `loading=lazy`，<video> / <audio> `preload=none`（点了才拉）。安全：只认 http(s) 与站内 /api/files/
// （@ramet/shared/md-dialect 的 safeEmbedSrc），iframe 走 sandbox；不认的地址只显示成文字。
// markdown：一整块 `<iframe src>` / `<video src controls>` / `<audio src controls>`，识别在方言层。

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $nodeSchema } from '@milkdown/kit/utils'
import { EMBED, safeEmbedSrc } from '@ramet/shared/md-dialect'
import { isVideoSite, toEmbed } from './embed-url'

const SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-presentation allow-forms'
const ALLOW = 'fullscreen; picture-in-picture; clipboard-write; encrypted-media'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const escapeAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

function heightOf(node: PMNode): string {
  const h = str(node.attrs.height)
  return /^\d+$/.test(h) ? h : ''
}

export const embedSchema = $nodeSchema('embed', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  attrs: { id: { default: '' }, kind: { default: 'iframe' }, src: { default: '' }, height: { default: '' } },
  parseDOM: [
    {
      tag: 'div[data-embed]',
      getAttrs: (dom) =>
        dom instanceof HTMLElement ? { kind: dom.dataset.embed || 'iframe', src: dom.dataset.src ?? '', height: dom.dataset.height ?? '' } : {},
    },
  ],
  toDOM: (node) => {
    const kind = str(node.attrs.kind)
    const src = str(node.attrs.src)
    const height = heightOf(node)
    const outer = { 'data-embed': kind, 'data-src': src, 'data-height': height, class: `embed embed-${kind}`, contenteditable: 'false' }
    if (!safeEmbedSrc(src)) return ['div', outer, ['span', { class: 'embed-bad' }, src || '（空的嵌入）']]
    if (kind === 'video') return ['div', outer, ['video', { src, controls: '', preload: 'none', playsinline: '' }]]
    if (kind === 'audio') return ['div', outer, ['audio', { src, controls: '', preload: 'none' }]]
    const style = height ? `height: ${height}px` : isVideoSite(src) ? 'aspect-ratio: 16 / 9' : 'height: 420px'
    return [
      'div',
      outer,
      ['iframe', { src, loading: 'lazy', sandbox: SANDBOX, allow: ALLOW, allowfullscreen: 'true', referrerpolicy: 'strict-origin-when-cross-origin', style }],
    ]
  },
  parseMarkdown: {
    match: (node) => node.type === EMBED,
    runner: (state, node, type) => {
      state.addNode(type, { kind: str(node.kind) || 'iframe', src: str(node.src), height: str(node.height) })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'embed',
    runner: (state, node) => {
      const kind = str(node.attrs.kind)
      const src = escapeAttr(str(node.attrs.src))
      const height = heightOf(node)
      const html =
        kind === 'video'
          ? `<video src="${src}" controls preload="none"></video>`
          : kind === 'audio'
            ? `<audio src="${src}" controls preload="none"></audio>`
            : `<iframe src="${src}"${height ? ` height="${height}"` : ''} loading="lazy" allowfullscreen></iframe>`
      state.addNode('html', undefined, html)
    },
  },
}))

/** 在光标处插入嵌入：光标所在段落是空的就换掉它，否则插在它后面 */
function insertEmbed(view: EditorView, kind: string, src: string): void {
  const type = view.state.schema.nodes.embed
  if (!type) return
  const node = type.create({ kind, src, height: '' })
  const { $from } = view.state.selection
  const tr = view.state.tr
  let at: number
  if ($from.parent.type.name === 'paragraph' && $from.parent.content.size === 0 && $from.depth >= 1) {
    at = $from.before()
    tr.replaceWith(at, $from.after(), node)
  } else {
    at = $from.depth >= 1 ? $from.after() : view.state.selection.to
    tr.insert(at, node)
  }
  const after = at + node.nodeSize
  const caret = TextSelection.findFrom(tr.doc.resolve(Math.min(after, tr.doc.content.size)), 1, true)
  if (caret) tr.setSelection(caret)
  view.dispatch(tr.scrollIntoView())
  view.focus()
}

/** 斜杠「嵌入」：在光标下方弹一行输入框，贴链接回车 */
export function promptEmbed(view: EditorView): void {
  const box = document.createElement('div')
  box.className = 'pop-card embed-prompt'
  const input = document.createElement('input')
  input.type = 'url'
  input.placeholder = '粘贴链接：YouTube、B 站、Figma、视频文件……'
  input.spellcheck = false
  const hint = document.createElement('div')
  hint.className = 'embed-prompt-hint'
  hint.textContent = 'Enter 插入 · Esc 取消'
  box.append(input, hint)
  const close = (): void => {
    box.remove()
    document.removeEventListener('mousedown', onOutside, true)
  }
  function onOutside(e: MouseEvent): void {
    if (!box.contains(e.target as Node)) close()
  }
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      view.focus()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = toEmbed(input.value)
      if (!target) {
        hint.textContent = '需要一个 http(s) 链接'
        hint.classList.add('is-error')
        return
      }
      close()
      insertEmbed(view, target.kind, target.src)
    }
  })
  document.body.append(box)
  const at = view.coordsAtPos(view.state.selection.from)
  box.style.left = `${Math.max(8, Math.min(at.left, window.innerWidth - box.offsetWidth - 8))}px`
  box.style.top = `${at.bottom + 6 + box.offsetHeight > window.innerHeight - 8 ? Math.max(8, at.top - box.offsetHeight - 6) : at.bottom + 6}px`
  document.addEventListener('mousedown', onOutside, true)
  input.focus()
}
