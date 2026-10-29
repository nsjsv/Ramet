// ---------- 块级方言规则（transform.ts 的 BLOCK_RULES） ----------
// 每条规则：在一串块级兄弟里从下标 i 起认一段，命中返回方言节点与吃掉的兄弟个数。节点的 children
// 仍是普通 mdast，transformDialect 的递归会继续识别里面的方言（嵌套提示框、折叠块里的分栏等）。
//   提示框  `> [!kind]± 标题`（GitHub / Obsidian），消息块标记 `[!user]` / `[!agent …]` 不算
//   折叠块  `<details[ open]>` `<summary>…</summary>` … `</details>`（拆成多个 html 节点，或没空行时一整块 html）
//   分栏    `<!-- columns -->` … `<!-- column -->` … `<!-- /columns -->`（html 注释，博客里退化成顺序排列）
//   目录    段落正文恰为 `[TOC]`（大小写不敏感）或 `[[_TOC_]]`
//   嵌入    独立一块的 `<iframe src>` / `<video src>` / `<audio src>`（只认 http(s) 与站内 /api/files/ 地址）

import { parseMdast } from './extensions.js'
import { textOf, type Md } from './types.js'

export type BlockRule = (siblings: Md[], index: number) => { node: Md; consumed: number } | null

export const CALLOUT = 'rametCallout'
export const TOGGLE = 'rametToggle'
export const COLUMNS = 'rametColumns'
export const COLUMN = 'rametColumn'
export const TOC = 'rametToc'
export const EMBED = 'rametEmbed'

const emptyParagraph = (): Md => ({ type: 'paragraph', children: [] })

function htmlValue(node: Md | undefined): string | null {
  return node?.type === 'html' && typeof node.value === 'string' ? node.value.trim() : null
}

/** 行内节点的纯文字 */
export function plainText(node: Md): string {
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'inlineMath') return textOf(node.value)
  if (node.type === 'break') return '\n'
  return (node.children ?? []).map(plainText).join('')
}

const CALLOUT_RE = /^\[!([A-Za-z][\w-]*)\]([+-]?)[ \t]*/

const callout: BlockRule = (siblings, i) => {
  const node = siblings[i]!
  if (node.type !== 'blockquote') return null
  const first = node.children?.[0]
  const lead = first?.type === 'paragraph' ? first.children?.[0] : undefined
  if (!first || lead?.type !== 'text') return null
  const m = CALLOUT_RE.exec(textOf(lead.value))
  if (!m) return null
  const kind = m[1]!.toLowerCase()
  if (kind === 'user' || kind === 'agent') return null // 消息块的标记段（message-blocks.ts）
  // 标题 = 标记所在的第一行（行内格式退成纯文字）；第一行之后的内容是正文第一段
  const inline: Md[] = [{ ...lead, value: textOf(lead.value).slice(m[0].length) }, ...(first.children ?? []).slice(1)]
  let title = ''
  const body: Md[] = []
  let inTitle = true
  for (const child of inline) {
    if (!inTitle) {
      body.push(child)
      continue
    }
    if (child.type === 'break') {
      inTitle = false
      continue
    }
    if (child.type === 'text') {
      const value = textOf(child.value)
      const nl = value.indexOf('\n')
      if (nl < 0) {
        title += value
        continue
      }
      title += value.slice(0, nl)
      inTitle = false
      const rest = value.slice(nl + 1)
      if (rest) body.push({ type: 'text', value: rest })
      continue
    }
    title += plainText(child)
  }
  const blocks: Md[] = [...(body.length ? [{ type: 'paragraph', children: body }] : []), ...(node.children ?? []).slice(1)]
  return {
    node: { type: CALLOUT, kind, fold: m[2] ?? '', title: title.trim(), children: blocks.length ? blocks : [emptyParagraph()] },
    consumed: 1,
  }
}

const DETAILS_OPEN_RE = /^<details(\s+open)?\s*>\s*(?:<summary>([\s\S]*?)<\/summary>)?$/i
const DETAILS_WHOLE_RE = /^<details(\s+open)?\s*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>$/i
const DETAILS_CLOSE_RE = /^<\/details>$/i
const SUMMARY_RE = /^<summary>([\s\S]*?)<\/summary>$/i

