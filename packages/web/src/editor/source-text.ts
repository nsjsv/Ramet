/* ---------- 源码模式：文档 → 源码文本 ----------
 * 逐个顶层块序列化再拼接，不整篇一次序列化：
 *   - 每个顶层列表只含一个条目（list-blocks.ts 的不变量），整篇序列化时 mdast-util-to-markdown 会给相邻同类列表
 *     交替换记号并隔空行；逐块序列化、相邻同类列表用单个换行拼，才是紧凑的一个列表。
 *   - 每块文字在源码里的归属是确定的，写回时（source-merge.ts）才能按块对齐。
 * 序列化为空串的块（空段落）不进文本也不进 blocks，写回也不碰它们。 */

import type { Node as PMNode } from '@milkdown/kit/prose/model'

export interface SourceDoc {
  text: string
  /** 进了文本的顶层块，顺序同文本 */
  blocks: PMNode[]
}

const isList = (node: PMNode): boolean => node.type.name === 'bullet_list' || node.type.name === 'ordered_list'

/** 相邻两块之间的分隔：同类列表条目紧挨（同一个列表），其余空一行 */
function separator(prev: PMNode, next: PMNode): string {
  return prev.type === next.type && isList(next) ? '\n' : '\n\n'
}

export function sourceOf(doc: PMNode, serializeBlock: (node: PMNode) => string): SourceDoc {
  let text = ''
  const blocks: PMNode[] = []
  doc.forEach((node) => {
    const md = serializeBlock(node)
    if (!md) return
    const prev = blocks[blocks.length - 1]
    text += prev ? separator(prev, node) + md : md
    blocks.push(node)
  })
  return { text, blocks }
}

/** 去掉解析结果里的空段落（markdown 表达不了，源码里也没有），与 sourceOf 跳过空块的口径一致 */
export function visibleParsed(blocks: readonly PMNode[]): PMNode[] {
  return blocks.filter((node) => !(node.type.name === 'paragraph' && node.content.size === 0))
}

/* ---------- 远端改动回流进源码编辑器：最小行级补丁 ----------
 * 新旧文本按行（带行尾换行符）做 LCS，连续的增删并成一处替换；补丁之外的光标 / 选区由编辑器自己映射，不跳。
 * 掐头去尾的相同行不进 LCS 表；中间段行数乘积过大时整段一处替换，O(n·m) 会卡页面。 */

export interface TextPatch {
  from: number
  to: number
  insert: string
}

const MAX_CELLS = 2_000_000

/** 按行切，每行带自己的换行符（最后一行可能没有），末行有没有换行也算内容差异 */
function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

export function textPatches(oldText: string, newText: string): TextPatch[] {
  if (oldText === newText) return []
  const a = linesOf(oldText)
  const b = linesOf(newText)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  let offset = a.slice(0, head).reduce((n, line) => n + line.length, 0)
  if (x.length * y.length > MAX_CELLS) return [{ from: offset, to: offset + x.join('').length, insert: y.join('') }]

  const dp: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0))
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  }
  const out: TextPatch[] = []
  let pending: TextPatch | null = null
  const flush = (): void => {
    if (pending && (pending.to > pending.from || pending.insert)) out.push(pending)
    pending = null
  }
  let i = 0
  let j = 0
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      flush()
      offset += x[i]!.length
      i++
      j++
    } else if (j >= y.length || (i < x.length && dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      pending ??= { from: offset, to: offset, insert: '' }
      offset += x[i]!.length
      pending.to = offset
      i++
    } else {
      pending ??= { from: offset, to: offset, insert: '' }
      pending.insert += y[j]!
      j++
    }
  }
  flush()
  return out
}
