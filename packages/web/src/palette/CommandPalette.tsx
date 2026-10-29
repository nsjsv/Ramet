/* ---------- 命令面板（⌘K / Ctrl+K）----------
 * 挂在 App 外壳。⌘K 在哪都开 / 关面板，但编辑器里选中了文字时仍是插链接（editor/shortcuts.ts 只在选区非空时接管并
 * preventDefault，这里看到 defaultPrevented 就让路）；终端里的 Ctrl+K 是 shell 的（同 ProjectDock 的 inTerminal）。
 * 常驻的只有开关状态与 ⌘K 监听；浮层本体（PaletteLayer.tsx：收集当前上下文、画浮层、接键盘）第一次打开才下载，
 * 条目与过滤是纯函数（palette-model.ts）。 */
import { lazy, Suspense, useEffect, useSyncExternalStore } from 'react'
import type { Page } from '../api'

const loadLayer = () => import('./PaletteLayer')
const PaletteLayer = lazy(loadLayer)
/** 空闲时预取浮层本体（App 外壳调用），第一次 ⌘K 不用等下载；失败不管，真打开时再拉 */
export const preloadPalette = (): void => void loadLayer().catch(() => {})

let open = false
/** 本体还没下载完时（Pending）敲下的字：本体挂上后当初始查询 */
let draft = ''
export const paletteDraft = (): string => draft
const listeners = new Set<() => void>()
function setOpen(next: boolean): void {
  if (open === next) return
  open = next
  if (next) draft = ''
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const togglePalette = (): void => setOpen(!open)
export const closePalette = (): void => setOpen(false)

function isPaletteKey(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'k') return false
  // 终端里的 Ctrl+K 是 shell 的（删到行尾）
  return !(e.ctrlKey && e.target instanceof Element && e.target.closest('.project-term') !== null)
}

export type PaletteProps = {
  pages: Page[]
  /** 当前空间：页面组只列它的页面，新建页面放在它下面 */
  spaceId: string | null
  canWritePage: (pageId: string) => boolean
  /** 新建了页面：外壳重拉页面树 */
  onCreated: () => void
}

/** 本体还在下载：先放一个看不见的输入框接住焦点，否则 ⌘K 后紧接着敲的字会落进编辑器正文；Esc 照常关 */
function Pending() {
  return (
    <input
      className="pal-pending"
      autoFocus
      aria-hidden
      tabIndex={-1}
      onChange={(e) => (draft = e.target.value)}
      onKeyDown={(e) => e.key === 'Escape' && closePalette()}
    />
  )
}

export default function CommandPalette(props: PaletteProps) {
  const isOpen = useSyncExternalStore(subscribe, () => open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 编辑器里选中文字时 ⌘K 是插链接：编辑器先处理并 preventDefault，这里让路
      if (e.defaultPrevented || !isPaletteKey(e)) return
      e.preventDefault()
      togglePalette()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return isOpen ? (
    <Suspense fallback={<Pending />}>
      <PaletteLayer {...props} />
    </Suspense>
  ) : null
}
