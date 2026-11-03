import { describe, expect, test } from 'vitest'
import {
  checkFormula,
  compileFormulas,
  complete,
  filterOps,
  FORMULA_MAX,
  FORMULAS_MAX,
  FUNCTION_DOCS,
  isComputedProp,
  isRollupTarget,
  parseCollection,
  rowValue,
  sortable,
  toDisplay,
  toStored,
  validateValue,
  type CollectionRefs,
  type CollectionRow,
  type CollectionView,
  type FormulaError,
  type RowsDelta,
} from '@ramet/shared/collection-model'
import { applyRowsDelta, fillFormulas, matchScope, queryWindow, type QueryCtx, type RowsWindow } from '@ramet/shared/collection-query'
import { BASE, calc, errorOf, errorOfStored, FILE_A, FILE_B, mkRow, NOW, propsWith, schemaWith, typeOf } from './collection-formula-fixtures'

/* 不变量（collection-formula/ 文件头）：存储形按属性 id 引用，改名 / 挪位置不影响；一份定义里的公式一起编译，
 * 环上的全部报循环引用、依赖它们的报「引用的公式有误」；运行时错误整格为空；求值只有 fillFormulas 一份，
 * 服务端窗口（queryWindow 开头算）与客户端套增量（applyRowsDelta 先算增量里的行）结果一致。 */


describe('词法与语法', () => {
  test('数字、文本（含中文引号与转义）、是否、属性引用（含转义）', () => {
    expect(calc('12 + 1.5 + 1e3 + .5')).toBe(1014)
    expect(calc('"a\\"b"')).toBe('a"b')
    expect(calc('“中文引号”')).toBe('中文引号')
    expect(calc('"反斜杠 \\\\ 与 \\n"')).toBe('反斜杠 \\ 与 \\n')
    expect(calc('true')).toBe(true)
    expect(calc('FALSE')).toBe(false)
    // 全角括号、逗号与半角一样认；函数名不分大小写
    expect(calc('round（1.26，1）')).toBe(1.3)
    expect(calc('[单价] + [数量]', { props: { pri: 2, qty: 3 } })).toBe(5)
  })

  test('优先级与结合性：比较 < & < 加减 < 乘除 < ^（右结合）< 负号', () => {
    expect(calc('1 + 2 * 3')).toBe(7)
    expect(calc('(1 + 2) * 3')).toBe(9)
    expect(calc('2 ^ 3 ^ 2')).toBe(512)
    expect(calc('-2 ^ 2')).toBe(4)
    expect(calc('2 ^ -1')).toBe(0.5)
    expect(calc('1 - 2 - 3')).toBe(-4)
    expect(calc('10 / 4 / 5')).toBe(0.5)
    expect(calc('"a" & 1 + 1')).toBe('a2')
    expect(calc('1 & 2 = "12"')).toBe(true)
    expect(calc('1 + 1 = 2')).toBe(true)
    expect(calc('2 <> 3')).toBe(true)
    expect(calc('2 != 2')).toBe(false)
    expect(calc('+3')).toBe(3)
  })

  test('语法错误给出位置', () => {
    expect(errorOf('1 +')).toMatchObject({ code: 'syntax', message: '公式没写完', at: [3, 3] })
    expect(errorOf('(1 + 2')).toMatchObject({ code: 'syntax' })
    expect(errorOf('1 2')).toMatchObject({ code: 'syntax', at: [2, 3] })
    expect(errorOf('abc')).toMatchObject({ code: 'syntax', at: [0, 3] })
    expect(errorOf('"abc')).toMatchObject({ code: 'syntax', at: [0, 4] })
    expect(errorOf('1 + [单价')).toMatchObject({ code: 'syntax', at: [4, 7] })
    expect(errorOf('1 # 2')).toMatchObject({ code: 'syntax', at: [2, 3] })
    expect(errorOf('[]')).toMatchObject({ code: 'syntax', message: '属性引用是空的' })
    expect(errorOf('IF(TRUE 1)')).toMatchObject({ code: 'syntax' })
    expect(errorOf('')).toMatchObject({ code: 'empty' })
    expect(errorOf('   ')).toMatchObject({ code: 'empty' })
  })

  test('长度与嵌套上限', () => {
    const long = ' ' + '1+'.repeat(999) + '1'
    expect(long.length).toBe(FORMULA_MAX)
    expect(calc(long)).toBe(1000)
    expect(errorOfStored(long + ' ')).toMatchObject({ code: 'too_long' })
    expect(calc('('.repeat(50) + '1' + ')'.repeat(50))).toBe(1)
    expect(errorOfStored('('.repeat(51) + '1' + ')'.repeat(51))).toMatchObject({ code: 'too_deep' })
    expect(errorOfStored('-'.repeat(51) + '1')).toMatchObject({ code: 'too_deep' })
    expect(errorOfStored('2^'.repeat(60) + '1')).toMatchObject({ code: 'too_deep' })
    expect(errorOfStored('ABS('.repeat(60) + '1' + ')'.repeat(60))).toMatchObject({ code: 'too_deep' })
  })
})

