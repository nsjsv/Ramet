import { describe, expect, test } from 'vitest'
import type { Page } from '../api'
import type { Candidate } from './mention-query'
import { mentionRows, pagePath } from './mention-rows'

/* 不变量（mention-rows.ts 文件头）：分组标题按候选顺序插入、不占候选下标；页面行右侧是父页标题链（最多两级） */

const page = (id: string, title: string, parent: string | null = null): Page =>
  ({ id, title, parent_id: parent, kind: 'doc', icon: null, created_at: '', space_id: 's', published: false, publish_includes_runs: false }) as Page

const pages = [page('a', '工作'), page('b', '2026', 'a'), page('c', '十月', 'b'), page('d', '周报', 'c'), page('e', '', 'a')]

describe('pagePath', () => {
  test('父页标题链，超过两级省略前面；顶层页没有路径；空标题显示「新页面」', () => {
    expect(pagePath(pages[3]!, pages)).toBe('… / 2026 / 十月')
    expect(pagePath(pages[2]!, pages)).toBe('工作 / 2026')
    expect(pagePath(pages[0]!, pages)).toBe('')
    expect(pagePath(page('f', 'x', 'e'), pages)).toBe('工作 / 新页面')
  })
})

describe('mentionRows', () => {
  test('@：Agent 组在前，页面组在后；index 对应候选下标', () => {
    const matches: Candidate[] = [
      { kind: 'agent', id: 'claude', label: 'Claude Code' },
      { kind: 'page', page: pages[3]! },
      { kind: 'page', page: pages[1]! },
    ]
    const rows = mentionRows(matches, pages)
    expect(rows.map((r) => (r.kind === 'item' ? `${r.index}:${r.title}|${r.aside}` : `#${r.title}`))).toEqual([
      '#Agent',
      '0:Claude Code|',
      '#页面',
      '1:周报|… / 2026 / 十月',
      '2:2026|工作',
    ])
  })

  test('@ 顶层：分类行不带分组标题、带数量与 ›，「最近」成组；进入分类后顶部是返回行、条目不分组', () => {
    const top: Candidate[] = [{ kind: 'category', cat: 'page', count: 5 }, { kind: 'page', page: pages[0]!, recent: true }]
    expect(mentionRows(top, pages).map((r) => (r.kind === 'item' ? `${r.title}|${r.aside}|${r.enter ? '›' : ''}` : `#${r.title}`))).toEqual([
      '页面|5|›',
      '#最近',
      '工作||',
    ])
    const inside = mentionRows([{ kind: 'person', person: { id: 'u', username: 'Clara', avatar: null } }], pages, 'person')
    expect(inside.map((r) => `${r.kind}:${r.title}`)).toEqual(['back:成员', 'item:Clara'])
  })

  test('[[：新建项单独一组', () => {
    const rows = mentionRows([{ kind: 'page', page: pages[0]! }, { kind: 'new', title: '周' }], pages)
    expect(rows.map((r) => (r.kind === 'section' ? `#${r.title}` : r.title))).toEqual(['#页面', '工作', '#新建', '新建「周」'])
  })
})
