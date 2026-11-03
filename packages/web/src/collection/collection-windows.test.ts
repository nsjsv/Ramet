import { describe, expect, test } from 'vitest'
import { parseCollection, type CollectionRow } from '@ramet/shared/collection-model'
import { WINDOW_LIMIT, WINDOW_LIMIT_MAX, type RowsWindow } from '@ramet/shared/collection-query'
import type { WindowState } from './collection-store'
import { cleanScope, coldWins, computedSig, fitsScope, newWin, pageLimit, querySig, RANGE_ROWS_CAP, rowsSearch, scopeKey, viewUsesTitle, warmWin } from './collection-windows'
import { rangeRowsOf, wantsMore } from './range-rows'

/* 窗口的范围（collection-windows.ts）：不限 / 按组 / 按日期范围各是各的窗口，键不撞；范围判定只问 shared 的 matchScope；
 * 冷缓存留下范围，再开时同一个键打底。按日期范围取全（range-rows.ts）：没取完、不在取、没失败、没到上限才续取 */

const schema = parseCollection({
  props: {
    sts: { name: '状态', type: 'status', pos: 0, options: { st: { name: '未开始', group: 'todo', pos: 0 }, sd: { name: '已完成', group: 'done', pos: 1 } } },
    dat: { name: '日期', type: 'date', pos: 1 },
    txt: { name: '备注', type: 'text', pos: 2 },
  },
  views: {
    cal: { layout: 'calendar', dateBy: 'dat', filter: { all: [{ prop: 'txt', op: 'empty' }] } },
    brd: { layout: 'board', groupBy: 'sts' },
  },
})

const row = (id: string, props: Record<string, unknown>): CollectionRow => ({
  id,
  title: id,
  icon: null,
  props,
  position: null,
  created_at: '2026-10-01T00:00:00Z',
  edited_at: '2026-10-01T00:00:00Z',
  has_body: false,
})

const state = (window: RowsWindow | null, patch: Partial<WindowState> = {}): WindowState => ({ window, loading: false, loadingMore: false, error: null, ...patch })

