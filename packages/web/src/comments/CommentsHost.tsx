/* ---------- 一个页面的评论宿主（编辑页 / 公开页各挂一个）----------
 * 绑定 store、把未解决的划词串（和正在写的草稿）喂给高亮插件、登记划词菜单的「评论」入口（只编辑页）、
 * 处理 `?comment=<串>` 深链（划词串滚到锚点开浮层；整页讨论 / 原文已删除的打开抽屉并展开），画浮层与抽屉。
 * 整页讨论区（PageDiscussion）由宿主页面放在正文下方，同一个 store。 */

import { useEffect, useRef } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { encodeAnchor, scrollToAnchor, setCommentMarks, yContextOf, type CommentMark } from './comment-anchor'
import { setCommentEntry } from './comment-entry'
import CommentPopover from './CommentPopover'
import CommentsDrawer from './CommentsDrawer'
import type { CommentCtx } from './CommentThread'
import { bindCommentsPage, openDraft, openDrawer, openThread, useComments } from './comments-store'

/** 草稿的高亮 id（还没有串）：点它什么也不做 */
const DRAFT = '__draft'

const onMarkClick = (id: string): void => {
  if (id !== DRAFT) openThread(id)
}

interface Props {
  pageId: string
  mode: 'auth' | 'public'
  getView: () => EditorView | undefined
  ctx: CommentCtx
  /** URL 里的 ?comment= */
  deepLink?: string | null
  /** 正文已经和服务端同步过（深链要等它：本地缓存先出的内容里可能还没有锚定的字） */
  ready?: () => boolean
}

export default function CommentsHost({ pageId, mode, getView, ctx, deepLink, ready }: Props) {
  const s = useComments()
  useEffect(() => bindCommentsPage(pageId, mode), [pageId, mode])

  useEffect(() => {
    if (mode !== 'auth') return
    return setCommentEntry(pageId, (view, range) => {
      const anchor = encodeAnchor(view.state.doc, yContextOf(view.state), range.from, range.to)
      if (anchor) openDraft(anchor)
    })
  }, [pageId, mode])

  const ours = s.pageId === pageId
  const { threads, popover } = s
  useEffect(() => {
    const view = getView()
    if (!view || !ours) return
    const marks: CommentMark[] = []
    for (const t of threads) if (t.kind === 'inline' && t.anchor && !t.resolvedAt) marks.push({ id: t.id, anchor: t.anchor })
    if (popover?.kind === 'draft') marks.push({ id: DRAFT, anchor: popover.anchor })
    const active = popover?.kind === 'thread' ? popover.threadId : popover ? DRAFT : null
    setCommentMarks(view, marks, active, onMarkClick)
  }, [threads, popover, ours, ctx.tick, getView])
  // 卸载（换页 / 切到对话视图）：高亮撤掉
  useEffect(
    () => () => {
      const view = getView()
      if (view) setCommentMarks(view, [], null, null)
    },
    [getView],
  )

  const handled = useRef('')
  useEffect(() => {
    if (!deepLink) handled.current = '' // 参数没了：下次再点同一个深链（收件箱）还要能打开
    if (!deepLink || !ours || !s.loaded) return
    const key = `${pageId}:${deepLink}`
    if (handled.current === key) return
    const thread = threads.find((t) => t.id === deepLink)
    if (thread?.kind === 'inline' && thread.anchor) {
      const view = getView()
      if (!view || !(ready?.() ?? true)) return // 等下一次 tick
      if (scrollToAnchor(view, thread.anchor)) {
        handled.current = key
        openThread(thread.id)
        return
      }
    }
    handled.current = key
    if (thread) openDrawer(thread.id)
  }, [deepLink, ours, s.loaded, threads, pageId, ctx.tick, getView, ready])

  if (!ours) return null
  return (
    <>
      {popover && <CommentPopover popover={popover} threads={threads} getView={getView} ctx={ctx} />}
      {s.drawer && <CommentsDrawer threads={threads} expanded={s.expanded} ctx={ctx} getView={getView} />}
    </>
  )
}
