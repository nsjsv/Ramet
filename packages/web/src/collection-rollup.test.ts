import { describe, expect, test } from 'vitest'
import {
  filterOps,
  isRollupTarget,
  parseCfg,
  PROP_TYPES,
  readComputed,
  ROLLUP_FNS,
  rollupFns,
  rollupOutput,
  rollupValue,
  rowValue,
  sortable,
  type CollectionProp,
  type CollectionRow,
  type PropType,
  type PropValue,
  type RollupFn,
} from '@ramet/shared/collection-model'

/* 不变量（@ramet/shared 的 collection-rollup.ts）：汇总只由服务端算，两端读 row.computed、按输出类型筛选排序；
 * 输出类型只看计算方式；计算方式不适用于目标类型 = 空；空集合计数类 0、占比 / 统计 / 日期类为空、显示原值为空。 */

const target = (type: PropType): CollectionProp => ({ id: 't00001', name: 'T', type, pos: 0, options: [], cfg: {} })
const rollup = (fn?: RollupFn): CollectionProp => ({
  id: 'r00001',
  name: 'R',
  type: 'rollup',
  pos: 0,
  options: [],
  cfg: { relation: 'l00001', prop: 't00001', ...(fn ? { fn } : {}) },
})
const calc = (fn: RollupFn, type: PropType, values: (PropValue | undefined)[]): unknown => rollupValue(fn, target(type), values)

