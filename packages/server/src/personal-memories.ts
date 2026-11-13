// ---------- 个人记忆：按人存，只有本人看得到，只给 Genet ----------
// 与空间公共记忆（memories.ts）是两回事：空间记忆进那个空间里每一轮 agent（包括跑在别人机器上的），个人记忆只进这个人的 Genet
// （Genet 跑在中心，不经任何机器；机器上的 agent 拿不到，会话文件会留在那台机器上）。上限、去空白、字数口径与空间记忆同一套。
// 写入只有本人：`/ai/memory` 手动、Genet 页和它下面的任务页上 `/记住`（routes/my-memories.ts），或 Genet 不带 space 的提议经本人点「记住」。

import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { withTransaction } from './db.js'
import { MEMORY_ITEM_MAX, MEMORY_SPACE_MAX, charCount, cleanMemoryText, type AddResult } from './memories.js'

export type PersonalMemoryRow = { id: string; text: string; source_page_id: string | null; created_at: string }
type RawRow = Omit<PersonalMemoryRow, 'created_at'> & { created_at: Date }
const toRow = (r: RawRow): PersonalMemoryRow => ({ ...r, created_at: r.created_at.toISOString() })

const SELECT_LIST = 'SELECT id, text, source_page_id, created_at FROM user_memories WHERE user_id = $1 ORDER BY created_at, id'

export async function listPersonalMemories(pool: Pick<Pool, 'query'>, userId: string): Promise<PersonalMemoryRow[]> {
  return (await pool.query<RawRow>(SELECT_LIST, [userId])).rows.map(toRow)
}

/** 合计字数（码点数，同 memories.ts 的 memoryChars） */
export async function personalMemoryChars(db: Pick<Pool, 'query'>, userId: string): Promise<number> {
  const { rows } = await db.query<{ text: string }>('SELECT text FROM user_memories WHERE user_id = $1', [userId])
  return rows.reduce((sum, r) => sum + charCount(r.text), 0)
}

const fullMessage = (used: number): string =>
  `你的个人记忆已有 ${used} 字，再加这条会超过 ${MEMORY_SPACE_MAX} 字的上限，请先删掉不用的`

/** 提前判一条能不能记（不落库）：Genet 的提议在打扰用户之前先判 */
export async function checkPersonalMemory(pool: Pool, userId: string, raw: string): Promise<{ ok: true; text: string } | Extract<AddResult, { ok: false }>> {
  const text = cleanMemoryText(raw)
  const n = charCount(text)
  if (n === 0) return { ok: false, reason: 'empty', message: '内容不能为空' }
  if (n > MEMORY_ITEM_MAX) return { ok: false, reason: 'too_long', message: `单条记忆最多 ${MEMORY_ITEM_MAX} 字（这条 ${n} 字），请精简` }
  const used = await personalMemoryChars(pool, userId)
  if (used + n > MEMORY_SPACE_MAX) return { ok: false, reason: 'space_full', message: fullMessage(used) }
  return { ok: true, text }
}

export type AddPersonalResult = { ok: true; memory: PersonalMemoryRow } | Extract<AddResult, { ok: false }>

/** 记一条（唯一写入口）。用户行加锁后再算合计，并发添加不会一起越过上限 */
export async function addPersonalMemory(pool: Pool, userId: string, raw: string, sourcePageId: string | null): Promise<AddPersonalResult> {
  const text = cleanMemoryText(raw)
  const n = charCount(text)
  if (n === 0) return { ok: false, reason: 'empty', message: '内容不能为空' }
  if (n > MEMORY_ITEM_MAX) return { ok: false, reason: 'too_long', message: `单条记忆最多 ${MEMORY_ITEM_MAX} 字（这条 ${n} 字），请精简` }
  return withTransaction(pool, async (client): Promise<AddPersonalResult> => {
    if (!(await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId])).rowCount) {
      return { ok: false, reason: 'forbidden', message: '账号不存在' }
    }
    const used = await personalMemoryChars(client, userId)
    if (used + n > MEMORY_SPACE_MAX) return { ok: false, reason: 'space_full', message: fullMessage(used) }
    const id = randomUUID()
    const row = (
      await client.query<RawRow>(
        'INSERT INTO user_memories (id, user_id, text, source_page_id) VALUES ($1, $2, $3, $4) RETURNING id, text, source_page_id, created_at',
        [id, userId, text, sourcePageId],
      )
    ).rows[0]
    if (!row) throw new Error('记忆写入后读不到')
    return { ok: true, memory: toRow(row) }
  })
}

/** 删一条；不是我的 = 不存在。返回是否真的删了 */
export async function deletePersonalMemory(pool: Pool, userId: string, memoryId: string): Promise<boolean> {
  const res = await pool.query('DELETE FROM user_memories WHERE id = $1 AND user_id = $2', [memoryId, userId])
  return (res.rowCount ?? 0) > 0
}
