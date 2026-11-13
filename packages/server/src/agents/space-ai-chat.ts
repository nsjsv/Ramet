// ---------- 和空间 AI 的直接对话：每个成员在每个开了空间 AI 的空间里一页 ----------
// 对话页在叫它的人自己的私人区（只有本人看得到；别人和空间 AI 说了什么，不该被同空间的人读到），不进页面树，来源锁定空间 AI。
// 空间 AI 平时只碰公共区（space-ai.ts），这一页是唯一的例外：它能在这里回复（解析见 space-ai.ts 的 SELECT_RESOLVABLE），读写范围照旧只有公共区。
// 照 Genet 页（assistant-agent.ts 的 ensureAssistantPage）的做法：登记行 space_ai_chats 锁住再判，并发打开两次也只建一页；页进了回收站 / 被删了，下次打开另建。
// 只读成员不建（空间 AI 以叫它的人的身份读写空间，只读成员叫不动它）；空间 AI 没开不建。

import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { putDocState } from '../collab.js'
import { withTransaction } from '../db.js'
import { INSERT, SET_TITLE } from '../routes/pages.js'
import { newPageDoc } from './markdown.js'
import { saveChoice } from './session-store.js'
import { SPACE_AI_DEFAULT_NAME, SPACE_AI_ID, SPACE_AI_JOIN } from './space-ai.js'

export type SpaceAiChat = { pageId: string; created: boolean } | { error: 'not found' | 'viewer' | 'off' }

const SELECT_STATE = `SELECT m.role, sc.id IS NOT NULL AS enabled, COALESCE(sa.name, '${SPACE_AI_DEFAULT_NAME}') AS name
  FROM spaces s JOIN space_members m ON m.space_id = s.id AND m.user_id = $2 ${SPACE_AI_JOIN} WHERE s.id = $1`
const CLAIM = 'INSERT INTO space_ai_chats (space_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING'
const LOCK = `SELECT c.page_id, p.id AS live FROM space_ai_chats c LEFT JOIN live_pages p ON p.id = c.page_id
  WHERE c.space_id = $1 AND c.user_id = $2 FOR UPDATE OF c`
const SET_PAGE = 'UPDATE space_ai_chats SET page_id = $3 WHERE space_id = $1 AND user_id = $2'

/** 对话页的标题 */
export const chatTitle = (aiName: string): string => `和 ${aiName} 的对话`

/** 我在这个空间的对话页：在就给，没有 / 进了回收站就新建（见文件头） */
export async function ensureSpaceAiChat(pool: Pool, user: { id: string }, spaceId: string): Promise<SpaceAiChat> {
  const state = (await pool.query<{ role: string; enabled: boolean; name: string }>(SELECT_STATE, [spaceId, user.id])).rows[0]
  if (!state) return { error: 'not found' }
  if (state.role === 'viewer') return { error: 'viewer' }
  if (!state.enabled) return { error: 'off' }
  return withTransaction(pool, async (db) => {
    await db.query(CLAIM, [spaceId, user.id])
    const row = (await db.query<{ page_id: string | null; live: string | null }>(LOCK, [spaceId, user.id])).rows[0]
    if (row?.page_id && row.live) return { pageId: row.page_id, created: false }
    const id = randomUUID()
    const title = chatTitle(state.name)
    await db.query(INSERT, [id, null, user.id, spaceId, false, user.id])
    // 标题同时写进 pages.title 与文档的 title 片段（编辑器以文档为准）
    await db.query(SET_TITLE, [title, id])
    await putDocState(db, `page:${id}`, newPageDoc(title, []))
    await saveChoice(db, id, SPACE_AI_ID)
    await db.query(SET_PAGE, [spaceId, user.id, id])
    return { pageId: id, created: true }
  })
}
