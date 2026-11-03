import { describe, expect, test } from 'vitest'
import { dateSpan, type CollectionRow } from '@ramet/shared/collection-model'
import { parseRange } from '@ramet/shared/collection-query'
import { fitLanes, fitWeek, isMonth, itemsOn, layoutWeeks, monthGrid, shiftMonth, shiftSpan, type CalItem, type Placed } from './calendar-model'

/* 日历排版：6 × 7 周一开头；条目按周截断、各周分车道（开始早、跨度长的先放）；放不下的收进「+N」，
 * 每天显示的 + 收起的 = 当天的全部条目；拖动整体平移，区间长度不变 */

const row = (id: string): CollectionRow => ({
  id,
  title: id,
  icon: null,
  props: {},
  position: null,
  created_at: '2026-10-01T00:00:00Z',
  edited_at: '2026-10-01T00:00:00Z',
  has_body: false,
})

const item = (id: string, value: string): CalItem => ({ row: row(id), span: dateSpan(value)! })
const brief = (p: Placed) => [p.row.id, p.colStart, p.colEnd, p.lane, p.clippedLeft, p.clippedRight]

describe('月历网格', () => {
  test('周一开头的 42 格；范围是第一格到最后一格（取数用，合法的 range）', () => {
    const grid = monthGrid('2026-11') // 11-01 是周日
    expect(grid.days).toHaveLength(42)
    expect(grid.from).toBe('2026-10-26')
    expect(grid.days[6]).toBe('2026-11-01')
    expect(grid.to).toBe('2026-12-06')
    expect(grid.range).toBe('2026-10-26..2026-12-06')
    expect(parseRange(grid.range)).toEqual({ from: grid.from, to: grid.to })
    // 1 号就是周一：第一格就是 1 号
    expect(monthGrid('2026-06').from).toBe('2026-06-01')
    expect(monthGrid('2024-02').days).toContain('2024-02-29')
  })

  test('翻月跨年；月份写法校验', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-05', -17)).toBe('2024-12')
    expect(isMonth('2026-11')).toBe(true)
    for (const bad of ['2026-13', '2026-00', '2026-1', '0000-01', 202611, null]) expect(isMonth(bad)).toBe(false)
  })
})

describe('按周分车道', () => {
  const grid = monthGrid('2026-11') // 第 0 周 10-26..11-01，第 1 周 11-02..11-08
  test('区间跨周在换行处断开、下一周从行首续画；单日落在对应列', () => {
    const weeks = layoutWeeks([item('a', '2026-10-31/2026-11-03'), item('b', '2026-11-04')], grid)
    expect(weeks[0]!.map(brief)).toEqual([['a', 5, 6, 0, false, true]])
    expect(weeks[1]!.map(brief)).toEqual([
      ['a', 0, 1, 0, true, false],
      ['b', 2, 2, 0, false, false],
    ])
    expect(weeks.slice(2).every((w) => w.length === 0)).toBe(true)
  })

  test('开始早的、跨度长的先放；放进第一条空着的车道；同样的按传入顺序', () => {
    const weeks = layoutWeeks(
      [item('short', '2026-11-03'), item('long', '2026-11-03/2026-11-06'), item('early', '2026-11-02'), item('tie', '2026-11-03'), item('later', '2026-11-05')],
      grid,
    )
    expect(weeks[1]!.map(brief)).toEqual([
      ['early', 0, 0, 0, false, false],
      ['long', 1, 4, 0, false, false],
      ['short', 1, 1, 1, false, false],
      ['tie', 1, 1, 2, false, false],
      ['later', 3, 3, 1, false, false],
    ])
  })

  test('整段包住一屏的区间：每周都从行首画到行尾，两头都断开；网格外的不画', () => {
    const weeks = layoutWeeks([item('all', '2026-01-01/2027-01-01'), item('out', '2026-12-07')], grid)
    for (const week of weeks) expect(week.map(brief)).toEqual([['all', 0, 6, 0, true, true]])
  })
})

describe('「+N」', () => {
  const grid = monthGrid('2026-11')
  test('放得下全画；放不下时前 capacity - 1 条车道总显示，最后一条只在覆盖的每天都放得下时显示；显示的 + 收起的 = 当天全部', () => {
    const items = [
      item('a', '2026-11-02/2026-11-04'),
      item('b', '2026-11-02'),
      item('c', '2026-11-02'),
      item('d', '2026-11-03/2026-11-05'),
      item('e', '2026-11-06'),
    ]
    const week = layoutWeeks(items, grid)[1]!
    const roomy = fitWeek(week, 4)
    expect(roomy.shown).toHaveLength(5)
    expect(roomy.more).toEqual([0, 0, 0, 0, 0, 0, 0])
    const tight = fitWeek(week, 2)
    const shown = tight.shown.map((p) => p.row.id)
    // 车道：a 0，b 1，c 2，d 1（02 那天之后车道 1 空出来了），e 0。02 那天有三条放不下：车道 1 的 b 收起；
    // d 也在车道 1，但它覆盖的 03–05 都放得下，照常画
    expect(shown).toEqual(['a', 'd', 'e'])
    expect(tight.more).toEqual([2, 0, 0, 0, 0, 0, 0])
    for (let col = 0; col < 7; col++) {
      const day = grid.days[7 + col]!
      const visible = tight.shown.filter((p) => p.colStart <= col && col <= p.colEnd).length
      expect(visible + tight.more[col]!, day).toBe(itemsOn(items, day).length)
    }
  })

  test('一格放几条：至少一条', () => {
    expect(fitLanes(28 + 22 * 4)).toBe(4)
    expect(fitLanes(28 + 22 * 4 - 1)).toBe(3)
    expect(fitLanes(0)).toBe(1)
  })

  test('当天全部条目按车道的放法排', () => {
    const items = [item('b', '2026-11-03'), item('a', '2026-11-01/2026-11-05'), item('c', '2026-11-04')]
    expect(itemsOn(items, '2026-11-03').map((i) => i.row.id)).toEqual(['a', 'b'])
    expect(itemsOn(items, '2026-11-06')).toEqual([])
  })
})

describe('拖动换天', () => {
  test('区间整体平移、长度不变；单日只挪那一天；跨月跨年；认不出的值 = null', () => {
    expect(shiftSpan('2026-11-03', 2)).toBe('2026-11-05')
    expect(shiftSpan('2026-11-03/2026-11-05', -3)).toBe('2026-10-31/2026-11-02')
    expect(shiftSpan('2026-12-30/2027-01-02', 3)).toBe('2027-01-02/2027-01-05')
    expect(shiftSpan('2026-11-03', 0)).toBe('2026-11-03')
    expect(shiftSpan('garbage', 1)).toBeNull()
    expect(shiftSpan(undefined, 1)).toBeNull()
  })
})
