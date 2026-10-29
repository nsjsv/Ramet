/* ---------- 收件箱的客户端状态（module store + useSyncExternalStore）----------
 * 服务端状态就是 GET /api/inbox 的结果，没有增量协议：control:global 上的 'inbox' 信号（服务端 300ms 去抖、不带内容）
 * 只触发重拉。这里再去抖一次并合并并发的拉取（在飞时来的信号排队再拉一次，不丢）。
 * 乐观更新只做摘除（答完审批、批准机器、知道了、打开了页面），以下一次重拉为准。
 * 不另开连接，订阅 control.ts 已有的那一条；退出登录后拆掉。 */

import { useSyncExternalStore } from 'react'
import { subscribeControl } from '../control'
import { inboxApi, type InboxItem } from './inbox-api'
import { dropByKey, dropDoneOf, hasDoneOf } from './inbox-model'

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
    // 正开着的对话页上做完的回合，用户就在眼前：直接算看过，别让收件箱再催一遍
    if (openPageId && hasDoneOf(items, openPageId)) markPageSeen(openPageId, true)
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

/** 当前打开的对话页（App 的路由 effect 设置） */
let openPageId: string | null = null
const seenAt = new Map<string, number>()
const SEEN_THROTTLE_MS = 10_000

export function setOpenPage(pageId: string | null): void {
  openPageId = pageId
}

/** 打开了这个对话页：告诉服务端（「做完待你看」据此消掉），本地先摘。10 秒内同一页不重复发；失败静默（读不到的页面服务端回 404） */
export function markPageSeen(pageId: string, force = false): void {
  const now = Date.now()
  if (!force && now - (seenAt.get(pageId) ?? 0) < SEEN_THROTTLE_MS) return
  seenAt.set(pageId, now)
  const items = dropDoneOf(state.items, pageId)
  if (items !== state.items) set({ ...state, items })
  void inboxApi.seen(pageId).catch(() => undefined)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useInbox(): State {
  return useSyncExternalStore(subscribe, () => state)
}
