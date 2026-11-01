// ---------- 页面评论：读写与形状 ----------
// 权限判定不在这里（路由先过 pageAccess），这里只管数据：列串、建串、回复、编辑、删除（含整串回收）、解决、已读，
// 以及 @ 记号的解析（只留本空间成员）与公开视图的降级（user id 不出公开接口）。
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { withTransaction } from '../db.js'

/** null = 作者已注销（外键置空） */
export type CommentAuthor = { id: string; name: string } | null
export type Comment = { id: string; author: CommentAuthor; body: string; createdAt: string; editedAt: string | null; deleted: boolean }
/** from / to = base64 编码的 Y.RelativePosition；blockId + text + n 是相对位置解析不了时的文字兜底 */
export type Anchor = { from: string; to: string; blockId: string; text: string; n: number }
export type ThreadKind = 'inline' | 'page'
export type Thread = {
  id: string
  kind: ThreadKind
  anchor: Anchor | null
  createdAt: string
  resolvedAt: string | null
  resolvedBy: CommentAuthor
  readAt: string | null
  comments: Comment[]
}
/** 公开页的形状：作者只有名字，不带 user id */
export type PublicAuthor = { name: string } | null
export type PublicComment = Omit<Comment, 'author'> & { author: PublicAuthor }
export type PublicThread = Omit<Thread, 'comments' | 'resolvedBy'> & { resolvedBy: null; comments: PublicComment[] }

/** 单条评论上限（按码点数，不按 UTF-16 码元：中文与 emoji 都算一个字） */
export const COMMENT_MAX = 4000
// 锚点字段的上限：只防塞大包，正常值远小于它们（文字兜底前端截 300 字）
const ANCHOR_POS_MAX = 2048
const ANCHOR_TEXT_MAX = 1000
const ANCHOR_ID_MAX = 200
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)

/** 评论正文：去掉首尾空白；空的、超长的返回错误原因 */
export function parseBody(raw: unknown): { body: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'body required' }
  const body = raw.trim()
  if (!body) return { error: 'body required' }
  if ([...body].length > COMMENT_MAX) return { error: `body exceeds ${COMMENT_MAX} characters` }
  return { body }
}

/** 锚点只校验形状（服务端不解析 Yjs 位置），只留已知字段 */
export function parseAnchor(raw: unknown): Anchor | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  const pos = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= ANCHOR_POS_MAX && BASE64.test(v)
  if (!pos(a.from) || !pos(a.to)) return null
  if (typeof a.blockId !== 'string' || !a.blockId || a.blockId.length > ANCHOR_ID_MAX) return null
  if (typeof a.text !== 'string' || [...a.text].length > ANCHOR_TEXT_MAX) return null
  if (typeof a.n !== 'number' || !Number.isInteger(a.n) || a.n < 0 || a.n > 100_000) return null
  return { from: a.from, to: a.to, blockId: a.blockId, text: a.text, n: a.n }
}

// @[名字](user:<id>)：名字里可能带 `]`，所以按收口的 `](user:` 定位（非贪婪匹配到最近的那个），不按第一个 `]` 切
const MENTION_RE = /@\[([^\n]*?)\]\(user:([A-Za-z0-9_-]{1,64})\)/g

/** body 里 @ 到的 user id（去重，未过滤） */
export function mentionIds(body: string): string[] {
  return [...new Set([...body.matchAll(MENTION_RE)].map((m) => m[2]!))]
}

/** 记号降成纯文字 `@名字`：公开页与收件箱摘要用，user id 不往外给 */
export function plainMentions(body: string): string {
  return body.replace(MENTION_RE, (_all, name: string) => `@${name}`)
}

/** 只留这个空间的成员：@ 一个外人既不能通知到他，也不该在库里记下他的 id */
async function memberMentions(db: Pool | PoolClient, spaceId: string, body: string): Promise<string[]> {
  const ids = mentionIds(body)
  if (ids.length === 0) return []
  const { rows } = await db.query<{ user_id: string }>(
    'SELECT user_id FROM space_members WHERE space_id = $1 AND user_id = ANY($2::text[])',
    [spaceId, ids],
  )
  const ok = new Set(rows.map((r) => r.user_id))
  return ids.filter((id) => ok.has(id))
}

