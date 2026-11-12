/* ---------- 这台设备的系统通知：开关、service worker、推送订阅、通道状态（module store）----------
 * 开关按设备存在 localStorage（手机想收、电脑不想收），记的是谁开的：会话过期后换了别人登录，不能不经他同意就把这台设备转到他名下。打开时向浏览器要权限、注册 sw、订阅推送并登记到服务端；
 * 订阅失败（如国内的 Chrome 连不上 FCM）就退回桌面通知（desktop.ts），通道判定见 notify-model.ts 的 channelOf。
 * 启动时（登录壳挂载）开关开着且权限还在：补登订阅（服务端丢了 / 换了号）、查一次服务端推送状态，之后每小时再查。 */

import { useSyncExternalStore } from 'react'
import type { Notice } from '@ramet/shared/inbox-notice'
import { ApiError, request } from '../api'
import { b64uBytes, channelOf, sameKey, type Channel, type ChannelReason, type DeviceState } from './notify-model'

const FLAG_KEY = 'ramet:notify'
const STATUS_EVERY_MS = 60 * 60_000

type Status = { registered: boolean; error: string | null }

export type NotifyState = DeviceState & { busy: boolean; channel: Channel; reason: ChannelReason }

const hasNotification = (): boolean => typeof window !== 'undefined' && 'Notification' in window
const pushSupported = (): boolean => 'serviceWorker' in navigator && 'PushManager' in window
const isIos = (): boolean => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const standalone = (): boolean => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

/** 当前登录的人（startNotify 时记下） */
let userId = ''

function readFlag(): boolean {
  try {
    return !!userId && localStorage.getItem(FLAG_KEY) === userId
  } catch {
    return false
  }
}

function writeFlag(on: boolean): void {
  try {
    if (on) localStorage.setItem(FLAG_KEY, userId)
    else localStorage.removeItem(FLAG_KEY)
  } catch {
    // 无痕模式：只在这次会话里生效
  }
}

function probe(): DeviceState {
  return {
    enabled: readFlag(),
    secure: window.isSecureContext,
    iosNeedsInstall: isIos() && !standalone(),
    canNotify: hasNotification(),
    permission: hasNotification() ? Notification.permission : 'denied',
    pushSupported: pushSupported(),
    subscribed: false,
    serverError: null,
    subscribeError: null,
  }
}

let state: NotifyState = withChannel({ ...probe(), busy: false })
const listeners = new Set<() => void>()

function withChannel(s: DeviceState & { busy: boolean }): NotifyState {
  return { ...s, ...channelOf(s) }
}

function set(patch: Partial<NotifyState>): void {
  state = withChannel({ ...state, ...patch })
  for (const l of listeners) l()
}

export function useNotifyState(): NotifyState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}

export const currentChannel = (): Channel => state.channel

/** 浏览器订阅失败给的是 DOMException（名字有用，如 AbortError / NotAllowedError）；服务端拒绝给的是人话，原样显示 */
const errText = (err: unknown): string => (err instanceof ApiError ? err.message : err instanceof Error ? `${err.name}: ${err.message}` : String(err))

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js')
  return navigator.serviceWorker.ready
}

/** 拿到（必要时新建）推送订阅并登记到服务端。服务器换过密钥的旧订阅推不进来，退订重来 */
async function subscribe(): Promise<PushSubscription> {
  const reg = await registration()
  const { publicKey } = await request<{ publicKey: string }>('/api/push/key')
  let sub = await reg.pushManager.getSubscription()
  if (sub && !sameKey(sub.options.applicationServerKey, publicKey)) {
    await sub.unsubscribe().catch(() => false)
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(publicKey) as BufferSource })
  const json = sub.toJSON()
  await request('/api/push/subscriptions', { method: 'POST', body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }) })
  return sub
}

