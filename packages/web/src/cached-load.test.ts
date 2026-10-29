import { describe, expect, test } from 'vitest'
import { createLoadCache } from './cached-load'

describe('列表页缓存', () => {
  test('取到就记住；失败不改缓存', async () => {
    const cache = createLoadCache()
    expect(cache.peek('memory:s1')).toBeUndefined()
    expect(await cache.fetch('memory:s1', async () => [1, 2])).toEqual({ ok: true, data: [1, 2], stale: false })
    expect(cache.peek('memory:s1')).toEqual([1, 2])
    const failed = await cache.fetch('memory:s1', async () => {
      throw new Error('boom')
    })
    expect(failed.ok).toBe(false)
    expect(cache.peek('memory:s1')).toEqual([1, 2])
  })

  test('超出上限：最久没用的先丢（读一次算用过）', () => {
    const cache = createLoadCache(2)
    cache.put('a', 1)
    cache.put('b', 2)
    expect(cache.peek('a')).toBe(1)
    cache.put('c', 3)
    expect(cache.peek('b')).toBeUndefined()
    expect(cache.peek('a')).toBe(1)
    expect(cache.peek('c')).toBe(3)
  })

  test('reset 清空；之前发出的请求回来了不写进缓存', async () => {
    const cache = createLoadCache()
    cache.put('a', 1)
    let resolve!: (v: number) => void
    const pending = cache.fetch('b', () => new Promise<number>((r) => (resolve = r)))
    cache.reset()
    expect(cache.peek('a')).toBeUndefined()
    resolve(2)
    expect(await pending).toEqual({ ok: true, data: 2, stale: true })
    expect(cache.peek('b')).toBeUndefined()
  })
})
