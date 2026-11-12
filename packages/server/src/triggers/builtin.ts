// ---------- 内置规则：每人一条「评论找我」、一条「正文 @我」 ----------
// 打开后，别人在评论里找我、在正文里 @我时叫醒 Genet 判断要不要处理。默认关：每来一条就跑一轮 Genet、花的是主人自己的模型额度，
// 开不开由主人决定；关着时这些事照样进收件箱（评论 / 正文 @ 条目不靠规则），要回就在收件箱点「代回复」自己起草。
// 两条都是普通规则（agent_triggers 一行，builtin = 来源名），走同一条派发流程；只是不能删（只能关），名字不能改，
// 也不能在 AI 页另建同来源的规则（一人多条只会把同一件事通知好几遍）。策略（叫 Genet 的指令）、动作、配置、启停都能改。
// 什么时候补建：来源要给某人发事件之前（他配了模型连接才补，没配的人不必凭空多两行）、AI 页列规则之前。
// 「还不能生效」（dormant）：动作里有叫 Genet，而主人还没配模型连接、或者还没有 Genet 页 —— 这时事件来了直接不发
// （不落记录、不进收件箱、不算失败），配好之后自动生效；打开了的规则不该给还没用上 AI 的人制造失败提醒。

import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { myPersonalSpaceId } from '../clone.js'
import { parseActions, type Action } from './actions.js'
import { legacyColumns, userTimeZone } from './store.js'

export const BUILTIN_SOURCES = ['comment', 'mention'] as const
export type BuiltinSource = (typeof BUILTIN_SOURCES)[number]

export function isBuiltinSource(raw: unknown): raw is BuiltinSource {
  return typeof raw === 'string' && (BUILTIN_SOURCES as readonly string[]).includes(raw)
}

/** 内置规则缺省的处理策略（叫 Genet 的指令） */
export const DEFAULT_POLICY = '判断要不要我处理：要回复就起草回复给我看；只是告知就标记不用处理'

export const BUILTIN_NO_DELETE = '内置规则只能关，不能删'
export const BUILTIN_NO_RENAME = '内置规则不能改名字'

/** 评论为什么找我（与收件箱评论条目的 reason 同一套：comments/inbox.ts 的 commentReason） */
export const COMMENT_REASONS = ['mention', 'reply', 'new_thread'] as const
export type CommentReason = (typeof COMMENT_REASONS)[number]

const REASON_LABEL: Record<CommentReason, string> = { mention: '@我', reply: '回复我参与的串', new_thread: '在我的页面上开新串' }
/** 事件通知里「为什么找你」那一行 */
export const REASON_TEXT: Record<CommentReason, string> = { mention: '评论里 @了你', reply: '回复了你参与的评论串', new_thread: '在你的页面上开了新的评论串' }

export type CommentConfig = { reasons: CommentReason[]; spaces: string[] }
export type MentionConfig = { spaces: string[] }

const SPACES_MAX = 50
const ID_MAX = 100

function record(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

/** 只看哪些空间：不填 / 空 = 全部 */
function spacesOf(raw: unknown): string[] | { error: string } {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== 'string' || !s.trim() || s.length > ID_MAX)) return { error: 'spaces 要写成空间 id 的列表（空 = 全部空间）' }
  const out = [...new Set(raw.map((s: string) => s.trim()))]
  return out.length > SPACES_MAX ? { error: `最多选 ${SPACES_MAX} 个空间` } : out
}

export function parseCommentConfig(raw: unknown): CommentConfig | { error: string } {
  const r = record(raw)
  const spaces = spacesOf(r.spaces)
  if ('error' in spaces) return spaces
  if (r.reasons === undefined) return { reasons: [...COMMENT_REASONS], spaces }
  if (!Array.isArray(r.reasons) || r.reasons.some((x) => !(COMMENT_REASONS as readonly unknown[]).includes(x))) {
    return { error: 'reasons 只能从 mention（@我）、reply（回复我参与的串）、new_thread（我页面上的新串）里选' }
  }
  const reasons = COMMENT_REASONS.filter((x) => (r.reasons as unknown[]).includes(x))
  return reasons.length > 0 ? { reasons, spaces } : { error: '至少选一种：@我、回复我参与的串、我页面上的新串' }
}

export function parseMentionConfig(raw: unknown): MentionConfig | { error: string } {
  const spaces = spacesOf(record(raw).spaces)
  return 'error' in spaces ? spaces : { spaces }
}

/** 库里读出来的配置：认不出就按缺省（全部原因、全部空间），不让一条坏配置把事件全挡掉 */
function commentConfig(raw: unknown): CommentConfig {
  const c = parseCommentConfig(raw)
  return 'error' in c ? { reasons: [...COMMENT_REASONS], spaces: [] } : c
}

