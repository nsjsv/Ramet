/* ---------- 机器授权的 REST 客户端（设置 → 机器；服务端 routes/machines.ts）----------
 * 机器 = connector 接入的用户机器；主人 = 接入人。别人要用，必须走授权仪式（重输密码 → 机器上本地确认）。
 * 错误：request() 抛 ApiError，message 已是服务端的人话（密码错 / 限速 / 校验失败 / 重复申请 / 非主人），直接展示即可。 */

import { request } from './api'

/** agent = 用这台机器上的 agent；machine = 用这台机器的终端 / 文件 */
export type MachineScope = 'agent' | 'machine'

export interface MachineSummary {
  id: string
  name: string
  /** 主人的用户名；老 connector 没有主人 = null */
  owner: string | null
  online: boolean
  /** 我是不是这台机器的主人 */
  mine: boolean
  /** pending = 我接入的、还在等空间所有者批准（只有接入人自己看得到）；approved = 已在空间里生效 */
  status: 'pending' | 'approved'
  /** 我此刻有效的授权（别人授权给我的）。id 是「放弃授权」要用的授权 id */
  grant: { id: string; scopes: MachineScope[]; expiresAt: string } | null
  /** 我是不是有一条还没处理的使用申请 */
  request: boolean
  /** 我那条未处理申请的 id（「撤回」要用） */
  requestId: string | null
}

export interface MachineRequest {
  id: string
  userId: string
  username: string
  scopes: MachineScope[]
  note: string
  createdAt: string
}

export type GrantStatus = 'pending' | 'active' | 'expired' | 'revoked'

export interface MachineGrant {
  id: string
  userId: string
  username: string
  scopes: MachineScope[]
  status: GrantStatus
  expiresAt: string
  confirmedAt: string | null
  revokedAt: string | null
  firstUsedAt: string | null
  createdAt: string
}

export interface MachineUsage {
  id: string
  userId: string
  username: string
  action: 'run' | 'answer' | 'config' | 'files' | 'terminal' | 'preview' | 'quick'
  pageId: string | null
  detail: Record<string, unknown>
  createdAt: string
}

export interface GrantCreated {
  grantId: string
  /** 一次性确认码（只返回这一次） */
  code: string
  expiresAt: string
  confirmExpiresAt: string
  /** 要在那台机器上运行的确认命令 */
  command: string
}

export interface GrantInput {
  password: string
  /** 手输的对方用户名（必须与 userId 对应的用户名完全一致） */
  username: string
  /** 手输的机器名（必须与这台机器完全一致） */
  machineName: string
  scopes: MachineScope[]
  days: number
  userId: string
}

const enc = encodeURIComponent
const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })

export const machineApi = {
  list: (spaceId: string) => request<MachineSummary[]>(`/api/spaces/${enc(spaceId)}/machines`),

  /** 申请使用别人的机器；409 = 已经申请过 */
  requestAccess: (id: string, scopes: MachineScope[], note: string) =>
    request<{ id: string }>(`/api/machines/${id}/requests`, json({ scopes, ...(note ? { note } : {}) })),
  /** 仅主人 */
  listRequests: (id: string) => request<MachineRequest[]>(`/api/machines/${id}/requests`),
  /** 主人拒绝，或申请人撤回 */
  dropRequest: (id: string, requestId: string) => request<unknown>(`/api/machines/${id}/requests/${requestId}`, { method: 'DELETE' }),

  /** 仅主人：发起授权（重输密码 + 手输确认）；201 带一次性确认命令 */
  createGrant: (id: string, input: GrantInput) =>
    request<GrantCreated>(`/api/machines/${id}/grants`, json({ ...input, acknowledged: true })),
  /** 仅主人 */
  listGrants: (id: string) => request<MachineGrant[]>(`/api/machines/${id}/grants`),
  /** 主人收回 / 取消待确认的，或被授权人自己放弃；收回即断 */
  revokeGrant: (id: string, grantId: string) => request<unknown>(`/api/machines/${id}/grants/${grantId}`, { method: 'DELETE' }),

  /** 仅主人：使用记录，新 → 旧；before = 上一页最后一条的 id */
  usage: (id: string, params: { limit: number; before?: string }) => {
    const q = new URLSearchParams({ limit: String(params.limit) })
    if (params.before) q.set('before', params.before)
    return request<MachineUsage[]>(`/api/machines/${id}/usage?${q.toString()}`)
  },
}
