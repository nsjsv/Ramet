// ---------- 行内方言：颜色标签与 Obsidian 的 `==高亮==` ----------
// 颜色：`<span data-color="red">…</span>` 对应 text_color，`<mark>` / `<mark data-color="blue">` 对应 highlight（缺省黄）；
// 只认带 data-color 的 span（别人的 span 不当颜色）。配对由 transform.ts 的 INLINE_TAGS 机制做。
// `==…==`：同一 phrasing 父节点里成对的 `==`，开的后面、收的前面不能是空白（同强调的规则），不成对原样留下。
// 行内代码是 inlineCode 节点（不是 text），里面的 `==` 不受影响。

import { DEFAULT_HIGHLIGHT, isColorName } from './colors.js'
import { RAMET_MARK, type Md } from './types.js'

const DATA_COLOR_RE = /\bdata-color\s*=\s*["']?([a-z]+)/i

export function colorSpanOpen(html: string): { mark: 'text_color'; color: string } | null {
  if (!/^<span\b[^>]*>$/i.test(html)) return null
  const color = DATA_COLOR_RE.exec(html)?.[1]?.toLowerCase()
  return isColorName(color) ? { mark: 'text_color', color } : null
}

export function highlightOpen(html: string): { mark: 'highlight'; color: string } | null {
  if (!/^<mark\b[^>]*>$/i.test(html)) return null
  const color = DATA_COLOR_RE.exec(html)?.[1]?.toLowerCase()
  return { mark: 'highlight', color: isColorName(color) ? color : DEFAULT_HIGHLIGHT }
}

type EqToken = { type: '__eq'; canOpen: boolean; canClose: boolean }

function isEq(node: Md | EqToken): node is EqToken {
  return node.type === '__eq'
}

/** 文本里的 `==` 拆成标记 token（判定能不能开 / 收） */
function splitEquals(children: Md[]): Array<Md | EqToken> {
  const out: Array<Md | EqToken> = []
  children.forEach((node, index) => {
    const value = node.type === 'text' && typeof node.value === 'string' ? node.value : null
    if (value === null || !value.includes('==')) {
      out.push(node)
      return
    }
    const parts = value.split('==')
    parts.forEach((part, i) => {
      if (i > 0) {
        const before = parts[i - 1]!
        const hasBefore = before !== '' || i > 1 || index > 0
        const hasAfter = part !== '' || i < parts.length - 1 || index < children.length - 1
        out.push({
          type: '__eq',
          canOpen: hasAfter && !/^\s/.test(part),
          canClose: hasBefore && !/\s$/.test(before),
        })
      }
      if (part) out.push({ type: 'text', value: part })
    })
  })
  return out
}

/** 相邻文本合并（拆过 `==` 之后） */
function mergeText(nodes: Md[]): Md[] {
  const out: Md[] = []
  for (const node of nodes) {
    const prev = out[out.length - 1]
    if (node.type === 'text' && prev?.type === 'text') prev.value = `${String(prev.value)}${String(node.value)}`
    else out.push(node)
  }
  return out
}

export function pairEqualsHighlight(children: Md[]): Md[] {
  if (!children.some((c) => c.type === 'text' && typeof c.value === 'string' && c.value.includes('=='))) return children
  const tokens = splitEquals(children)
  const out: Md[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (!isEq(token)) {
      out.push(token)
      continue
    }
    const close = token.canOpen ? tokens.findIndex((t, k) => k > i && isEq(t) && t.canClose) : -1
    if (close > i + 1) {
      const inner = tokens.slice(i + 1, close).map((t) => (isEq(t) ? { type: 'text', value: '==' } : t))
      out.push({ type: RAMET_MARK, mark: 'highlight', color: DEFAULT_HIGHLIGHT, children: mergeText(inner) })
      i = close
      continue
    }
    out.push({ type: 'text', value: '==' })
  }
  return mergeText(out)
}