describe('类型推断与错误码', () => {
  test('输出类型', () => {
    expect(typeOf('[单价] * [数量]')).toBe('number')
    expect(typeOf('IF([完成], "✅", "⏳")')).toBe('text')
    expect(typeOf('[完成]')).toBe('boolean')
    expect(typeOf('TODAY()')).toBe('date')
    expect(typeOf('[开始] + 1')).toBe('date')
    expect(typeOf('[开始] - [开始]')).toBe('number')
    expect(typeOf('[标签]')).toBe('list')
    expect(typeOf('[子任务]')).toBe('list')
    expect(typeOf('[状态]')).toBe('text')
    // 夹具里的编号带前缀 T：在公式里是文字（没有前缀时是数字，见 collection-formula-text.test.ts）
    expect(typeOf('[编号]')).toBe('text')
    expect(typeOf('[工时]')).toBe('number')
    expect(typeOf('[最晚]')).toBe('date')
    expect(typeOf('[子任务值]')).toBe('list')
    expect(typeOf('[创建者]')).toBe('list')
    expect(typeOf('[名称]')).toBe('text')
    expect(typeOf('IF(FALSE, 1)')).toBe('number')
  })

  test('类型不对 / 未知函数 / 参数个数：错误码与位置', () => {
    expect(errorOf('1 + "a"')).toMatchObject({ code: 'type', at: [0, 7] })
    expect(errorOf('IF(1, 2, 3)')).toMatchObject({ code: 'type', at: [3, 4] })
    expect(errorOf('IF(TRUE, 1, "a")')).toMatchObject({ code: 'type', at: [12, 15] })
    expect(errorOf('IFS(TRUE, 1, FALSE, "a")')).toMatchObject({ code: 'type' })
    expect(errorOf('SWITCH(1, "a", 2)')).toMatchObject({ code: 'type' })
    expect(errorOf('[单价] = "1"')).toMatchObject({ code: 'type' })
    expect(errorOf('[标签] < [标签]')).toMatchObject({ code: 'type' })
    expect(errorOf('ROUND("a")')).toMatchObject({ code: 'type' })
    expect(errorOf('-"a"')).toMatchObject({ code: 'type' })
    expect(errorOf('[开始] * 2')).toMatchObject({ code: 'type' })
    expect(errorOf('DATEDIF([开始], TODAY(), "X")')).toMatchObject({ code: 'type', at: [23, 26] })
    expect(errorOf('DATEADD([开始], 1, "Q")')).toMatchObject({ code: 'type' })
    expect(errorOf('FOO(1)')).toMatchObject({ code: 'unknown_function', at: [0, 6] })
    expect(errorOf('__proto__(1)')).toMatchObject({ code: 'unknown_function' })
    expect(errorOf('constructor()')).toMatchObject({ code: 'unknown_function' })
    expect(errorOf('IF(TRUE)')).toMatchObject({ code: 'arity', message: 'IF 要 2–3 个参数，这里有 1 个' })
    expect(errorOf('TODAY(1)')).toMatchObject({ code: 'arity' })
    expect(errorOf('SUM()')).toMatchObject({ code: 'arity', message: 'SUM 至少要 1 个参数，这里有 0 个' })
    expect(errorOf('[没有这个]')).toMatchObject({ code: 'unknown_prop', at: [0, 6] })
  })

  test('存储形里引用了不存在的 id = 引用的属性已删除；写成名字的 = 找不到', () => {
    expect(errorOfStored('[@zzz999] + 1')).toMatchObject({ code: 'deleted_prop', message: '引用的属性已删除', at: [0, 9] })
    expect(errorOfStored('[单价]')).toMatchObject({ code: 'unknown_prop' })
  })
})

