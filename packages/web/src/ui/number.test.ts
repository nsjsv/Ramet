import { describe, expect, test } from 'vitest'
import { clampNumber, commitNumber, formatNumber, parseNumberText, stepNumber } from './number'

describe('parseNumberText', () => {
  test('空 = null，不是数字 = undefined', () => {
    expect(parseNumberText('')).toBeNull()
    expect(parseNumberText('   ')).toBeNull()
    expect(parseNumberText('abc')).toBeUndefined()
    expect(parseNumberText('1.2.3')).toBeUndefined()
    expect(parseNumberText('12px')).toBeUndefined()
    expect(parseNumberText('Infinity')).toBeUndefined()
    expect(parseNumberText('1e999')).toBeUndefined()
  })

  test('正负号、小数、千分位、科学计数', () => {
    expect(parseNumberText(' 42 ')).toBe(42)
    expect(parseNumberText('-3.5')).toBe(-3.5)
    expect(parseNumberText('+7')).toBe(7)
    expect(parseNumberText('.5')).toBe(0.5)
    expect(parseNumberText('1,234')).toBe(1234)
    expect(parseNumberText('2e3')).toBe(2000)
  })
})

describe('clampNumber / commitNumber', () => {
  const port = { min: 1024, max: 65535, integer: true }

  test('越界夹到边上，整数四舍五入', () => {
    expect(clampNumber(80, port)).toBe(1024)
    expect(clampNumber(70000, port)).toBe(65535)
    expect(clampNumber(3000.6, port)).toBe(3001)
    expect(clampNumber(-1.5, {})).toBe(-1.5)
  })

  test('非法回退（undefined），清空只在 nullable 时提交 null', () => {
    expect(commitNumber('abc', port)).toBeUndefined()
    expect(commitNumber('', port)).toBeUndefined()
    expect(commitNumber('', { ...port, nullable: true })).toBeNull()
    expect(commitNumber('8080', port)).toBe(8080)
    expect(commitNumber('99', { min: 1, max: 30, integer: true })).toBe(30)
  })
})

describe('stepNumber', () => {
  test('从草稿走一步并收进范围', () => {
    expect(stepNumber('7', 7, 1, { min: 1, max: 30 })).toBe(8)
    expect(stepNumber('30', 30, 10, { min: 1, max: 30 })).toBe(30)
    expect(stepNumber('1', 1, -1, { min: 1 })).toBe(1)
  })

  test('草稿读不出时从原值，原值也没有时从 0（带 min 时第一下落在 min 上）', () => {
    expect(stepNumber('x', 5, 1, {})).toBe(6)
    expect(stepNumber('', null, 1, { min: 1024 })).toBe(1024)
    expect(stepNumber('', null, 1, { min: 1 })).toBe(1)
    expect(stepNumber('', null, -1, { min: 1 })).toBe(1)
    expect(stepNumber('', null, -1, {})).toBe(-1)
  })

  test('小数步长不出浮点尾巴', () => {
    expect(stepNumber('0.2', null, 0.1, {})).toBe(0.3)
    expect(stepNumber('1.25', null, 0.1, {})).toBe(1.35)
  })
})

test('formatNumber', () => {
  expect(formatNumber(null)).toBe('')
  expect(formatNumber(12)).toBe('12')
})