function decodeEntities(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}

function summaryText(raw: string | undefined): string {
  return decodeEntities((raw ?? '').replace(/<[^>]+>/g, '')).trim()
}

const details: BlockRule = (siblings, i) => {
  const html = htmlValue(siblings[i])
  if (html === null) return null
  const whole = DETAILS_WHOLE_RE.exec(html)
  if (whole) {
    const inner = parseMdast(whole[3] ?? '').children ?? []
    return { node: { type: TOGGLE, summary: summaryText(whole[2]), children: inner }, consumed: 1 }
  }
  const open = DETAILS_OPEN_RE.exec(html)
  if (!open) return null
  let depth = 0
  for (let k = i + 1; k < siblings.length; k++) {
    const value = htmlValue(siblings[k])
    if (value === null) continue
    if (DETAILS_OPEN_RE.test(value)) depth += 1
    else if (DETAILS_CLOSE_RE.test(value)) {
      if (depth > 0) {
        depth -= 1
        continue
      }
      let body = siblings.slice(i + 1, k)
      let summary = open[2]
      const firstHtml = htmlValue(body[0])
      const separate = summary === undefined && firstHtml !== null ? SUMMARY_RE.exec(firstHtml) : null
      if (separate) {
        summary = separate[1]
        body = body.slice(1)
      }
      return { node: { type: TOGGLE, summary: summaryText(summary), children: body }, consumed: k - i + 1 }
    }
  }
  return null
}

const COLS_OPEN_RE = /^<!--\s*columns\s*-->$/i
const COL_SEP_RE = /^<!--\s*column\s*-->$/i
const COLS_CLOSE_RE = /^<!--\s*\/columns\s*-->$/i

const columns: BlockRule = (siblings, i) => {
  const html = htmlValue(siblings[i])
  if (html === null || !COLS_OPEN_RE.test(html)) return null
  let depth = 0
  const cols: Md[][] = [[]]
  for (let k = i + 1; k < siblings.length; k++) {
    const node = siblings[k]!
    const value = htmlValue(node)
    if (value !== null && COLS_OPEN_RE.test(value)) depth += 1
    else if (value !== null && COLS_CLOSE_RE.test(value)) {
      if (depth > 0) depth -= 1
      else {
        while (cols.length < 2) cols.push([])
        const children = cols.map((c) => ({ type: COLUMN, children: c.length ? c : [emptyParagraph()] }))
        return { node: { type: COLUMNS, children }, consumed: k - i + 1 }
      }
    } else if (value !== null && depth === 0 && COL_SEP_RE.test(value)) {
      cols.push([])
      continue
    }
    cols[cols.length - 1]!.push(node)
  }
  return null
}

const TOC_RE = /^\s*(\[toc\]|\[\[_toc_\]\])\s*$/i

const toc: BlockRule = (siblings, i) => {
  const node = siblings[i]!
  if (node.type !== 'paragraph' || node.children?.length !== 1) return null
  const only = node.children[0]!
  return only.type === 'text' && TOC_RE.test(textOf(only.value)) ? { node: { type: TOC }, consumed: 1 } : null
}

const EMBED_RE = /^<(iframe|video|audio)\b([^>]*)>(?:\s*<\/\1>)?$/i

function attr(attrs: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs)
  return decodeEntities(m?.[1] ?? m?.[2] ?? m?.[3] ?? '')
}

/** 嵌入地址只认 http(s) 与站内文件（javascript: / data: 之类一律不认） */
export function safeEmbedSrc(src: string): boolean {
  return /^https?:\/\//i.test(src) || /^\/api\/files\/[\w-]+/.test(src)
}

const embed: BlockRule = (siblings, i) => {
  const html = htmlValue(siblings[i])
  const m = html !== null ? EMBED_RE.exec(html) : null
  if (!m) return null
  const src = attr(m[2] ?? '', 'src')
  if (!safeEmbedSrc(src)) return null
  const height = attr(m[2] ?? '', 'height').replace(/px$/i, '')
  return { node: { type: EMBED, kind: m[1]!.toLowerCase(), src, height: /^\d+$/.test(height) ? height : '' }, consumed: 1 }
}

export const BLOCK_RULES: BlockRule[] = [callout, details, columns, toc, embed]
