/* ---------- Genet 的 REST 客户端（服务端 routes/assistant.ts） ---------- */
import { request } from '../api'

/** 任务页此刻怎样（服务端 agents/run-status.ts 判定，前端只显示） */
export type TaskStatus = 'running' | 'approval' | 'failed' | 'done' | 'idle'

/** 一次最多问这么多页（服务端 RUN_STATUS_MAX） */
export const RUN_STATUS_MAX = 50

export const assistantApi = {
  /** 这个人的 Genet 页：没有、或进了回收站，服务端就在个人空间顶层新建一页 */
  page: () => request<{ pageId: string }>('/api/me/assistant', { method: 'POST' }).then((r) => r.pageId),
  /** 这些页的运行状态；看不到的页不在结果里 */
  statuses: (ids: readonly string[]) =>
    request<{ statuses: Record<string, TaskStatus> }>(`/api/pages/run-status?ids=${ids.map(encodeURIComponent).join(',')}`).then((r) => r.statuses),
}
