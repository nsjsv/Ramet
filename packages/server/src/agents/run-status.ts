// ---------- 任务页此刻的状态（Genet 页里任务链接旁的那个标记） ----------
// 只由服务端判定，前端只显示：
//   approval：这一页有待批的请求（agent 会话的或 Ramet 自己的），优先于 running —— 用户该去批了；
//   running：这一页有在飞的一轮；或者最后一块回复还是 o:run（server 刚重启、远端回合还没认领回来）；
//   failed：最后一块回复以失败或停止收尾；
//   done：最后一块回复正常结束；
//   idle：还没有回复。
// 后三种读的是回复块的 stats 属性，判据与前端失败条（web editor/reply-fail.ts 的 isFailedReply / isStoppedReply）同一个：
// @ramet/shared/reply-stats 的 decodeStats 解出的结果位 o（error / cancelled）。
// 看不到的页（不存在 / 回收站 / 不是成员）不出现在结果里，不泄露存在性。

import * as Y from 'yjs'
import { decodeStats } from '@ramet/shared/reply-stats'
import type { Pool } from 'pg'
import { pageAccess } from '../collab.js'
import type { PendingApproval } from './manager-types.js'

export type RunStatus = 'running' | 'approval' | 'failed' | 'done' | 'idle'

/** 一次最多问这么多页（前端只问 Genet 页里提到的任务页） */
export const RUN_STATUS_MAX = 50

export type RunStatusHost = {
  pool: Pool
  running(pageId: string): boolean
  approvals(): PendingApproval[]
  /** 页面正文：活文档优先，否则从库加载 */
  fragment(pageId: string): Promise<Y.XmlFragment>
}

/** 文档里最后一块回复的结局（没有回复 = idle） */
export function replyStatus(fragment: Y.XmlFragment): Exclude<RunStatus, 'approval'> {
  let last: Y.XmlElement | null = null
  fragment.forEach((node) => {
    if (node instanceof Y.XmlElement && node.nodeName === 'agent_reply') last = node
  })
  if (!last) return 'idle'
  const o = decodeStats((last as Y.XmlElement).getAttribute('stats')).o
  if (o === 'error' || o === 'cancelled') return 'failed'
  if (o === 'run') return 'running'
  return 'done'
}

/** 这些页此刻的状态（按调用者的可见性过滤） */
export async function runStatuses(host: RunStatusHost, user: { id: string; role: string }, pageIds: string[]): Promise<Record<string, RunStatus>> {
  const waiting = new Set(host.approvals().map((a) => a.pageId))
  const out: Record<string, RunStatus> = {}
  for (const id of new Set(pageIds)) {
    if (!(await pageAccess(host.pool, id, user))) continue
    if (waiting.has(id)) out[id] = 'approval'
    else if (host.running(id)) out[id] = 'running'
    else out[id] = replyStatus(await host.fragment(id))
  }
  return out
}