type ThreadRow = {
  id: string
  kind: ThreadKind
  anchor: Anchor | null
  created_at: Date
  resolved_at: Date | null
  resolved_by: string | null
  resolved_by_name: string | null
  read_at: Date | null
}
type CommentRow = {
  id: string
  thread_id: string
  author_id: string | null
  username: string | null
  body: string
  created_at: Date
  edited_at: Date | null
  deleted_at: Date | null
}

/** 串所属的那种评论在页面上开着（t = comment_threads、p = pages 的别名）。关掉的那种：列表、公开页、收件箱都不出，写入 403 */
export const KIND_ENABLED = `((t.kind = 'inline' AND p.inline_comments) OR (t.kind = 'page' AND p.page_comments))`

// $2 = 读者（取他的已读时刻，公开页传 NULL）；$3 = 只取这一个串（NULL = 全部）；$4 = 只要未解决的
const SELECT_THREADS = `SELECT t.id, t.kind, t.anchor, t.created_at, t.resolved_at, t.resolved_by, ru.username AS resolved_by_name, r.read_at
  FROM comment_threads t
  JOIN pages p ON p.id = t.page_id
  LEFT JOIN users ru ON ru.id = t.resolved_by
  LEFT JOIN comment_reads r ON r.thread_id = t.id AND r.user_id = $2
  WHERE t.page_id = $1 AND ${KIND_ENABLED} AND ($3::text IS NULL OR t.id = $3) AND (NOT $4 OR t.resolved_at IS NULL)
  ORDER BY t.created_at, t.id`
const SELECT_COMMENTS = `SELECT c.id, c.thread_id, c.author_id, u.username, c.body, c.created_at, c.edited_at, c.deleted_at
  FROM comments c
  JOIN comment_threads t ON t.id = c.thread_id
  JOIN pages p ON p.id = t.page_id
  LEFT JOIN users u ON u.id = c.author_id
  WHERE t.page_id = $1 AND ${KIND_ENABLED} AND ($2::text IS NULL OR t.id = $2) AND (NOT $3 OR t.resolved_at IS NULL)
  ORDER BY c.created_at, c.id`

const author = (id: string | null, name: string | null): CommentAuthor => (id && name !== null ? { id, name } : null)

function toComment(r: CommentRow): Comment {
  return {
    id: r.id,
    author: author(r.author_id, r.username),
    body: r.deleted_at ? '' : r.body,
    createdAt: r.created_at.toISOString(),
    editedAt: iso(r.edited_at),
    deleted: r.deleted_at !== null,
  }
}

async function loadThreads(
  db: Pool | PoolClient,
  pageId: string,
  opts: { userId: string | null; threadId?: string; openOnly?: boolean },
): Promise<Thread[]> {
  const only = opts.threadId ?? null
  const openOnly = opts.openOnly ?? false
  // 顺序查：db 可能是事务里的同一个连接，不能并发发两条
  const threads = await db.query<ThreadRow>(SELECT_THREADS, [pageId, opts.userId, only, openOnly])
  const comments = await db.query<CommentRow>(SELECT_COMMENTS, [pageId, only, openOnly])
  const byThread = new Map<string, Comment[]>()
  for (const r of comments.rows) {
    const list = byThread.get(r.thread_id) ?? []
    list.push(toComment(r))
    byThread.set(r.thread_id, list)
  }
  return threads.rows.map((t) => ({
    id: t.id,
    kind: t.kind,
    anchor: t.anchor,
    createdAt: t.created_at.toISOString(),
    resolvedAt: iso(t.resolved_at),
    resolvedBy: author(t.resolved_by, t.resolved_by_name),
    readAt: iso(t.read_at),
    comments: byThread.get(t.id) ?? [],
  }))
}

