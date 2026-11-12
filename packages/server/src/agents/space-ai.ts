// ---------- 空间 AI：每个团队空间一个、跑在中心里的 AI（身份、配置与凭证范围的唯一定义） ----------
// 与 Genet 共用同一个驱动（drivers/assistant/driver.ts 的 space 模式），差别全在「主体」：
//   - 代表空间，不代表某个人：会话属于空间（同空间的成员接着同一段对话），模型连接是空间 owner 在配置里指定的、他自己的那一套；
//   - 权限 = 空间 ∩ 叫它的人：凭证的 userId 是叫它的人（上限），凭证上另带 space（范围），中心端点两样都判；
//   - 不碰机器、不派活、没有定时器 / 自动化 / 代发评论：凭证只放行白名单里的 /api/ramet/* 端点，以后新加的端点默认被拦。
// 只有一个 catalog id，按页面所在的空间解析：chip 随页面搬到别的团队空间就是那个空间的 AI，搬到个人空间就解析不出来（同未知 agent）。
// 生效 = 团队空间 + 有配置 + 连接还在且属于此刻的空间 owner（owner 删了连接、删号转交都会让它停用）。
// 别处只调这里的判定，不另写。

import type { Pool } from 'pg'
import type { ConnectionRow } from '../ai-connections.js'
import type { GrantCtx } from '../page-read.js'
import { assistantPass } from './machine-access.js'
import type { ResolvedAgent } from './manager-types.js'
import { RESERVED_AGENT_PREFIX } from './registry.js'
import type { ToolProfile } from './tool-profile.js'

export const SPACE_AI_ID = `${RESERVED_AGENT_PREFIX}space-ai`
/** 没配过名字时的显示名（也是 space_ai.name 的缺省值） */
export const SPACE_AI_DEFAULT_NAME = 'AI'
export const SPACE_AI_NAME_MAX = 20
/** 还没启用 / 连接没了：一轮开头现读配置读不到时的失败文案 */
export const SPACE_AI_OFF = '这个空间还没有启用 AI'
export const SPACE_AI_NO_TEAM = '空间 AI 不能带队：要几个 agent 一起做，请在对话页里选你机器上的 agent 再用 /带队'

export function isSpaceAiId(agentId: string): boolean {
  return agentId === SPACE_AI_ID
}

/** 空间 AI 的生效判定（SQL 片段，别名 s = spaces）：sc 打得上 = 生效。列表、解析、取连接都拼它，判定只有这一份 */
export const SPACE_AI_JOIN = `LEFT JOIN space_ai sa ON sa.space_id = s.id
  LEFT JOIN user_ai_connections sc ON sc.id = sa.connection_id AND sc.user_id = s.owner_id AND NOT s.is_personal`

// 页面所在空间的空间 AI（生效的才有行）；$2 = 叫它的人，必须是那个空间的成员
const SELECT_RESOLVABLE = `SELECT s.id FROM live_pages p JOIN spaces s ON s.id = p.space_id
  JOIN space_members m ON m.space_id = s.id AND m.user_id = $2
  ${SPACE_AI_JOIN} WHERE p.id = $1 AND sc.id IS NOT NULL`
const SELECT_OF_PAGE = `SELECT s.id AS space_id, s.owner_id, sc.id AS connection_id, COALESCE(sa.name, '${SPACE_AI_DEFAULT_NAME}') AS name
  FROM live_pages p JOIN spaces s ON s.id = p.space_id ${SPACE_AI_JOIN} WHERE p.id = $1 AND sc.id IS NOT NULL`
const SELECT_CONNECTION = `SELECT sc.id, sc.user_id, sc.name, sc.protocol, sc.base_url, sc.model, sc.key_ciphertext, sc.key_last4
  FROM spaces s ${SPACE_AI_JOIN} WHERE s.id = $1 AND sc.id IS NOT NULL`
// 名字不看生效：停用了，已有的回复块照样显示它的名字
const SELECT_NAMES = `SELECT p.id, sa.name FROM live_pages p JOIN space_ai sa ON sa.space_id = p.space_id WHERE p.id = ANY($1::text[])`
const IN_SPACE = 'SELECT 1 FROM live_pages WHERE id = $1 AND space_id = $2'

export type SpaceAi = { spaceId: string; ownerId: string; connectionId: string; name: string }

/** 这一页所在空间的空间 AI（生效的）；个人空间 / 没配 / 连接没了 = null */
export async function spaceAiOf(pool: Pool, pageId: string): Promise<SpaceAi | null> {
  const row = (await pool.query<{ space_id: string; owner_id: string; connection_id: string; name: string }>(SELECT_OF_PAGE, [pageId])).rows[0]
  return row ? { spaceId: row.space_id, ownerId: row.owner_id, connectionId: row.connection_id, name: row.name } : null
}

