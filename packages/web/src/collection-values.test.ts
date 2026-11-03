import { describe, expect, test } from 'vitest'
import {
  addDays,
  cleanPrefix,
  conditionValue,
  dateSpan,
  daysBetween,
  epochDay,
  fileList,
  FILES_MAX,
  formatNumber,
  fromEpochDay,
  idList,
  isComputedProp,
  joinDate,
  parseCollection,
  PROP_TYPES,
  readValue,
  rowValue,
  validateValue,
  weekdayOf,
  type CollectionProp,
  type CollectionRow,
  type Filter,
  type PropType,
} from '@ramet/shared/collection-model'
import { compareRows, matchFilter, type QueryCtx } from '@ramet/shared/collection-query'

/* 新类型的值（@ramet/shared/collection-values，经 collection-model 导出）：邮箱、电话、文件、日期区间是存储值，
 * 创建者、最后编辑者、自动编号是行元数据。不变量同 collection-model：readValue 容错不抛、validateValue 是唯一校验；
 * 区间日期的筛选：「是」= 比较日落在区间里，「早于」= 整段在它之前，「晚于」= 整段在它之后；单日时与逐日比较完全一样 */

function prop(type: PropType, extra: Partial<CollectionProp> = {}): CollectionProp {
  return { id: 'p1', name: '属性', type, pos: 0, options: [], cfg: {}, ...extra }
}

const FILE_A = { id: '0b5f4a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', name: 'b-设计稿.png', mime: 'image/png', size: 1024 }
const FILE_B = { id: '1c6e5b4f-2d3e-4f60-9bac-1d2e3f4a5b6c', name: 'a-说明.pdf', mime: 'application/pdf', size: 0 }

describe('邮箱 / 电话', () => {
  test('邮箱：去首尾空白、空 = 删键；要有 @ 和带点的域名，没有空白与控制字符，≤ 320 字', () => {
    const p = prop('email')
    expect(validateValue(p, '  amy@example.com ')).toEqual({ ok: true, value: 'amy@example.com' })
    expect(validateValue(p, '   ')).toEqual({ ok: true, value: null })
    for (const bad of ['amy', 'amy@', '@example.com', 'amy@example', 'a my@example.com', 'amy@exa\u0000mple.com', 'a@b.c\ud800', 42, ['a@b.co']]) {
      expect(validateValue(p, bad).ok).toBe(false)
    }
    expect(validateValue(p, `${'x'.repeat(314)}@b.com`).ok).toBe(true)
    expect(validateValue(p, `${'x'.repeat(315)}@b.com`).ok).toBe(false)
  })

  test('电话：只收数字与 + - ( ) . 空格 # * , ; x X 转，至少 3 位数字，≤ 50 字', () => {
    const p = prop('phone')
    for (const good of ['110', '+86 138-0000-0000', '(010) 1234.5678', '1234 x56', '400-800-1234 转 8', '*990#', '123,456;7']) {
      expect(validateValue(p, ` ${good} `)).toEqual({ ok: true, value: good })
    }
    expect(validateValue(p, '')).toEqual({ ok: true, value: null })
    for (const bad of ['12', '++--()', 'call 110', '１２３', '138\n0000', 1380000, '1'.repeat(51)]) {
      expect(validateValue(p, bad).ok).toBe(false)
    }
  })

  test('readValue：非空字符串（格式不对也照样读出来显示，原值不动）；别的形状读成空', () => {
    for (const type of ['email', 'phone'] as const) {
      expect(readValue(prop(type), 'whatever')).toBe('whatever')
      expect(readValue(prop(type), '')).toBeUndefined()
      expect(readValue(prop(type), 3)).toBeUndefined()
    }
  })
})

