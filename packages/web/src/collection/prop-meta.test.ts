import { expect, test } from 'vitest'
import { newView, TITLE_PROP, type CollectionProp } from '@ramet/shared/collection-model'
import { columnWidth, formatStamp, hrefOf, moveTo, nextColor, parseNumberInput } from './prop-meta'

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
  const num: CollectionProp = { id: 'num001', name: 'n', type: 'number', pos: 0, options: [] }
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
