// 从任意位置打开设置弹窗的某一页。弹窗的开关状态在侧栏（Sidebar.tsx），编辑器里的小浮层（随手 AI 没配模型连接时的「去设置」）、
// 收件箱里的使用申请够不着它，经这条总线递话：Sidebar 订阅，收到就打开并跳到指定分页。
// spaceId：空间类分页（机器）只看当前选中的空间，条目属于别的空间时要先切过去。没人订阅（公开页等）时静默无事。

export type SettingsTarget = 'quick' | 'machines'

type Listener = (tab: SettingsTarget, spaceId?: string) => void
const listeners = new Set<Listener>()

export function openSettings(tab: SettingsTarget, spaceId?: string): void {
  listeners.forEach((l) => l(tab, spaceId))
}

export function onOpenSettings(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
