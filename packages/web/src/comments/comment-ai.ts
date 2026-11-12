/* ---------- 评论里的 AI：@ 菜单给谁、选中落成什么记号、AI 写的评论谁能删 / 改 ----------
 * 个人空间（以及还不知道是不是团队空间：公开页、空间列表还没到）里是 Genet：叫的是写评论的人自己的 Genet（服务端 comments/genet-call.ts）；
 * 团队空间里是这个空间的 AI（开着时）：空间共用、回复以它自己的名义出现（comments/space-ai-call.ts）；没开就两个都不给，
 * 团队空间里不给个人 Genet 的入口（同一个串里的人都该叫得动、看得懂同一个 AI）。
 * 删 / 改的判定与服务端 comments/store.ts 的 mayDelete、PATCH 同口径，这里只决定按钮摆不摆。 */

import { ASSISTANT_AGENT, SPACE_AI_ID } from '../assistant/identity'
import type { SpaceAiInfo } from '../assistant/space-ai'
import { GENET_MARK, spaceAiMark, type Comment } from './comments-api'

/** 评论框 @ 菜单里的那一个 AI；mark = 选中后写进框里的记号（框里画成 agent chip） */
export type CommentAi = { id: string; label: string; mark: string }

/** spaceAi = 评论所在空间的空间 AI（assistant/space-ai.ts：团队空间有、个人空间 / 不知道 = null） */
export function commentAi(spaceAi: SpaceAiInfo | null): CommentAi | null {
  if (!spaceAi) return { id: ASSISTANT_AGENT.id, label: ASSISTANT_AGENT.label, mark: GENET_MARK }
  return spaceAi.enabled ? { id: SPACE_AI_ID, label: spaceAi.name, mark: spaceAiMark(spaceAi.name) } : null
}

/** threadBy = 串的发起人（首条评论的作者，与服务端 comment_threads.created_by 同一个人）；me 空 = 还不知道我是谁 */
export function canDeleteComment(comment: Comment, threadBy: string | undefined, me: string, canModerate: boolean): boolean {
  if (comment.deleted) return false
  if (canModerate) return true
  if (!me) return false
  if (comment.author?.ai) return threadBy === me || comment.invoker === me
  return comment.author?.id === me
}

/** 只有作者本人能改；AI 写的没有作者，没人能改 */
export function canEditComment(comment: Comment, me: string): boolean {
  return !comment.deleted && !comment.author?.ai && !!me && comment.author?.id === me
}
