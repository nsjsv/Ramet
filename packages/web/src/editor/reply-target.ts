// ---------- 用户消息的「重新回复」落点 ----------
// 对话模式删掉 AI 回复后，用户气泡上能直接让 agent 再答一次。纯函数，只看顶层块的先后：
// 用户消息 = 顶层 user_message，AI 回复 = 顶层 agent_reply（message-blocks.ts）。
// 消费方：chat-acts.ts（点击时按当下文档现算）、chat-view.tsx（装饰重算时决定给不给按钮）。

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { messageConfigOf } from './message-blocks'

const isUserMessage = (node: PMNode): boolean => node.type.name === 'user_message'

/** 用户消息块 id → 怎么让 agent 再答一次：
 *  - 它后面（下一条用户消息之前）有 AI 回复 → 原地重新生成那一条（regen；@ 点名链的多条回复取第一条）；
 *  - 没有回复、且它是文档最后一条非空用户消息 → 直接发（send，同草稿的发送：continue 的增量就是最后一条）；
 *  - 没有回复又不是最后一条 → null：continue 会答到最后一条消息上，不给这个入口。 */
export type ReplyTarget = { kind: 'regen'; replyId: string } | { kind: 'send'; agent: string }

export function replyTargetOf(doc: PMNode, userId: string): ReplyTarget | null {
  let mine: PMNode | null = null
  for (let i = 0; i < doc.childCount; i++) {
    const node = doc.child(i)
    if (!mine) {
      if (isUserMessage(node) && node.attrs.id === userId) mine = node
      continue
    }
    if (isUserMessage(node)) return null
    if (node.type.name === 'agent_reply') {
      const id: unknown = node.attrs.id
      return typeof id === 'string' && id ? { kind: 'regen', replyId: id } : null
    }
  }
  return mine && mine.textContent.trim() ? { kind: 'send', agent: messageConfigOf(mine).agent } : null
}

/** 一趟扫完：哪些用户消息有「重新回复」落点（与 replyTargetOf 同口径；对话视图每次重算装饰都要，别逐条 O(n²)） */
export function redoableUserIds(doc: PMNode): Set<string> {
  const out = new Set<string>()
  let pending: PMNode | null = null
  const add = (node: PMNode): void => {
    const id: unknown = node.attrs.id
    if (typeof id === 'string' && id) out.add(id)
  }
  for (let i = 0; i < doc.childCount; i++) {
    const node = doc.child(i)
    if (isUserMessage(node)) pending = node
    else if (node.type.name === 'agent_reply' && pending) {
      add(pending)
      pending = null
    }
  }
  if (pending && pending.textContent.trim()) add(pending)
  return out
}
