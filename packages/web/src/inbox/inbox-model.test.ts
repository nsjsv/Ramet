import { describe, expect, test } from 'vitest'
import type { InboxItem } from './inbox-api'
import { attentionCount, dropByKey, dropSeenOf, groupOf, hasSeenOf, newsCount, splitInbox } from './inbox-model'

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
    expect(groupOf('comment')).toBe('news')
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

const comment = (tid: string, at: string): InboxItem => ({
  type: 'comment', key: `comment:${tid}`, at, pageId: 'p1', pageTitle: 't', threadId: tid, author: { id: 'u', name: 'bob' }, excerpt: '看看这里', reason: 'reply',
})

describe('评论', () => {
  test('进「新消息」与做完的回合按时间混排（新的在前），不算进角标；乐观摘除按 comment:<串>', () => {
    const groups = splitInbox([done('d1', 'p1', '2026-10-18T07:00:00Z'), comment('t1', '2026-10-18T08:00:00Z'), comment('t2', '2026-10-18T06:00:00Z')])
    expect(groups.news.map((i) => i.key)).toEqual(['comment:t1', 'd1', 'comment:t2'])
    expect(attentionCount([comment('t1', 't'), approval('a')])).toBe(1)
    expect(dropByKey([comment('t1', 't'), comment('t2', 't')], 'comment:t1').map((i) => i.key)).toEqual(['comment:t2'])
  })
})

const timerFailed = (id: string, at: string, paused = false): InboxItem => ({
  type: 'timer_failed', key: `timer_failed:${id}`, at, eventId: id, timerId: 'tm', timerName: '早报', scheduledAt: at, reason: '目标页已经不在了', paused,
})

describe('定时器没能触发', () => {
  test('进「新消息」与别的新消息按时间混排（新的在前），算进小点、不算进角标；乐观摘除按 timer_failed:<记录>', () => {
    expect(groupOf('timer_failed')).toBe('news')
    const groups = splitInbox([done('d1', 'p1', '2026-10-18T07:00:00Z'), timerFailed('e1', '2026-10-18T08:00:00Z', true), timerFailed('e2', '2026-10-18T06:00:00Z')])
    expect(groups.news.map((i) => i.key)).toEqual(['timer_failed:e1', 'd1', 'timer_failed:e2'])
    expect(groups.attention).toEqual([])
    expect(newsCount([timerFailed('e1', 't'), running('x', 't')])).toBe(1)
    expect(attentionCount([timerFailed('e1', 't')])).toBe(0)
    expect(dropByKey([timerFailed('e1', 't'), timerFailed('e2', 't')], 'timer_failed:e1').map((i) => i.key)).toEqual(['timer_failed:e2'])
  })
})

const automation = (id: string, at: string): InboxItem => ({
  type: 'automation', key: `automation:${id}`, at, noticeId: id, ruleId: 'r1', ruleName: '周报提醒', text: '周报该写了', pageId: null, pageTitle: '',
})

describe('规则发来的通知', () => {
  test('进「新消息」按时间混排（新的在前），算进小点、不算进角标；乐观摘除按 automation:<通知>', () => {
    expect(groupOf('automation')).toBe('news')
    const groups = splitInbox([done('d1', 'p1', '2026-10-18T07:00:00Z'), automation('n1', '2026-10-18T08:00:00Z'), approval('a')])
    expect(groups.news.map((i) => i.key)).toEqual(['automation:n1', 'd1'])
    expect(groups.attention.map((i) => i.key)).toEqual(['a'])
    expect(newsCount([automation('n1', 't'), running('x', 't')])).toBe(1)
    expect(attentionCount([automation('n1', 't')])).toBe(0)
    expect(dropByKey([automation('n1', 't'), automation('n2', 't')], 'automation:n1').map((i) => i.key)).toEqual(['automation:n2'])
  })
})

const docMention = (pageId: string, at: string): InboxItem => ({
  type: 'doc_mention', key: `doc_mention:${pageId}`, at, pageId, pageTitle: '周报', blockId: 'b1', actor: { id: 'u', name: 'bob' }, excerpt: '@alice 看看这段',
})

describe('正文里 @了你', () => {
  test('进「新消息」按时间混排（新的在前），算进小点、不算进角标', () => {
    expect(groupOf('doc_mention')).toBe('news')
    const groups = splitInbox([done('d1', 'p1', '2026-10-18T07:00:00Z'), docMention('p2', '2026-10-18T08:00:00Z'), approval('a')])
    expect(groups.news.map((i) => i.key)).toEqual(['doc_mention:p2', 'd1'])
    expect(newsCount([docMention('p2', 't'), running('x', 't')])).toBe(1)
    expect(attentionCount([docMention('p2', 't')])).toBe(0)
  })

  test('打开那一页就消掉（与「做完」一起），别的页的不动', () => {
    const items = [docMention('p1', 't'), done('d1', 'p1', 't'), docMention('p2', 't'), comment('t1', 't')]
    expect(hasSeenOf(items, 'p2')).toBe(true)
    expect(dropSeenOf(items, 'p1').map((i) => i.key)).toEqual(['doc_mention:p2', 'comment:t1'])
    expect(dropSeenOf(items, 'p2').map((i) => i.key)).toEqual(['doc_mention:p1', 'd1', 'comment:t1'])
  })
})

describe('角标', () => {
  test('只数需要你处理的', () => {
    expect(attentionCount([approval('a'), pending('c', 't'), request('r', 't'), done('d', 'p', 't'), running('x', 't'), firstUse('f', 't')])).toBe(3)
    expect(attentionCount([])).toBe(0)
  })

  test('小点数新消息（做完、首次使用、评论），在跑的不算', () => {
    expect(newsCount([done('d', 'p', 't'), firstUse('f', 't'), comment('t1', 't'), running('x', 't'), approval('a')])).toBe(3)
    expect(newsCount([running('x', 't')])).toBe(0)
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
    expect(hasSeenOf(items, 'p1')).toBe(true)
    expect(hasSeenOf(items, 'p3')).toBe(false)
    expect(dropSeenOf(items, 'p1').map((i) => i.key)).toEqual(['d2', 'x'])
    expect(dropSeenOf(items, 'p3')).toBe(items)
  })
})
