import { describe, expect, test } from 'vitest'
import type { InboxItem } from './inbox-api'
import { attentionCount, dropByKey, dropDoneOf, groupOf, hasDoneOf, splitInbox } from './inbox-model'

const approval = (key: string): InboxItem => ({
  type: 'approval', key, at: null, pageId: 'p1', pageTitle: 't', agentId: 'a', agentName: 'A', requestId: key, title: '运行命令', options: [], detail: {},
})
const pending = (key: string, at: string): InboxItem => ({
  type: 'connector_pending', key, at, connectorId: key, machine: 'm', owner: 'o', agents: [], spaceId: 's', spaceName: 'S',
})
const request = (key: string, at: string): InboxItem => ({
  type: 'access_request', key, at, connectorId: 'c', machine: 'm', spaceId: 's', spaceName: 'S', requestId: key, username: 'u', scopes: ['agent'], note: '',
})
const done = (key: string, pageId: string, at: string): InboxItem => ({
  type: 'done', key, at, pageId, pageTitle: 't', runPageId: 'r', agentId: 'a', agentName: 'A', outcome: 'end',
})
const running = (key: string, at: string): InboxItem => ({
  type: 'running', key, at, pageId: 'p', pageTitle: 't', runId: key, agentId: 'a', agentName: 'A',
})
const plan = (key: string, at: string): InboxItem => ({
  type: 'plan', key: `plan:${key}`, at, pageId: 'p1', pageTitle: 't', title: '拆分存储层', planId: key,
})
const firstUse = (key: string, at: string): InboxItem => ({
  type: 'first_use', key, at, connectorId: 'c', machine: 'm', grantId: key, username: 'u', scopes: ['agent'],
})

describe('分组', () => {
  test('需要处理 / 新消息 / 在跑', () => {
    expect(groupOf('approval')).toBe('attention')
    expect(groupOf('connector_pending')).toBe('attention')
    expect(groupOf('access_request')).toBe('attention')
    expect(groupOf('question')).toBe('attention')
    expect(groupOf('plan')).toBe('attention')
    expect(groupOf('done')).toBe('news')
    expect(groupOf('first_use')).toBe('news')
    expect(groupOf('running')).toBe('running')
  })

  test('需要处理：审批在前，其次机器类；同类旧的在前。新消息 / 在跑：新的在前', () => {
    const groups = splitInbox([
      request('r1', '2026-10-18T10:00:00Z'),
      pending('c2', '2026-10-18T09:00:00Z'),
      pending('c1', '2026-10-18T08:00:00Z'),
      approval('a1'),
      approval('a2'),
      done('d1', 'p1', '2026-10-18T07:00:00Z'),
      firstUse('f1', '2026-10-18T11:00:00Z'),
      done('d2', 'p2', '2026-10-18T09:00:00Z'),
      running('x1', '2026-10-18T06:00:00Z'),
      running('x2', '2026-10-18T07:00:00Z'),
    ])
    expect(groups.attention.map((i) => i.key)).toEqual(['a1', 'a2', 'c1', 'c2', 'r1'])
    expect(groups.news.map((i) => i.key)).toEqual(['f1', 'd2', 'd1'])
    expect(groups.running.map((i) => i.key)).toEqual(['x2', 'x1'])
  })
})

describe('等你批计划（带队）', () => {
  test('进「需要你处理」，排在审批与提问之后、机器类之前；乐观摘除按 plan:<planId>', () => {
    const groups = splitInbox([pending('c1', '2026-10-18T08:00:00Z'), plan('x', '2026-10-18T09:00:00Z'), approval('a1')])
    expect(groups.attention.map((i) => i.key)).toEqual(['a1', 'plan:x', 'c1'])
    const items = [plan('x', 't'), plan('y', 't')]
    expect(dropByKey(items, 'plan:x').map((i) => i.key)).toEqual(['plan:y'])
    expect(attentionCount([plan('x', 't'), done('d', 'p', 't')])).toBe(1)
  })
})

describe('角标', () => {
  test('只数需要你处理的', () => {
    expect(attentionCount([approval('a'), pending('c', 't'), request('r', 't'), done('d', 'p', 't'), running('x', 't'), firstUse('f', 't')])).toBe(3)
    expect(attentionCount([])).toBe(0)
  })
})

describe('乐观摘除', () => {
  test('按 key 摘；没有就原样返回同一个数组（不触发多余渲染）', () => {
    const items = [approval('a'), pending('c', 't')]
    expect(dropByKey(items, 'a').map((i) => i.key)).toEqual(['c'])
    expect(dropByKey(items, 'nope')).toBe(items)
  })

  test('打开对话页：摘掉它的「做完」，别的页的、别的类型的不动', () => {
    const items = [done('d1', 'p1', 't'), done('d2', 'p2', 't'), running('x', 't')]
    expect(hasDoneOf(items, 'p1')).toBe(true)
    expect(hasDoneOf(items, 'p3')).toBe(false)
    expect(dropDoneOf(items, 'p1').map((i) => i.key)).toEqual(['d2', 'x'])
    expect(dropDoneOf(items, 'p3')).toBe(items)
  })
})
