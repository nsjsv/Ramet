/* ---------- 收件箱的客户端状态（module store + useSyncExternalStore）----------
 * 服务端状态就是 GET /api/inbox 的结果，没有增量协议：control:global 上的 'inbox' 信号（服务端 300ms 去抖、不带内容）
 * 只触发重拉。这里再去抖一次并合并并发的拉取（在飞时来的信号排队再拉一次，不丢）。
 * 乐观更新只做摘除（答完审批、批准机器、知道了、打开了页面），以下一次重拉为准。
 * 不另开连接，订阅 control.ts 已有的那一条；退出登录后拆掉。 */

import { useSyncExternalStore } from 'react'
import { subscribeControl } from '../control'
import { inboxApi, type InboxItem } from './inbox-api'
import { dropByKey, dropSeenOf, hasSeenOf } from './inbox-model'

type State = { items: InboxItem[]; loaded: boolean; failed: boolean }

const EMPTY: State = { items: [], loaded: false, failed: false }
let state: State = EMPTY
const listeners = new Set<() => void>()

function set(next: State): void {
  state = next
  for (const l of listeners) l()
}

let inflight = false
let again = false
let timer: number | undefined

/** 立即拉一次；已有一次在飞就排队再拉一次（在飞的那次可能漏掉刚发生的变化） */
export async function refreshInbox(): Promise<void> {
  if (inflight) {
    again = true
    return
  }
  inflight = true
  try {
    const items = await inboxApi.list()
    set({ items, loaded: true, failed: false })
    // 正开着的页面上做完的回合 / 新的 @，用户就在眼前：直接算看过，别让收件箱再催一遍
    for (const pageId of openPages.keys()) if (hasSeenOf(items, pageId)) markPageSeen(pageId, true)
  } catch (err) {
    console.error(err)
    set({ ...state, loaded: true, failed: true })
  } finally {
    inflight = false
    if (again) {
      again = false
      void refreshInbox()
    }
  }
}

/** 去抖后拉（收到服务端信号时） */
function scheduleRefresh(): void {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => void refreshInbox(), 200)
}

/** 登录壳里调一次：先拉一次，之后跟着 control:global 的 'inbox'（和重连补拉的 'sync'）走。返回拆除函数 */
export function startInboxSync(): () => void {
  void refreshInbox()
  const off = subscribeControl((ev) => {
    if (ev === 'inbox') scheduleRefresh()
    else if (ev === 'sync') void refreshInbox()
  })
  return () => {
    off()
    window.clearTimeout(timer)
    again = false
    set(EMPTY) // 换账号时不能让上一个人的条目留在内存里
  }
}

/** 乐观摘除一条（答完审批、批准 / 拒绝机器、知道了）；服务端的重拉随后校正 */
export function dropInboxItem(key: string): void {
  const items = dropByKey(state.items, key)
  if (items !== state.items) set({ ...state, items })
}

/** 正开着的对话页（路由上的那一页 + Genet 浮窗里的那一页）→ 开着它的处数 */
const openPages = new Map<string, number>()
const seenAt = new Map<string, number>()
const SEEN_THROTTLE_MS = 10_000

/** 登记一页正开着，返回注销（可以重复登记同一页，都注销了才算关） */
export function openPage(pageId: string): () => void {
  openPages.set(pageId, (openPages.get(pageId) ?? 0) + 1)
  let done = false
  return () => {
    if (done) return
    done = true
    const left = (openPages.get(pageId) ?? 1) - 1
    if (left > 0) openPages.set(pageId, left)
    else openPages.delete(pageId)
  }
}

/** 打开了这一页：告诉服务端（「做完待你看」「正文里 @了你」据此消掉），本地先摘。10 秒内同一页不重复发；失败静默（读不到的页面服务端回 404） */
export function markPageSeen(pageId: string, force = false): void {
  const now = Date.now()
  if (!force && now - (seenAt.get(pageId) ?? 0) < SEEN_THROTTLE_MS) return
  seenAt.set(pageId, now)
  const items = dropSeenOf(state.items, pageId)
  if (items !== state.items) set({ ...state, items })
  void inboxApi.seen(pageId).catch(() => undefined)
}

/** 非 React 的订阅方（桌面通知，notify/desktop.ts）：每次状态变化拿到最新的 */
export function onInboxChange(cb: (s: { items: InboxItem[]; loaded: boolean; failed: boolean }) => void): () => void {
  const listener = (): void => cb(state)
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useInbox(): State {
  return useSyncExternalStore(subscribe, () => state)
}
