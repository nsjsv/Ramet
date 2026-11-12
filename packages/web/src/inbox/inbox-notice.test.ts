/* shared/inbox-notice：服务端推送与前端桌面通知共用的文案 / 跳转 / 身份。用前端的 InboxItem 形状喂（服务端的形状由 tsc 在调用处把关） */
import { describe, expect, it } from 'vitest'
import { moreNotice, noticeIdent, noticeOf } from '@ramet/shared/inbox-notice'
import type { InboxItem } from './inbox-api'

const at = '2026-11-11T08:00:00.000Z'
const page = { pageId: 'p 1', pageTitle: '周报' }

const cases: [string, InboxItem, { title: string; body: string; url: string; urgent: boolean }][] = [
  [
    'approval',
    { type: 'approval', key: 'approval:p:a:r', at: null, ...page, agentId: 'a', agentName: 'Claude', requestId: 'r', title: 'Bash', options: [], detail: { command: 'rm -rf build' } },
    { title: 'Claude 等你批准', body: 'rm -rf build · 《周报》', url: '/page/p%201', urgent: true },
  ],
  [
    'question',
    { type: 'question', key: 'question:p:a:r', at: null, ...page, agentId: 'a', agentName: 'Codex', requestId: 'r', text: '用哪个数据库？' },
    { title: 'Codex 在问你', body: '用哪个数据库？ · 《周报》', url: '/page/p%201', urgent: true },
  ],
  ['plan', { type: 'plan', key: 'plan:x', at, ...page, title: '重构登录', planId: 'x' }, { title: '计划等你确认', body: '重构登录 · 《周报》', url: '/page/p%201', urgent: true }],
  [
    'done',
    { type: 'done', key: 'done:p', at, ...page, runPageId: 'r', agentId: 'a', agentName: 'Claude', outcome: 'error' },
    { title: 'Claude 出错了', body: '《周报》', url: '/page/p%201', urgent: false },
  ],
  [
    'connector_pending',
    { type: 'connector_pending', key: 'connector_pending:c', at, connectorId: 'c', machine: 'mac', owner: null, agents: [], spaceId: 's', spaceName: '团队' },
    { title: '有机器等你批准接入', body: '有成员 想接入「mac」 · 空间「团队」', url: '/inbox', urgent: true },
  ],
  [
    'access_request',
    { type: 'access_request', key: 'access_request:x', at, connectorId: 'c', machine: 'mac', spaceId: 's', spaceName: '团队', requestId: 'x', username: 'bob', scopes: [], note: '' },
    { title: 'bob 申请使用你的机器', body: '「mac」 · 空间「团队」', url: '/inbox', urgent: true },
  ],
  [
    'first_use',
    { type: 'first_use', key: 'first_use:g', at, connectorId: 'c', machine: 'mac', grantId: 'g', username: 'bob', scopes: [] },
    { title: 'bob 开始使用你的机器', body: '「mac」', url: '/inbox', urgent: false },
  ],
  [
    'comment',
    { type: 'comment', key: 'comment:t', at, ...page, threadId: 't/1', author: { ai: 'space', name: '小助手' }, excerpt: '这里\n要改', reason: 'reply' },
    { title: '小助手 回复了你', body: '这里 要改 · 《周报》', url: '/page/p%201?comment=t%2F1', urgent: false },
  ],
  [
    'doc_mention',
    { type: 'doc_mention', key: 'doc_mention:p', at, pageId: 'p', pageTitle: '', blockId: 'b1', actor: { id: 'u', name: 'bob' }, excerpt: '@alice 看下' },
    { title: 'bob 在《无标题》里 @了你', body: '@alice 看下', url: '/page/p?block=b1', urgent: false },
  ],
  [
    'timer_failed',
    { type: 'timer_failed', key: 'timer_failed:e', at, eventId: 'e', timerId: 't', timerName: '日报', source: 'comment', scheduledAt: at, reason: '没有可用的 agent', paused: false },
    { title: '规则「日报」没能触发', body: '没有可用的 agent', url: '/ai/automations', urgent: false },
  ],
  [
    'automation',
    { type: 'automation', key: 'automation:n', at, noticeId: 'n', ruleId: null, ruleName: '盯周报', text: '有新改动', pageId: null, pageTitle: '' },
    { title: '规则「盯周报」', body: '有新改动', url: '/inbox', urgent: false },
  ],
]

describe('noticeOf', () => {
  it.each(cases)('%s', (_name, item, want) => {
    expect(noticeOf(item)).toEqual({ ...want, tag: item.key })
  })

  it('在跑不通知', () => {
    const item: InboxItem = { type: 'running', key: 'running:r', at, ...page, runId: 'r', agentId: 'a', agentName: 'Claude' }
    expect(noticeOf(item)).toBeNull()
  })

  it('定时器（或老服务端没给来源）叫「定时」；做完 / 停止的说法', () => {
    const timer: InboxItem = { type: 'timer_failed', key: 'k', at, eventId: 'e', timerId: 't', timerName: '日报', scheduledAt: at, reason: 'x', paused: true }
    expect(noticeOf(timer)?.title).toBe('定时「日报」没能触发')
    const done = (outcome: string): InboxItem => ({ type: 'done', key: 'done:p', at, ...page, runPageId: 'r', agentId: 'a', agentName: 'Claude', outcome })
    expect(noticeOf(done('end'))?.title).toBe('Claude 做完了')
    expect(noticeOf(done('cancelled'))?.title).toBe('Claude 已停止')
  })

  it('正文按字截到 160（不切坏多字节字符）', () => {
    const item: InboxItem = { type: 'automation', key: 'k', at, noticeId: 'n', ruleId: null, ruleName: 'r', text: '😀'.repeat(300), pageId: null, pageTitle: '' }
    const body = noticeOf(item)!.body
    expect([...body]).toHaveLength(160)
    expect(body.endsWith('…')).toBe(true)
  })
})

describe('noticeIdent / moreNotice', () => {
  it('同一个 key 换了时间算新的一件；没有时间只看 key', () => {
    expect(noticeIdent({ key: 'comment:t', at: 'a' })).not.toBe(noticeIdent({ key: 'comment:t', at: 'b' }))
    expect(noticeIdent({ key: 'approval:x', at: null })).toBe('approval:x@')
  })

  it('合成的那一条去收件箱', () => {
    expect(moreNotice(3)).toMatchObject({ title: '还有 3 件事', url: '/inbox' })
  })
})
