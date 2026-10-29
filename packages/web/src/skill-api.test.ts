import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cachedSkills, invalidateSkills, loadSkills } from './skill-api'

// 斜杠菜单每次弹出都要 skill 列表，但同一空间 30 秒内只打一次服务端；并发请求合并成一次；
// 库里增删改后（invalidate）下一次取数重新来；失败退回旧值而不是抛错

const list = [{ id: 'p1', name: 'one' }]
let calls = 0
const fetchMock = vi.fn(async () => {
  calls++
  return new Response(JSON.stringify(list), { status: 200 })
})

beforeEach(() => {
  calls = 0
  vi.useFakeTimers()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  fetchMock.mockClear()
})

test('同空间 30 秒内复用，过期才重新请求；并发请求合并', async () => {
  const [a, b] = await Promise.all([loadSkills('s-ttl'), loadSkills('s-ttl')])
  expect(a).toEqual(list)
  expect(b).toBe(a)
  expect(calls).toBe(1)
  expect(cachedSkills('s-ttl')).toEqual(list)

  await loadSkills('s-ttl')
  expect(calls).toBe(1)
  vi.advanceTimersByTime(31_000)
  await loadSkills('s-ttl')
  expect(calls).toBe(2)
})

test('invalidate 后下一次取数重新来；不同空间互不影响', async () => {
  await loadSkills('s-inv')
  await loadSkills('s-other')
  expect(calls).toBe(2)
  invalidateSkills('s-inv')
  await loadSkills('s-inv')
  await loadSkills('s-other')
  expect(calls).toBe(3)
})

test('请求失败：退回缓存里的旧值（没有就空表），不抛错', async () => {
  await loadSkills('s-fail')
  fetchMock.mockImplementationOnce(async () => new Response('{"error":"boom"}', { status: 500 }))
  expect(await loadSkills('s-fail', true)).toEqual(list)
  fetchMock.mockImplementationOnce(async () => new Response('{"error":"boom"}', { status: 500 }))
  expect(await loadSkills('s-never', true)).toEqual([])
})
