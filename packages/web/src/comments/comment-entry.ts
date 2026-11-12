/* ---------- 划词评论的入口登记 ----------
 * 框选菜单（editor/selection-menu.ts）与正文里 @空间 AI（editor/doc-mention.ts）是非 React 的插件，评论 UI 在 React 里：
 * 页面挂着划词评论时（文档视图、doc 页、划词评论开着）登记一个入口，有入口才摆「评论」按钮、才能在正文里 @AI 开框。
 * 对话视图 / 过程页 / skill 页 / 划词评论关着不登记。 */

import type { EditorView } from '@milkdown/kit/prose/view'
import { COPY } from '../copy'
import { toast } from '../ui/toast'
import { spaceAiMark } from './comments-api'

/** 在 range 上开新评论框；initial = 框里预先写好的字。返回开没开成（区间里没有字 / 没有协同绑定时开不了） */
export type CommentEntry = (view: EditorView, range: { from: number; to: number }, initial?: string) => boolean

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

/** 正文普通段落里 @空间 AI 的宿主一侧（editor-session.ts 交给 doc-mention 插件）：在 range 上开新评论框、预填空间 AI（label = 它的名字）的记号；
 *  这一页没有划词评论 / range 空 / 锚点算不出来就提示原因、不开框 */
export function openAiComment(pageId: string): (view: EditorView, range: { from: number; to: number } | null, label: string) => void {
  return (view, range, label) => {
    const entry = commentEntry(pageId)
    if (!entry) return toast(COPY.comments.aiNoInline)
    if (!range || !entry(view, range, `${spaceAiMark(label)} `)) toast(COPY.comments.aiNoText)
  }
}
