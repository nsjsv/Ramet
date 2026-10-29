import { expect, test } from 'vitest'
import { parseRange } from './files.js'

/* 不变量（routes/files.ts parseRange）：单段 Range 解析成闭区间，越界 416，多段 / 坏格式忽略（回整个文件）。 */

test('单段：a-b / a- / -n', () => {
  expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
  expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 })
  expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
  expect(parseRange('bytes=990-2000', 1000)).toEqual({ start: 990, end: 999 })
})

test('越界 = 416；多段 / 坏格式 / 没有 = 整个文件', () => {
  expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable')
  expect(parseRange('bytes=0-1,5-9', 1000)).toBeNull()
  expect(parseRange('items=0-1', 1000)).toBeNull()
  expect(parseRange(undefined, 1000)).toBeNull()
})
