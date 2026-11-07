import { describe, expect, it } from 'vitest'
import { HYSTERESIS, MARGIN_W, MIN_CONTENT, marginFits, stackCards } from './margin-layout'

const box = (id: string, ideal: number, height = 50) => ({ id, ideal, height })

describe('stackCards', () => {
  it('没有激活：互不重叠的照锚点放', () => {
    const tops = stackCards([box('a', 0), box('b', 100), box('c', 300)], null, 8)
    expect([...tops]).toEqual([['a', 0], ['b', 100], ['c', 300]])
  })

  it('没有激活：压到上一张就往下推，推挤会传下去', () => {
    const tops = stackCards([box('a', 0), box('b', 20), box('c', 70)], null, 8)
    expect([...tops]).toEqual([['a', 0], ['b', 58], ['c', 116]])
  })

  it('激活的钉在锚点，上面的往上让、下面的往下推', () => {
    const tops = stackCards([box('a', 0), box('b', 20), box('c', 40), box('d', 60)], 'c', 8)
    expect(tops.get('c')).toBe(40)
    expect(tops.get('d')).toBe(98)
    expect(tops.get('b')).toBe(40 - 8 - 50)
    expect(tops.get('a')).toBe(40 - 8 - 50 - 8 - 50)
  })

  it('激活的在最前面：等同于从它开始顺推', () => {
    const tops = stackCards([box('a', 10), box('b', 20)], 'a', 8)
    expect([...tops]).toEqual([['a', 10], ['b', 68]])
  })

  it('上面的不挡路就留在自己的锚点', () => {
    const tops = stackCards([box('a', 0, 20), box('b', 200)], 'b', 8)
    expect(tops.get('a')).toBe(0)
    expect(tops.get('b')).toBe(200)
  })

  it('激活 id 不在列表里：当没有激活', () => {
    const tops = stackCards([box('a', 0), box('b', 10)], 'zz', 8)
    expect([...tops]).toEqual([['a', 0], ['b', 58]])
  })
})

describe('marginFits', () => {
  const need = 48 + 72 + MARGIN_W + MIN_CONTENT
  it('刚好够宽进宽模式，差 1px 不进', () => {
    expect(marginFits(need, 48, 72, false)).toBe(true)
    expect(marginFits(need - 1, 48, 72, false)).toBe(false)
  })

  it('已经是宽模式：滞回范围内不退', () => {
    expect(marginFits(need - HYSTERESIS, 48, 72, true)).toBe(true)
    expect(marginFits(need - HYSTERESIS - 1, 48, 72, true)).toBe(false)
  })
})
