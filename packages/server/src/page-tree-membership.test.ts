import { expect, test } from 'vitest'
import { pagesInPageTree } from '@ramet/shared/page-tree'

type Row = { id: string; parent_id: string | null; in_page_tree?: boolean }

test('目录树文档及其子孙不进页面树；普通页和缺省字段仍在', () => {
  const dir = { id: 'dir', parent_id: null, in_page_tree: false }
  const child = { id: 'child', parent_id: 'dir', in_page_tree: true }
  const run = { id: 'run', parent_id: 'child' }
  const root = { id: 'root', parent_id: null, in_page_tree: true }
  const nested = { id: 'nested', parent_id: 'root' }
  const legacy = { id: 'legacy', parent_id: null }

  expect(pagesInPageTree<Row>([dir, child, run, root, nested, legacy]).map((p) => p.id)).toEqual([
    'root',
    'nested',
    'legacy',
  ])
})

test('父不在列表里的页当顶层；parent 成环的页排除', () => {
  const orphan = { id: 'orphan', parent_id: 'missing', in_page_tree: true }
  const a = { id: 'a', parent_id: 'b', in_page_tree: true }
  const b = { id: 'b', parent_id: 'a', in_page_tree: true }

  expect(pagesInPageTree<Row>([orphan]).map((p) => p.id)).toEqual(['orphan'])
  expect(pagesInPageTree<Row>([a, b])).toEqual([])
})
