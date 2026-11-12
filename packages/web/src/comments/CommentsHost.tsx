/* ---------- 一个页面的评论宿主（编辑页 / 公开页各挂一个）----------
 * 绑定 store、把未解决的划词串（和正在写的草稿）喂给高亮插件、登记划词菜单的「评论」入口（只编辑页）、
 * 处理 `?comment=<串>` 深链（划词串滚到锚点并激活；整页讨论 / 原文已删除的打开抽屉并展开），画浮层与抽屉。
 * 激活的串放得下右侧评论栏（store.wide）时画成卡片、不弹浮层。
 * 右侧评论栏（CommentMargin）与整页讨论区（PageDiscussion）由宿主页面放在正文列里，同一个 store。
 * 两种评论的开关（kinds）由宿主读页面属性传进来：服务端只列开着的那种串，划词评论关着就不登记划词入口。
 * 宿主按开关做 key：开关一变就重新绑定、重拉（别人切的开关随页面树重拉过来，也走这条）。
 * 代回复（draft，收件箱「代回复」带 `&draft=1` 进来）：`?comment=` 打开那个串之后起草回复；`?block=` 在那一块的整段文字上开新评论框再起草。
 * 草稿经 reply-draft.ts 流式写进框里；交给框之后调 onDraftTaken（宿主把 URL 里的 draft 去掉，刷新 / 后退回来不再生成一遍）。 */

import { useEffect, useRef } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { COPY } from '../copy'
import { findBlock } from '../editor/block-id'
import { toast } from '../ui/toast'
import { encodeAnchor, scrollToAnchor, setCommentMarks, yContextOf, type CommentMark } from './comment-anchor'
import { setCommentEntry } from './comment-entry'
import CommentPopover from './CommentPopover'
import CommentsDrawer from './CommentsDrawer'
import type { CommentSwitchState } from './CommentSwitches'
import type { CommentCtx } from './CommentThread'
import type { Thread } from './comments-api'
import { DRAFT_ID, bindCommentsPage, openDraft, openDrawer, openThread, useComments } from './comments-store'
import { blockText, mentionReplyBody, threadReplyBody } from './reply-context'
import { startReplyDraft, stopReplyDraft } from './reply-draft'

const C = COPY.comments

/** 代回复一个串：解决了的没有回复框，说明原因 */
function draftThread(thread: Thread, title: string): void {
  if (thread.resolvedAt) return toast(C.draftResolved)
  const body = threadReplyBody({
    instruction: C.draftInstruction,
    title,
    quote: thread.anchor?.text ?? '',
    comments: thread.comments,
    deletedUser: C.deletedUser,
    omitted: C.draftOmitted,
  })
  startReplyDraft({ target: thread.id }, body)
}

// 草稿的高亮（还没有串）：点它什么也不做
const onMarkClick = (id: string): void => {
  if (id !== DRAFT_ID) openThread(id)
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
  kinds: CommentSwitchState
  /** 代回复：URL 带 draft=1 时给（title = 页面标题，block = ?block= 的块）；没有 = null */
  draft?: { title: string; block: string | null } | null
  /** 草稿交出去了：宿主去掉 URL 里的 draft */
  onDraftTaken?: () => void
}

