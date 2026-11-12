import { describe, expect, it } from 'vitest'
import { b64uBytes, capNotices, channelOf, claim, CLAIM_KEEP, freshNotices, sameKey, type DeviceState } from './notify-model'
import type { InboxItem } from '../inbox/inbox-api'

const ok: DeviceState = {
  enabled: true,
  secure: true,
  iosNeedsInstall: false,
  canNotify: true,
  permission: 'granted',
  pushSupported: true,
  subscribed: true,
  serverError: null,
  subscribeError: null,
}

describe('channelOf：一台设备只走一条通道', () => {
  it('推送登记好、服务端没报错 → 推送', () => {
    expect(channelOf(ok)).toEqual({ channel: 'push', reason: 'push' })
  })

  it('推送用不了 → 退回桌面通知，并说明原因', () => {
    expect(channelOf({ ...ok, subscribed: false, subscribeError: 'AbortError' })).toEqual({ channel: 'desktop', reason: 'push-unavailable' })
    expect(channelOf({ ...ok, serverError: '连不上推送服务 fcm.googleapis.com（ETIMEDOUT）' })).toEqual({ channel: 'desktop', reason: 'push-failing' })
    expect(channelOf({ ...ok, subscribed: false, pushSupported: false })).toEqual({ channel: 'desktop', reason: 'no-push' })
    expect(channelOf({ ...ok, subscribed: false })).toEqual({ channel: 'desktop', reason: 'push-pending' })
  })

  it('没开 / 没权限 / 不支持 / 不是 https / iOS 没装到主屏幕 → 不通知', () => {
    expect(channelOf({ ...ok, enabled: false }).reason).toBe('disabled')
    expect(channelOf({ ...ok, permission: 'denied' }).reason).toBe('denied')
    expect(channelOf({ ...ok, permission: 'default' }).reason).toBe('not-granted')
    expect(channelOf({ ...ok, canNotify: false }).reason).toBe('unsupported')
    expect(channelOf({ ...ok, secure: false }).reason).toBe('insecure')
    expect(channelOf({ ...ok, iosNeedsInstall: true }).reason).toBe('ios-install')
    for (const d of [{ ...ok, enabled: false }, { ...ok, permission: 'denied' as const }, { ...ok, secure: false }]) expect(channelOf(d).channel).toBe('off')
  })
})

const comment = (thread: string, at: string): InboxItem => ({
  type: 'comment',
  key: `comment:${thread}`,
  at,
  pageId: 'p1',
  pageTitle: '周报',
  threadId: thread,
  author: { id: 'u2', name: 'bob' },
  excerpt: '看一下',
  reason: 'mention',
})
const running: InboxItem = { type: 'running', key: 'running:r1', at: '2026-11-11T00:00:00Z', pageId: 'p1', pageTitle: '周报', runId: 'r1', agentId: 'a', agentName: 'Claude' }

describe('freshNotices', () => {
  it('第一次加载只记基线；之后新出现的才算，在跑的不算', () => {
    const first = freshNotices(null, [comment('t1', 'a')])
    expect(first.fresh).toEqual([])
    const next = freshNotices(first.known, [comment('t1', 'a'), comment('t2', 'b'), running])
    expect(next.fresh.map((n) => n.notice.tag)).toEqual(['comment:t2'])
  })

  it('同一个串换了时间算新的；摘掉后又回来的不算', () => {
    const { known } = freshNotices(null, [comment('t1', 'a')])
    const gone = freshNotices(known, [])
    expect(freshNotices(gone.known, [comment('t1', 'a')]).fresh).toEqual([])
    expect(freshNotices(gone.known, [comment('t1', 'b')]).fresh.map((n) => n.notice.title)).toEqual(['bob @了你'])
  })
})

describe('capNotices / claim', () => {
  it('超过上限：前 max-1 条 + 一条「还有 N 件事」', () => {
    const list = freshNotices(new Set(), ['1', '2', '3', '4', '5'].map((t) => comment(t, 'x'))).fresh.map((n) => n.notice)
    expect(capNotices(list, 3).map((n) => n.title)).toEqual(['bob @了你', 'bob @了你', '还有 3 件事'])
    expect(capNotices(list.slice(0, 3), 3)).toHaveLength(3)
  })

  it('同一条只有一个标签页抢得到；记录表只留最近的', () => {
    const a = claim([], 'x')
    expect(a).toEqual(['x'])
    expect(claim(a!, 'x')).toBeNull()
    const full = Array.from({ length: CLAIM_KEEP }, (_, i) => String(i))
    const next = claim(full, 'new')!
    expect(next).toHaveLength(CLAIM_KEEP)
    expect(next[0]).toBe('1')
    expect(next.at(-1)).toBe('new')
  })
})

describe('applicationServerKey', () => {
  it('base64url 解码与比对', () => {
    const key = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'
    const bytes = b64uBytes(key)
    expect(bytes).toHaveLength(65)
    expect(sameKey(bytes.buffer as ArrayBuffer, key)).toBe(true)
    expect(sameKey(new Uint8Array(65).buffer, key)).toBe(false)
    expect(sameKey(null, key)).toBe(false)
  })
})
