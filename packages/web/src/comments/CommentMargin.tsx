/* ---------- 右侧评论栏：划词评论的卡片（Notion 式，贴画面右缘）----------
 * 宿主把它挂在滚动口（编辑页 .main、公开页 .public-page）里、紧挨正文列之前：流内 0 高、铺满滚动口内容盒宽的盒子（.cm-margin），
 * 卡片 absolute 靠右挂在里面，随正文一起滚，不用监听滚动；不放进正文列，是因为卡片要贴画面右缘，不跟列走（列侧栏开合时还会 FLIP 平移）。
 * 不给滚动口加 position（会改掉里面现有 absolute 后代的包含块），也不用 fixed（滚动时要跟着正文走）。
 * - 量宽：滚动口内容盒放得下评论栏 → store.wide（CommentsHost 据此不弹浮层，激活的串画成卡片）。
 * - 有卡片可画（未解决且锚点解析得出的划词串，或正在写的草稿）→ 给正文列写 data-cm-margin，CSS 让列右缘离开评论栏
 *   （居中时本来就够远就不动），开合走 flip()。
 *   用属性不用 class：React 不碰它没声明的属性，列的 className 重算冲不掉；hud/make-room.ts 只盯列的 class，
 *   评论栏开合不让它重算让位（否则让位 → 变窄 → 栏收 → 让位变少 → 栏开，来回推）。
 * - 排布：卡片顶边对齐锚点第一行，重叠的往下推；激活的钉在锚点，上面的往上让（margin-layout.ts）。
 *   每次渲染后量一遍、有变化才 setState；文档变化（高亮插件通知）、列 / 卡片尺寸变化（ResizeObserver）触发重渲。
 * 卡片收起时画首条评论和回复（长串中间折起），点了激活（同点高亮）；激活的画整个串（同浮层），草稿是新串输入框。
 * 指针停在卡片上：store.hover，CommentsHost 让它在正文里的高亮加深。 */

import { Fragment, useEffect, useLayoutEffect, useReducer, useRef, useState, type KeyboardEvent } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { COPY } from '../copy'
import { flip } from '../motion'
import { subscribePeople } from '../people'
import { relativeTime } from '../UpdatesFeed'
import CommentBody from './CommentBody'
import CommentThread, { CommentAvatar, DraftComposer, type CommentCtx } from './CommentThread'
import { commentRange, onCommentDocChange } from './comment-anchor'
import type { Anchor, Comment, Thread } from './comments-api'
import { DRAFT_ID, closePopover, hoverThread, openThread, setWide, useComments } from './comments-store'
import { CARD_PAD, marginFits, stackCards, type CardBox } from './margin-layout'
import { useDismiss } from './use-dismiss'

const C = COPY.comments
const ATTR = 'data-cm-margin'

type Placed = { id: string; top: number }

/** 正文列所在滚动口的内容盒放得下评论栏吗（列的左内边距与 --cm-right 不随评论栏开合变，判定不会自激） */
function fitsIn(column: HTMLElement, wasWide: boolean): boolean {
  const host = column.parentElement
  if (!host) return false
  const hs = getComputedStyle(host)
  const cs = getComputedStyle(column)
  const available = host.clientWidth - (parseFloat(hs.paddingLeft) || 0) - (parseFloat(hs.paddingRight) || 0)
  return marginFits(available, parseFloat(cs.paddingLeft) || 0, parseFloat(cs.getPropertyValue('--cm-right')) || 0, wasWide)
}

function setColumnMargin(column: HTMLElement, on: boolean, animate: boolean): void {
  if (column.hasAttribute(ATTR) === on) return
  if (animate) flip([column], () => column.toggleAttribute(ATTR, on))
  else column.toggleAttribute(ATTR, on)
}

const samePlaced = (a: Placed[], b: Placed[]): boolean => a.length === b.length && a.every((p, i) => p.id === b[i]!.id && p.top === b[i]!.top)

/** 收起的卡片最多画几条评论；再多就留首条和最后 TAIL 条，中间折成「还有 N 条回复」（长串不至于把下面的卡片推出很远） */
const PREVIEW_MAX = 4
const TAIL = 2