/** 空间 AI 的执行目标：页面所在的团队空间启用了它、发起人是那个空间的成员才有，否则 null（调用方当未知 agent）。
 *  凭据同 Genet（不在任何机器上跑）；space 决定凭证的范围与驱动的会话主体 */
export async function resolveSpaceAi(pool: Pool, user: { id: string }, pageId: string): Promise<ResolvedAgent | null> {
  const row = (await pool.query<{ id: string }>(SELECT_RESOLVABLE, [pageId, user.id])).rows[0]
  return row ? { id: SPACE_AI_ID, pass: assistantPass(user), assistant: true, space: { id: row.id } } : null
}

/** 这个空间的空间 AI 此刻用的连接（还没解密）；没启用 = null。驱动每一轮开头现读 */
export async function spaceAiConnection(pool: Pool, spaceId: string): Promise<ConnectionRow | null> {
  return (await pool.query<ConnectionRow>(SELECT_CONNECTION, [spaceId])).rows[0] ?? null
}

/** 各页所在空间的空间 AI 名字（回复块抬头、署名、收件箱用）；没配过的不在结果里，调用方写缺省名 */
export async function spaceAiNames(pool: Pick<Pool, 'query'>, pageIds: string[]): Promise<Map<string, string>> {
  if (pageIds.length === 0) return new Map()
  const { rows } = await pool.query<{ id: string; name: string }>(SELECT_NAMES, [[...new Set(pageIds)]])
  return new Map(rows.map((r) => [r.id, r.name]))
}

/** 页面是不是这个空间里的活页（凭证收窄的判定） */
export async function pageInSpace(pool: Pick<Pool, 'query'>, pageId: string, spaceId: string): Promise<boolean> {
  return ((await pool.query(IN_SPACE, [pageId, spaceId])).rowCount ?? 0) > 0
}

/** 名字：trim 后 1–20 字（按码点数），否则 null */
export function normalizeSpaceAiName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.replace(/\s+/g, ' ').trim()
  const n = [...name].length
  return n >= 1 && n <= SPACE_AI_NAME_MAX ? name : null
}

// ---------- 凭证范围 ----------

/** 给页面上的 agent 签凭证时的上下文（manager.pageReadTools）：精简档同原来；空间 AI 另带 space，并且不能叫别的 agent */
export function pageToolCtx(agent: Pick<ResolvedAgent, 'id' | 'space'>, pageId: string, profile: ToolProfile): Partial<GrantCtx> {
  const space = agent.space ? { space: agent.space.id } : {}
  if (profile === 'minimal') return { pageId, agentId: agent.id, canDispatch: false, profile: 'minimal', ...space }
  return { pageId, agentId: agent.id, canDispatch: !agent.space, ...space }
}

const READ_TOOLS = ['read_page', 'read_image', 'search_pages']
const WRITE_TOOLS = ['edit_page', 'create_page', 'move_page', 'rename_page', 'trash_page', 'propose_memory']

/** 收窄凭证能用的 Ramet 工具（GET /api/ramet/tools）。不列 agents：空间 AI 不叫人也不派活 */
export function spaceTools(readOnly: boolean, skills: boolean): string[] {
  return [...READ_TOOLS, ...(readOnly ? [] : WRITE_TOOLS), ...(skills ? ['use_skill'] : [])]
}

// /api/ramet/* 的白名单（方法 + 路径）。write = 有副作用，只读凭证去掉。不在表里的一律 403：
// 派活、叫人、带队、定时器、盯页面、代发评论、「不用处理」、等任务，以及以后新加的端点
const ALLOWED: Array<{ method: string; path: RegExp; write: boolean }> = [
  { method: 'GET', path: /^\/api\/ramet\/tools$/, write: false },
  { method: 'POST', path: /^\/api\/ramet\/search$/, write: false },
  { method: 'GET', path: /^\/api\/ramet\/skills\/[^/]+(\/file)?$/, write: false },
  { method: 'POST', path: /^\/api\/ramet\/pages$/, write: true },
  { method: 'POST', path: /^\/api\/ramet\/pages\/[^/]+\/(move|rename|trash)$/, write: true },
  { method: 'POST', path: /^\/api\/ramet\/memories\/propose$/, write: true },
]

/** 收窄过的凭证（空间 / 只读）能不能打这个端点 */
export function narrowedAllowed(method: string, path: string, readOnly: boolean): boolean {
  return ALLOWED.some((a) => a.method === method && a.path.test(path) && !(readOnly && a.write))
}
