// ---------- Genet：每个用户一个、跑在中心里的 agent（身份与 Genet 页的唯一定义） ----------
// Genet 是第五种驱动（drivers/assistant/driver.ts），接进现有的会话机制：Genet 页就是一个普通的对话页，回复、过程页、审批、
// 原生会话优先都照旧。它和别的 agent 不同的地方都由这里回答，别处只调这里的判定：
//   - catalog id 固定是 ASSISTANT_ID，不进通用目录（别的页面的选择器、@ 菜单里都没有它）；
//   - 只在「这一页就是发起人自己的 Genet 页」时解析得出来（resolveAssistant，manager.resolve 带着页面调它），
//     所以普通的继续 / @ 链 / 重新生成 / 续跑 / 排队派发 / 预备会话都走同一个判定，不在各入口另写；
//   - 不在任何机器上跑：凭据是 machine-access.ts 的 assistantPass，不判机器使用权、不记使用；没有工作区（cwd 恒为空）。
// Genet 页：个人空间顶层、主人私人区里的一个 doc 页（只有他看得到），记在 assistants 表里；进了回收站就当没有，下次唤起新建一个（旧页照常留在回收站）。
//   它不进页面树（in_page_tree = false，入口是侧栏的「AI」），派出去的任务页挂在它下面，跟着祖先链一起不在树里；
//   照常能打开、搜索、提及、回收。

import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { myPersonalSpaceId } from '../clone.js'
import { putDocState } from '../collab.js'
import { withTransaction } from '../db.js'
import { INSERT, SET_TITLE } from '../routes/pages.js'
import { assistantPass } from './machine-access.js'
import type { ResolvedAgent } from './manager-types.js'
import { newPageDoc } from './markdown.js'
import { RESERVED_AGENT_PREFIX } from './registry.js'
import { saveChoice } from './session-store.js'

export const ASSISTANT_ID = `${RESERVED_AGENT_PREFIX}assistant`
/** Genet 页的默认标题，也是 Genet 在署名里的名字 */
export const ASSISTANT_LABEL = 'Genet'

export function isAssistantId(agentId: string): boolean {
  return agentId === ASSISTANT_ID
}

/** 能不能当带队的组长：带队时组员是中心替组长同步跑的子运行（team.ts），Genet 不能同步调用别的 agent，所以不能带队 */
export function canLeadTeam(agent: Pick<ResolvedAgent, 'assistant'>): boolean {
  return !agent.assistant
}

export const NO_TEAM_LEAD = 'Genet 不能带队：要几个 agent 一起做，请到普通的对话页里用 /带队；在这里可以让 Genet 把活派出去'

// Genet 页 = assistants 里登记的、还活着的那一页（回收站里的不算）
const IS_ASSISTANT_PAGE = `SELECT 1 FROM assistants a JOIN live_pages p ON p.id = a.page_id WHERE a.user_id = $1 AND a.page_id = $2`
const CLAIM = 'INSERT INTO assistants (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING'
const LOCK = `SELECT a.page_id, p.id AS live FROM assistants a LEFT JOIN live_pages p ON p.id = a.page_id
  WHERE a.user_id = $1 FOR UPDATE OF a`
const SET_PAGE = 'UPDATE assistants SET page_id = $2 WHERE user_id = $1'

// 这一页或它的某个祖先是谁的 Genet 页（至多 64 层）
const GENET_OWNER_OF = `WITH RECURSIVE up(id, parent_id, n) AS (
    SELECT id, parent_id, 0 FROM pages WHERE id = $1
    UNION ALL SELECT p.id, p.parent_id, up.n + 1 FROM pages p JOIN up ON p.id = up.parent_id WHERE up.n < 64
  ) SELECT a.user_id FROM up JOIN assistants a ON a.page_id = up.id ORDER BY up.n LIMIT 1`

/** 这页在谁的 Genet 子树里（Genet 页本身、它下面的任务页 / 过程页）；不在 = null。
 *  `/记住` 与 Genet 的提议在这里缺省记进个人记忆；Genet 收「眼前的空间」时跳过这些页（它们只是放在那个空间里） */
export async function genetOwnerOf(pool: Pick<Pool, 'query'>, pageId: string): Promise<string | null> {
  return (await pool.query<{ user_id: string }>(GENET_OWNER_OF, [pageId])).rows[0]?.user_id ?? null
}

/** 这一页是不是这个人的 Genet 页（活的） */
export async function isAssistantPage(pool: Pool, userId: string, pageId: string): Promise<boolean> {
  return ((await pool.query(IS_ASSISTANT_PAGE, [userId, pageId])).rowCount ?? 0) > 0
}

/** Genet 的执行目标：只在发起人自己的 Genet 页上有，否则 null（调用方当未知 agent） */
export async function resolveAssistant(pool: Pool, user: { id: string }, pageId: string): Promise<ResolvedAgent | null> {
  if (!(await isAssistantPage(pool, user.id, pageId))) return null
  return { id: ASSISTANT_ID, pass: assistantPass(user), assistant: true }
}

/** 这个人的 Genet 页：在就直接给；没有、或进了回收站，就在个人空间顶层的私人区新建一页（标题「Genet」，来源记成 Genet，不进页面树）再登记。
 *  同一个事务里先锁住这个人的登记行，并发唤起两次也只建一页 */
export async function ensureAssistantPage(pool: Pool, user: { id: string }): Promise<{ pageId: string; created: boolean }> {
  const spaceId = await myPersonalSpaceId(pool, user.id)
  if (!spaceId) throw new Error('拿不到个人空间')
  return withTransaction(pool, async (db) => {
    await db.query(CLAIM, [user.id])
    const row = (await db.query<{ page_id: string | null; live: string | null }>(LOCK, [user.id])).rows[0]
    if (row?.page_id && row.live) return { pageId: row.page_id, created: false }
    const id = randomUUID()
    // 建在主人自己那个空间的私人区：Genet 的对话只有他看得到（任务页、过程页挂在它下面，跟着同区）
    await db.query(INSERT, [id, null, user.id, spaceId, false, user.id])
    // 标题同时写进 pages.title 与文档的 title 片段（编辑器以文档为准，只写其一会被空文档冲掉）
    await db.query(SET_TITLE, [ASSISTANT_LABEL, id])
    await putDocState(db, `page:${id}`, newPageDoc(ASSISTANT_LABEL, []))
    await saveChoice(db, id, ASSISTANT_ID)
    await db.query(SET_PAGE, [user.id, id])
    return { pageId: id, created: true }
  })
}

// CommonMark 允许反斜杠转义的全部 ASCII 标点
const MARKDOWN_PUNCT = /[!-\/:-@[-`{-~]/g

/** 任务页在回复里的写法：`[@标题](page:<id>)`。回复的 markdown 落块时（@ramet/shared/markdown-blocks 的 pageMentionOf）
 *  「文字恰为 @名字、只有这一个 page: 链接」的这段直接落成页面提及（page_mention）。标题里的 markdown 记号全部转义：
 *  不然加粗 / 方括号会把这段拆成几截文字，落不成提及。`==高亮==` 是解析之后在文字上认的方言（md-dialect/inline.ts），
 *  转义挡不住，只能在相邻的两个 `=` 之间垫一个零宽空格（落成提及时再去掉） */
export function taskMention(title: string, pageId: string): string {
  const label = title.replace(/\s+/g, ' ').trim().replace(/=(?==)/g, '=\u200b').replace(MARKDOWN_PUNCT, '\\$&')
  return `[@${label}](page:${pageId})`
}