describe('每个函数', () => {
  test('逻辑：IF / IFS / SWITCH 按需求值，AND / OR / NOT / ISBLANK', () => {
    expect(calc('IF([完成], "✅", "⏳")', { props: { don: true } })).toBe('✅')
    expect(calc('IF([完成], "✅", "⏳")')).toBe('⏳')
    expect(calc('IF(FALSE, 1)')).toBeUndefined()
    expect(calc('IF([数量] = 0, 0, [单价] / [数量])', { props: { pri: 6, qty: 0 } })).toBe(0)
    expect(calc('[单价] / [数量]', { props: { pri: 6, qty: 0 } })).toBeUndefined()
    const ifs = 'IFS([单价] > 10, "贵", [单价] > 5, "中", "便宜")'
    expect(calc(ifs, { props: { pri: 20 } })).toBe('贵')
    expect(calc(ifs, { props: { pri: 7 } })).toBe('中')
    expect(calc(ifs, { props: { pri: 1 } })).toBe('便宜')
    expect(calc('IFS(FALSE, 1)')).toBeUndefined()
    // 状态读不出值时是缺省选项（未开始）
    const sw = 'SWITCH([状态], "未开始", 0, "已完成", 1, -1)'
    expect(calc(sw)).toBe(0)
    expect(calc(sw, { props: { sts: 'sd' } })).toBe(1)
    expect(calc('SWITCH("x", "a", 1)')).toBeUndefined()
    expect(calc('SWITCH("x", "a", 1, 2)')).toBe(2)
    expect(calc('AND(TRUE, [完成])', { props: { don: true } })).toBe(true)
    expect(calc('AND(TRUE, [完成])')).toBe(false)
    expect(calc('AND(FALSE, 1 / 0 > 1)')).toBe(false)
    expect(calc('OR(FALSE, [完成])', { props: { don: true } })).toBe(true)
    expect(calc('OR(TRUE, 1 / 0 > 1)')).toBe(true)
    expect(calc('NOT([完成])')).toBe(true)
    expect(calc('ISBLANK([备注])')).toBe(true)
    expect(calc('ISBLANK("")')).toBe(true)
    expect(calc('ISBLANK([标签])')).toBe(true)
    expect(calc('ISBLANK([标签])', { props: { tag: ['ta'] } })).toBe(false)
    expect(calc('ISBLANK(0)')).toBe(false)
    expect(calc('ISBLANK([完成])')).toBe(false)
  })

  test('数学', () => {
    expect(calc('[单价] * [数量]', { props: { pri: 2.5, qty: 4 } })).toBe(10)
    // 空在算术里当 0
    expect(calc('[单价] + [数量]', { props: { pri: 2 } })).toBe(2)
    expect(calc('SUM(1, 2, [单价])', { props: { pri: 3 } })).toBe(6)
    expect(calc('SUM([子任务值], [工时], 1)', { computed: { shw: [1, 'x', 2], hrs: 10 } })).toBe(14)
    expect(calc('SUM([子任务值])')).toBe(0)
    expect(calc('AVERAGE(1, 2, 3)')).toBe(2)
    expect(calc('AVERAGE([子任务值])')).toBeUndefined()
    expect(calc('AVERAGE([子任务值])', { computed: { shw: [1, 'x', 4] } })).toBe(2.5)
    expect(calc('MIN(3, 1, 2)')).toBe(1)
    expect(calc('MAX(3, 1, 2)')).toBe(3)
    expect(calc('MIN([子任务值])')).toBeUndefined()
    expect(calc('ROUND(1.005, 2)')).toBe(1.01)
    expect(calc('ROUND(-2.5)')).toBe(-3)
    expect(calc('ROUND(1234, -2)')).toBe(1200)
    expect(calc('ROUND(0.1 + 0.2, 10)')).toBe(0.3)
    expect(calc('ROUNDUP(1.21, 1)')).toBe(1.3)
    expect(calc('ROUNDUP(-1.21, 1)')).toBe(-1.3)
    expect(calc('ROUNDUP(0.1 + 0.2, 1)')).toBe(0.3)
    expect(calc('ROUNDDOWN(1.29, 1)')).toBe(1.2)
    expect(calc('ROUNDDOWN(-1.29)')).toBe(-1)
    expect(calc('CEILING(1.2)')).toBe(2)
    expect(calc('FLOOR(-1.2)')).toBe(-2)
    expect(calc('ABS(-3)')).toBe(3)
    expect(calc('MOD(7, 3)')).toBe(1)
    expect(calc('MOD(-7, 3)')).toBe(2)
    expect(calc('MOD(1, 0)')).toBeUndefined()
    expect(calc('POWER(2, 10)')).toBe(1024)
    expect(calc('POWER(-8, 1 / 3)')).toBeUndefined()
    expect(calc('POWER(10, 400)')).toBeUndefined()
    expect(calc('SQRT(9)')).toBe(3)
    expect(calc('SQRT(-1)')).toBeUndefined()
    expect(calc('INT(-1.5)')).toBe(-2)
    expect(calc('-0')).toBe(0)
  })

  test('文本', () => {
    expect(calc('CONCAT([编号], " ", [名称])', { number: 12 })).toBe('T-12 任务')
    expect(calc('CONCAT("a", 1, TRUE, [标签])', { props: { tag: ['ta', 'tb'] } })).toBe('a1TRUEA, B')
    expect(calc('LEN("你好😀")')).toBe(3)
    expect(calc('LEN([备注])')).toBe(0)
    expect(calc('LEFT("你好😀", 2)')).toBe('你好')
    expect(calc('LEFT("abc")')).toBe('a')
    expect(calc('LEFT("abc", -1)')).toBeUndefined()
    expect(calc('RIGHT("abc", 2)')).toBe('bc')
    expect(calc('RIGHT("abc", 5)')).toBe('abc')
    expect(calc('MID("abcdef", 2, 3)')).toBe('bcd')
    expect(calc('MID("abc", 0, 1)')).toBeUndefined()
    expect(calc('UPPER("abc")')).toBe('ABC')
    expect(calc('LOWER("ABC")')).toBe('abc')
    expect(calc('TRIM("  a   b  ")')).toBe('a b')
    expect(calc('SUBSTITUTE("a-b-c", "-", "+")')).toBe('a+b+c')
    expect(calc('SUBSTITUTE("abc", "", "x")')).toBe('abc')
    expect(calc('CONTAINS("hello", "ell")')).toBe(true)
    expect(calc('CONTAINS("Hello", "hello")')).toBe(false)
    expect(calc('TEXT(TRUE)')).toBe('TRUE')
    expect(calc('TEXT(0.1 + 0.2)')).toBe('0.3')
    expect(calc('TEXT([开始])', { props: { beg: '2026-10-01/2026-10-05' } })).toBe('2026-10-01 → 2026-10-05')
    expect(calc('TEXT(DATE(2026, 1, 2))')).toBe('2026-01-02')
    expect(calc('TEXT([创建时间])', {}, { now: NOW, tzOffset: 480 })).toBe('2026-11-02 16:00')
    expect(calc('VALUE("1,234.5")')).toBe(1234.5)
    expect(calc('VALUE(" 12 ")')).toBe(12)
    expect(calc('VALUE("abc")')).toBeUndefined()
    // 空文本归成空（不写进 computed）
    expect(calc('""')).toBeUndefined()
    expect(calc('[备注] & ""')).toBeUndefined()
  })

  test('日期', () => {
    expect(calc('TODAY()', {}, { now: NOW, tzOffset: 0 })).toBe('2026-11-02')
    expect(calc('TODAY()', {}, { now: NOW, tzOffset: 480 })).toBe('2026-11-03')
    expect(calc('NOW()', {}, { now: NOW })).toBe('2026-11-02T20:00:00.000Z')
    expect(calc('DATE(2026, 13, 1)')).toBe('2027-01-01')
    expect(calc('DATE(2026, 3, 0)')).toBe('2026-02-28')
    expect(calc('DATE(10000, 1, 1)')).toBeUndefined()
    expect(calc('DATE(0, 1, 1)')).toBeUndefined()
    const at = { props: { beg: '2026-10-05' } }
    expect(calc('YEAR([开始])', at)).toBe(2026)
    expect(calc('MONTH([开始])', at)).toBe(10)
    expect(calc('DAY([开始])', at)).toBe(5)
    expect(calc('YEAR([开始])')).toBeUndefined()
    expect(calc('WEEKDAY(DATE(2024, 1, 1))')).toBe(1)
    expect(calc('WEEKDAY(DATE(2024, 1, 7))')).toBe(7)
    expect(calc('DATEDIF([开始], TODAY(), "D")', { props: { beg: '2026-10-01' } }, { now: NOW, tzOffset: 0 })).toBe(32)
    expect(calc('DATEDIF([开始], TODAY(), "D")', { props: { beg: '2026-10-01' } }, { now: NOW, tzOffset: 480 })).toBe(33)
    expect(calc('DATEDIF([开始], TODAY(), "D")')).toBeUndefined()
    expect(calc('DATEDIF(DATE(2026, 1, 31), DATE(2026, 2, 28), "M")')).toBe(0)
    expect(calc('DATEDIF(DATE(2026, 1, 31), DATE(2026, 3, 1), "m")')).toBe(1)
    expect(calc('DATEDIF(DATE(2020, 2, 29), DATE(2021, 2, 28), "Y")')).toBe(0)
    expect(calc('DATEDIF(DATE(2021, 1, 1), DATE(2020, 1, 1), "Y")')).toBe(-1)
    expect(calc('DATEDIF(DATE(2021, 1, 1), DATE(2020, 1, 1), [备注])', { props: { txt: 'Q' } })).toBeUndefined()
    expect(calc('DATEADD(DATE(2026, 1, 31), 1, "M")')).toBe('2026-02-28')
    expect(calc('DATEADD(DATE(2024, 2, 29), 1, "Y")')).toBe('2025-02-28')
    expect(calc('DATEADD([开始], 2, "W")', at)).toBe('2026-10-19')
    expect(calc('DATEADD([开始], -1, "D")', { props: { beg: '2026-10-01/2026-10-05' } })).toBe('2026-09-30/2026-10-04')
    expect(calc('DATEADD([创建时间], 1, "D")')).toBe('2026-11-03T08:00:00.000Z')
    expect(calc('DATEADD(DATE(9999, 12, 31), 1, "D")')).toBeUndefined()
    const range = { props: { beg: '2026-10-01/2026-10-05' } }
    expect(calc('START([开始])', range)).toBe('2026-10-01')
    expect(calc('END([开始])', range)).toBe('2026-10-05')
    expect(calc('[开始] + 1', at)).toBe('2026-10-06')
    expect(calc('1 + [开始]', at)).toBe('2026-10-06')
    expect(calc('[开始] - 5', at)).toBe('2026-09-30')
    // 日期为空时整个为空（不能把空当 0 天加出一个数来）
    expect(calc('[开始] + 1')).toBeUndefined()
    expect(calc('DATE(2026, 1, 10) - DATE(2026, 1, 1)')).toBe(9)
    expect(calc('[开始] < TODAY()', at)).toBe(true)
    expect(calc('[开始] = DATE(2026, 10, 5)', at)).toBe(true)
    // 带时刻的与不带的比相等：按那一天
    expect(calc('[创建时间] = TODAY()', {}, { now: NOW, tzOffset: 0 })).toBe(true)
    expect(calc('NOW() > [创建时间]')).toBe(true)
  })

  test('列表', () => {
    const sub = { computed: { sub: ['a', 'b', 'c'] }, ref_titles: { a: '甲', b: '乙', c: '' } }
    expect(calc('COUNT([子任务])', sub)).toBe(3)
    expect(calc('COUNT([子任务])')).toBe(0)
    expect(calc('JOIN([子任务])', sub)).toBe('甲, 乙, ')
    expect(calc('JOIN([标签], "/")', { props: { tag: ['tb', 'ta'] } })).toBe('B/A')
    expect(calc('FIRST([标签])', { props: { tag: ['ta', 'tb'] } })).toBe('A')
    expect(calc('LAST([标签])', { props: { tag: ['ta', 'tb'] } })).toBe('B')
    expect(calc('FIRST([标签])')).toBeUndefined()
    expect(calc('INCLUDES([标签], "B")', { props: { tag: ['ta', 'tb'] } })).toBe(true)
    expect(calc('INCLUDES([标签], "C")', { props: { tag: ['ta', 'tb'] } })).toBe(false)
    expect(calc('INCLUDES([子任务值], 2)', { computed: { shw: [1, 2] } })).toBe(true)
    expect(calc('JOIN([附件], ",")', { props: { fil: [FILE_A, FILE_B] } })).toBe('a.png,b.pdf')
    // 列表本身原样写进 computed
    expect(calc('[标签]', { props: { tag: ['ta', 'tb'] } })).toEqual(['A', 'B'])
    expect(calc('[标签]')).toBeUndefined()
  })
})

