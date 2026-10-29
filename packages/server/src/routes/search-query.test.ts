import { expect, test } from 'vitest'
import { buildSearch } from './search.js'

/* 不变量（routes/search.ts buildSearch）：空白切词、去重、最多 8 个；LIKE 通配符按字面；整串小写判标题档位。 */

test('切词、去重、小写', () => {
  const q = buildSearch('  会议  纪要 会议 ')!
  expect(q.terms).toEqual(['会议', '纪要'])
  expect(q.full).toBe('会议 纪要 会议')
})

test('% _ \\ 按字面转义', () => {
  const q = buildSearch('100%_a\\b')!
  expect(q.patterns).toEqual(['%100\\%\\_a\\\\b%'])
  expect(q.prefix).toBe('100\\%\\_a\\\\b%')
})

test('空串 = null；最多 8 个词', () => {
  expect(buildSearch('   ')).toBeNull()
  expect(buildSearch('a b c d e f g h i j')!.terms).toHaveLength(8)
})
