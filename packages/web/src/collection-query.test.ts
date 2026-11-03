import { describe, expect, test } from 'vitest'
import { parseCollection, type CollectionRow, type CollectionView, type Filter, type RowsDelta } from '@ramet/shared/collection-model'
import {
  applyRowsDelta,
  clampLimit,
  compareRows,
  groupKey,
  groupOrder,
  joinRange,
  matchFilter,
  matchScope,
  parseRange,
  queryWindow,
  RANGE_DAYS_MAX,
  rowSpan,
  sortRows,
  WINDOW_LIMIT,
  WINDOW_LIMIT_MAX,
  type QueryCtx,
  type RowsWindow,
  type WindowOpts,
} from '@ramet/shared/collection-query'

/* 不变量（@ramet/shared/collection-query 文件头）：顺序是确定的全序（[组序] → 多级排序 → position NULLS LAST, created_at, id），
 * 空值恒排最后；窗口 = 排好序的命中行的前缀，游标 = 末行序号 + id；客户端按增量维护窗口后仍是服务端列表的前缀，
 * 总数与分组计数与服务端现算的一致，拿客户端的游标接着翻页不重不漏。 */

const PROPS = {
  txt: { name: '备注', type: 'text', pos: 0 },
  num: { name: '工时', type: 'number', pos: 1 },
  sel: { name: '优先级', type: 'select', pos: 2, options: { hi: { name: '高', pos: 0 }, lo: { name: '低', pos: 1 } } },
  mul: { name: '标签', type: 'multi_select', pos: 3, options: { ta: { name: 'A', pos: 0 }, tb: { name: 'B', pos: 1 } } },
  sts: {
    name: '状态',
    type: 'status',
    pos: 4,
    options: {
      sd: { name: '已完成', group: 'done', pos: 0 },
      sg: { name: '进行中', group: 'doing', pos: 0 },
      st: { name: '未开始', group: 'todo', pos: 0 },
    },
  },
  dat: { name: '截止', type: 'date', pos: 5 },
  chk: { name: '完成', type: 'checkbox', pos: 6 },
  url: { name: '链接', type: 'url', pos: 7 },
  who: { name: '负责人', type: 'person', pos: 8 },
  cre: { name: '创建时间', type: 'created_time', pos: 9 },
  edi: { name: '编辑时间', type: 'edited_time', pos: 10 },
  eml: { name: '邮箱', type: 'email', pos: 11 },
  fil: { name: '附件', type: 'files', pos: 12 },
  cby: { name: '创建者', type: 'created_by', pos: 13 },
  eby: { name: '最后编辑者', type: 'edited_by', pos: 14 },
  uid: { name: '编号', type: 'unique_id', pos: 15 },
}
const schema = parseCollection({ props: PROPS })

function viewOf(settings: Record<string, unknown> = {}): CollectionView {
  return parseCollection({ props: PROPS, views: { v1: settings } }).views[0]!
}

const stamp = (sec: number): string => new Date(Date.UTC(2026, 9, 1) + sec * 1000).toISOString()

function row(id: string, props: Record<string, unknown> = {}, extra: Partial<CollectionRow> = {}): CollectionRow {
  return { id, title: id, icon: null, props, position: null, created_at: stamp(0), edited_at: stamp(0), has_body: false, ...extra }
}

function matching(rows: CollectionRow[], filter: Filter, ctx: QueryCtx = {}): string[] {
  return rows.filter((r) => matchFilter(r, filter, schema, ctx)).map((r) => r.id)
}

const ids = (rows: CollectionRow[]): string[] => rows.map((r) => r.id)
const where = (prop: string, op: string, value?: unknown): Filter => viewOf({ filter: { all: [{ prop, op, value }] } }).filter

