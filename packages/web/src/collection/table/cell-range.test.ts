import { describe, expect, test } from 'vitest'
import type { CollectionProp } from '@ramet/shared/collection-model'
import { boxOf, parseCell, parseTsv, planPaste, toTsv, type ParseCtx } from './cell-range'

const prop = (type: CollectionProp['type'], options: CollectionProp['options'] = []): CollectionProp => ({ id: 'p1', name: 'P', type, pos: 0, options })
const opts = [
  { id: 'oa', name: 'A', color: 'red', pos: 0 },
  { id: 'ob', name: 'B', color: 'blue', pos: 1 },
] as CollectionProp['options']
const ctx: ParseCtx = {
  optionId: (p, name) => p.options.find((o) => o.name === name)?.id,
  personId: (name) => (name === 'amy' ? 'u1' : undefined),
}

describe('格子选区', () => {
  test('矩形：两个方向都归一', () => {
    expect(boxOf({ row: 3, col: 1 }, { row: 1, col: 4 })).toEqual({ r0: 1, r1: 3, c0: 1, c1: 4 })
  })

  test('TSV 往返：制表符 / 换行 / 引号的格加引号', () => {
    const grid = [
      ['a', 'b\tc'],
      ['多\n行', 'say "hi"'],
      ['', 'x'],
    ]
    expect(parseTsv(toTsv(grid))).toEqual(grid)
    expect(parseTsv('1\t2\r\n3\t4\r\n')).toEqual([
      ['1', '2'],
      ['3', '4'],
    ])
  })

  test('粘贴落点：一格填满选区；多格从左上角铺开并裁到表格内', () => {
    expect(planPaste([['v']], { r0: 0, r1: 1, c0: 2, c1: 3 }, 5, 5).map((x) => [x.row, x.col])).toEqual([
      [0, 2],
      [0, 3],
      [1, 2],
      [1, 3],
    ])
    const out = planPaste(
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
      { r0: 4, r1: 4, c0: 1, c1: 1 },
      5,
      2,
    )
    expect(out).toEqual([{ row: 4, col: 1, text: 'a' }])
  })

  test('文字 → 值：按类型解析，认不出跳过，空 = 清空', () => {
    expect(parseCell(prop('number'), '1,234.5', ctx)).toBe(1234.5)
    expect(parseCell(prop('number'), 'abc', ctx)).toBeUndefined()
    expect(parseCell(prop('date'), '2026/1/2', ctx)).toBe('2026-01-02')
    expect(parseCell(prop('date'), '2026-02-30', ctx)).toBeUndefined()
    expect(parseCell(prop('checkbox'), '✓', ctx)).toBe(true)
    expect(parseCell(prop('checkbox'), '否', ctx)).toBeNull()
    expect(parseCell(prop('select', opts), 'B', ctx)).toBe('ob')
    expect(parseCell(prop('select', opts), 'C', ctx)).toBeUndefined()
    expect(parseCell(prop('multi_select', opts), 'A、B, C', ctx)).toEqual(['oa', 'ob'])
    expect(parseCell(prop('person'), 'amy，bob', ctx)).toEqual(['u1'])
    expect(parseCell(prop('text'), '  ', ctx)).toBeNull()
    expect(parseCell(prop('created_time'), '2026-01-01', ctx)).toBeUndefined()
  })
})
