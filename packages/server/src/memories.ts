// ---------- 空间公共记忆 ----------
// 空间级，这个空间里所有 agent 共享。写入只有两条路：成员手动（记忆面板 / 输入卡 `/记住`，走 REST），
// 或 agent 经 propose_memory 提议、成员点「记住」（走 ramet-tools.ts 的审批）。两条路都落到 addMemory，上限与去空白只在这一处。
// 注入：每轮开跑时把这个空间的全部记忆原样带上（不筛选、不检索、不额外调模型），由 memoryBlock 渲染，
// 与会话复用的 hash 同口径（agents/prompt-env.ts 的 promptHash）：记忆变了即上下文变了，新建会话全文重放。

import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { withTransaction } from './db.js'

/** 单条上限（字数 = Unicode 码点数，前端同口径） */
export const MEMORY_ITEM_MAX = 2000
/** 每个空间合计上限：每轮全部带上，不精简就会吃掉上下文，所以硬顶 */
export const MEMORY_SPACE_MAX = 30000

export type MemoryRow = {
  id: string
  space_id: string
  text: string
  created_by: string | null
  /** 记的人的用户名（现查；删号后查不到为 null，界面显示「有人」） */
  created_by_name: string | null
  source_page_id: string | null
  created_at: string
}

/** 库里取出来的行：created_at 是 Date，对外统一成 ISO 串（浏览器都认） */
type RawRow = Omit<MemoryRow, 'created_at'> & { created_at: Date }
const toRow = (r: RawRow): MemoryRow => ({ ...r, created_at: r.created_at.toISOString() })

export type AddResult =
  | { ok: true; memory: MemoryRow }
  | { ok: false; reason: 'empty' | 'too_long' | 'space_full' | 'no_space' | 'forbidden'; message: string }

const SELECT_MEMORY = `SELECT m.id, m.space_id, m.text, m.created_by, u.username AS created_by_name, m.source_page_id, m.created_at
  FROM space_memories m LEFT JOIN users u ON u.id = m.created_by`
const SELECT_LIST = `${SELECT_MEMORY} WHERE m.space_id = $1 ORDER BY m.created_at, m.id`
const SELECT_ONE = `${SELECT_MEMORY} WHERE m.id = $1`

/** 字数：码点数（JS 的 length 按 UTF-16 单元，emoji 会多算；SQL 侧 char_length 也是码点） */
export const charCount = (text: string): number => Array.from(text).length

/** 去首尾空白、统一换行；空串无效 */
export function cleanMemoryText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').trim()
}

export async function listMemories(pool: Pool, spaceId: string): Promise<MemoryRow[]> {
  return (await pool.query<RawRow>(SELECT_LIST, [spaceId])).rows.map(toRow)
}

/** 这个空间已记的字数合计。在 JS 里按码点数：不用 SQL 的 char_length（它按库的编码算，非 UTF-8 的库会把中文数成字节）；
 *  总量被 MEMORY_SPACE_MAX 封顶，取回全部文字求和很便宜 */
export async function memoryChars(db: Pick<Pool, 'query'>, spaceId: string): Promise<number> {
  const { rows } = await db.query<{ text: string }>('SELECT text FROM space_memories WHERE space_id = $1', [spaceId])
  return rows.reduce((sum, r) => sum + charCount(r.text), 0)
}

/** 提前判一条文字能不能写（不落库）：propose_memory 在打扰用户之前先判，写不进去就直接回告 agent */
export async function checkMemory(pool: Pool, spaceId: string, raw: string): Promise<{ ok: true; text: string } | Extract<AddResult, { ok: false }>> {
  const text = cleanMemoryText(raw)
  const n = charCount(text)
  if (n === 0) return { ok: false, reason: 'empty', message: '内容不能为空' }
  if (n > MEMORY_ITEM_MAX) return { ok: false, reason: 'too_long', message: `单条记忆最多 ${MEMORY_ITEM_MAX} 字（这条 ${n} 字），请精简` }
  const used = await memoryChars(pool, spaceId)
  if (used + n > MEMORY_SPACE_MAX) {
    return { ok: false, reason: 'space_full', message: `这个空间的记忆已有 ${used} 字，再加这条会超过 ${MEMORY_SPACE_MAX} 字的上限，请先删掉不用的` }
  }
  return { ok: true, text }
}

