import { expect, test } from 'vitest'
import { newView, PROP_TYPES, TITLE_PROP, type CollectionProp } from '@ramet/shared/collection-model'
import { columnWidth, formatDate, formatStamp, formulaDate, hrefOf, localDay, moveTo, nextColor, parseDateInput, parseNumberInput, TYPE_ORDER } from './prop-meta'

/* 不变量：数字 / 链接 / 时间的「输入 → 值」「值 → 显示」只在 prop-meta 定义；空输入 = 清空，认不出 = 不写 */

test('数字输入：空 = 清空，认不出 = 不写，千分位与空白可以有', () => {
  expect(parseNumberInput('')).toBeNull()
  expect(parseNumberInput('  ')).toBeNull()
  expect(parseNumberInput('12')).toBe(12)
  expect(parseNumberInput(' -1,234.5 ')).toBe(-1234.5)
  expect(parseNumberInput('.5')).toBe(0.5)
  expect(parseNumberInput('1e3')).toBe(1000)
  expect(parseNumberInput('12abc')).toBeUndefined()
  expect(parseNumberInput('1e999')).toBeUndefined()
  expect(parseNumberInput('--1')).toBeUndefined()
})

test('链接：没写协议补 https，危险协议不给链接', () => {
  expect(hrefOf('example.com/a')).toBe('https://example.com/a')
  expect(hrefOf('http://x.cn')).toBe('http://x.cn')
  expect(hrefOf('mailto:a@b.c')).toBe('mailto:a@b.c')
  expect(hrefOf(' JavaScript:alert(1)')).toBeNull()
  expect(hrefOf('')).toBeNull()
})

test('时间：按本地时区显示到分钟；认不出原样', () => {
  const d = new Date(Date.UTC(2026, 9, 25, 3, 4))
  const p = (n: number) => String(n).padStart(2, '0')
  expect(formatStamp('2026-10-25 03:04:05.123+00')).toBe(
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
  )
  expect(formatStamp('不是时间')).toBe('不是时间')
})

test('列宽：存过的优先，否则按类型缺省', () => {
  const view = { id: 'v', ...newView('t', 'table', 0) }
  const num: CollectionProp = { id: 'num001', name: 'n', type: 'number', pos: 0, options: [], cfg: {} }
  expect(columnWidth(view, TITLE_PROP)).toBe(280)
  expect(columnWidth(view, num)).toBe(160)
  expect(columnWidth({ ...view, widths: { num001: 90 } }, num)).toBe(90)
})

test('新选项颜色：先挑没用过的；重排：插到其余项的第 index 位', () => {
  expect(nextColor([])).toBe('brown')
  expect(nextColor(['brown', 'orange'])).toBe('yellow')
  expect(moveTo(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
  expect(moveTo(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a'])
  expect(moveTo(['a', 'b'], 'x', 1)).toEqual(['a', 'x', 'b'])
})

test('新建属性菜单列全每一种类型，各一次', () => {
  expect([...TYPE_ORDER].sort()).toEqual([...PROP_TYPES].sort())
})

test('日期显示：单日原样，区间「开始 → 结束」；认不出原样', () => {
  expect(formatDate('2026-01-02')).toBe('2026-01-02')
  expect(formatDate('2026-01-02/2026-01-05')).toBe('2026-01-02 → 2026-01-05')
  expect(formatDate('垃圾')).toBe('垃圾')
  expect(localDay(new Date(2026, 0, 2, 23, 59))).toBe('2026-01-02')
})

test('日期输入：一天的几种写法与区间；「/」只在两侧都是 YYYY-MM-DD 时算区间', () => {
  expect(parseDateInput('2026/1/2')).toBe('2026-01-02')
  expect(parseDateInput('2026.1.2')).toBe('2026-01-02')
  expect(parseDateInput('2026年1月2日')).toBe('2026-01-02')
  expect(parseDateInput('2026-01-02/2026-01-05')).toBe('2026-01-02/2026-01-05')
  expect(parseDateInput('2026-01-05 -> 2026-01-02')).toBe('2026-01-02/2026-01-05')
  expect(parseDateInput('2026-01-02 ～ 2026-01-02')).toBe('2026-01-02')
  expect(parseDateInput('2026-02-30')).toBeUndefined()
  expect(parseDateInput('1')).toBeUndefined()
  expect(parseDateInput('')).toBeUndefined()
})

test('公式算出的日期：单日 / 区间同日期格，时间戳同创建时间格（本地时区）', () => {
  expect(formulaDate('2026-10-01')).toBe('2026-10-01')
  expect(formulaDate('2026-10-01/2026-10-03')).toBe('2026-10-01 → 2026-10-03')
  expect(formulaDate('2026-10-25T03:04:05.123Z')).toBe(formatStamp('2026-10-25T03:04:05.123Z'))
  expect(formulaDate('2026-10-25T03:04:05.123Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
})
