import { useSyncExternalStore } from 'react'

/* ---------- 对话附件的摆法（全局记忆，设置弹窗「编辑」分页） ----------
 * 图片 / 文件引用 / 块引用在对话输入框和已发气泡里怎么摆：
 *  - inline：就是正文里的行内 token（图片是小缩略图 + 图 N），悬停弹预览；
 *  - tray：正文里只留短占位符（图 N / 文件名 / 引用 N），附件排成卡片放在输入卡 / 气泡上方，悬停互相高亮。
 * 只是显示方式：消息内容一样（图片都落在正文原位，见 composer-input.tsx）。存在本机浏览器里，别的标签页改了经 storage 事件跟上。 */

export type AttachLayout = 'inline' | 'tray'

const KEY = 'ramet:attach-layout'

function parse(raw: string | null): AttachLayout {
  return raw === 'tray' ? 'tray' : 'inline'
}

function readStored(): AttachLayout {
  try {
    return parse(localStorage.getItem(KEY))
  } catch {
    return 'inline' // 隐私模式 / quota 时按默认
  }
}

let current: AttachLayout = readStored()
const listeners = new Set<() => void>()

function update(next: AttachLayout): void {
  if (next === current) return
  current = next
  listeners.forEach((l) => l())
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) update(parse(e.newValue))
  })
}

export function attachLayout(): AttachLayout {
  return current
}

export function setAttachLayout(next: AttachLayout): void {
  try {
    localStorage.setItem(KEY, next)
  } catch {
    // 隐私模式 quota：丢的只是偏好记忆，本次照样切
  }
  update(next)
}

export function onAttachLayout(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function useAttachLayout(): AttachLayout {
  return useSyncExternalStore(onAttachLayout, attachLayout)
}
