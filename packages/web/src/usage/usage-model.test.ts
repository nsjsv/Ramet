import { describe, expect, it } from 'vitest'
import { axisTicks, barHeights, formatTokens, shortDay, sourceLabel, tokensOf } from './usage-model'

describe('AI 使用量的显示规则', () => {
  it('token 数：一万以下照写，往上写万 / 亿，小数是 0 不写', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(9_999)).toBe('9,999')
    expect(formatTokens(10_000)).toBe('1 万')
    expect(formatTokens(123_456)).toBe('12.3 万')
    expect(formatTokens(250_000_000)).toBe('2.5 亿')
    expect(formatTokens(-5)).toBe('0')
  })

  it('一行的 token 合计含缓存读写', () => {
    expect(tokensOf({ calls: 1, requests: 2, input: 10, output: 5, cacheRead: 3, cacheWrite: 2 })).toBe(20)
  })

  it('柱高按最多的那天算；用过的至少有一点高度；全没用过都是 0', () => {
    expect(barHeights([0, 50, 100])).toEqual([0, 50, 100])
    expect(barHeights([1, 1000])).toEqual([3, 100])
    expect(barHeights([0, 0])).toEqual([0, 0])
    expect(barHeights([])).toEqual([])
  })

  it('横轴标头、中、尾三天；日期写成月/日', () => {
    expect(shortDay('2026-11-09')).toBe('11/9')
    const days = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']
    expect(axisTicks(days)).toEqual([
      { index: 0, label: '11/1' },
      { index: 2, label: '11/3' },
      { index: 4, label: '11/5' },
    ])
    expect(axisTicks(['2026-11-01'])).toEqual([{ index: 0, label: '11/1' }])
    expect(axisTicks([])).toEqual([])
  })

  it('来源的叫法；认不出的原样显示', () => {
    expect(sourceLabel('space_ai')).toBe('空间 AI')
    expect(sourceLabel('new_thing')).toBe('new_thing')
  })
})
