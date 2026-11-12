/* ---------- 收件箱的 REST 客户端（服务端 routes/inbox.ts；形状同 server/src/inbox.ts 的 InboxItem）----------
 * 收件箱只是视图，条目上的按钮调的都是已有接口（api.respondPermission / approveConnector / rejectConnector），权限判定在那些接口上。 */

import { request } from '../api'
import type { MachineScope } from '../machine-api'

export type ApprovalOption = { optionId: string; name: string; kind?: string }
export type ApprovalDetail = { kind?: string; command?: string; path?: string; description?: string }

export type InboxItem =
  | {
      type: 'approval'
      key: string
      at: null
      pageId: string
      pageTitle: string
      agentId: string
      agentName: string
      requestId: string
      title: string
      options: ApprovalOption[]
      detail: ApprovalDetail
    }
  | {
      type: 'connector_pending'
      key: string
      at: string
      connectorId: string
      machine: string
      owner: string | null
      agents: string[]
      spaceId: string
      spaceName: string
    }
  | {
      type: 'access_request'
      key: string
      at: string
      connectorId: string
      machine: string
      spaceId: string
      spaceName: string
      requestId: string
      username: string
      scopes: MachineScope[]
      note: string
    }
  | { type: 'first_use'; key: string; at: string; connectorId: string; machine: string; grantId: string; username: string; scopes: MachineScope[] }
  | { type: 'done'; key: string; at: string; pageId: string; pageTitle: string; runPageId: string; agentId: string; agentName: string; outcome: string }
  | { type: 'running'; key: string; at: string; pageId: string; pageTitle: string; runId: string; agentId: string; agentName: string }
  // 等你批计划（带队 /带队）：你发起的、还是草稿的计划；planId = 计划卡的身份（key 是 `plan:<planId>`）
  | { type: 'plan'; key: string; at: string; pageId: string; pageTitle: string; title: string; planId: string }
  // 等你回答：agent 的提问。表单在页面里答，这里只给入口
  | { type: 'question'; key: string; at: null; pageId: string; pageTitle: string; agentId: string; agentName: string; requestId: string; text: string }
  // 评论：一个讨论串一条（有人回复了你发过言的串 / @了你 / 在你建的页面上开了新串），excerpt = 首条内容摘要（@ 记号已降成纯文字）
  | {
      type: 'comment'
      key: string
      at: string
      pageId: string
      pageTitle: string
      threadId: string
      /** 空间 AI 写的：{ ai: 'space', name }（没有 id）；null = 已注销用户 */
      author: { id: string; name: string } | { ai: 'space'; name: string } | null
      excerpt: string
      reason: 'reply' | 'mention' | 'new_thread'
    }
  // 定时器 / 规则没能触发：source = 规则的来源（timer = 定时器）；scheduledAt = 本应触发的时刻；paused = 因为连续失败自动暂停了。可「知道了」
  | {
      type: 'timer_failed'
      key: string
      at: string
      eventId: string
      timerId: string
      timerName: string
      /** 旧服务端不给：按定时器算 */
      source?: string
      scheduledAt: string
      reason: string
      paused: boolean
    }
  // 规则的「发通知」动作发给你的一条：pageId = 事件所在页（看不到了 = null）；ruleId = null 表示规则已经删了。可「知道了」
  | {
      type: 'automation'
      key: string
      at: string
      noticeId: string
      ruleId: string | null
      ruleName: string
      text: string
      pageId: string | null
      pageTitle: string
    }
  // 别人在页面正文里 @了你：每页一条（最新的那次），blockId = @ 所在的块；打开那一页就算看过（同「做完待你看」，走 seen）
  | {
      type: 'doc_mention'
      key: string
      at: string
      pageId: string
      pageTitle: string
      blockId: string
      actor: { id: string; name: string }
      excerpt: string
    }

export const inboxApi = {
  list: () => request<{ items: InboxItem[] }>('/api/inbox').then((r) => r.items),
  /** 打开了这一页（「做完待你看」「正文里 @了你」据此消掉） */
  seen: (pageId: string) => request<unknown>('/api/inbox/seen', { method: 'POST', body: JSON.stringify({ pageId }) }),
  /** 点「知道了」（首次使用、规则没能触发、规则发来的通知） */
  dismiss: (key: string) => request<unknown>('/api/inbox/dismiss', { method: 'POST', body: JSON.stringify({ key }) }),
}
