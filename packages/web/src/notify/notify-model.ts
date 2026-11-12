/* ---------- 系统通知的纯函数：这台设备走哪条通道、收件箱里哪些是新的、多标签页抢占（有单测）---------- */

import { moreNotice, noticeIdent, noticeOf, type Notice, type NoticeItem } from '@ramet/shared/inbox-notice'

export type Channel = 'push' | 'desktop' | 'off'

/** 为什么是这条通道（设置页照着说人话） */
export type ChannelReason =
  | 'insecure' // 不是 https：浏览器不给通知
  | 'ios-install' // iOS 没添加到主屏幕
  | 'unsupported' // 浏览器没有通知能力
  | 'disabled' // 这台设备没开
  | 'denied' // 浏览器里拒绝了通知权限
  | 'not-granted' // 开过，但权限被重置成了「询问」
  | 'push' // 走推送
  | 'no-push' // 浏览器不支持推送，退回桌面通知
  | 'push-unavailable' // 订阅失败（如连不上浏览器自己的推送服务），退回桌面通知
  | 'push-failing' // 服务端最近推不出去，退回桌面通知
  | 'push-pending' // 正在登记推送，先用桌面通知

export type DeviceState = {
  enabled: boolean
  secure: boolean
  iosNeedsInstall: boolean
  canNotify: boolean
  permission: NotificationPermission
  pushSupported: boolean
  /** 服务端登记着这台设备的推送订阅 */
  subscribed: boolean
  /** 服务端最近一次推送失败的原因（成功后清空） */
  serverError: string | null
  /** 浏览器订阅推送时的错误 */
  subscribeError: string | null
}

/** 一台设备只走一条通道（同一件事不弹两次）：推送通 → 推送；否则标签页开着时弹桌面通知 */
export function channelOf(d: DeviceState): { channel: Channel; reason: ChannelReason } {
  if (!d.secure) return { channel: 'off', reason: 'insecure' }
  if (d.iosNeedsInstall) return { channel: 'off', reason: 'ios-install' }
  if (!d.canNotify) return { channel: 'off', reason: 'unsupported' }
  if (!d.enabled) return { channel: 'off', reason: 'disabled' }
  if (d.permission === 'denied') return { channel: 'off', reason: 'denied' }
  if (d.permission !== 'granted') return { channel: 'off', reason: 'not-granted' }
  if (d.subscribed && !d.serverError) return { channel: 'push', reason: 'push' }
  if (!d.pushSupported) return { channel: 'desktop', reason: 'no-push' }
  if (d.subscribeError) return { channel: 'desktop', reason: 'push-unavailable' }
  if (d.serverError) return { channel: 'desktop', reason: 'push-failing' }
  return { channel: 'desktop', reason: 'push-pending' }
}

/** 这次收件箱里新出现的通知。known = 这个标签页见过的全部身份（null = 第一次加载，只记基线、不通知）。
 *  known 只增不减：乐观摘掉的条目被下一次重拉带回来时，不能当成新的再弹一遍 */
export function freshNotices(
  known: Set<string> | null,
  items: readonly NoticeItem[],
): { known: Set<string>; fresh: { ident: string; notice: Notice }[] } {
  const next = new Set(known ?? [])
  const fresh: { ident: string; notice: Notice }[] = []
  for (const item of items) {
    const ident = noticeIdent(item)
    if (next.has(ident)) continue
    next.add(ident)
    const notice = noticeOf(item)
    if (known && notice) fresh.push({ ident, notice })
  }
  return { known: next, fresh }
}

/** 一次太多：前 max - 1 条照弹，其余合成一条 */
export function capNotices(list: Notice[], max: number): Notice[] {
  return list.length > max ? [...list.slice(0, max - 1), moreNotice(list.length - (max - 1))] : list
}

export const CLAIM_KEEP = 200

/** 同一台设备的多个标签页抢同一条：抢到返回新的记录表，已被抢走返回 null */
export function claim(list: readonly string[], ident: string): string[] | null {
  if (list.includes(ident)) return null
  return [...list, ident].slice(-CLAIM_KEEP)
}

/** base64url → 字节（applicationServerKey 要字节） */
export function b64uBytes(text: string): Uint8Array {
  const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

/** 已有订阅用的是不是这把公钥（服务器换过密钥后旧订阅推不进来，要重订） */
export function sameKey(current: ArrayBuffer | null | undefined, publicKey: string): boolean {
  if (!current) return false
  const a = new Uint8Array(current)
  const b = b64uBytes(publicKey)
  return a.length === b.length && a.every((v, i) => v === b[i])
}
