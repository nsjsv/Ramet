/* 单页分享的 REST（服务端 routes/page-shares.ts）。判定全在服务端，这里只是调用 */
import { request } from '../api'

export type ShareLevel = 'edit' | 'view'
/** 直接分享给我的一页：by = 分享的人（删号了 = null） */
export type MyShare = { pageId: string; level: ShareLevel; by: string | null; spaceId: string }
/** 我作为访客进得去的空间（有页分享给我、我又不是成员） */
export type GuestSpace = { id: string; name: string }
/** 分享面板里的一个人：guest = 不是这个空间的成员（访客）；from = null 是直接给在这页上的；否则继承自那个祖先（我看不到它时 title = null） */
export type PageShare = { userId: string; username: string; level: ShareLevel; guest: boolean; from: null | { id: string; title: string | null } }
/** owner = 私人页的主人（公共页 null） */
export type PageShares = { owner: { id: string; username: string } | null; shares: PageShare[] }

const path = (pageId: string, userId?: string): string =>
  `/api/pages/${encodeURIComponent(pageId)}/shares${userId ? `/${encodeURIComponent(userId)}` : ''}`

export const shareApi = {
  mine: () => request<{ shares: MyShare[]; guestSpaces: GuestSpace[] }>('/api/me/shares'),
  list: (pageId: string) => request<PageShares>(path(pageId)),
  /** 按用户名邀请（空间外的人也行：成为访客） */
  invite: (pageId: string, username: string, level: ShareLevel) =>
    request<PageShares>(path(pageId), { method: 'POST', body: JSON.stringify({ username, level }) }),
  set: (pageId: string, userId: string, level: ShareLevel) =>
    request<PageShares>(path(pageId, userId), { method: 'PUT', body: JSON.stringify({ level }) }),
  remove: (pageId: string, userId: string) => request<PageShares>(path(pageId, userId), { method: 'DELETE' }),
}

/** 空间设置的访客卡（routes/space-guests.ts，空间 owner）：公共区的页给标题，私人区只计数 */
export type SpaceGuest = { userId: string; username: string; pages: Array<{ id: string; title: string; level: ShareLevel }>; privateCount: number }
export type SpaceGuests = { membersInvite: boolean; guests: SpaceGuest[] }

const guestsPath = (spaceId: string, userId?: string): string =>
  `/api/spaces/${encodeURIComponent(spaceId)}/guests${userId ? `/${encodeURIComponent(userId)}` : ''}`

export const guestsApi = {
  list: (spaceId: string) => request<SpaceGuests>(guestsPath(spaceId)),
  /** 成员能不能邀请访客（owner 一直能） */
  setPolicy: (spaceId: string, membersInvite: boolean) =>
    request<unknown>(guestsPath(spaceId), { method: 'PATCH', body: JSON.stringify({ membersInvite }) }),
  /** 移出空间：删他在这个空间收到的全部分享 */
  remove: (spaceId: string, userId: string) => request<unknown>(guestsPath(spaceId, userId), { method: 'DELETE' }),
}
