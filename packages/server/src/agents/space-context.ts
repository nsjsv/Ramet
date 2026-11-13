// ---------- 空间上下文块：Genet 跨空间时带的「空间清单 / 个人记忆 / 某个空间的约定」，唯一渲染 ----------
// 块的头一行都是 Ramet 加的方括号行（写法在 Genet 的 system 提示词里有说明，两处同改）。一个空间的约定 = 它的公共记忆 + skill 清单；
// 指纹（hash）只随内容变：Genet 同一个会话里带过、没变就不再带（genet-context.ts）。
// 页面上 agent 的记忆（pageMemory）：页面所在空间的记忆块（memories.ts 的 memoryBlock，原样）+ 页面记着的目标空间（Genet 派活时记的
// agent_session.contextSpace）的约定。没有目标空间时与 memoryBlockOfPage 逐字节相同，别的 agent 的提示词不变。
// 空间清单、目标空间都按成员行判：空间级的约定只给成员（访客看得到页，看不到空间的约定）。

import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { memoryBlockOfPage } from '../memories.js'
import { listPersonalMemories } from '../personal-memories.js'
import { listSkills } from '../skills.js'

export type SpaceRole = 'owner' | 'member' | 'viewer'
export type SpaceRef = { id: string; name: string; role: SpaceRole }
export type SkillLine = { name: string; description: string }
export type SpaceContext = { memory: string[]; skills: SkillLine[]; hash: string }
/** here = 用户此刻在这个空间里；asked = Genet 用 read_space 取的；task = 派出去的任务在这个空间里做 */
export type SpaceWhy = 'here' | 'asked' | 'task'

/** skill 清单的上限：同 MCP 工具说明里的索引（mcp/tools/skills.mjs），每条 300 字、合计 8000 字、至多 100 个 */
const SKILL_ITEM_MAX = 300
const SKILL_TOTAL_MAX = 8000
const SKILL_COUNT_MAX = 100

const ROLE_LABEL: Record<SpaceRole, string> = { owner: '所有者', member: '成员', viewer: '只读成员' }

const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)

const SELECT_SPACE_MEMORY = 'SELECT text FROM space_memories WHERE space_id = $1 ORDER BY created_at, id'

export async function spaceContext(pool: Pool, spaceId: string): Promise<SpaceContext> {
  const [memory, skills] = await Promise.all([
    pool.query<{ text: string }>(SELECT_SPACE_MEMORY, [spaceId]).then((r) => r.rows.map((m) => m.text)),
    listSkills(pool, spaceId).then((list) => list.slice(0, SKILL_COUNT_MAX).map((s) => ({ name: s.name, description: s.description }))),
  ])
  return { memory, skills, hash: sha({ memory, skills }) }
}

const bullet = (text: string): string => `- ${text.split('\n').join('\n  ')}`

function skillIndex(skills: readonly SkillLine[]): string[] {
  const lines: string[] = []
  let used = 0
  for (const s of skills) {
    const desc = s.description.replace(/\s+/g, ' ')
    const line = `- ${s.name}：${desc.length > SKILL_ITEM_MAX ? `${desc.slice(0, SKILL_ITEM_MAX - 1)}…` : desc}`
    if (used + line.length > SKILL_TOTAL_MAX) {
      lines.push(`（还有 ${skills.length - lines.length} 个没列出，知道名字就直接用）`)
      break
    }
    lines.push(line)
    used += line.length
  }
  return lines
}

const WHY_HEAD: Record<SpaceWhy, string> = {
  here: '用户此刻在这个空间里',
  asked: '你用 read_space 取的',
  task: '这个任务在这个空间里做，要守它的约定',
}

/** 一个空间的约定。task（派出去的任务页上的 agent）不列 skill：它的 use_skill 本来就是这个空间的 skill（工具说明里有索引） */
export function renderSpaceBlock(space: { id: string; name: string }, ctx: SpaceContext, why: SpaceWhy): string {
  const out = [`[Ramet 空间上下文：「${space.name}」space:${space.id}，${WHY_HEAD[why]}]`]
  if (ctx.memory.length) out.push('这个空间的公共记忆（由成员确认记下，在这个空间里干活请遵循）：', ...ctx.memory.map(bullet))
  else out.push('这个空间还没有公共记忆。')
  if (why !== 'task') {
    if (ctx.skills.length) out.push(`这个空间的 skill（用 use_skill 时 space 填 ${space.id}）：`, ...skillIndex(ctx.skills))
    else out.push('这个空间没有 skill。')
  }
  return out.join('\n')
}

/** 个人记忆的条目与指纹 */
export async function personalMemory(pool: Pool, userId: string): Promise<{ items: string[]; hash: string }> {
  const items = (await listPersonalMemories(pool, userId)).map((m) => m.text)
  return { items, hash: sha(items) }
}

/** updated = 同一个会话里之前带过、现在变了（可能删空了：要明说，不然模型还守着旧的） */
export function renderPersonalMemory(items: readonly string[], why: 'start' | 'updated'): string {
  const head = `[Ramet 个人记忆：用户本人确认记下，只有他看得到${why === 'updated' ? '（有更新，以这一份为准）' : ''}]`
  return [head, ...(items.length ? items.map(bullet) : ['现在没有个人记忆。'])].join('\n')
}

