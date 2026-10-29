import { expect, test } from 'vitest'
import type { Page } from '../api'
import { blockVerdict, needsState, type VerdictInput } from './embed-verdict'

// 不变量：内联集合只有父页是本页才显示数据（挪走 / 副本里的块不链接回源数据）；
// 链接视图不论集合在哪都显示；不在页面列表里才问状态接口，区分「在回收站」与「无法加载」。

const page = (id: string, parent: string | null, kind: Page['kind'] = 'collection'): Page => ({
  id,
  parent_id: parent,
  title: id,
  kind,
  created_at: '',
  space_id: 's1',
  published: false,
  publish_includes_runs: false,
  icon: null,
})
const base: VerdictInput = { link: false, hostId: 'h', collectionId: 'c', pages: [], state: undefined, creating: false, failed: false }
const kind = (o: Partial<VerdictInput>) => blockVerdict({ ...base, ...o }).kind

test('在列表里：父页是本页 = 拥有；不是 = 已不在本页；链接视图都显示', () => {
  expect(blockVerdict({ ...base, pages: [page('c', 'h')] })).toEqual({ kind: 'show', spaceId: 's1' })
  expect(kind({ pages: [page('c', 'other')] })).toBe('elsewhere')
  expect(kind({ pages: [page('c', 'other')], link: true })).toBe('show')
  expect(kind({ pages: [page('c', 'h', 'doc')] })).toBe('unavailable')
})

test('不在列表里：按状态接口', () => {
  expect(kind({ state: undefined })).toBe('loading')
  expect(kind({ state: null })).toBe('unavailable')
  expect(kind({ state: { state: 'trashed', parent_id: 'h', title: 'c', inline: true } })).toBe('trashed')
  expect(kind({ state: { state: 'trashed', parent_id: 'x', title: 'c', inline: true } })).toBe('elsewhere')
  expect(kind({ state: { state: 'trashed', parent_id: 'x', title: 'c', inline: true }, link: true })).toBe('trashed')
  expect(kind({ state: { state: 'live', parent_id: 'h', title: 'c', inline: true } })).toBe('show')
})

test('本端正在建 / 建失败；列表没到；块里没有集合 id', () => {
  expect(kind({ creating: true })).toBe('creating')
  expect(kind({ creating: true, pages: [page('c', 'h')] })).toBe('show')
  expect(kind({ failed: true, pages: [page('c', 'h')] })).toBe('failed')
  expect(kind({ pages: null })).toBe('loading')
  expect(kind({ collectionId: '' })).toBe('unavailable')
})

test('只有不在列表里、也不是本端正在建的才问状态接口', () => {
  expect(needsState({ pages: [], collectionId: 'c', creating: false, failed: false })).toBe(true)
  expect(needsState({ pages: [page('c', 'h')], collectionId: 'c', creating: false, failed: false })).toBe(false)
  expect(needsState({ pages: null, collectionId: 'c', creating: false, failed: false })).toBe(false)
  expect(needsState({ pages: [], collectionId: 'c', creating: true, failed: false })).toBe(false)
})

test('块里能不能改集合：宿主页可写且集合所在空间里不是 viewer', async () => {
  const { blockWritable } = await import('./embed-verdict')
  const spaces = [
    { id: 'mine', my_role: 'member' },
    { id: 'ro', my_role: 'viewer' },
  ] as unknown as import('../api').Space[]
  expect(blockWritable(true, spaces, 'mine')).toBe(true)
  expect(blockWritable(true, spaces, 'ro')).toBe(false) // 别的空间粘贴来的链接视图，我在那边是 viewer
  expect(blockWritable(false, spaces, 'mine')).toBe(false) // 宿主页只读
  expect(blockWritable(true, spaces, 'other')).toBe(true) // 不在我的空间列表里：同 PageRoute 口径，以服务端为准
})
