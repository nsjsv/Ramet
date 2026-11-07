// ---------- agent 的显示名：服务端唯一的来源 ----------
// 收件箱条目的 agentName（inbox.ts）、补发内容里给别的 agent 的回复署名（catch-up.ts）都从这里取原料：
// 中心自己的 Genet 是固定的名字；本机 agent 用配置里的名字；connector 上的取机器名 + 它上报的名字（在线时以此刻的清单为准，
// 不在线用库里最近一次上报的）。怎么拼成一句（「机器 · 名字」还是「名字（机器）」）由调用方定，两边各自的写法不同。

import type { Pool } from 'pg'
import { ASSISTANT_LABEL, isAssistantId } from './assistant-agent.js'
import { parseRemoteId } from './manager-types.js'
import type { ConnectorAgentInfo } from './protocol.js'

/** label = agent 自己的名字；machine = 它所在的 connector 的名字（本机 agent / Genet 没有） */
export type AgentName = { label: string; machine?: string }

export type AgentNameHost = {
  /** 中心本机 agent（RAMET_LOCAL_AGENTS=1 才有） */
  localAgents(): Array<{ id: string; label: string }>
  /** connector 此刻上报的 agent 清单；离线时为 undefined，回落库里上一次上报的 */
  onlineAgents(connectorId: string): ConnectorAgentInfo[] | undefined
}

/** 这些 catalog id 的显示名；认不出的（不存在的机器等）不在结果里，调用方自己回落 */
export async function agentNames(pool: Pick<Pool, 'query'>, host: AgentNameHost, ids: Iterable<string>): Promise<Map<string, AgentName>> {
  const names = new Map<string, AgentName>()
  const remote = new Map<string, Array<{ id: string; agentId: string }>>()
  for (const id of new Set(ids)) {
    if (isAssistantId(id)) {
      names.set(id, { label: ASSISTANT_LABEL })
      continue
    }
    const local = host.localAgents().find((a) => a.id === id)
    if (local) {
      names.set(id, { label: local.label })
      continue
    }
    const parsed = parseRemoteId(id)
    if (!parsed) continue
    const list = remote.get(parsed.connectorId) ?? []
    list.push({ id, agentId: parsed.agentId })
    remote.set(parsed.connectorId, list)
  }
  if (remote.size === 0) return names
  const { rows } = await pool.query<{ id: string; name: string; agents: ConnectorAgentInfo[] | null }>(
    'SELECT id, name, agents FROM connectors WHERE id = ANY($1::text[])',
    [[...remote.keys()]],
  )
  for (const row of rows) {
    const agents = host.onlineAgents(row.id) ?? (Array.isArray(row.agents) ? row.agents : [])
    for (const { id, agentId } of remote.get(row.id) ?? []) {
      names.set(id, { label: agents.find((a) => a.id === agentId)?.label ?? agentId, machine: row.name })
    }
  }
  return names
}
