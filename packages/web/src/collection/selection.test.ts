import { describe, expect, test } from 'vitest'
import { hitIds, pruneIds, rangeIds } from './selection'

describe('多选', () => {
  test('连选：锚点到目标（含两端），两个方向都行；锚点不在顺序里 = 只有目标', () => {
    const order = ['a', 'b', 'c', 'd']
    expect(rangeIds(order, 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(rangeIds(order, 'd', 'b')).toEqual(['b', 'c', 'd'])
    expect(rangeIds(order, 'x', 'c')).toEqual(['c'])
    expect(rangeIds(order, null, 'c')).toEqual(['c'])
  })

  test('框选：相交才算，边贴边不算', () => {
    const items = [
      { id: 'a', left: 0, right: 100, top: 0, bottom: 30 },
      { id: 'b', left: 0, right: 100, top: 30, bottom: 60 },
      { id: 'c', left: 0, right: 100, top: 60, bottom: 90 },
    ]
    expect(hitIds(items, { left: 50, right: 60, top: 10, bottom: 40 })).toEqual(['a', 'b'])
    expect(hitIds(items, { left: 50, right: 60, top: 30, bottom: 60 })).toEqual(['b'])
    expect(hitIds(items, { left: 100, right: 120, top: 0, bottom: 90 })).toEqual([])
  })

  test('摘除：没变化返回 null', () => {
    const picked = new Set(['a', 'b'])
    expect(pruneIds(picked, () => true)).toBeNull()
    expect([...pruneIds(picked, (id) => id === 'b')!]).toEqual(['b'])
  })
})
