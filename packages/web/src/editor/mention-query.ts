/* ---------- 引用菜单：光标位置的查询解析 + 候选（纯函数，无 DOM；文档模式与对话输入框共用）----------
 * 两个触发：
 *   `@`  大菜单：Agent / 页面 / Skill / 成员 四个分类。只在行首或空白后的 @ 成立（邮箱里的 @ 不弹），
 *        查询词不含空白与括号。三种形态由 candidatesFor 的 category 参数和查询词决定：
 *          顶层、空查询：分类行（带数量，数量为 0 的不出）加「最近」页面；
 *          顶层、有查询：跨分类搜索，每组截断，截掉的给一行「全部 n 个」（选中即带着查询词进入该分类）；
 *          进入了某分类：该分类全部条目按查询词筛选。
 *        进出分类是菜单内部导航，状态在宿主（键位语义见 mention-nav.ts），不进一次性触发会话。
 *   `[[` 只列页面，查询词不含 `]` / 换行（页面标题常带空格，所以空格可以有）；打了不存在的名字，
 *        候选末尾多一项「新建页面」，选中就建（当前页的子页）并插入引用。
 * `[` `]` `(` `)` 不进 `@` 的查询字符集：`@[标题](page:id)` 记号（手打 / 粘贴进来、还没升成 chip 的）里带这些符号，
 * 光标落在记号后面时不能再被解析成一次新查询，否则菜单会莫名重开（文档模式插的是 chip，不进文本）。
 * 标题为空按「新页面」参与过滤与展示（服务端播种的新页标题就是空串）。 */

import type { AgentInfo, Page } from '../api'

export type MentionTrigger = '@' | '[['

export type MentionQuery = {
  trigger: MentionTrigger
  /** 触发符（`@` 或 `[[`）在文本里的下标 */
  start: number
  /** 查询结束下标（= 光标） */
  end: number
  /** 触发符与光标之间的原文（可能为空 = 刚打触发符） */
  query: string
}

/** `@` 查询词的终止字符：空白 + 上面那组标题语法符号 */
const TOKEN_STOP = /[\s[\]()]/

function atQuery(value: string, cursor: number): MentionQuery | null {
  let start = cursor
  while (start > 0 && !TOKEN_STOP.test(value[start - 1]!)) start--
  if (value[start] !== '@') return null
  // 行首或空白之后才算，拦掉 a@b 这类邮箱 / 句内 @
  if (start > 0 && !/\s/.test(value[start - 1]!)) return null
  return { trigger: '@', start, end: cursor, query: value.slice(start + 1, cursor) }
}

function bracketQuery(value: string, cursor: number): MentionQuery | null {
  const open = value.lastIndexOf('[[', cursor - 2)
  if (open < 0) return null
  const query = value.slice(open + 2, cursor)
  if (/[\]\n]/.test(query)) return null
  return { trigger: '[[', start: open, end: cursor, query }
}

/** 光标处的引用查询；`[[` 优先（它的查询词可以带空格，`@` 的不行，两者同时成立时前者更长更具体） */
export function mentionQuery(value: string, cursor: number): MentionQuery | null {
  if (cursor <= 0 || cursor > value.length) return null
  return bracketQuery(value, cursor) ?? atQuery(value, cursor)
}

/** 列表上限：`[[` 的页面条数 */
export const MENTION_LIMIT = 8
/** 跨分类搜索时每组最多几行（截掉的给一行「全部 n 个」） */
const GROUP_LIMIT: Record<MentionCategory, number> = { agent: 5, page: 6, skill: 3, person: 4 }
/** 进入分类后最多列几条（菜单可滚动；再多就靠输入筛选） */
const CATEGORY_LIMIT = 60
/** 顶层「最近」分组的条数 */
const RECENT_LIMIT = 5

export type MentionCategory = 'agent' | 'page' | 'skill' | 'person'
/** 分类的展示顺序（顶层分类行、跨分类搜索的分组顺序都按它） */
export const CATEGORY_ORDER: readonly MentionCategory[] = ['agent', 'page', 'skill', 'person']

/** skill 候选只要这几项（skill-api 的 SkillSummary 是它的超集） */
export interface MentionSkill {
  /** skill 页的页面 id：选中插一颗指向它的 page_mention（与斜杠菜单点名同口径） */
  id: string
  name: string
  description: string
}

/** 成员候选（people.ts 的 Person 同形） */
export interface MentionPerson {
  id: string
  username: string
  avatar: string | null
}

/** 候选的全部来源。宿主各自从缓存同步取（mention-sources.ts），到了新数据重画 */
export interface MentionSources {
  /** null = 页面目录还没到：没有页面候选，`[[` 也不提议新建 */
  pages: readonly Page[] | null
  agents: readonly AgentInfo[]
  skills: readonly MentionSkill[]
  /** 当前空间的成员（已去掉自己） */
  people: readonly MentionPerson[]
  /** 本机最近打开的页面 id（新的在前，recent-pages.ts） */
  recent: readonly string[]
  /** 当前页：「最近」分组不列它自己 */
  currentPageId?: string
}

/** 空标题的展示名（也是过滤词） */
export function mentionLabel(title: string): string {
  return title.trim() || '新页面'
}

/** 能被提及的页面：文档（含集合的行）与集合；过程页 / skill 页不出现（skill 走自己的分类） */
export function isMentionablePage(p: Page): boolean {
  return p.kind === 'doc' || p.kind === 'collection'
}