function spaceText(spaces: string[]): string {
  return spaces.length > 0 ? ` · 只看 ${spaces.length} 个空间` : ''
}

export function describeComment(raw: unknown): string {
  const c = commentConfig(raw)
  const list = c.reasons.map((r) => REASON_LABEL[r]).join('、')
  // 「评论里 @我」与「正文里 @我」同一个写法：汉字与 @ 之间空一格
  return `评论里${list.startsWith('@') ? ' ' : ''}${list}${spaceText(c.spaces)}`
}

export function describeMention(raw: unknown): string {
  const c = parseMentionConfig(raw)
  return `正文里 @我${spaceText('error' in c ? [] : c.spaces)}`
}

/** 这条评论事件合不合这条规则的配置 */
export function commentMatches(raw: unknown, reason: CommentReason, spaceId: string): boolean {
  const c = commentConfig(raw)
  return c.reasons.includes(reason) && (c.spaces.length === 0 || c.spaces.includes(spaceId))
}

export function mentionMatches(raw: unknown, spaceId: string): boolean {
  const c = parseMentionConfig(raw)
  return 'error' in c || c.spaces.length === 0 || c.spaces.includes(spaceId)
}

/** 主人现在能不能让 Genet 干活：有没有模型连接、有没有活的 Genet 页 */
export type AiState = { connection: boolean; genet: boolean }

const SELECT_AI_STATE = `SELECT EXISTS (SELECT 1 FROM user_ai_connections WHERE user_id = $1) AS connection,
  EXISTS (SELECT 1 FROM assistants a JOIN live_pages p ON p.id = a.page_id WHERE a.user_id = $1) AS genet`

export async function aiState(pool: Pick<Pool, 'query'>, userId: string): Promise<AiState> {
  const row = (await pool.query<AiState>(SELECT_AI_STATE, [userId])).rows[0]
  return { connection: row?.connection ?? false, genet: row?.genet ?? false }
}

/** 还不能生效：code 给前端挑补救按钮（去设置配连接 / 打开 Genet），text 是显示的人话 */
export type DormantCode = 'no_connection' | 'no_genet_page'
export type Dormant = { code: DormantCode; text: string }

const DORMANT: Record<DormantCode, Dormant> = {
  no_connection: { code: 'no_connection', text: '配好模型连接后生效' },
  no_genet_page: { code: 'no_genet_page', text: '打开一次 AI 页后生效' },
}

/** 规则此刻为什么还不能生效（只看叫 Genet：别的动作不靠模型连接）；能 = null */
export function dormantReason(actions: unknown, state: AiState): Dormant | null {
  const parsed = parseActions(actions)
  if ('error' in parsed || !parsed.some((a) => a.type === 'genet')) return null
  if (!state.connection) return DORMANT.no_connection
  if (!state.genet) return DORMANT.no_genet_page
  return null
}

const BUILTIN: Record<BuiltinSource, { name: string; config: CommentConfig | MentionConfig }> = {
  comment: { name: '评论找我', config: { reasons: [...COMMENT_REASONS], spaces: [] } },
  mention: { name: '正文 @我', config: { spaces: [] } },
}

// 新建的一律关着（enabled = false），见文件头
const INSERT_BUILTIN = `INSERT INTO agent_triggers (id, space_id, owner_id, source, builtin, name, instruction, spec, config, time_zone, target_page, agent, actions, enabled)
  VALUES ($1, $2, $3, $4, $4, $5, $6, '{}'::jsonb, $7::jsonb, $8, $9, $10, $11::jsonb, false)
  ON CONFLICT (owner_id, builtin) WHERE builtin IS NOT NULL DO NOTHING`

/** 把这个人缺的内置规则补上，补上的是关着的（已有的不动：打开的、改过策略的都原样留着）。规则所在空间 = 个人空间 */
export async function ensureBuiltin(pool: Pool, userId: string): Promise<void> {
  const have = (await pool.query<{ builtin: string }>('SELECT builtin FROM agent_triggers WHERE owner_id = $1 AND builtin IS NOT NULL', [userId])).rows
  const missing = BUILTIN_SOURCES.filter((b) => !have.some((r) => r.builtin === b))
  if (missing.length === 0) return
  const space = await myPersonalSpaceId(pool, userId)
  if (!space) return
  const actions: Action[] = [{ type: 'genet', instruction: DEFAULT_POLICY }]
  const legacy = await legacyColumns(pool, userId, actions)
  const tz = await userTimeZone(pool, userId)
  for (const b of missing) {
    await pool.query(INSERT_BUILTIN, [
      randomUUID(), space, userId, b, BUILTIN[b].name, legacy.instruction, JSON.stringify(BUILTIN[b].config), tz, legacy.target, legacy.agent, JSON.stringify(actions),
    ])
  }
}
