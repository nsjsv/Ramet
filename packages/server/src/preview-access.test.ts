// ---------- 预览票据 / 会话（内存，注入时钟） ----------
import { describe, expect, test } from 'vitest'
import { cookieValue, PreviewAccess } from './preview-access.js'

function make(ttl = 60_000, sessionTtl = 3600_000) {
  const clock = { t: 1_000_000 }
  const access = new PreviewAccess({ ticketTtlMs: ttl, sessionTtlMs: sessionTtl, now: () => clock.t })
  return { clock, access }
}

describe('票据', () => {
  test('一次性：核一次就没了，哪怕之后的检查没通过', () => {
    const { access } = make()
    const t = access.issueTicket('u1', 'p1')!
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    expect(access.redeem(t)).toEqual({ userId: 'u1', previewId: 'p1' })
    expect(access.redeem(t)).toBeNull()
  })

  test('过期：到点就核不出来，且同样被消费', () => {
    const { access, clock } = make(60_000)
    const t = access.issueTicket('u1', 'p1')!
    clock.t += 59_999
    const ok = access.issueTicket('u1', 'p1')!
    expect(access.redeem(ok)).not.toBeNull()
    clock.t += 2
    expect(access.redeem(t)).toBeNull()
    expect(access.redeem(t)).toBeNull()
  })

  test('绑人 + 绑预览：票据里记着是谁、哪个预览；没见过的串核不出', () => {
    const { access } = make()
    const a = access.issueTicket('alice', 'p1')!
    const b = access.issueTicket('bob', 'p2')!
    expect(access.redeem(b)).toEqual({ userId: 'bob', previewId: 'p2' })
    expect(access.redeem(a)).toEqual({ userId: 'alice', previewId: 'p1' })
    expect(access.redeem('0'.repeat(64))).toBeNull()
  })

  test('每人未使用的票据有上限（防刷内存）；用掉或过期后额度回来', () => {
    const { access, clock } = make()
    const tickets: string[] = []
    for (let i = 0; i < 20; i++) tickets.push(access.issueTicket('u1', 'p1')!)
    expect(access.issueTicket('u1', 'p1')).toBeNull()
    expect(access.issueTicket('u2', 'p1')).not.toBeNull() // 别人不受影响
    access.redeem(tickets[0]!)
    expect(access.issueTicket('u1', 'p1')).not.toBeNull()
    clock.t += 61_000
    expect(access.issueTicket('u1', 'p1')).not.toBeNull()
  })

  test('预览停止共享：它的票据与会话一起作废', () => {
    const { access } = make()
    const t = access.issueTicket('u1', 'p1')!
    const keep = access.issueTicket('u1', 'p2')!
    const sid = access.openSession('u1', 'p1')
    access.dropPreview('p1')
    expect(access.redeem(t)).toBeNull()
    expect(access.session(sid)).toBeNull()
    expect(access.redeem(keep)).not.toBeNull()
  })
})

describe('会话', () => {
  test('绑定 用户 + 预览，有寿命，不续期', () => {
    const { access, clock } = make(60_000, 1000)
    const sid = access.openSession('u1', 'p1')
    expect(sid).toMatch(/^[0-9a-f]{64}$/)
    expect(access.session(sid)).toMatchObject({ userId: 'u1', previewId: 'p1' })
    clock.t += 999
    expect(access.session(sid)).not.toBeNull()
    clock.t += 2
    expect(access.session(sid)).toBeNull()
    expect(access.session('nope')).toBeNull()
  })

  test('重新确认的时刻可以刷新（缓存几秒）', () => {
    const { access, clock } = make()
    const sid = access.openSession('u1', 'p1')
    const at = access.session(sid)!.checkedAt
    clock.t += 4000
    access.touch(sid)
    expect(access.session(sid)!.checkedAt).toBe(at + 4000)
  })
})

test('cookieValue：取指定名字，不误取前缀相同的', () => {
  expect(cookieValue('a=1; ramet_pv=xyz; b=2', 'ramet_pv')).toBe('xyz')
  expect(cookieValue('ramet_pv_other=1; b=2', 'ramet_pv')).toBeNull()
  expect(cookieValue(undefined, 'ramet_pv')).toBeNull()
  expect(cookieValue('ramet_pv=', 'ramet_pv')).toBeNull()
})
