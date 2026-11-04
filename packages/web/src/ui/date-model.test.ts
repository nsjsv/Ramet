import { describe, expect, test } from 'vitest'
import {
  addMonths,
  daysInMonth,
  formatDateTime,
  joinDateTime,
  localDateTimeOf,
  localDay,
  monthGrid,
  moveDay,
  parseDateInput,
  parseDateTime,
  parseDay,
  parseTime,
  shiftMonth,
  splitDateTime,
} from './date-model'

/* 日期的纯逻辑：月格（周一开头 6 × 7，日历视图与选择器共用）、键盘移动、翻月夹日、文字与时间的解析 */

describe('月格', () => {
  test('周一开头 42 格，非本月的日子补齐首尾', () => {
    const grid = monthGrid('2026-11') // 11-01 是周日
    expect(grid.days).toHaveLength(42)
    expect(grid.days[0]).toBe('2026-10-26')
    expect(grid.days[6]).toBe('2026-11-01')
    expect(grid.days[41]).toBe('2026-12-06')
    expect([grid.from, grid.to]).toEqual(['2026-10-26', '2026-12-06'])
    // 1 号就是周一：第一格就是 1 号
    expect(monthGrid('2026-06').days[0]).toBe('2026-06-01')
    expect(monthGrid('2024-02').days).toContain('2024-02-29')
  })

  test('跨年翻月', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2027-01', -1)).toBe('2026-12')
    expect(shiftMonth('2026-05', -17)).toBe('2024-12')
    expect(shiftMonth('2026-11', -23)).toBe('2024-12')
    expect(monthGrid('2027-01').days[0]).toBe('2026-12-28')
  })

  test('每月天数（闰年 2 月）', () => {
    expect(daysInMonth('2026-02')).toBe(28)
    expect(daysInMonth('2028-02')).toBe(29)
    expect(daysInMonth('2100-02')).toBe(28)
    expect(daysInMonth('2000-02')).toBe(29)
    expect(daysInMonth('2026-04')).toBe(30)
    expect(daysInMonth('2026-12')).toBe(31)
  })

  test('翻月时日子夹到那个月的最后一天，不跳进下个月', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29')
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28')
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15')
    expect(addMonths('2028-02-29', 12)).toBe('2029-02-28')
  })
})

describe('键盘移动', () => {
  test('←→ 一天、↑↓ 一周，跨月跨年', () => {
    expect(moveDay('2026-11-01', 'ArrowLeft')).toBe('2026-10-31')
    expect(moveDay('2026-12-31', 'ArrowRight')).toBe('2027-01-01')
    expect(moveDay('2026-11-03', 'ArrowUp')).toBe('2026-10-27')
    expect(moveDay('2026-12-29', 'ArrowDown')).toBe('2027-01-05')
  })

  test('PageUp / PageDown 一个月（Shift 一年），日子夹到月末', () => {
    expect(moveDay('2026-03-31', 'PageUp')).toBe('2026-02-28')
    expect(moveDay('2026-01-31', 'PageDown')).toBe('2026-02-28')
    expect(moveDay('2026-11-03', 'PageDown', true)).toBe('2027-11-03')
    expect(moveDay('2028-02-29', 'PageUp', true)).toBe('2027-02-28')
  })

  test('Home / End 到本周一 / 周日', () => {
    expect(moveDay('2026-11-04', 'Home')).toBe('2026-11-02') // 周三 → 周一
    expect(moveDay('2026-11-04', 'End')).toBe('2026-11-08')
    expect(moveDay('2026-11-02', 'Home')).toBe('2026-11-02')
    expect(moveDay('2026-11-08', 'End')).toBe('2026-11-08')
    expect(moveDay('2026-12-30', 'End')).toBe('2027-01-03') // 本周跨年
  })

  test('不是移动键 = null；翻出可选的年份就不动', () => {
    expect(moveDay('2026-11-03', 'Enter')).toBeNull()
    expect(moveDay('2026-11-03', 'a')).toBeNull()
    expect(moveDay('9999-12-31', 'ArrowRight')).toBe('9999-12-31')
    expect(moveDay('9999-12-15', 'PageDown')).toBe('9999-12-15')
    expect(moveDay('0001-01-01', 'ArrowLeft')).toBe('0001-01-01')
  })
})