describe('matchFilter：每种类型的运算', () => {
  const rows = [
    row('a', { txt: 'Hello World', num: 3, sel: 'hi', mul: ['ta'], sts: 'st', dat: '2026-10-01', chk: true, url: 'https://ramet.dev', who: ['u1'] }),
    row('b', { txt: 'hello', num: 10, sel: 'lo', mul: ['ta', 'tb'], sts: 'sg', dat: '2026-10-25', who: ['u2'] }),
    row('c', { sts: 'sd', sel: 'gone', mul: ['gone'], chk: false }, { title: '' }),
  ]

  test('文本 / 链接 / 名称：包含与等于不分大小写，空与非空', () => {
    expect(matching(rows, where('txt', 'contains', 'WORLD'))).toEqual(['a'])
    expect(matching(rows, where('txt', 'eq', 'HELLO'))).toEqual(['b'])
    expect(matching(rows, where('txt', 'empty'))).toEqual(['c'])
    expect(matching(rows, where('txt', 'not_empty'))).toEqual(['a', 'b'])
    expect(matching(rows, where('url', 'contains', 'ramet'))).toEqual(['a'])
    expect(matching(rows, where('title', 'eq', 'B'))).toEqual(['b'])
    expect(matching(rows, where('title', 'empty'))).toEqual(['c'])
  })

  test('数字：比较运算不含空值，≠ 含空值', () => {
    expect(matching(rows, where('num', 'eq', 3))).toEqual(['a'])
    expect(matching(rows, where('num', 'neq', 3))).toEqual(['b', 'c'])
    expect(matching(rows, where('num', 'gt', 3))).toEqual(['b'])
    expect(matching(rows, where('num', 'gte', 3))).toEqual(['a', 'b'])
    expect(matching(rows, where('num', 'lt', 10))).toEqual(['a'])
    expect(matching(rows, where('num', 'lte', 10))).toEqual(['a', 'b'])
    expect(matching(rows, where('num', 'empty'))).toEqual(['c'])
  })

  test('单选 / 状态：是、不是（含空）、为空（选项已删也算空）、属于组', () => {
    expect(matching(rows, where('sel', 'is', 'hi'))).toEqual(['a'])
    expect(matching(rows, where('sel', 'is_not', 'hi'))).toEqual(['b', 'c'])
    expect(matching(rows, where('sel', 'empty'))).toEqual(['c'])
    expect(matching(rows, where('sts', 'in_group', 'doing'))).toEqual(['b'])
    expect(matching(rows, where('sts', 'in_group', 'done'))).toEqual(['c'])
    expect(matching(rows, where('sts', 'is', 'st'))).toEqual(['a'])
  })

  test('多选 / 人员：包含、不包含（含空）、为空', () => {
    expect(matching(rows, where('mul', 'contains', 'tb'))).toEqual(['b'])
    expect(matching(rows, where('mul', 'not_contains', 'tb'))).toEqual(['a', 'c'])
    expect(matching(rows, where('mul', 'empty'))).toEqual(['c'])
    expect(matching(rows, where('who', 'contains', 'u2'))).toEqual(['b'])
    expect(matching(rows, where('who', 'empty'))).toEqual(['c'])
  })

  test('日期：等于、之前、之后、为空；复选框：没勾就是否', () => {
    expect(matching(rows, where('dat', 'eq', '2026-10-25'))).toEqual(['b'])
    expect(matching(rows, where('dat', 'before', '2026-10-25'))).toEqual(['a'])
    expect(matching(rows, where('dat', 'after', '2026-10-01'))).toEqual(['b'])
    expect(matching(rows, where('dat', 'empty'))).toEqual(['c'])
    expect(matching(rows, where('chk', 'checked'))).toEqual(['a'])
    expect(matching(rows, where('chk', 'unchecked'))).toEqual(['b', 'c'])
  })

  test('创建 / 编辑时间按 ctx.tzOffset 折成那一天再比', () => {
    const late = [row('x', {}, { created_at: '2026-10-24 20:30:00.5+00', edited_at: '2026-10-24T15:00:00Z' })]
    expect(matching(late, where('cre', 'eq', '2026-10-25'), { tzOffset: 480 })).toEqual(['x'])
    expect(matching(late, where('cre', 'eq', '2026-10-25'))).toEqual([])
    expect(matching(late, where('cre', 'before', '2026-10-25'))).toEqual(['x'])
    expect(matching(late, where('edi', 'after', '2026-10-23'), { tzOffset: -600 })).toEqual(['x'])
    expect(matching(late, where('edi', 'empty'))).toEqual([])
  })

  test('多个条件同时满足；没填完的条件、引用已删属性的条件不参与', () => {
    const both: Filter = { all: [...where('txt', 'contains', 'hello').all, ...where('num', 'gt', 5).all] }
    expect(matching(rows, both)).toEqual(['b'])
    expect(matching(rows, where('num', 'gt'))).toEqual(['a', 'b', 'c'])
    expect(matching(rows, { all: [{ prop: 'gone', op: 'empty' }] })).toEqual(['a', 'b', 'c'])
    // 手写的 Filter 不经 parseCollection 也按同一口径：运算不适用于类型就不参与
    expect(matching(rows, { all: [{ prop: 'num', op: 'contains', value: 'x' }] })).toEqual(['a', 'b', 'c'])
  })
})

describe('compareRows：确定的全序', () => {
  const sorted = (rows: CollectionRow[], sorts: { prop: string; dir: 'asc' | 'desc' }[], ctx: QueryCtx = {}): string[] =>
    ids(rows.slice().sort((a, b) => compareRows(a, b, sorts, schema, ctx)))

  test('数字升降序，空值不论方向都排最后', () => {
    const rows = [row('a', { num: 2 }), row('b'), row('c', { num: -1 }), row('d', { num: 10 })]
    expect(sorted(rows, [{ prop: 'num', dir: 'asc' }])).toEqual(['c', 'a', 'd', 'b'])
    expect(sorted(rows, [{ prop: 'num', dir: 'desc' }])).toEqual(['d', 'a', 'c', 'b'])
  })

  test('文本按 Collator（数字按数值、中文按拼音且在拉丁字母之前），排序相同再按码点', () => {
    const rows = ['a10', 'a9', '张三', '阿', '李四', '1', '01'].map((t) => row(t, { txt: t }))
    expect(sorted(rows, [{ prop: 'txt', dir: 'asc' }])).toEqual(['01', '1', '阿', '李四', '张三', 'a9', 'a10'])
  })

  test('选项按定义里的顺序，不按名字；状态先按组，空值按缺省选项（第一个）排', () => {
    expect(sorted([row('a', { sel: 'lo' }), row('b', { sel: 'hi' })], [{ prop: 'sel', dir: 'asc' }])).toEqual(['b', 'a'])
    const rows = [row('a', { sts: 'sd' }), row('b', { sts: 'st' }), row('c', { sts: 'sg' }), row('d')]
    expect(sorted(rows, [{ prop: 'sts', dir: 'asc' }])).toEqual(['b', 'd', 'c', 'a'])
    expect(sorted(rows, [{ prop: 'sts', dir: 'desc' }])).toEqual(['a', 'c', 'b', 'd'])
  })

  test('多级排序：第一级相同再比第二级', () => {
    const rows = [row('a', { sts: 'st', num: 1 }), row('b', { sts: 'sg', num: 5 }), row('c', { sts: 'st', num: 7 })]
    expect(sorted(rows, [{ prop: 'sts', dir: 'asc' }, { prop: 'num', dir: 'desc' }])).toEqual(['c', 'a', 'b'])
  })

  test('没有排序时按手动顺序：position（NULL 在后）→ created_at → id', () => {
    const rows = [
      row('a', {}, { position: 2 }),
      row('b', {}, { position: null, created_at: stamp(5) }),
      row('c', {}, { position: 1 }),
      row('e', {}, { position: null, created_at: stamp(1) }),
      row('d', {}, { position: null, created_at: stamp(1) }),
    ]
    expect(sorted(rows, [])).toEqual(['c', 'a', 'd', 'e', 'b'])
  })

  test('人员按 ctx.nameOf 的名字，没给就按 id；复选框未勾在前；日期 / 时间按先后', () => {
    const people = [row('a', { who: ['u2'] }), row('b', { who: ['u1'] })]
    expect(sorted(people, [{ prop: 'who', dir: 'asc' }])).toEqual(['b', 'a'])
    expect(sorted(people, [{ prop: 'who', dir: 'asc' }], { nameOf: (id) => (id === 'u1' ? '张' : '阿') })).toEqual(['a', 'b'])
    expect(sorted([row('a', { chk: true }), row('b')], [{ prop: 'chk', dir: 'asc' }])).toEqual(['b', 'a'])
    expect(sorted([row('a', { dat: '2026-10-02' }), row('b', { dat: '2025-12-31' })], [{ prop: 'dat', dir: 'asc' }])).toEqual(['b', 'a'])
    const times = [row('a', {}, { edited_at: stamp(9) }), row('b', {}, { edited_at: '2026-10-01 00:00:10+00' })]
    expect(sorted(times, [{ prop: 'edi', dir: 'desc' }])).toEqual(['b', 'a'])
  })

  test('不同的行永不相等', () => {
    expect(compareRows(row('a'), row('b'), [], schema)).toBeLessThan(0)
    expect(compareRows(row('b'), row('a'), [], schema)).toBeGreaterThan(0)
    expect(compareRows(row('a'), row('a'), [], schema)).toBe(0)
  })
})

