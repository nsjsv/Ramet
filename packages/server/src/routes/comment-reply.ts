/* ---------- Genet 以主人的名义回复评论（reply_comment；Bearer，注册在 ramet-tools.ts 的 app 上） ----------
 * POST /api/ramet/comments/reply { thread, body } → { ok, commentId }；主人没同意 → { rejected: true, message }
 * 只有 Genet 凭证、且凭证绑的是本人的 Genet 页（同 dispatch_task 的闸门），否则 403。
 * 每次都先在 Genet 页弹审批卡（只给主人），卡上就是要发出去的原文，主人点「发送」才发：发出去的话署的是主人的名字，
 * 不管是不是读到外来事件之后都要他看过。所以不再经「外来事件之后先问主人」（ramet-consent.ts）那一层，免得弹两张。
 * 判定与评论接口同一套：主人读得到这一页（含 viewer：评论不改文档）、是 doc 页、这种评论在页面上开着；
 * 读不到 / 串不在 404，不是 doc 400，关掉了 403。等审批的这段时间可能变了，点完「发送」再判一次。
 * 例外：主人在这个串里 @Genet 叫过它、还在等（comments/genet-call.ts 的 claim）→ 这次直接发出，不弹卡：是他叫它回在这里的；一次呼叫只免一次。
 * 发出去的回复标 via = 'genet'（界面上「Genet 代发」），广播、收件箱刷新、「评论找我」的触发与界面上回复同一条（posted）。 */

import type { Context, Hono } from 'hono'
import type { Pool } from 'pg'
import { ASSISTANT_ID } from '../agents/assistant-agent.js'
import type { OwnApprovals } from '../agents/own-approvals.js'
import { pageAccess } from '../collab.js'
import { addReply, parseBody, threadContext, type ThreadContext } from '../comments/store.js'
import type { GenetCalls } from '../comments/genet-call.js'
import type { PostedComment } from '../triggers/sources/comment.js'
import { heartbeatJson, REJECTED, type Outcome } from './ramet-consent.js'

export type CommentReplyDeps = {
  pool: Pool
  /** Bearer 凭证 → 主人 + 他的 Genet 页；401 = 没有凭证，403 = 不是 Genet 页上的 Genet 凭证 */
  genet(c: Context): Promise<{ user: { id: string; role: string }; home: string } | 401 | 403>
  approvals(): Pick<OwnApprovals, 'decide'>
  /** 评论写成功：广播 + 收件箱（同界面上的回复） */
  changed(pageId: string): void
  /** 新回复交给「评论找我」的触发 */
  posted(c: PostedComment): void
  /** 评论里 @Genet 的呼叫：有就免这一次审批（测试桩可以不给） */
  calls?: () => Pick<GenetCalls, 'claim' | 'unclaim'>
}

/** 主人此刻能不能在这个串里回复：能 = 串与页面标题 */
async function replyable(pool: Pool, user: { id: string; role: string }, threadId: string): Promise<{ ctx: ThreadContext; title: string } | Outcome> {
  const ctx = await threadContext(pool, threadId)
  const role = ctx ? await pageAccess(pool, ctx.pageId, user) : null
  if (!ctx || !role) return { status: 404, body: { error: '没有这个评论串，或者你看不到它了' } }
  if (ctx.pageKind !== 'doc') return { status: 400, body: { error: '只有文档页能评论' } }
  if (!ctx.kindEnabled) return { status: 403, body: { error: '这一页关掉了这种评论' } }
  const title = (await pool.query<{ title: string }>('SELECT title FROM pages WHERE id = $1', [ctx.pageId])).rows[0]?.title || '无标题'
  return { ctx, title }
}

export function commentReplyRoutes(app: Hono, deps: CommentReplyDeps): void {
  const { pool } = deps

  app.post('/api/ramet/comments/reply', async (c) => {
    const g = await deps.genet(c)
    if (g === 401) return c.json({ error: 'unauthorized' }, 401)
    if (g === 403) return c.json({ error: '只有 Genet 能代你回复评论' }, 403)
    const raw = ((await c.req.json().catch(() => null)) ?? {}) as { thread?: unknown; body?: unknown }
    const threadId = typeof raw.thread === 'string' ? raw.thread.trim() : ''
    if (!threadId) return c.json({ error: '要给出评论串（通知里「评论串」那一行的 id）' }, 400)
    const parsed = parseBody(raw.body)
    if ('error' in parsed) return c.json({ error: parsed.error === 'body required' ? '回复不能为空' : '回复太长了（最多 4000 字）' }, 400)
    const first = await replyable(pool, g.user, threadId)
    if ('status' in first) return c.json(first.body, first.status)
    const post = async (ctx: ThreadContext): Promise<{ ok: true; commentId: string }> => {
      const comment = await addReply(pool, { pageId: ctx.pageId, spaceId: ctx.spaceId, threadId, userId: g.user.id, body: parsed.body, via: 'genet' })
      deps.changed(ctx.pageId)
      deps.posted({ commentId: comment.id, threadId, pageId: ctx.pageId, authorId: g.user.id })
      return { ok: true, commentId: comment.id }
    }
    const claimed = (await deps.calls?.().claim(threadId, g.user.id)) ?? []
    if (claimed.length > 0) {
      try {
        return c.json(await post(first.ctx))
      } catch (err) {
        await deps.calls?.().unclaim(claimed)
        throw err
      }
    }
    return heartbeatJson(c, async () => {
      const decision = await deps.approvals().decide(
        { pageId: g.home, agentId: ASSISTANT_ID },
        {
          title: `以你的名义回复《${first.title}》里的评论？`,
          toolCall: { kind: 'other', title: '回复评论', content: [{ type: 'content', content: { type: 'text', text: parsed.body } }] },
          labels: { allow: '发送', reject: '不发' },
          // 署的是主人的名字：只有他看得到、答得了
          only: g.user.id,
        },
        c.req.raw.signal,
      )
      if (!decision.allowed) return REJECTED
      const now = await replyable(pool, g.user, threadId)
      if ('status' in now) return now.body
      return post(now.ctx)
    })
  })
}
