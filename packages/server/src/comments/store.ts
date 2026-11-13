// ---------- 页面评论：读写与形状 ----------
// 权限判定不在这里（路由先过 pageAccess），这里只管数据：列串、建串、回复、编辑、删除（含整串回收）、解决、已读，
// 以及 @ 记号的解析（只留本空间成员）与公开视图的降级（user id 不出公开接口）。
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { withTransaction } from '../db.js'
import { SPACE_AI_DEFAULT_NAME, spaceAiNames } from '../agents/space-ai.js'
import { viewersAmong } from '../page-visibility.js'

/** 人写的评论的作者 */
export type UserAuthor = { id: string; name: string }
/** 空间 AI 写的评论：没有用户 id，名字是页面所在空间的空间 AI 此刻的名字（改名后旧评论也跟着变） */
export type AiAuthor = { ai: 'space'; name: string }
/** null = 作者已注销（外键置空） */
export type CommentAuthor = UserAuthor | AiAuthor | null
/** 评论里 @Genet / @空间 AI 的处理状态（comments/genet-call.ts、space-ai-call.ts）。回了（answered）不出：回复就在串里。
 *  waiting 给能看这个串的人都看（知道有回复要来）。
 *  Genet：没成的结局（done = 看过了但没回在这里、failed）与原因只给叫的人（那是他自己的 AI）；
 *  空间 AI（ai = 它此刻的名字）：failed 与原因给所有能看这个串的人（它是空间共用的，没回成大家都该知道为什么） */
export type CommentCall = { state: 'waiting' | 'done' | 'failed'; reason: string; ai?: string }
/** via = 'genet'：Genet 以作者的名义代发的（作者批过原文，或作者在串里叫了它），只做记录、界面上不另标；本人写的没有这个键。
 *  invoker：空间 AI 写的评论是谁叫它写的（他能删这条），人写的没有这个键 */
export type Comment = {
  id: string
  author: CommentAuthor
  body: string
  createdAt: string
  editedAt: string | null
  deleted: boolean
  via?: 'genet'
  invoker?: string
  call?: CommentCall
}
/** from / to = base64 编码的 Y.RelativePosition；blockId + text + n 是相对位置解析不了时的文字兜底 */
export type Anchor = { from: string; to: string; blockId: string; text: string; n: number }
export type ThreadKind = 'inline' | 'page'
export type Thread = {
  id: string
  kind: ThreadKind
  anchor: Anchor | null
  createdAt: string
  resolvedAt: string | null
  resolvedBy: UserAuthor | null
  readAt: string | null
  comments: Comment[]
}
/** 公开页的形状：作者只有名字（空间 AI 另标 ai，好画机器人图标），不带任何 id */
export type PublicAuthor = { name: string } | AiAuthor | null
export type PublicComment = Omit<Comment, 'author' | 'invoker'> & { author: PublicAuthor }
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

// 正文里的记号：@ 成员 `@[名字](user:<id>)`，叫 Genet / 空间 AI `@[名字](agent:ramet:assistant|space-ai)`（评论框里的 agent chip，
// 口径同输入框的 agent_mention；别的 agent 在评论里叫不动，记号原样是文字）。
// 名字里可能带 `]`，所以按收口的 `](` + 认得的目标定位（非贪婪匹配到最近的那个），不按第一个 `]` 切。
// 几种记号必须用同一个正则一起扫：分开扫的话，前一种的非贪婪匹配会从别的记号的 `@[` 一直吃到自己的收口（`@[AI](agent:…) 和 @[bob](user:…)`）
const MARK_RE = /@\[([^\n]*?)\]\((user:[A-Za-z0-9_-]{1,64}|agent:ramet:assistant|agent:ramet:space-ai)\)/g
const GENET_TARGET = 'agent:ramet:assistant'
const SPACE_AI_TARGET = 'agent:ramet:space-ai'

/** body 里 @ 到的 user id（去重，未过滤） */
export function mentionIds(body: string): string[] {
  const ids = [...body.matchAll(MARK_RE)].map((m) => m[2]!).filter((t) => t.startsWith('user:'))
  return [...new Set(ids.map((t) => t.slice('user:'.length)))]
}

const squeeze = (s: string): string => s.replace(/[ \t]+/g, ' ').trim()
const calls = (body: string, target: string): boolean => [...body.matchAll(MARK_RE)].some((m) => m[2] === target)
const without = (body: string, target: string): string => squeeze(body.replace(MARK_RE, (all, _name: string, t: string) => (t === target ? ' ' : all)))

/** 这条评论叫了 Genet 没有 */
export function callsGenet(body: string): boolean {
  return calls(body, GENET_TARGET)
}

/** 去掉叫 Genet 的记号：剩下的就是给它的要求 */
export function withoutGenet(body: string): string {
  return without(body, GENET_TARGET)
}

/** 这条评论叫了空间 AI 没有 */
export function callsSpaceAi(body: string): boolean {
  return calls(body, SPACE_AI_TARGET)
}

/** 去掉叫空间 AI 的记号：剩下的就是给它的要求 */
export function withoutSpaceAi(body: string): string {
  return without(body, SPACE_AI_TARGET)
}