describe('适用的计算方式与输出类型', () => {
  test('每种目标类型能用的计算方式；关联 / 汇总 / 公式不能当目标', () => {
    expect(rollupFns('text')).toEqual(ROLLUP_FNS.slice(0, 9))
    expect(rollupFns('number')).toEqual([...ROLLUP_FNS.slice(0, 9), 'sum', 'average', 'median', 'min', 'max', 'range'])
    expect(rollupFns('unique_id')).toEqual(rollupFns('number'))
    for (const type of ['date', 'created_time', 'edited_time'] as const) {
      expect(rollupFns(type)).toEqual([...ROLLUP_FNS.slice(0, 9), 'earliest', 'latest', 'date_range'])
    }
    expect(rollupFns('checkbox')).toEqual([...ROLLUP_FNS.slice(0, 9), 'checked', 'unchecked', 'percent_checked', 'percent_unchecked'])
    expect(PROP_TYPES.filter((type) => !isRollupTarget(type))).toEqual(['relation', 'rollup', 'formula'])
    expect(rollupFns('relation')).toEqual([])
    // 全部计算方式都至少适用于一种类型
    const used = new Set(PROP_TYPES.flatMap((type) => [...rollupFns(type)]))
    expect(ROLLUP_FNS.filter((fn) => !used.has(fn))).toEqual([])
  })

  test('输出类型只看计算方式：最早 / 最晚是日期，显示原值 / 去重值与未选是列表，其余是数字', () => {
    expect(ROLLUP_FNS.filter((fn) => rollupOutput(fn) === 'list')).toEqual(['show_original', 'show_unique'])
    expect(ROLLUP_FNS.filter((fn) => rollupOutput(fn) === 'date')).toEqual(['earliest', 'latest'])
    expect(rollupOutput(undefined)).toBe('list')
  })

  test('筛选运算与能否排序跟着输出类型走', () => {
    expect(filterOps(rollup('sum'))).toEqual(['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'empty'])
    expect(filterOps(rollup('latest'))).toEqual(['eq', 'before', 'after', 'empty'])
    expect(filterOps(rollup('show_original'))).toEqual(['empty', 'not_empty'])
    expect(filterOps(rollup())).toEqual(['empty', 'not_empty'])
    expect([sortable(rollup('count')), sortable(rollup('earliest')), sortable(rollup('show_unique')), sortable(rollup())]).toEqual([
      true,
      true,
      false,
      false,
    ])
  })

  test('cfg 解析：正向 / 反向关联与汇总各取认得的字段，认不出的不给', () => {
    const cid = '0b0c3c1e-6f7a-4b2c-9d8e-112233445566'
    expect(parseCfg('relation', { target: cid, reverse: 'q00001', single: true })).toEqual({ target: cid, reverse: 'q00001', single: true })
    expect(parseCfg('relation', { target: cid, reverse: 'BAD', single: 'yes' })).toEqual({ target: cid, reverse: null, single: false })
    expect(parseCfg('relation', { target: cid, mirror: 'p00001', reverse: 'q00001' })).toEqual({ target: cid, mirror: 'p00001' })
    expect(parseCfg('relation', { target: 'not-a-uuid' })).toEqual({ reverse: null, single: false })
    expect(parseCfg('relation', null)).toEqual({ reverse: null, single: false })
    expect(parseCfg('rollup', { relation: 'l00001', prop: 'title', fn: 'sum' })).toEqual({ relation: 'l00001', prop: 'title', fn: 'sum' })
    expect(parseCfg('rollup', { relation: 'title', prop: '__proto__', fn: 'nope' })).toEqual({})
    // 改类型不清 cfg：同一份原值按当前类型读
    expect(parseCfg('unique_id', { target: cid, prefix: 'T' })).toEqual({ prefix: 'T' })
  })
})

describe('计算', () => {
  test('空集合：计数类 0，占比 / 统计 / 日期类为空，显示原值为空', () => {
    for (const fn of ['count', 'count_values', 'count_unique', 'count_empty', 'count_not_empty'] as const) expect(calc(fn, 'text', [])).toBe(0)
    for (const fn of ['checked', 'unchecked'] as const) expect(calc(fn, 'checkbox', [])).toBe(0)
    for (const fn of ['percent_empty', 'percent_not_empty', 'show_original', 'show_unique'] as const) expect(calc(fn, 'text', [])).toBeUndefined()
    for (const fn of ['sum', 'average', 'median', 'min', 'max', 'range'] as const) expect(calc(fn, 'number', [])).toBeUndefined()
    for (const fn of ['earliest', 'latest', 'date_range'] as const) expect(calc(fn, 'date', [])).toBeUndefined()
    for (const fn of ['percent_checked', 'percent_unchecked'] as const) expect(calc(fn, 'checkbox', [])).toBeUndefined()
  })

  test('全是空值：计数照数行，统计为空，占比 1 / 0', () => {
    const values = [undefined, undefined, undefined]
    expect(calc('count', 'number', values)).toBe(3)
    expect(calc('count_empty', 'number', values)).toBe(3)
    expect(calc('count_not_empty', 'number', values)).toBe(0)
    expect(calc('count_values', 'number', values)).toBe(0)
    expect(calc('percent_empty', 'number', values)).toBe(1)
    expect(calc('percent_not_empty', 'number', values)).toBe(0)
    expect(calc('sum', 'number', values)).toBeUndefined()
    expect(calc('show_original', 'number', values)).toBeUndefined()
    expect(calc('unchecked', 'checkbox', values)).toBe(3)
    expect(calc('percent_checked', 'checkbox', values)).toBe(0)
  })

  test('计数：多值逐项算，去重按值', () => {
    const tags: (PropValue | undefined)[] = [['a', 'b'], ['b'], undefined, ['c', 'a']]
    expect(calc('count', 'multi_select', tags)).toBe(4)
    expect(calc('count_values', 'multi_select', tags)).toBe(5)
    expect(calc('count_unique', 'multi_select', tags)).toBe(3)
    expect(calc('count_empty', 'multi_select', tags)).toBe(1)
    expect(calc('count_not_empty', 'multi_select', tags)).toBe(3)
    expect(calc('percent_empty', 'multi_select', tags)).toBe(0.25)
    expect(calc('percent_not_empty', 'multi_select', tags)).toBe(0.75)
  })

  test('显示原值 / 去重值：按关联的顺序逐个摊平，跳过空值；文件按整项去重', () => {
    expect(calc('show_original', 'text', ['甲', undefined, '乙', '甲'])).toEqual(['甲', '乙', '甲'])
    expect(calc('show_unique', 'text', ['甲', undefined, '乙', '甲'])).toEqual(['甲', '乙'])
    expect(calc('show_original', 'multi_select', [['a', 'b'], ['b']])).toEqual(['a', 'b', 'b'])
    expect(calc('show_unique', 'number', [3, 1, 3])).toEqual([3, 1])
    expect(calc('show_original', 'checkbox', [true, undefined, true])).toEqual([true, true])
    const f1 = { id: '11111111-1111-4111-8111-111111111111', name: 'a.png', mime: 'image/png', size: 1 }
    const f2 = { id: '22222222-2222-4222-8222-222222222222', name: 'b.pdf', mime: 'application/pdf', size: 2 }
    expect(calc('show_unique', 'files', [[f1, f2], [f1]])).toEqual([f1, f2])
  })

  test('数字统计：只算数字，中位数偶数个取中间两个的平均', () => {
    const values: (PropValue | undefined)[] = [4, undefined, 1, 7, 2]
    expect(calc('sum', 'number', values)).toBe(14)
    expect(calc('average', 'number', values)).toBe(3.5)
    expect(calc('median', 'number', values)).toBe(3)
    expect(calc('median', 'number', [5, 1, 3])).toBe(3)
    expect(calc('min', 'number', values)).toBe(1)
    expect(calc('max', 'number', values)).toBe(7)
    expect(calc('range', 'number', values)).toBe(6)
    expect(calc('sum', 'unique_id', [3, 4])).toBe(7)
    // 计算方式不适用于目标类型：为空
    expect(calc('sum', 'text', ['1', '2'])).toBeUndefined()
    expect(calc('checked', 'number', [1])).toBeUndefined()
    expect(calc('earliest', 'checkbox', [true])).toBeUndefined()
  })

  test('日期：区间取开始 / 结束，范围按天；创建 / 编辑时间原样取时间戳，范围按毫秒折成天', () => {
    const days: (PropValue | undefined)[] = ['2026-03-05', '2026-01-10/2026-01-20', undefined, '2026-02-01/2026-04-01']
    expect(calc('earliest', 'date', days)).toBe('2026-01-10')
    expect(calc('latest', 'date', days)).toBe('2026-04-01')
    expect(calc('date_range', 'date', days)).toBe(81)
    const stamps = ['2026-01-02 08:00:00+00', '2026-01-01T00:00:00Z', '2026-01-03 12:00:00+00']
    expect(calc('earliest', 'created_time', stamps)).toBe('2026-01-01T00:00:00Z')
    expect(calc('latest', 'edited_time', stamps)).toBe('2026-01-03 12:00:00+00')
    expect(calc('date_range', 'created_time', stamps)).toBe(2.5)
  })

  test('复选框：已勾选 / 未勾选数与占比（空值算没勾）', () => {
    const values = [true, undefined, true, undefined, undefined]
    expect(calc('checked', 'checkbox', values)).toBe(2)
    expect(calc('unchecked', 'checkbox', values)).toBe(3)
    expect(calc('percent_checked', 'checkbox', values)).toBe(0.4)
    expect(calc('percent_unchecked', 'checkbox', values)).toBe(0.6)
  })
})

describe('读 row.computed', () => {
  const row = (computed?: Record<string, unknown>, props: Record<string, unknown> = {}): CollectionRow => ({
    id: 'r1',
    title: '',
    icon: null,
    props,
    position: null,
    created_at: '2026-01-01 00:00:00+00',
    edited_at: '2026-01-01 00:00:00+00',
    has_body: true,
    ...(computed ? { computed } : {}),
  })

  test('汇总按输出类型规整：形状对不上为空，空列表为空', () => {
    expect(readComputed(rollup('sum'), 3)).toBe(3)
    expect(readComputed(rollup('sum'), '3')).toBeUndefined()
    expect(readComputed(rollup('earliest'), '2026-01-01')).toBe('2026-01-01')
    expect(readComputed(rollup('earliest'), '2026-01-01 08:00:00+00')).toBe('2026-01-01 08:00:00+00')
    expect(readComputed(rollup('earliest'), 'nope')).toBeUndefined()
    expect(readComputed(rollup('show_original'), ['a', 1, true, null, { x: 1 }])).toEqual(['a', 1, true])
    expect(readComputed(rollup('show_original'), [])).toBeUndefined()
    expect(rowValue(row({ r00001: 5 }), rollup('count'))).toBe(5)
    expect(rowValue(row(), rollup('count'))).toBeUndefined()
  })

  test('关联：有 computed 以它为准；没有时正向退回行文档里存的（「只能关联一行」只认第一个），反向为空', () => {
    const forward: CollectionProp = { id: 'p00001', name: 'P', type: 'relation', pos: 0, options: [], cfg: { target: 'x', reverse: null, single: false } }
    const single: CollectionProp = { ...forward, cfg: { ...forward.cfg, single: true } }
    const reverse: CollectionProp = { ...forward, cfg: { target: 'x', mirror: 'q00001' } }
    expect(rowValue(row({ p00001: ['b'] }, { p00001: ['a', 'b'] }), forward)).toEqual(['b'])
    // 服务端给了空列表：关联已失效 / 对方的行都不在了，不退回存储值
    expect(rowValue(row({ p00001: [] }, { p00001: ['a'] }), forward)).toBeUndefined()
    expect(rowValue(row(undefined, { p00001: ['a', 'b', 'a'] }), forward)).toEqual(['a', 'b'])
    expect(rowValue(row(undefined, { p00001: ['a', 'b'] }), single)).toEqual(['a'])
    expect(rowValue(row(undefined, { p00001: ['a'] }), reverse)).toBeUndefined()
    expect(rowValue(row({ p00001: ['s1', 's2'] }), reverse)).toEqual(['s1', 's2'])
  })
})
