import { describe, expect, test } from 'vitest'
import { parseCollection, type CollectionView } from '@ramet/shared/collection-model'
import { fillFormulas, queryWindow } from '@ramet/shared/collection-query'
import { BASE, calc, errorOf, mkRow, NOW, propsWith, schemaWith, typeOf } from './collection-formula-fixtures'

/* 公式的典型写法与文本口径：最常见的五种写法原样照写；文本连接把别的类型按 TEXT() 的文字接上（算术 / 比较 / 条件仍不转换）；
 * 文本输出的公式列排序与文本列同一个 Collator，公式里的比较运算按码点；编译出错的原因记在属性上。 */

describe('最常见的五种写法（原样照写）', () => {
  // 编号 = 带前缀 T 的自动编号（在公式里是文字「T-12」）、子任务 = 关联（标题来自 ref_titles）：与 BASE 里的属性同名同类型
  const schema = schemaWith({
    ex0001: ['总价', '[单价] * [数量]'],
    ex0002: ['进度', 'IF([完成], "✅", "⏳")'],
    ex0003: ['已过天数', 'DATEDIF([开始], TODAY(), "D")'],
    ex0004: ['标签名', 'CONCAT([编号], " ", [名称])'],
    ex0005: ['子任务数', 'COUNT([子任务])'],
  })
  const row = mkRow({
    title: '写周报',
    number: 12,
    props: { pri: 2.5, qty: 4, don: true, beg: '2026-10-01', sub: ['a', 'b', 'c'] },
    computed: { sub: ['a', 'b', 'c'] },
    ref_titles: { a: '甲', b: '乙', c: '丙' },
  })

  test('都编译通过，输出类型对', () => {
    const types = ['ex0001', 'ex0002', 'ex0003', 'ex0004', 'ex0005'].map((id) => schema.props.find((p) => p.id === id)!.output)
    expect(types).toEqual(['number', 'text', 'number', 'text', 'number'])
  })

  test('结果正确（TODAY 按看的人的时区）', () => {
    const got = fillFormulas([row], schema, { now: NOW, tzOffset: 0 })[0]!.computed
    expect(got).toMatchObject({ ex0001: 10, ex0002: '✅', ex0003: 32, ex0004: 'T-12 写周报', ex0005: 3 })
    expect(fillFormulas([row], schema, { now: NOW, tzOffset: 480 })[0]!.computed?.ex0003).toBe(33)
    const blank = fillFormulas([mkRow()], schema, { now: NOW })[0]!.computed
    expect(blank).toEqual({ ex0001: 0, ex0002: '⏳', ex0004: ' 任务', ex0005: 0 })
  })
})

describe('文本连接把别的类型按 TEXT() 的文字接上', () => {
  test('& 与 CONCAT 接数字、是否、日期、列表，与 TEXT() / JOIN() 同一种写法', () => {
    const row = { number: 7, props: { don: true, beg: '2026-10-01/2026-10-03', tag: ['ta', 'tb'], pri: 0.1 } }
    expect(calc('[编号] & "-" & [名称]', row)).toBe('T-7-任务')
    expect(calc('"完成：" & [完成]', row)).toBe('完成：TRUE')
    expect(calc('CONCAT([开始])', row)).toBe(calc('TEXT([开始])', row))
    expect(calc('[开始] & ""', row)).toBe('2026-10-01 → 2026-10-03')
    expect(calc('[标签] & ""', row)).toBe(calc('JOIN([标签])', row))
    expect(calc('[单价] * 3 & ""', row)).toBe('0.3')
    expect(calc('[创建时间] & ""', {}, { now: NOW, tzOffset: 480 })).toBe('2026-11-02 16:00')
    expect(typeOf('[编号] & [完成] & [开始] & [标签]')).toBe('text')
    expect(typeOf('CONCAT([编号], [完成], [开始], [标签], [工时])')).toBe('text')
  })

  test('算术、比较、条件仍不转换', () => {
    expect(errorOf('[数量] + "1"')).toMatchObject({ code: 'type' })
    expect(errorOf('[数量] = "12"')).toMatchObject({ code: 'type' })
    expect(errorOf('IF([数量], 1, 2)')).toMatchObject({ code: 'type' })
    expect(errorOf('LEN([数量])')).toMatchObject({ code: 'type' })
  })

  test('自动编号：有前缀是文字「T-7」，没有前缀是数字（能算、能比大小）', () => {
    const plain = { ...BASE, uid: { ...BASE.uid, cfg: {} } }
    const schema = schemaWith({ ex0010: ['下一个', '[编号] + 1'], ex0011: ['靠前', '[编号] < 10'] }, plain)
    const got = fillFormulas([mkRow({ number: 7 })], schema, { now: NOW })[0]!.computed
    expect(got).toMatchObject({ ex0010: 8, ex0011: true })
    expect(typeOf('[编号]')).toBe('text')
    expect(calc('LEN([编号])', { number: 7 })).toBe(3)
  })
})

describe('文本公式的排序与文本列同一个比较器', () => {
  const schema = schemaWith({ fx0001: ['备注照抄', '[备注]'] })
  const texts = ['item10', 'item9', '张三', '阿四', 'b', 'B', 'a']
  const rows = texts.map((txt, i) => mkRow({ id: `t${i}`, title: `行${i}`, props: { txt }, position: i }))
  const view = (prop: string, dir: 'asc' | 'desc'): CollectionView =>
    parseCollection({ props: propsWith({ fx0001: ['备注照抄', '[备注]'] }), views: { v1: { sorts: [{ prop, dir }] } } }).views[0]!

  test('升序 / 降序都与按文本属性排的一样（数字按大小、中文按拼音），不是码点序', () => {
    for (const dir of ['asc', 'desc'] as const) {
      const byFormula = queryWindow(rows, view('fx0001', dir), schema).rows.map((r) => r.id)
      const byText = queryWindow(rows, view('txt', dir), schema).rows.map((r) => r.id)
      expect(byFormula).toEqual(byText)
    }
    const asc = queryWindow(rows, view('fx0001', 'asc'), schema).rows.map((r) => r.props.txt)
    expect(asc.indexOf('item9')).toBeLessThan(asc.indexOf('item10'))
    expect(asc.indexOf('阿四')).toBeLessThan(asc.indexOf('张三'))
  })

  test('公式里的比较运算按码点（结果是值本身，两端必须比出一样的是否）', () => {
    expect(calc('"item10" < "item9"')).toBe(true)
    expect(calc('"张" < "阿"')).toBe(true)
  })
})

describe('属性上记着编译出错的原因', () => {
  test('出错的公式有 formulaError，好的没有；还没写是 empty', () => {
    const schema = schemaWith({ fa0001: ['好', '[单价] * 2'], fb0001: ['坏', '[单价] & 1 + "x"'], fc0001: ['空', ''] })
    const by = (id: string) => schema.props.find((p) => p.id === id)!
    expect(by('fa0001').formulaError).toBeUndefined()
    expect(by('fb0001')).toMatchObject({ output: null, formulaError: { code: 'type' } })
    expect(by('fc0001')).toMatchObject({ output: null, formulaError: { code: 'empty' } })
  })
})
