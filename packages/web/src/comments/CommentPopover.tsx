/* ---------- 划词评论的浮层（窄屏；放得下右侧评论栏时画成卡片，见 CommentMargin）----------
 * 锚在被评论的那段字下方（下面放不下翻到上方），fixed 定位、滚动 / 窗口变化时按锚点重新求位置。
 * 两种内容：已有的串（CommentThread）；刚选中的字写第一条评论（引用原文 + 输入框，发出后变成那个串）。
 * 点浮层外面 / Esc 收起；点到别的高亮不先收（高亮的点击会直接换成那个串）。锚定的字没了（被删）浮层自己收起。 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { commentRange } from './comment-anchor'
import CommentThread, { DraftComposer, type CommentCtx } from './CommentThread'
import type { Thread } from './comments-api'
import { closePopover, type Popover } from './comments-store'
import { useDismiss } from './use-dismiss'

const C = COPY.comments
const GAP = 8

interface Props {
  popover: Popover
  threads: Thread[]
  getView: () => EditorView | undefined
  ctx: CommentCtx
}

export default function CommentPopover({ popover, threads, getView, ctx }: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const thread = popover.kind === 'thread' ? threads.find((t) => t.id === popover.threadId) : undefined
  const anchor = popover.kind === 'draft' ? popover.anchor : thread?.anchor

  const place = useCallback(() => {
    const view = getView()
    const box = boxRef.current
    if (!view || view.isDestroyed || !box || !anchor) return
    const range = commentRange(view, anchor)
    if (!range) return closePopover()
    const start = view.coordsAtPos(range.from)
    const end = view.coordsAtPos(range.to, -1)
    const h = box.offsetHeight
    const w = box.offsetWidth
    let top = end.bottom + GAP
    if (top + h > window.innerHeight - GAP && start.top - h - GAP > GAP) top = start.top - h - GAP
    const left = Math.max(GAP, Math.min(start.left, window.innerWidth - w - GAP))
    setPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }))
  }, [getView, anchor])

  // 每次渲染后重量一次（串里多了评论、文档变了都会改变高度 / 锚点位置）；值没变不触发重渲染
  useLayoutEffect(place)

  useEffect(() => {
    const onScroll = (): void => place()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [place])
  useDismiss(true, (target) => !!boxRef.current?.contains(target))

  // 串被删了 / 不在列表里了（别人删光了评论）：收起
  useEffect(() => {
    if (popover.kind === 'thread' && !thread) closePopover()
  }, [popover, thread])

  if (!anchor) return null
  return (
    <div
      ref={boxRef}
      className="pop-card cm-pop"
      role="dialog"
      aria-label={C.drawer}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      <div className="cm-pop-head">
        <div className="cm-quote">{anchor.text}</div>
        <button type="button" className="vh-close" aria-label={C.cancel} onClick={closePopover}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {thread ? (
        <CommentThread thread={thread} ctx={ctx} onEscape={closePopover} />
      ) : (
        !ctx.readOnly && <DraftComposer anchor={anchor} ctx={ctx} />
      )}
    </div>
  )
}
