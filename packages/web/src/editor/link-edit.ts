// 行内链接的改写与重新定位（悬浮栏 link-hover.ts 用的纯函数）。
// editLinkTr：「文本 + 链接」表单应用成一个事务（一步撤销）：
//   文字没变 = 只换地址（removeMark + addMark，链接文字上的加粗 / 颜色等原样保留；不走 toggleMark，见 link-input.ts）；
//   文字改了 = 整段换成新文字，沿用原链接第一个字符上的 mark（链接本身换成新地址）；
//   文字清空 = 用地址作文字；地址清空 = 摘掉链接留文字；都没变 = null（不写文档）。
// findLink：正文变了以后找回悬浮栏盯着的那条链接。协同对端的改动经 y-prosemirror 是整篇替换的事务，位置映射不可用，
//   所以按内容找：同一 href 的链接里文字相同的优先，再取离原位置最近的；找不到 = 链接没了。

import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import { linkRangesIn, normalizeHref, type LinkRange } from './link-input'

/** 悬浮栏上的缩略地址：去掉 http(s):// / mailto: 与开头的 www.，只剩域名时去掉末尾的 / */
export function shortHref(href: string): string {
  return href
    .replace(/^(https?:\/\/|mailto:)/i, '')
    .replace(/^www\./i, '')
    .replace(/^([^/?#]+)\/$/, '$1')
}

/** 复制用的完整地址：站内相对地址（/page/…）补上 origin */
export function absoluteHref(href: string, origin: string): string {
  return href.startsWith('/') && !href.startsWith('//') ? origin + href : href
}

export function editLinkTr(state: EditorState, range: LinkRange, rawText: string, rawHref: string): Transaction | null {
  const link = state.schema.marks.link
  if (!link) return null
  const { from, to } = range
  const href = normalizeHref(rawHref)
  const oldText = state.doc.textBetween(from, to)
  const text = rawText.trim() ? rawText : href || oldText
  if (text === oldText && href === range.href) return null
  const first = state.doc.nodeAt(from)
  const old = first?.marks.find((m) => m.type === link)
  const next = href ? link.create({ ...old?.attrs, href }) : null
  const tr = state.tr
  if (text === oldText) {
    tr.removeMark(from, to, link)
    if (next) tr.addMark(from, to, next)
    return tr
  }
  const marks = link.removeFromSet(first?.marks ?? [])
  tr.replaceWith(from, to, state.schema.text(text, next ? next.addToSet(marks) : marks))
  return tr
}

export function findLink(state: EditorState, want: { href: string; text: string; from: number }): LinkRange | null {
  const link = state.schema.marks.link
  if (!link) return null
  let best: LinkRange | null = null
  let bestScore = Infinity
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    for (const r of linkRangesIn(node, pos + 1, link)) {
      if (r.href !== want.href) continue
      const score = (state.doc.textBetween(r.from, r.to) === want.text ? 0 : 1e9) + Math.abs(r.from - want.from)
      if (score < bestScore) {
        best = r
        bestScore = score
      }
    }
    return false
  })
  return best
}
