import { describe, expect, it } from 'vitest'
import { areaChangeConfirm, areaOf, canPrivatize, isPrivatePage, pagesOfArea } from './page-area'

describe('页面的区', () => {
  it('只看自己的 private_owner；旧缓存缺字段 = 公共；别人的 = 分享给我的', () => {
    expect(areaOf({ private_owner: 'u1' }, 'u1')).toBe('private')
    expect(areaOf({ private_owner: 'u2' }, 'u1')).toBe('shared')
    expect(areaOf({ private_owner: null }, 'u1')).toBe('public')
    expect(areaOf({}, 'u1')).toBe('public')
    expect(isPrivatePage(null)).toBe(false)
    expect(isPrivatePage({ private_owner: 'u1' })).toBe(true)
  })

  it('按区分页', () => {
    const pages = [
      { id: 'a', private_owner: null },
      { id: 'b', private_owner: 'me' },
      { id: 'c' },
      { id: 'd', private_owner: 'bob' },
    ]
    expect(pagesOfArea(pages, 'public', 'me').map((p) => p.id)).toEqual(['a', 'c'])
    expect(pagesOfArea(pages, 'private', 'me').map((p) => p.id)).toEqual(['b'])
    expect(pagesOfArea(pages, 'shared', 'me').map((p) => p.id)).toEqual(['d'])
  })

  it('挪进私人区：创建人、空间 owner 可以，别的成员不行；已经私人的不再给这个入口', () => {
    expect(canPrivatize({ owner_id: 'me', private_owner: null }, 'me', 'member')).toBe(true)
    expect(canPrivatize({ owner_id: 'bob', private_owner: null }, 'me', 'owner')).toBe(true)
    expect(canPrivatize({ owner_id: 'bob', private_owner: null }, 'me', 'member')).toBe(false)
    expect(canPrivatize({ owner_id: null, private_owner: null }, 'me', null)).toBe(false)
    expect(canPrivatize({ owner_id: 'me', private_owner: 'me' }, 'me', 'owner')).toBe(false)
  })

  it('换区的确认：同区不问，进私人区与回公共区各一句', () => {
    expect(areaChangeConfirm('public', 'public')).toBeNull()
    expect(areaChangeConfirm('public', 'private')).toBe('to-private')
    expect(areaChangeConfirm('private', 'public')).toBe('to-public')
    expect(areaChangeConfirm('shared', 'public')).toBeNull()
  })
})
