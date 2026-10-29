import { describe, expect, test } from 'vitest'
import { newStatusOptions, parseCollection, pickView, type CollectionRow } from '@ramet/shared/collection-model'
import { queryWindow } from '@ramet/shared/collection-query'
import { columnsOf, dropNeighbors, gridTemplate, insertNeighbors, moveCursor, sectionsOf } from './table-model'

/* 不变量：「名称」恒为第一列；分段与窗口顺序一致（同组的行连着），计数用服务端的分组计数；
 * 拖行落点给出的邻居就是落下后紧挨着它的两行，没挪动不发请求。 */

const OPTS = newStatusOptions()
const [TODO, DOING, DONE] = Object.keys(OPTS) as [string, string, string]

const schema = parseCollection({
  props: {
    sts001: { name: '状态', type: 'status', pos: 0, options: OPTS },
    num001: { name: '工时', type: 'number', pos: 1 },
    old001: { name: '旧', type: 'text', pos: 2 },
  },
  views: {
    v1: { name: '表', layout: 'table', pos: 0, filter: { all: [] }, sorts: [], groupBy: 'sts001', shown: ['num001', 'gone00', 'title'], widths: { num001: 90 } },
    v2: { name: '表2', layout: 'table', pos: 1, filter: { all: [] }, sorts: [], groupBy: null, shown: null, widths: {} },
  },
})

const row = (id: string, status: string | null, position: number): CollectionRow => ({
  id,
  title: id,
  icon: null,
  props: status ? { sts001: status } : {},
  position,
  created_at: '2026-10-25 00:00:00+00',
  edited_at: '2026-10-25 00:00:00+00',
  has_body: false,
})

test('列：名称在前，按显示顺序，已删的属性不画；shown 为 null 时全部按 pos', () => {
  expect(columnsOf(schema, pickView(schema, 'v1')).map((p) => p.id)).toEqual(['title', 'num001'])
  expect(columnsOf(schema, pickView(schema, 'v2')).map((p) => p.id)).toEqual(['title', 'sts001', 'num001', 'old001'])
  expect(gridTemplate(columnsOf(schema, pickView(schema, 'v1')), pickView(schema, 'v1'))).toBe('280px 90px minmax(44px, 1fr)')
  expect(gridTemplate(columnsOf(schema, pickView(schema, 'v1')), pickView(schema, 'v1'), { id: 'num001', width: 120 })).toBe(
    '280px 120px minmax(44px, 1fr)',
  )
})

describe('分段', () => {
  const rows = [row('a', DOING, 0), row('b', null, 1), row('c', TODO, 2), row('d', DOING, 3)]
  test('窗口到底：按组序出全部组（含空组；状态空值归缺省选项），计数来自服务端', () => {
    const view = pickView(schema, 'v1')
    const win = queryWindow(rows, view, schema)
    const sections = sectionsOf(win, schema, view)
    expect(sections.map((s) => [s.key, s.rows.map((r) => r.id), s.count])).toEqual([
      [TODO, ['b', 'c'], 2],
      [DOING, ['a', 'd'], 2],
      [DONE, [], 0],
    ])
    expect(sections[1]?.option?.id).toBe(DOING)
  })
  test('窗口没到底：只出已加载的组，计数含没加载的', () => {
    const view = pickView(schema, 'v1')
    const win = queryWindow(rows, view, schema, { limit: 3 })
    expect(sectionsOf(win, schema, view).map((s) => [s.key, s.rows.length, s.count])).toEqual([
      [TODO, 2, 2],
      [DOING, 1, 2],
    ])
  })
  test('不分组 = 一段', () => {
    const view = pickView(schema, 'v2')
    expect(sectionsOf(queryWindow(rows, view, schema), schema, view)).toHaveLength(1)
  })
})

test('拖行落点：邻居是落下后紧挨着的两行；原地不动 = null', () => {
  const rows = [row('a', null, 0), row('b', null, 1), row('c', null, 2)]
  expect(dropNeighbors(rows, 'c', 'a', false)).toEqual({ after: null, before: 'a' })
  expect(dropNeighbors(rows, 'a', 'c', true)).toEqual({ after: 'c', before: null })
  expect(dropNeighbors(rows, 'a', 'b', true)).toEqual({ after: 'b', before: 'c' })
  expect(dropNeighbors(rows, 'a', 'b', false)).toBeNull()
  expect(dropNeighbors(rows, 'b', 'a', true)).toBeNull()
  expect(dropNeighbors(rows, 'x', 'a', true)).toBeNull()
  expect(dropNeighbors(rows, 'b', 'b', true)).toBeNull()
  // 别处来的行（看板跨列）：插在目标前后
  expect(insertNeighbors(rows, 'a', false)).toEqual({ after: null, before: 'a' })
  expect(insertNeighbors(rows, 'b', true)).toEqual({ after: 'b', before: 'c' })
  expect(insertNeighbors(rows, 'x', true)).toBeNull()
})

test('方向键：夹在表格范围内', () => {
  expect(moveCursor({ row: 0, col: 0 }, 'ArrowUp', 3, 4)).toEqual({ row: 0, col: 0 })
  expect(moveCursor({ row: 2, col: 3 }, 'ArrowRight', 3, 4)).toEqual({ row: 2, col: 3 })
  expect(moveCursor({ row: 1, col: 1 }, 'ArrowDown', 3, 4)).toEqual({ row: 2, col: 1 })
  expect(moveCursor({ row: 1, col: 1 }, 'Enter', 3, 4)).toBeNull()
})

test('⌘ / Ctrl+方向键到边，Home / End 到行首行尾（加 ⌘ 到首格 / 末格）', () => {
  expect(moveCursor({ row: 1, col: 1 }, 'ArrowDown', 3, 4, true)).toEqual({ row: 2, col: 1 })
  expect(moveCursor({ row: 1, col: 1 }, 'ArrowLeft', 3, 4, true)).toEqual({ row: 1, col: 0 })
  expect(moveCursor({ row: 1, col: 1 }, 'End', 3, 4)).toEqual({ row: 1, col: 3 })
  expect(moveCursor({ row: 1, col: 1 }, 'Home', 3, 4, true)).toEqual({ row: 0, col: 0 })
  expect(moveCursor({ row: 1, col: 1 }, 'End', 3, 4, true)).toEqual({ row: 2, col: 3 })
  // Tab 不跳
  expect(moveCursor({ row: 1, col: 1 }, 'Tab', 3, 4, true)).toEqual({ row: 1, col: 2 })
})
