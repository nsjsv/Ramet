/* ---------- 页面的区：公共区 / 我的私人区 / 分享给我的（侧栏分栏、换区入口、页头标记、@ 的 AI 共用） ----------
 * 区只看页面自己的 private_owner（服务端保证子页与父页同区，前端不沿父链推导）：空 = 公共区，是我 = 我的私人区，
 * 是别人 = 别人分享给我的（别人的私人页只有分享给了我才会出现在我的页面列表里，见 page-share.ts）。
 * 谁能把公共页挪进私人区与服务端 page-area.ts 同口径（页面创建人、空间 owner）；服务端照判，这里只决定给不给入口。 */
import type { Page } from './api'

export type PageArea = 'public' | 'private' | 'shared'

export function areaOf(page: Pick<Page, 'private_owner'>, me: string): PageArea {
  if (!page.private_owner) return 'public'
  return page.private_owner === me ? 'private' : 'shared'
}

export function isPrivatePage(page: Pick<Page, 'private_owner'> | null | undefined): boolean {
  return !!page?.private_owner
}

/** 一棵树里属于这一区的页（调用方已经按空间、页面树成员筛过） */
export function pagesOfArea<P extends Pick<Page, 'private_owner'>>(pages: readonly P[], area: PageArea, me: string): P[] {
  return pages.filter((p) => areaOf(p, me) === area)
}

/** 公共页能不能挪进私人区：挪进去别人就看不到它和它的子页了，只给创建人和空间 owner */
export function canPrivatize(page: Pick<Page, 'owner_id' | 'private_owner'>, me: string, spaceRole: string | null | undefined): boolean {
  if (page.private_owner) return false
  return page.owner_id === me || spaceRole === 'owner'
}

/** 拖动 / 菜单换区之前要先确认的那句话；同区挪动不用确认。分享给我的页不能换区（只有主人能，界面不给入口） */
export function areaChangeConfirm(from: PageArea, to: PageArea): 'to-private' | 'to-public' | null {
  if (from === to || from === 'shared' || to === 'shared') return null
  return to === 'private' ? 'to-private' : 'to-public'
}
