// ---------- 时间线视图 ----------
// 左栏是行标题（固定宽，横向滚动时贴在左边），右边是横向时间轴，两边逐行对齐、共用一个滚动层（表头吸顶，竖向只画看得见的行）。
// 排版全在 timeline-model（纯函数）：刻度（日 / 周 / 月 / 季）、取数分块、表头、横条位置、拖动改起止。
// 取数：视口覆盖到的块（左右各多一块）各是一个按日期范围取的窗口（useRangeWindows 取全），合起来按视图顺序排；
// 横向滚到没取过的时间段就多看一块。没有日期的行在底部的「未排期」（none 窗口，滚到底续取），可一键排到今天。
// 刻度与视口左缘是个人状态（本机记忆，personal.ts），不写集合文档。
// · 横条：单日也占一整天；只有「日期」属性能改：拖整条 = 平移，拖两端 = 改开始 / 结束，拖动中只改本地预览、松手写一次；
//   按创建 / 编辑时间排、或 viewer 时不能拖。点横条或标题打开行页面
// · 左栏底部「＋ 新建」：新行日期 = 今天（否则会落进「未排期」看不到），就地输入标题
// 横条位置用 transform: translateX + width，拖动预览不做过渡；落下后行换位置用 motion.ts 的 flip()，不做 width / height / margin 过渡。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { addDays, daysBetween, isCalendarDate, TITLE_PROP, type CollectionRow, type CollectionSchema, type CollectionView, type DateSpan } from '@ramet/shared/collection-model'
import { dateByProp, RANGE_NONE, rowSpan, sortRows } from '@ramet/shared/collection-query'
import { COPY } from '../../copy'
import { Icon } from '../../icons'
import { flip } from '../../motion'
import { PageIcon } from '../../PageIcon'
import { CellEditor } from '../cells/CellEditor'
import { useRowsWindow, type CollectionHandle } from '../collection-store'
import { RANGE_ROWS_CAP } from '../collection-windows'
import { DateSetup } from '../date-setup'
import { useLoadMore } from '../load-more'
import { readPersonal, writePersonal } from '../personal'
import { localDay } from '../../ui/date-model'
import { useRangeWindows } from '../range-rows'
import {
  AXIS_DAYS,
  axisOrigin,
  barOf,
  centerLeft,
  chunkOf,
  chunksFor,
  dayAt,
  defaultLeft,
  dragSpan,
  headerTicks,
  isScale,
  mergeRows,
  SCALE_ORDER,
  SCALES,
  spanValue,
  visibleRange,
  zoomLeft,
  type DragMode,
  type Scale,
  type Tick,
} from './timeline-model'

const C = COPY.collection

/** 左栏宽、行高、两层表头的高（像素，与 collection-timeline.css 一致：经 CSS 变量传过去） */
const LEFT_W = 240
const ROW_H = 34
const HEAD_H = 52
/** 离轴的两头不到这么远就换 origin（视口不动） */
const EDGE = 800
/** 横条窄于它时标题画在横条右边 */
const LABEL_INSIDE = 72

type Props = {
  handle: CollectionHandle
  schema: CollectionSchema
  view: CollectionView
  readOnly: boolean
  spaceId: string | null
  onOpenRow: (rowId: string) => void
}

type Saved = { scale: Scale; left: string | null }
const savedKey = (viewId: string): string => `ramet.collection.timeline.${viewId}`

function readSaved(viewId: string): Saved {
  try {
    const raw: unknown = JSON.parse(readPersonal(savedKey(viewId)) ?? 'null')
    const v = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
    return { scale: isScale(v.scale) ? v.scale : 'week', left: typeof v.left === 'string' && isCalendarDate(v.left) ? v.left : null }
  } catch {
    return { scale: 'week', left: null }
  }
}

/** 滚动层的视口：x / y = scrollLeft / scrollTop；x < 0 = 还没量过 */
type Viewport = { x: number; y: number; w: number; h: number }
type BarDrag = { rowId: string; span: DateSpan; mode: DragMode; x0: number; moved: boolean; days: number }

