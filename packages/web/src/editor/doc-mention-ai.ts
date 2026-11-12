/* ---------- 正文里 @空间 AI：在 `>>` 消息块里是点名，在普通段落里是开一条划词评论 ----------
 * 只有 `>>` 消息块里的 agent chip 会叫 agent 跑；普通段落里留一个空间 AI 的 chip 什么也不会发生。
 * 所以普通段落里选它 = 删掉 `@查询`（正文里不留东西），在当前这一块的整段文字上开新的划词评论框并预填它的记号，
 * 用户在框里写问题发出去，由评论那一套叫它回（服务端 comments/space-ai-call.ts）。
 * 当前块没有字 → 往前找最近一个有字的块；都没有 / 这一页没有划词评论（关着、不是 doc 页、对话视图）→ 提示原因、不开框。
 * 这里只有纯函数（插件 doc-mention.ts 用）；开框与提示是宿主的事（comments/comment-entry.ts 的 openAiComment，editor-session.ts 经 opts 交给插件）。 */

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { isSpaceAiId } from '../assistant/identity'

export type TextRange = { from: number; to: number }

/** 选中的 agent 怎么落：插 chip（`>>` 消息块里，或不是空间 AI），还是开评论框（普通段落里的空间 AI） */
export function agentPickRoute(agentId: string, inMessage: boolean): 'chip' | 'comment' {
  return isSpaceAiId(agentId) && !inMessage ? 'comment' : 'chip'
}

/** pos 所在的文本块有字就是它的内容范围；没有就往前找最近一个有字的文本块；都没有 = null。
 *  范围是整段（开头到结尾），评论锚点自己会收进有字的地方（comment-anchor.ts 的 encodeAnchor） */
export function commentRangeAt(doc: PMNode, pos: number): TextRange | null {
  let found: TextRange | null = null
  doc.descendants((node, at) => {
    if (at + 1 > pos) return false // 文档序：从这里起的块都在 pos 后面
    if (!node.isTextblock) return true
    if (node.textContent.trim()) found = { from: at + 1, to: at + 1 + node.content.size }
    return false
  })
  return found
}