/** 记号降成纯文字 `@名字`：公开页与收件箱摘要用，user id 不往外给 */
export function plainMentions(body: string): string {
  return body.replace(MARK_RE, (_all, name: string) => `@${name}`)
}

/** 只留看得到这页的人：@ 一个看不到它的人既不能通知到他，也不该在库里记下他的 id */
async function viewerMentions(db: Pool | PoolClient, pageId: string, body: string): Promise<string[]> {
  const ids = mentionIds(body)
  if (ids.length === 0) return []
  const ok = new Set(await viewersAmong(db, pageId, ids))
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
  via: string | null
  author_ai?: string | null
  invoker_id?: string | null
  call_state?: string | null
  call_reason?: string | null
  call_at?: Date | null
  ai_state?: string | null
  ai_reason?: string | null
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
const SELECT_COMMENTS = `SELECT c.id, c.thread_id, c.author_id, u.username, c.body, c.created_at, c.edited_at, c.deleted_at, c.via,
    c.author_ai, c.invoker_id, g.state AS call_state, g.reason AS call_reason, g.created_at AS call_at, a.state AS ai_state, a.reason AS ai_reason
  FROM comments c
  JOIN comment_threads t ON t.id = c.thread_id
  JOIN pages p ON p.id = t.page_id
  LEFT JOIN users u ON u.id = c.author_id
  LEFT JOIN comment_genet_calls g ON g.comment_id = c.id
  LEFT JOIN comment_ai_calls a ON a.comment_id = c.id
  WHERE t.page_id = $1 AND ${KIND_ENABLED} AND ($2::text IS NULL OR t.id = $2) AND (NOT $3 OR t.resolved_at IS NULL)
  ORDER BY c.created_at, c.id`

const author = (id: string | null, name: string | null): UserAuthor | null => (id && name !== null ? { id, name } : null)

/** 叫了 Genet 却这么久还没结果：Genet 那一轮没能收尾（服务重启之类），不再显示「正在处理」 */
export const CALL_STALE_MS = 30 * 60_000

/** viewer = 读的人（公开页 null：不出状态）；aiName = 页面所在空间的空间 AI 此刻的名字。
 *  一条评论同时叫了两个（手打了两种记号）时只出空间 AI 的：串里只能画一行 */
function callOf(r: CommentRow, viewer: string | null, aiName: string): CommentCall | undefined {
  if (viewer === null || r.deleted_at) return undefined
  if (r.ai_state === 'waiting' || r.ai_state === 'failed') return { state: r.ai_state, reason: r.ai_state === 'failed' ? (r.ai_reason ?? '') : '', ai: aiName }
  if (!r.call_state || r.call_state === 'answered') return undefined
  const stale = r.call_state === 'waiting' && !!r.call_at && Date.now() - r.call_at.getTime() > CALL_STALE_MS
  if (r.call_state === 'waiting' && !stale) return { state: 'waiting', reason: '' }
  if (viewer !== r.author_id) return undefined
  return stale ? { state: 'failed', reason: '等了太久没有结果' } : { state: r.call_state === 'done' ? 'done' : 'failed', reason: r.call_reason ?? '' }
}

function toComment(r: CommentRow, viewer: string | null = null, aiName = SPACE_AI_DEFAULT_NAME): Comment {
  const call = callOf(r, viewer, aiName)
  return {
    id: r.id,
    author: r.author_ai === 'space' ? { ai: 'space', name: aiName } : author(r.author_id, r.username),
    body: r.deleted_at ? '' : r.body,
    createdAt: r.created_at.toISOString(),
    editedAt: iso(r.edited_at),
    deleted: r.deleted_at !== null,
    ...(r.via === 'genet' ? { via: 'genet' as const } : {}),
    ...(r.author_ai === 'space' && r.invoker_id ? { invoker: r.invoker_id } : {}),
    ...(call ? { call } : {}),
  }
}

/** 这一页所在空间的空间 AI 名字（不看启用没有：停用了，它写过的评论照样署这个名字）；没配过 = 缺省名 */
async function aiNameOf(db: Pick<Pool, 'query'>, pageId: string): Promise<string> {
  return (await spaceAiNames(db, [pageId])).get(pageId) ?? SPACE_AI_DEFAULT_NAME
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
  // 只有串里出现过空间 AI（它写的评论 / 叫它的呼叫）才去查名字
  const aiName = comments.rows.some((r) => r.author_ai || r.ai_state) ? await aiNameOf(db, pageId) : SPACE_AI_DEFAULT_NAME
  const byThread = new Map<string, Comment[]>()
  for (const r of comments.rows) {
    const list = byThread.get(r.thread_id) ?? []
    list.push(toComment(r, opts.userId, aiName))
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

/** 公开页的作者：只留名字（空间 AI 另标 ai） */
function publicAuthor(a: CommentAuthor): PublicAuthor {
  if (!a) return null
  return 'ai' in a ? { ai: a.ai, name: a.name } : { name: a.name }
}

/** 公开页：只要未解决的串；作者只给名字，正文里的 @ 记号降成纯文字，任何 id（作者、叫空间 AI 的人）都不出 */
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
    comments: t.comments.map(({ invoker: _invoker, ...c }) => ({ ...c, body: plainMentions(c.body), author: publicAuthor(c.author) })),
  }))
}