describe('文件与媒体', () => {
  test('validateValue：只留 id / name / mime / size 四个字段，按 id 去重，空列表 = 删键', () => {
    const p = prop('files')
    expect(validateValue(p, [{ ...FILE_A, extra: 1 }, FILE_B, { ...FILE_A, name: '另一个名字' }])).toEqual({ ok: true, value: [FILE_A, FILE_B] })
    expect(validateValue(p, [])).toEqual({ ok: true, value: null })
    expect(validateValue(p, [{ ...FILE_A, mime: '' }]).ok).toBe(true)
  })

  test('validateValue：任一项不合格整格不收；最多 FILES_MAX 个（去重之后数）', () => {
    const p = prop('files')
    const bad = [
      FILE_A,
      [{ ...FILE_A, id: 'x' }],
      [{ ...FILE_A, id: FILE_A.id.toUpperCase() }],
      [{ ...FILE_A, name: '' }],
      [{ ...FILE_A, name: 'x'.repeat(256) }],
      [{ ...FILE_A, name: 'a\tb' }],
      [{ ...FILE_A, name: '半个\udc00' }],
      [{ ...FILE_A, mime: 'x'.repeat(101) }],
      [{ ...FILE_A, size: -1 }],
      [{ ...FILE_A, size: 1.5 }],
      [{ ...FILE_A, size: '1' }],
      [FILE_A, null],
      ['0b5f4a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'],
    ]
    for (const value of bad) expect(validateValue(p, value).ok).toBe(false)
    const many = Array.from({ length: FILES_MAX + 1 }, (_, i) => ({ ...FILE_A, id: FILE_A.id.slice(0, -2) + String(i).padStart(2, '0') }))
    expect(validateValue(p, many).ok).toBe(false)
    expect(validateValue(p, many.slice(0, FILES_MAX)).ok).toBe(true)
    expect(validateValue(p, [...many.slice(0, FILES_MAX), many[0]]).ok).toBe(true)
  })

  test('readValue：跳过没有合法 id 的项与重复项，缺的字段按空补，最多 FILES_MAX 个；一项都没有 = 空', () => {
    const p = prop('files')
    expect(readValue(p, [FILE_A, { id: 'bad' }, 'x', null, { id: FILE_B.id }, { ...FILE_A, name: 'dup' }])).toEqual([
      FILE_A,
      { id: FILE_B.id, name: '', mime: '', size: 0 },
    ])
    expect(readValue(p, [{ id: 'bad' }])).toBeUndefined()
    expect(readValue(p, FILE_A)).toBeUndefined()
    expect(readValue(p, ['a', 'b'])).toBeUndefined()
    const many = Array.from({ length: 30 }, (_, i) => ({ ...FILE_A, id: FILE_A.id.slice(0, -2) + String(i).padStart(2, '0') }))
    expect((readValue(p, many) as unknown[]).length).toBe(FILES_MAX)
  })

  test('idList / fileList 分得清两种列表值', () => {
    expect(idList(['u1'])).toEqual(['u1'])
    expect(idList([FILE_A])).toBeUndefined()
    expect(fileList([FILE_A])).toEqual([FILE_A])
    expect(fileList(['u1'])).toBeUndefined()
    expect(idList('u1')).toBeUndefined()
    expect(fileList(undefined)).toBeUndefined()
  })
})

