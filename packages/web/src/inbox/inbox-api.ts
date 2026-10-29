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
  // 等你回答：agent 的提问（ACP elicitation）。表单在页面里答，这里只给入口
  | { type: 'question'; key: string; at: null; pageId: string; pageTitle: string; agentId: string; agentName: string; requestId: string; text: string }

export const inboxApi = {
  list: () => request<{ items: InboxItem[] }>('/api/inbox').then((r) => r.items),
  /** 打开了这个对话页（「做完待你看」据此消掉） */
  seen: (pageId: string) => request<unknown>('/api/inbox/seen', { method: 'POST', body: JSON.stringify({ pageId }) }),
  /** 点「知道了」 */
  dismiss: (key: string) => request<unknown>('/api/inbox/dismiss', { method: 'POST', body: JSON.stringify({ key }) }),
}
