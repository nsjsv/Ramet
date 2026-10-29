/* ---------- 带队计划的 REST 客户端（服务端 routes/team.ts）+ 全页共用的计划视图 store ----------
 * 错误统一是 ApiError：message 是服务端的人话（403 带机器主人名、400 带校验原因），code 是短码
 * （forbidden / plan not draft / leader mismatch / assignee unavailable …）。 */

import type { TeamPlanView } from '@ramet/shared/run-model'
import { request } from '../api'
import { createPlanStore } from './team-store'

/** PATCH 的请求体：只能改这几样。cwd 给 null = 回到默认目录；换负责人时旧目录作废，要换目录一并给 */
export type PlanPatch = {
  title?: string
  tasks?: Array<{ id: string; title?: string; assignee?: string; cwd?: string | null }>
}

const base = (pageId: string, planId: string): string => `/api/pages/${pageId}/team/${planId}`

export const teamApi = {
  get: (pageId: string, planId: string) => request<TeamPlanView>(base(pageId, planId)),
  patch: (pageId: string, planId: string, body: PlanPatch) =>
    request<TeamPlanView>(base(pageId, planId), { method: 'PATCH', body: JSON.stringify(body) }),
  cancel: (pageId: string, planId: string) => request<TeamPlanView>(`${base(pageId, planId)}/cancel`, { method: 'POST' }),
}

/** 全页共用的计划视图 store（agent-bar 的 SSE 往里 put，计划卡从里面读） */
export const planStore = createPlanStore(teamApi.get)
