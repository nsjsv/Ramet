import { describe, expect, test } from 'vitest'
import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import type { AgentInfo, Page } from '../api'
import { pickAgent, findAgent, agentLabel } from '../default-agent'
import { catalogForPage } from '../editor/agent-bar'
import { agentBadge } from '../editor/agent-badge'
import { ASSISTANT_ID, builtinAgent, capsOf, isAssistantPage, pageCatalog, rememberAssistantPage } from './identity'
import { idsToPoll, mentionedPages, statusLabel, taskPages, tasksIn } from './task-status'
import type { TaskStatus } from './assistant-api'
import { positionMark } from './position'

const codex: AgentInfo = { id: 'c:m1:codex', label: '机器 · Codex' }
const claude: AgentInfo = { id: 'claude', label: 'Claude' }
const catalog = [codex, claude]
const NONE = { choice: null, lock: '' }

describe('Genet 的身份：一处定义', () => {
  test('按 id 认得出 Genet（目录里没有它）：名字、头像、能力', () => {
    expect(builtinAgent(ASSISTANT_ID)?.label).toBe('Genet')
    expect(agentBadge(ASSISTANT_ID)).toEqual({ kind: 'mark', key: 'genet' })
    expect(builtinAgent('claude')).toBeUndefined()
    expect(findAgent(ASSISTANT_ID)?.id).toBe(ASSISTANT_ID)
    expect(agentLabel(ASSISTANT_ID)).toBe('Genet')
    expect(capsOf(builtinAgent(ASSISTANT_ID))).toEqual({ workspace: false, toolProfile: false, team: false })
    expect(capsOf(codex)).toEqual({ workspace: true, toolProfile: true, team: true })
  })

  test('Genet 页：记住的来源或锁定的工具是 Genet，或者是唤起时拿到的那一页', () => {
    expect(isAssistantPage('p1', NONE)).toBe(false)
    expect(isAssistantPage('p1', { choice: ASSISTANT_ID, lock: '' })).toBe(true)
    expect(isAssistantPage('p1', { choice: '', lock: ASSISTANT_ID })).toBe(true)
    expect(isAssistantPage('p1', { choice: 'claude', lock: 'claude' })).toBe(false)
    rememberAssistantPage('home')
    expect(isAssistantPage('home', NONE)).toBe(true)
    expect(isAssistantPage('p1', NONE)).toBe(false)
  })

  test('Genet 页的目录只有 Genet：回落挑中它，不借全局默认；别的页面看不到它', () => {
    expect(pageCatalog(catalog, false)).toBe(catalog)
    const home = catalogForPage(catalog, 'p2', { choice: ASSISTANT_ID, lock: '' })
    expect(home.map((a) => a.id)).toEqual([ASSISTANT_ID])
    // 首帧还没到（choice = null）也认得出唤起时拿到的那一页
    expect(catalogForPage(catalog, 'home', NONE).map((a) => a.id)).toEqual([ASSISTANT_ID])
    expect(pickAgent(home, '', '', 'claude')).toBe(ASSISTANT_ID)
    // 锁定成 Genet（第一块回复）之后照样只有它；锁成别的工具时 Genet 不在
    expect(catalogForPage(catalog, 'p2', { choice: ASSISTANT_ID, lock: ASSISTANT_ID }).map((a) => a.id)).toEqual([ASSISTANT_ID])
    expect(catalogForPage(catalog, 'p3', { choice: '', lock: 'claude' }).map((a) => a.id)).toEqual(['claude'])
    expect(catalogForPage(catalog, 'p3', NONE).map((a) => a.id)).not.toContain(ASSISTANT_ID)
  })
})

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    page_mention: { group: 'inline', inline: true, atom: true, attrs: { pageId: { default: '' }, title: { default: '' } } },
  },
  marks: { link: { attrs: { href: { default: '' } } } },
})
const link = (text: string, href: string): PMNode => schema.text(text, [schema.mark('link', { href })])
const para = (...nodes: PMNode[]): PMNode => schema.node('paragraph', null, nodes)

describe('任务状态：提到了哪些任务页、问哪些', () => {
  test('提到的页 = 文档里的页面提及 chip（按出现顺序去重）；还停在链接形态的不算（气泡里画不出它的状态标）', () => {
    const doc = schema.node('doc', null, [
      para(schema.text('派出去了：'), schema.node('page_mention', { pageId: 't1', title: '修 bug' }), schema.text(' 和 '), link('文档', 'page:t9')),
      para(schema.node('page_mention', { pageId: 't2', title: '写文档' }), schema.node('page_mention', { pageId: 't1', title: '修 bug' })),
    ])
    expect(mentionedPages(doc)).toEqual(['t1', 't2'])
  })

  test('任务页 = Genet 页下面的普通页面（过程页、别处的页不算），最多问 50 个、留最近提到的', () => {
    const page = (id: string, parent: string | null, kind: Page['kind'] = 'doc') => ({ id, parent_id: parent, kind }) as Page
    const pages = [page('t1', 'home'), page('t2', 'home'), page('r1', 'home', 'run'), page('x', 'other')]
    expect(tasksIn(['x', 't2', 'r1', 't1', 'gone'], pages, 'home')).toEqual(['t2', 't1'])
    expect(tasksIn(['t1'], null, 'home')).toEqual([])
    const many = Array.from({ length: 60 }, (_, i) => page(`k${i}`, 'home'))
    const ids = tasksIn(many.map((p) => p.id), many, 'home')
    expect(ids).toHaveLength(50)
    expect(ids[0]).toBe('k10')
  })

  test('任务分页列的：Genet 页下面的全部普通页面，新的在上', () => {
    const page = (id: string, parent: string | null, created_at: string, kind: Page['kind'] = 'doc') => ({ id, parent_id: parent, kind, created_at }) as Page
    const pages = [
      page('t1', 'home', '2026-11-05 08:00:00.5+00'),
      page('r1', 'home', '2026-11-05 09:00:00+00', 'run'),
      page('t3', 'home', '2026-11-05 10:00:00+00'),
      page('x', 'other', '2026-11-05 11:00:00+00'),
      page('t2', 'home', '2026-11-05 08:00:00.75+00'),
      page('c1', 't1', '2026-11-05 12:00:00+00'),
    ]
    expect(taskPages(pages, 'home').map((p) => p.id)).toEqual(['t3', 't2', 't1'])
    expect(taskPages(null, 'home')).toEqual([])
    expect(taskPages(pages, 'nobody')).toEqual([])
  })

  test('定时只问还不知道的和没到终态的', () => {
    const known = new Map<string, TaskStatus>([
      ['a', 'running'],
      ['b', 'done'],
      ['c', 'approval'],
      ['d', 'failed'],
      ['e', 'idle'],
    ])
    expect(idsToPoll(['a', 'b', 'c', 'd', 'e', 'f'], known)).toEqual(['a', 'c', 'e', 'f'])
    expect(idsToPoll(['b', 'd'], known)).toEqual([])
  })

  test('状态标的字：还没回复不标', () => {
    expect(statusLabel('running')).toBe('运行中')
    expect(statusLabel('approval')).toBe('等你批准')
    expect(statusLabel('done')).toBe('已完成')
    expect(statusLabel('failed')).toBe('失败')
    expect(statusLabel('idle')).toBeNull()
    expect(statusLabel(undefined)).toBeNull()
  })
})

describe('唤起时预放的位置', () => {
  test('没有正文视图（或没选中）什么都不放：当前页记在消息的 ctx 上，不进输入框', () => {
    expect(positionMark('p1', undefined)).toBe('')
  })
})
