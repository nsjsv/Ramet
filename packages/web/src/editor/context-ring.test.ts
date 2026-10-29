import { describe, expect, it } from 'vitest'
import { encodeStats } from '@ramet/shared/reply-stats'
import { contextFor, ctxLevel } from './context-ring'

const reply = (agent: string, stats: Parameters<typeof encodeStats>[0]) => ({ agent, stats: encodeStats(stats) })

describe('上下文圆环取值', () => {
  it('这个 agent 正在跑：用实时值', () => {
    expect(contextFor([reply('claude', { o: 'end', cu: 1, cs: 10 })], 'claude', { agent: 'claude', context: { used: 50, size: 100 } })).toEqual({ used: 50, size: 100, live: true })
  })
  it('没在跑 / 跑的是别的 agent：取它最近一条收尾回复的 stats；在飞的占位块跳过', () => {
    const replies = [reply('claude', { o: 'end', cu: 10, cs: 100 }), reply('codex', { o: 'end', cu: 7, cs: 70 }), reply('claude', { o: 'run' })]
    expect(contextFor(replies, 'claude', { agent: 'codex', context: { used: 1, size: 2 } })).toEqual({ used: 10, size: 100, live: false })
    expect(contextFor(replies, 'codex', null)).toEqual({ used: 7, size: 70, live: false })
  })
  it('最近一条收尾回复没报上下文 = 不知道（不拿更早的旧值）；没跑过 = 没有', () => {
    expect(contextFor([reply('claude', { o: 'end', cu: 10, cs: 100 }), reply('claude', { o: 'end', st: 1 })], 'claude', null)).toBeNull()
    expect(contextFor([], 'claude', null)).toBeNull()
    expect(contextFor([reply('claude', { o: 'end', cu: 1, cs: 2 })], '', null)).toBeNull()
  })
  it('颜色档：≥80% 琥珀、≥95% 红', () => {
    expect(ctxLevel({ used: 79, size: 100, live: false })).toBe('')
    expect(ctxLevel({ used: 80, size: 100, live: false })).toBe('is-warn')
    expect(ctxLevel({ used: 95, size: 100, live: false })).toBe('is-danger')
  })
})