describe('日期区间', () => {
  test('编码：单日 YYYY-MM-DD，区间 开始/结束；读值按规范写法（交换、同一天写成单日）', () => {
    const p = prop('date')
    expect(readValue(p, '2026-10-01')).toBe('2026-10-01')
    expect(readValue(p, '2026-10-01/2026-10-05')).toBe('2026-10-01/2026-10-05')
    expect(readValue(p, '2026-10-05/2026-10-01')).toBe('2026-10-01/2026-10-05')
    expect(readValue(p, '2026-10-05/2026-10-05')).toBe('2026-10-05')
    for (const bad of ['2026-10-01/', '/2026-10-01', '2026-10-01/2026-02-30', '2026-10-01/2026-10-02/2026-10-03', '2026-10-01 2026-10-02', 20261001]) {
      expect(readValue(p, bad)).toBeUndefined()
    }
    expect(dateSpan('2026-10-05/2026-10-01')).toEqual({ start: '2026-10-01', end: '2026-10-05' })
    expect(dateSpan('2026-10-05')).toEqual({ start: '2026-10-05', end: '2026-10-05' })
    expect(joinDate('2026-10-05', '2026-10-01')).toBe('2026-10-01/2026-10-05')
    expect(joinDate('2026-10-05', '2026-10-05')).toBe('2026-10-05')
  })

  test('validateValue：两端都是真实日历日；规整成规范写法', () => {
    const p = prop('date')
    expect(validateValue(p, '2026-10-09/2026-10-02')).toEqual({ ok: true, value: '2026-10-02/2026-10-09' })
    expect(validateValue(p, '2026-10-02/2026-10-02')).toEqual({ ok: true, value: '2026-10-02' })
    expect(validateValue(p, '2024-02-29/2025-02-28')).toEqual({ ok: true, value: '2024-02-29/2025-02-28' })
    for (const bad of ['2026-10-02/2025-02-29', '', '2026-10-02/', ' 2026-10-02', 20261002]) {
      expect(validateValue(p, bad).ok).toBe(false)
    }
  })

  // 比较日 d = 10-05：每一行的值 → [是, 早于, 晚于]
  const TRUTH: [string, [boolean, boolean, boolean]][] = [
    ['2026-10-05', [true, false, false]],
    ['2026-10-04', [false, true, false]],
    ['2026-10-06', [false, false, true]],
    ['2026-10-01/2026-10-10', [true, false, false]],
    ['2026-10-05/2026-10-10', [true, false, false]],
    ['2026-10-01/2026-10-05', [true, false, false]],
    ['2026-10-01/2026-10-04', [false, true, false]],
    ['2026-10-06/2026-10-10', [false, false, true]],
  ]
  const schema = parseCollection({ props: { dat: { name: '日期', type: 'date', pos: 0 } } })
  const row = (id: string, dat?: string): CollectionRow => ({
    id,
    title: id,
    icon: null,
    props: dat === undefined ? {} : { dat },
    position: null,
    created_at: '2026-10-01T00:00:00Z',
    edited_at: '2026-10-01T00:00:00Z',
    has_body: false,
  })
  const where = (op: string, value?: string): Filter => ({ all: [{ prop: 'dat', op: op as 'eq', ...(value ? { value } : {}) }] })

  test('筛选真值表：是 = 落在区间里，早于 = 整段在之前，晚于 = 整段在之后；为空只认没有值', () => {
    for (const [value, [eq, before, after]] of TRUTH) {
      const r = row('r', value)
      expect([matchFilter(r, where('eq', '2026-10-05'), schema), matchFilter(r, where('before', '2026-10-05'), schema), matchFilter(r, where('after', '2026-10-05'), schema)], value).toEqual([
        eq,
        before,
        after,
      ])
      expect(matchFilter(r, where('empty'), schema)).toBe(false)
    }
    const empty = row('e')
    expect(matchFilter(empty, where('empty'), schema)).toBe(true)
    for (const op of ['eq', 'before', 'after']) expect(matchFilter(empty, where(op, '2026-10-05'), schema)).toBe(false)
  })

  test('排序：先比开始日，同一天开始的再比结束日；空值不论方向都在最后', () => {
    const rows = [row('long', '2026-10-01/2026-10-09'), row('none'), row('single', '2026-10-01'), row('later', '2026-10-02'), row('short', '2026-10-01/2026-10-03')]
    const order = (dir: 'asc' | 'desc') => [...rows].sort((a, b) => compareRows(a, b, [{ prop: 'dat', dir }], schema)).map((r) => r.id)
    expect(order('asc')).toEqual(['single', 'short', 'long', 'later', 'none'])
    expect(order('desc')).toEqual(['later', 'long', 'short', 'single', 'none'])
  })
})

