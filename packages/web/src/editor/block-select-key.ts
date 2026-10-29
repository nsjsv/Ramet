/* ---------- 块选区状态 ----------
 * 键与形状单独成模块：block-turn / block-ops / block-menu 都要读写它，放在 block-select.ts 会和它依赖的 block-menu.ts 成环。
 * {active, from, to} 是一段顶层块的 doc 位置区间 [from, to)，或单个下钻节点（列表项 / AI 回复子块 / 分栏里的块）的 [起点, 终点)。
 * 故意不写进 PM 选区（PM 那边只有折叠的 caret，整块原生选区会闪，见 block-handle.ts）。
 * head：键盘 Shift+↑↓ 扩缩时移动的那一端（'start' 是 from 端动，'end' 是 to 端动），鼠标建立的选区缺省 'end'。 */

import { PluginKey } from '@milkdown/kit/prose/state'

export interface BlockSelectState {
  active: boolean
  from: number
  to: number
  head?: 'start' | 'end'
}

export const CLEAR_BLOCK_SELECT: BlockSelectState = { active: false, from: 0, to: 0 }
export const blockSelectKey = new PluginKey<BlockSelectState>('blockSelect')
