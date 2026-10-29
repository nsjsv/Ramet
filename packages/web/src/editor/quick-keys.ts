// ---------- 随手 AI 的键位（⌘J / Ctrl+J）----------
// 单独成模块：浮层、正文插件、对话输入框、选区菜单都要认这个键，放哪一边都会拉出循环依赖。
// ⌘I 是斜体所以用 J；浏览器自带的 Ctrl+J（下载）在编辑器 / 浮层里被接管（处理过的按键会 preventDefault）。

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/** 按键帽文字：Mac 是 ⌘J，其它平台 Ctrl+J（设置里的快捷键页同一口径） */
export const QUICK_KEY_LABEL = MAC ? '⌘J' : 'Ctrl+J'

/** ⌘J（Mac）/ Ctrl+J（其它）。不带 Shift / Alt，输入法组字中不算 */
export function isQuickKey(e: KeyboardEvent): boolean {
  if (e.shiftKey || e.altKey || e.isComposing) return false
  const mod = MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return mod && (e.code === 'KeyJ' || e.key.toLowerCase() === 'j')
}
