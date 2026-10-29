import { expect, test } from 'vitest'
import type { Space } from './api'
import { spaceReadOnly } from './space-role'

// 只有所在空间里我是 viewer 才只读；空间不在列表里（列表未到）不算只读

const space = (id: string, my_role: Space['my_role']): Space => ({ id, name: id, owner_id: 'u', is_personal: false, created_at: '', my_role }) as Space

test('viewer 只读，member / owner 可写，不在列表里不算只读', () => {
  const spaces = [space('a', 'viewer'), space('b', 'member'), space('c', 'owner')]
  expect(spaceReadOnly(spaces, 'a')).toBe(true)
  expect(spaceReadOnly(spaces, 'b')).toBe(false)
  expect(spaceReadOnly(spaces, 'c')).toBe(false)
  expect(spaceReadOnly(spaces, 'zzz')).toBe(false)
  expect(spaceReadOnly(spaces, null)).toBe(false)
  expect(spaceReadOnly(null, 'a')).toBe(false)
})