function PreviewItem({ comment, ctx }: { comment: Comment; ctx: CommentCtx }) {
  if (comment.deleted) return <div className="cm-item is-deleted">{C.deleted}</div>
  return (
    <div className="cm-item">
      <div className="cm-meta">
        <CommentAvatar author={comment.author} spaceId={ctx.spaceId} />
        <span className="cm-name">{comment.author?.name ?? C.deletedUser}</span>
        <span className="cm-time">{relativeTime(comment.createdAt)}</span>
      </div>
      <CommentBody body={comment.body} />
    </div>
  )
}

/** 收起的卡片：首条评论和回复（每条正文截三行，CSS 管），太长的串中间折起来 */
function Preview({ thread, ctx }: { thread: Thread; ctx: CommentCtx }) {
  const all = thread.comments
  const folded = all.length > PREVIEW_MAX ? all.length - 1 - TAIL : 0
  const shown = folded > 0 ? [all[0]!, ...all.slice(-TAIL)] : all
  return (
    <div className="cm-list">
      {shown.map((c, i) => (
        <Fragment key={c.id}>
          <PreviewItem comment={c} ctx={ctx} />
          {i === 0 && folded > 0 && <div className="cm-card-replies">{C.moreReplies(folded)}</div>}
        </Fragment>
      ))}
    </div>
  )
}

interface Props {
  pageId: string
  /** 正文列（编辑页 .editor-page、公开页 .public-main）：它和这个组件同在一个滚动口里 */
  getColumn: () => HTMLElement | null
  getView: () => EditorView | undefined
  ctx: CommentCtx
  /** 正文已经和服务端同步过（之前锚点可能还解析不全）；不给 = 一直是 */
  ready?: () => boolean
}