describe('属性在公式里的值', () => {
  test('人员类：用户名（取不到用 id）；选项：名字；关联：对方行的标题', () => {
    const nameOf = (id: string): string | undefined => (id === 'u1' ? 'amy' : undefined)
    const ctx: QueryCtx = { now: NOW, nameOf }
    expect(calc('[负责人]', { props: { who: ['u1', 'u2'] } }, ctx)).toEqual(['amy', 'u2'])
    expect(calc('[创建者]', { created_by: 'u1' }, ctx)).toEqual(['amy'])
    expect(calc('[状态]', { props: { sts: 'sd' } })).toBe('已完成')
    expect(calc('[子任务]', { computed: { sub: ['a'] }, ref_titles: { a: '甲' } })).toEqual(['甲'])
    // 乐观改了关联、回声还没到：退回存储值，标题未知写成空字
    expect(calc('COUNT([子任务])', { props: { sub: ['a', 'b'] } })).toBe(2)
  })

  test('汇总：数字 / 日期原样；逐个显示的列表按 refs 把选项 id 换成名字、用户 id 换成用户名，文件写文件名', () => {
    expect(calc('[工时] * 2', { computed: { hrs: 4 } })).toBe(8)
    expect(calc('[最晚] + 1', { computed: { lat: '2026-03-01' } })).toBe('2026-03-02')
    expect(calc('DAY([最晚])', { computed: { lat: '2026-01-15 20:00:00+00' } }, { now: NOW, tzOffset: 480 })).toBe(16)
    const select: CollectionRefs = { shw: { state: 'ok', prop: { type: 'select', options: [{ id: 'o1', name: '高', color: 'red', pos: 0 }], cfg: {} } } }
    expect(calc('[子任务值]', { computed: { shw: ['o1', 'zz'] } }, { now: NOW, refs: select })).toEqual(['高', 'zz'])
    const people: CollectionRefs = { shw: { state: 'ok', prop: { type: 'person', options: [], cfg: {} } } }
    expect(calc('[子任务值]', { computed: { shw: ['u1'] } }, { now: NOW, refs: people, nameOf: () => 'amy' })).toEqual(['amy'])
    expect(calc('[子任务值]', { computed: { shw: [FILE_A, true, 3] } })).toEqual(['a.png', true, 3])
  })

  test('时区：TODAY() 与创建时间按看的人的时区折成那一天', () => {
    const created = { created_at: '2026-11-02T18:00:00Z' }
    expect(calc('DAY([创建时间])', created, { now: NOW, tzOffset: 0 })).toBe(2)
    expect(calc('DAY([创建时间])', created, { now: NOW, tzOffset: 480 })).toBe(3)
    expect(calc('DAY([创建时间])', created, { now: NOW, tzOffset: -600 })).toBe(2)
    // 时区夹在 ±14 小时
    expect(calc('DAY(TODAY())', {}, { now: NOW, tzOffset: 99_999 })).toBe(3)
  })
})

