// ---------- 页面级 agent 会话的落库（pages.agent_session）----------
// sessions / configs / workspaces（以及页面级的 choice / tools）是 agent_session 这一列 jsonb 里平级的键。这里只有 SQL 与
// 读写函数，只依赖 pool：不碰 manager 的内存状态、不广播。turn.ts / session-config.ts / manager.ts 共用。
import type { Pool, PoolClient } from 'pg'
import { toolOf } from '@ramet/shared/reply-stats'
import type { ResolvedAgent, SavedSession } from './manager-types.js'
import { isSpaceAiId } from './space-ai.js'
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

/** db 可以是事务里的连接（建 Genet 页时与建页同一个事务） */
export async function saveChoice(pool: Pool | PoolClient, pageId: string, agentId: string): Promise<void> {
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
// 这个会话建在哪的派生事实（sessions[agentId].cwd）。会话复用由
// runTurn / prepare 的 saved.cwd === 生效 cwd 判定，改工作区自动作废旧会话，没有额外失效逻辑。

async function loadWorkspace(pool: Pool, pageId: string, agentId: string): Promise<string | null> {
  const { rows } = await pool.query<{ cwd: string | null }>(SELECT_WORKSPACE, [pageId, agentId])
  return rows[0]?.cwd ?? null
}

/** 生效工作区（唯一解析入口）：用户指定，其次执行端默认（connector 上报的本机目录 / 中心进程 cwd）。
 *  只看 agent 的 id 与执行端默认目录，所以项目面板（没有 ResolvedAgent，只有 machine 凭据）也走这里。
 *  Genet 不在任何机器上跑，没有工作区：恒为空（会话复用比较 cwd，空串在每一轮都一样） */
export async function effectiveCwd(
  pool: Pool,
  pageId: string,
  agent: Pick<ResolvedAgent, 'id' | 'assistant'> & { remote?: { defaultCwd: string } },
): Promise<string> {
  if (agent.assistant) return ''
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
  /** 会话看到的最后一块（SavedSession.seen）；null = 准备会话（建了会话但还没喂文档，见 SavedSession 注释） */
  seen: string | null,
  /** 交给这个会话 MCP 的凭证属于谁（SavedSession.userId） */
  userId: string,
  /** 这个会话交付的工具档位（SavedSession.tools） */
  tools: ToolProfile,
  /** 只有改写老记录（还没有 seen）时原样带上它的 hash，否则老记录的增量判据就丢了 */
  lastSyncedHash?: string | null,
): Promise<void> {
  const record = { sessionId, cwd, seen, userId, tools, ...(lastSyncedHash ? { lastSyncedHash } : {}) }
  await pool.query(SAVE_STATE, [pageId, agentId, JSON.stringify(record)])
}

// 会话记录 + 这一页这个工具的会话最后在哪台机器上跑（current[工具] = catalog id），同一条 UPDATE：
// 换机器（session-move.ts）据 current 判断上次在哪、从中心把那个会话下发到这一台
const SAVE_TURN_STATE = `UPDATE pages SET agent_session =
  COALESCE(agent_session, '{}'::jsonb) ||
  jsonb_build_object('sessions', COALESCE(agent_session->'sessions', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)) ||
  jsonb_build_object('current', COALESCE(agent_session->'current', '{}'::jsonb) || jsonb_build_object($4::text, to_jsonb($2::text)))
  WHERE id = $1`
const SELECT_CURRENT = `SELECT agent_session->'current'->>$2 AS current FROM pages WHERE id = $1`

/** 一轮发出提示词之前落会话记录（seen = 这一轮的回复块），同时把 current[工具] 记成这个 agent。
 *  只有真正喂过文档的会话才算「这一页的会话在这台机器上」：准备会话、改配置时落的记录不改 current，
 *  否则在别的机器上点开 chip（prepare）就会让这一页忘了会话其实在哪 */
export async function persistTurnSession(
  pool: Pool,
  pageId: string,
  agentId: string,
  sessionId: string,
  cwd: string,
  seen: string,
  userId: string,
  tools: ToolProfile,
  /** Genet 带过的跨空间上下文（别的 agent 不传，记录形状不变） */
  context?: Record<string, string>,
): Promise<void> {
  const record = { sessionId, cwd, seen, userId, tools, ...(context ? { context } : {}) }
  await pool.query(SAVE_TURN_STATE, [pageId, agentId, JSON.stringify(record), toolOf(agentId)])
}

/** 这一页这个工具的会话最后在哪个 agent（catalog id）上跑；没有 = null */
export async function loadCurrent(pool: Pool, pageId: string, tool: string): Promise<string | null> {
  const { rows } = await pool.query<{ current: string | null }>(SELECT_CURRENT, [pageId, tool])
  return rows[0]?.current ?? null
}

/** 该用户能复用的会话记录：只有 MCP 凭证就是他的那个会话才算（见 SavedSession.userId），别人的当作没有。
 *  空间 AI 例外：会话属于空间，同空间的成员接着同一段对话；加载时驱动换上这个人的凭证（MCP 进程按它重起），
 *  它从会话里看到的只有这个空间的内容（凭证收窄），换人接着用不会把上一个人的权限带过来 */
export async function loadOwnSession(pool: Pool, pageId: string, agentId: string, userId: string): Promise<SavedSession | null> {
  const saved = await loadSessionState(pool, pageId, agentId)
  return saved && (saved.userId === userId || isSpaceAiId(agentId)) ? saved : null
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
