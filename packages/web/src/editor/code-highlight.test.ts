import { describe, expect, test } from 'vitest'
import { createLowlight, common } from 'lowlight'
import { highlightRanges } from './code-highlight'
import { findLang, highlightName, langLabel } from './code-langs'

/* 不变量（code-highlight.ts / code-langs.ts 文件头）：token 是扁平、有序、不重叠的区间，拼回去就是原文；
 * 语言名按表与别名归一，lowlight 不认识的语言不出 token。 */

const lowlight = createLowlight(common)

describe('highlightRanges', () => {
  test('JS：关键字 / 字符串出 token，区间有序不重叠，覆盖的文字与原文一致', () => {
    const code = "const a = 'x' // c"
    const tokens = highlightRanges(lowlight, code, 'js')
    expect(tokens.find((t) => code.slice(t.from, t.to) === 'const')?.cls).toContain('hljs-keyword')
    expect(tokens.find((t) => code.slice(t.from, t.to) === "'x'")?.cls).toContain('hljs-string')
    for (let i = 1; i < tokens.length; i++) expect(tokens[i]!.from).toBeGreaterThanOrEqual(tokens[i - 1]!.to)
  })

  test('嵌套 span 的 class 拼在一起', () => {
    const code = 'const s = `a${b}`'
    const tokens = highlightRanges(lowlight, code, 'javascript')
    expect(tokens.some((t) => t.cls.split(' ').length > 1)).toBe(true)
  })

  test('不认识的语言 / mermaid / 空串：没有 token', () => {
    expect(highlightRanges(lowlight, 'x', 'no-such-lang')).toEqual([])
    expect(highlightRanges(lowlight, 'graph TD; A-->B', 'mermaid')).toEqual([])
    expect(highlightRanges(lowlight, '', 'js')).toEqual([])
  })

  test('HTML 走 xml 语法', () => {
    expect(highlightName('html')).toBe('xml')
    expect(highlightRanges(lowlight, '<a href="x">y</a>', 'html').length).toBeGreaterThan(0)
  })
})

describe('语言表', () => {
  test('别名、大小写归一；不认识的原样显示，空 = 纯文本', () => {
    expect(findLang('TS')?.id).toBe('typescript')
    expect(langLabel('py')).toBe('Python')
    expect(langLabel('cobol')).toBe('cobol')
    expect(langLabel('')).toBe('纯文本')
  })
})