describe('分组', () => {
  test('groupKey：选项 id，空值与已删选项是 ""（状态读成缺省选项）；groupOrder：无值组在前、状态按组且没有无值组', () => {
    expect(groupKey(row('a', { sts: 'sg' }), 'sts', schema)).toBe('sg')
    expect(groupKey(row('a', { sts: 'gone' }), 'sts', schema)).toBe('st')
    expect(groupKey(row('a'), 'sts', schema)).toBe('st')
    expect(groupKey(row('a'), 'sel', schema)).toBe('')
    expect(groupOrder(schema, 'sts')).toEqual(['st', 'sg', 'sd'])
    expect(groupOrder(schema, 'sel')).toEqual(['', 'hi', 'lo'])
    expect(groupOrder(schema, 'txt')).toEqual([])
    expect(groupOrder(schema, null)).toEqual([])
  })
})

describe('queryWindow', () => {
  const rows = [
    row('a', { sts: 'sd', num: 1 }),
    row('b', { sts: 'st', num: 2 }),
    row('c', { num: 3 }),
    row('d', { sts: 'st', num: 4 }),
    row('e', { sts: 'sd', num: 5, txt: '藏起来' }),
  ]

  test('筛选后计总数；有分组时给每个组的计数（含 0；状态空值算缺省选项），同组的行连在一起按组序排', () => {
    const view = viewOf({ groupBy: 'sts', sorts: [{ prop: 'num', dir: 'desc' }], filter: { all: [{ prop: 'txt', op: 'empty' }] } })
    const win = queryWindow(rows, view, schema)
    expect(ids(win.rows)).toEqual(['d', 'c', 'b', 'a'])
    expect(win.total).toBe(4)
    expect(win.groups).toEqual({ st: 3, sg: 0, sd: 1 })
    expect(win.next).toBeNull()
    expect(win.group).toBeUndefined()
  })

  test('按组取（看板的一列）：只有这一组，total 是组内数，groups 仍是全部组', () => {
    const view = viewOf({ groupBy: 'sts', sorts: [{ prop: 'num', dir: 'desc' }] })
    const win = queryWindow(rows, view, schema, { group: 'st' })
    expect(ids(win.rows)).toEqual(['d', 'c', 'b'])
    expect(win.total).toBe(3)
    expect(win.group).toBe('st')
    expect(win.groups).toEqual({ st: 3, sg: 0, sd: 2 })
    expect(ids(queryWindow(rows, view, schema, { group: '' }).rows)).toEqual([])
    // 视图没分组时 group 参数不生效
    expect(queryWindow(rows, viewOf(), schema, { group: 'st' }).total).toBe(5)
  })

  test('limit 缺省 50、上限 100、至少 1，查询串里的字符串也收', () => {
    expect(clampLimit(undefined)).toBe(WINDOW_LIMIT)
    expect(clampLimit('abc')).toBe(WINDOW_LIMIT)
    expect(clampLimit('')).toBe(WINDOW_LIMIT)
    expect(clampLimit(1000)).toBe(WINDOW_LIMIT_MAX)
    expect(clampLimit('20')).toBe(20)
    expect(clampLimit(0)).toBe(1)
    expect(clampLimit(7.9)).toBe(7)
  })

  test('游标翻页不重不漏；坏游标、过期游标（序号上已不是那一行）从头取', () => {
    const many = Array.from({ length: 23 }, (_, i) => row(`r${String(i).padStart(2, '0')}`, { num: i % 5 }))
    const view = viewOf({ sorts: [{ prop: 'num', dir: 'asc' }] })
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const win: RowsWindow = queryWindow(many, view, schema, { cursor, limit: 5 })
      seen.push(...ids(win.rows))
      cursor = win.next
      if (!cursor) break
    }
    expect(seen).toEqual(ids(queryWindow(many, view, schema, { limit: 100 }).rows))
    expect(new Set(seen).size).toBe(23)
    const first = queryWindow(many, view, schema, { limit: 5 })
    for (const bad of ['garbage', ':x', '-1:r00', '4:not-that-row', '99:r00']) {
      expect(ids(queryWindow(many, view, schema, { cursor: bad, limit: 5 }).rows)).toEqual(ids(first.rows))
    }
  })

  test('5000 行的集合：首屏不超过 100 行，按窗口翻页能取完', () => {
    const big = Array.from({ length: 5000 }, (_, i) => row(`r${i}`, { num: (i * 7919) % 1000, sts: i % 3 ? 'st' : 'sd' }))
    const view = viewOf({ sorts: [{ prop: 'num', dir: 'desc' }], filter: { all: [{ prop: 'sts', op: 'is', value: 'st' }] } })
    const first = queryWindow(big, view, schema, { limit: 1000 })
    expect(first.rows).toHaveLength(100)
    expect(first.total).toBe(3333)
    let count = first.rows.length
    let cursor = first.next
    while (cursor) {
      const win: RowsWindow = queryWindow(big, view, schema, { cursor, limit: 100 })
      count += win.rows.length
      cursor = win.next
    }
    expect(count).toBe(3333)
  })
})

