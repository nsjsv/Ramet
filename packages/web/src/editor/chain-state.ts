/* ---------- @ 点名链在前端的进度 ----------
 * 规则只有一份（@ramet/shared/mention-chain，服务端用同一个函数决定下一个跑谁），这里把 ProseMirror 文档的顶层块摊成
 * ChainBlock 喂给它。用于失败条 / 失败胶囊上要不要出继续剩下的 N 个。 */

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { chainRest, mentionChainOf, type ChainBlock } from '@ramet/shared/run-model'

/** 用户消息里 @ 到的 agent（按出现顺序） */
function mentionsIn(msg: PMNode): string[] {
  const out: string[] = []
  msg.descendants((n) => {
    if (n.type.name === 'agent_mention' && typeof n.attrs.agentId === 'string' && n.attrs.agentId) out.push(n.attrs.agentId)
    return true
  })
  return out
}

/** 顶层块摊成 ChainBlock，顺带记下最后一条回复的块 id */
function chainBlocks(doc: PMNode): { blocks: ChainBlock[]; lastReply: string } {
  const blocks: ChainBlock[] = []
  let lastReply = ''
  doc.forEach((node) => {
    if (node.type.name === 'user_message') blocks.push({ kind: 'user_message', mentions: mentionsIn(node) })
    else if (node.type.name === 'agent_reply') {
      blocks.push({ kind: 'agent_reply' })
      lastReply = typeof node.attrs.id === 'string' ? node.attrs.id : ''
    } else blocks.push({ kind: 'other' })
  })
  return { blocks, lastReply }
}

/** 这条回复失败后，被点名的 agent 还剩几个没轮到。只有它是文档里最后一条回复才算（之后又有回复 / 新消息，
 *  这条失败就不再是链停住的地方），没有链或链走完了返回 0 */
export function chainRestAfter(doc: PMNode, replyId: string): number {
  const { blocks, lastReply } = chainBlocks(doc)
  return lastReply === replyId ? chainRest(mentionChainOf(blocks)) : 0
}

/** 下一轮会跑谁（服务端点名优先于消息 chip 与请求体）：最后一条用户消息点名的、还没轮到的第一家；没有链 / 轮完了是空串 */
export function nextMention(doc: PMNode): string {
  const chain = mentionChainOf(chainBlocks(doc).blocks)
  return chain && chain.replied < chain.agents.length ? (chain.agents[chain.replied] ?? '') : ''
}
