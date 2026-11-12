/* ---------- 桌面通知：推送用不了的设备，在有 Ramet 标签页开着时弹 ----------
 * 跟着收件箱 store 走（不另开连接、不另拉接口）：每次重拉出新的条目，满足三件事才弹——
 *   这台设备的通道是 desktop（推送通的设备只走推送，同一件事不弹两次）、这台设备没人在用（presence.ts）、
 *   这一条被本标签页抢到（同一台设备开着几个标签页只弹一次；同 tag 兜底）。
 * 第一次加载只记基线：开着的页面一刷新不会把收件箱里已有的全弹一遍。 */

import { onInboxChange } from '../inbox/inbox-store'
import { capNotices, claim, freshNotices } from './notify-model'
import { deviceActive } from './presence'
import { currentChannel, showLocal } from './push-client'

const CLAIM_KEY = 'ramet:notified'
/** 一次重拉最多弹几条（合盖很久醒来补拉时不刷屏） */
const MAX_AT_ONCE = 3

function claimed(ident: string): boolean {
  try {
    const list = JSON.parse(localStorage.getItem(CLAIM_KEY) ?? '[]') as unknown
    const next = claim(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [], ident)
    if (!next) return false
    localStorage.setItem(CLAIM_KEY, JSON.stringify(next))
    return true
  } catch {
    // 读写不了 localStorage：各标签页各弹各的，靠同 tag 合并
    return true
  }
}

/** 登录壳挂载时调；返回拆除 */
export function startDesktopNotify(onOpen: (url: string) => void): () => void {
  let known: Set<string> | null = null
  return onInboxChange((s) => {
    if (!s.loaded || s.failed) return
    const { known: next, fresh } = freshNotices(known, s.items)
    known = next
    if (fresh.length === 0 || currentChannel() !== 'desktop' || deviceActive()) return
    const mine = fresh.filter((n) => claimed(n.ident)).map((n) => n.notice)
    for (const n of capNotices(mine, MAX_AT_ONCE)) void showLocal(n, onOpen).catch((err: unknown) => console.warn('[notify] 弹通知失败', err))
  })
}
