import { useCallback, useSyncExternalStore } from 'react'
import { usePageAgent } from '../editor/agent-bar'
import { useAgents } from '../default-agent'

/* ---------- 项目面板的外壳状态：开合 / 宽度 / 当前分页（跨刷新记住，localStorage）----------
 * 一个偏好一个所有者（同 view-mode / default-agent 的做法）：顶栏按钮、⌘E、面板本身读写同一份 store。
 * 「面板开着」只是用户的意愿；真正出现还要看当前页面的 agent 是不是一台自己能用的机器（useProjectTarget）。 */

const KEY_OPEN = 'ramet.project.open'
const KEY_WIDTH = 'ramet.project.width'
const KEY_TAB = 'ramet.project.tab'

export const WIDTH_DEFAULT = 440
export const WIDTH_MIN = 320
export const WIDTH_MAX = 760

export type ProjectTab = 'round' | 'files' | 'changes' | 'terminal' | 'preview'
export const PROJECT_TABS: readonly ProjectTab[] = ['round', 'files', 'changes', 'terminal', 'preview']

const clampWidth = (w: number): number => Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(w)))

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null // 隐私模式 / quota：按没记过
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 只丢记忆，不阻断交互
  }
}

type Shell = { open: boolean; width: number; tab: ProjectTab }

function initial(): Shell {
  const width = Number(read(KEY_WIDTH))
  const tab = read(KEY_TAB)
  return {
    open: read(KEY_OPEN) === '1',
    width: width >= WIDTH_MIN && width <= WIDTH_MAX ? clampWidth(width) : WIDTH_DEFAULT,
    tab: PROJECT_TABS.includes(tab as ProjectTab) ? (tab as ProjectTab) : 'files',
  }
}

let shell: Shell = initial()
const listeners = new Set<() => void>()

function set(next: Partial<Shell>): void {
  shell = { ...shell, ...next }
  listeners.forEach((l) => l())
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export const useProjectShell = (): Shell => useSyncExternalStore(subscribe, () => shell)

export function setProjectOpen(open: boolean): void {
  write(KEY_OPEN, open ? '1' : '0')
  set({ open })
}

export const toggleProject = (): void => setProjectOpen(!shell.open)

/** 「找文件」的外部入口（命令面板）：打开项目面板，并让面板弹出找文件框（面板自己的 ⌘P 是另一条路） */
const quickListeners = new Set<() => void>()
/** 请求时面板还没挂上（刚打开）：记着，挂上时补上 */
let pendingQuick = false
export function requestQuickOpen(): void {
  setProjectOpen(true)
  if (quickListeners.size === 0) pendingQuick = true
  quickListeners.forEach((l) => l())
}
export function onQuickOpenRequest(cb: () => void): () => void {
  quickListeners.add(cb)
  if (pendingQuick) {
    pendingQuick = false
    cb()
  }
  return () => {
    quickListeners.delete(cb)
  }
}

export function setProjectTab(tab: ProjectTab): void {
  write(KEY_TAB, tab)
  set({ tab })
}

/** 拖动中只改内存（面板宽度每帧变，别每帧写 localStorage）；松手再 commit */
export function setProjectWidth(width: number, commit = false): void {
  const w = clampWidth(width)
  if (commit) write(KEY_WIDTH, String(w))
  set({ width: w })
}

/** 这一页的项目面板对准哪台机器：页面上选中的 agent 是 connector 上的 agent、且我对这台机器有 machine 授权（接入人 ∨ 有效授权）。
 *  依据是 GET /api/agents 目录里服务端算好的 `machine` 标记（不为了试探去请求项目接口）；没有 = 不出现入口。
 *  真正的判定在每个项目端点上再做一次，这里只管「要不要显示入口」。 */
export function useProjectTarget(pageId: string | undefined): { agent: string; label: string } | null {
  const { agent } = usePageAgent(pageId)
  const { agents } = useAgents()
  const hit = agent ? agents.find((a) => a.id === agent) : undefined
  return hit?.machine === true ? { agent: hit.id, label: hit.label } : null
}

/** 面板的开合与「当前页面有没有可用的项目」合在一起：顶栏按钮用 */
export function useProjectToggle(pageId: string | undefined): { available: boolean; open: boolean; toggle: () => void } {
  const target = useProjectTarget(pageId)
  const { open } = useProjectShell()
  const toggle = useCallback(() => toggleProject(), [])
  return { available: target !== null, open, toggle }
}