/** 页面上的全部串（含已解决），按创建时间；readAt 是 userId 的已读时刻 */
export function listThreads(pool: Pool, pageId: string, userId: string): Promise<Thread[]> {
  return loadThreads(pool, pageId, { userId })
}

export async function getThread(db: Pool | PoolClient, pageId: string, threadId: string, userId: string): Promise<Thread | null> {
  return (await loadThreads(db, pageId, { userId, threadId }))[0] ?? null
}

/** 公开页：只要未解决的串；作者只给名字，正文里的 @ 记号降成纯文字 */
export async function publicThreads(pool: Pool, pageId: string): Promise<PublicThread[]> {
  const threads = await loadThreads(pool, pageId, { userId: null, openOnly: true })
  return threads.map((t) => ({
    id: t.id,
    kind: t.kind,
    anchor: t.anchor,
    createdAt: t.createdAt,
    resolvedAt: null,
    resolvedBy: null,
    readAt: null,
    comments: t.comments.map((c) => ({ ...c, body: plainMentions(c.body), author: c.author ? { name: c.author.name } : null })),
  }))
}

const UPSERT_READ = `INSERT INTO comment_reads (user_id, thread_id, read_at) VALUES ($1, $2, now())
  ON CONFLICT (user_id, thread_id) DO UPDATE SET read_at = now()`
const INSERT_COMMENT = 'INSERT INTO comments (id, thread_id, author_id, body, mentions) VALUES ($1, $2, $3, $4, $5)'

/** 新开一个串（连同首条评论）。发言人自己算已读 */
export async function createThread(
  pool: Pool,
  input: { pageId: string; spaceId: string; userId: string; kind: ThreadKind; anchor: Anchor | null; body: string },
): Promise<Thread> {
  return withTransaction(pool, async (client) => {
    const threadId = randomUUID()
    await client.query('INSERT INTO comment_threads (id, page_id, kind, anchor, created_by) VALUES ($1, $2, $3, $4, $5)', [
      threadId,
      input.pageId,
      input.kind,
      input.anchor === null ? null : JSON.stringify(input.anchor),
      input.userId,
    ])
    const mentions = await memberMentions(client, input.spaceId, input.body)
    await client.query(INSERT_COMMENT, [randomUUID(), threadId, input.userId, input.body, mentions])
    await client.query(UPSERT_READ, [input.userId, threadId])
    return (await getThread(client, input.pageId, threadId, input.userId))!
  })
}

/** 回复。发言人自己算已读（自己的话不该再出现在自己的收件箱） */
export async function addReply(
  pool: Pool,
  input: { pageId: string; spaceId: string; threadId: string; userId: string; body: string },
): Promise<Comment> {
  return withTransaction(pool, async (client) => {
    const id = randomUUID()
    const mentions = await memberMentions(client, input.spaceId, input.body)
    await client.query(INSERT_COMMENT, [id, input.threadId, input.userId, input.body, mentions])
    await client.query(UPSERT_READ, [input.userId, input.threadId])
    const { rows } = await client.query<CommentRow>(
      `SELECT c.id, c.thread_id, c.author_id, u.username, c.body, c.created_at, c.edited_at, c.deleted_at
       FROM comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.id = $1`,
      [id],
    )
    return toComment(rows[0]!)
  })
}

/** 解决 / 重新打开。已解决的再点解决不改时刻与人 */
export async function setResolved(pool: Pool, pageId: string, threadId: string, userId: string, resolved: boolean): Promise<Thread | null> {
  await pool.query(
    `UPDATE comment_threads SET
       resolved_at = CASE WHEN $2 THEN COALESCE(resolved_at, now()) ELSE NULL END,
       resolved_by = CASE WHEN $2 THEN COALESCE(resolved_by, $3) ELSE NULL END
     WHERE id = $1`,
    [threadId, resolved, userId],
  )
  return getThread(pool, pageId, threadId, userId)
}

export async function markRead(pool: Pool, userId: string, threadId: string): Promise<void> {
  await pool.query(UPSERT_READ, [userId, threadId])
}

