import { expect, test } from 'vitest'
import type { AgentInfo, Page } from '../api'
import { candidateLabel, candidatesFor, mentionQuery, type MentionSources } from './mention-query'

/* 不变量：`@` 只在行首/空白后触发（邮箱不触发），查询词不含空白与括号；`[[` 可带空格，到 `]` 或换行为止；
 * 记号 `@[标题](page:id)` 之后光标不会被当成新查询；
 * `@` 空查询 = 分类行（数量为 0 的不出）+「最近」页面；有查询 = 按 Agent / 页面 / Skill / 成员 分组、截断给「全部 n 个」；
 * 进入分类 = 该分类全部条目；
 * `[[` 只列页面，打了不存在的名字多一项「新建页面」，已存在（不分大小写）就不出；过程页 / skill 页不出现 */

const page = (id: string, title: string, kind: Page['kind'] = 'doc'): Page =>
  ({ id, title, kind, parent_id: null, created_at: '', space_id: 's', published: false, publish_includes_runs: false, icon: null }) as Page
const agent = (id: string, label: string): AgentInfo => ({ id, label })
const src = (pages: Page[] | null, agents: AgentInfo[], extra: Partial<MentionSources> = {}): MentionSources => ({
  pages,
  agents,
  skills: [],
  people: [],
  recent: [],
  ...extra,
})
/** 光标在末尾的查询（省得手数下标） */
const atEnd = (value: string) => mentionQuery(value, value.length)!

test('@ 触发：行首 / 空白后成立，邮箱不触发；查询词止于空白与括号', () => {
  expect(mentionQuery('@', 1)).toMatchObject({ trigger: '@', start: 0, query: '' })
  expect(mentionQuery('写 @cla', 6)).toMatchObject({ trigger: '@', start: 2, query: 'cla' })
  expect(mentionQuery('a@b', 3)).toBeNull()
  expect(mentionQuery('@claude 写', 9)).toBeNull() // 光标已在空白之后的字里
  // 记号 @[标题](page:id) 之后光标不被当成新查询
  const token = '@[设计稿](page:abc)'
  expect(mentionQuery(token, token.length)).toBeNull()
  expect(mentionQuery(`${token} 再 @co`, token.length + 6)).toMatchObject({ trigger: '@', query: 'co' })
})

test('[[ 触发：查询词可带空格，遇 ] 或换行就不是查询了；[[ 比同时成立的 @ 优先', () => {
  expect(mentionQuery('[[', 2)).toMatchObject({ trigger: '[[', start: 0, query: '' })
  expect(mentionQuery('见 [[产品 路线', 9)).toMatchObject({ trigger: '[[', start: 2, query: '产品 路线' })
  expect(mentionQuery('[[已经写完]] 后面', 10)).toBeNull()
  expect(mentionQuery('[[第一行\n第二行', 9)).toBeNull()
  expect(mentionQuery('@[[x', 4)).toMatchObject({ trigger: '[[', query: 'x' })
})

test('@ 有查询：按分组跨分类搜索（agent → 页面 → skill → 成员），不分大小写；只列 doc 页', () => {
  const pages = [page('p1', 'Claude 笔记'), page('p2', '周报'), page('r1', 'Claude 过程', 'run'), page('s1', 'Claude skill', 'skill')]
  const agents = [agent('claude', 'Claude'), agent('c:1:codex', 'Codex')]
  const extra = { skills: [{ id: 's1', name: 'claude-review', description: '' }], people: [{ id: 'u1', username: 'Clara', avatar: null }] }
  const q = mentionQuery('@cla', 4)!
  expect(candidatesFor(q, src(pages, agents, extra)).map((c) => [c.kind, candidateLabel(c)])).toEqual([
    ['agent', 'Claude'],
    ['page', 'Claude 笔记'],
    ['skill', 'claude-review'],
    ['person', 'Clara'],
  ])
  expect(candidatesFor(q, src(null, agents)).map((c) => c.kind)).toEqual(['agent']) // 页面目录没到：只有 agent
})

test('@ 空查询：分类行带数量（0 的不出）+「最近」页面（不含当前页）；最近的页排在页面分类前面', () => {
  const pages = [page('p1', '甲'), page('p2', '乙'), page('p3', '丙')]
  const agents = [agent('claude', 'Claude')]
  const s = src(pages, agents, { recent: ['p3', 'p1'], currentPageId: 'p1', people: [{ id: 'u1', username: 'Clara', avatar: null }] })
  expect(candidatesFor(mentionQuery('@', 1)!, s).map((c) => (c.kind === 'category' ? `${c.cat}:${c.count}` : candidateLabel(c)))).toEqual([
    'agent:1',
    'page:3',
    'person:1',
    '丙',
  ])
  expect(candidatesFor(mentionQuery('@', 1)!, s, 'page').map(candidateLabel)).toEqual(['丙', '甲', '乙'])
})

test('@ 分组截断给「全部 n 个」，进入分类后按查询词列全部', () => {
  const pages = Array.from({ length: 9 }, (_, i) => page(`p${i}`, `报告 ${i}`))
  const all = candidatesFor(mentionQuery('@报告', 3)!, src(pages, []))
  expect(all.filter((c) => c.kind === 'page')).toHaveLength(6)
  expect(all.at(-1)).toEqual({ kind: 'category', cat: 'page', count: 9, more: true })
  expect(candidatesFor(mentionQuery('@报告', 3)!, src(pages, []), 'page')).toHaveLength(9)
})

test('[[ 候选：只列页面；不存在的名字多一项新建，已存在就不出；页面目录没到不出新建', () => {
  const pages = [page('p1', '产品路线'), page('p2', '周报')]
  const agents = [agent('claude', 'Claude')]
  expect(candidatesFor(atEnd('[[产品'), src(pages, agents)).map((c) => c.kind)).toEqual(['page', 'new']) // 只是前缀，不是同名
  expect(candidatesFor(atEnd('[[产品路线'), src(pages, agents)).map((c) => c.kind)).toEqual(['page']) // 同名：不再提议新建
  expect(candidatesFor(atEnd('[[Zz 新页面'), src(pages, agents))).toEqual([{ kind: 'new', title: 'Zz 新页面' }])
  expect(candidatesFor(atEnd('[['), src(pages, agents)).map((c) => c.kind)).toEqual(['page', 'page']) // 空查询不提议新建
  expect(candidatesFor(atEnd('[[x'), src(null, agents))).toEqual([])
})

test('集合与集合的行都能被 @ / [[ 找到（行是 doc 页），过程页 / skill 页仍不出现', () => {
  const pages = [page('c1', '需求池', 'collection'), { ...page('row1', '需求：导出'), parent_id: 'c1' }, page('r1', '需求 过程', 'run')]
  const hits = candidatesFor(mentionQuery('@需求', 3)!, src(pages, [])).filter((c) => c.kind === 'page')
  expect(hits.map(candidateLabel)).toEqual(['需求池', '需求：导出'])
  expect(candidatesFor(atEnd('[[需求池'), src(pages, [])).map((c) => c.kind)).toEqual(['page']) // 同名集合：不再提议新建
})