/** 写一条记忆（唯一写入口）。空间行加锁后再算合计，并发添加不会一起越过上限。
 *  写的人（createdBy：面板 / `/记住` 的操作人，或在提议上点「记住」的人）必须是该空间的 owner / member，
 *  记忆会进这个空间里每一轮 agent（包括跑在别人机器上的），不是成员的全局 admin 也不行 */
export async function addMemory(pool: Pool, spaceId: string, raw: string, createdBy: string, sourcePageId: string | null): Promise<AddResult> {
  const text = cleanMemoryText(raw)
  const n = charCount(text)
  if (n === 0) return { ok: false, reason: 'empty', message: '内容不能为空' }
  if (n > MEMORY_ITEM_MAX) return { ok: false, reason: 'too_long', message: `单条记忆最多 ${MEMORY_ITEM_MAX} 字（这条 ${n} 字），请精简` }
  return withTransaction(pool, async (client): Promise<AddResult> => {
    const locked = await client.query('SELECT 1 FROM spaces WHERE id = $1 FOR UPDATE', [spaceId])
    if (locked.rowCount === 0) return { ok: false, reason: 'no_space', message: '空间不存在' }
    const member = await client.query(
      "SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2 AND role IN ('owner', 'member')",
      [spaceId, createdBy],
    )
    if (member.rowCount === 0) return { ok: false, reason: 'forbidden', message: '只有这个空间的成员（非只读）能记下记忆' }
    const used = await memoryChars(client, spaceId)
    if (used + n > MEMORY_SPACE_MAX) {
      return { ok: false, reason: 'space_full', message: `这个空间的记忆已有 ${used} 字，再加这条会超过 ${MEMORY_SPACE_MAX} 字的上限，请先删掉不用的` }
    }
    const id = randomUUID()
    await client.query('INSERT INTO space_memories (id, space_id, text, created_by, source_page_id) VALUES ($1, $2, $3, $4, $5)', [id, spaceId, text, createdBy, sourcePageId])
    const row = (await client.query<RawRow>(SELECT_ONE, [id])).rows[0]
    if (!row) throw new Error('记忆写入后读不到')
    return { ok: true, memory: toRow(row) }
  })
}

/** 删一条；记忆必须属于这个空间（跨空间的 id 当不存在）。返回是否真的删了 */
export async function deleteMemory(pool: Pool, spaceId: string, memoryId: string): Promise<boolean> {
  const res = await pool.query('DELETE FROM space_memories WHERE id = $1 AND space_id = $2', [memoryId, spaceId])
  return (res.rowCount ?? 0) > 0
}

/** 记忆块的提示词文字；没有记忆返回 ''（调用方据此不加这一段，hash 与没有记忆时完全一致）。
 *  逐条一个列表项，多行记忆的续行缩进两格；标明来源，agent 知道这是成员确认过的 */
export function memoryBlock(items: ReadonlyArray<{ text: string }>): string {
  if (items.length === 0) return ''
  const lines = items.map((m) => `- ${m.text.split('\n').join('\n  ')}`)
  return ['这个空间的公共记忆（由成员确认记下，所有 agent 共享，请遵循）：', ...lines].join('\n')
}

/** 页面所在空间的记忆块（页面不存在 / 已回收 / 没有空间返回 ''） */
export async function memoryBlockOfPage(pool: Pool, pageId: string): Promise<string> {
  const { rows } = await pool.query<{ space_id: string | null }>('SELECT space_id FROM live_pages WHERE id = $1', [pageId])
  const spaceId = rows[0]?.space_id
  if (!spaceId) return ''
  const { rows: items } = await pool.query<{ text: string }>('SELECT text FROM space_memories WHERE space_id = $1 ORDER BY created_at, id', [spaceId])
  return memoryBlock(items)
}
