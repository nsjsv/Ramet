import { describe, expect, test } from 'vitest'
import { flattenTree, langOfPath, sizeLabel, splitPath, type DirState } from './file-tree'

const ok = (names: Array<[string, 'dir' | 'file']>, extra: Partial<DirState> = {}): DirState => ({
  status: 'ok',
  entries: names.map(([name, type]) => ({ name, type })),
  truncated: false,
  ...extra,
})

describe('flattenTree', () => {
  const dirs = new Map<string, DirState>([
    ['', ok([['src', 'dir'], ['lib', 'dir'], ['a.txt', 'file']])],
    ['src', ok([['deep', 'dir'], ['b.ts', 'file']])],
    ['src/deep', ok([['c.ts', 'file']])],
  ])

  test('只展开展开了的目录，缩进按深度', () => {
    expect(flattenTree(dirs, new Set()).map((r) => (r.kind === 'entry' ? `${r.depth}:${r.path}` : r.text))).toEqual(['0:src', '0:lib', '0:a.txt'])
    const rows = flattenTree(dirs, new Set(['src', 'src/deep']))
    expect(rows.map((r) => (r.kind === 'entry' ? `${r.depth}:${r.path}${r.open ? '*' : ''}` : r.text))).toEqual([
      '0:src*', '1:src/deep*', '2:src/deep/c.ts', '1:src/b.ts', '0:lib', '0:a.txt',
    ])
  })

  test('展开了但还没加载的目录显示加载中；失败带原因；空目录和截断各一行', () => {
    const rows = flattenTree(
      new Map<string, DirState>([
        ['', ok([['a', 'dir'], ['b', 'dir'], ['c', 'dir']], { truncated: true })],
        ['b', { status: 'error', entries: [], truncated: false, error: '没有访问权限' }],
        ['c', ok([])],
      ]),
      new Set(['a', 'b', 'c']),
    )
    expect(rows.map((r) => (r.kind === 'entry' ? r.path : typeof r.text === 'string' ? r.text : `error:${r.text.error}`))).toEqual([
      'a', 'loading', 'b', 'error:没有访问权限', 'c', 'empty', 'truncated',
    ])
  })

  test('文件被当成展开也不展开', () => {
    expect(flattenTree(dirs, new Set(['a.txt'])).filter((r) => r.kind === 'note')).toEqual([])
  })
})

describe('其它', () => {
  test('扩展名 → 语言；认文件名；不认识的不高亮', () => {
    expect(langOfPath('src/App.tsx')).toBe('typescript')
    expect(langOfPath('a/b/Dockerfile')).toBe('dockerfile')
    expect(langOfPath('Makefile')).toBe('makefile')
    expect(langOfPath('README.md')).toBe('markdown')
    expect(langOfPath('.gitignore')).toBe('')
    expect(langOfPath('data.unknownext')).toBe('')
    expect(langOfPath('noext')).toBe('')
  })

  test('大小与路径拆分', () => {
    expect(sizeLabel(12)).toBe('12 B')
    expect(sizeLabel(1536)).toBe('1.5 KB')
    expect(sizeLabel(20 * 1024)).toBe('20 KB')
    expect(sizeLabel(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(splitPath('src/a/b.ts')).toEqual({ dir: 'src/a/', name: 'b.ts' })
    expect(splitPath('b.ts')).toEqual({ dir: '', name: 'b.ts' })
  })
})
