import { describe, expect, test } from 'vitest'
import type { CollectionProp, CollectionRow } from '@ramet/shared/collection-model'
import { setSelf } from '../../people'
import { boxOf, cellText, parseCell, parseTsv, planPaste, toTsv, type ParseCtx } from './cell-range'

const prop = (type: CollectionProp['type'], options: CollectionProp['options'] = []): CollectionProp => ({ id: 'p1', name: 'P', type, pos: 0, options, cfg: {} })
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

describe('新类型的复制与粘贴', () => {
  const FILE_A = { id: '0b8f6a52-3f6c-4c3e-9a51-2b1d7c9e4f01', name: 'a.png', mime: 'image/png', size: 10 }
  const FILE_B = { id: '0b8f6a52-3f6c-4c3e-9a51-2b1d7c9e4f02', name: '报告.pdf', mime: 'application/pdf', size: 20 }
  const row = (props: Record<string, unknown>, meta: Partial<CollectionRow> = {}): CollectionRow => ({
    id: 'r1',
    title: 'R',
    icon: null,
    props,
    position: 0,
    created_at: '2026-10-25 00:00:00+00',
    edited_at: '2026-10-25 00:00:00+00',
    has_body: false,
    ...meta,
  })

  test('复制：邮箱 / 电话原样，区间「开始 → 结束」，文件名用「、」连，编号带前缀，创建者 / 最后编辑者给名字', () => {
    setSelf({ id: 'me', username: '小明', avatar: null })
    expect(cellText(row({ p1: 'a@b.co' }), prop('email'), null)).toBe('a@b.co')
    expect(cellText(row({ p1: '+86 10 1234' }), prop('phone'), null)).toBe('+86 10 1234')
    expect(cellText(row({ p1: '2026-01-05/2026-01-02' }), prop('date'), null)).toBe('2026-01-02 → 2026-01-05')
    expect(cellText(row({ p1: '2026-01-02' }), prop('date'), null)).toBe('2026-01-02')
    expect(cellText(row({ p1: [FILE_A, FILE_B] }), prop('files'), null)).toBe('a.png、报告.pdf')
    const num: CollectionProp = { ...prop('unique_id'), cfg: { prefix: 'TASK' } }
    expect(cellText(row({}, { number: 12 }), num, null)).toBe('TASK-12')
    expect(cellText(row({}, { number: 12 }), prop('unique_id'), null)).toBe('12')
    expect(cellText(row({}), prop('unique_id'), null)).toBe('')
    expect(cellText(row({}, { created_by: 'me' }), prop('created_by'), null)).toBe('小明')
    expect(cellText(row({}, { edited_by: 'me' }), prop('edited_by'), null)).toBe('小明')
  })

  test('粘贴：邮箱 / 电话过校验；区间认四种写法；文件和系统生成的类型贴不进', () => {
    expect(parseCell(prop('email'), ' a@b.co ', ctx)).toBe('a@b.co')
    expect(parseCell(prop('email'), 'not-an-email', ctx)).toBeUndefined()
    expect(parseCell(prop('phone'), '010-1234 5678', ctx)).toBe('010-1234 5678')
    expect(parseCell(prop('phone'), 'call me', ctx)).toBeUndefined()
    for (const text of ['2026-01-02 → 2026-01-05', '2026-01-02/2026-01-05', '2026/1/2 ~ 2026/1/5', '2026年1月2日 至 2026年1月5日'])
      expect([text, parseCell(prop('date'), text, ctx)]).toEqual([text, '2026-01-02/2026-01-05'])
    expect(parseCell(prop('date'), '2026-01-05 → 2026-01-02', ctx)).toBe('2026-01-02/2026-01-05')
    expect(parseCell(prop('date'), '2026-01-02 → 2026-01-02', ctx)).toBe('2026-01-02')
    expect(parseCell(prop('date'), '2026/1/2', ctx)).toBe('2026-01-02')
    expect(parseCell(prop('date'), '2026-01-02 → 2026-02-30', ctx)).toBeUndefined()
    expect(parseCell(prop('date'), '2026-01-02 → 2026-01-03 → 2026-01-04', ctx)).toBeUndefined()
    expect(parseCell(prop('files'), 'a.png', ctx)).toBeUndefined()
    for (const type of ['created_by', 'edited_by', 'unique_id'] as const) expect(parseCell(prop(type), '1', ctx)).toBeUndefined()
  })
})

describe('关联与汇总', () => {
  const rel: CollectionProp = { id: 'rel001', name: '项目', type: 'relation', pos: 0, options: [], cfg: { target: '0b0c3c1e-6f7a-4b2c-9d8e-112233445566', reverse: null } }
  const sum: CollectionProp = { id: 'sum001', name: '数', type: 'rollup', pos: 1, options: [], cfg: { relation: 'rel001', prop: 'title', fn: 'percent_not_empty' } }
  const row: CollectionRow = {
    id: 'a1',
    title: 'A1',
    icon: null,
    props: { rel001: ['x'] },
    position: 0,
    created_at: '',
    edited_at: '',
    has_body: false,
    computed: { rel001: [], sum001: 0.25 },
  }

  test('复制：关联给对方行的标题（读 computed，空 = 空串），汇总给显示的文字', () => {
    expect(cellText(row, rel, null)).toBe('')
    expect(cellText(row, sum, null)).toBe('25.0%')
  })

  test('粘贴不认关联与汇总（标题认不回是哪一行）', () => {
    expect(parseCell(rel, '阿尔法', ctx)).toBeUndefined()
    expect(parseCell(rel, '', ctx)).toBeUndefined()
    expect(parseCell(sum, '3', ctx)).toBeUndefined()
  })
})

describe('公式', () => {
  const formula = (output: CollectionProp['output']): CollectionProp => ({ id: 'fx0001', name: '公式', type: 'formula', pos: 0, options: [], cfg: {}, output })
  const row = (value: unknown): CollectionRow => ({
    id: 'a1',
    title: 'A1',
    icon: null,
    props: {},
    position: 0,
    created_at: '',
    edited_at: '',
    has_body: false,
    computed: { fx0001: value },
  })

  test('复制按输出类型的文字；是否同复选框（勾 / 空）；有误的公式是空串', () => {
    expect(cellText(row(12.5), formula('number'), null)).toBe('12.5')
    expect(cellText(row(true), formula('boolean'), null)).toBe('✓')
    expect(cellText(row(false), formula('boolean'), null)).toBe('')
    expect(cellText(row('2026-10-01'), formula('date'), null)).toBe('2026-10-01')
    expect(cellText(row(['A', 'B']), formula('list'), null)).toBe('A、B')
    expect(cellText(row(12.5), formula(null), null)).toBe('')
  })

  test('粘贴不写公式', () => {
    expect(parseCell(formula('number'), '3', ctx)).toBeUndefined()
    expect(parseCell(formula('text'), '', ctx)).toBeUndefined()
  })
})