const num = (day: string, from: number, to: number): number => Number(day.slice(from, to))

/** 表头一格的文字：月份在上层写全年月（日 / 周刻度），在下层只写月（上层已是年） */
function tickLabel(unit: string, start: string, top: boolean): string {
  const year = num(start, 0, 4)
  const month = num(start, 5, 7)
  const day = num(start, 8, 10)
  if (unit === 'year') return C.date.year(year)
  if (unit === 'quarter') return C.date.quarter(Math.floor((month - 1) / 3) + 1)
  if (unit === 'month') return top ? C.date.monthTitle(year, month) : C.date.month(month)
  if (unit === 'week') return C.date.firstDay(month, day)
  return String(day)
}

export default function TimelineView({ handle, schema, view, readOnly, spaceId, onOpenRow }: Props) {
  const prop = dateByProp(view, schema)
  const [saved] = useState(() => readSaved(view.id))
  const today = localDay()
  const [scale, setScale] = useState<Scale>(saved.scale)
  const [origin, setOrigin] = useState(() => axisOrigin(saved.scale, saved.left ?? defaultLeft(saved.scale, localDay(), 900)))
  const [vp, setVp] = useState<Viewport>({ x: -1, y: 0, w: 0, h: 0 })
  const [naming, setNaming] = useState<string | null>(null)
  const [noneOpen, setNoneOpen] = useState(false)
  const [preview, setPreview] = useState<{ rowId: string; span: DateSpan } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<HTMLDivElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  /** 换了 origin / 刻度之后要补回的 scrollLeft（渲染出新的轴之后才能设） */
  const pendingX = useRef<number | null>(null)
  const frame = useRef(0)
  const drag = useRef<BarDrag | null>(null)

  const px = SCALES[scale]
  const axisW = AXIS_DAYS[scale] * px
  const axisVp = Math.max(px, vp.w - LEFT_W)
  const leftDay = vp.x < 0 ? (saved.left ?? today) : dayAt(vp.x, origin, scale)
  const rightDay = addDays(leftDay, Math.ceil(axisVp / px))
  const ranges = useMemo(() => (prop ? chunksFor(scale, leftDay, rightDay).map((c) => c.range) : []), [prop, scale, leftDay, rightDay])
  const data = useRangeWindows(handle, prop ? view.id : null, ranges)
  const ctx = useMemo(() => handle.queryCtx(), [handle])
  const rows = useMemo(() => sortRows(mergeRows(data.lists), view, schema, ctx), [data.lists, view, schema, ctx])
  const none = useRowsWindow(handle, prop?.type === 'date' ? view.id : null, { range: RANGE_NONE })
  const header = useMemo(() => headerTicks(scale, origin, addDays(origin, AXIS_DAYS[scale] - 1)), [scale, origin])
  const canDrag = !readOnly && prop?.type === 'date'

  const measure = (): void => {
    const el = scrollRef.current
    if (!el) return
    setVp((cur) =>
      cur.x === el.scrollLeft && cur.y === el.scrollTop && cur.w === el.clientWidth && cur.h === el.clientHeight
        ? cur
        : { x: el.scrollLeft, y: el.scrollTop, w: el.clientWidth, h: el.clientHeight },
    )
  }
  const applyPending = (): void => {
    const el = scrollRef.current
    if (!el || pendingX.current === null) return
    el.scrollLeft = pendingX.current
    pendingX.current = null
    measure()
  }
  /** 把视口左缘挪到 left（可同时换刻度）：轴按新的左缘重画，渲染完再补 scrollLeft */
  const jumpTo = (left: string, nextScale: Scale = scale): void => {
    const nextOrigin = axisOrigin(nextScale, left)
    pendingX.current = daysBetween(nextOrigin, left) * SCALES[nextScale]
    if (nextScale === scale && nextOrigin === origin) applyPending()
    setScale(nextScale)
    setOrigin(nextOrigin)
  }

  useLayoutEffect(applyPending, [origin, scale])
  // 滚动层出现时（有了日期属性）：按记住的左缘、或让今天落在视口三分之一处
  const shown = prop !== undefined
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    jumpTo(saved.left ?? defaultLeft(scale, localDay(), el.clientWidth - LEFT_W))
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
    // 只在滚动层挂上时定一次位
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  // 记住刻度与左缘（停下来再写，滚动中不每帧写 localStorage）
  useEffect(() => {
    if (vp.x < 0) return
    const timer = setTimeout(() => writePersonal(savedKey(view.id), JSON.stringify({ scale, left: leftDay })), 400)
    return () => clearTimeout(timer)
  }, [view.id, scale, leftDay, vp.x])

  // 刚新建的行：滚到看得见
  useEffect(() => {
    const el = scrollRef.current
    const i = naming ? rows.findIndex((r) => r.id === naming) : -1
    if (!el || i < 0) return
    const top = i * ROW_H
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight - HEAD_H) el.scrollTop = Math.max(0, top - ROW_H * 2)
  }, [naming, rows])

  useLoadMore(sentinel, noneOpen ? none.window : null, none.loadMore)

  if (!prop) return <DateSetup doc={handle.doc} schema={schema} view={view} readOnly={readOnly} />

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const x = el.scrollLeft
    // 快到轴的两头：换 origin，scrollLeft 补回同一天同一处（视口不动）
    if (pendingX.current === null && (x < EDGE || x + el.clientWidth - LEFT_W > axisW - EDGE)) {
      const left = dayAt(x, origin, scale)
      const nextOrigin = axisOrigin(scale, left)
      if (nextOrigin !== origin) {
        pendingX.current = daysBetween(nextOrigin, left) * px + (x - daysBetween(origin, left) * px)
        setOrigin(nextOrigin)
        return
      }
    }
    if (!frame.current)
      frame.current = requestAnimationFrame(() => {
        frame.current = 0
        measure()
      })
  }

  const switchScale = (next: Scale): void => {
    if (next !== scale) jumpTo(zoomLeft(scale, next, leftDay, axisVp, today), next)
  }
  const goToday = (): void => jumpTo(centerLeft(scale, today, axisVp))

  const rowEls = (): Element[] => [...(rowsRef.current?.querySelectorAll('.cl-tl-row') ?? [])]

  const create = (): void => {
    const set = prop.type === 'date' ? { [prop.id]: today } : undefined
    const range = chunkOf(scale, today).range
    if (today < leftDay || today > rightDay) goToday()
    // 乐观新建：行立即出现在今天，就地输入标题；今天那一块还没取过（窗口里没有它）就等建成后打开它的页面
    const created = handle.createRow(set ? { set } : {}, { viewId: view.id, range })
    if (!created) return
    if (handle.windowState(view.id, { range }).window?.rows.some((r) => r.id === created.id)) setNaming(created.id)
    else void created.ready.then((row) => row && onOpenRow(row.id))
  }

  const startDrag = (e: React.PointerEvent<HTMLElement>, row: CollectionRow, span: DateSpan, mode: DragMode): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    drag.current = { rowId: row.id, span, mode, x0: e.clientX, moved: false, days: 0 }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const moveDrag = (e: React.PointerEvent<HTMLElement>): void => {
    const d = drag.current
    if (!d || (!d.moved && Math.abs(e.clientX - d.x0) < 3)) return
    const days = Math.round((e.clientX - d.x0) / px)
    if (d.moved && days === d.days) return
    d.moved = true
    d.days = days
    setPreview({ rowId: d.rowId, span: dragSpan(d.span, d.mode, days) })
  }
  const endDrag = (): void => {
    const d = drag.current
    drag.current = null
    setPreview(null)
    if (!d) return
    if (!d.moved) {
      if (d.mode === 'move') onOpenRow(d.rowId)
      return
    }
    const next = spanValue(dragSpan(d.span, d.mode, d.days))
    if (next !== spanValue(d.span)) flip(rowEls(), () => flushSync(() => void handle.setValues(d.rowId, { [prop.id]: next })))
  }

  const renderBar = (row: CollectionRow) => {
    const span = preview?.rowId === row.id ? preview.span : rowSpan(row, prop, ctx)
    if (!span) return null
    const { left, width } = barOf(span, origin, scale)
    const w = Math.max(width, 6)
    const title = row.title || COPY.untitled
    const inside = w >= LABEL_INSIDE
    return (
      <>
        <div
          className={'cl-tl-bar' + (canDrag ? ' is-draggable' : '') + (preview?.rowId === row.id ? ' is-dragging' : '')}
          style={{ transform: `translateX(${left}px)`, width: w }}
          data-tip={!readOnly && !canDrag ? C.date.locked : undefined}
          role="button"
          tabIndex={-1}
          {...(canDrag
            ? { onPointerDown: (e: React.PointerEvent<HTMLElement>) => startDrag(e, row, span, 'move'), onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: () => {
                drag.current = null
                setPreview(null)
              } }
            : { onClick: () => onOpenRow(row.id) })}
        >
          {canDrag && <span className="cl-tl-grip is-start" data-tip={C.date.resizeStart} onPointerDown={(e) => startDrag(e, row, span, 'start')} />}
          {inside && <span className="cl-tl-bar-name">{title}</span>}
          {canDrag && <span className="cl-tl-grip is-end" data-tip={C.date.resizeEnd} onPointerDown={(e) => startDrag(e, row, span, 'end')} />}
        </div>
        {!inside && (
          <span className="cl-tl-after" style={{ transform: `translateX(${left + w + 6}px)` }}>
            {title}
          </span>
        )}
      </>
    )
  }

  const renderName = (row: CollectionRow) => (
    <div
      className="cl-tl-name"
      role="button"
      tabIndex={naming === row.id ? -1 : 0}
      onClick={(e) => {
        if (naming !== row.id && e.currentTarget.contains(e.target as Node)) onOpenRow(row.id)
      }}
      onKeyDown={(e) => {
        if (naming !== row.id && e.target === e.currentTarget && e.key === 'Enter') onOpenRow(row.id)
      }}
    >
      <PageIcon icon={row.icon} placeholder={row.has_body} />
      {naming === row.id ? (
        <CellEditor
          prop={TITLE_PROP}
          value={undefined}
          doc={handle.doc}
          spaceId={spaceId}
          onCommit={(value) => {
            setNaming(null)
            // 只敲了空白 = 没起名：不发改名（改名会触发一次全站页面列表重拉）
            if (typeof value === 'string' && value.trim()) void handle.renameRow(row.id, value)
          }}
          onDone={() => setNaming(null)}
        />
      ) : (
        <span className={'cl-tl-title' + (row.title ? '' : ' is-empty')}>{row.title || COPY.untitled}</span>
      )}
    </div>
  )

  const tickStyle = (t: Tick) => ({ transform: `translateX(${daysBetween(origin, t.start) * px}px)`, width: t.days * px })
  const [first, end] = visibleRange(Math.max(0, vp.y), Math.max(vp.h - HEAD_H, ROW_H * 10), ROW_H, rows.length)
  const todayX = daysBetween(origin, today) * px
  const noneRows = none.window?.rows ?? []

  return (
    <div className="cl-tl" style={{ '--tl-left': `${LEFT_W}px`, '--tl-row': `${ROW_H}px`, '--tl-head': `${HEAD_H}px` } as React.CSSProperties}>
      <div className="cl-tl-bar-top">
        <div className="cl-tl-scales" role="group">
          {SCALE_ORDER.map((s) => (
            <button key={s} type="button" className={'cl-bar-btn' + (s === scale ? ' is-on' : '')} aria-pressed={s === scale} onClick={() => switchScale(s)}>
              {C.date.scales[s]}
            </button>
          ))}
        </div>
        <button type="button" className="cl-bar-btn" onClick={goToday}>
          {C.date.today}
        </button>
        {data.capped && <span className="cl-hint">{C.date.capped(RANGE_ROWS_CAP)}</span>}
        {data.error && <span className="cl-hint">{C.notFound}</span>}
      </div>
      <div ref={scrollRef} className={'cl-tl-scroll' + (data.loading ? ' is-loading' : '')} onScroll={onScroll}>
        <div className="cl-tl-canvas" style={{ width: LEFT_W + axisW }}>
          <div className="cl-tl-head">
            <div className="cl-tl-corner">{C.props.title}</div>
            <div className="cl-tl-ticks" style={{ width: axisW }}>
              {header.top.map((t) => (
                <div key={t.start} className="cl-tl-tick is-top" style={tickStyle(t)}>
                  <span>{tickLabel(header.topUnit, t.start, true)}</span>
                </div>
              ))}
              {header.bottom.map((t) => (
                <div key={t.start} className={'cl-tl-tick is-bottom' + (header.bottomUnit === 'day' && t.start === today ? ' is-today' : '')} style={tickStyle(t)}>
                  <span>{tickLabel(header.bottomUnit, t.start, false)}</span>
                </div>
              ))}
            </div>
          </div>
          <div ref={rowsRef} className="cl-tl-rows" style={{ height: Math.max(rows.length, 1) * ROW_H }}>
            <div className="cl-tl-grid" style={{ width: axisW }} aria-hidden="true">
              {header.bottom.map((t) => (
                <div key={t.start} className="cl-tl-line" style={{ transform: `translateX(${daysBetween(origin, t.start) * px}px)` }} />
              ))}
              {todayX >= 0 && todayX < axisW && <div className="cl-tl-today" style={{ transform: `translateX(${todayX + px / 2}px)` }} />}
            </div>
            {rows.slice(first, end).map((row, k) => (
              <div key={row.id} className="cl-tl-row" data-row-id={row.id} style={{ top: (first + k) * ROW_H }}>
                {renderName(row)}
                <div className="cl-tl-lane" style={{ width: axisW }}>
                  {renderBar(row)}
                </div>
              </div>
            ))}
            {rows.length === 0 && !data.loading && <div className="cl-tl-empty">{C.noRows}</div>}
          </div>
          {!readOnly && (
            <button type="button" className="cl-tl-new" onClick={create}>
              <Icon name="plus" size={14} />
              {C.newRow}
            </button>
          )}
        </div>
      </div>
      {prop.type === 'date' && (
        <div className="cl-tl-none">
          <button type="button" className="cl-tl-none-head" aria-expanded={noneOpen} onClick={() => setNoneOpen((v) => !v)}>
            <Icon name="chevron" size={12} className={'chev' + (noneOpen ? ' open' : '')} />
            <span>{C.date.unscheduled}</span>
            <span className="cl-section-count">{none.window?.total ?? ''}</span>
          </button>
          {noneOpen && (
            <div className="cl-tl-none-list">
              {noneRows.map((row) => (
                <div key={row.id} className="cl-tl-none-row">
                  <button type="button" className="cl-tl-none-name" onClick={() => onOpenRow(row.id)}>
                    <PageIcon icon={row.icon} placeholder={row.has_body} />
                    <span className={'cl-tl-title' + (row.title ? '' : ' is-empty')}>{row.title || COPY.untitled}</span>
                  </button>
                  {canDrag && (
                    <button type="button" className="cl-bar-btn" onClick={() => void handle.setValues(row.id, { [prop.id]: today })}>
                      {C.date.schedule}
                    </button>
                  )}
                </div>
              ))}
              {none.window && none.window.total === 0 && <div className="cl-hint">{C.date.noUnscheduled}</div>}
              {none.window?.next && (
                <div ref={sentinel} className="cl-more">
                  <button type="button" className="cl-bar-btn" disabled={none.loadingMore} onClick={none.loadMore}>
                    {none.loadingMore ? C.loading : C.loadMore}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
