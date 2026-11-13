/* ---------- 分享给我的（侧栏「分享给我的」、页面只读、面包屑、空间切换器的「作为访客」共用） ----------
 * 一页给我的权限 = 区给的（公共区 / 我自己的私人区：按我在空间里的角色）与分享给的（这页或祖先直接分享给我的，取最宽）里更宽的那个，
 * 与服务端 page-visibility.ts 同口径；服务端照判（REST 403、协同只读），这里只决定界面给不给写入口。
 * 「分享给我的」列表随页面列表同步刷新：同步的成员指纹带着分享（服务端 page-sync.ts），指纹变了才重拉，不另开连接、不轮询。 */
import { useSyncExternalStore } from 'react'
import type { Page, Space } from './api'
import { selfId, subscribePeople } from './people'
import { shareApi, type GuestSpace, type MyShare, type ShareLevel } from './share/share-api'

export type SharesState = {
  /** 这份数据属于谁（换账号后旧数据不能拿来判断） */
  uid: string
  loaded: boolean
  byPage: ReadonlyMap<string, MyShare>
  /** 我作为访客进得去的空间（服务端算：有页分享给我、我又不是成员） */
  guestSpaces: readonly GuestSpace[]
}

type Lookup = (id: string) => Pick<Page, 'id' | 'parent_id'> | undefined

/** 这页或祖先上直接分享给我的那些，近的在前（沿父链往上，环 / 缺父即停） */
function sharesUp(pageId: string, lookup: Lookup, byPage: ReadonlyMap<string, MyShare>): MyShare[] {
  const out: MyShare[] = []
  const seen = new Set<string>()
  for (let cur = lookup(pageId); cur && !seen.has(cur.id); cur = cur.parent_id ? lookup(cur.parent_id) : undefined) {
    seen.add(cur.id)
    const hit = byPage.get(cur.id)
    if (hit) out.push(hit)
  }
  return out
}

/** 分享给我的档位：这页或祖先上给的，有一处可编辑就是可编辑；没有 = null */
export function shareLevelOf(pageId: string, lookup: Lookup, byPage: ReadonlyMap<string, MyShare>): ShareLevel | null {
  const hits = sharesUp(pageId, lookup, byPage)
  if (hits.length === 0) return null
  return hits.some((s) => s.level === 'edit') ? 'edit' : 'view'
}

/** 最近的那条分享（面包屑悬停写谁分享的） */
export function nearestShare(pageId: string, lookup: Lookup, byPage: ReadonlyMap<string, MyShare>): MyShare | null {
  return sharesUp(pageId, lookup, byPage)[0] ?? null
}

/** 我在这个空间是访客：不在我的成员空间里（空间列表没到时不算，免得先把写入口全关了再打开） */
export function isGuestIn(spaceId: string | null | undefined, spaces: readonly Pick<Space, 'id'>[] | null): boolean {
  return !!spaceId && spaces !== null && !spaces.some((s) => s.id === spaceId)
}

/** 别人的私人页（只可能是分享给我的才会出现在我的页面列表里） */
export function isSharedToMe(page: Pick<Page, 'private_owner'>, me: string): boolean {
  return !!page.private_owner && page.private_owner !== me
}

/** 我在这页上能不能写（owner / member 或可编辑的分享）。空间列表还没到时区给的按可写算（同 spaceReadOnly 的缺省），
 *  分享还没到时分享给的按没有算 */
export function canWritePage(
  page: Pick<Page, 'id' | 'parent_id' | 'space_id' | 'private_owner'>,
  lookup: Lookup,
  spaces: readonly Pick<Space, 'id' | 'my_role'>[] | null,
  me: string,
  byPage: ReadonlyMap<string, MyShare>,
): boolean {
  if (!isSharedToMe(page, me)) {
    const role = spaces === null ? 'member' : spaces.find((s) => s.id === page.space_id)?.my_role
    if (role === 'owner' || role === 'member') return true
  }
  return shareLevelOf(page.id, lookup, byPage) === 'edit'
}

/* ---------- store ---------- */

let state: SharesState = { uid: '', loaded: false, byPage: new Map(), guestSpaces: [] }
let lastKey = ''
let seq = 0
const listeners = new Set<() => void>()

/** 每次页面同步后调用：同步指纹（含分享）变了，或换了账号，就重拉「分享给我的」 */
export function noteSyncKey(uid: string, members: string): void {
  const key = `${uid}\n${members}`
  if (key === lastKey) return
  lastKey = key
  const mine = ++seq
  shareApi.mine().then(
    (res) => {
      if (mine !== seq) return
      state = { uid, loaded: true, byPage: new Map(res.shares.map((s) => [s.pageId, s])), guestSpaces: res.guestSpaces }
      listeners.forEach((l) => l())
    },
    (err: unknown) => {
      // 下次指纹变了再试；这次当作没有分享（只读兜底，服务端照判）
      console.error(err)
      if (mine === seq) lastKey = ''
    },
  )
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

const EMPTY: SharesState = { uid: '', loaded: false, byPage: new Map(), guestSpaces: [] }

/** 当前账号的「分享给我的」；别的账号留下的数据当没有 */
export function useMyShares(me: string): SharesState {
  const cur = useSyncExternalStore(subscribe, () => state)
  return cur.uid === me ? cur : EMPTY
}

/** 当前登录用户 id（登录态镜像，people.ts）：不在 React 树里拿到 user 的组件用 */
export function useSelfId(): string {
  return useSyncExternalStore(subscribePeople, selfId)
}
