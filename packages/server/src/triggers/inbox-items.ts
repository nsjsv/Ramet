// ---------- 收件箱里规则相关的两类：「自动化通知」与「正文里 @了你」 ----------
// 自动化通知（automation_notices，规则的「发通知」动作写的）：
// 只给收件人自己；7 天内、最多 30 条、新的在前；收件人必须仍是规则所在空间的成员（列举类只含自己是成员的空间，同别的类型）。
// 带的页面（事件所在页）只在它还活着、收件人看得到它时给标题和 id，否则当没有。可「知道了」（automation:<通知 id>）。
// 规则删了通知留着（rule_name 是写通知时记下的），ruleId 变成 null。
// 正文里 @了你（page_mentions，triggers/sources/mention.ts 记的）：别人加的（认得出是谁、不是我自己）、30 天内、页面活着且我仍看得到它、
// 晚于我上次打开那一页（inbox_seen，同「做完待你看」：打开那一页就算看过）；每页只给最新的一条，最多 30 条。不用配模型连接也有。

import type { Pool } from 'pg'
import { pageAccessJoin, pageVisibleSql } from '../page-visibility.js'

export const AUTOMATION_PREFIX = 'automation:'

export type AutomationInboxItem = {
  type: 'automation'
  key: string
  at: string
  noticeId: string
  ruleId: string | null
  ruleName: string
  text: string
  pageId: string | null
  pageTitle: string
}

const WINDOW_DAYS = 7
const LIST_MAX = 30

const SELECT_NOTICES = `SELECT n.id, n.trigger_id, n.rule_name, n.text, n.created_at,
    CASE WHEN p.id IS NOT NULL AND ${pageVisibleSql('p', '$1')} THEN p.id END AS page_id,
    p.title AS page_title
  FROM automation_notices n LEFT JOIN live_pages p ON p.id = n.page_id
  WHERE n.user_id = $1 AND n.created_at > now() - interval '${WINDOW_DAYS} days'
    AND EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = n.space_id AND m.user_id = $1)
    AND NOT EXISTS (SELECT 1 FROM inbox_dismissed d WHERE d.user_id = $1 AND d.item_key = '${AUTOMATION_PREFIX}' || n.id)
  ORDER BY n.created_at DESC, n.id LIMIT ${LIST_MAX}`

/** 「知道了」的归属校验：这条通知是我的 */
export const SELECT_MY_NOTICE = 'SELECT 1 FROM automation_notices WHERE id = $2 AND user_id = $1'

export async function automationItems(pool: Pool, user: { id: string }): Promise<AutomationInboxItem[]> {
  const { rows } = await pool.query<{
    id: string
    trigger_id: string | null
    rule_name: string
    text: string
    created_at: Date
    page_id: string | null
    page_title: string | null
  }>(SELECT_NOTICES, [user.id])
  return rows.map((r) => ({
    type: 'automation' as const,
    key: `${AUTOMATION_PREFIX}${r.id}`,
    at: r.created_at.toISOString(),
    noticeId: r.id,
    ruleId: r.trigger_id,
    ruleName: r.rule_name,
    text: r.text,
    pageId: r.page_id,
    pageTitle: r.page_id ? r.page_title || '无标题' : '',
  }))
}

export type DocMentionInboxItem = {
  type: 'doc_mention'
  key: string
  at: string
  pageId: string
  pageTitle: string
  blockId: string
  actor: { id: string; name: string }
  excerpt: string
}

const MENTION_DAYS = 30
const EXCERPT_MAX = 120

const SELECT_DOC_MENTIONS = `SELECT * FROM (
  SELECT DISTINCT ON (pm.page_id) pm.id, pm.page_id, pm.block_id, pm.excerpt, pm.created_at, pm.actor_id, u.username, p.title
  FROM page_mentions pm
  JOIN live_pages p ON p.id = pm.page_id
  ${pageAccessJoin('p', '$1', 'm')}
  JOIN users u ON u.id = pm.actor_id
  LEFT JOIN inbox_seen s ON s.user_id = $1 AND s.page_id = pm.page_id
  WHERE pm.user_id = $1 AND pm.actor_id <> $1 AND pm.created_at > now() - interval '${MENTION_DAYS} days'
    AND (s.seen_at IS NULL OR pm.created_at > s.seen_at)
  ORDER BY pm.page_id, pm.created_at DESC, pm.id DESC
) hit ORDER BY created_at DESC, page_id LIMIT ${LIST_MAX}`

export async function docMentionItems(pool: Pool, user: { id: string }): Promise<DocMentionInboxItem[]> {
  const { rows } = await pool.query<{
    page_id: string
    block_id: string
    excerpt: string
    created_at: Date
    actor_id: string
    username: string
    title: string
  }>(SELECT_DOC_MENTIONS, [user.id])
  return rows.map((r) => ({
    type: 'doc_mention' as const,
    key: `doc_mention:${r.page_id}`,
    at: r.created_at.toISOString(),
    pageId: r.page_id,
    pageTitle: r.title || '无标题',
    blockId: r.block_id,
    actor: { id: r.actor_id, name: r.username },
    excerpt: [...r.excerpt].length > EXCERPT_MAX ? `${[...r.excerpt].slice(0, EXCERPT_MAX).join('')}…` : r.excerpt,
  }))
}
