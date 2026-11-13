// ---------- 收件箱里的「分享给你」（page_shares 现读，没有自己的表） ----------
// 别人分享给我的页（给的人认得出、不是我自己；给的人删号了照样列，只是不写是谁）、30 天内、页面活着且我此刻看得到它、
// 晚于我上次打开那一页（inbox_seen，同「正文里 @了你」：打开那一页就算看过）；改了档位算新的一次。最多 30 条，新的在前。

import type { Pool } from 'pg'
import { pageAccessJoin } from './page-visibility.js'

export type ShareInboxItem = {
  type: 'share'
  key: string
  at: string
  pageId: string
  pageTitle: string
  level: 'edit' | 'view'
  /** 分享的人；删号了 = null */
  actor: { id: string; name: string } | null
}

const SHARE_DAYS = 30
const LIST_MAX = 30

const SELECT_SHARES = `SELECT s.page_id, s.level, s.created_at, s.granted_by, u.username, p.title
  FROM page_shares s
  JOIN live_pages p ON p.id = s.page_id
  ${pageAccessJoin('p', '$1', 'm')}
  LEFT JOIN users u ON u.id = s.granted_by
  LEFT JOIN inbox_seen r ON r.user_id = $1 AND r.page_id = s.page_id
  WHERE s.user_id = $1 AND s.granted_by IS DISTINCT FROM $1 AND s.created_at > now() - interval '${SHARE_DAYS} days'
    AND (r.seen_at IS NULL OR s.created_at > r.seen_at)
  ORDER BY s.created_at DESC, s.page_id LIMIT ${LIST_MAX}`

export async function shareItems(pool: Pool, user: { id: string }): Promise<ShareInboxItem[]> {
  const { rows } = await pool.query<{
    page_id: string
    level: 'edit' | 'view'
    created_at: Date
    granted_by: string | null
    username: string | null
    title: string
  }>(SELECT_SHARES, [user.id])
  return rows.map((r) => ({
    type: 'share' as const,
    key: `share:${r.page_id}`,
    at: r.created_at.toISOString(),
    pageId: r.page_id,
    pageTitle: r.title || '无标题',
    level: r.level,
    actor: r.granted_by && r.username ? { id: r.granted_by, name: r.username } : null,
  }))
}
