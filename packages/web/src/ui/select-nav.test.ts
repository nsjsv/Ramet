import { describe, expect, test } from 'vitest'
import { edgeIndex, initialIndex, matchIndex, stepIndex } from './select-nav'

const opts = (...labels: string[]) => labels.map((l) => (l.startsWith('!') ? { label: l.slice(1), disabled: true } : { label: l }))

describe('stepIndex', () => {
  test('上下移动跳过禁用项', () => {
    const o = opts('a', '!b', 'c', '!d')
    expect(stepIndex(o, 0, 1)).toBe(2)
    expect(stepIndex(o, 2, -1)).toBe(0)
  })

  test('到头不回绕，停在原处', () => {
    const o = opts('a', 'b', '!c')
    expect(stepIndex(o, 1, 1)).toBe(1)
    expect(stepIndex(o, 0, -1)).toBe(0)
  })

  test('没有当前项时从头 / 尾找', () => {
    const o = opts('!a', 'b', 'c')
    expect(stepIndex(o, -1, 1)).toBe(1)
    expect(stepIndex(o, o.length, -1)).toBe(2)
  })

  test('全禁用：-1', () => {
    expect(stepIndex(opts('!a', '!b'), -1, 1)).toBe(-1)
    expect(stepIndex([], -1, 1)).toBe(-1)
  })
})

describe('edgeIndex / initialIndex', () => {
  test('首尾可选项', () => {
    const o = opts('!a', 'b', 'c', '!d')
    expect(edgeIndex(o, 'first')).toBe(1)
    expect(edgeIndex(o, 'last')).toBe(2)
  })

  test('打开时落在当前值，当前值禁用或没有时落在第一个可选项', () => {
    const o = opts('!a', 'b', 'c')
    expect(initialIndex(o, 2)).toBe(2)
    expect(initialIndex(o, 0)).toBe(1)
    expect(initialIndex(o, -1)).toBe(1)
  })
})

describe('matchIndex', () => {
  const o = opts('Apple', 'Banana', 'avocado', '!apricot', 'blueberry', '成员', '只读')

  test('前缀匹配不分大小写', () => {
    expect(matchIndex(o, 0, 'ba')).toBe(1)
    expect(matchIndex(o, 0, 'AV')).toBe(2)
    expect(matchIndex(o, 0, '只')).toBe(6)
  })

  test('同一字母连按在以它开头的项之间轮换，跳过禁用项', () => {
    expect(matchIndex(o, 0, 'a')).toBe(2)
    expect(matchIndex(o, 2, 'aa')).toBe(0)
    expect(matchIndex(o, 1, 'b')).toBe(4)
    expect(matchIndex(o, 4, 'b')).toBe(1)
  })

  test('继续往下打字，当前项仍匹配就不动', () => {
    expect(matchIndex(o, 4, 'bl')).toBe(4)
  })

  test('找不到：-1', () => {
    expect(matchIndex(o, 0, 'zz')).toBe(-1)
    expect(matchIndex(o, 0, 'apr')).toBe(-1)
    expect(matchIndex(o, 0, '')).toBe(-1)
  })
})
