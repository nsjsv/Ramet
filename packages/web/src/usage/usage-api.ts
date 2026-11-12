/* ---------- AI 使用量的接口与形状（服务端 routes/ai-usage.ts、ai-usage.ts） ----------
 * 只有 token 与次数，不折算金额；「一天」按看的人的时区切，byDay 每天一行（没用就是 0）。 */

import { request } from '../api'

export type UsageSource = 'genet' | 'space_ai' | 'quick' | 'ai_gen' | 'ai_prop'

export type UsageSums = { calls: number; requests: number; input: number; output: number; cacheRead: number; cacheWrite: number }
export type UsageDay = { day: string } & UsageSums

type UsageReport = { days: number; timeZone: string; totals: UsageSums; byDay: UsageDay[] }

/** 我的连接花了多少（含我当 owner 的空间 AI 被成员叫的那部分） */
export type MyUsage = UsageReport & {
  bySource: Array<{ source: UsageSource } & UsageSums>
  byModel: Array<{ model: string } & UsageSums>
}

/** 这个空间的空间 AI 花了多少（只有 owner 拿得到），按叫它的成员分 */
export type SpaceAiUsage = UsageReport & { byMember: Array<{ userId: string | null; name: string } & UsageSums> }

export const USAGE_DAYS = 30

export const usageApi = {
  mine: (days = USAGE_DAYS) => request<MyUsage>(`/api/me/ai-usage?days=${days}`),
  space: (spaceId: string, days = USAGE_DAYS) => request<SpaceAiUsage>(`/api/spaces/${encodeURIComponent(spaceId)}/ai/usage?days=${days}`),
}
