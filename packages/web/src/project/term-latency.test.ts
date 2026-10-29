import { expect, test } from 'vitest'
import { LatencySamples, percentile, spread } from './term-latency'

test('percentile：最近秩法；没有样本 = null', () => {
  expect(percentile([], 50)).toBeNull()
  expect(percentile([30], 95)).toBe(30)
  const xs = Array.from({ length: 20 }, (_, i) => i + 1) // 1..20
  expect(percentile(xs, 50)).toBe(10)
  expect(percentile(xs, 95)).toBe(19)
  expect(percentile([5, 1, 3], 50)).toBe(3) // 不要求有序
})

test('spread 取整；LatencySamples 只留最近 keep 个', () => {
  expect(spread([])).toBeNull()
  expect(spread([10.4, 20.6])).toEqual({ p50: 10, p95: 21 })
  const s = new LatencySamples(3)
  for (const x of [1, 2, 3, 4]) s.add(x)
  expect(s.values).toEqual([2, 3, 4])
})
