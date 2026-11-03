import { useSyncExternalStore } from 'react'

/* ---------- 界面明暗：跟随系统 / 浅色 / 深色（全局记忆，设置弹窗「外观」分页） ----------
 * 生效的明暗写在 <html data-theme="light|dark">，dark.css 按它覆盖令牌；CSS 管不到的地方（emoji 选择器的 shadow DOM、
 * Mermaid 出图、xterm 配色）用 isDark() 取值、onThemeChange() 在明暗翻转时重画。
 * 首帧：index.html 的内联脚本按同一个 key 先写好 data-theme——模块脚本是 defer 的，赶不上首帧，深色用户每次打开会先闪一下白底。
 * 跟随系统时听 prefers-color-scheme；别的标签页改了偏好经 storage 事件跟上。
 * 单一所有者：key、当前值、订阅者都在这里；index.html 的脚本是唯一的复刻，改 key / 取值两边同改。 */

export type ThemePref = 'system' | 'light' | 'dark'

const KEY = 'ramet:theme'
const SYSTEM_DARK = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null

function parse(raw: string | null): ThemePref {
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}

function readStored(): ThemePref {
  try {
    return parse(localStorage.getItem(KEY))
  } catch {
    return 'system' // 隐私模式 / quota 时按默认
  }
}

function resolve(p: ThemePref): boolean {
  return p === 'system' ? Boolean(SYSTEM_DARK?.matches) : p === 'dark'
}

let pref: ThemePref = readStored()
let dark = resolve(pref)
/** 偏好变了（设置界面重渲染） */
const prefListeners = new Set<() => void>()
/** 生效明暗翻转了（要按新配色重画的非 CSS 消费方） */
const darkListeners = new Set<() => void>()

function paint(): void {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

/** 先写 data-theme 再通知：订阅方在回调里 getComputedStyle 读到的已是新令牌 */
function update(next: ThemePref): void {
  const prefChanged = next !== pref
  pref = next
  const nextDark = resolve(pref)
  const darkChanged = nextDark !== dark
  dark = nextDark
  paint()
  if (prefChanged) prefListeners.forEach((l) => l())
  if (darkChanged) darkListeners.forEach((l) => l())
}

/** main.tsx 里装一次：校正首帧脚本写的 data-theme，开始听系统明暗与别的标签页 */
export function installTheme(): void {
  paint()
  SYSTEM_DARK?.addEventListener('change', () => update(pref))
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) update(parse(e.newValue))
  })
}

export function themePref(): ThemePref {
  return pref
}

export function setThemePref(next: ThemePref): void {
  if (next === pref) return
  try {
    if (next === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
  } catch {
    // 隐私模式 quota：丢的只是偏好记忆，本次照样切
  }
  update(next)
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribePref, themePref)
}

function subscribePref(fn: () => void): () => void {
  prefListeners.add(fn)
  return () => {
    prefListeners.delete(fn)
  }
}

/** 当前生效的是不是深色 */
export function isDark(): boolean {
  return dark
}

/** 生效明暗翻转时回调；返回取消订阅 */
export function onThemeChange(fn: () => void): () => void {
  darkListeners.add(fn)
  return () => {
    darkListeners.delete(fn)
  }
}
