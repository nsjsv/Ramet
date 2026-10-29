/* ---------- 正文的编辑方式：二选一（全局记忆） ----------
 *   rich   所见即所得：ProseMirror 块编辑器，输入前缀（`# ` `- ` `> ` …）当场成型，删掉才变回来；
 *   source 源码：CodeMirror 编辑 markdown 原文，记号全部显示（只有样式高亮，source-editor.tsx）。
 * 过程页 / 对话视图没有 markdown 编辑，照常显示所见即所得（Editor.tsx 判定）。
 * 单一所有者：当前值、localStorage、订阅者都在这里。顶栏 ⋮ 菜单（EditModeItems）与设置弹窗读写同一份。
 * localStorage 里存的其它值（含已不存在的 `live`）一律读成所见即所得。 */

import { useSyncExternalStore } from 'react'
import { COPY } from '../copy'
import { Icon } from '../icons'

export type EditMode = 'rich' | 'source'

const KEY = 'ramet-edit-mode'

function readStored(): EditMode {
  try {
    return localStorage.getItem(KEY) === 'source' ? 'source' : 'rich'
  } catch {
    return 'rich' // 隐私模式 / quota 时按默认
  }
}

let current: EditMode = readStored()
const listeners = new Set<() => void>()

export function editMode(): EditMode {
  return current
}

export function setEditMode(next: EditMode): void {
  if (next === current) return
  current = next
  try {
    localStorage.setItem(KEY, next)
  } catch {
    // 隐私模式 quota：丢的只是偏好记忆
  }
  listeners.forEach((l) => l())
}

export function subscribeEditMode(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function useEditMode(): EditMode {
  return useSyncExternalStore(subscribeEditMode, editMode)
}

/** 顶栏 ⋮ 菜单里的一项：点亮切到源码，再点回到所见即所得 */
export function EditModeItems() {
  const on = useEditMode() === 'source'
  return (
    <button type="button" aria-pressed={on} title={COPY.editMode.sourceHint} onClick={() => setEditMode(on ? 'rich' : 'source')}>
      <Icon name="code-block" className="menu-icon" />
      {COPY.editMode.source}
      {on && <Icon name="check" size={14} className="menu-check" />}
    </button>
  )
}
