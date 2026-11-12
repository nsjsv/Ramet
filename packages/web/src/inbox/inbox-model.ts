/* ---------- 收件箱的纯函数：分组 / 排序 / 角标 / 乐观摘除（有单测）---------- */

import type { InboxItem } from './inbox-api'

export type InboxGroup = 'attention' | 'news' | 'running'

const GROUP: Record<InboxItem['type'], InboxGroup> = {
  approval: 'attention',
  connector_pending: 'attention',
  access_request: 'attention',
  question: 'attention',
  plan: 'attention',
  first_use: 'news',
  done: 'news',
  comment: 'news',
  timer_failed: 'news',
  automation: 'news',
  doc_mention: 'news',
  running: 'running',
}

/** 「需要你处理」里的先后：等着批准的命令最急，其次提问 / 计划，再是机器类 */
const ATTENTION_RANK: Partial<Record<InboxItem['type'], number>> = {
  approval: 0,
  question: 1,
  plan: 2,
  connector_pending: 3,
  access_request: 4,
}

export const groupOf = (type: InboxItem['type']): InboxGroup => GROUP[type]

const time = (item: InboxItem): number => (item.at ? new Date(item.at).getTime() || 0 : 0)

export type InboxGroups = Record<InboxGroup, InboxItem[]>

/** 分三组：需要你处理（按类型再按时间，旧的在前——先来先处理）、新消息（新的在前）、在跑（新的在前）。组内同序保持服务端顺序（稳定排序） */
export function splitInbox(items: readonly InboxItem[]): InboxGroups {
  const out: InboxGroups = { attention: [], news: [], running: [] }
  for (const item of items) out[GROUP[item.type]].push(item)
  out.attention.sort((a, b) => (ATTENTION_RANK[a.type] ?? 9) - (ATTENTION_RANK[b.type] ?? 9) || time(a) - time(b))
  out.news.sort((a, b) => time(b) - time(a))
  out.running.sort((a, b) => time(b) - time(a))
  return out
}

/** 角标 = 需要你处理的条数 */
export function attentionCount(items: readonly InboxItem[]): number {
  return items.filter((item) => GROUP[item.type] === 'attention').length
}

/** 小点 = 新消息的条数（服务端只给没看过的：没看过的完成 / 正文 @、没读过的评论、没点「知道了」的首次使用 / 规则失败 / 规则发来的通知）。
 *  只在没有要处理的事时才显示，有的话数字角标已经够醒目 */
export function newsCount(items: readonly InboxItem[]): number {
  return items.filter((item) => GROUP[item.type] === 'news').length
}

export function dropByKey(items: readonly InboxItem[], key: string): InboxItem[] {
  return items.some((item) => item.key === key) ? items.filter((item) => item.key !== key) : (items as InboxItem[])
}

/** 打开这一页就算看过的条目：「做完待你看」与「正文里 @了你」（服务端同一张 inbox_seen） */
const seenByOpening = (item: InboxItem, pageId: string): boolean => (item.type === 'done' || item.type === 'doc_mention') && item.pageId === pageId

/** 打开某一页后，它的「做完待你看」「正文里 @了你」就算看过了 */
export function dropSeenOf(items: readonly InboxItem[], pageId: string): InboxItem[] {
  return items.some((item) => seenByOpening(item, pageId)) ? items.filter((item) => !seenByOpening(item, pageId)) : (items as InboxItem[])
}

export function hasSeenOf(items: readonly InboxItem[], pageId: string): boolean {
  return items.some((item) => seenByOpening(item, pageId))
}

/** 「代回复」跳到哪：评论 = 打开那个串并起草回复，正文里 @了你 = 在那一块开新评论框起草（页面侧见 comments/reply-draft.ts）。
 *  别的条目、没有块 id 的正文 @ 没有这个按钮（null） */
export function draftReplyHref(item: InboxItem): string | null {
  if (item.type === 'comment') return `/page/${item.pageId}?comment=${encodeURIComponent(item.threadId)}&draft=1`
  if (item.type === 'doc_mention' && item.blockId) return `/page/${item.pageId}?block=${encodeURIComponent(item.blockId)}&draft=1`
  return null
}