export type ListedSpace = SpaceRef & { memories: number; skills: number }

const SELECT_MY_SPACES = `SELECT s.id, s.name, m.role,
    (SELECT count(*)::int FROM space_memories x WHERE x.space_id = s.id) AS memories,
    (SELECT count(*)::int FROM skills k JOIN live_pages kp ON kp.id = k.page_id WHERE k.space_id = s.id) AS skills
  FROM space_members m JOIN spaces s ON s.id = m.space_id WHERE m.user_id = $1 ORDER BY s.created_at, s.id`

/** 用户是成员的空间（访客空间不在：那里没有他能守的约定） */
export async function mySpaces(pool: Pool, userId: string): Promise<ListedSpace[]> {
  return (await pool.query<ListedSpace>(SELECT_MY_SPACES, [userId])).rows
}

export function renderSpaceList(list: readonly ListedSpace[]): string {
  const lines = list.map((s) => `- 「${s.name}」space:${s.id}（用户是${ROLE_LABEL[s.role]}；公共记忆 ${s.memories} 条，skill ${s.skills} 个）`)
  return ['[Ramet 空间清单：用户所在的空间]', ...(lines.length ? lines : ['（没有）'])].join('\n')
}

/** 清单的指纹只取 id / 名字 / 角色：条数常变，不该让清单反复重发 */
export function listHash(list: readonly ListedSpace[]): string {
  return sha(list.map((s) => [s.id, s.name, s.role]))
}

// 页面记着的目标空间，且页面的创建人（派活人）此刻仍是那个空间的成员
const SELECT_TARGET = `SELECT s.id, s.name FROM live_pages p
  JOIN spaces s ON s.id = p.agent_session->>'contextSpace'
  JOIN space_members m ON m.space_id = s.id AND m.user_id = p.owner_id
  WHERE p.id = $1`

/** 页面上 agent 的记忆：页面所在空间的记忆块 + 目标空间的约定（见文件头） */
export async function pageMemory(pool: Pool, pageId: string): Promise<string> {
  const [base, target] = await Promise.all([
    memoryBlockOfPage(pool, pageId),
    pool.query<{ id: string; name: string }>(SELECT_TARGET, [pageId]).then((r) => r.rows[0]),
  ])
  if (!target) return base
  const block = renderSpaceBlock(target, await spaceContext(pool, target.id), 'task')
  return base ? `${base}\n\n${block}` : block
}

const SET_TARGET = `UPDATE pages SET agent_session = COALESCE(agent_session, '{}'::jsonb) || jsonb_build_object('contextSpace', $2::text) WHERE id = $1`

/** 派活时记下任务页的目标空间 */
export async function saveContextSpace(pool: Pick<Pool, 'query'>, pageId: string, spaceId: string): Promise<void> {
  await pool.query(SET_TARGET, [pageId, spaceId])
}

const SELECT_TARGET_OF_GRANT = `SELECT p.agent_session->>'contextSpace' AS space FROM live_pages p
  JOIN space_members m ON m.space_id = p.agent_session->>'contextSpace' AND m.user_id = $2 WHERE p.id = $1`

/** 任务页上的 agent 用哪个空间的 skill：页面记着目标空间、且用的人是那里的成员 → 目标空间；否则 null（照旧按页面所在空间） */
export async function contextSpaceOf(pool: Pool, pageId: string, userId: string): Promise<string | null> {
  return (await pool.query<{ space: string }>(SELECT_TARGET_OF_GRANT, [pageId, userId])).rows[0]?.space ?? null
}

const SELECT_MEMBER_SPACE = `SELECT s.id, s.name FROM spaces s JOIN space_members m ON m.space_id = s.id AND m.user_id = $2 WHERE s.id = $1`
const SELECT_REF_SPACES = `SELECT DISTINCT s.id, s.name FROM live_pages p JOIN spaces s ON s.id = p.space_id
  JOIN space_members m ON m.space_id = s.id AND m.user_id = $2 WHERE p.id = ANY($1::text[])`
const PAGE_REF = /page:([0-9a-f-]{36})/gi

/** 派活的目标空间：给了就要是成员（不是 = null，调用方报错）；没给就看任务说明里 page:<id> 提到的、用户是成员的空间，恰好一个才算 */
export async function taskSpace(pool: Pool, userId: string, wanted: string | undefined, task: string): Promise<{ id: string; name: string } | null | 'not-member'> {
  if (wanted) return (await pool.query<{ id: string; name: string }>(SELECT_MEMBER_SPACE, [wanted, userId])).rows[0] ?? 'not-member'
  const ids = [...new Set([...task.matchAll(PAGE_REF)].map((m) => m[1]!.toLowerCase()))]
  if (ids.length === 0) return null
  const rows = (await pool.query<{ id: string; name: string }>(SELECT_REF_SPACES, [ids, userId])).rows
  return rows.length === 1 ? rows[0]! : null
}
