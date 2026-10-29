import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { TeamPlanView, TeamState, TeamTask } from '@ramet/shared/run-model'

// 目录（我能用的 agent）是模块级 store + 拉取副作用；服务端渲染里只要它给个空列表
vi.mock('../default-agent', () => ({
  useAgents: () => ({ agents: [], loaded: true }),
  agentList: () => [{ id: 'claude', label: 'Claude Code' }],
  getDefaultAgent: () => '',
  subscribeAgentList: () => () => {},
  subscribeDefaultAgent: () => () => {},
  ensureAgentsLoaded: () => {},
  pickAgent: () => '',
}))

import { setSelf } from '../people'
import { PlanCard } from './PlanCard'
import { planStore } from './team-api'

const task = (id: string, extra: Partial<TeamTask> = {}): TeamTask => ({ id, title: `任务${id}`, assignee: 'claude', label: 'Claude', dependsOn: [], status: 'pending', spans: [], usable: true, ...extra })
const draft = (tasks: TeamTask[]): TeamState => ({ planId: 'p1', title: '拆分存储层', leader: 'claude', status: 'draft', tasks })
const viewOf = (state: TeamState, extra: Partial<TeamPlanView> = {}): TeamPlanView => ({
  ...state,
  pageId: 'pg',
  initiatorId: 'u1',
  initiator: 'alice',
  createdAt: '2026-10-18T00:00:00Z',
  ...extra,
})

const render = (state: TeamState, props: { canAct?: boolean; snapshotOnly?: boolean } = {}) =>
  renderToStaticMarkup(<PlanCard pageId="pg" team={state} canAct={props.canAct ?? true} snapshotOnly={props.snapshotOnly ?? false} />)

beforeEach(() => {
  planStore.clear()
  setSelf({ id: 'u1', username: 'alice', avatar: null })
})

describe('计划卡（服务端渲染冒烟）', () => {
  test('发起人 + 草稿 + 可写：任务标题可编辑、有负责人与目录下拉、开工 / 取消按钮', () => {
    const state = draft([task('a'), task('b', { dependsOn: ['a'] })])
    planStore.put(viewOf(state))
    const html = render(state)
    expect(html).toContain('<input')
    expect(html).toContain('aria-label="任务 1 的标题"')
    expect(html).toContain('team-chip')
    expect(html).toContain('开工')
    expect(html).toContain('取消计划')
    expect(html).toContain('等 #1 做完')
    expect(html).toContain('待确认')
  })

  test('有负责人用不了：标红提示换人，开工按钮禁用并说明原因', () => {
    const state = draft([task('a', { usable: false })])
    planStore.put(viewOf(state))
    const html = render(state)
    expect(html).toContain('无权使用，请换人')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>开工<\/button>/)
    expect(html).toContain('先给它们换人')
  })

  test('不是发起人 / 页面只读：只读，没有输入框和按钮，说明由谁发起', () => {
    const state = draft([task('a')])
    planStore.put(viewOf(state, { initiatorId: 'u2', initiator: 'bob' }))
    const other = render(state)
    expect(other).not.toContain('<input')
    expect(other).not.toContain('取消计划')
    expect(other).toContain('bob')
    planStore.put(viewOf(state))
    const readOnly = render(state, { canAct: false })
    expect(readOnly).not.toContain('<input')
    expect(readOnly).not.toContain('取消计划')
  })

  test('开工之后（视图是 running）：以视图为准，收成一行，不再有编辑控件', () => {
    const state = draft([task('a')])
    planStore.put(viewOf({ ...state, status: 'running' }))
    const html = render(state)
    expect(html).toContain('已开工')
    expect(html).not.toContain('<input')
    expect(html).toContain('data-open="false"')
  })

  test('视图还没加载到：先画快照、只读，并说在加载', () => {
    const html = render(draft([task('a')]))
    expect(html).not.toContain('<input')
    expect(html).toContain('正在加载计划')
  })

  test('过程页 / 公开页（snapshotOnly）：只读快照，标明是提交时的草稿，不依赖 store', () => {
    const state = draft([task('a')])
    planStore.put(viewOf(state)) // 即使 store 里有，也不当可编辑
    const html = render(state, { snapshotOnly: true })
    expect(html).not.toContain('<input')
    expect(html).toContain('提交时的草稿')
  })
})
