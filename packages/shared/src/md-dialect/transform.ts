// ---------- 方言识别：在 mdast 上把方言写法改写成方言节点（纯函数、递归、幂等） ----------
// 两张表，各特性往里登记，别处不另写识别：
//   BLOCK_RULES：块级（blocks.ts），在一串块级兄弟里从下标 i 起认一段（提示框、折叠块、分栏、目录、嵌入），
//                命中返回替换节点与吃掉的兄弟个数；
//   INLINE_TAGS：行内成对 HTML 标签，同一 phrasing 父节点里开标签与之后配对的闭标签之间的节点包成 rametMark。
// 识别只在解析方向跑（milkdown 的 remark 插件 transformer / 服务端 parseMarkdown），序列化方向不经过这里。

import { BLOCK_RULES } from './blocks.js'
import { colorSpanOpen, highlightOpen, pairEqualsHighlight } from './inline.js'
import { revertFalseInlineMath } from './math.js'
import { RAMET_MARK, type MarkName, type Md } from './types.js'

export { BLOCK_RULES, type BlockRule } from './blocks.js'

export type InlineTag = {
  /** 标签名（小写），开 / 闭标签按它配对 */
  tag: string
  /** 开标签 html 的原文 → mark 与属性；不认 = null */
  open: (html: string) => { mark: MarkName; color?: string } | null
}

/** 行内成对标签（按登记顺序试） */
export const INLINE_TAGS: InlineTag[] = [
  { tag: 'u', open: (html) => (/^<u\s*>$/i.test(html) ? { mark: 'underline' } : null) },
  { tag: 'span', open: colorSpanOpen },
  { tag: 'mark', open: highlightOpen },
]

/** 行内内容的父节点类型：它们的 children 是 phrasing */
const PHRASING_PARENTS = new Set(['paragraph', 'heading', 'tableCell', 'emphasis', 'strong', 'delete', 'link', 'linkReference', RAMET_MARK])

const CLOSE_RE = /^<\/([a-z][a-z0-9-]*)\s*>$/i
const OPEN_NAME_RE = /^<([a-z][a-z0-9-]*)[\s>/]/i

function htmlValue(node: Md | undefined): string | null {
  return node?.type === 'html' && typeof node.value === 'string' ? node.value.trim() : null
}

/** 开标签对应的闭标签下标（同名嵌套计数）；没有 = -1 */
function closingIndex(children: Md[], from: number, tag: string): number {
  let depth = 0
  for (let k = from; k < children.length; k++) {
    const html = htmlValue(children[k])
    if (html === null) continue
    const close = CLOSE_RE.exec(html)
    if (close && close[1]!.toLowerCase() === tag) {
      if (depth === 0) return k
      depth -= 1
      continue
    }
    const open = OPEN_NAME_RE.exec(html)
    if (open && open[1]!.toLowerCase() === tag) depth += 1
  }
  return -1
}

export function transformInline(children: Md[]): Md[] {
  return pairTags(pairEqualsHighlight(revertFalseInlineMath(children)))
}

/** 行内成对 HTML 标签包成 rametMark（递归处理包进去的那段） */
function pairTags(children: Md[]): Md[] {
  const out: Md[] = []
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!
    const html = htmlValue(child)
    const name = html !== null ? OPEN_NAME_RE.exec(html)?.[1]?.toLowerCase() : undefined
    const rule = name ? INLINE_TAGS.find((t) => t.tag === name) : undefined
    const opened = rule && html !== null ? rule.open(html) : null
    if (rule && opened) {
      const end = closingIndex(children, i + 1, rule.tag)
      if (end > i) {
        out.push({ type: RAMET_MARK, ...opened, children: pairTags(children.slice(i + 1, end)) })
        i = end
        continue
      }
    }
    out.push(child)
  }
  return out
}

export function transformBlocks(children: Md[]): Md[] {
  if (BLOCK_RULES.length === 0) return children
  const out: Md[] = []
  for (let i = 0; i < children.length; ) {
    let hit: { node: Md; consumed: number } | null = null
    for (const rule of BLOCK_RULES) {
      hit = rule(children, i)
      if (hit) break
    }
    if (hit && hit.consumed > 0) {
      out.push(hit.node)
      i += hit.consumed
    } else {
      out.push(children[i]!)
      i += 1
    }
  }
  return out
}

/** 整棵树就地改写（root 本身对象不换，children 换成识别后的） */
export function transformDialect(root: Md): void {
  const walk = (node: Md): void => {
    if (!node.children) return
    node.children = PHRASING_PARENTS.has(node.type) ? transformInline(node.children) : transformBlocks(node.children)
    for (const child of node.children) walk(child)
  }
  walk(root)
}