/* ---------- 增量 ---------- */

const delta = (up: RowsDelta['up'], rm: RowsDelta['rm'] = []): RowsDelta => ({ t: 'collection.rows', up, rm })

describe('applyRowsDelta', () => {
  const view = viewOf({ sorts: [{ prop: 'num', dir: 'asc' }], filter: { all: [{ prop: 'sts', op: 'is_not', value: 'sd' }] } })
  const base = Array.from({ length: 8 }, (_, i) => row(`r${i}`, { num: i * 10, sts: 'st' }))

  test('窗口里的行改值：按新值重排，计数不变；不改入参', () => {
    const win = queryWindow(base, view, schema, { limit: 4 })
    const moved = row('r3', { num: 5, sts: 'st' })
    const next = applyRowsDelta(win, delta([{ row: moved, prev: { num: 30 } }]), view, schema)
    expect(ids(next.rows)).toEqual(['r0', 'r3', 'r1', 'r2'])
    expect(next.total).toBe(8)
    expect(ids(win.rows)).toEqual(['r0', 'r1', 'r2', 'r3'])
  })

  test('不再命中筛选：摘掉、总数减一；排到已加载末行之后：摘掉、总数不变，游标接着能取到它', () => {
    const win = queryWindow(base, view, schema, { limit: 4 })
    const done = applyRowsDelta(win, delta([{ row: row('r1', { num: 10, sts: 'sd' }), prev: { sts: 'st' } }]), view, schema)
    expect(ids(done.rows)).toEqual(['r0', 'r2', 'r3'])
    expect(done.total).toBe(7)

    const server = base.map((r) => (r.id === 'r1' ? row('r1', { num: 65, sts: 'st' }) : r))
    const later = applyRowsDelta(win, delta([{ row: server[1]!, prev: { num: 10 } }]), view, schema)
    expect(ids(later.rows)).toEqual(['r0', 'r2', 'r3'])
    expect(later.total).toBe(8)
    expect(ids(queryWindow(server, view, schema, { cursor: later.next, limit: 10 }).rows)).toEqual(['r4', 'r5', 'r6', 'r1', 'r7'])
  })

  test('不在窗口里的行：排在末行之前就插入，之后的只加总数；已到底的窗口一律插入', () => {
    const win = queryWindow(base, view, schema, { limit: 4 })
    const early = applyRowsDelta(win, delta([{ row: row('n1', { num: 15, sts: 'st' }) }]), view, schema)
    expect(ids(early.rows)).toEqual(['r0', 'r1', 'n1', 'r2', 'r3'])
    expect(early.total).toBe(9)
    const late = applyRowsDelta(win, delta([{ row: row('n2', { num: 99, sts: 'st' }) }]), view, schema)
    expect(ids(late.rows)).toEqual(['r0', 'r1', 'r2', 'r3'])
    expect(late.total).toBe(9)

    const all = queryWindow(base, view, schema, { limit: 100 })
    const tail = applyRowsDelta(all, delta([{ row: row('n2', { num: 99, sts: 'st' }) }]), view, schema)
    expect(ids(tail.rows).at(-1)).toBe('n2')
    expect(tail.next).toBeNull()
    expect(tail.total).toBe(9)
  })

  test('删除：在窗口里就摘掉；不在窗口里按 rm.row 判断要不要减计数', () => {
    const win = queryWindow(base, view, schema, { limit: 4 })
    const next = applyRowsDelta(win, delta([], [{ row: base[2]! }, { row: base[7]! }, { row: row('x', { sts: 'sd' }) }]), view, schema)
    expect(ids(next.rows)).toEqual(['r0', 'r1', 'r3'])
    expect(next.total).toBe(6)
  })

  test('看板换列：两列的窗口各套一次，各自增减，分组计数在两边一致', () => {
    const board = viewOf({ layout: 'board', groupBy: 'sts' })
    const rows = [row('a', { sts: 'st' }), row('b', { sts: 'st' }), row('c', { sts: 'sg' })]
    const todo = queryWindow(rows, board, schema, { group: 'st' })
    const doing = queryWindow(rows, board, schema, { group: 'sg' })
    const change = delta([{ row: row('a', { sts: 'sg' }), prev: { sts: 'st' } }])
    const todo2 = applyRowsDelta(todo, change, board, schema)
    const doing2 = applyRowsDelta(doing, change, board, schema)
    expect(ids(todo2.rows)).toEqual(['b'])
    expect(ids(doing2.rows)).toEqual(['a', 'c'])
    expect([todo2.total, doing2.total]).toEqual([1, 2])
    expect(todo2.groups).toEqual({ st: 1, sg: 2, sd: 0 })
    expect(doing2.groups).toEqual(todo2.groups)
  })

  test('不在窗口里的行靠 prev 还原旧值（含旧标题），计数精确', () => {
    const titled = viewOf({ filter: { all: [{ prop: 'title', op: 'contains', value: '急' }] } })
    const rows = [row('a', {}, { title: '急事' }), row('b', {}, { title: '急件' }), row('c', {}, { title: '慢' })]
    const win = queryWindow(rows, titled, schema, { limit: 1 })
    expect(win.total).toBe(2)
    const renamed = applyRowsDelta(win, delta([{ row: row('b', {}, { title: '不急了' }), prev: { title: '急件' } }]), titled, schema)
    expect(renamed.total).toBe(2)
    const calm = applyRowsDelta(win, delta([{ row: row('b', {}, { title: '缓' }), prev: { title: '急件' } }]), titled, schema)
    expect(calm.total).toBe(1)
    expect(calm.next).toBeNull()
  })

  test('reset（手动顺序重编号）：窗口原样返回、不套任何行，由调用方重取', () => {
    const win = queryWindow(base, view, schema, { limit: 4 })
    const reset: RowsDelta = { t: 'collection.rows', up: [{ row: row('r3', { num: 1, sts: 'st' }), prev: {} }], rm: [], reset: true }
    expect(applyRowsDelta(win, reset, view, schema)).toBe(win)
  })
})