export default function CommentMargin({ pageId, getColumn, getView, ctx, ready }: Props) {
  const s = useComments()
  const slotRef = useRef<HTMLDivElement>(null)
  const cardEls = useRef(new Map<string, HTMLDivElement>())
  const [fits, setFits] = useState(false)
  const [placed, setPlaced] = useState<Placed[]>([])
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const viewOf = useRef(getView)
  viewOf.current = getView
  const columnOf = useRef(getColumn)
  columnOf.current = getColumn
  // 这一页的评论和正文都到齐了：之后的开合（写第一条、解决最后一条、窗口跨过阈值）才做平移动画，进页面时直接就位
  const settled = useRef<string | null>(null)

  const ours = s.pageId === pageId
  const { popover } = s
  const activeId = popover?.kind === 'thread' ? popover.threadId : popover ? DRAFT_ID : null
  const anchors = new Map<string, Anchor>()
  const byId = new Map<string, Thread>()
  if (ours) {
    for (const t of s.threads) {
      if (t.kind !== 'inline' || !t.anchor || t.resolvedAt) continue
      anchors.set(t.id, t.anchor)
      byId.set(t.id, t)
    }
    if (popover?.kind === 'draft') anchors.set(DRAFT_ID, popover.anchor)
  }

  // 文档变了、列 / 宿主 / 卡片尺寸变了、成员名单到了（头像换真图，高度可能变）：下一帧重量
  const frame = useRef(0)
  const schedule = useRef(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      bump()
    })
  })
  const ro = useRef<ResizeObserver | null>(null)
  const watched = useRef(new Set<Element>())
  useEffect(() => {
    const kick = schedule.current
    const observer = new ResizeObserver(kick)
    ro.current = observer
    for (const el of [columnOf.current(), slotRef.current?.parentElement]) if (el) observer.observe(el)
    const offDoc = onCommentDocChange((view) => view === viewOf.current() && kick())
    const offPeople = subscribePeople(kick)
    return () => {
      observer.disconnect()
      ro.current = null
      watched.current.clear()
      offDoc()
      offPeople()
      cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [])

  useLayoutEffect(() => {
    const slot = slotRef.current
    const column = getColumn()
    if (!slot || !column) return
    const wide = fitsIn(column, fits)
    const view = getView()
    const visible = !!view && !view.isDestroyed && view.dom.getClientRects().length > 0
    const resolved: { id: string; from: number }[] = []
    if (wide && visible) {
      for (const [id, anchor] of anchors) {
        const range = commentRange(view, anchor)
        if (range) resolved.push({ id, from: range.from })
      }
    }
    setColumnMargin(column, resolved.length > 0, settled.current === pageId)
    if (ours && s.loaded && (ready?.() ?? true)) settled.current = pageId
    // 先开合列（布局变了）再量锚点
    const base = slot.getBoundingClientRect().top
    const boxes: (CardBox & { from: number })[] = resolved.map(({ id, from }) => ({
      id,
      from,
      ideal: view!.coordsAtPos(from, 1).top - base - CARD_PAD,
      height: cardEls.current.get(id)?.offsetHeight ?? 0,
    }))
    boxes.sort((a, b) => a.ideal - b.ideal || a.from - b.from)
    const tops = stackCards(boxes, activeId)
    const next = boxes.map((b) => ({ id: b.id, top: Math.round(tops.get(b.id) ?? b.ideal) }))
    if (!samePlaced(next, placed)) setPlaced(next)
    if (wide !== fits) setFits(wide)
    setWide(wide)
    // 宽模式下激活的串画不出来（解决了、删了、锚定的字没了、正文不可见）：收起，别留一个看不见的激活态
    if (wide && ours && s.loaded && activeId && !resolved.some((r) => r.id === activeId)) closePopover()
    // 新出现的卡片接进 ResizeObserver（同一个元素重复 observe 会再报一次尺寸，所以只接新的）
    const observer = ro.current
    if (observer) {
      const live = new Set<Element>(cardEls.current.values())
      for (const el of watched.current) if (!live.has(el)) observer.unobserve(el)
      for (const el of live) if (!watched.current.has(el)) observer.observe(el)
      watched.current = live
    }
  })

  // 拆掉（换到对话视图 / 划词评论关了）：列复位，激活的串回到浮层口径
  useEffect(() => {
    // 拆除时宿主的 ref 可能已经摘掉了，列在挂上时就记住
    const column = columnOf.current()
    return () => {
      column?.removeAttribute(ATTR)
      setWide(false)
      hoverThread(null)
    }
  }, [])

  useDismiss(fits && !!popover, (target) => !!target.closest('.cm-card'))

  const activate = (id: string) => (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    openThread(id)
  }

  return (
    <div className="cm-margin" ref={slotRef}>
      {placed.map(({ id, top }) => {
        const thread = byId.get(id)
        const draft = id === DRAFT_ID && popover?.kind === 'draft' ? popover.anchor : null
        const initial = popover?.kind === 'draft' ? popover.initial : undefined
        if (!thread && !draft) return null
        const active = id === activeId
        const ref = (el: HTMLDivElement | null): void => {
          if (el) cardEls.current.set(id, el)
          else cardEls.current.delete(id)
        }
        const style = { transform: `translateY(${top}px)` }
        const hover = { onMouseEnter: () => hoverThread(id), onMouseLeave: () => hoverThread(null) }
        if (draft) {
          return (
            <div key={id} ref={ref} className="cm-card is-active is-draft" style={style} role="dialog" aria-label={C.drawer}>
              {/* 预填的字不同就换一个新框：框只在建起来那一刻读 initial */}
              <DraftComposer key={initial ?? ''} anchor={draft} ctx={ctx} initial={initial} />
            </div>
          )
        }
        if (active) {
          return (
            <div key={id} ref={ref} className="cm-card is-active" style={style} role="dialog" aria-label={C.drawer} {...hover}>
              <CommentThread thread={thread!} ctx={ctx} onEscape={closePopover} />
            </div>
          )
        }
        return (
          <div
            key={id}
            ref={ref}
            className="cm-card"
            style={style}
            role="button"
            tabIndex={0}
            onClick={() => openThread(id)}
            onKeyDown={activate(id)}
            {...hover}
          >
            <Preview thread={thread!} ctx={ctx} />
          </div>
        )
      })}
    </div>
  )
}
