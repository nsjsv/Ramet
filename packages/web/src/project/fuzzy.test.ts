import { describe, expect, test } from 'vitest'
import { fuzzyFilter, fuzzyMatch } from './fuzzy'

describe('fuzzyMatch', () => {
  test('子序列命中，不区分大小写；不是子序列就没命中', () => {
    expect(fuzzyMatch('ApP', 'src/App.tsx')).not.toBeNull()
    expect(fuzzyMatch('xyz', 'src/App.tsx')).toBeNull()
    expect(fuzzyMatch('tsa', 'src/App.tsx')).toBeNull() // 顺序不对
  })

  test('返回命中字符的下标（高亮用）', () => {
    expect(fuzzyMatch('app', 'src/App.tsx')?.indices).toEqual([4, 5, 6])
  })

  test('空查询命中一切', () => {
    expect(fuzzyMatch('  ', 'a/b')).toEqual({ path: 'a/b', score: 0, indices: [] })
  })
})

describe('fuzzyFilter', () => {
  const paths = [
    'packages/web/src/App.tsx',
    'packages/web/src/api.ts',
    'packages/server/src/agents/manager.ts',
    'docs/application-notes.md',
    'README.md',
  ]

  test('文件名以查询开头的排前面', () => {
    expect(fuzzyFilter(paths, 'app')[0]!.path).toBe('packages/web/src/App.tsx')
    expect(fuzzyFilter(paths, 'readme').map((h) => h.path)).toEqual(['README.md'])
  })

  test('单词开头的缩写：路径分隔后的首字母', () => {
    expect(fuzzyFilter(paths, 'psam')[0]!.path).toBe('packages/server/src/agents/manager.ts')
  })

  test('驼峰首字母', () => {
    expect(fuzzyMatch('fb', 'src/fooBar.ts')?.indices).toEqual([4, 7])
  })

  test('限制条数；空查询按原顺序取前 N 条', () => {
    expect(fuzzyFilter(paths, '', 2).map((h) => h.path)).toEqual(paths.slice(0, 2))
    expect(fuzzyFilter(paths, 'a', 3)).toHaveLength(3)
  })
})
