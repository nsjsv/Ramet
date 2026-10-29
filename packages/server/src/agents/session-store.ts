// ---------- 页面级 agent 会话的落库（pages.agent_session）----------
// sessions / configs / workspaces（以及页面级的 choice / tools）是 agent_session 这一列 jsonb 里平级的键。这里只有 SQL 与
// 读写函数，只依赖 pool：不碰 manager 的内存状态、不广播。turn.ts / session-config.ts / manager.ts 共用。
import type { Pool } from 'pg'
import type { ResolvedAgent, SavedSession } from './manager-types.js'
import { toolProfileOf, type ToolProfile } from './tool-profile.js'

const SELECT_STATE = 'SELECT agent_session FROM pages WHERE id = $1'
// 工作区覆盖：用户给 (页面, agent) 指定的执行目录；没指定过就没有键，回落执行端默认
const SELECT_WORKSPACE = `SELECT agent_session->'workspaces'->$2 AS cwd FROM pages WHERE id = $1`
const SET_WORKSPACE = `UPDATE pages SET agent_session =
  COALESCE(agent_session, '{}'::jsonb) ||
  jsonb_build_object('workspaces',
    COALESCE(agent_session->'workspaces', '{}'::jsonb) || jsonb_build_object($2::text, to_jsonb($3::text)))
  WHERE id = $1`
const CLEAR_WORKSPACE = `UPDATE pages SET agent_session =
  COALESCE(agent_session, '{}'::jsonb) ||
  jsonb_build_object('workspaces', COALESCE(agent_session->'workspaces', '{}'::jsonb) - $2::text)
  WHERE id = $1`
// 按 agent 分存写入：合并 'sessions' map，不覆盖其它 agent 的条目；并发由页面互斥挡住
const SAVE_STATE = `UPDATE pages SET agent_session =
  COALESCE(agent_session, '{}'::jsonb) ||
  jsonb_build_object('sessions', COALESCE(agent_session->'sessions', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb))
  WHERE id = $1`
// configs 与 sessions 平级：configs[agentId][configId] = value，逐键合并，不覆盖其它 agent。
// jsonb_set 不会创建缺失的中间键，所以两层都用 COALESCE || jsonb_build_object 显式合并
const PERSIST_CONFIG = `UPDATE pages SET agent_session =
  COALESCE(agent_session, '{}'::jsonb) ||
  jsonb_build_object('configs',
    COALESCE(agent_session->'configs', '{}'::jsonb) ||
    jsonb_build_object($2::text,
      COALESCE(agent_session->'configs'->$2, '{}'::jsonb) || jsonb_build_object($3::text, to_jsonb($4::text))))
  WHERE id = $1`

// 页面记住的来源：用户在这一页选过 / 设过模型、目录 / 从输入卡发过消息的 agent（catalog id）。
// 意图层，同 workspaces：协作者共享、换设备不丢；没有就由前端回落到用户的全局默认 agent
const SELECT_CHOICE = `SELECT agent_session->>'choice' AS choice FROM pages WHERE id = $1`
const SET_CHOICE = `UPDATE pages SET agent_session =
  COALESCE(agent_session, '{}'::jsonb) || jsonb_build_object('choice', $2::text)
  WHERE id = $1`

/** 本页记住的来源；没有 = '' */
export async function loadChoice(pool: Pool, pageId: string): Promise<string> {
  const { rows } = await pool.query<{ choice: string | null }>(SELECT_CHOICE, [pageId])
  return rows[0]?.choice ?? ''
}

export async function saveChoice(pool: Pool, pageId: string, agentId: string): Promise<void> {
  await pool.query(SET_CHOICE, [pageId, agentId])
}

// 页面的工具档位（tool-profile.ts）：意图层，同 choice，协作者共享、对这页上所有 agent 生效；没有就是 full
const SELECT_TOOLS = `SELECT agent_session->>'tools' AS tools FROM pages WHERE id = $1`
const SET_TOOLS = `UPDATE pages SET agent_session =
  COALESCE(agent_session, '{}'::jsonb) || jsonb_build_object('tools', $2::text)
  WHERE id = $1`

