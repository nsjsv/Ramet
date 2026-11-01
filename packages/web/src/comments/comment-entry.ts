/* ---------- 划词菜单「评论」的入口登记 ----------
 * 框选菜单（editor/selection-menu.ts）是非 React 的插件视图，评论 UI 在 React 里：页面挂评论时（文档视图、doc 页）登记一个入口，
 * 菜单有入口才摆「评论」按钮。对话视图 / 过程页 / skill 页不登记，按钮自然不出现。 */

import type { EditorView } from '@milkdown/kit/prose/view'

export type CommentEntry = (view: EditorView, range: { from: number; to: number }) => void

const entries = new Map<string, CommentEntry>()

/** 返回撤销函数；只撤自己登记的那一份（换页时新页可能已经先登记了） */
export function setCommentEntry(pageId: string, entry: CommentEntry): () => void {
  entries.set(pageId, entry)
  return () => {
    if (entries.get(pageId) === entry) entries.delete(pageId)
  }
}

export function commentEntry(pageId: string): CommentEntry | undefined {
  return entries.get(pageId)
}
