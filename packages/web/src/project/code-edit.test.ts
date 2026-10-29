import { describe, expect, test } from 'vitest'
import { cleanReplacement, contextAround, previewRows, replaceLines, selectedText, selectionLines } from './code-edit'

const FILE = 'line1\nline2\nline3\nline4\nline5\n'
const at = (needle: string): number => FILE.indexOf(needle)

describe('selectionLines：选区的字符偏移 → 盖住的行', () => {
  test('单行 / 多行 / 选了半行也算整行', () => {
    expect(selectionLines(FILE, at('line2'), at('line2') + 5)).toEqual({ from: 2, to: 2 })
    expect(selectionLines(FILE, at('line2') + 2, at('line4') + 2)).toEqual({ from: 2, to: 4 })
  })

  test('终点刚好在下一行行首（连换行一起选）不算选了下一行', () => {
    expect(selectionLines(FILE, at('line2'), at('line3'))).toEqual({ from: 2, to: 2 })
    expect(selectionLines(FILE, at('line2'), at('line4'))).toEqual({ from: 2, to: 3 })
  })

  test('空选区 / 只选了换行与空白 → null；反向选区（终点在前）一样算', () => {
    expect(selectionLines(FILE, 3, 3)).toBeNull()
    expect(selectionLines('a\n\n\nb\n', 2, 4)).toBeNull()
    expect(selectionLines(FILE, at('line4') + 2, at('line2'))).toEqual({ from: 2, to: 4 })
  })

  test('文件末尾没有换行的最后一行、越界的偏移', () => {
    expect(selectionLines('a\nb', 2, 3)).toEqual({ from: 2, to: 2 })
    expect(selectionLines('a\nb', 0, 999)).toEqual({ from: 1, to: 2 })
  })
})

describe('selectedText / contextAround', () => {
  test('选中行原文带行尾；前后文各取靠近选区的一段', () => {
    expect(selectedText(FILE, { from: 2, to: 3 })).toBe('line2\nline3\n')
    const c = contextAround(FILE, { from: 3, to: 3 })
    expect(c).toEqual({ text: 'line3\n', before: 'line1\nline2\n', after: 'line4\nline5\n' })
  })

  test('前后文很长时只留靠近选区的 2000 字', () => {
    const long = `${'a\n'.repeat(5000)}MID\n${'b\n'.repeat(5000)}`
    const c = contextAround(long, { from: 5001, to: 5001 })
    expect(c.text).toBe('MID\n')
    expect(c.before.length).toBe(2000)
    expect(c.before.endsWith('a\n')).toBe(true)
    expect(c.after.length).toBe(2000)
    expect(c.after.startsWith('b\n')).toBe(true)
  })
})

describe('cleanReplacement：模型输出 → 替换用的代码', () => {
  test('去掉外面包的围栏与首尾空行，里面的缩进不动', () => {
    expect(cleanReplacement('```ts\n  const a = 1\n  const b = 2\n```\n', 'x')).toBe('  const a = 1\n  const b = 2')
    expect(cleanReplacement('\n\nfoo()\n\n', 'x')).toBe('foo()')
    expect(cleanReplacement('~~~\nx\n~~~', 'x')).toBe('x')
  })

  test('围栏不在两头（代码里本来就有 ```）不动；CRLF 归一；全空 → 空串', () => {
    expect(cleanReplacement('a\n```\nb', 'x')).toBe('a\n```\nb')
    expect(cleanReplacement('a\r\nb', 'x')).toBe('a\nb')
    expect(cleanReplacement('\n\n', 'x')).toBe('')
  })

  test('原文自己带围栏（在改 markdown 里的代码块）：围栏是内容，不剥', () => {
    const md = '```js\nold()\n```'
    expect(cleanReplacement('```js\nnew()\n```', md)).toBe('```js\nnew()\n```')
  })

  test('流式生成中：开头的围栏行先不画；没有围栏的照常', () => {
    expect(cleanReplacement('```ts\nconst a', 'x', true)).toBe('const a')
    expect(cleanReplacement('```ts', 'x', true)).toBe('')
    expect(cleanReplacement('const a = 1\ncon', 'x', true)).toBe('const a = 1\ncon')
    expect(cleanReplacement('```ts\nconst a', 'x', false)).toBe('```ts\nconst a')
  })
})

