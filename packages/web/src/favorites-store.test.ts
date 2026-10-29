import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { favoritesState, isFavorite, loadFavorites, toggleFavorite } from './favorites-store'

/* 不变量：切换是乐观的（星标立刻变），请求失败回滚；收藏的键是 页面#块（整页块为空），页面和它里面的块互不干扰；
 * 服务端列表是权威，加载后替换本地占位 */

type Row = { id: string; pageId: string; blockId: string | null; blockType: string; text: string; title: string; gone: boolean; createdAt: string }
const row = (id: string, pageId: string, blockId: string | null): Row => ({ id, pageId, blockId, blockType: '', text: '', title: '', gone: false, createdAt: '' })

let server: Row[] = []
let failNext = false
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET'
  if (failNext && method !== 'GET') {
    failNext = false
    return new Response('{"error":"boom"}', { status: 500 })
  }
  if (method === 'GET') return new Response(JSON.stringify(server), { status: 200 })
  if (method === 'POST') {
    const body = JSON.parse(String(init?.body)) as { pageId: string; blockId?: string }
    const created = row(`f-${server.length + 1}`, body.pageId, body.blockId ?? null)
    server = [created, ...server]
    return new Response(JSON.stringify({ id: created.id }), { status: 201 })
  }
  const id = url.split('/').pop()
  server = server.filter((r) => r.id !== id)
  return new Response('{}', { status: 200 })
})

beforeEach(async () => {
  server = []
  failNext = false
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  await loadFavorites() // 清掉上一条用例留下的本地状态
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('收藏页面与块互不干扰；切换乐观生效，取消后消失', async () => {
  expect(await toggleFavorite('p1')).toBe(true)
  expect(isFavorite('p1')).toBe(true)
  expect(isFavorite('p1', 'b1')).toBe(false) // 收藏了页面，不等于收藏了里面的块
  expect(await toggleFavorite('p1', 'b1')).toBe(true)
  expect(isFavorite('p1', 'b1')).toBe(true)
  await loadFavorites()
  expect(favoritesState().list.map((f) => [f.pageId, f.blockId])).toEqual([['p1', 'b1'], ['p1', null]])

  expect(await toggleFavorite('p1', 'b1')).toBe(false)
  expect(isFavorite('p1', 'b1')).toBe(false)
  expect(isFavorite('p1')).toBe(true)
})

test('请求失败：回滚到切换之前（收藏失败不留星标，取消失败星标还在）', async () => {
  failNext = true
  expect(await toggleFavorite('p2', 'b9')).toBe(false)
  expect(isFavorite('p2', 'b9')).toBe(false)

  await toggleFavorite('p2', 'b9')
  await loadFavorites()
  expect(isFavorite('p2', 'b9')).toBe(true)
  failNext = true
  expect(await toggleFavorite('p2', 'b9')).toBe(true)
  expect(isFavorite('p2', 'b9')).toBe(true)
})
