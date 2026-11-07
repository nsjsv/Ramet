// ---------- file_mention：引用 agent 工作区里的一个文件（行内原子 chip） ----------
// 项目文件浏览的「引用」插进对话输入框的东西：chip 只显示文件名，悬停提示是完整路径。
// attrs.path 是相对工作区根的路径（与文件浏览同一口径），给 AI / 搜索是 `@路径`（updates.ts textOf，各家 CLI 都认 @ 文件），
// 导出也是 `@路径` 文字（export-doc.ts）。
//
// 进出通道同另外几种提及：toDOM / parseDOM 保剪贴板往返；toMarkdown 写成 `[@路径](file:<编码路径>)` 链接，
// mention-upgrade.ts 在 parse 边界升回来；对话输入框对外的记号是 `@[文件名](file:<编码路径>)`。
// Editor / PublicPage 必须 .use，否则协同对端与公开页出现未注册节点会整页解析失败。

import { $nodeSchema } from '@milkdown/kit/utils'
import { mdLink } from './md-link'

/** chip 的 DOM 标记属性（parseDOM 认它），值是完整路径 */
export const FILE_MENTION_ATTR = 'data-file-mention'

/** 路径 → 记号 / 链接里的 target。记号靠 `)` 收口、target 含空白就不升，所以这几个字符百分号编码，
 *  别的原样（target 读起来还是路径）。`%` 自己也编，解码才不会把路径里本来的 `%xx` 解歪 */
export function fileTarget(path: string): string {
  return path.replace(/[%()\s]/g, (c) => (c === '(' ? '%28' : c === ')' ? '%29' : encodeURIComponent(c)))
}

/** target → 路径；不是合法编码（手写的记号）就原样当路径 */
export function fileOfTarget(target: string): string {
  try {
    return decodeURIComponent(target)
  } catch {
    return target
  }
}

/** 显示用的文件名：路径最后一段（目录引用带尾斜杠时取目录名） */
export function fileName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** 对话输入框里引用一个文件的记号 */
export function fileMark(path: string): string {
  return `@[${fileName(path)}](file:${fileTarget(path)})`
}

export const fileMentionSchema = $nodeSchema('file_mention', () => ({
  inline: true,
  group: 'inline',
  atom: true, // 原子 chip：光标进不去，backspace 一次删整颗
  attrs: {
    path: { default: '' },
  },
  parseDOM: [
    {
      tag: `span[${FILE_MENTION_ATTR}]`,
      getAttrs: (dom) => ({ path: (dom as HTMLElement).getAttribute(FILE_MENTION_ATTR) ?? '' }),
    },
  ],
  toDOM: (node) => {
    const path = typeof node.attrs.path === 'string' ? node.attrs.path : ''
    return ['span', { class: 'file-mention', [FILE_MENTION_ATTR]: path, 'data-tip': path }, fileName(path) || '文件']
  },
  parseMarkdown: { match: () => false, runner: () => {} },
  toMarkdown: {
    match: (node) => node.type.name === 'file_mention',
    runner: (state, node) => {
      const path = typeof node.attrs.path === 'string' ? node.attrs.path : ''
      mdLink(state, `@${path}`, `file:${fileTarget(path)}`, false)
    },
  },
}))
