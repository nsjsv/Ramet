/* ---------- 记忆的 REST 客户端：空间公共记忆（routes/memories.ts）、个人记忆与 `/记住`（routes/my-memories.ts） ---------- */

import { request } from '../api'

export type Memory = {
  id: string
  text: string
  /** 个人记忆没有这两项（都是自己记的） */
  created_by?: string | null
  /** 记的人的用户名；删号后查不到 = null */
  created_by_name?: string | null
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

export const personalMemoryApi = {
  list: () => request<MemoryList>('/api/me/memories'),
  add: (text: string) => request<{ memory: Memory }>('/api/me/memories', { method: 'POST', body: JSON.stringify({ text }) }).then((r) => r.memory),
  remove: (id: string) => request<unknown>(`/api/me/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

/** `/记住` 记到哪：personal = 你的个人记忆；{ space } = 那个空间的公共记忆（服务端按页面定） */
export type RememberTarget = 'personal' | { space: string }

export const rememberApi = {
  onPage: (pageId: string, text: string) =>
    request<{ target: RememberTarget }>(`/api/pages/${encodeURIComponent(pageId)}/memories`, { method: 'POST', body: JSON.stringify({ text }) }).then((r) => r.target),
}
