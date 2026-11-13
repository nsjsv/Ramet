// ---------- 访客不能在宿主空间的页上用 AI ----------
// 访客 = 不是页面所在空间的成员、靠分享看得到这页的人。AI 一跑就带上这个空间的上下文（记忆、skill、空间约定），
// 还会经 MCP 读写空间里的页，这些都只给成员；访客要用 AI 得先被拉进空间（同 Notion：访客不能用 AI）。
// 在 AgentManager.resolve 带页面解析时判：发起、继续、重新生成、续跑、排队派发、@ 链都要经它拿执行目标。
import type { Pool } from 'pg'
import { pageVisibleSql } from '../page-visibility.js'
import { ForbiddenError } from './posture.js'

export const GUEST_NO_AI = '你是这个空间的访客，不能在这里用 AI'

// 只算他看得到的页：页还不存在（Genet 派活先判 agent 能不能用、再建任务页）、看不到（与不存在同一个 404）都不算，那时的页面闸由调用方自己判
const AS_GUEST = `SELECT 1 FROM pages p WHERE p.id = $1
  AND NOT EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = p.space_id AND m.user_id = $2)
  AND ${pageVisibleSql('p', '$2')}`

/** 这页我看得到、又不是它所在空间的成员（访客），就抛 ForbiddenError（路由转 403，文案给用户看） */
export async function assertNotGuest(pool: Pool, userId: string, pageId: string): Promise<void> {
  if ((await pool.query(AS_GUEST, [pageId, userId])).rowCount) throw new ForbiddenError(GUEST_NO_AI)
}

export const GUEST_AI_READONLY = '用户是这个空间的访客，AI 只能读这里的页，不能改'

/** 这页存在、用户又不是它所在空间的成员（作为访客看到的页）。agent 经 MCP 写页面的闸（ramet-tools.ts 的 writablePage、page-read.ts 的写端点）用：
 *  访客不能在宿主空间里用 AI，他在别处跑的 agent 也不能替他改那里的页；读不拦（他本来就看得到） */
export async function isGuestOf(pool: Pool, userId: string, pageId: string): Promise<boolean> {
  return ((await pool.query(AS_GUEST, [pageId, userId])).rowCount ?? 0) > 0
}
