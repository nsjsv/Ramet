import { describe, expect, test } from 'vitest'
import { countWords } from './word-count'

describe('countWords', () => {
  test('中文按字、英文按词、标点空白不计', () => {
    expect(countWords('')).toBe(0)
    expect(countWords('  \n ')).toBe(0)
    expect(countWords('你好 world')).toBe(3)
    expect(countWords('Hello, world!')).toBe(2)
    expect(countWords('123 个')).toBe(2)
    expect(countWords('你好，世界。')).toBe(4)
  })
  test('中英紧挨着也分得开；词内撇号 / 连字符 / 小数点不断词', () => {
    expect(countWords('用React写')).toBe(3)
    expect(countWords("don't stop well-known 3.14")).toBe(4)
    expect(countWords('こんにちは')).toBe(5)
  })
  test('块之间的换行把英文词隔开', () => {
    expect(countWords('end\nStart')).toBe(2)
  })
})
