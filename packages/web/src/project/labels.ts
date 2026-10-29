import type { AgentInfo } from '../api'

/** 报错文案：request() 抛的 ApiError.message 已是服务端的人话 */
export const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** agent 的短名（改动列表里的「谁改的」）：目录里叫「机器 · Claude」，这里只要 Claude；目录里找不到（已下线）退回原生 id */
export function agentShortLabel(id: string, agents: readonly AgentInfo[]): string {
  const hit = agents.find((a) => a.id === id)
  if (hit) return hit.label.split(' · ').pop() ?? hit.label
  return id.replace(/^c:[^:]+:/, '') || 'AI'
}

/** 改动列表里「谁改的」：by 是 agent 的 catalog id；'quick' = 随手 AI 写的；没有 = 用户自己 */
export function authorLabel(by: string | undefined, agents: readonly AgentInfo[], you: string, quick: string): string {
  if (!by) return you
  return by === QUICK_AUTHOR ? quick : agentShortLabel(by, agents)
}

/** 服务端给 git-status 的 by：随手 AI 写进去的文件（不是 agent 的 catalog id） */
export const QUICK_AUTHOR = 'quick'
