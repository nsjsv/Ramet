// ---------- AI 回复显示什么 icon / 名字（回复抬头与右上角岛共用） ----------
import { GENERIC_MARK, brandMark, type AgentBadge } from '../agent-marks'
import { findAgent, getDefaultAgent } from '../default-agent'

/** 这个 agent 配的文本 logo（没配 = 空） */
function textLogo(agentId: string): string {
  return findAgent(agentId)?.logo?.trim() ?? ''
}

/** 这个 agent 的品牌 mark key（目录项指定的优先，再按 id、label 里的词认） */
function markKey(agentId: string): string | null {
  if (!agentId) return null
  const hit = findAgent(agentId)
  return hit?.mark ?? brandMark(agentId) ?? (hit ? brandMark(hit.label) : null)
}

/** 按 agent 自己的信息给 icon：文本 logo → 品牌 mark → null（都没有） */
function badgeOf(agentId: string): AgentBadge | null {
  if (!agentId) return null
  const text = textLogo(agentId)
  if (text) return { kind: 'text', text }
  const key = markKey(agentId)
  return key ? { kind: 'mark', key } : null
}

/** 这块 AI 回复显示什么 icon：按产出它的 agent 给（文本 logo、品牌 mark）。
 *  该 agent 还在目录里但两样都没有，给通用星标（不能借用别的 agent 的图，那是假归属）；
 *  完全不认识这个 agent（connector 离线的历史块、没有 agent 属性的块）就回落当前默认 agent，再没有就星标 */
export function agentBadge(agentId: string): AgentBadge {
  const own = badgeOf(agentId)
  if (own) return own
  if (agentId && findAgent(agentId)) return { kind: 'mark', key: GENERIC_MARK }
  return badgeOf(getDefaultAgent()) ?? { kind: 'mark', key: GENERIC_MARK }
}

/** 这块 AI 回复顶栏显示的名字：产出者在目录里的 label，不认识则回落默认 agent 的 label，再没有就空串
 *  （公开页不拉目录，顶栏只剩 icon）。回落口径与 agentBadge 一致。
 *  pageId = 回复所在的页：空间 AI 的名字按这一页所在的空间现取（改名后新旧回复都是新名字），不给就是缺省名 */
export function agentName(agentId: string, pageId?: string): string {
  const label = (id: string): string => findAgent(id, pageId)?.label?.trim() ?? ''
  return label(agentId) || label(getDefaultAgent())
}
