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

export function dropByKey(items: readonly InboxItem[], key: string): InboxItem[] {
  return items.some((item) => item.key === key) ? items.filter((item) => item.key !== key) : (items as InboxItem[])
}

/** 打开某个对话页后，它的「做完待你看」就算看过了 */
export function dropDoneOf(items: readonly InboxItem[], pageId: string): InboxItem[] {
  return items.some((item) => item.type === 'done' && item.pageId === pageId)
    ? items.filter((item) => !(item.type === 'done' && item.pageId === pageId))
    : (items as InboxItem[])
}

export function hasDoneOf(items: readonly InboxItem[], pageId: string): boolean {
  return items.some((item) => item.type === 'done' && item.pageId === pageId)
}
