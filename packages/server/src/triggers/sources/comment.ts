// ---------- 来源：评论找我（source = 'comment'） ----------
// 有人新开评论串 / 回复之后（routes/comments.ts、Genet 代发的回复 routes/comment-reply.ts），找出该让谁知道：
// 与收件箱的评论条目同一个判定（comments/inbox.ts 的 commentReason）—— @了他 > 他在串里发过言 > 首条且他是页面创建者；
// 页面活着、他仍是那个空间的成员、那种评论在页面上开着、不是他自己写的。每个人按他自己的规则各发一次事件。
// 触发者是写评论的人，规则主人是被找的人，所以事件恒是外来的：通知标「外来」，Genet 之后动手要先问主人。
// 幂等键 comment:<评论 id>：同一条评论重复调只落一次记录。调用方不等这里（hub.background）：评论接口不能被派发拖慢。

import type { Pool } from 'pg'
import { KIND_ENABLED, plainMentions } from '../../comments/store.js'
import { commentReason } from '../../comments/inbox.js'
import { aiState, commentMatches, dormantReason, ensureBuiltin, REASON_TEXT, type CommentReason } from '../builtin.js'
import type { TriggerHub } from '../hub.js'

/** 一条刚写进去的评论（新串的首条或回复） */
export type PostedComment = { commentId: string; threadId: string; pageId: string; authorId: string }

export type SourceDeps = { pool: Pool; hub: Pick<TriggerHub, 'emit' | 'causedBy'> }

const EARLIER_MAX = 3
const EARLIER_EXCERPT = 80

const SELECT_RECIPIENTS = `SELECT m.user_id, why.reason, p.space_id, p.title, c.body, u.username AS author_name
  FROM comments c
  JOIN comment_threads t ON t.id = c.thread_id
  JOIN live_pages p ON p.id = t.page_id
  JOIN space_members m ON m.space_id = p.space_id
  LEFT JOIN users u ON u.id = c.author_id
  CROSS JOIN LATERAL (SELECT ${commentReason('m.user_id')} AS reason) why
  WHERE c.id = $1 AND c.deleted_at IS NULL AND ${KIND_ENABLED} AND c.author_id IS DISTINCT FROM m.user_id AND why.reason IS NOT NULL
  ORDER BY m.user_id`

// 这条之前的几条（新的在前取，再倒回时间顺序）：给 Genet 看上下文
const SELECT_EARLIER = `SELECT u.username, c.body FROM comments c LEFT JOIN users u ON u.id = c.author_id
  WHERE c.thread_id = $1 AND c.deleted_at IS NULL AND c.id <> $2
    AND (c.created_at, c.id) < (SELECT created_at, id FROM comments WHERE id = $2)
  ORDER BY c.created_at DESC, c.id DESC LIMIT ${EARLIER_MAX}`

function excerpt(body: string, max: number): string {
  const flat = plainMentions(body).replace(/\s+/g, ' ').trim()
  return [...flat].length > max ? `${[...flat].slice(0, max).join('')}…` : flat
}

export async function commentPosted(deps: SourceDeps, posted: PostedComment): Promise<void> {
  const { pool, hub } = deps
  const { rows } = await pool.query<{
    user_id: string
    reason: CommentReason
    space_id: string
    title: string
    body: string
    author_name: string | null
  }>(SELECT_RECIPIENTS, [posted.commentId])
  if (rows.length === 0) return
  const first = rows[0]!
  const earlier = (await pool.query<{ username: string | null; body: string }>(SELECT_EARLIER, [posted.threadId, posted.commentId])).rows
    .reverse()
    .map((r) => `${r.username ?? '已注销用户'}：${excerpt(r.body, EARLIER_EXCERPT)}`)
  const depth = hub.causedBy(posted.pageId)
  for (const r of rows) {
    const state = await aiState(pool, r.user_id)
    // 没配模型连接的人不必替他补内置规则（默认的叫 Genet 也用不了）；他以前就有的规则照常找出来
    if (state.connection) await ensureBuiltin(pool, r.user_id)
    await hub.emit({
      source: 'comment',
      key: `comment:${posted.commentId}`,
      ownerId: r.user_id,
      actorId: posted.authorId,
      depth,
      payload: {
        actor: { id: posted.authorId, name: first.author_name ?? '已注销用户' },
        page: { id: posted.pageId, title: first.title },
        text: plainMentions(first.body),
        extra: [
          ['评论串', posted.threadId],
          ['为什么找你', REASON_TEXT[r.reason]],
          ['链接', `/page/${posted.pageId}?comment=${posted.threadId}`],
          ...(earlier.length > 0 ? [['串里前面的评论', earlier.join(' ｜ ')] as [string, string]] : []),
        ],
      },
      match: (rule) => !dormantReason(rule.actions, state) && commentMatches(rule.config, r.reason, r.space_id),
    })
  }
}
