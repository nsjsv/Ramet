/* ---------- 端口预览的 REST 客户端（server routes/previews.ts）----------
 * 预览 = agent 所在机器上的开发服务器（127.0.0.1:端口）经 connector 转发，在独立的预览源里看（与 Ramet 不同源）。
 * 共享要 machine 授权；看（列表、取票据）只要页面可读。request() 抛的 ApiError.message 已是服务端的人话。 */

import { request } from '../api'

export interface PreviewItem {
  id: string
  port: number
  /** 打开预览落在哪个路径（以 / 开头） */
  path: string
  /** 机器名 */
  machine: string
  /** 共享人的用户名 */
  shared_by: string
  mine: boolean
  online: boolean
  /** 共享人或机器主人可以停止 */
  can_stop: boolean
  created_at: number
}

export interface PreviewList {
  /** false = 服务器没有开预览端口（RAMET_PREVIEW_PORT 没设） */
  enabled: boolean
  previews: PreviewItem[]
}

const onPage = (pageId: string, suffix = ''): string => `/api/pages/${pageId}/previews${suffix}`

export const previewApi = {
  list: (pageId: string) => request<PreviewList>(onPage(pageId)),
  share: (pageId: string, agent: string, port: number, path: string) =>
    request<{ id: string }>(`/api/pages/${pageId}/project/previews`, {
      method: 'POST',
      body: JSON.stringify({ agent, port, ...(path && path !== '/' ? { path } : {}) }),
    }),
  stop: (pageId: string, id: string) => request<{ ok: true }>(onPage(pageId, `/${id}`), { method: 'DELETE' }),
  /** 一次性进入地址（60 秒内用、只能用一次）：打开它 = 在预览源上换到预览会话，再跳到预览入口 */
  ticket: (pageId: string, id: string) => request<{ url: string }>(onPage(pageId, `/${id}/ticket`), { method: 'POST', body: '{}' }),
}

/** 预览地址的显示：localhost:5173 或 localhost:5173/app */
export const previewLabel = (p: Pick<PreviewItem, 'port' | 'path'>): string => `localhost:${p.port}${p.path === '/' ? '' : p.path}`

/** 在新标签里打开一个预览。
 *  票据要异步取，而浏览器只放行「点击当下」同步打开的窗口：先同步开一个空白窗口，票据回来再导航过去；
 *  开的时候切断 opener（新窗口里最终是不可信的预览页，不能让它碰到 Ramet 的窗口） */
export async function openPreviewTab(pageId: string, id: string): Promise<void> {
  const win = window.open('', '_blank')
  if (win) win.opener = null
  try {
    const { url } = await previewApi.ticket(pageId, id)
    if (win) win.location.href = url
    else window.open(url, '_blank', 'noopener')
  } catch (err) {
    win?.close()
    throw err
  }
}
