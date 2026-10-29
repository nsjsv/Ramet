import { describe, expect, test } from 'vitest'
import { parseCollection, TITLE_PROP, type CollectionRow } from '@ramet/shared/collection-model'
import { fillSpan, planFill } from './fill'

/* 不变量：只填拖过的行（不碰选区本身）；数字 / 日期两格以上且等差才续序列，否则按周期复制，往上拖周期不乱；
 * 空格填成清空；计算列不填。 */

const schema = parseCollection({
  props: {
    num001: { name: '数', type: 'number', pos: 0 },
    day001: { name: '日', type: 'date', pos: 1 },
    txt001: { name: '文', type: 'text', pos: 2 },
    crt001: { name: '建', type: 'created_time', pos: 3 },
  },
  views: { v1: { name: '表', layout: 'table', pos: 0, filter: { all: [] }, sorts: [], groupBy: null, shown: null, widths: {} } },
})
const prop = (id: string) => schema.props.find((p) => p.id === id)!
const cols = [TITLE_PROP, prop('num001'), prop('day001'), prop('txt001'), prop('crt001')]

const row = (id: string, props: Record<string, unknown> = {}): CollectionRow => ({
  id,
  title: id,
  icon: null,
  props,
  position: 0,
  created_at: '2026-10-25 00:00:00+00',
  edited_at: '2026-10-25 00:00:00+00',
  has_body: false,
})

/** 第 col 列写进了哪些 [行, 值] */
const colOf = (writes: ReturnType<typeof planFill>, col: number) => writes.filter((w) => w.col === col).map((w) => [w.row, w.value])

test('拖到选区下方 / 上方 = 那一段；停在选区里不填', () => {
  const box = { r0: 2, r1: 3, c0: 1, c1: 1 }
  expect(fillSpan(box, 5)).toEqual({ r0: 4, r1: 5 })
  expect(fillSpan(box, 0)).toEqual({ r0: 0, r1: 1 })
  expect(fillSpan(box, 3)).toBeNull()
  expect(fillSpan(box, 2)).toBeNull()
})

describe('填什么', () => {
  test('单格：往下复制（数字一格不续序列）', () => {
    const rows = [row('a', { num001: 5, txt001: '甲' }), row('b'), row('c')]
    const w = planFill(rows, cols, { r0: 0, r1: 0, c0: 1, c1: 3 }, { r0: 1, r1: 2 })
    expect(colOf(w, 1)).toEqual([[1, 5], [2, 5]])
    expect(colOf(w, 2)).toEqual([[1, null], [2, null]]) // 源格是空的：清空
    expect(colOf(w, 3)).toEqual([[1, '甲'], [2, '甲']])
  })

  test('等差数字续序列，往上拖往回减；小数不出浮点尾巴', () => {
    const rows = [row('a'), row('b'), row('c', { num001: 0.1 }), row('d', { num001: 0.3 }), row('e'), row('f')]
    const box = { r0: 2, r1: 3, c0: 1, c1: 1 }
    expect(colOf(planFill(rows, cols, box, { r0: 4, r1: 5 }), 1)).toEqual([[4, 0.5], [5, 0.7]])
    expect(colOf(planFill(rows, cols, box, { r0: 0, r1: 1 }), 1)).toEqual([[0, -0.3], [1, -0.1]])
  })

  test('不等差 / 有空格：按周期复制，往上拖也是同一周期', () => {
    const rows = [row('a'), row('b'), row('c', { num001: 1 }), row('d', { num001: 2 }), row('e', { num001: 4 }), row('f'), row('g')]
    const box = { r0: 2, r1: 4, c0: 1, c1: 1 }
    expect(colOf(planFill(rows, cols, box, { r0: 5, r1: 6 }), 1)).toEqual([[5, 1], [6, 2]])
    // 紧挨选区上方的是选区最下一格的值（周期往回接）
    expect(colOf(planFill(rows, cols, box, { r0: 0, r1: 1 }), 1)).toEqual([[0, 2], [1, 4]])
  })

  test('日期按天续序列（跨月）；名称列复制标题；计算列不填', () => {
    const rows = [row('a', { day001: '2026-01-30' }), row('b', { day001: '2026-01-31' }), row('c')]
    const w = planFill(rows, cols, { r0: 0, r1: 1, c0: 0, c1: 4 }, { r0: 2, r1: 2 })
    expect(colOf(w, 2)).toEqual([[2, '2026-02-01']])
    expect(colOf(w, 0)).toEqual([[2, 'a']])
    expect(colOf(w, 4)).toEqual([])
  })

  test('日期序列越界的格不动', () => {
    const rows = [row('a'), row('b', { day001: '0001-01-01' }), row('c', { day001: '0001-01-02' })]
    expect(colOf(planFill(rows, cols, { r0: 1, r1: 2, c0: 2, c1: 2 }, { r0: 0, r1: 0 }), 2)).toEqual([])
  })
})