/* ---------- 按日期范围取的窗口（日历 / 时间线） ---------- */

describe('日期范围', () => {
  const cal = (settings: Record<string, unknown> = {}) => viewOf({ layout: 'calendar', dateBy: 'dat', ...settings })

  test('parseRange：两端含的 YYYY-MM-DD..YYYY-MM-DD 或 none；认不出、反序、跨度超过上限都是 null', () => {
    expect(parseRange('2026-10-01..2026-10-31')).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(parseRange('2026-10-01..2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-10-01' })
    expect(parseRange('none')).toBe('none')
    expect(joinRange('2026-10-01', '2026-10-31')).toBe('2026-10-01..2026-10-31')
    for (const bad of ['', '2026-10-01', '2026-10-01..', '2026-10-31..2026-10-01', '2026-02-30..2026-03-01', '2026-1-1..2026-1-2', ' 2026-10-01..2026-10-02', 'NONE', null, 7]) {
      expect(parseRange(bad)).toBeNull()
    }
    const from = '2026-01-01'
    const last = new Date(Date.UTC(2026, 0, RANGE_DAYS_MAX)).toISOString().slice(0, 10)
    const over = new Date(Date.UTC(2026, 0, RANGE_DAYS_MAX + 1)).toISOString().slice(0, 10)
    expect(parseRange(`${from}..${last}`)).not.toBeNull()
    expect(parseRange(`${from}..${over}`)).toBeNull()
  })

  test('与范围有交集就在里面：单日、区间（含端点相接、整段包住范围）、没有值只在 none 里', () => {
    const range = '2026-10-05..2026-10-11'
    const cases: [unknown, boolean][] = [
      ['2026-10-04', false],
      ['2026-10-05', true],
      ['2026-10-11', true],
      ['2026-10-12', false],
      ['2026-10-01/2026-10-04', false],
      ['2026-10-01/2026-10-05', true],
      ['2026-10-11/2026-10-20', true],
      ['2026-10-12/2026-10-20', false],
      ['2026-09-01/2026-12-31', true],
      ['2026-10-06/2026-10-08', true],
      ['2026-10-20/2026-10-01', true], // 写反的区间按交换后的读
      [undefined, false],
      ['not a date', false],
    ]
    for (const [dat, hit] of cases) {
      const r = row('a', dat === undefined ? {} : { dat })
      expect(matchScope(r, cal(), schema, { range }), String(dat)).toBe(hit)
      expect(matchScope(r, cal(), schema, { range: 'none' }), `none ${String(dat)}`).toBe(dat === undefined || dat === 'not a date')
    }
  })

  test('创建 / 编辑时间按 ctx.tzOffset 折成那一天再判（同筛选的口径）', () => {
    // UTC 10-04 20:00 = 东八区 10-05 04:00
    const r = row('a', {}, { created_at: '2026-10-04T20:00:00Z', edited_at: '2026-10-11T18:00:00Z' })
    const byCreated = cal({ dateBy: 'cre' })
    const byEdited = cal({ dateBy: 'edi' })
    const range = '2026-10-05..2026-10-11'
    expect(matchScope(r, byCreated, schema, { range })).toBe(false)
    expect(matchScope(r, byCreated, schema, { range }, { tzOffset: 480 })).toBe(true)
    expect(matchScope(r, byEdited, schema, { range })).toBe(true)
    expect(matchScope(r, byEdited, schema, { range }, { tzOffset: 480 })).toBe(false)
    expect(rowSpan(r, schema.props.find((p) => p.id === 'cre')!, { tzOffset: 480 })).toEqual({ start: '2026-10-05', end: '2026-10-05' })
    expect(matchScope(r, byCreated, schema, { range: 'none' })).toBe(false)
  })

  test('queryWindow：只有范围里的行，total 只数范围里的，带回 range；与筛选同时成立', () => {
    const rows = [
      row('a', { dat: '2026-10-03', num: 1 }),
      row('b', { dat: '2026-10-06/2026-10-09', num: 2 }),
      row('c', { dat: '2026-10-10', num: 3 }),
      row('d', { num: 4 }),
      row('e', { dat: '2026-09-28/2026-10-05', num: 5 }),
    ]
    const range = '2026-10-05..2026-10-11'
    const win = queryWindow(rows, cal(), schema, { range })
    expect(ids(win.rows)).toEqual(['b', 'c', 'e'])
    expect(win.total).toBe(3)
    expect(win.range).toBe(range)
    const filtered = queryWindow(rows, cal({ filter: { all: [{ prop: 'num', op: 'lt', value: 4 }] } }), schema, { range })
    expect(ids(filtered.rows)).toEqual(['b', 'c'])
    expect(ids(queryWindow(rows, cal(), schema, { range: 'none' }).rows)).toEqual(['d'])
    // 视图没有日期属性（没选 / 属性改成了别的类型）、或范围认不出：不限定，也不带回 range
    for (const [view, opts] of [
      [viewOf(), { range }],
      [cal({ dateBy: 'txt' }), { range }],
      [cal(), { range: 'garbage' }],
    ] as const) {
      const all = queryWindow(rows, view, schema, opts)
      expect(all.total).toBe(5)
      expect(all.range).toBeUndefined()
    }
    // 顺序仍是视图的排序（日历在前端自己按日期排版，窗口顺序只决定同一天里的先后）
    expect(ids(queryWindow(rows, cal({ sorts: [{ prop: 'num', dir: 'desc' }] }), schema, { range }).rows)).toEqual(['e', 'c', 'b'])
  })

  test('applyRowsDelta：行改了日期进 / 出范围，计数精确；不在窗口里的行靠 prev 判断', () => {
    const range = '2026-10-05..2026-10-11'
    const view = cal({ sorts: [{ prop: 'num', dir: 'asc' }] })
    const rows = Array.from({ length: 6 }, (_, i) => row(`r${i}`, { num: i, dat: `2026-10-${String(5 + i).padStart(2, '0')}` }))
    const win = queryWindow(rows, view, schema, { range, limit: 3 })
    expect(win.total).toBe(6)
    // 窗口里的行挪出范围：摘掉、减一
    const out = applyRowsDelta(win, delta([{ row: row('r1', { num: 1, dat: '2026-11-01' }), prev: { dat: '2026-10-06' } }]), view, schema)
    expect(ids(out.rows)).toEqual(['r0', 'r2'])
    expect(out.total).toBe(5)
    expect(out.range).toBe(range)
    // 窗口外（没加载到）的行挪出范围：靠 prev 还原旧值，减一
    const far = applyRowsDelta(win, delta([{ row: row('r5', { num: 5, dat: '2026-12-01' }), prev: { dat: '2026-10-10' } }]), view, schema)
    expect(far.total).toBe(5)
    // 范围外的行挪进来、排在已加载末行之前：插入、加一
    const into = applyRowsDelta(win, delta([{ row: row('x', { num: 0.5, dat: '2026-10-01/2026-10-05' }), prev: { dat: '2026-09-01' } }]), view, schema)
    expect(ids(into.rows)).toEqual(['r0', 'x', 'r1', 'r2'])
    expect(into.total).toBe(7)
    // 范围外的行改来改去还在范围外：不动
    const still = applyRowsDelta(win, delta([{ row: row('y', { num: 0, dat: '2026-12-02' }), prev: { dat: '2026-12-01' } }]), view, schema)
    expect(still).toEqual(win)
    // none：清掉日期的行进「未排期」
    const none = queryWindow(rows, view, schema, { range: 'none' })
    const cleared = applyRowsDelta(none, delta([{ row: row('r2', { num: 2 }), prev: { dat: '2026-10-07' } }]), view, schema)
    expect(ids(cleared.rows)).toEqual(['r2'])
    expect(cleared.total).toBe(1)
  })

  test('sortRows：几个窗口合起来按视图顺序排（与 queryWindow 同一个比较器）', () => {
    const rows = [row('a', { num: 3 }), row('b', { num: 1 }), row('c', { num: 2 }, { position: 0 })]
    const view = cal({ sorts: [{ prop: 'num', dir: 'asc' }] })
    expect(ids(sortRows(rows, view, schema))).toEqual(ids(queryWindow(rows, view, schema).rows))
    expect(ids(sortRows(rows, cal(), schema))).toEqual(['c', 'a', 'b'])
    expect(ids(rows)).toEqual(['a', 'b', 'c'])
  })
})