describe('窗口的范围', () => {
  test('键：不限、按组（含无值组 ""）、按日期范围、none 各不相同；缺省与空对象同一个', () => {
    const keys = [
      scopeKey('v'),
      scopeKey('v', { group: '' }),
      scopeKey('v', { group: 'st' }),
      scopeKey('v', { range: '2026-10-01..2026-10-31' }),
      scopeKey('v', { range: 'none' }),
      scopeKey('v', { group: 'st', range: 'none' }),
      scopeKey('w'),
    ]
    expect(new Set(keys).size).toBe(keys.length)
    expect(scopeKey('v', {})).toBe(scopeKey('v'))
    expect(scopeKey('v', { group: undefined })).toBe(scopeKey('v'))
  })

  test('cleanScope 只留有值的键；newWin 存规整后的范围', () => {
    expect(cleanScope({ group: undefined, range: 'none' })).toEqual({ range: 'none' })
    expect(cleanScope({ group: '' })).toEqual({ group: '' })
    expect(cleanScope()).toEqual({})
    expect(newWin('v', { group: undefined }).scope).toEqual({})
  })

  test('fitsScope：筛选 ∧ 组 ∧ 日期范围（同 shared 的 matchScope）', () => {
    const range = '2026-10-05..2026-10-11'
    expect(fitsScope(row('a', { dat: '2026-10-06' }), schema, 'cal', { range }, {})).toBe(true)
    expect(fitsScope(row('a', { dat: '2026-10-12' }), schema, 'cal', { range }, {})).toBe(false)
    expect(fitsScope(row('a', { dat: '2026-10-06', txt: '有字' }), schema, 'cal', { range }, {})).toBe(false)
    expect(fitsScope(row('a', {}), schema, 'cal', { range: 'none' }, {})).toBe(true)
    expect(fitsScope(row('a', { sts: 'sd' }), schema, 'brd', { group: 'sd' }, {})).toBe(true)
    expect(fitsScope(row('a', { sts: 'sd' }), schema, 'brd', { group: 'st' }, {})).toBe(false)
  })

  test('一页：按日期范围取的窗口按上限取，其余按缺省', () => {
    expect(pageLimit({ range: 'none' })).toBe(WINDOW_LIMIT_MAX)
    expect(pageLimit({ group: 'st' })).toBe(WINDOW_LIMIT)
    expect(pageLimit({})).toBe(WINDOW_LIMIT)
  })

  test('查询串：组（含无值组 ""）、日期范围、游标都带上，没有的不出现', () => {
    const q = (extra: Partial<Parameters<typeof rowsSearch>[0]> = {}) =>
      Object.fromEntries(new URLSearchParams(rowsSearch({ view: 'cal', limit: 100, tz: 480, ...extra })))
    expect(q()).toEqual({ view: 'cal', limit: '100', tz: '480' })
    expect(q({ range: '2026-10-01..2026-10-31', cursor: '3:abc' })).toEqual({ view: 'cal', limit: '100', tz: '480', range: '2026-10-01..2026-10-31', cursor: '3:abc' })
    expect(q({ range: 'none', cursor: null })).toEqual({ view: 'cal', limit: '100', tz: '480', range: 'none' })
    expect(q({ group: '' })).toEqual({ view: 'cal', limit: '100', tz: '480', group: '' })
  })

  test('查询签名含日期属性：换了日期属性要重取', () => {
    const other = parseCollection({
      props: { dat: { type: 'date', pos: 1 }, cre: { type: 'created_time', pos: 2 } },
      views: { cal: { layout: 'calendar', dateBy: 'dat' } },
    })
    const moved = parseCollection({
      props: { dat: { type: 'date', pos: 1 }, cre: { type: 'created_time', pos: 2 } },
      views: { cal: { layout: 'calendar', dateBy: 'cre' } },
    })
    expect(querySig(other, 'cal')).not.toBe(querySig(moved, 'cal'))
  })

  test('公式：改表达式、引用的属性改了选项都换签名（已算好的公式值旧了要重取）；只改名字不换；没有公式时签名不变', () => {
    const props = (expr: string, option = '高', name = '优先级') => ({
      sel: { name, type: 'select', pos: 0, options: { hi: { name: option, pos: 0 } } },
      txt: { name: '备注', type: 'text', pos: 1 },
      fx1: { name: '公式', type: 'formula', pos: 2, cfg: { expr } },
    })
    const sig = (p: Record<string, unknown>) => computedSig(parseCollection({ props: p }))
    const base = sig(props('[@sel] & "!"'))
    expect(sig(props('[@sel] & "?"'))).not.toBe(base)
    expect(sig(props('[@sel] & "!"', '低'))).not.toBe(base)
    expect(sig(props('[@sel] & "!"', '高', '改了名'))).toBe(base)
    expect(sig({ txt: { name: '备注', type: 'text', pos: 1 } })).toBe('[]')
  })

  test('按引用了「名称」的公式筛选 / 排序：窗口外的行改名也要重取', () => {
    const s = parseCollection({
      props: {
        txt: { name: '备注', type: 'text', pos: 0 },
        fx1: { name: '大写名', type: 'formula', pos: 1, cfg: { expr: 'UPPER([@title])' } },
        fx2: { name: '再包一层', type: 'formula', pos: 2, cfg: { expr: '[@fx1] & "!"' } },
        fx3: { name: '不看名', type: 'formula', pos: 3, cfg: { expr: '[@txt] & "!"' } },
      },
      views: { a: { sorts: [{ prop: 'fx2', dir: 'asc' }] }, b: { filter: { all: [{ prop: 'fx3', op: 'empty' }] } }, c: { sorts: [{ prop: 'title', dir: 'asc' }] } },
    })
    expect(['a', 'b', 'c'].map((v) => viewUsesTitle(s, v))).toEqual([true, false, true])
  })

  test('冷缓存往返：只留取到过内容的窗口，范围原样带回，打底的窗口记 stale、不在取', () => {
    const win: RowsWindow = { rows: [row('a', { dat: '2026-10-06' })], next: null, total: 1, range: '2026-10-05..2026-10-11' }
    const a = newWin('cal', { range: '2026-10-05..2026-10-11' }, state(win, { loading: true }))
    const b = newWin('brd', { group: 'st' })
    const cold = coldWins([a, b])
    expect(cold).toEqual([{ viewId: 'cal', scope: { range: '2026-10-05..2026-10-11' }, state: a.state }])
    const warm = warmWin(cold[0]!)
    expect(scopeKey(warm.viewId, warm.scope)).toBe(scopeKey('cal', { range: '2026-10-05..2026-10-11' }))
    expect(warm).toMatchObject({ stale: true, refs: 0, fetching: false, sig: null })
    expect(warm.state).toEqual({ window: win, loading: false, loadingMore: false, error: null })
  })
})

describe('按日期范围取全', () => {
  const rows = (n: number): CollectionRow[] => Array.from({ length: n }, (_, i) => row(`r${i}`, {}))

  test('wantsMore：没取完、不在取、没失败、没到上限才续取', () => {
    expect(wantsMore(state({ rows: rows(100), next: 'c', total: 300 }))).toBe(true)
    expect(wantsMore(state({ rows: rows(100), next: null, total: 100 }))).toBe(false)
    expect(wantsMore(state({ rows: rows(100), next: 'c', total: 300 }, { loadingMore: true }))).toBe(false)
    expect(wantsMore(state({ rows: rows(100), next: 'c', total: 300 }, { loading: true }))).toBe(false)
    expect(wantsMore(state({ rows: rows(100), next: 'c', total: 300 }, { error: '断了' }))).toBe(false)
    expect(wantsMore(state({ rows: rows(RANGE_ROWS_CAP), next: 'c', total: 5000 }))).toBe(false)
    expect(wantsMore(state(null, { loading: true }))).toBe(false)
  })

  test('rangeRowsOf：各范围的行、首屏没到算加载中、到上限还没取完算超限、取第一个错误', () => {
    const out = rangeRowsOf([
      state({ rows: rows(2), next: null, total: 2 }),
      state({ rows: rows(RANGE_ROWS_CAP), next: 'c', total: 4000 }),
    ])
    expect(out.lists.map((l) => l.length)).toEqual([2, RANGE_ROWS_CAP])
    expect(out).toMatchObject({ loading: false, capped: true, error: null })
    expect(rangeRowsOf([state(null, { loading: true }), state(null, { error: '没权限' })])).toMatchObject({ loading: true, capped: false, error: '没权限' })
  })
})
