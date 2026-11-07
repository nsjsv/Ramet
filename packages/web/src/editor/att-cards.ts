/* ---------- 消息附件：清单 + 卡片（对话输入框的托盘、A 摆法下气泡上方共用） ----------
 * 附件 = 一条消息里的图片、文件引用、块引用、页面提及，按文档序（agent / 成员点名是在叫人，不算）。输入框（composer-input.tsx 自己的 schema）与文档里的消息
 * （主 schema）节点名、attrs 口径一致，一个 attItemsOf 两边通用。
 * 正文里对应的 token 是同序的 DOM（ATT_TOKEN 选中的元素，toDOM 出来的 class）：第 i 张卡片 ⇄ 第 i 个 token，
 * 悬停联动（att-hover.ts）只靠这个序号，不在 DOM 上另记身份。「图 N / 引用 N / 页面 N」的 N 与 CSS counter（styles/attach.css）同序。 */
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { iconSvg } from '../icons'
import { fileName } from './file-mention'
import { toDisplay } from './media'
import { mentionLabel } from './mention-query'

export type AttItem =
  | { kind: 'image'; src: string; preview: string; key: string; state: 'ok' | 'uploading' | 'failed' }
  | { kind: 'file'; path: string }
  | { kind: 'quote'; text: string }
  | { kind: 'page'; title: string }

/** 算附件的节点（attItemsOf 收的就是它们） */
export const ATT_NODES: ReadonlySet<string> = new Set(['image', 'file_mention', 'block_ref', 'page_mention'])

/** 正文里附件 token 的选择器：图片 wrapper / 文件引用 / 块引用 / 页面提及（顺序与 attItemsOf 一致） */
export const ATT_TOKEN = '.img-wrap, .file-mention, .block-ref, .page-mention'

const C = {
  image: (n: number) => `图 ${n}`,
  quote: (n: number) => `引用 ${n}`,
  page: (n: number) => `页面 ${n}`,
  remove: '移除',
  uploading: '上传中…',
  failed: '上传失败，不会随消息发出',
}

/** 一段内容里的附件，文档序 */
export function attItemsOf(root: PMNode): AttItem[] {
  const out: AttItem[] = []
  root.descendants((n) => {
    const a = n.attrs as Record<string, unknown>
    if (n.type.name === 'image') {
      const src = typeof a.src === 'string' ? a.src : ''
      const preview = typeof a.preview === 'string' && a.preview ? a.preview : toDisplay(src)
      const state = a.failed === true ? 'failed' : src ? 'ok' : 'uploading'
      out.push({ kind: 'image', src, preview, key: typeof a.key === 'string' ? a.key : '', state })
    } else if (n.type.name === 'file_mention') out.push({ kind: 'file', path: typeof a.path === 'string' ? a.path : '' })
    else if (n.type.name === 'block_ref') out.push({ kind: 'quote', text: typeof a.text === 'string' ? a.text : '' })
    else if (n.type.name === 'page_mention') out.push({ kind: 'page', title: mentionLabel(typeof a.title === 'string' ? a.title : '') })
  })
  return out
}

/** 每个附件在托盘摆法的正文里显示的名字：图 N / 引用 N / 页面 N 按各自出现的次序编号，文件是文件名 */
export function attLabels(items: readonly AttItem[]): string[] {
  let images = 0
  let quotes = 0
  let pages = 0
  return items.map((it) => {
    if (it.kind === 'image') return C.image(++images)
    if (it.kind === 'quote') return C.quote(++quotes)
    if (it.kind === 'page') return C.page(++pages)
    return fileName(it.path)
  })
}

const el = (tag: string, cls: string, text?: string): HTMLElement => {
  const node = document.createElement(tag)
  node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

/** 一张卡片。onRemove 给了就带 ×（输入框托盘），气泡上方的只读 */
export function attCard(item: AttItem, label: string, onRemove?: () => void): HTMLElement {
  const card = el('div', `att-card is-${item.kind}`)
  if (item.kind === 'image') {
    card.classList.toggle('is-uploading', item.state === 'uploading')
    card.classList.toggle('is-failed', item.state === 'failed')
    if (item.state !== 'ok') card.dataset.tip = item.state === 'failed' ? C.failed : C.uploading
    const box = el('span', 'att-card-img')
    const img = document.createElement('img')
    img.src = item.preview
    img.alt = ''
    img.draggable = false
    box.append(img)
    card.append(box, el('span', 'att-card-badge', label))
  } else {
    const ico = el('span', 'att-card-ico')
    ico.innerHTML = iconSvg(item.kind === 'file' ? 'code-block' : item.kind === 'page' ? 'file' : 'blockquote', 16)
    const text = el('span', 'att-card-text')
    if (item.kind === 'file') {
      const dir = item.path.split('/').slice(0, -1).join('/')
      text.append(el('span', 'att-card-title', label), el('span', 'att-card-sub', dir || './'))
      card.dataset.tip = item.path
    } else {
      const title = item.kind === 'page' ? item.title : item.text
      text.append(el('span', 'att-card-title', title || label), el('span', 'att-card-sub', label))
      // 标题 / 片段长了会被截断，悬停看全文
      if (title) card.dataset.tip = title
    }
    card.append(ico, text)
  }
  if (onRemove) {
    const x = el('button', 'att-card-x')
    x.setAttribute('type', 'button')
    x.setAttribute('aria-label', C.remove)
    x.innerHTML = iconSvg('x', 10)
    // 不抢输入框焦点：删完光标还在原处
    x.addEventListener('mousedown', (e) => e.preventDefault())
    x.addEventListener('click', (e) => {
      e.stopPropagation()
      onRemove()
    })
    card.append(x)
  }
  return card
}

/** 卡片的身份（托盘重画时复用没变的卡片，入场动画只给新来的） */
export function attKey(item: AttItem, label: string): string {
  if (item.kind === 'image') return `i:${item.key || item.src}:${item.state}:${label}`
  if (item.kind === 'page') return `p:${item.title}:${label}`
  return item.kind === 'file' ? `f:${item.path}` : `q:${item.text}:${label}`
}
