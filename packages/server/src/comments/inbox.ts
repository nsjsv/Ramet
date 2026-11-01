// ---------- 收件箱里的评论条目 ----------
// 一个讨论串一条，取串里最新一条「该让我看到」的评论 C：不是我写的、没删、30 天内、晚于我读到这个串的时刻，且满足其一
//   mention    C @了我（mentions 是落库时过滤过的本空间成员）
//   reply      我在这个串里发过言（未删的）——我之后才发言的话，发言时已读，比我早的评论自然不算
//   new_thread C 是串的首条，而我是页面创建者
// 只列活页面（live_pages）且我仍是其空间成员的（列举类：全局 admin 也不例外）。只是视图，按钮走评论接口自己的判定。
// 页面关掉的那种评论不列：页面上已收起，点进去看不到、也读不掉这条
import type { Pool } from 'pg'
import { KIND_ENABLED, plainMentions } from './store.js'

export type CommentInboxItem = {
  type: 'comment'
  key: string
  at: string
  pageId: string
  pageTitle: string
  threadId: string
  author: { id: string; name: string } | null
  excerpt: string
  reason: 'reply' | 'mention' | 'new_thread'
}

const WINDOW_DAYS = 30
const LIST_MAX = 30
const EXCERPT_MAX = 120

const SELECT_COMMENT_ITEMS = `SELECT * FROM (
  SELECT DISTINCT ON (t.id) t.id AS thread_id, p.id AS page_id, p.title, c.body, c.created_at, c.author_id, u.username,
    CASE WHEN c.mentions @> ARRAY[$1::text] THEN 'mention'
         WHEN mine.yes THEN 'reply'
         ELSE 'new_thread' END AS reason
  FROM comment_threads t
  JOIN live_pages p ON p.id = t.page_id
  JOIN space_members m ON m.space_id = p.space_id AND m.user_id = $1
  JOIN comments c ON c.thread_id = t.id
  LEFT JOIN users u ON u.id = c.author_id
  LEFT JOIN comment_reads r ON r.thread_id = t.id AND r.user_id = $1
  CROSS JOIN LATERAL (SELECT EXISTS (
    SELECT 1 FROM comments o WHERE o.thread_id = t.id AND o.author_id = $1 AND o.deleted_at IS NULL
  ) AS yes) mine
  WHERE c.deleted_at IS NULL
    AND ${KIND_ENABLED}
    AND c.author_id IS DISTINCT FROM $1
    AND c.created_at > now() - interval '${WINDOW_DAYS} days'
    AND (r.read_at IS NULL OR c.created_at > r.read_at)
    AND (
      c.mentions @> ARRAY[$1::text]
      OR mine.yes
      OR (p.owner_id = $1 AND c.id = (SELECT f.id FROM comments f WHERE f.thread_id = t.id ORDER BY f.created_at, f.id LIMIT 1))
    )
  ORDER BY t.id, c.created_at DESC, c.id DESC
) hit ORDER BY created_at DESC, thread_id LIMIT ${LIST_MAX}`

function excerptOf(body: string): string {
  const text = plainMentions(body).replace(/\s+/g, ' ').trim()
  const chars = [...text]
  return chars.length > EXCERPT_MAX ? `${chars.slice(0, EXCERPT_MAX).join('')}…` : text
}

export async function commentItems(pool: Pool, user: { id: string }): Promise<CommentInboxItem[]> {
  const { rows } = await pool.query<{
    thread_id: string
    page_id: string
    title: string
    body: string
    created_at: Date
    author_id: string | null
    username: string | null
    reason: CommentInboxItem['reason']
  }>(SELECT_COMMENT_ITEMS, [user.id])
  return rows.map((r) => ({
    type: 'comment' as const,
    key: `comment:${r.thread_id}`,
    at: r.created_at.toISOString(),
    pageId: r.page_id,
    pageTitle: r.title,
    threadId: r.thread_id,
    author: r.author_id && r.username !== null ? { id: r.author_id, name: r.username } : null,
    excerpt: excerptOf(r.body),
    reason: r.reason,
  }))
}