/** 页面候选 = 可提及的页，最近打开的排前面（按最近程度），其余保持目录顺序 */
function docPages(src: MentionSources): Page[] {
  const rank = new Map(src.recent.map((id, i) => [id, i]))
  return (src.pages ?? [])
    .filter(isMentionablePage)
    .map((page, i) => ({ page, key: rank.get(page.id) ?? src.recent.length + i }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.page)
}

/** 按标题大小写不敏感过滤，截到 limit */
export function pageMatches(pages: readonly Page[], query: string, limit = MENTION_LIMIT): Page[] {
  const q = query.trim().toLowerCase()
  const out: Page[] = []
  for (const p of pages) {
    if (!isMentionablePage(p)) continue
    if (q && !mentionLabel(p.title).toLowerCase().includes(q)) continue
    out.push(p)
    if (out.length >= limit) break
  }
  return out
}

export type Candidate =
  /** 分类入口（顶层分类行；more = 跨分类搜索里某组的「全部 n 个」）。选中 = 进入该分类，不插东西 */
  | { kind: 'category'; cat: MentionCategory; count: number; more?: boolean }
  | { kind: 'agent'; id: string; label: string }
  /** recent = 顶层「最近」分组里的页面（只影响分组标题） */
  | { kind: 'page'; page: Page; recent?: boolean }
  | { kind: 'skill'; skill: MentionSkill }
  | { kind: 'person'; person: MentionPerson }
  | { kind: 'new'; title: string }

const has = (text: string, needle: string): boolean => !needle || text.toLowerCase().includes(needle)

/** 某分类下按查询词筛出的全部条目（不截断） */
function categoryItems(cat: MentionCategory, src: MentionSources, query: string): Candidate[] {
  const needle = query.trim().toLowerCase()
  switch (cat) {
    case 'agent':
      return src.agents.filter((a) => has(a.label || a.id, needle)).map((a) => ({ kind: 'agent', id: a.id, label: a.label || a.id }))
    case 'page':
      return docPages(src)
        .filter((p) => has(mentionLabel(p.title), needle))
        .map((page) => ({ kind: 'page', page }))
    case 'skill':
      return src.skills.filter((s) => has(s.name, needle)).map((skill) => ({ kind: 'skill', skill }))
    case 'person':
      return src.people.filter((p) => has(p.username, needle)).map((person) => ({ kind: 'person', person }))
  }
}

/** 这个查询下菜单里的全部候选（顺序即展示顺序，键盘导航只认这个数组）。
 *  category = 宿主当前进入的分类（null = 顶层）；`[[` 不分分类 */
export function candidatesFor(q: MentionQuery, src: MentionSources, category: MentionCategory | null = null): Candidate[] {
  if (q.trigger === '[[') {
    const pageCandidates: Candidate[] = pageMatches(docPages(src), q.query).map((page) => ({ kind: 'page', page }))
    const title = q.query.trim()
    const exists = (src.pages ?? []).some((p) => isMentionablePage(p) && mentionLabel(p.title).toLowerCase() === title.toLowerCase())
    return title && src.pages && !exists ? [...pageCandidates, { kind: 'new', title }] : pageCandidates
  }
  if (category) return categoryItems(category, src, q.query).slice(0, CATEGORY_LIMIT)
  if (!q.query.trim()) {
    const cats: Candidate[] = []
    for (const cat of CATEGORY_ORDER) {
      const count = categoryItems(cat, src, '').length
      if (count > 0) cats.push({ kind: 'category', cat, count })
    }
    const recentIds = new Set(src.recent)
    const recent: Candidate[] = docPages(src)
      .filter((p) => recentIds.has(p.id) && p.id !== src.currentPageId)
      .slice(0, RECENT_LIMIT)
      .map((page) => ({ kind: 'page', page, recent: true }))
    return [...cats, ...recent]
  }
  const out: Candidate[] = []
  for (const cat of CATEGORY_ORDER) {
    const all = categoryItems(cat, src, q.query)
    const cap = GROUP_LIMIT[cat]
    out.push(...all.slice(0, cap))
    if (all.length > cap) out.push({ kind: 'category', cat, count: all.length, more: true })
  }
  return out
}

/** 分类名（分类行 / 分组标题 / 「‹ 返回」行） */
export function categoryLabel(cat: MentionCategory): string {
  return cat === 'agent' ? 'Agent' : cat === 'page' ? '页面' : cat === 'skill' ? 'Skill' : '成员'
}

/** 候选在菜单里的文字 */
export function candidateLabel(c: Candidate): string {
  switch (c.kind) {
    case 'category':
      return categoryLabel(c.cat)
    case 'agent':
      return c.label
    case 'page':
      return mentionLabel(c.page.title)
    case 'skill':
      return c.skill.name
    case 'person':
      return c.person.username
    case 'new':
      return c.title
  }
}

/** 候选的稳定 key（React 列表 / DOM 行身份） */
export function candidateKey(c: Candidate): string {
  switch (c.kind) {
    case 'category':
      return `${c.more ? 'more' : 'cat'}:${c.cat}`
    case 'agent':
      return `a:${c.id}`
    case 'page':
      return `p:${c.page.id}`
    case 'skill':
      return `s:${c.skill.id}`
    case 'person':
      return `u:${c.person.id}`
    case 'new':
      return 'new'
  }
}
