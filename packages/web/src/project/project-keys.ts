/* ---------- 项目面板的键位（⌘E 开关面板、⌘P 找文件）----------
 * 单独成模块：外壳（全局监听）、面板、设置里的快捷键说明表都要认这两个键，放哪一边都会拉出循环依赖。
 * ⌘E 在正文里本来是行内代码（milkdown 预设）：监听挂在 window 冒泡阶段，编辑器先处理，光标在正文里时 ⌘E 仍是行内代码
 *（处理过的按键已 preventDefault，这里就不再接管），其它位置（对话输入框、面板、侧栏等）才开关面板；顶栏按钮随时可用。
 * ⌘P 只在面板打开时接管（盖掉浏览器的「打印」）。 */

/** PM 键名（设置里的快捷键说明表引用；真正的绑定在下面的 isXxxKey） */
export const PROJECT_KEYS = { toggle: 'Mod-e', quickOpen: 'Mod-p' } as const

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

export const PROJECT_TOGGLE_LABEL = MAC ? '⌘E' : 'Ctrl+E'
export const PROJECT_OPEN_FILE_LABEL = MAC ? '⌘P' : 'Ctrl+P'

function modKey(e: KeyboardEvent, code: string, key: string): boolean {
  if (e.shiftKey || e.altKey || e.isComposing || e.defaultPrevented) return false
  const mod = MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return mod && (e.code === code || e.key.toLowerCase() === key)
}

export const isProjectToggleKey = (e: KeyboardEvent): boolean => modKey(e, 'KeyE', 'e')
export const isQuickOpenKey = (e: KeyboardEvent): boolean => modKey(e, 'KeyP', 'p')

/** 按键发生在终端里：Ctrl+E（行尾）/ Ctrl+P（上一条历史）等是 shell 的，不是面板的快捷键。
 *  Mac 上面板的快捷键是 ⌘（meta），与 shell 的 Ctrl 不冲突，照常可用 */
export function inTerminal(e: KeyboardEvent): boolean {
  return e.ctrlKey && e.target instanceof Element && e.target.closest('.project-term') !== null
}