async function currentEndpoint(): Promise<string | null> {
  if (!pushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration()
  return (await reg?.pushManager.getSubscription())?.endpoint ?? null
}

/** 服务端眼里这台设备的推送通不通 */
async function refreshStatus(): Promise<void> {
  const endpoint = await currentEndpoint().catch(() => null)
  if (!endpoint) {
    set({ subscribed: false, serverError: null })
    return
  }
  const st = await request<Status>('/api/push/status', { method: 'POST', body: JSON.stringify({ endpoint }) }).catch(() => null)
  if (st) set({ subscribed: st.registered, serverError: st.error })
}

/** 登记推送；失败不抛，记下原因（通道退回桌面通知） */
async function setupPush(): Promise<void> {
  if (!pushSupported()) return
  try {
    await subscribe()
    set({ subscribeError: null })
    await refreshStatus()
  } catch (err) {
    console.warn('[notify] 推送订阅失败，改用桌面通知', err)
    set({ subscribed: false, subscribeError: errText(err) })
    // 推送订阅不上也要有 sw：桌面通知经它弹，点击才能跳回来
    await registration().catch(() => undefined)
  }
}

/** 打开（必须在用户点击里调：浏览器只在用户操作时弹权限请求） */
export async function enableNotify(): Promise<void> {
  if (!hasNotification()) return
  set({ busy: true })
  try {
    const permission = await Notification.requestPermission()
    set({ permission })
    if (permission !== 'granted') return
    writeFlag(true)
    set({ enabled: true })
    await setupPush()
  } finally {
    set({ busy: false })
  }
}

/** 关掉：服务端注销、浏览器退订，之后这台设备什么都不弹 */
export async function disableNotify(): Promise<void> {
  set({ busy: true })
  try {
    writeFlag(false)
    set({ enabled: false })
    await forgetSubscription()
  } finally {
    set({ busy: false, subscribed: false, serverError: null, subscribeError: null })
  }
}

async function forgetSubscription(): Promise<void> {
  const reg = pushSupported() ? await navigator.serviceWorker.getRegistration().catch(() => undefined) : undefined
  const sub = await reg?.pushManager.getSubscription().catch(() => null)
  if (!sub) return
  await request('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => undefined)
  await sub.unsubscribe().catch(() => false)
}

/** 退出登录前调（cookie 还有效）：这台设备不再收上一个人的通知，下一个登录的人要自己重新打开 */
export async function forgetDevice(): Promise<void> {
  writeFlag(false)
  set({ enabled: false, subscribed: false, serverError: null, subscribeError: null })
  await forgetSubscription().catch(() => undefined)
}

/** 开关是别人开的（他的会话过期了、没走退出登录）：浏览器里退订，服务端下次推送拿到 410 自己删掉，这台设备不再收他的通知 */
function dropOthers(): void {
  let owner: string | null = null
  try {
    owner = localStorage.getItem(FLAG_KEY)
  } catch {
    return
  }
  if (!owner || owner === userId) return
  writeFlag(false)
  if (!pushSupported()) return
  void navigator.serviceWorker
    .getRegistration()
    .then((reg) => reg?.pushManager.getSubscription())
    .then((sub) => sub?.unsubscribe())
    .catch(() => undefined)
}

/** 页面自己弹一条（桌面通道、测试）。有 sw 就经它弹（安卓只认这种，点击也统一由 sw 处理），没有再用 Notification */
export async function showLocal(notice: Notice, onOpen: (url: string) => void): Promise<void> {
  const options = { body: notice.body, tag: notice.tag, icon: '/icon-192.png', data: { url: notice.url } }
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration().catch(() => undefined) : undefined
  if (reg) {
    await reg.showNotification(notice.title, options)
    return
  }
  const n = new Notification(notice.title, options)
  n.onclick = () => {
    window.focus()
    onOpen(notice.url)
    n.close()
  }
}

/** 设置页的「发一条测试通知」：推送通道走服务端完整链路，桌面通道本地弹 */
export async function sendTest(onOpen: (url: string) => void): Promise<{ ok: true } | { ok: false; error: string }> {
  if (state.channel === 'push') {
    const endpoint = await currentEndpoint()
    if (!endpoint) return { ok: false, error: '这台设备还没登记，请重新开启通知' }
    const res = await request<{ ok: boolean; error?: string }>('/api/push/test', { method: 'POST', body: JSON.stringify({ endpoint }) })
    await refreshStatus()
    return res.ok ? { ok: true } : { ok: false, error: res.error ?? '发送失败' }
  }
  if (state.channel === 'desktop') {
    await showLocal({ title: 'Ramet 测试通知', body: '能看到这条，说明这台设备能收到通知', url: '/inbox', tag: 'ramet:test', urgent: false }, onOpen)
    return { ok: true }
  }
  return { ok: false, error: '这台设备的通知没有打开' }
}

/** sw 里点了通知：让页面在站内跳过去 */
function listenOpen(onOpen: (url: string) => void): () => void {
  if (!('serviceWorker' in navigator)) return () => undefined
  const handler = (e: MessageEvent): void => {
    const data = e.data as { type?: unknown; url?: unknown } | null
    if (data?.type === 'ramet:open' && typeof data.url === 'string' && data.url.startsWith('/')) onOpen(data.url)
  }
  navigator.serviceWorker.addEventListener('message', handler)
  return () => navigator.serviceWorker.removeEventListener('message', handler)
}

/** 登录壳挂载时调：恢复这台设备的通道、接住通知点击；返回拆除 */
export function startNotify(user: string, onOpen: (url: string) => void): () => void {
  userId = user
  dropOthers()
  set({ ...probe(), busy: false })
  const offOpen = listenOpen(onOpen)
  if (state.enabled && state.permission === 'granted') void setupPush()
  const timer = window.setInterval(refreshNotifyStatus, STATUS_EVERY_MS)
  // 设置里改了浏览器的通知权限（地址栏的站点设置）：回到页面时重新读
  const onVisible = (): void => {
    if (document.visibilityState === 'visible' && hasNotification() && Notification.permission !== state.permission) set({ permission: Notification.permission })
  }
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    offOpen()
    window.clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisible)
  }
}

/** 设置页打开时：再查一次服务端状态 */
export function refreshNotifyStatus(): void {
  if (state.enabled && state.permission === 'granted') void refreshStatus()
}
