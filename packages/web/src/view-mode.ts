import { useSyncExternalStore } from 'react'

/* ---------- 视图模式（文档 / 聊天）----------
 * 优先级：页面自己的记忆 > 全局默认（设置弹窗「编辑器」分页） > 文档。
 * 'doc' = 现有编辑器，'chat' = 聊天气泡流（editor/chat-view.tsx）。
 * 单一所有者：key 常量与读写只在本模块出现（Editor.tsx 与 SettingsModal 都从这里拿）。 */

const VIEW_MODE_KEY_PREFIX = 'ramet:viewmode:'
const DEFAULT_KEY = 'ramet:viewmode:default'

/** localStorage 读取：隐私模式/quota 抛错时按文档模式 */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, chat: boolean): void {
  try {
    localStorage.setItem(key, chat ? 'chat' : 'doc')
  } catch (err) {
    console.error('save view mode failed:', err)
  }
}

/** 该页是否为聊天模式（非法值/未选过 → 全局默认） */
export function readViewMode(pageId: string | undefined): boolean {
  if (pageId) {
    const own = read(VIEW_MODE_KEY_PREFIX + pageId)
    if (own === 'chat') return true
    if (own === 'doc') return false
  }
  return read(DEFAULT_KEY) === 'chat'
}

/** 记下该页自己的选择（覆盖全局默认，只对该页生效） */
export function writeViewMode(pageId: string | undefined, chat: boolean): void {
  write(VIEW_MODE_KEY_PREFIX + pageId, chat)
}

export function getDefaultViewMode(): boolean {
  return read(DEFAULT_KEY) === 'chat'
}

const listeners = new Set<() => void>()

export function setDefaultViewMode(chat: boolean): void {
  write(DEFAULT_KEY, chat)
  listeners.forEach((l) => l())
}

/** 设置弹窗用：全局默认打开方式（新页面/未选过的页按它） */
export function useDefaultViewMode(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    getDefaultViewMode,
  )
}

/** 「切到文档 / 对话视图」的外部入口（命令面板）：当前编辑器订阅，按它自己的切换动画切（Editor.tsx 的 switchView） */
const toggleListeners = new Set<() => void>()
export function requestViewToggle(): void {
  toggleListeners.forEach((l) => l())
}
export function onViewToggleRequest(cb: () => void): () => void {
  toggleListeners.add(cb)
  return () => {
    toggleListeners.delete(cb)
  }
}