/* ---------- 随机模拟：服务端现算 vs 客户端套增量 ---------- */

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 服务端的完整列表：按游标一页页取完（顺带验证翻页） */
function everything(rows: CollectionRow[], view: CollectionView, opts: WindowOpts): CollectionRow[] {
  const out: CollectionRow[] = []
  let cursor: string | null = null
  for (;;) {
    const win: RowsWindow = queryWindow(rows, view, schema, { ...opts, cursor, limit: 100 })
    out.push(...win.rows)
    cursor = win.next
    if (!cursor) return out
  }
}

const FILES = [
  { id: '0b5f4a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', name: 'b.png', mime: 'image/png', size: 1 },
  { id: '1c6e5b4f-2d3e-4f60-9bac-1d2e3f4a5b6c', name: 'a.pdf', mime: 'application/pdf', size: 2 },
]
// 单日与区间混着来，比较日 10-05 落在区间内 / 端点上 / 外面的都有；有一个写反了的区间（读成交换后的）
const DATES = ['2026-10-01', '2026-10-05', '2026-10-09', '2026-10-01/2026-10-05', '2026-10-03/2026-10-08', '2026-10-06/2026-10-09', '2026-10-09/2026-10-02']

function simulate(seed: number, view: CollectionView, opts: WindowOpts = {}): void {
  const rand = rng(seed)
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!
  const titles = ['甲', '乙', '丙', 'a2', 'a10', '']
  const values = {
    sts: () => pick(['st', 'sg', 'sd']),
    num: () => Math.floor(rand() * 6),
    sel: () => pick(['hi', 'lo']),
    dat: () => pick(DATES),
    eml: () => pick(['amy@x.co', 'Bob@x.co', 'eve@y.co']),
    fil: () => (rand() < 0.5 ? [pick(FILES)] : [...FILES].reverse()),
  }
  const keys = Object.keys(values) as (keyof typeof values)[]
  let clock = 0
  let numbers = 0
  // 元数据不进 prev：创建者与编号一行定了就不变，最后编辑者随改动变（只拿来排序，按它筛选的计数本就有余量）
  const fresh = (id: string): CollectionRow => {
    const props: Record<string, unknown> = {}
    for (const key of keys) if (rand() < 0.6) props[key] = values[key]()
    clock += 1
    numbers += rand() < 0.9 ? 1 : 0
    return row(id, props, {
      title: pick(titles),
      position: rand() < 0.8 ? Math.floor(rand() * 50) : null,
      created_at: stamp(clock),
      edited_at: stamp(clock),
      created_by: pick(['u1', 'u2', null]),
      edited_by: pick(['u1', 'u2', 'u3']),
      number: rand() < 0.9 ? numbers : null,
    })
  }
  const mutate = (before: CollectionRow): { after: CollectionRow; prev: Record<string, unknown> } => {
    const props = { ...before.props }
    let title = before.title
    let position = before.position
    for (let n = 1 + Math.floor(rand() * 2); n > 0; n--) {
      const what = pick([...keys, 'title', 'position'] as const)
      if (what === 'title') title = pick(titles)
      else if (what === 'position') position = rand() < 0.2 ? null : Math.floor(rand() * 50)
      else if (rand() < 0.2) delete props[what]
      else props[what] = values[what]()
    }
    const prev: Record<string, unknown> = {}
    for (const key of new Set([...Object.keys(before.props), ...Object.keys(props)])) {
      if (JSON.stringify(before.props[key]) !== JSON.stringify(props[key])) prev[key] = Object.hasOwn(before.props, key) ? before.props[key] : null
    }
    if (title !== before.title) prev.title = before.title
    clock += 1
    return { after: { ...before, props, title, position, edited_at: stamp(clock), edited_by: pick(['u1', 'u2', 'u3']) }, prev }
  }

  const server: CollectionRow[] = Array.from({ length: 40 }, (_, i) => fresh(`r${i}`))
  let client: RowsWindow = queryWindow(server, view, schema, { ...opts, limit: 8 })
  for (let step = 0; step < 250; step++) {
    const roll = rand()
    let change: RowsDelta
    if (roll < 0.6 && server.length) {
      const i = Math.floor(rand() * server.length)
      const { after, prev } = mutate(server[i]!)
      server[i] = after
      change = delta([{ row: after, prev }])
    } else if (roll < 0.8 || !server.length) {
      const added = fresh(`n${step}`)
      server.push(added)
      change = delta([{ row: added }])
    } else {
      const [gone] = server.splice(Math.floor(rand() * server.length), 1)
      change = delta([], [{ row: gone! }])
    }
    client = applyRowsDelta(client, change, view, schema)
    if (rand() < 0.15 && client.next) {
      // 「加载更多」：拿客户端维护的游标接着取，接在后面
      const page: RowsWindow = queryWindow(server, view, schema, { ...opts, cursor: client.next, limit: 8 })
      client = { ...client, rows: [...client.rows, ...page.rows], next: page.next, total: page.total, groups: page.groups }
    }
    const full = everything(server, view, opts)
    expect(client.rows).toEqual(full.slice(0, client.rows.length))
    expect(client.total).toBe(full.length)
    expect(client.next === null).toBe(client.rows.length === full.length)
    expect(client.groups).toEqual(queryWindow(server, view, schema, opts).groups)
  }
  // 最后把剩下的一口气翻完：与服务端完整列表逐行一致
  let cursor = client.next
  const rows = [...client.rows]
  while (cursor) {
    const page: RowsWindow = queryWindow(server, view, schema, { ...opts, cursor, limit: 8 })
    rows.push(...page.rows)
    cursor = page.next
  }
  expect(ids(rows)).toEqual(ids(everything(server, view, opts)))
}