export async function loadToolProfile(pool: Pool, pageId: string): Promise<ToolProfile> {
  const { rows } = await pool.query<{ tools: string | null }>(SELECT_TOOLS, [pageId])
  return toolProfileOf(rows[0]?.tools)
}

export async function saveToolProfile(pool: Pool, pageId: string, profile: ToolProfile): Promise<void> {
  await pool.query(SET_TOOLS, [pageId, profile])
}

// ---------- 工作区（cwd）覆盖 ----------
// 用户指定的工作区与会话的 cwd 是两个概念：前者是意图（落库、协作者可见），后者是
// 这个会话建在哪、喂到哪个 hash 的派生事实（sessions[agentId].cwd）。会话复用由
// runTurn / prepare 的 saved.cwd === 生效 cwd 判定，改工作区自动作废旧会话，没有额外失效逻辑。

async function loadWorkspace(pool: Pool, pageId: string, agentId: string): Promise<string | null> {
  const { rows } = await pool.query<{ cwd: string | null }>(SELECT_WORKSPACE, [pageId, agentId])
  return rows[0]?.cwd ?? null
}

/** 生效工作区（唯一解析入口）：用户指定，其次执行端默认（connector 上报的本机目录 / 中心进程 cwd）。
 *  只看 agent 的 id 与执行端默认目录，所以项目面板（没有 ResolvedAgent，只有 machine 凭据）也走这里 */
export async function effectiveCwd(
  pool: Pool,
  pageId: string,
  agent: Pick<ResolvedAgent, 'id'> & { remote?: { defaultCwd: string } },
): Promise<string> {
  const override = await loadWorkspace(pool, pageId, agent.id)
  return override ?? agent.remote?.defaultCwd ?? process.cwd()
}

/** 指定 / 清除该 (页面, agent) 的工作区覆盖：cwd 空串表示清除。只落意图这一层 */
export async function saveWorkspace(pool: Pool, pageId: string, agentId: string, cwd: string): Promise<void> {
  if (cwd) await pool.query(SET_WORKSPACE, [pageId, agentId, cwd])
  else await pool.query(CLEAR_WORKSPACE, [pageId, agentId])
}

export async function loadSessionState(pool: Pool, pageId: string, agentId: string): Promise<SavedSession | null> {
  const { rows } = await pool.query<{ agent_session: { sessions?: Record<string, SavedSession> } | null }>(
    SELECT_STATE,
    [pageId],
  )
  return rows[0]?.agent_session?.sessions?.[agentId] ?? null
}

export async function persistSession(
  pool: Pool,
  pageId: string,
  agentId: string,
  sessionId: string,
  cwd: string,
  /** null = 准备会话（建了会话但还没喂文档，见 SavedSession 注释） */
  lastSyncedHash: string | null,
  /** 交给这个会话 MCP 的凭证属于谁（SavedSession.userId） */
  userId: string,
  /** 这个会话交付的工具档位（SavedSession.tools） */
  tools: ToolProfile,
): Promise<void> {
  await pool.query(SAVE_STATE, [pageId, agentId, JSON.stringify({ sessionId, cwd, lastSyncedHash, userId, tools })])
}

/** 该用户能复用的会话记录：只有 MCP 凭证就是他的那个会话才算（见 SavedSession.userId），别人的当作没有 */
export async function loadOwnSession(pool: Pool, pageId: string, agentId: string, userId: string): Promise<SavedSession | null> {
  const saved = await loadSessionState(pool, pageId, agentId)
  return saved && saved.userId === userId ? saved : null
}

export async function loadConfigs(pool: Pool, pageId: string, agentId: string): Promise<Record<string, string>> {
  const { rows } = await pool.query<{ agent_session: { configs?: Record<string, Record<string, string>> } | null }>(
    SELECT_STATE,
    [pageId],
  )
  return rows[0]?.agent_session?.configs?.[agentId] ?? {}
}

export async function persistConfigs(pool: Pool, pageId: string, agentId: string, values: Record<string, string>): Promise<void> {
  for (const [configId, value] of Object.entries(values)) {
    await pool.query(PERSIST_CONFIG, [pageId, agentId, configId, value])
  }
}