describe('replaceLines：只换选中的行，别的一个字不动', () => {
  test('中间几行换成不同行数的新内容', () => {
    expect(replaceLines(FILE, { from: 2, to: 3 }, 'X\nY\nZ')).toBe('line1\nX\nY\nZ\nline4\nline5\n')
    expect(replaceLines(FILE, { from: 2, to: 3 }, 'only')).toBe('line1\nonly\nline4\nline5\n')
  })

  test('删除（空结果）= 整行拿掉，不留空行', () => {
    expect(replaceLines(FILE, { from: 2, to: 3 }, '')).toBe('line1\nline4\nline5\n')
  })

  test('文件末尾没有换行：被换的是最后一行，新内容末尾也不加', () => {
    expect(replaceLines('a\nb', { from: 2, to: 2 }, 'B1\nB2')).toBe('a\nB1\nB2')
    expect(replaceLines('a\nb\n', { from: 2, to: 2 }, 'B')).toBe('a\nB\n')
  })

  test('CRLF 文件：新行也用 CRLF，没被选中的行原样', () => {
    expect(replaceLines('a\r\nb\r\nc\r\n', { from: 2, to: 2 }, 'B1\nB2')).toBe('a\r\nB1\r\nB2\r\nc\r\n')
  })

  test('第一行 / 全部行', () => {
    expect(replaceLines(FILE, { from: 1, to: 1 }, 'first')).toBe('first\nline2\nline3\nline4\nline5\n')
    expect(replaceLines('a\nb\n', { from: 1, to: 2 }, 'z')).toBe('z\n')
  })
})

describe('previewRows：就地 diff', () => {
  const rows = (r: { from: number; to: number }, rep: string, trim: boolean) => previewRows(FILE, r, rep, { trim, context: 1 })

  test('生成中：旧的整段当删除、新的整段当新增，前后各一行上下文，行号对得上', () => {
    expect(rows({ from: 2, to: 3 }, 'X\nY\nZ', false)).toEqual([
      { kind: 'ctx', text: 'line1', old: 1, new: 1 },
      { kind: 'del', text: 'line2', old: 2 },
      { kind: 'del', text: 'line3', old: 3 },
      { kind: 'add', text: 'X', new: 2 },
      { kind: 'add', text: 'Y', new: 3 },
      { kind: 'add', text: 'Z', new: 4 },
      { kind: 'ctx', text: 'line4', old: 4, new: 5 },
      { kind: 'hunk', text: '' },
    ])
  })

  test('生成完（trim）：头尾没变的行挪回上下文，只标真正改了的', () => {
    expect(rows({ from: 2, to: 4 }, 'line2\nCHANGED\nline4', true)).toEqual([
      { kind: 'ctx', text: 'line1', old: 1, new: 1 },
      { kind: 'ctx', text: 'line2', old: 2, new: 2 },
      { kind: 'del', text: 'line3', old: 3 },
      { kind: 'add', text: 'CHANGED', new: 3 },
      { kind: 'ctx', text: 'line4', old: 4, new: 4 },
      { kind: 'ctx', text: 'line5', old: 5, new: 5 },
    ])
  })

  test('删除（空结果）：只有删除行；新旧完全一样（trim）：没有 del / add', () => {
    const del = rows({ from: 2, to: 2 }, '', true)
    expect(del.filter((l) => l.kind === 'add')).toEqual([])
    expect(del.filter((l) => l.kind === 'del')).toEqual([{ kind: 'del', text: 'line2', old: 2 }])
    expect(del.find((l) => l.text === 'line3')).toMatchObject({ old: 3, new: 2 })
    const same = rows({ from: 2, to: 3 }, 'line2\nline3', true)
    expect(same.some((l) => l.kind === 'del' || l.kind === 'add')).toBe(false)
  })

  test('选区在文件头 / 尾：没有省略号（上下文够不着的那一侧）', () => {
    const top = previewRows(FILE, { from: 1, to: 1 }, 'X', { trim: false, context: 1 })
    expect(top[0]).toEqual({ kind: 'del', text: 'line1', old: 1 })
    // 离文件头远：上面补一行省略
    expect(previewRows(FILE, { from: 4, to: 4 }, 'X', { trim: false, context: 1 })[0]).toEqual({ kind: 'hunk', text: '' })
    const bottom = previewRows(FILE, { from: 5, to: 5 }, 'X', { trim: false, context: 1 })
    expect(bottom.at(-1)).toEqual({ kind: 'add', text: 'X', new: 5 })
  })
})
