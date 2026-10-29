/* ---------- 引用菜单的行：分组 + 每行显示什么 ----------
 * 纯函数：候选（mention-query.ts 的 candidatesFor，顺序即键盘导航顺序）转成带分组标题的行。
 * 对话输入框（mention-menu.tsx，React）与文档内（doc-mention.ts，DOM）两个渲染器都只消费它，显示口径只有一份：
 *   `@` 顶层空查询：分类行（图标 + 名称 + 数量 + ›，不带分组标题）加「最近」组；
 *   `@` 顶层有查询：「Agent」「页面」「Skill」「成员」各组，组尾可能有一行「查看全部 n 个…」；
 *   `@` 进入分类：顶部一行「‹ 分类名」（点了回顶层；不是候选、不占下标）加该分类的条目，不再分组；
 *   `[[`：「页面」「新建」两组。
 *   页面行是图标、标题和右侧灰字的所在路径（父页标题链，最多两级）；skill 行右侧是描述。
 * item.index 是它在候选数组里的下标：activeIndex / pick 仍按候选数组，分组标题与返回行不占下标。 */

import type { Page, PageIcon } from '../api'
import { COPY } from '../copy'
import { candidateLabel, categoryLabel, type Candidate, type MentionCategory, type MentionPerson } from './mention-query'

export type RowIcon =
  | { kind: 'agent'; agentId: string }
  | { kind: 'page'; icon: PageIcon | null }
  | { kind: 'new' }
  | { kind: 'category'; cat: MentionCategory }
  | { kind: 'skill' }
  | { kind: 'person'; person: MentionPerson }
  | { kind: 'more' }

export type MentionRow =
  | { kind: 'section'; title: string }
  /** 进入分类后的顶行：点了回顶层 */
  | { kind: 'back'; title: string }
  | {
      kind: 'item'
      index: number
      cand: Candidate
      title: string
      aside: string
      icon: RowIcon
      /** 行尾画 ›：选中是「进入」而不是插入 */
      enter?: boolean
    }

/** 路径最多显示几级父页（再往上省略成「… /」） */
const PATH_DEPTH = 2

/** 页面的所在路径：父页标题链（不含自己），只留最近 PATH_DEPTH 级 */
export function pagePath(page: Pick<Page, 'id' | 'parent_id'>, pages: readonly Page[]): string {
  const byId = new Map(pages.map((p) => [p.id, p]))
  const chain: string[] = []
  const seen = new Set<string>([page.id])
  for (let cur = page.parent_id ? byId.get(page.parent_id) : undefined; cur && !seen.has(cur.id); ) {
    seen.add(cur.id)
    chain.unshift(cur.title.trim() || COPY.mention.untitled)
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
  }
  if (chain.length <= PATH_DEPTH) return chain.join(' / ')
  return `… / ${chain.slice(-PATH_DEPTH).join(' / ')}`
}

/** 候选所在的分组标题；'' = 不带标题（顶层分类行） */
function groupOf(cand: Candidate): string {
  switch (cand.kind) {
    case 'category':
      return cand.more ? categoryLabel(cand.cat) : ''
    case 'agent':
      return COPY.mention.agents
    case 'page':
      return cand.recent ? COPY.mention.recent : COPY.mention.pages
    case 'skill':
      return COPY.mention.skills
    case 'person':
      return COPY.mention.people
    case 'new':
      return COPY.mention.create
  }
}

function itemOf(cand: Candidate, index: number, pages: readonly Page[] | null): MentionRow {
  const base = { kind: 'item' as const, index, cand, title: candidateLabel(cand), aside: '' }
  switch (cand.kind) {
    case 'category':
      return cand.more
        ? { ...base, title: COPY.mention.seeAll(cand.count, categoryLabel(cand.cat)), icon: { kind: 'more' }, enter: true }
        : { ...base, aside: String(cand.count), icon: { kind: 'category', cat: cand.cat }, enter: true }
    case 'agent':
      return { ...base, icon: { kind: 'agent', agentId: cand.id } }
    case 'page':
      return { ...base, aside: pages ? pagePath(cand.page, pages) : '', icon: { kind: 'page', icon: cand.page.icon } }
    case 'skill':
      return { ...base, aside: cand.skill.description, icon: { kind: 'skill' } }
    case 'person':
      return { ...base, icon: { kind: 'person', person: cand.person } }
    case 'new':
      return { ...base, title: COPY.mention.newPage(cand.title), icon: { kind: 'new' } }
  }
}

/** category = 宿主当前进入的分类（null = 顶层）：进入后顶部给返回行、条目不再分组 */
export function mentionRows(matches: readonly Candidate[], pages: readonly Page[] | null, category: MentionCategory | null = null): MentionRow[] {
  const rows: MentionRow[] = []
  if (category) {
    rows.push({ kind: 'back', title: categoryLabel(category) })
    matches.forEach((cand, index) => rows.push(itemOf(cand, index, pages)))
    return rows
  }
  let group: string | null = null
  matches.forEach((cand, index) => {
    const g = groupOf(cand)
    if (g !== group) {
      group = g
      if (g) rows.push({ kind: 'section', title: g })
    }
    rows.push(itemOf(cand, index, pages))
  })
  return rows
}
