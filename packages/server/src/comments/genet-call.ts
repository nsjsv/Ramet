// ---------- 评论里 @Genet：叫评论者自己的 Genet 处理这个串 ----------
// 等同在 AI 页里跟 Genet 说一句：不走规则底座（不算 AI 次数、没有内置规则可关），用叫的人自己的模型连接与权限。
// 发起（posted，评论接口写成功之后在后台跑）：新串首条 / 回复里带 Genet 记号、不是 Genet 代发的 → 记一次呼叫（waiting），
//   在他的 Genet 页尾写评论呼叫通知（triggers/notice.ts 的 callNoticeElement）并叫醒 Genet（忙着就排在这一轮后面）。
//   没配模型连接 / 没有 Genet 页 / 写不进 Genet 页 → 记 failed 和原因，什么都不写。
// 回在串里（claim，reply_comment 弹审批之前调）：这个人在这个串上有 waiting 的呼叫 → 用掉（answered），这次回复直接发出、不弹审批；
//   是他自己叫 Genet 回在这里的。一次呼叫只免一次：之后再回照常要他点「发送」。
// 收尾（runEnded，Genet 页上一轮结束时）：这一轮开始之前就写进来的呼叫归它管 —— 还 waiting 的就是没回在串里：
//   正常结束 = done（看过了，没回在这里），出错 / 被停 = failed。一轮开始之后才来的留给下一轮（排队的那一轮会处理它）。
// 状态变了都广播这一页的评论（同页在线的人重拉）；串里怎么显示见 store.ts 的 callOf。

import type { Pool } from 'pg'
import type { GenetNotify } from '../agents/genet-notify.js'
import { callNoticeElement } from '../triggers/notice.js'
import type { PostedComment } from '../triggers/sources/comment.js'
import { callsGenet, CALL_STALE_MS, plainMentions, withoutGenet, type Anchor } from './store.js'

export type GenetCallDeps = {
  pool: Pool
  notify: Pick<GenetNotify, 'post'>
  /** 这一页的评论变了（广播 + 收件箱） */
  changed(pageId: string): void
}

/** 通知里整串评论的总预算与单条上限（按字）：串太长时留首条和最近的，中间注明省略 */
const THREAD_MAX = 6000
const LINE_MAX = 1500

const SELECT_CALL = `SELECT c.body, c.via, c.deleted_at IS NOT NULL AS deleted, t.anchor, p.id AS page_id, p.title
  FROM comments c JOIN comment_threads t ON t.id = c.thread_id JOIN live_pages p ON p.id = t.page_id WHERE c.id = $1`
const SELECT_THREAD = `SELECT c.id, c.author_id, u.username, c.body, c.via FROM comments c LEFT JOIN users u ON u.id = c.author_id
  WHERE c.thread_id = $1 AND c.deleted_at IS NULL ORDER BY c.created_at, c.id`
const SELECT_READY = `SELECT EXISTS (SELECT 1 FROM user_ai_connections WHERE user_id = $1) AS connection,
  (SELECT a.page_id FROM assistants a JOIN live_pages p ON p.id = a.page_id WHERE a.user_id = $1) AS home`
const INSERT_CALL = `INSERT INTO comment_genet_calls (comment_id, thread_id, user_id, home_id, state, reason, created_at, settled_at)
  VALUES ($1, $2, $3, $4, $5::text, $6, $7, CASE WHEN $5::text = 'waiting' THEN NULL ELSE now() END)
  ON CONFLICT (comment_id) DO NOTHING RETURNING comment_id`
const FAIL_CALL = `UPDATE comment_genet_calls SET state = 'failed', reason = $2, settled_at = now() WHERE comment_id = $1 AND state = 'waiting'`
const SETTLE_RUN = `UPDATE comment_genet_calls g SET state = $3, reason = $4, settled_at = now() FROM comment_threads t
  WHERE g.home_id = $1 AND g.state = 'waiting' AND g.created_at < $2 AND t.id = g.thread_id RETURNING t.page_id`
const CLAIM = `UPDATE comment_genet_calls SET state = 'answered', settled_at = now()
  WHERE thread_id = $1 AND user_id = $2 AND state = 'waiting' AND created_at > $3 RETURNING comment_id`
const UNCLAIM = `UPDATE comment_genet_calls SET state = 'waiting', settled_at = NULL WHERE comment_id = ANY($1::text[]) AND state = 'answered'`

const cut = (s: string, max: number): string => ([...s].length > max ? `${[...s].slice(0, max).join('')}…` : s)

