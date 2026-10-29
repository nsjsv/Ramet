// ---------- 页面正文 → Markdown（服务端，保留行内格式）----------
// 提示词口径的 serializeDoc（agents/doc.ts）故意丢掉行内格式，只要读得见的文字；这里给「正文就是文件」的场景用
// （skill 的 SKILL.md 要把页面正文原样交给 agent，行内代码、加粗、链接都不能丢）。
// 只认编辑器里真实存在的节点与 mark（见 @ramet/shared/markdown-blocks 的形状清单）。
// 写法与编辑器的 toMarkdown 一致（下划线 / 颜色是行内 html，公式是 `$…$` / `$$…$$`，提示框 / 折叠块 / 分栏 / 目录 / 嵌入
// 见 @ramet/shared/md-dialect），导回去结构不变。其余自定义块（引用块节点、同步块等）退成它们的可见文字，不报错。

import * as Y from 'yjs'
import { markCloseTag, markOpenTag } from '@ramet/shared/md-dialect'
import { textOf } from './updates.js'

function marked(text: string, attrs: Record<string, unknown>): string {
  if (!text) return text
  if (attrs.inlineCode) return `\`${text.replace(/`/g, '\\`')}\``
  let out = text
  if (attrs.strong) out = `**${out}**`
  if (attrs.emphasis) out = `*${out}*`
  if (attrs.strike_through) out = `~~${out}~~`
  for (const name of ['underline', 'text_color', 'highlight'] as const) {
    const value = attrs[name]
    if (!value) continue
    const color = typeof value === 'object' ? (value as { color?: unknown }).color : undefined
    out = `${markOpenTag(name, color)}${out}${markCloseTag(name)}`
  }
  const link = attrs.link
  const href = link && typeof link === 'object' ? (link as { href?: unknown }).href : undefined
  return typeof href === 'string' && href ? `[${out}](${href})` : out
}

/** 一个文本块的行内内容：XmlText 按 delta 带格式输出，行内原子（换行 / 图片）单独处理，其余取可见文字 */
function inline(el: Y.XmlElement): string {
  let out = ''
  el.forEach((child) => {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as Array<{ insert?: unknown; attributes?: Record<string, unknown> }>) {
        if (typeof op.insert === 'string') out += marked(op.insert, op.attributes ?? {})
        else if (op.insert instanceof Y.XmlElement) out += inlineNode(op.insert)
      }
    } else if (child instanceof Y.XmlElement) out += inlineNode(child)
  })
  return out
}

function inlineNode(el: Y.XmlElement): string {
  if (el.nodeName === 'hardbreak') return '\\\n'
  if (el.nodeName === 'image') {
    const src: unknown = el.getAttribute('src')
    const alt: unknown = el.getAttribute('alt')
    return `![${typeof alt === 'string' ? alt : ''}](${typeof src === 'string' ? src : ''})`
  }
  return textOf(el)
}

function children(el: Y.XmlElement): Y.XmlElement[] {
  const out: Y.XmlElement[] = []
  el.forEach((c) => {
    if (c instanceof Y.XmlElement) out.push(c)
  })
  return out
}

const indent = (text: string, pad: string): string =>
  text
    .split('\n')
    .map((line) => (line ? pad + line : line))
    .join('\n')

function listItem(item: Y.XmlElement, marker: string): string {
  const checked: unknown = item.getAttribute('checked')
  const task = checked === true ? '[x] ' : checked === false ? '[ ] ' : ''
  const [first, ...rest] = children(item).map((b) => block(b))
  const head = `${marker}${task}${first ?? ''}`
  // 条目里的后续块（嵌套列表 / 段落）缩进到标记之后；松散列表（spread）块间空一行，紧凑列表贴着
  const spread: unknown = item.getAttribute('spread')
  const gap = spread === true ? '\n\n' : '\n'
  return rest.length ? `${head}\n${indent(rest.join(gap), ' '.repeat(marker.length))}` : head
}

function table(el: Y.XmlElement): string {
  const rows = children(el).map((row) => children(row).map((cell) => inline(children(cell)[0] ?? cell).replace(/\|/g, '\\|').replace(/\n/g, ' ')))
  if (rows.length === 0) return ''
  const head = `| ${rows[0]!.join(' | ')} |`
  const sep = `| ${rows[0]!.map(() => '---').join(' | ')} |`
  return [head, sep, ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`)].join('\n')
}

function block(el: Y.XmlElement): string {
  switch (el.nodeName) {
    case 'paragraph':
      return inline(el)
    case 'heading': {
      const level = Number(el.getAttribute('level') ?? 1)
      return `${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${inline(el)}`
    }
    case 'code_block': {
      const lang: unknown = el.getAttribute('language')
      const code = textOf(el)
      const fence = code.includes('```') ? '````' : '```'
      return `${fence}${typeof lang === 'string' ? lang : ''}\n${code}\n${fence}`
    }
    case 'math_block':
      return `$$\n${textOf(el)}\n$$`
    case 'blockquote':
      return indent(children(el).map(block).join('\n\n'), '> ').replace(/^(?!> )/gm, '> ')
    case 'hr':
      return '---'
    case 'bullet_list':
      return children(el).map((item) => listItem(item, '- ')).join('\n')
    case 'ordered_list': {
      let n = Number(el.getAttribute('start') ?? el.getAttribute('order') ?? 1)
      if (!Number.isFinite(n)) n = 1
      return children(el).map((item) => listItem(item, `${n++}. `)).join('\n')
    }
    case 'table':
      return table(el)
    case 'callout': {
      const kind = String(el.getAttribute('kind') ?? 'note').toUpperCase()
      const fold = String(el.getAttribute('fold') ?? '')
      const title = String(el.getAttribute('title') ?? '')
      const head = `[!${kind}]${fold}${title ? ` ${title}` : ''}`
      return indent([head, ...children(el).map(block)].join('\n\n'), '> ').replace(/^(?!> )/gm, '> ')
    }
    case 'toggle': {
      const [summary, ...rest] = children(el)
      const text = (summary ? textOf(summary) : '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      return [`<details>\n<summary>${text}</summary>`, ...rest.map(block), '</details>'].join('\n\n')
    }
    case 'columns':
      return ['<!-- columns -->', children(el).map((col) => children(col).map(block).join('\n\n')).join('\n\n<!-- column -->\n\n'), '<!-- /columns -->'].join('\n\n')
    case 'toc':
      return '[TOC]'
    case 'embed': {
      const kind = String(el.getAttribute('kind') ?? 'iframe')
      const src = String(el.getAttribute('src') ?? '').replace(/"/g, '&quot;')
      if (kind === 'video' || kind === 'audio') return `<${kind} src="${src}" controls preload="none"></${kind}>`
      return `<iframe src="${src}" loading="lazy" allowfullscreen></iframe>`
    }
    default:
      return textOf(el)
  }
}

/** 整页正文 → markdown（块之间空一行，首尾去空白） */
export function fragmentToMarkdown(fragment: Y.XmlFragment): string {
  const out: string[] = []
  fragment.forEach((node) => {
    if (node instanceof Y.XmlElement) {
      const md = block(node)
      if (md.trim()) out.push(md)
    }
  })
  return out.join('\n\n').trim()
}
