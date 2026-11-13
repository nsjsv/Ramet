import { describe, expect, it } from 'vitest'
import { canWritePage, isGuestIn, isSharedToMe, nearestShare, shareLevelOf } from './page-share'
import type { MyShare } from './share/share-api'

// bob 的私人树：root → mid → leaf；另有公共页 pub（空间 s1）
const pages = [
  { id: 'root', parent_id: null, space_id: 's1', private_owner: 'bob' },
  { id: 'mid', parent_id: 'root', space_id: 's1', private_owner: 'bob' },
  { id: 'leaf', parent_id: 'mid', space_id: 's1', private_owner: 'bob' },
  { id: 'pub', parent_id: null, space_id: 's1', private_owner: null },
  { id: 'mine', parent_id: null, space_id: 's1', private_owner: 'me' },
]
const byId = new Map(pages.map((p) => [p.id, p]))
const lookup = (id: string) => byId.get(id)
const shares = (...list: [string, 'edit' | 'view'][]): Map<string, MyShare> => new Map(list.map(([pageId, level]) => [pageId, { pageId, level, by: 'bob', spaceId: 's1' }]))

describe('分享给我的', () => {
  it('档位沿父链继承，有一处可编辑就可编辑；最近的那条给面包屑', () => {
    const s = shares(['root', 'view'], ['mid', 'edit'])
    expect(shareLevelOf('root', lookup, s)).toBe('view')
    expect(shareLevelOf('leaf', lookup, s)).toBe('edit')
    expect(shareLevelOf('pub', lookup, s)).toBeNull()
    expect(nearestShare('leaf', lookup, s)?.pageId).toBe('mid')
  })

  it('别人的私人页才算分享给我的', () => {
    expect(isSharedToMe(pages[0]!, 'me')).toBe(true)
    expect(isSharedToMe(pages[3]!, 'me')).toBe(false)
    expect(isSharedToMe(pages[4]!, 'me')).toBe(false)
  })

  it('能不能写：区给的与分享给的取更宽；别人的私人页不看空间角色', () => {
    const viewer = [{ id: 's1', my_role: 'viewer' as const }]
    const owner = [{ id: 's1', my_role: 'owner' as const }]
    expect(canWritePage(byId.get('pub')!, lookup, viewer, 'me', shares())).toBe(false)
    expect(canWritePage(byId.get('pub')!, lookup, viewer, 'me', shares(['pub', 'edit']))).toBe(true)
    expect(canWritePage(byId.get('pub')!, lookup, owner, 'me', shares())).toBe(true)
    expect(canWritePage(byId.get('leaf')!, lookup, owner, 'me', shares(['root', 'view']))).toBe(false)
    expect(canWritePage(byId.get('leaf')!, lookup, viewer, 'me', shares(['mid', 'edit']))).toBe(true)
    expect(canWritePage(byId.get('mine')!, lookup, null, 'me', shares())).toBe(true)
  })

  it('访客：空间不在我的成员空间里；只看分享的档位；空间列表没到不算访客', () => {
    const elsewhere = [{ id: 's2', my_role: 'owner' as const }]
    expect(isGuestIn('s1', elsewhere)).toBe(true)
    expect(isGuestIn('s2', elsewhere)).toBe(false)
    expect(isGuestIn('s1', null)).toBe(false)
    expect(canWritePage(byId.get('pub')!, lookup, elsewhere, 'me', shares())).toBe(false)
    expect(canWritePage(byId.get('pub')!, lookup, elsewhere, 'me', shares(['pub', 'view']))).toBe(false)
    expect(canWritePage(byId.get('pub')!, lookup, elsewhere, 'me', shares(['pub', 'edit']))).toBe(true)
  })
})