describe('存储形 ↔ 显示形', () => {
  const base = parseCollection({ props: BASE })

  test('按 id 存，[名称] 是标题；空白与写法原样保留', () => {
    const stored = toStored('[单价]  *  [数量] & [名称]', base)
    expect(stored).toEqual({ ok: true, expr: '[@pri]  *  [@qty] & [@title]' })
    expect(toDisplay('[@pri]  *  [@qty] & [@title]', base)).toBe('[单价]  *  [数量] & [名称]')
  })

  test('改名、挪位置后公式照常；显示形跟着新名字', () => {
    const before = schemaWith({ fx0001: ['总价', '[单价] * [数量]'] })
    const expr = before.props.find((p) => p.id === 'fx0001')!.cfg.expr!
    const renamed = parseCollection({
      props: { ...BASE, pri: { ...BASE.pri, name: '价格', pos: 50 }, fx0001: { name: '总价', type: 'formula', pos: 0, cfg: { expr } } },
    })
    expect(toDisplay(expr, renamed)).toBe('[价格] * [数量]')
    const row = mkRow({ props: { pri: 3, qty: 4 } })
    expect(fillFormulas([row], before)[0]!.computed?.fx0001).toBe(12)
    expect(fillFormulas([row], renamed)[0]!.computed?.fx0001).toBe(12)
  })

  test('同名属性、认不出的名字报错（位置在显示形里）', () => {
    const dup = parseCollection({ props: { ...BASE, qt2: { name: '数量', type: 'text', pos: 30 } } })
    expect(toStored('1 + [数量]', dup)).toEqual({ ok: false, error: { code: 'dup_name', message: '有两个属性都叫「数量」，先改名', at: [4, 8] } })
    expect(toStored('[没有]', base)).toMatchObject({ ok: false, error: { code: 'unknown_prop', at: [0, 4] } })
    expect(toStored('"abc', base)).toMatchObject({ ok: false, error: { code: 'syntax' } })
  })

  test('删掉被引用的属性：显示 [已删除的属性]、编译报「引用的属性已删除」；属性回来（恢复版本）公式恢复', () => {
    const schema = schemaWith({ fx0001: ['总价', '[单价] * [数量]'] })
    const expr = schema.props.find((p) => p.id === 'fx0001')!.cfg.expr!
    const { pri, ...rest } = BASE
    const gone = parseCollection({ props: { ...rest, fx0001: { name: '总价', type: 'formula', pos: 100, cfg: { expr } } } })
    expect(toDisplay(expr, gone)).toBe('[已删除的属性] * [数量]')
    const compiled = compileFormulas(gone).get('fx0001')!
    expect(compiled.ok).toBe(false)
    expect(!compiled.ok && compiled.error).toMatchObject({ code: 'deleted_prop', message: '引用的属性已删除' })
    expect(gone.props.find((p) => p.id === 'fx0001')!.output).toBeNull()
    const back = parseCollection({ props: { ...rest, pri, fx0001: { name: '总价', type: 'formula', pos: 100, cfg: { expr } } } })
    expect(fillFormulas([mkRow({ props: { pri: 2, qty: 5 } })], back)[0]!.computed?.fx0001).toBe(10)
  })

  test('名字里的 ] 与开头的 @ 转义后来回不变；名字为空的属性写成 [@id]', () => {
    const odd = parseCollection({
      props: { ab1: { name: 'a]b\\c', type: 'number', pos: 0 }, at1: { name: '@x', type: 'number', pos: 1 }, nn1: { name: '', type: 'number', pos: 2 } },
    })
    const display = toDisplay('[@ab1] + [@at1] + [@nn1]', odd)
    expect(display).toBe('[a\\]b\\\\c] + [\\@x] + [@nn1]')
    expect(toStored(display, odd)).toEqual({ ok: true, expr: '[@ab1] + [@at1] + [@nn1]' })
  })

  test('写坏的存储形：认得的引用照换，其余原样', () => {
    const base2 = parseCollection({ props: BASE })
    expect(toDisplay('[@pri] + "没结束', base2)).toBe('[单价] + "没结束')
  })
})

describe('循环引用与依赖顺序', () => {
  test('A ↔ B 两列都报循环引用；依赖它们的报「引用的公式有误」；自己引用自己', () => {
    const schema = schemaWith({ fa0001: ['甲', '[乙] + 1'], fb0001: ['乙', '[甲] + 1'], fc0001: ['丙', '[甲] * 2'], fd0001: ['丁', '[丁]'] })
    const compiled = compileFormulas(schema)
    const err = (id: string): FormulaError | undefined => {
      const c = compiled.get(id)!
      return c.ok ? undefined : c.error
    }
    // 编译的是存储形：位置是存储形里的（编辑器经 checkFormula 换算成显示形）
    expect(err('fa0001')).toMatchObject({ code: 'cycle', at: [0, 9] })
    expect(err('fa0001')?.message).toContain('「甲」')
    expect(err('fb0001')).toMatchObject({ code: 'cycle' })
    expect(err('fc0001')).toMatchObject({ code: 'bad_ref', message: '引用的公式「甲」有误' })
    expect(err('fd0001')).toMatchObject({ code: 'cycle', message: '公式引用了自己（循环引用）' })
    // 有误的公式整列为空：服务端 / 旧定义留下的值也清掉
    const [row] = fillFormulas([mkRow({ computed: { fa0001: 5 } })], schema)
    expect(row!.computed).toEqual({})
  })

  test('A → B → C 按依赖顺序算（与属性的先后无关）', () => {
    const schema = schemaWith({ fa0001: ['甲', '[乙] * 2'], fb0001: ['乙', '[丙] + 1'], fc0001: ['丙', '[单价]'] })
    expect([...compileFormulas(schema).keys()]).toEqual(['fc0001', 'fb0001', 'fa0001'])
    expect(fillFormulas([mkRow({ props: { pri: 3 } })], schema)[0]!.computed).toEqual({ fc0001: 3, fb0001: 4, fa0001: 8 })
  })

  test('强连通分量里不在同一条回边路径上的公式也算环（r → a → r，r → b → a）', () => {
    const schema = schemaWith({ fr0001: ['r', '[a] + [b]'], fa0001: ['a', '[r]'], fb0001: ['b', '[a]'] })
    for (const c of compileFormulas(schema).values()) expect(!c.ok && c.error.code).toBe('cycle')
  })

  test('一个集合最多 FORMULAS_MAX 个公式；一百个首尾相接的公式照常按顺序算', () => {
    const formulas: Record<string, [string, string]> = {}
    for (let i = 0; i <= FORMULAS_MAX; i++) formulas[`f${String(i).padStart(5, '0')}`] = [`公式${i}`, i >= FORMULAS_MAX - 1 ? '1' : `[公式${i + 1}] + 1`]
    const schema = schemaWith(formulas)
    const compiled = compileFormulas(schema)
    expect(compiled.get('f00000')).toMatchObject({ ok: true })
    expect(fillFormulas([mkRow()], schema)[0]!.computed?.f00000).toBe(FORMULAS_MAX)
    expect(compiled.get(`f${String(FORMULAS_MAX).padStart(5, '0')}`)).toMatchObject({ ok: false, error: { code: 'too_long' } })
  })

  test('公式加起来太长：超出总量的报错不算', () => {
    const long = `[单价]${' + 1'.repeat(400)}`
    const formulas: Record<string, [string, string]> = {}
    for (let i = 0; i < 20; i++) formulas[`f${String(i).padStart(5, '0')}`] = [`公式${i}`, long]
    const compiled = compileFormulas(schemaWith(formulas))
    expect(compiled.get('f00000')?.ok).toBe(true)
    expect(compiled.get('f00019')).toMatchObject({ ok: false, error: { code: 'too_long' } })
  })
})