/** 串里的评论排进预算：首条（话题）必留，其余从最近的往前留，留不下的注明省略了几条 */
export function fitThread(lines: string[], max = THREAD_MAX): string[] {
  const capped = lines.map((l) => cut(l, LINE_MAX))
  const [first, ...rest] = capped
  if (first === undefined) return []
  let budget = max - first.length
  const kept: string[] = []
  for (let i = rest.length - 1; i >= 0 && budget >= rest[i]!.length; i--) {
    kept.unshift(rest[i]!)
    budget -= rest[i]!.length
  }
  const dropped = rest.length - kept.length
  return dropped > 0 ? [first, `……（中间省略了 ${dropped} 条）`, ...kept] : [first, ...kept]
}

export class GenetCalls {
  constructor(private deps: GenetCallDeps) {}

  /** 一条刚写进去的评论：叫了 Genet 就发起一次（调用方不等） */
  async posted(c: PostedComment): Promise<void> {
    const { pool } = this.deps
    const call = (
      await pool.query<{ body: string; via: string | null; deleted: boolean; anchor: Anchor | null; page_id: string; title: string }>(SELECT_CALL, [
        c.commentId,
      ])
    ).rows[0]
    // Genet 代发的回复里带了记号也不算：不然它回一句就又叫醒自己
    if (!call || call.deleted || call.via === 'genet' || !callsGenet(call.body)) return
    const ready = (await pool.query<{ connection: boolean; home: string | null }>(SELECT_READY, [c.authorId])).rows[0]
    const unready = !ready?.connection ? '还没配模型连接：到设置里加一套' : !ready.home ? '还没有 Genet 对话：先打开一次 AI 页' : null
    const home = ready?.home ?? null
    // 先记下呼叫再写通知：写好就可能立刻开跑，那一轮的开始时刻必须晚于这一行
    const created = await pool.query(INSERT_CALL, [
      c.commentId,
      c.threadId,
      c.authorId,
      unready ? null : home,
      unready ? 'failed' : 'waiting',
      unready ?? '',
      new Date(),
    ])
    if (!created.rowCount) return
    this.deps.changed(c.pageId)
    if (unready || !home) return
    const thread = (
      await pool.query<{ id: string; author_id: string | null; username: string | null; body: string; via: string | null }>(SELECT_THREAD, [c.threadId])
    ).rows
    const lines = thread.map((r) => {
      const who = `${r.username ?? '已注销用户'}${r.via === 'genet' ? '（Genet 代发）' : ''}${r.id === c.commentId ? '（叫你的这条）' : ''}`
      return `${who}：${plainMentions(r.body)}`
    })
    const refused = await this.deps.notify.post(home, c.authorId, (frag) =>
      callNoticeElement(frag, {
        page: { id: call.page_id, title: call.title },
        threadId: c.threadId,
        request: plainMentions(withoutGenet(call.body)),
        quote: call.anchor?.text ? cut(call.anchor.text, LINE_MAX) : null,
        lines: fitThread(lines),
        external: thread.some((r) => r.author_id !== c.authorId),
      }),
    )
    if (!refused) return
    await pool.query(FAIL_CALL, [c.commentId, refused])
    this.deps.changed(c.pageId)
  }

  /** reply_comment 要回这个串：有他叫的、还在等的呼叫就用掉，返回用掉的（空 = 没有，照常审批） */
  async claim(threadId: string, userId: string): Promise<string[]> {
    const { rows } = await this.deps.pool.query<{ comment_id: string }>(CLAIM, [threadId, userId, new Date(Date.now() - CALL_STALE_MS)])
    return rows.map((r) => r.comment_id)
  }

  /** 用掉了却没发成：退回去，之后还能再回 */
  async unclaim(ids: string[]): Promise<void> {
    if (ids.length > 0) await this.deps.pool.query(UNCLAIM, [ids])
  }

  /** Genet 页（或任何页）上一轮结束：这一轮开始之前写进来的、还在等的呼叫收尾 */
  async runEnded(pageId: string, outcome: 'end' | 'cancelled' | 'error', error: string | null, startedAt: number): Promise<void> {
    const [state, reason] =
      outcome === 'end' ? ['done', ''] : outcome === 'cancelled' ? ['failed', '你停掉了 Genet 这一轮'] : ['failed', error || 'Genet 这一轮出错了']
    const { rows } = await this.deps.pool.query<{ page_id: string }>(SETTLE_RUN, [pageId, new Date(startedAt), state, reason])
    for (const page of new Set(rows.map((r) => r.page_id))) this.deps.changed(page)
  }
}
