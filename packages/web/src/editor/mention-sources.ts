/* ---------- `@` 大菜单的候选来源（文档内 doc-mention.ts 与对话输入框 chat-view.tsx 共用） ----------
 * 页面目录与 agent 目录由宿主给；skill 与成员按当前页所在空间从缓存同步取：
 *   skill 是 skill-api.ts 的 30 秒缓存（斜杠菜单同一份），成员是 people.ts 的按空间缓存（对话头像同一份）。
 * 同步取不到（第一次）就先给空表，宿主在会话开启时调 warmMentionSources，取到了重画一次，菜单不等网络。
 * 「最近」来自 recent-pages.ts（本机最近打开的页）。成员里去掉自己（@ 自己没有意义）。 */

import type { AgentInfo, Page } from '../api'
import { loadSpaceMembers, selfId, spaceMembers } from '../people'
import { recentPageIds } from '../recent-pages'
import { cachedSkills, loadSkills } from '../skill-api'
import type { MentionSources } from './mention-query'

function spaceOf(pages: readonly Page[] | null, pageId: string): string | null {
  return pages?.find((p) => p.id === pageId)?.space_id ?? null
}

export function mentionSources(pages: readonly Page[] | null, agents: readonly AgentInfo[], pageId: string): MentionSources {
  const spaceId = spaceOf(pages, pageId)
  const me = selfId()
  return {
    pages,
    agents,
    skills: spaceId ? (cachedSkills(spaceId) ?? []) : [],
    people: spaceId ? (spaceMembers(spaceId) ?? []).filter((p) => p.id !== me) : [],
    recent: recentPageIds(),
    currentPageId: pageId,
  }
}

/** 后台取 skill 与成员（都有缓存，命中就立刻 resolve）；resolve 后宿主重画 */
export function warmMentionSources(pages: readonly Page[] | null, pageId: string): Promise<void> {
  const spaceId = spaceOf(pages, pageId)
  if (!spaceId) return Promise.resolve()
  return Promise.all([loadSkills(spaceId), loadSpaceMembers(spaceId)]).then(() => undefined)
}