describe('恶意输入', () => {
  test('__proto__ / constructor 之类的属性名与 id 不会摸到原型', () => {
    const props = {
      constructor: { name: '__proto__', type: 'number', pos: 0 },
      tostring: { name: 'constructor', type: 'text', pos: 1 },
    }
    const schema = schemaWith({ hasownproperty: ['toString', '[__proto__] * 2 & [constructor]'] }, props)
    const [row] = fillFormulas([mkRow({ props: { constructor: 4, tostring: 'x' } })], schema)
    expect(row!.computed).toEqual({ hasownproperty: '8x' })
    expect(rowValue(row!, schema.props.find((p) => p.id === 'hasownproperty')!)).toBe('8x')
    // 一个没算出值的公式：computed 里没有这一项，不读出原型上的东西
    const formulas: Record<string, [string, string]> = {}
    formulas['constructor'] = ['c', '[备注]']
    const empty = schemaWith(formulas)
    const [blank] = fillFormulas([mkRow()], empty)
    expect(rowValue(blank!, empty.props.find((p) => p.id === 'constructor')!)).toBeUndefined()
  })

  test('SUBSTITUTE 套娃膨胀：很快为空，不吃光内存', () => {
    let expr = '"aaaaaaaaaa"'
    for (let i = 0; i < 20; i++) expr = `SUBSTITUTE(${expr}, "a", "aaaaaaaaaa")`
    const started = Date.now()
    expect(calc(expr)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('公式属性的属性口径', () => {
  test('只读：计算类、写不进、不能当汇总目标', () => {
    const schema = schemaWith({ fx0001: ['总价', '[单价] * [数量]'] })
    const prop = schema.props.find((p) => p.id === 'fx0001')!
    expect(isComputedProp(prop)).toBe(true)
    expect(validateValue(prop, 1)).toEqual({ ok: false, error: '这个属性自动生成，不能改' })
    expect(isRollupTarget('formula')).toBe(false)
  })

  test('筛选运算与能否排序按输出类型；有误的只有为空 / 不为空、不能排序', () => {
    const schema = schemaWith({
      fn0001: ['数', '1'],
      ft0001: ['字', '"a"'],
      fb0001: ['是', 'TRUE'],
      fd0001: ['日', 'TODAY()'],
      fl0001: ['表', '[标签]'],
    })
    const out = (id: string) => schema.props.find((p) => p.id === id)!
    expect(filterOps(out('fn0001'))).toEqual(['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'empty'])
    expect(filterOps(out('ft0001'))).toEqual(['contains', 'eq', 'empty', 'not_empty'])
    expect(filterOps(out('fb0001'))).toEqual(['checked', 'unchecked'])
    expect(filterOps(out('fd0001'))).toEqual(['eq', 'before', 'after', 'empty'])
    expect(filterOps(out('fl0001'))).toEqual(['contains', 'empty', 'not_empty'])
    expect(['fn0001', 'ft0001', 'fb0001', 'fd0001', 'fl0001'].map((id) => sortable(out(id)))).toEqual([true, true, true, true, false])
    const bad = parseCollection({ props: { fx0001: { name: 'x', type: 'formula', pos: 0, cfg: { expr: '1 +' } } } }).props[0]!
    expect(bad.output).toBeNull()
    expect(filterOps(bad)).toEqual(['empty', 'not_empty'])
    expect(sortable(bad)).toBe(false)
  })

  test('computed 里的值按输出类型规整：形状不对读成空', () => {
    const schema = schemaWith({ fn0001: ['数', '1'], fd0001: ['日', 'TODAY()'], fl0001: ['表', '[标签]'] })
    const prop = (id: string) => schema.props.find((p) => p.id === id)!
    const read = (id: string, raw: unknown) => rowValue(mkRow({ computed: { [id]: raw } }), prop(id))
    expect(read('fn0001', 3)).toBe(3)
    expect(read('fn0001', '3')).toBeUndefined()
    expect(read('fd0001', '2026-01-02')).toBe('2026-01-02')
    expect(read('fd0001', '2026-01-02/2026-01-05')).toBe('2026-01-02/2026-01-05')
    expect(read('fd0001', '2026-11-02T20:00:00.000Z')).toBe('2026-11-02T20:00:00.000Z')
    expect(read('fd0001', 'tomorrow')).toBeUndefined()
    expect(read('fl0001', ['A', 1, { x: 1 }])).toEqual(['A', 1])
    expect(read('fl0001', [])).toBeUndefined()
  })
})

/* ---------- 筛选 / 排序：服务端窗口与客户端增量 ---------- */

const FORMULAS: Record<string, [string, string]> = {
  tot001: ['总价', '[单价] * [数量]'],
  lab001: ['标记', 'IF([完成], "done-" & [名称], "todo-" & [名称])'],
  big001: ['大单', '[单价] * [数量] > 10'],
  due001: ['到期', 'DATEADD([开始], 7, "D")'],
  tgs001: ['标签们', '[标签]'],
  cnt001: ['标签数', 'COUNT([标签]) + [总价]'],
}
const FJSON = propsWith(FORMULAS)
const fschema = parseCollection({ props: FJSON })
const fview = (settings: Record<string, unknown> = {}): CollectionView => parseCollection({ props: FJSON, views: { v1: settings } }).views[0]!

describe('按公式筛选 / 排序', () => {
  const rows = [
    mkRow({ id: 'a', title: 'A', props: { pri: 3, qty: 5, don: true, beg: '2026-10-01', tag: ['ta'] }, position: 0 }),
    mkRow({ id: 'b', title: 'B', props: { pri: 2, qty: 2, beg: '2026-10-20', tag: ['ta', 'tb'] }, position: 1 }),
    mkRow({ id: 'c', title: 'C', props: { pri: 10, qty: 2, tag: ['tb'] }, position: 2 }),
  ]
  const hit = (prop: string, op: string, value?: unknown): string[] =>
    queryWindow(rows, fview({ filter: { all: [{ prop, op, value }] } }), fschema).rows.map((r) => r.id)
  const order = (prop: string, dir: 'asc' | 'desc'): string[] => queryWindow(rows, fview({ sorts: [{ prop, dir }] }), fschema).rows.map((r) => r.id)

  test('数字比较、文本包含、是否、日期早于 / 晚于、列表包含', () => {
    expect(hit('tot001', 'gt', 10)).toEqual(['a', 'c'])
    expect(hit('tot001', 'eq', 4)).toEqual(['b'])
    expect(hit('lab001', 'contains', 'DONE')).toEqual(['a'])
    expect(hit('lab001', 'eq', 'todo-b')).toEqual(['b'])
    expect(hit('big001', 'checked')).toEqual(['a', 'c'])
    expect(hit('big001', 'unchecked')).toEqual(['b'])
    expect(hit('due001', 'before', '2026-10-10')).toEqual(['a'])
    expect(hit('due001', 'after', '2026-10-10')).toEqual(['b'])
    expect(hit('due001', 'eq', '2026-10-08')).toEqual(['a'])
    expect(hit('due001', 'empty')).toEqual(['c'])
    expect(hit('tgs001', 'contains', 'B')).toEqual(['b', 'c'])
    expect(hit('tgs001', 'not_empty')).toEqual(['a', 'b', 'c'])
    // 列表没有数字运算：条件解析时就丢掉
    expect(fview({ filter: { all: [{ prop: 'tgs001', op: 'gt', value: 1 }] } }).filter.all).toEqual([])
  })

  test('排序按输出类型；列表输出不排（解析时丢掉）；窗口里的行带着公式值', () => {
    expect(order('tot001', 'desc')).toEqual(['c', 'a', 'b'])
    expect(order('lab001', 'asc')).toEqual(['a', 'b', 'c'])
    expect(order('due001', 'desc')).toEqual(['b', 'a', 'c'])
    expect(order('big001', 'desc')).toEqual(['a', 'c', 'b'])
    expect(order('cnt001', 'asc')).toEqual(['b', 'a', 'c'])
    expect(fview({ sorts: [{ prop: 'tgs001', dir: 'asc' }] }).sorts).toEqual([])
    const first = queryWindow(rows, fview(), fschema).rows[0]!
    expect(first.computed).toMatchObject({ tot001: 15, lab001: 'done-A', big001: true, due001: '2026-10-08', tgs001: ['A'], cnt001: 16 })
    // 没有公式的集合：行原样，不多一个 computed
    const plain = parseCollection({ props: BASE })
    expect(queryWindow(rows, parseCollection({ props: BASE, views: { v1: {} } }).views[0]!, plain).rows[0]).toBe(rows[0])
  })

  test('乐观新建的行（还没有公式值）按公式判在不在窗口里', () => {
    const view = fview({ filter: { all: [{ prop: 'tot001', op: 'gt', value: 10 }] } })
    expect(matchScope(mkRow({ props: { pri: 4, qty: 4 } }), view, fschema, {})).toBe(true)
    expect(matchScope(mkRow({ props: { pri: 1, qty: 4 } }), view, fschema, {})).toBe(false)
  })

  test('增量：服务端带来的公式值不用，按本机重算；按 prev 还原的旧行也重算，计数精确', () => {
    const view = fview({ filter: { all: [{ prop: 'tot001', op: 'gt', value: 10 }] } })
    const start = queryWindow(rows, view, fschema)
    expect(start.rows.map((r) => r.id)).toEqual(['a', 'c'])
    const b2 = { ...rows[1]!, props: { ...rows[1]!.props, qty: 9 }, computed: { tot001: -1 } }
    const next = applyRowsDelta(start, { t: 'collection.rows', up: [{ row: b2, prev: { qty: 2 } }], rm: [] }, view, fschema)
    expect(next.rows.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(next.rows[1]!.computed?.tot001).toBe(18)
    expect(next.total).toBe(3)
    // b 不在窗口里（没取全）也按旧行计数：旧行按 prev 还原后是 4，不在筛选里，不减
    const partial: RowsWindow = { ...start, rows: [start.rows[0]!], next: 'x' }
    expect(applyRowsDelta(partial, { t: 'collection.rows', up: [{ row: b2, prev: { qty: 2 } }], rm: [] }, view, fschema).total).toBe(3)
  })
})

/* ---------- 随机模拟：服务端现算 vs 客户端套增量（含公式） ---------- */

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

function everything(rows: CollectionRow[], view: CollectionView, ctx: QueryCtx): CollectionRow[] {
  const out: CollectionRow[] = []
  let cursor: string | null = null
  for (;;) {
    const win: RowsWindow = queryWindow(rows, view, fschema, { cursor, limit: 100 }, ctx)
    out.push(...win.rows)
    cursor = win.next
    if (!cursor) return out
  }
}

function simulate(seed: number, view: CollectionView): void {
  const rand = rng(seed)
  const ctx: QueryCtx = { now: NOW, tzOffset: 480 }
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!
  const values: Record<string, () => unknown> = {
    pri: () => Math.floor(rand() * 6),
    qty: () => Math.floor(rand() * 4),
    don: () => true,
    beg: () => pick(['2026-10-01', '2026-10-05', '2026-10-09/2026-10-12']),
    tag: () => pick([['ta'], ['tb'], ['ta', 'tb']]),
  }
  const keys = Object.keys(values)
  const titles = ['甲', '乙', 'a2', '']
  let clock = 0
  const fresh = (id: string): CollectionRow => {
    const props: Record<string, unknown> = {}
    for (const key of keys) if (rand() < 0.6) props[key] = values[key]!()
    clock += 1
    return mkRow({ id, title: pick(titles), props, position: rand() < 0.8 ? Math.floor(rand() * 50) : null, created_at: new Date(NOW + clock * 1000).toISOString() })
  }
  const mutate = (before: CollectionRow): { after: CollectionRow; prev: Record<string, unknown> } => {
    const props = { ...before.props }
    let title = before.title
    const what = pick([...keys, 'title'])
    if (what === 'title') title = pick(titles)
    else if (rand() < 0.25) delete props[what]
    else props[what] = values[what]!()
    const prev: Record<string, unknown> = {}
    for (const key of new Set([...Object.keys(before.props), ...Object.keys(props)])) {
      if (JSON.stringify(before.props[key]) !== JSON.stringify(props[key])) prev[key] = Object.hasOwn(before.props, key) ? before.props[key] : null
    }
    if (title !== before.title) prev.title = before.title
    // 服务端增量里的行不带公式值（或带着别的时区算的旧值）：客户端不用它
    return { after: { ...before, props, title, computed: { tot001: 999 } }, prev }
  }
  const server: CollectionRow[] = Array.from({ length: 30 }, (_, i) => fresh(`r${i}`))
  let client: RowsWindow = queryWindow(server, view, fschema, { limit: 6 }, ctx)
  for (let step = 0; step < 200; step++) {
    const roll = rand()
    let change: RowsDelta
    if (roll < 0.6) {
      const i = Math.floor(rand() * server.length)
      const { after, prev } = mutate(server[i]!)
      server[i] = after
      change = { t: 'collection.rows', up: [{ row: after, prev }], rm: [] }
    } else if (roll < 0.8 || server.length < 5) {
      const added = fresh(`n${step}`)
      server.push(added)
      change = { t: 'collection.rows', up: [{ row: added }], rm: [] }
    } else {
      const [gone] = server.splice(Math.floor(rand() * server.length), 1)
      change = { t: 'collection.rows', up: [], rm: [{ row: gone! }] }
    }
    client = applyRowsDelta(client, change, view, fschema, ctx)
    if (rand() < 0.15 && client.next) {
      const page = queryWindow(server, view, fschema, { cursor: client.next, limit: 6 }, ctx)
      client = { ...client, rows: [...client.rows, ...page.rows], next: page.next, total: page.total }
    }
    const full = everything(server, view, ctx)
    expect(client.rows).toEqual(full.slice(0, client.rows.length))
    expect(client.total).toBe(full.length)
  }
}

describe('applyRowsDelta：随机模拟（按公式筛选排序），窗口恒为服务端列表的前缀', () => {
  test('按数字公式筛选 + 按文本公式排序', () =>
    simulate(21, fview({ filter: { all: [{ prop: 'tot001', op: 'gte', value: 4 }] }, sorts: [{ prop: 'lab001', dir: 'asc' }] })))
  test('按是否公式筛选 + 按日期公式倒序', () => simulate(22, fview({ filter: { all: [{ prop: 'big001', op: 'unchecked' }] }, sorts: [{ prop: 'due001', dir: 'desc' }] })))
  test('按列表公式包含 + 按引用公式的公式排序', () =>
    simulate(23, fview({ filter: { all: [{ prop: 'tgs001', op: 'contains', value: 'A' }] }, sorts: [{ prop: 'cnt001', dir: 'desc' }] })))
  test('按日期公式早于', () => simulate(24, fview({ filter: { all: [{ prop: 'due001', op: 'before', value: '2026-10-15' }] } })))
})

describe('性能', () => {
  test('5,000 行 × 10 个公式：一次窗口查询算完', () => {
    const formulas: Record<string, [string, string]> = {}
    const exprs = [
      '[单价] * [数量]',
      'IF([完成], "✅", "⏳")',
      'DATEDIF([开始], TODAY(), "D")',
      'CONCAT([编号], " ", [名称])',
      'COUNT([标签])',
      'ROUND([单价] / 3, 2)',
      'UPPER([名称]) & "-" & TEXT([数量])',
      'DATEADD([开始], [数量], "D")',
      'AND([完成], [单价] > 2)',
      'SUM([单价], [数量], 1)',
    ]
    exprs.forEach((expr, i) => (formulas[`pf${String(i).padStart(4, '0')}`] = [`公式${i}`, expr]))
    const schema = schemaWith(formulas)
    const rows = Array.from({ length: 5000 }, (_, i) =>
      mkRow({ id: `r${i}`, title: `行 ${i}`, number: i + 1, props: { pri: i % 7, qty: i % 5, don: i % 2 === 0, beg: '2026-10-01', tag: ['ta'] } }),
    )
    const view = parseCollection({ props: BASE, views: { v1: {} } }).views[0]!
    const started = performance.now()
    const win = queryWindow(rows, { ...view, sorts: [{ prop: 'pf0000', dir: 'desc' }] }, schema, {}, { now: NOW })
    const took = performance.now() - started
    expect(win.total).toBe(5000)
    expect(win.rows[0]!.computed?.pf0000).toBe(24)
    expect(took).toBeLessThan(3000)
  })
})

describe('编辑器：补全与实时校验', () => {
  const schema = schemaWith({ fx0001: ['总价', '[单价] * [数量]'], fy0001: ['再算', '[总价] + 1'] })

  test('[ 后列属性名（开头吻合的在前，不列自己），在完整的引用里替换整个引用', () => {
    const got = complete('[单', 2, schema, 'fx0001')
    expect(got.map((s) => s.label)).toEqual(['单价'])
    expect(got[0]).toEqual({ kind: 'prop', label: '单价', detail: 'number', insert: '[单价]', from: 0, to: 2 })
    const all = complete('[单价] + [', 8, schema, 'fx0001')
    expect(all[0]!.label).toBe('名称')
    expect(all.some((s) => s.label === '总价')).toBe(false)
    expect(all.some((s) => s.label === '再算')).toBe(true)
    expect(complete('[单价]', 2, schema)[0]).toMatchObject({ from: 0, to: 4 })
    expect(complete('[价', 2, schema).map((s) => s.label)).toEqual(['单价', '总价'])
  })

  test('字母后列函数名；文本里、数字里不补', () => {
    const got = complete('1 + su', 6, schema)
    expect(got.map((s) => s.label)).toEqual(['SUM', 'SUBSTITUTE'])
    expect(got[0]).toEqual({ kind: 'function', label: 'SUM', detail: 'SUM(数字1, …)', insert: 'SUM(', from: 4, to: 6 })
    expect(complete('"su', 3, schema)).toEqual([])
    expect(complete('1e', 2, schema)).toEqual([])
    expect(complete('[a] + IF', 8, schema).map((s) => s.label)).toEqual(['IF', 'IFS'])
    expect(FUNCTION_DOCS.map((d) => d.name)).toContain('DATEDIF')
  })

  test('实时校验：通过给存储形与输出类型；错误位置是显示形里的', () => {
    expect(checkFormula('[单价] * [数量]', schema, 'fx0001')).toEqual({ ok: true, expr: '[@pri] * [@qty]', type: 'number' })
    // 存储形比显示形短：位置照样对得上显示形
    expect(checkFormula('[单价] + [备注] * 2', schema, 'fx0001')).toMatchObject({ ok: false, error: { code: 'type', at: [7, 15] } })
    expect(checkFormula('IF(TRUE, [数量], "a")', schema, 'fx0001')).toMatchObject({ ok: false, error: { code: 'type', at: [15, 18] } })
    // 再算 引用了 总价：总价改成引用 再算 就成环
    expect(checkFormula('1 + [再算]', schema, 'fx0001')).toMatchObject({ ok: false, error: { code: 'cycle', at: [4, 8] } })
    expect(checkFormula('[不存在]', schema, 'fx0001')).toMatchObject({ ok: false, error: { code: 'unknown_prop', at: [0, 5] } })
    // 定义里还没有这个属性（刚要建）：按现有定义推断
    expect(checkFormula('[总价] & ""', schema, 'new001')).toEqual({ ok: true, expr: '[@fx0001] & ""', type: 'text' })
  })
})
