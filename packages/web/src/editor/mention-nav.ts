/* ---------- `@` 大菜单的键位语义（纯函数；文档内 doc-mention.ts 与对话输入框 chat-view.tsx 共用） ----------
 * 宿主只在菜单开着时问这里这个键是什么意思，按结论动作；返回 null 表示不归菜单管，放行给编辑器 / 输入框。
 *   ↑ / ↓          移动高亮（循环）
 *   Enter / Tab    高亮的是分类行（或「全部 n 个」）→ 进入该分类；否则选中插入
 *   →              高亮的是分类行 → 进入；否则放行（照常挪光标）
 *   ←              已进入分类 → 回顶层；否则放行
 *   Backspace      已进入分类且查询词为空 → 回顶层（不删 `@`）；否则放行（照常删字 = 筛选变宽）
 *   Esc            关菜单（结束会话）
 * Shift+Enter / Shift+Tab 不拦（换行、缩进等既有行为）。输入法组字中的键宿主自己先放行，不进这里。 */

import type { Candidate, MentionCategory } from './mention-query'

export type MentionKeyAction =
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'enter'; cat: MentionCategory }
  | { type: 'back' }
  | { type: 'pick'; cand: Candidate }
  | { type: 'close' }

export interface MentionKeyContext {
  /** 宿主当前进入的分类（null = 顶层） */
  category: MentionCategory | null
  /** 触发符后面的查询词 */
  query: string
  /** 当前高亮的候选 */
  active: Candidate | undefined
}

/** 选中一个候选：分类行 = 进入，其余 = 插入（点击与 Enter / Tab 走同一条） */
export function activate(cand: Candidate): MentionKeyAction {
  return cand.kind === 'category' ? { type: 'enter', cat: cand.cat } : { type: 'pick', cand }
}

export function mentionKey(event: { key: string; shiftKey: boolean }, ctx: MentionKeyContext): MentionKeyAction | null {
  switch (event.key) {
    case 'ArrowDown':
      return { type: 'move', delta: 1 }
    case 'ArrowUp':
      return { type: 'move', delta: -1 }
    case 'Enter':
    case 'Tab':
      if (event.shiftKey) return null
      return ctx.active ? activate(ctx.active) : null
    case 'ArrowRight':
      return ctx.active?.kind === 'category' ? { type: 'enter', cat: ctx.active.cat } : null
    case 'ArrowLeft':
      return ctx.category ? { type: 'back' } : null
    case 'Backspace':
      return ctx.category && ctx.query === '' ? { type: 'back' } : null
    case 'Escape':
      return { type: 'close' }
    default:
      return null
  }
}
