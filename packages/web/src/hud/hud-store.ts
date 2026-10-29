/* ---------- 右上角工作台的开合状态（模块级小 store，同 agent-bar / project-state 的写法）----------
 * 只记「面板开没开、看哪一页、看的是哪一轮」。这一轮的数据不在这里：在飞的来自 agent-bar 的 store，
 * 跑完的按过程页 id 拉 record（hud-source.ts）。 */
import { useSyncExternalStore } from 'react'
import type { HudTab } from './hud-model'

/** 面板看的是哪一轮：replyId 认块（在飞的一轮还没有过程页）；runId = 过程页（跑完才有） */
export type HudTarget = { pageId: string; replyId: string; runId: string | null }

type Hud = {
  open: boolean
  tab: HudTab
  /** null = 看当前页在飞的那一轮 */
  target: HudTarget | null
}

let hud: Hud = { open: false, tab: 'overview', target: null }
const listeners = new Set<() => void>()

function set(next: Hud): void {
  hud = next
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export const useHud = (): Hud => useSyncExternalStore(subscribe, () => hud)
export const hudState = (): Hud => hud

/** 打开面板到某一页；target 缺省 = 当前页在飞的那一轮 */
export function openHud(tab: HudTab, target: HudTarget | null = null): void {
  set({ open: true, tab, target })
}

export function setHudTab(tab: HudTab): void {
  if (hud.tab !== tab) set({ ...hud, tab })
}

export function closeHud(): void {
  if (hud.open || hud.target) set({ ...hud, open: false, target: null })
}

/** 换页：面板跟着关（它看的是上一页的一轮） */
export function resetHudFor(pageId: string | undefined): void {
  if (hud.target && hud.target.pageId !== pageId) set({ ...hud, open: false, target: null })
  else if (hud.open && !pageId) set({ ...hud, open: false })
}

/** 进过程页（带 run-door 的进门变形）：当前编辑器挂载时登记（Editor.tsx），面板的「在过程页里看」用它；
 *  anchor = 变形的起点（停靠的岛；不在就没有变形）。没登记（不在编辑器页面）→ false，调用方自己跳转 */
type RunOpener = (runId: string, anchor: HTMLElement | null) => void
let opener: RunOpener | null = null

export function setRunOpener(fn: RunOpener | null): void {
  opener = fn
}

export function openRunPage(runId: string, anchor: HTMLElement | null): boolean {
  if (!opener) return false
  opener(runId, anchor)
  return true
}
