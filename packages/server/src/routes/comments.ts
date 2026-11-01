/* ---------- 页面评论 REST（数据与形状见 comments/store.ts）----------
 * GET    /api/pages/:id/comments                 → { threads }：全部串（含已解决），每串带评论与我的 readAt
 * POST   /api/pages/:id/comments {kind, anchor?, body} → 201 { thread }
 * POST   /api/comment-threads/:tid/replies {body} → 201 { comment }
 * POST   /api/comment-threads/:tid/resolve {resolved} → { thread }
 * POST   /api/comment-threads/:tid/read           → {}
 * PATCH  /api/comments/:cid {body}                → { comment }：只有作者本人
 * DELETE /api/comments/:cid                       → { threadDeleted }：作者本人或空间 owner
 * 判定：能读这个页面的空间成员（含 viewer）都能看、发、回复、解决——评论不改文档，所以不要写权；全局 admin 不例外。
 * 页面不存在 / 已在回收站 / 非成员 / 串或评论不属于可读页面 一律 404（不泄露存在性）；不是 doc 页（过程页 / skill / 集合）发不了，400。
 * 每次写成功都通知调用方（index.ts 把它接到页面文档的 stateless 广播与收件箱刷新）。
 * 每条路由自带 requireAuth（路径限定），挂载顺序无影响。 */

import { Hono, type Context } from 'hono'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv } from '../auth.js'
import { pageAccess } from '../collab.js'
import {
  addReply,
  commentContext,
  createThread,
  deleteComment,
  editComment,
  listThreads,
  markRead,
  parseAnchor,
  parseBody,
  setResolved,
  threadContext,
  type ThreadContext,
} from '../comments/store.js'

const NOT_FOUND = { error: 'not found' }
const NOT_COMMENTABLE = { error: 'comments are only available on doc pages' }

async function readJson(c: Context<AuthEnv>): Promise<Record<string, unknown> | null> {
  const body = (await c.req.json().catch(() => null)) as unknown
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
}

export function commentRoutes(pool: Pool, changed: (pageId: string) => void = () => {}) {
  const app = new Hono<AuthEnv>()
  const auth = requireAuth(pool)

  /** 串 + 我对它所在页面的角色；读不到（串不存在 / 页面不可读）返回 null */
  async function readableThread(c: Context<AuthEnv>): Promise<(ThreadContext & { role: string }) | null> {
    const ctx = await threadContext(pool, c.req.param('tid') ?? '')
    if (!ctx) return null
    const role = await pageAccess(pool, ctx.pageId, c.get('user'))
    return role ? { ...ctx, role } : null
  }

  app.get('/api/pages/:id/comments', auth, async (c) => {
    const id = c.req.param('id')
    if (!(await pageAccess(pool, id, c.get('user')))) return c.json(NOT_FOUND, 404)
    c.header('cache-control', 'no-store')
    return c.json({ threads: await listThreads(pool, id, c.get('user').id) })
  })

  app.post('/api/pages/:id/comments', auth, async (c) => {
    const id = c.req.param('id')
    const user = c.get('user')
    if (!(await pageAccess(pool, id, user))) return c.json(NOT_FOUND, 404)
    const page = (await pool.query<{ kind: string; space_id: string }>('SELECT kind, space_id FROM live_pages WHERE id = $1', [id])).rows[0]
    if (!page) return c.json(NOT_FOUND, 404)
    if (page.kind !== 'doc') return c.json(NOT_COMMENTABLE, 400)
    const input = await readJson(c)
    if (input?.kind !== 'inline' && input?.kind !== 'page') return c.json({ error: "kind must be 'inline' or 'page'" }, 400)
    let anchor = null
    if (input.kind === 'inline') {
      anchor = parseAnchor(input.anchor)
      if (!anchor) return c.json({ error: 'invalid anchor' }, 400)
    } else if (input.anchor !== undefined && input.anchor !== null) {
      return c.json({ error: 'page comments have no anchor' }, 400)
    }
    const parsed = parseBody(input.body)
    if ('error' in parsed) return c.json(parsed, 400)
    const thread = await createThread(pool, { pageId: id, spaceId: page.space_id, userId: user.id, kind: input.kind, anchor, body: parsed.body })
    changed(id)
    return c.json({ thread }, 201)
  })

  app.post('/api/comment-threads/:tid/replies', auth, async (c) => {
    const ctx = await readableThread(c)
    if (!ctx) return c.json(NOT_FOUND, 404)
    if (ctx.pageKind !== 'doc') return c.json(NOT_COMMENTABLE, 400)
    const parsed = parseBody((await readJson(c))?.body)
    if ('error' in parsed) return c.json(parsed, 400)
    const comment = await addReply(pool, { pageId: ctx.pageId, spaceId: ctx.spaceId, threadId: ctx.threadId, userId: c.get('user').id, body: parsed.body })
    changed(ctx.pageId)
    return c.json({ comment }, 201)
  })

  app.post('/api/comment-threads/:tid/resolve', auth, async (c) => {
    const ctx = await readableThread(c)
    if (!ctx) return c.json(NOT_FOUND, 404)
    if (ctx.pageKind !== 'doc') return c.json(NOT_COMMENTABLE, 400)
    const resolved = (await readJson(c))?.resolved
    if (typeof resolved !== 'boolean') return c.json({ error: 'resolved must be a boolean' }, 400)
    const thread = await setResolved(pool, ctx.pageId, ctx.threadId, c.get('user').id, resolved)
    // 并发删掉了这个串
    if (!thread) return c.json(NOT_FOUND, 404)
    changed(ctx.pageId)
    return c.json({ thread })
  })

  // 已读只影响我自己的收件箱，不广播给页面上的其他人
  app.post('/api/comment-threads/:tid/read', auth, async (c) => {
    const ctx = await readableThread(c)
    if (!ctx) return c.json(NOT_FOUND, 404)
    await markRead(pool, c.get('user').id, ctx.threadId)
    return c.json({})
  })

  app.patch('/api/comments/:cid', auth, async (c) => {
    const user = c.get('user')
    const ctx = await commentContext(pool, c.req.param('cid'))
    if (!ctx || ctx.deleted || !(await pageAccess(pool, ctx.pageId, user))) return c.json(NOT_FOUND, 404)
    if (ctx.authorId !== user.id) return c.json({ error: 'forbidden' }, 403)
    const parsed = parseBody((await readJson(c))?.body)
    if ('error' in parsed) return c.json(parsed, 400)
    const comment = await editComment(pool, ctx.commentId, ctx.spaceId, parsed.body)
    if (!comment) return c.json(NOT_FOUND, 404)
    changed(ctx.pageId)
    return c.json({ comment })
  })

  app.delete('/api/comments/:cid', auth, async (c) => {
    const user = c.get('user')
    const ctx = await commentContext(pool, c.req.param('cid'))
    const role = ctx && !ctx.deleted ? await pageAccess(pool, ctx.pageId, user) : null
    if (!ctx || !role) return c.json(NOT_FOUND, 404)
    // 空间 owner 能删任何人的（管内容）；全局 admin 不是 owner 就没有这一条
    if (ctx.authorId !== user.id && role !== 'owner') return c.json({ error: 'forbidden' }, 403)
    const result = await deleteComment(pool, ctx.commentId, ctx.threadId)
    changed(ctx.pageId)
    return c.json(result)
  })

  return app
}
