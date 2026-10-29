import { describe, expect, test } from 'vitest'
import { foldDiff, lineDiff } from './line-diff'

// 删 / 增 / 未变三种行按原顺序排；新文全部行 = 未变 + 新增，旧文全部行 = 未变 + 删除

const show = (lines: Array<{ t: string; s?: string; n?: number }>) => lines.map((l) => (l.t === '…' ? `…${l.n}` : `${l.t}${l.s}`))

describe('lineDiff', () => {
  test('改一行：删旧行、增新行，前后不动', () => {
    expect(show(lineDiff('a\nb\nc\n', 'a\nB\nc\n'))).toEqual([' a', '-b', '+B', ' c'])
  })

  test('新建文件（旧文空）= 全部新增；删光 = 全部删除', () => {
    expect(show(lineDiff('', 'x\ny'))).toEqual(['+x', '+y'])
    expect(show(lineDiff('x\ny', ''))).toEqual(['-x', '-y'])
  })

  test('完全相同 = 全是未变行', () => {
    expect(show(lineDiff('a\nb', 'a\nb'))).toEqual([' a', ' b'])
  })

  test('中间插入几行：对齐，不把后面的行全判成改动', () => {
    expect(show(lineDiff('1\n2\n3\n4', '1\n2\nnew\n3\n4'))).toEqual([' 1', ' 2', '+new', ' 3', ' 4'])
  })

  test('两边各自保住全部行', () => {
    const d = lineDiff('a\nb\nc\nd', 'b\nx\nd\ne')
    expect(d.filter((l) => l.t !== '+').map((l) => l.s)).toEqual(['a', 'b', 'c', 'd'])
    expect(d.filter((l) => l.t !== '-').map((l) => l.s)).toEqual(['b', 'x', 'd', 'e'])
  })
})

describe('foldDiff', () => {
  test('改动前后各留 3 行，其余折成「… N」', () => {
    const old = Array.from({ length: 20 }, (_, i) => `L${i}`).join('\n')
    const next = old.replace('L10', 'X')
    expect(show(foldDiff(lineDiff(old, next)))).toEqual(['…7', ' L7', ' L8', ' L9', '-L10', '+X', ' L11', ' L12', ' L13', '…6'])
  })
})