describe('解析', () => {
  test('本地时区的今天', () => {
    expect(localDay(new Date(2026, 0, 2, 23, 59))).toBe('2026-01-02')
    expect(localDay(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31')
  })

  test('日期（含区间）：一天的几种写法与区间；「/」只在两侧都是 YYYY-MM-DD 时算区间', () => {
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

  test('一天：多种写法，区间与认不出的不算', () => {
    expect(parseDay('2026-11-03')).toBe('2026-11-03')
    expect(parseDay(' 2026/1/2 ')).toBe('2026-01-02')
    expect(parseDay('2026年1月2日')).toBe('2026-01-02')
    expect(parseDay('2026-02-30')).toBeUndefined()
    expect(parseDay('2026-01-02/2026-01-05')).toBeUndefined()
    expect(parseDay('2026-01-02 ～ 2026-01-02')).toBeUndefined()
    expect(parseDay('2026-11')).toBeUndefined()
    expect(parseDay('')).toBeUndefined()
  })

  test('时间：HH:MM，小时可以一位、分钟必须两位，全角冒号也认', () => {
    expect(parseTime('09:30')).toBe('09:30')
    expect(parseTime('9:30')).toBe('09:30')
    expect(parseTime(' 23:59 ')).toBe('23:59')
    expect(parseTime('14：05')).toBe('14:05')
    expect(parseTime('00:00')).toBe('00:00')
    expect(parseTime('24:00')).toBeUndefined()
    expect(parseTime('12:60')).toBeUndefined()
    expect(parseTime('9:5')).toBeUndefined()
    expect(parseTime('0930')).toBeUndefined()
    expect(parseTime('')).toBeUndefined()
  })

  test('日期加时间：空格或 T 分隔；只有日期 = 当天 00:00', () => {
    expect(parseDateTime('2026-11-03 14:30')).toBe('2026-11-03T14:30')
    expect(parseDateTime('2026-11-03T9:05')).toBe('2026-11-03T09:05')
    expect(parseDateTime('2026年11月3日 8:00')).toBe('2026-11-03T08:00')
    expect(parseDateTime('2026-11-03')).toBe('2026-11-03T00:00')
    expect(parseDateTime('2026-11-03 25:00')).toBeUndefined()
    expect(parseDateTime('2026-02-30 10:00')).toBeUndefined()
    expect(parseDateTime('14:30')).toBeUndefined()
  })

  test('外来的日期时间换成本地钟点：带 Z / 偏移的按时刻换算，人写的形状按本地读', () => {
    const local = (d: Date) => `${localDay(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    expect(localDateTimeOf('2026-11-03T06:30:00Z')).toBe(local(new Date(Date.UTC(2026, 10, 3, 6, 30))))
    expect(localDateTimeOf('2026-11-03T14:30:00+08:00')).toBe(local(new Date(Date.UTC(2026, 10, 3, 6, 30))))
    expect(localDateTimeOf('2026-11-03T14:30:45')).toBe('2026-11-03T14:30')
    expect(localDateTimeOf('2026-11-03T14:30')).toBe('2026-11-03T14:30')
    // 只有日期：本地零点（Date.parse 会当成 UTC 零点）
    expect(localDateTimeOf('2026-11-03')).toBe('2026-11-03T00:00')
    expect(localDateTimeOf('明天')).toBeUndefined()
    // 换算后交回去还是同一个时刻（提问表单的缺省值原样提交）
    const iso = '2026-11-03T06:30:00.000Z'
    expect(new Date(localDateTimeOf(iso)!).toISOString()).toBe(iso)
  })

  test('拼合 / 拆分 / 显示', () => {
    expect(joinDateTime('2026-11-03', '14:30')).toBe('2026-11-03T14:30')
    expect(splitDateTime('2026-11-03T14:30')).toEqual({ day: '2026-11-03', time: '14:30' })
    expect(splitDateTime('2026-11-03')).toBeUndefined()
    expect(splitDateTime('2026-11-03T24:00')).toBeUndefined()
    expect(splitDateTime('2026-11-31T10:00')).toBeUndefined()
    expect(formatDateTime('2026-11-03T14:30')).toBe('2026-11-03 14:30')
  })
})