describe('applyRowsDelta：随机模拟，窗口恒为服务端列表的前缀', () => {
  test('手动顺序', () => simulate(1, viewOf()))
  test('筛选 + 多级排序', () =>
    simulate(2, viewOf({ sorts: [{ prop: 'num', dir: 'desc' }, { prop: 'title', dir: 'asc' }], filter: { all: [{ prop: 'sts', op: 'is_not', value: 'sd' }] } })))
  test('按状态分组的表格（组序在前）', () => simulate(3, viewOf({ groupBy: 'sts', sorts: [{ prop: 'sel', dir: 'asc' }] })))
  test('看板的一列（按组取）', () => simulate(4, viewOf({ layout: 'board', groupBy: 'sts' }), { group: 'sg' }))
  test('看板的无值列', () => simulate(5, viewOf({ layout: 'board', groupBy: 'sel', filter: { all: [{ prop: 'num', op: 'gte', value: 2 }] } }), { group: '' }))
  test('按编辑时间倒序', () => simulate(6, viewOf({ sorts: [{ prop: 'edi', dir: 'desc' }] })))
  test('日期区间：落在区间里的筛选 + 按日期倒序', () =>
    simulate(7, viewOf({ filter: { all: [{ prop: 'dat', op: 'eq', value: '2026-10-05' }] }, sorts: [{ prop: 'dat', dir: 'desc' }] })))
  test('日期区间：整段在之前 / 之后的筛选 + 按编号', () =>
    simulate(8, viewOf({ filter: { all: [{ prop: 'dat', op: 'before', value: '2026-10-05' }] }, sorts: [{ prop: 'uid', dir: 'asc' }] })))
  test('编号 / 创建者筛选，按最后编辑者再按编号排序', () =>
    simulate(
      9,
      viewOf({
        filter: { all: [{ prop: 'uid', op: 'gt', value: 5 }, { prop: 'cby', op: 'not_contains', value: 'u1' }] },
        sorts: [{ prop: 'eby', dir: 'asc' }, { prop: 'uid', dir: 'desc' }],
      }),
    ))
  test('文件 / 邮箱：不为空的筛选，按第一个文件名、邮箱排序', () =>
    simulate(
      10,
      viewOf({
        filter: { all: [{ prop: 'fil', op: 'not_empty' }, { prop: 'eml', op: 'contains', value: 'X.CO' }] },
        sorts: [{ prop: 'fil', dir: 'asc' }, { prop: 'eml', dir: 'desc' }],
      }),
    ))
  test('按状态分组 + 日期晚于的筛选', () =>
    simulate(11, viewOf({ groupBy: 'sts', filter: { all: [{ prop: 'dat', op: 'after', value: '2026-10-05' }] }, sorts: [{ prop: 'cby', dir: 'asc' }] })))
  test('日历的一个月（按日期范围取）', () => simulate(12, viewOf({ layout: 'calendar', dateBy: 'dat' }), { range: '2026-10-04..2026-10-06' }))
  test('时间线的一块 + 筛选 + 按日期排序', () =>
    simulate(
      13,
      viewOf({ layout: 'timeline', dateBy: 'dat', filter: { all: [{ prop: 'num', op: 'gte', value: 2 }] }, sorts: [{ prop: 'dat', dir: 'asc' }] }),
      { range: '2026-10-08..2026-10-30' },
    ))
  test('时间线的「未排期」（none）', () => simulate(14, viewOf({ layout: 'timeline', dateBy: 'dat', sorts: [{ prop: 'num', dir: 'desc' }] }), { range: 'none' }))
  test('按分组的表格 + 日期范围（分组计数仍数全部命中筛选的行）', () =>
    simulate(15, viewOf({ groupBy: 'sts', dateBy: 'dat' }), { range: '2026-10-02..2026-10-05' }))
})