const UPSERT_READ = `INSERT INTO comment_reads (user_id, thread_id, read_at) VALUES ($1, $2, now())
  ON CONFLICT (user_id, thread_id) DO UPDATE SET read_at = now()`
const INSERT_COMMENT = 'INSERT INTO comments (id, thread_id, author_id, body, mentions, via) VALUES ($1, $2, $3, $4, $5, $6)'
const INSERT_AI_COMMENT = "INSERT INTO comments (id, thread_id, author_id, body, mentions, author_ai, invoker_id) VALUES ($1, $2, NULL, $3, $4, 'space', $5)"
const SELECT_ONE = `SELECT c.id, c.thread_id, c.author_id, u.username, c.body, c.created_at, c.edited_at, c.deleted_at, c.via, c.author_ai, c.invoker_id
  FROM comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.id = $1`

/** 新开一个串（连同首条评论）。发言人自己算已读 */
export async function createThread(
  pool: Pool,
  input: { pageId: string; userId: string; kind: ThreadKind; anchor: Anchor | null; body: string },
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
    const mentions = await viewerMentions(client, input.pageId, input.body)
    await client.query(INSERT_COMMENT, [randomUUID(), threadId, input.userId, input.body, mentions, null])
    await client.query(UPSERT_READ, [input.userId, threadId])
    return (await getThread(client, input.pageId, threadId, input.userId))!
  })
}

/** 回复。发言人自己算已读（自己的话不该再出现在自己的收件箱）。via = 'genet'：Genet 代发（作者批过原文） */
export async function addReply(
  pool: Pool,
  input: { pageId: string; threadId: string; userId: string; body: string; via?: 'genet' },
): Promise<Comment> {
  return withTransaction(pool, async (client) => {
    const id = randomUUID()
    const mentions = await viewerMentions(client, input.pageId, input.body)
    await client.query(INSERT_COMMENT, [id, input.threadId, input.userId, input.body, mentions, input.via ?? null])
    await client.query(UPSERT_READ, [input.userId, input.threadId])
    const { rows } = await client.query<CommentRow>(SELECT_ONE, [id])
    return toComment(rows[0]!)
  })
}

/** 空间 AI 回一条（作者是 AI、没有用户 id；invokerId = 叫它的人）。不记已读：AI 没有收件箱 */
export async function addAiReply(pool: Pool, input: { pageId: string; threadId: string; invokerId: string; body: string }): Promise<Comment> {
  const id = randomUUID()
  const mentions = await viewerMentions(pool, input.pageId, input.body)
  await pool.query(INSERT_AI_COMMENT, [id, input.threadId, input.body, mentions, input.invokerId])
  const { rows } = await pool.query<CommentRow>(SELECT_ONE, [id])
  return toComment(rows[0]!, null, await aiNameOf(pool, input.pageId))
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
export async function editComment(pool: Pool, commentId: string, pageId: string, body: string): Promise<Comment | null> {
  const mentions = await viewerMentions(pool, pageId, body)
  const { rows } = await pool.query<CommentRow>(
    `WITH up AS (UPDATE comments SET body = $2, mentions = $3, edited_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING *)
     SELECT up.id, up.thread_id, up.author_id, u.username, up.body, up.created_at, up.edited_at, up.deleted_at, up.via, up.author_ai, up.invoker_id
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
/** authorAi = 空间 AI 写的；invokerId = 叫它写的人；threadBy = 串的发起人（三者都只为判「AI 写的评论谁能删」） */
export type CommentContext = ThreadContext & {
  commentId: string
  authorId: string | null
  authorAi: boolean
  invokerId: string | null
  threadBy: string | null
  deleted: boolean
}

/** 删一条评论：人写的 = 作者本人或空间 owner；空间 AI 写的（没有作者）= 串的发起人、叫它的人、空间 owner。
 *  全局 admin 不是 owner 就没有这一条。AI 写的没人能编辑（编辑只认作者本人，它没有） */
export function mayDelete(ctx: Pick<CommentContext, 'authorId' | 'authorAi' | 'invokerId' | 'threadBy'>, userId: string, role: string): boolean {
  if (role === 'owner') return true
  if (ctx.authorAi) return ctx.threadBy === userId || ctx.invokerId === userId
  return ctx.authorId === userId
}

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
    author_ai: string | null
    invoker_id: string | null
    created_by: string | null
    deleted: boolean
    page_id: string
    space_id: string
    kind: string
    enabled: boolean
  }>(
    `SELECT c.thread_id, c.author_id, c.author_ai, c.invoker_id, t.created_by, c.deleted_at IS NOT NULL AS deleted, t.page_id, p.space_id, p.kind,
       ${KIND_ENABLED} AS enabled
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
        authorAi: r.author_ai === 'space',
        invokerId: r.invoker_id,
        threadBy: r.created_by,
        deleted: r.deleted,
      }
    : null
}
