import { expect, test } from 'vitest'
import { comparePages } from '@ramet/shared/page-tree'
import type { Page, PageSync } from './api'
import { applyPageSync, createPageSyncer, readPagesCache, writePagesCache, type SyncMark } from './page-sync'

/* 不变量：增量并进本地列表后与整表重拉逐项同序（comparePages = 服务端 position ASC NULLS LAST, created_at, id）；
 * 旧缓存（数组）照样播种但没有游标；单飞 + 在途期间的请求完成后再来一次 */

const page = (id: string, extra: Partial<Page> = {}): Page => ({
  id,
  parent_id: null,
  title: id,
  created_at: '2026-10-27 10:00:00+00',
  space_id: 's',
  published: false,
  kind: 'doc',
  publish_includes_runs: false,
  icon: null,
  position: null,
  ...extra,
})

test('comparePages：position 升序、NULL 排后，再 created_at、id', () => {
  const list = [
    page('d', { position: null, created_at: '2026-10-27 10:00:02+00' }),
    page('c', { position: null, created_at: '2026-10-27 10:00:01+00' }),
    page('b', { position: 2 }),
    page('a', { position: 0.5 }),
    page('e', { position: undefined, created_at: '2026-10-27 10:00:01+00' }),
    page('f', { position: 2, created_at: '2026-10-27 09:00:00+00' }),
  ]
  expect([...list].sort(comparePages).map((p) => p.id)).toEqual(['a', 'f', 'b', 'c', 'e', 'd'])
})

test('applyPageSync：full 替换；增量摘 rm、覆盖 / 补上 up 再重排；没碰到的本地改动保留', () => {
  const cur = [page('a', { position: 0 }), page('b', { position: 1, title: '乐观改名' }), page('c', { position: 2 })]
  const full: PageSync = { cursor: '1', members: 'm', full: [page('z')] }
  expect(applyPageSync(cur, full).map((p) => p.id)).toEqual(['z'])

  const delta: PageSync = {
    cursor: '2',
    members: 'm',
    up: [page('c', { position: -1, title: '挪到最前' }), page('n', { position: 1.5 })],
    rm: ['a', 'ghost'],
  }
  const next = applyPageSync(cur, delta)
  expect(next.map((p) => p.id)).toEqual(['c', 'b', 'n'])
  expect(next[0]!.title).toBe('挪到最前')
  expect(next[1]!.title).toBe('乐观改名')
  // 不改入参
  expect(cur.map((p) => p.id)).toEqual(['a', 'b', 'c'])
})

test('缓存：新格式往返；旧数组格式播种但没有游标；坏数据按无缓存', () => {
  const mark: SyncMark = { cursor: '123', members: 'abc' }
  const pages = [page('a')]
  expect(readPagesCache(writePagesCache(mark, pages))).toEqual({ mark, pages })
  expect(readPagesCache(JSON.stringify(pages))).toEqual({ mark: null, pages })
  expect(readPagesCache(JSON.stringify({ pages, cursor: 5 }))).toEqual({ mark: null, pages })
  expect(readPagesCache(null)).toBeNull()
  expect(readPagesCache('{oops')).toBeNull()
  expect(readPagesCache(JSON.stringify({ cursor: '1', members: 'm' }))).toBeNull()
  expect(readPagesCache('42')).toBeNull()
})

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('syncer：单飞，在途期间的请求合并成完成后的一次；游标与确认列表按响应推进', async () => {
  const calls: (SyncMark | null)[] = []
  const pending: ReturnType<typeof deferred<PageSync>>[] = []
  const results: { mark: SyncMark; confirmed: string[] }[] = []
  const syncer = createPageSyncer({
    cache: { mark: { cursor: '10', members: 'm' }, pages: [page('a')] },
    fetch: (since) => {
      calls.push(since)
      const d = deferred<PageSync>()
      pending.push(d)
      return d.promise
    },
    onResult: (_res, mark, confirmed) => results.push({ mark, confirmed: confirmed.map((p) => p.id) }),
    onError: () => {},
  })
  const first = syncer.run()
  const second = syncer.run()
  const third = syncer.run()
  expect(calls).toEqual([{ cursor: '10', members: 'm' }])
  pending[0]!.resolve({ cursor: '11', members: 'm', up: [page('b')], rm: [] })
  expect((await first)?.map((p) => p.id)).toEqual(['a', 'b'])
  await new Promise((r) => setTimeout(r, 0))
  // 在途期间的两次合成一次，带的是新游标
  expect(calls).toEqual([{ cursor: '10', members: 'm' }, { cursor: '11', members: 'm' }])
  pending[1]!.resolve({ cursor: '12', members: 'm', up: [], rm: ['a'] })
  expect((await second)?.map((p) => p.id)).toEqual(['b'])
  expect((await third)?.map((p) => p.id)).toEqual(['b'])
  expect(results).toEqual([
    { mark: { cursor: '11', members: 'm' }, confirmed: ['a', 'b'] },
    { mark: { cursor: '12', members: 'm' }, confirmed: ['b'] },
  ])
  await new Promise((r) => setTimeout(r, 0))
  expect(calls).toHaveLength(2)
})

test('syncer：没有缓存（或旧缓存没游标）就不带游标；失败兑现 null、游标不动', async () => {
  const calls: (SyncMark | null)[] = []
  let fail = true
  const syncer = createPageSyncer({
    cache: { mark: null, pages: [page('a')] },
    fetch: async (since) => {
      calls.push(since)
      if (fail) throw new Error('网络断了')
      return { cursor: '7', members: 'm', full: [page('x')] }
    },
    onResult: () => {},
    onError: () => {},
  })
  expect(await syncer.run()).toBeNull()
  fail = false
  expect((await syncer.run())?.map((p) => p.id)).toEqual(['x'])
  expect(calls).toEqual([null, null])
  await syncer.run()
  expect(calls[2]).toEqual({ cursor: '7', members: 'm' })
})