/** 改正文：mentions 跟着重算（改出来的新 @ 也要能通知到） */
export async function editComment(pool: Pool, commentId: string, spaceId: string, body: string): Promise<Comment | null> {
  const mentions = await memberMentions(pool, spaceId, body)
  const { rows } = await pool.query<CommentRow>(
    `WITH up AS (UPDATE comments SET body = $2, mentions = $3, edited_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING *)
     SELECT up.id, up.thread_id, up.author_id, u.username, up.body, up.created_at, up.edited_at, up.deleted_at
     FROM up LEFT JOIN users u ON u.id = up.author_id`,
    [commentId, body, mentions],
  )
  return rows[0] ? toComment(rows[0]) : null
}

/** 删评论。首条且串里还有别的活评论 → 留「评论已删除」占位（软删、清空正文与 @）；回复直接删掉（不留占位）。
 *  之后串里没有活评论了 → 整串物理删除（已读、占位随之级联）。先锁住串那一行，并发删最后两条不会留下空串 */
export async function deleteComment(pool: Pool, commentId: string, threadId: string): Promise<{ threadDeleted: boolean }> {
  return withTransaction(pool, async (client) => {
    if (!(await client.query('SELECT 1 FROM comment_threads WHERE id = $1 FOR UPDATE', [threadId])).rowCount) return { threadDeleted: true }
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM comments WHERE thread_id = $1 ORDER BY created_at, id LIMIT 1',
      [threadId],
    )
    if (rows[0]?.id === commentId) {
      await client.query("UPDATE comments SET deleted_at = now(), body = '', mentions = '{}' WHERE id = $1", [commentId])
    } else {
      await client.query('DELETE FROM comments WHERE id = $1', [commentId])
    }
    const live = await client.query('SELECT 1 FROM comments WHERE thread_id = $1 AND deleted_at IS NULL LIMIT 1', [threadId])
    if (live.rowCount) return { threadDeleted: false }
    await client.query('DELETE FROM comment_threads WHERE id = $1', [threadId])
    return { threadDeleted: true }
  })
}

export type ThreadContext = { threadId: string; pageId: string; spaceId: string; pageKind: string; kindEnabled: boolean }
export type CommentContext = ThreadContext & { commentId: string; authorId: string | null; deleted: boolean }

/** 串属于哪个页面（基表：活不活、能不能读由调用方的 pageAccess 判） */
export async function threadContext(pool: Pool, threadId: string): Promise<ThreadContext | null> {
  const { rows } = await pool.query<{ page_id: string; space_id: string; kind: string; enabled: boolean }>(
    `SELECT t.page_id, p.space_id, p.kind, ${KIND_ENABLED} AS enabled FROM comment_threads t JOIN pages p ON p.id = t.page_id WHERE t.id = $1`,
    [threadId],
  )
  const r = rows[0]
  return r ? { threadId, pageId: r.page_id, spaceId: r.space_id, pageKind: r.kind, kindEnabled: r.enabled } : null
}

export async function commentContext(pool: Pool, commentId: string): Promise<CommentContext | null> {
  const { rows } = await pool.query<{
    thread_id: string
    author_id: string | null
    deleted: boolean
    page_id: string
    space_id: string
    kind: string
    enabled: boolean
  }>(
    `SELECT c.thread_id, c.author_id, c.deleted_at IS NOT NULL AS deleted, t.page_id, p.space_id, p.kind, ${KIND_ENABLED} AS enabled
     FROM comments c JOIN comment_threads t ON t.id = c.thread_id JOIN pages p ON p.id = t.page_id WHERE c.id = $1`,
    [commentId],
  )
  const r = rows[0]
  return r
    ? {
        commentId,
        threadId: r.thread_id,
        pageId: r.page_id,
        spaceId: r.space_id,
        pageKind: r.kind,
        kindEnabled: r.enabled,
        authorId: r.author_id,
        deleted: r.deleted,
      }
    : null
}