describe('创建者 / 最后编辑者 / 自动编号', () => {
  const schema = parseCollection({
    props: {
      cby: { name: '创建者', type: 'created_by', pos: 0 },
      eby: { name: '最后编辑者', type: 'edited_by', pos: 1 },
      uid: { name: '编号', type: 'unique_id', pos: 2, cfg: { prefix: 'T' } },
      fil: { name: '附件', type: 'files', pos: 3 },
      eml: { name: '邮箱', type: 'email', pos: 4 },
    },
  })
  const row = (id: string, extra: Partial<CollectionRow> = {}): CollectionRow => ({
    id,
    title: id,
    icon: null,
    props: {},
    position: null,
    created_at: '2026-10-01T00:00:00Z',
    edited_at: '2026-10-01T00:00:00Z',
    has_body: false,
    ...extra,
  })
  const rows = [
    row('a', { created_by: 'u1', edited_by: 'u2', number: 3, props: { fil: [FILE_A], eml: 'Amy@Example.com' } }),
    row('b', { created_by: 'u2', edited_by: 'u2', number: 10, props: { fil: [FILE_B, FILE_A] } }),
    row('c', { created_by: null, number: null }),
    row('d'),
  ]
  const filter = (prop: string, op: string, value?: unknown): string[] =>
    rows.filter((r) => matchFilter(r, { all: [{ prop, op: op as 'eq', ...(value === undefined ? {} : { value: value as string }) }] }, schema)).map((r) => r.id)
  const sorted = (prop: string, dir: 'asc' | 'desc', ctx: QueryCtx = {}): string[] =>
    [...rows].sort((x, y) => compareRows(x, y, [{ prop, dir }], schema, ctx)).map((r) => r.id)

  test('系统生成的类型写不进、不在行文档里；isComputedProp 认它们、创建 / 编辑时间、汇总、公式与反向关联', () => {
    for (const type of ['created_by', 'edited_by', 'unique_id'] as const) {
      expect(validateValue(prop(type), ['u1'])).toEqual({ ok: false, error: '这个属性自动生成，不能改' })
      expect(readValue(prop(type), ['u1'])).toBeUndefined()
    }
    expect(PROP_TYPES.filter((type) => isComputedProp(prop(type)))).toEqual(['created_time', 'edited_time', 'created_by', 'edited_by', 'unique_id', 'rollup', 'formula'])
    expect(isComputedProp({ ...prop('relation'), cfg: { target: 'x', mirror: 'p00002' } })).toBe(true)
  })

  test('筛选：创建者 / 最后编辑者同人员（比较值是用户 id），编号按数字，文件只有为空 / 不为空，邮箱同文本', () => {
    expect(filter('cby', 'contains', 'u1')).toEqual(['a'])
    expect(filter('cby', 'not_contains', 'u1')).toEqual(['b', 'c', 'd'])
    expect(filter('cby', 'empty')).toEqual(['c', 'd'])
    expect(filter('eby', 'contains', 'u2')).toEqual(['a', 'b'])
    expect(filter('uid', 'gt', 3)).toEqual(['b'])
    expect(filter('uid', 'lte', 3)).toEqual(['a'])
    expect(filter('uid', 'neq', 3)).toEqual(['b', 'c', 'd'])
    expect(filter('fil', 'empty')).toEqual(['c', 'd'])
    expect(filter('fil', 'not_empty')).toEqual(['a', 'b'])
    expect(filter('eml', 'contains', 'example')).toEqual(['a'])
    // 不适用的运算 / 比较值形状不对的条件不参与
    expect(filter('uid', 'empty')).toEqual(['a', 'b', 'c', 'd'])
    expect(filter('uid', 'eq', '3')).toEqual(['a', 'b', 'c', 'd'])
    expect(conditionValue(prop('unique_id'), 'eq', 3)).toBe(3)
    expect(conditionValue(prop('created_by'), 'contains', '')).toBeUndefined()
    expect(conditionValue(prop('files'), 'empty', 'x')).toBeUndefined()
  })

  test('排序：编号按数字；创建者按名字（ctx.nameOf），没给按 id；文件按第一个文件名；空值恒在最后', () => {
    expect(sorted('uid', 'asc')).toEqual(['a', 'b', 'c', 'd'])
    expect(sorted('uid', 'desc')).toEqual(['b', 'a', 'c', 'd'])
    expect(sorted('cby', 'asc')).toEqual(['a', 'b', 'c', 'd'])
    const names: Record<string, string> = { u1: 'zed', u2: 'amy' }
    expect(sorted('cby', 'asc', { nameOf: (id) => names[id] })).toEqual(['b', 'a', 'c', 'd'])
    expect(sorted('fil', 'asc')).toEqual(['b', 'a', 'c', 'd'])
    expect(rowValue(rows[1]!, schema.props[3]!)).toEqual([FILE_B, FILE_A])
  })

  test('编号的显示：有前缀写成「前缀-编号」；前缀的规范形状', () => {
    const uid = schema.props.find((p) => p.id === 'uid')!
    expect(formatNumber(uid, 12)).toBe('T-12')
    expect(formatNumber(prop('unique_id', { cfg: { prefix: '' } }), 12)).toBe('12')
    expect(cleanPrefix(' Task #1 ')).toBe('Task1')
    expect(cleanPrefix('ABCDEFGHIJKL')).toBe('ABCDEFGHIJ')
    expect(cleanPrefix(7)).toBe('')
  })
})

describe('日期的加减（日历 / 时间线排版、日期范围的跨度）', () => {
  test('天数换算按 UTC、往返一致；跨月、跨年、闰年都对；年份 1–99 不被当成 1900 年代', () => {
    expect(epochDay('1970-01-01')).toBe(0)
    expect(epochDay('1969-12-31')).toBe(-1)
    for (const day of ['2026-11-02', '2024-02-29', '0001-01-01', '0099-12-31', '9999-12-31']) expect(fromEpochDay(epochDay(day))).toBe(day)
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(addDays('2025-02-28', 1)).toBe('2025-03-01')
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
    expect(daysBetween('2026-10-30', '2026-11-02')).toBe(3)
    expect(daysBetween('2026-11-02', '2026-10-30')).toBe(-3)
  })

  test('星期：周一 = 0 … 周日 = 6', () => {
    expect(weekdayOf('2026-11-02')).toBe(0) // 周一
    expect(weekdayOf('2026-11-08')).toBe(6) // 周日
    expect(weekdayOf('1970-01-01')).toBe(3) // 周四
    expect(weekdayOf('1969-12-29')).toBe(0)
  })
})