describe('between（手动顺序的邻居中点，服务端定位置与客户端乐观显示同用）', () => {
  test('两侧都有取中点，单侧外扩 1，都没有为 0', async () => {
    const { between } = await import('@ramet/shared/collection-query')
    expect(between(1, 2)).toBe(1.5)
    expect(between(undefined, 3)).toBe(2)
    expect(between(3, undefined)).toBe(4)
    expect(between(undefined, undefined)).toBe(0)
  })
  test('邻居没排过、次序反了、精度用尽 = null', async () => {
    const { between } = await import('@ramet/shared/collection-query')
    expect(between(null, 1)).toBeNull()
    expect(between(2, 1)).toBeNull()
    expect(between(1, 1 + Number.EPSILON)).toBeNull()
  })
})

describe('关联与汇总：读服务端算好的 computed，按输出类型筛选排序', () => {
  const T = '0b0c3c1e-6f7a-4b2c-9d8e-112233445566'
  const RPROPS = {
    rel: { name: '子任务', type: 'relation', pos: 0, cfg: { target: T, reverse: 'rev001', single: false } },
    rev: { name: '父任务', type: 'relation', pos: 1, cfg: { target: T, mirror: 'rel001' } },
    sum: { name: '工时合计', type: 'rollup', pos: 2, cfg: { relation: 'rel', prop: 'p00001', fn: 'sum' } },
    lat: { name: '最晚截止', type: 'rollup', pos: 3, cfg: { relation: 'rel', prop: 'p00002', fn: 'latest' } },
    shw: { name: '负责人们', type: 'rollup', pos: 4, cfg: { relation: 'rel', prop: 'p00003', fn: 'show_original' } },
  }
  const rschema = parseCollection({ props: RPROPS })
  const rview = (settings: Record<string, unknown>): CollectionView => parseCollection({ props: RPROPS, views: { v1: settings } }).views[0]!
  const rrow = (id: string, computed: Record<string, unknown>, position: number, props: Record<string, unknown> = {}): CollectionRow =>
    row(id, props, { computed, position })
  const rows = [
    rrow('a', { rel: ['x', 'y'], rev: [], sum: 5, lat: '2026-03-01', shw: ['u1', 'u2'] }, 0),
    rrow('b', { rel: [], rev: ['z'], shw: [] }, 1, { rel: ['gone'] }),
    rrow('c', { rel: ['y'], rev: ['z', 'w'], sum: 12, lat: '2026-01-15 08:00:00+00' }, 2),
  ]
  const hit = (prop: string, op: string, value?: unknown): string[] =>
    rows.filter((r) => matchFilter(r, rview({ filter: { all: [{ prop, op, value }] } }).filter, rschema)).map((r) => r.id)
  const sorted = (prop: string, dir: 'asc' | 'desc'): string[] => ids(queryWindow(rows, rview({ sorts: [{ prop, dir }] }), rschema).rows)

  test('关联：包含 / 不包含 / 为空 / 不为空，比较值是对方的一行；computed 的空列表不退回存储值', () => {
    expect(hit('rel', 'contains', 'y')).toEqual(['a', 'c'])
    expect(hit('rel', 'not_contains', 'x')).toEqual(['b', 'c'])
    expect(hit('rel', 'empty')).toEqual(['b'])
    expect(hit('rel', 'not_empty')).toEqual(['a', 'c'])
    expect(hit('rev', 'contains', 'z')).toEqual(['b', 'c'])
    expect(hit('rev', 'empty')).toEqual(['a'])
  })

  test('汇总：数字按数字、日期按天（日历日与时间戳都认）、列表只有为空 / 不为空', () => {
    expect(hit('sum', 'gt', 6)).toEqual(['c'])
    expect(hit('sum', 'empty')).toEqual(['b'])
    expect(hit('lat', 'before', '2026-02-01')).toEqual(['c'])
    expect(hit('lat', 'eq', '2026-03-01')).toEqual(['a'])
    expect(hit('lat', 'eq', '2026-01-15')).toEqual(['c'])
    expect(hit('shw', 'not_empty')).toEqual(['a'])
    expect(hit('shw', 'empty')).toEqual(['b', 'c'])
    // 列表输出的汇总没有数字运算：条件解析时就丢掉
    expect(rview({ filter: { all: [{ prop: 'shw', op: 'gt', value: 1 }] } }).filter.all).toEqual([])
  })

  test('排序：汇总的数字 / 日期可排（空值恒在最后），关联与列表输出的汇总解析时丢掉', () => {
    expect(sorted('sum', 'desc')).toEqual(['c', 'a', 'b'])
    expect(sorted('lat', 'asc')).toEqual(['c', 'a', 'b'])
    expect(rview({ sorts: [{ prop: 'rel', dir: 'asc' }, { prop: 'shw', dir: 'asc' }, { prop: 'sum', dir: 'asc' }] }).sorts).toEqual([
      { prop: 'sum', dir: 'asc' },
    ])
    // 手写的排序里带着排不了的属性：不参与，按手动顺序
    expect(ids(queryWindow(rows, { ...rview({}), sorts: [{ prop: 'rel', dir: 'desc' }] }, rschema).rows)).toEqual(['a', 'b', 'c'])
  })

  test('计算值变了的行按 prev: {} 发：窗口里的行按新值进出，refs 原样留着', () => {
    const view = rview({ filter: { all: [{ prop: 'sum', op: 'gt', value: 6 }] } })
    const refs = { sum: { state: 'ok' as const, target: { id: T, title: '任务' } } }
    const start = { ...queryWindow(rows, view, rschema), refs }
    expect(ids(start.rows)).toEqual(['c'])
    const a2 = { ...rows[0]!, computed: { ...rows[0]!.computed, sum: 9 } }
    const next = applyRowsDelta(start, delta([{ row: a2, prev: {} }]), view, rschema)
    expect(ids(next.rows)).toEqual(['a', 'c'])
    expect(next.total).toBe(2)
    expect(next.refs).toBe(refs)
  })
})
