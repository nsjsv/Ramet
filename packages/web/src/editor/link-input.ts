// 链接编辑行：框选工具栏的「链接」按钮与 Mod-K 共用，工具栏切到一行输入框（地址 + 确定 + 移除），Enter 应用、Esc 取消。
// 作用范围在打开时定死（from / to）：有选区 = 选区；折叠光标在链接里 = 整条链接；折叠光标不在链接里 = 在光标处
// 插入一段以地址为文字的链接。应用 = removeMark + addMark 单事务（toggleMark 对已有链接是纯摘除语义，不能用）；
// 空地址 = 只摘链接。
// 输入框在工具栏里，焦点离开编辑器时工具栏仍显示（selection-menu.ts 的 shouldShow 认 content 里的焦点）。

import type { MarkType, Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorState } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { iconSvg } from '../icons'

export type LinkRange = { from: number; to: number; href: string }

/** 一个文本块里的全部链接段（同一个 href 的相邻文本连成一条）；base = 块内容的起点位置 */
export function linkRangesIn(block: PMNode, base: number, link: MarkType): LinkRange[] {
  const out: LinkRange[] = []
  let cur: LinkRange | null = null
  block.forEach((child, offset) => {
    const mark = child.marks.find((m) => m.type === link)
    const from = base + offset
    const to = from + child.nodeSize
    if (mark && cur && cur.href === mark.attrs.href && cur.to === from) cur.to = to
    else {
      cur = mark ? { from, to, href: String(mark.attrs.href ?? '') } : null
      if (cur) out.push(cur)
    }
  })
  return out
}

/** 折叠光标所在链接的整段范围；不在链接里 = null。两条链接首尾相接时取后一条 */
export function linkRangeAt(state: EditorState, pos: number): LinkRange | null {
  const link = state.schema.marks.link
  const $pos = state.doc.resolve(pos)
  if (!link || !$pos.parent.isTextblock) return null
  const hit = linkRangesIn($pos.parent, $pos.start(), link).filter((r) => pos >= r.from && pos <= r.to)
  return hit.at(-1) ?? null
}

/** 选区里第一个链接的地址（输入框默认值） */
export function hrefIn(state: EditorState, from: number, to: number): string {
  let href = ''
  state.doc.nodesBetween(from, to, (node) => {
    const link = node.marks.find((m) => m.type.name === 'link')
    if (link) href = String(link.attrs.href ?? '')
    return !href
  })
  return href
}

/** 用户敲的地址补成可点的链接：像域名（有点、没空格、没协议）补 https://；站内路径、锚点、mailto 原样 */
export function normalizeHref(raw: string): string {
  const url = raw.trim()
  if (!url) return ''
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('/') || url.startsWith('#')) return url
  if (/^[^\s/]+\.[^\s/]+/.test(url)) return `https://${url}`
  return url
}

export function applyLink(view: EditorView, range: { from: number; to: number }, raw: string): void {
  const link = view.state.schema.marks.link
  if (!link) return
  const href = normalizeHref(raw)
  const tr = view.state.tr
  if (range.from === range.to) {
    if (!href) return
    tr.insertText(href, range.from)
    tr.addMark(range.from, range.from + href.length, link.create({ href }))
  } else {
    tr.removeMark(range.from, range.to, link)
    if (href) tr.addMark(range.from, range.to, link.create({ href }))
  }
  view.dispatch(tr.scrollIntoView())
}

export interface LinkEditor {
  row: HTMLElement
  open(view: EditorView, range: LinkRange): void
  close(): void
  isOpen(): boolean
}

/** 造一行链接编辑器，挂进 host（工具栏）。打开时给 host 加 `is-link-mode`（CSS 藏掉格式按钮） */
export function createLinkEditor(host: HTMLElement): LinkEditor {
  const row = document.createElement('div')
  row.className = 'link-row'
  const input = document.createElement('input')
  input.type = 'url'
  input.placeholder = '粘贴或输入链接'
  input.spellcheck = false
  const ok = document.createElement('button')
  ok.type = 'button'
  ok.title = '应用'
  ok.innerHTML = iconSvg('check', 16)
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.title = '移除链接'
  remove.innerHTML = iconSvg('clear-format', 16)
  row.append(input, ok, remove)

  let current: { view: EditorView; range: LinkRange } | null = null

  const close = (): void => {
    host.classList.remove('is-link-mode')
    current = null
  }
  const finish = (href: string | null): void => {
    const target = current
    close()
    if (!target) return
    if (href !== null) applyLink(target.view, target.range, href)
    target.view.focus()
  }
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(input.value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish(null)
    }
  })
  for (const btn of [ok, remove]) btn.addEventListener('mousedown', (e) => e.preventDefault())
  ok.addEventListener('click', () => finish(input.value))
  remove.addEventListener('click', () => finish(''))
  input.addEventListener('blur', () => {
    // 点到工具栏别处 / 编辑器：放弃这次编辑（不改文档）
    window.setTimeout(() => {
      if (current && !row.contains(document.activeElement)) close()
    }, 0)
  })

  return {
    row,
    open(view, range) {
      current = { view, range }
      host.classList.add('is-link-mode')
      input.value = range.href
      remove.hidden = !range.href
      input.focus()
      input.select()
    },
    close,
    isOpen: () => current !== null,
  }
}