export default function CommentsHost({ pageId, mode, getView, ctx, deepLink, ready, kinds, draft, onDraftTaken }: Props) {
  const s = useComments()
  useEffect(() => bindCommentsPage(pageId, mode), [pageId, mode])
  // 换页 / 卸载：还在生成的草稿停掉（别的页的框接不着它）
  useEffect(() => () => stopReplyDraft(), [pageId])

  const inline = kinds.inline
  useEffect(() => {
    if (mode !== 'auth' || !inline) return
    return setCommentEntry(pageId, (view, range) => {
      const anchor = encodeAnchor(view.state.doc, yContextOf(view.state), range.from, range.to)
      if (anchor) openDraft(anchor)
    })
  }, [pageId, mode, inline])

  const ours = s.pageId === pageId
  const { threads, popover, hover } = s
  useEffect(() => {
    const view = getView()
    if (!view || !ours) return
    const marks: CommentMark[] = []
    for (const t of threads) if (t.kind === 'inline' && t.anchor && !t.resolvedAt) marks.push({ id: t.id, anchor: t.anchor })
    if (popover?.kind === 'draft') marks.push({ id: DRAFT_ID, anchor: popover.anchor })
    const active = popover?.kind === 'thread' ? popover.threadId : popover ? DRAFT_ID : null
    setCommentMarks(view, marks, active, hover, onMarkClick)
  }, [threads, popover, hover, ours, ctx.tick, getView])
  // 卸载（换页 / 切到对话视图）：高亮撤掉
  useEffect(
    () => () => {
      const view = getView()
      if (view) setCommentMarks(view, [], null, null, null)
    },
    [getView],
  )

  const handled = useRef('')
  const title = draft?.title ?? ''
  const draftOn = !!draft
  useEffect(() => {
    if (!deepLink) handled.current = '' // 参数没了：下次再点同一个深链（收件箱）还要能打开
    if (!deepLink || !ours || !s.loaded) return
    // 带不带 draft 算两次：看过这个串之后再点「代回复」还要起草
    const key = `${pageId}:${deepLink}:${draftOn ? 'draft' : ''}`
    if (handled.current === key) return
    const thread = threads.find((t) => t.id === deepLink)
    const taken = (): void => {
      handled.current = `${pageId}:${deepLink}:` // URL 里的 draft 去掉之后还是这个深链，不再处理
      if (!thread) toast(C.draftGone)
      else draftThread(thread, title)
      onDraftTaken?.()
    }
    if (thread?.kind === 'inline' && thread.anchor) {
      const view = getView()
      if (!view || !(ready?.() ?? true)) return // 等下一次 tick
      if (scrollToAnchor(view, thread.anchor)) {
        handled.current = key
        openThread(thread.id)
        if (draftOn) taken()
        return
      }
    }
    handled.current = key
    if (thread) openDrawer(thread.id)
    if (draftOn) taken()
  }, [deepLink, ours, s.loaded, threads, pageId, ctx.tick, getView, ready, draftOn, title, onDraftTaken])

  // 正文里被 @ 了的代回复：在那一块的整段文字上开新评论框（划词评论关着由宿主页面说明，这里不开）
  const block = draft && !deepLink && mode === 'auth' && inline ? draft.block : null
  const drafted = useRef('')
  useEffect(() => {
    if (!block) drafted.current = ''
    if (!block || !ours || !s.loaded) return
    const key = `${pageId}:${block}`
    if (drafted.current === key) return
    const view = getView()
    if (!view || !(ready?.() ?? true)) return // 等下一次 tick
    drafted.current = key
    onDraftTaken?.()
    const found = findBlock(view.state.doc, block)
    if (!found) return toast(C.draftGone)
    const { node, pos } = found
    const anchor = encodeAnchor(view.state.doc, yContextOf(view.state), pos + 1, pos + node.nodeSize - 1)
    if (!anchor) return toast(C.draftNoText)
    openDraft(anchor)
    const body = mentionReplyBody({ instruction: C.draftMentionInstruction, title, quote: blockText(node) })
    startReplyDraft({ target: DRAFT_ID, anchor }, body)
  }, [block, ours, s.loaded, pageId, ctx.tick, getView, ready, title, onDraftTaken])

  if (!ours) return null
  return (
    <>
      {popover && !s.wide && <CommentPopover popover={popover} threads={threads} getView={getView} ctx={ctx} />}
      {s.drawer && <CommentsDrawer threads={threads} expanded={s.expanded} ctx={ctx} getView={getView} kinds={kinds} />}
    </>
  )
}
