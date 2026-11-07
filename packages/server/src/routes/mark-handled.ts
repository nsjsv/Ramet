/* ---------- Genet 标记「不用处理」（mark_handled） ----------
 * Genet 看了一条事件通知、判断不用管时调：在 Genet 页上找这一轮正在写的那块回复（最后一块、stats 还是 o:run），设 quiet = 理由。
 * 前端把带 quiet 的回复连同它前面紧挨着的事件通知折成一行灰字（「看了 bob 在《周报》的评论：只是确认，不用处理」），点开看原文。
 * ReplyWriter 收尾只换子块、只写自己的几个属性（stats / run / plan / team），不重建这一块，所以这里设的 quiet 留得住；
 * 重新生成 / 续跑（reset / reopen）时 ReplyWriter 把它去掉。不亮收件箱：这一刻记进 quiet_turns，这一轮的过程页不算「做完待你看」。 */

import type { Pool } from 'pg'
import * as Y from 'yjs'
import { decodeStats } from '@ramet/shared/reply-stats'
import type { DocWriter } from '../collab.js'
import type { Outcome } from './ramet-consent.js'

const REASON_MAX = 200

export async function markHandled(deps: { pool: Pool; write?: DocWriter | undefined }, user: { id: string; role: string }, home: string, raw: unknown): Promise<Outcome> {
  const flat = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  if (!flat) return { status: 400, body: { error: '要写一句为什么不用处理' } }
  if (!deps.write) return { status: 500, body: { error: '没有文档写入通道' } }
  const reason = [...flat].slice(0, REASON_MAX).join('')
  let marked = false
  await deps.write(`page:${home}`, user, (doc, origin) =>
    doc.transact(() => {
      let last: Y.XmlElement | null = null
      doc.getXmlFragment('prosemirror').forEach((c) => {
        if (c instanceof Y.XmlElement && c.nodeName === 'agent_reply') last = c
      })
      const reply = last as Y.XmlElement | null
      if (!reply || decodeStats(reply.getAttribute('stats')).o !== 'run') return
      reply.setAttribute('quiet', reason)
      marked = true
    }, origin),
  )
  if (!marked) return { status: 409, body: { error: '这一轮的回复不在了，或者已经写完了：只能在回复的这一轮里标记' } }
  await deps.pool.query('INSERT INTO quiet_turns (page_id) VALUES ($1)', [home])
  return { status: 200, body: { ok: true } }
}
