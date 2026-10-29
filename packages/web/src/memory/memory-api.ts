/* ---------- 空间公共记忆的 REST 客户端（服务端 routes/memories.ts；形状同 server/src/memories.ts）---------- */

import { request } from '../api'

export type Memory = {
  id: string
  space_id: string
  text: string
  created_by: string | null
  /** 记的人的用户名；删号后查不到 = null */
  created_by_name: string | null
  /** 从哪个页面提议 / 记下的（页面物理删后为 null） */
  source_page_id: string | null
  created_at: string
}

export type MemoryList = { items: Memory[]; chars: number; limits: { item: number; space: number } }

export const memoryApi = {
  list: (spaceId: string) => request<MemoryList>(`/api/spaces/${encodeURIComponent(spaceId)}/memories`),
  add: (spaceId: string, text: string) =>
    request<{ memory: Memory }>(`/api/spaces/${encodeURIComponent(spaceId)}/memories`, { method: 'POST', body: JSON.stringify({ text }) }).then((r) => r.memory),
  remove: (spaceId: string, id: string) =>
    request<unknown>(`/api/spaces/${encodeURIComponent(spaceId)}/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
