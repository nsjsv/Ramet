/* ---------- 这个标签页此刻在不在用（系统通知据此不打扰人）----------
 * 在用 = 可见 + 有焦点 + 1 分钟内有过操作（键鼠 / 触摸 / 滚动）。两处要知道：
 *   - 服务端（推送）：状态切换时经 control:global 报 presence:on / off，连上 / 重连时再报一次当前状态；
 *   - 本设备别的标签页（桌面通知）：在用期间每 5 秒最多写一次 localStorage 标记，转为不在用时删掉自己写的。
 * 只报切换，不心跳：死连接由服务端的连接心跳断开，标记有时间戳，标签页崩了也会自己过期。 */

import { listenControl, sendControl } from '../control'
import { randomUuid } from '../uuid'

export const IDLE_MS = 60_000
const MARK_KEY = 'ramet:active'
const MARK_EVERY_MS = 5_000
const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const

const tabId = randomUuid()
let active = false
let lastInput = 0
let lastMark = 0
let idleTimer: number | undefined

const visibleAndFocused = (): boolean => document.visibilityState === 'visible' && document.hasFocus()

function readMark(): { tab: string; at: number } | null {
  try {
    const raw = localStorage.getItem(MARK_KEY)
    const i = raw?.lastIndexOf(':') ?? -1
    if (!raw || i < 0) return null
    return { tab: raw.slice(0, i), at: Number(raw.slice(i + 1)) || 0 }
  } catch {
    return null
  }
}

function writeMark(now: number): void {
  if (now - lastMark < MARK_EVERY_MS) return
  lastMark = now
  try {
    localStorage.setItem(MARK_KEY, `${tabId}:${now}`)
  } catch {
    // 无痕模式写不进：只影响本设备多个标签页之间的判断
  }
}

function clearMark(): void {
  lastMark = 0
  try {
    if (readMark()?.tab === tabId) localStorage.removeItem(MARK_KEY)
  } catch {
    // 同上
  }
}

function update(): void {
  const now = Date.now()
  const next = visibleAndFocused() && now - lastInput < IDLE_MS
  if (next !== active) {
    active = next
    sendControl(active ? 'presence:on' : 'presence:off')
    if (!active) clearMark()
  }
  window.clearTimeout(idleTimer)
  if (active) {
    writeMark(now)
    idleTimer = window.setTimeout(update, IDLE_MS - (now - lastInput) + 50)
  }
}

function onInput(): void {
  lastInput = Date.now()
  // 在用期间的输入只需要续标记；高频的 pointermove / scroll 不必每次都重算
  if (active && lastInput - lastMark < MARK_EVERY_MS) return
  update()
}

/** 这台设备上有没有哪个 Ramet 标签页正在用（包括自己） */
export function deviceActive(): boolean {
  if (active) return true
  const mark = readMark()
  return !!mark && Date.now() - mark.at < IDLE_MS + MARK_EVERY_MS
}

/** 登录壳挂载时调；返回拆除（退出 / 换账号） */
export function startPresence(): () => void {
  // 刚打开 / 刚登录：人就在跟前
  lastInput = Date.now()
  active = false
  const opts = { capture: true, passive: true }
  for (const ev of INPUT_EVENTS) window.addEventListener(ev, onInput, opts)
  window.addEventListener('focus', update)
  window.addEventListener('blur', update)
  document.addEventListener('visibilitychange', update)
  // 连上 / 重连：服务端那边是新连接，没有状态，报一次当前的
  const offSync = listenControl((ev) => {
    if (ev === 'sync') sendControl(active ? 'presence:on' : 'presence:off')
  })
  update()
  return () => {
    for (const ev of INPUT_EVENTS) window.removeEventListener(ev, onInput, opts)
    window.removeEventListener('focus', update)
    window.removeEventListener('blur', update)
    document.removeEventListener('visibilitychange', update)
    offSync()
    window.clearTimeout(idleTimer)
    if (active) sendControl('presence:off')
    active = false
    clearMark()
  }
}
