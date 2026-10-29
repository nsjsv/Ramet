import { describe, expect, test } from 'vitest'
import { newStatusOptions, parseCollection, pickView, type CollectionRow } from '@ramet/shared/collection-model'
import { boardColumns, canDrop, cardProps, dropPlan, hasValue } from './board-model'

/* 不变量：列 = 组序（「无值」在最前）；卡片不重复画名称与分组属性、空值不画；
 * 落点：跨列改分组值（无值列写 null），无排序时带上落点邻居，有排序时列内不能拖，落回原处不发请求。 */

const OPTS = newStatusOptions()
const [TODO, DOING, DONE] = Object.keys(OPTS) as [string, string, string]

const view = (id: string, settings: Record<string, unknown>) => ({
  name: id,
  layout: 'board',
  pos: 0,
  filter: { all: [] },
  sorts: [],
  groupBy: 'sts001',
  shown: null,
  widths: {},
  ...settings,
})

const schema = parseCollection({
  props: {
    sts001: { name: '状态', type: 'status', pos: 0, options: OPTS },
    num001: { name: '工时', type: 'number', pos: 1 },
    chk001: { name: '完成', type: 'checkbox', pos: 2 },
    tag001: { name: '标签', type: 'multi_select', pos: 3, options: {} },
    txt001: { name: '备注', type: 'text', pos: 4 },
  },
  views: {
    b1: view('b1', {}),
    b2: view('b2', { sorts: [{ prop: 'num001', dir: 'asc' }], shown: ['txt001', 'sts001', 'title', 'gone00'] }),
    b3: view('b3', { groupBy: 'num001' }),
  },
})

const row = (id: string, props: Record<string, unknown> = {}): CollectionRow => ({
  id,
  title: id,
  icon: null,
  props,
  position: null,
  created_at: '2026-10-25 00:00:00+00',
  edited_at: '2026-10-25 00:00:00+00',
  has_body: false,
})

test('列：按选项顺序（状态空值读成缺省选项，没有无值列）；分组属性不是状态 / 单选 = 不能分列', () => {
  const cols = boardColumns(schema, pickView(schema, 'b1'))
  expect(cols?.prop.id).toBe('sts001')
  expect(cols?.columns.map((c) => c.key)).toEqual([TODO, DOING, DONE])
  expect(cols?.columns[1]?.option?.id).toBe(DOING)
  expect(boardColumns(schema, pickView(schema, 'b3'))).toBeNull()
})

test('卡片属性：按显示顺序，去掉名称与分组属性、已删的属性；空值不画', () => {
  expect(cardProps(schema, pickView(schema, 'b1')).map((p) => p.id)).toEqual(['num001', 'chk001', 'tag001', 'txt001'])
  expect(cardProps(schema, pickView(schema, 'b2')).map((p) => p.id)).toEqual(['txt001'])
  const prop = (id: string) => cardProps(schema, pickView(schema, 'b1')).find((p) => p.id === id)!
  expect(hasValue(row('a', { num001: 0 }), prop('num001'))).toBe(true)
  expect(hasValue(row('a', { chk001: false }), prop('chk001'))).toBe(false)
  expect(hasValue(row('a', { chk001: true }), prop('chk001'))).toBe(true)
  expect(hasValue(row('a', { tag001: [] }), prop('tag001'))).toBe(false)
  expect(hasValue(row('a', { txt001: 5 }), prop('txt001'))).toBe(false)
})

describe('落点', () => {
  const manual = pickView(schema, 'b1')
  const sorted = pickView(schema, 'b2')
  const doing = [row('b', { sts001: DOING }), row('c', { sts001: DOING })]

  test('跨列：改值 + 落点邻居；无值列写 null；空列只改值', () => {
    const drag = { rowId: 'a', from: TODO }
    expect(dropPlan(manual, drag, { key: DOING, targetId: 'c', below: false }, doing)).toEqual({
      set: { sts001: DOING },
      neighbors: { after: 'b', before: 'c' },
    })
    expect(dropPlan(manual, drag, { key: DOING, targetId: null, below: false }, doing)).toEqual({
      set: { sts001: DOING },
      neighbors: { after: 'c', before: null },
    })
    expect(dropPlan(manual, drag, { key: '', targetId: null, below: false }, [])).toEqual({ set: { sts001: null }, neighbors: null })
  })

  test('列内：只挪顺序；落回原处 = null', () => {
    const drag = { rowId: 'b', from: DOING }
    expect(dropPlan(manual, drag, { key: DOING, targetId: 'c', below: true }, doing)).toEqual({
      set: null,
      neighbors: { after: 'c', before: null },
    })
    expect(dropPlan(manual, drag, { key: DOING, targetId: 'c', below: false }, doing)).toBeNull()
    expect(dropPlan(manual, drag, { key: DOING, targetId: 'b', below: true }, doing)).toBeNull()
    expect(dropPlan(manual, { rowId: 'c', from: DOING }, { key: DOING, targetId: null, below: false }, doing)).toBeNull()
  })

  test('有排序：列内不能拖；跨列只改值', () => {
    expect(canDrop(sorted, { rowId: 'b', from: DOING }, DOING)).toBe(false)
    expect(canDrop(manual, { rowId: 'b', from: DOING }, DOING)).toBe(true)
    expect(dropPlan(sorted, { rowId: 'b', from: DOING }, { key: DOING, targetId: 'c', below: true }, doing)).toBeNull()
    expect(dropPlan(sorted, { rowId: 'a', from: TODO }, { key: DOING, targetId: 'c', below: false }, doing)).toEqual({
      set: { sts001: DOING },
      neighbors: null,
    })
  })
})
