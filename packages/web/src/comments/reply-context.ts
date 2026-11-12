/* ---------- 代回复的上下文：交给 POST /api/quick（kind 'reply'）的请求体（纯函数）----------
 * 回复评论串：页面标题 + 划词原文 + 整串评论（「作者：内容」，按时间先后）；正文里被 @：页面标题 + 那一块的文字。
 * 我是谁由服务端按登录的人填（串里哪些话是我说的，靠它认），这里不带。
 * 预算：串太长时首条必留（问题本身），其余从最近的往前留，中间注明省略了几条；单条、原文各有上限。
 * 正文里的提及记号降成 @名字：模型不该看到也不该写出成员 id，草稿里出现 Genet 记号还会在发出去时叫醒 Genet。 */

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { QuickBody } from '../quick-api'
import { plainBody, type Comment } from './comments-api'

/** 整串评论的字数预算（服务端 text 上限 2 万字，留足余量） */
export const THREAD_BUDGET = 12_000
/** 单条评论最多带这么多字 */
export const COMMENT_CLIP = 1_500
/** 划词原文 / 那一块的文字最多带这么多字（服务端同一个上限） */
export const QUOTE_CLIP = 4_000

const clip = (s: string, n: number): string => ([...s].length > n ? `${[...s].slice(0, n).join('')}…` : s)

/** 一条评论的一行：「作者：内容」；内容里的换行缩进两格，免得和下一条混在一起 */
function line(c: Comment, deletedUser: string): string {
  const body = clip(plainBody(c.body).trim(), COMMENT_CLIP).replace(/\n/g, '\n  ')
  return `${c.author?.name ?? deletedUser}：${body}`
}

/** 整串评论排进预算：删掉的不带；首条必留，其余从最近的往前留，留不下的折成一行「（中间省略 N 条）」 */
export function threadText(comments: readonly Comment[], deletedUser: string, omitted: (n: number) => string, budget = THREAD_BUDGET): string {
  const lines = comments.filter((c) => !c.deleted && c.body.trim()).map((c) => line(c, deletedUser))
  if (lines.length === 0) return ''
  const [first, ...rest] = lines as [string, ...string[]]
  let used = first.length
  const tail: string[] = []
  for (let i = rest.length - 1; i >= 0; i--) {
    const l = rest[i]!
    if (used + l.length + 1 > budget) break
    used += l.length + 1
    tail.unshift(l)
  }
  const skipped = rest.length - tail.length
  return [first, ...(skipped > 0 ? [omitted(skipped)] : []), ...tail].join('\n')
}

/** 回复一个评论串 */
export function threadReplyBody(input: {
  instruction: string
  title: string
  quote: string
  comments: readonly Comment[]
  deletedUser: string
  omitted: (n: number) => string
}): QuickBody {
  return {
    kind: 'reply',
    instruction: input.instruction,
    title: input.title.trim(),
    quote: clip(input.quote.trim(), QUOTE_CLIP),
    text: threadText(input.comments, input.deletedUser, input.omitted),
  }
}

/** 正文里一块的文字（交给模型的 quote）：@ 成员的 chip 写成 @名字 —— 它没有 leafText，按块的文字算会丢掉被 @ 的是谁；
 *  别的行内原子照它自己的 leafText（公式等），块与块之间换行 */
export function blockText(node: PMNode): string {
  return node.textBetween(0, node.content.size, '\n', (leaf) =>
    leaf.type.name === 'user_mention' ? `@${String(leaf.attrs.name ?? '')}` : (leaf.type.spec.leafText?.(leaf) ?? ''),
  )
}

/** 别人在正文这一块里 @了我：在这一块上新开一条评论 */
export function mentionReplyBody(input: { instruction: string; title: string; quote: string }): QuickBody {
  return { kind: 'reply', instruction: input.instruction, title: input.title.trim(), quote: clip(input.quote.trim(), QUOTE_CLIP) }
}
