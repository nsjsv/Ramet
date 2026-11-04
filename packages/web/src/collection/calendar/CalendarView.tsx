// ---------- 日历视图（月视图，周一开头） ----------
// 按视图的日期属性（dateBy：日期 / 创建时间 / 编辑时间）把行排进 6 × 7 的月历格，排版全在 calendar-model（纯函数）。
// 取数：这一屏（第一格到最后一格）是一个按日期范围取的窗口（useRangeRows 取全），翻到别的月就是另一个窗口；
// 行改了日期由增量自动进 / 出。翻到哪个月是个人状态（本机记忆，personal.ts），不写集合文档。
// · 条目 = 图标 + 标题（不画别的属性），区间跨天画成横条、跨周断开续画；点开行页面
// · 一格放不下的收进「+N」，点开列出当天全部条目
// · 只有「日期」属性能改：拖条目到别的天 = 区间整体平移（单日只挪那一天），松手写一次；格子悬停出「＋」新建一行并带上这一天，
//   新行就地输入标题。按创建 / 编辑时间排、或 viewer 时不能拖、不能新建
// 改变布局的动画（拖动落下）用 motion.ts 的 flip()，不做 width / height / margin 过渡。
import { useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { dateSpan, daysBetween, joinDate, TITLE_PROP, weekdayOf, type CollectionSchema, type CollectionView, type DateSpan } from '@ramet/shared/collection-model'
import { dateByProp, rowSpan } from '@ramet/shared/collection-query'
import { COPY } from '../../copy'
import { Icon } from '../../icons'
import { flip } from '../../motion'
import { PageIcon } from '../../PageIcon'
import { CellEditor } from '../cells/CellEditor'
import type { CollectionHandle } from '../collection-store'
import { RANGE_ROWS_CAP } from '../collection-windows'
import { DateSetup } from '../date-setup'
import { readPersonal, writePersonal } from '../personal'
import { Popover } from '../../ui/popover'
import { useRangeRows } from '../range-rows'
import { localDay, monthOf, shiftMonth } from '../../ui/date-model'
import { calendarGrid, DAY_HEAD, fitLanes, fitWeek, isMonth, itemsOn, LANE_H, layoutWeeks, shiftSpan, type CalItem, type Placed } from './calendar-model'

const C = COPY.collection

/** 一周（一行格子）的高度：日期号一行 + 四条车道 */
const CELL_H = DAY_HEAD + LANE_H * 4 + 4

type Props = {
  handle: CollectionHandle
  schema: CollectionSchema
  view: CollectionView
  readOnly: boolean
  spaceId: string | null
  onOpenRow: (rowId: string) => void
}

const monthKey = (viewId: string): string => `ramet.collection.calendar.${viewId}`

function readMonth(viewId: string): string {
  const saved = readPersonal(monthKey(viewId))
  return isMonth(saved) ? saved : monthOf(localDay())
}

/** 拖动中的条目：按下时的值与指针所在的那天；moved = 已经拖出去了（松手不算点击） */
type Drag = { rowId: string; value: string; grab: string; x: number; y: number; moved: boolean; span: DateSpan | null }

const day1 = (day: string): number => Number(day.slice(8, 10))
const month1 = (day: string): number => Number(day.slice(5, 7))

export default function CalendarView({ handle, schema, view, readOnly, spaceId, onOpenRow }: Props) {
  const prop = dateByProp(view, schema)
  const [month, setMonthState] = useState(() => readMonth(view.id))
  const grid = useMemo(() => calendarGrid(month), [month])
  const data = useRangeRows(handle, prop ? view.id : null, grid.range)
  const ctx = useMemo(() => handle.queryCtx(), [handle])
  const items = useMemo<CalItem[]>(
    () =>
      prop
        ? data.rows.flatMap((row) => {
            const span = rowSpan(row, prop, ctx)
            return span ? [{ row, span }] : []
          })
        : [],
    [data.rows, prop, ctx],
  )
  const weeks = useMemo(() => layoutWeeks(items, grid), [items, grid])
  const capacity = fitLanes(CELL_H)
  const canWrite = !readOnly && prop?.type === 'date'
  /** 刚新建、正在输入标题的行与它那一天 */
  const [naming, setNaming] = useState<{ id: string; day: string } | null>(null)
  const [moreAt, setMoreAt] = useState<{ day: string; el: HTMLElement } | null>(null)
  const [preview, setPreview] = useState<{ rowId: string; span: DateSpan } | null>(null)
  const drag = useRef<Drag | null>(null)
  /** 刚拖完：随后那次 click 不当成打开 */
  const dragged = useRef(false)
  const gridRef = useRef<HTMLDivElement>(null)

  if (!prop) return <DateSetup doc={handle.doc} schema={schema} view={view} readOnly={readOnly} />

  const setMonth = (next: string): void => {
    setMonthState(next)
    writePersonal(monthKey(view.id), next)
  }
  const today = localDay()

  /** 指针下面是哪一天（条目盖在格子上：从命中链里找格子） */
  const dayAt = (x: number, y: number): string | null => {
    for (const el of document.elementsFromPoint(x, y)) {
      const cell = el.closest<HTMLElement>('[data-day]')
      if (cell && gridRef.current?.contains(cell)) return cell.dataset.day ?? null
    }
    return null
  }

  const itemEls = (): Element[] => [...(gridRef.current?.querySelectorAll('.cl-cal-item') ?? [])]

  const create = (day: string): void => {
    // 乐观新建：条目立即出现，就地输入标题；落在窗口没取到的那一段（这一屏行太多）就等建成后打开它的页面
    const created = handle.createRow({ set: { [prop.id]: day } }, { viewId: view.id, range: grid.range })
    if (!created) return
    if (handle.windowState(view.id, { range: grid.range }).window?.rows.some((r) => r.id === created.id)) setNaming({ id: created.id, day })
    else void created.ready.then((row) => row && onOpenRow(row.id))
  }

  const endDrag = (): void => {
    drag.current = null
    setPreview(null)
  }

  const itemEvents = (p: Placed) =>
    canWrite
      ? {
          onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
            if (e.button !== 0) return
            const grab = dayAt(e.clientX, e.clientY)
            if (!grab) return
            drag.current = { rowId: p.row.id, value: joinDate(p.span.start, p.span.end), grab, x: e.clientX, y: e.clientY, moved: false, span: null }
            e.currentTarget.setPointerCapture(e.pointerId)
          },
          onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
            const d = drag.current
            if (!d || (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4)) return
            d.moved = true
            const day = dayAt(e.clientX, e.clientY)
            const span = day ? dateSpan(shiftSpan(d.value, daysBetween(d.grab, day))) : undefined
            if (!span) return
            d.span = span
            setPreview((cur) => (cur?.span.start === span.start && cur.span.end === span.end ? cur : { rowId: d.rowId, span }))
          },
          onPointerUp: () => {
            const d = drag.current
            endDrag()
            if (!d?.moved) return
            dragged.current = true
            const next = d.span ? joinDate(d.span.start, d.span.end) : d.value
            if (next !== d.value) flip(itemEls(), () => flushSync(() => void handle.setValues(d.rowId, { [prop.id]: next })))
          },
          onPointerCancel: endDrag,
        }
      : {}

  const renderItem = (p: Placed) => {
    if (naming?.id === p.row.id) return null
    // 两头各缩进 3px 与格子边留缝；断口那头贴着格子边，看得出是接着上一周 / 下一周的
    const inL = p.clippedLeft ? 0 : 3
    const inR = p.clippedRight ? 0 : 3
    const style = {
      left: `calc(${(p.colStart / 7) * 100}% + ${inL}px)`,
      width: `calc(${((p.colEnd - p.colStart + 1) / 7) * 100}% - ${inL + inR}px)`,
      top: DAY_HEAD + p.lane * LANE_H,
    }
    return (
      <button
        key={p.row.id}
        type="button"
        className={
          'cl-cal-item' +
          (p.clippedLeft ? ' is-cut-left' : '') +
          (p.clippedRight ? ' is-cut-right' : '') +
          (preview?.rowId === p.row.id ? ' is-dragging' : '') +
          (canWrite ? ' is-draggable' : '')
        }
        style={style}
        data-tip={!readOnly && !canWrite ? C.date.locked : undefined}
        onClick={() => {
          if (dragged.current) {
            dragged.current = false
            return
          }
          onOpenRow(p.row.id)
        }}
        {...itemEvents(p)}
      >
        <PageIcon icon={p.row.icon} placeholder={p.row.has_body} />
        <span className={'cl-cal-name' + (p.row.title ? '' : ' is-empty')}>{p.row.title || COPY.untitled}</span>
      </button>
    )
  }

  const inPreview = (day: string): boolean => preview !== null && preview.span.start <= day && day <= preview.span.end
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  const moreItems = moreAt ? itemsOn(items, moreAt.day) : []

  return (
    <div
      className="cl-cal"
      style={{ '--cal-cell': `${CELL_H}px`, '--cal-head': `${DAY_HEAD}px`, '--cal-lane': `${LANE_H}px`, '--cal-more': `${DAY_HEAD + (capacity - 1) * LANE_H}px` } as React.CSSProperties}
    >
      <div className="cl-cal-head">
        <span className="cl-cal-title">{C.date.monthTitle(y, m)}</span>
        {data.capped && <span className="cl-hint">{C.date.capped(RANGE_ROWS_CAP)}</span>}
        {data.error && <span className="cl-hint">{C.notFound}</span>}
        <div className="cl-cal-nav">
          <button type="button" className="icon-btn" data-tip={C.date.prevMonth} aria-label={C.date.prevMonth} onClick={() => setMonth(shiftMonth(month, -1))}>
            <Icon name="chevron" size={14} className="cl-flip-x" />
          </button>
          <button type="button" className="cl-bar-btn" onClick={() => setMonth(monthOf(today))}>
            {C.date.today}
          </button>
          <button type="button" className="icon-btn" data-tip={C.date.nextMonth} aria-label={C.date.nextMonth} onClick={() => setMonth(shiftMonth(month, 1))}>
            <Icon name="chevron" size={14} />
          </button>
        </div>
      </div>
      <div className="cl-cal-weekdays" aria-hidden="true">
        {C.date.weekdays.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div ref={gridRef} className={'cl-cal-grid' + (data.loading ? ' is-loading' : '')}>
        {weeks.map((placed, w) => {
          const fit = fitWeek(placed, capacity)
          return (
            <div key={grid.days[w * 7]} className="cl-cal-week">
              {grid.days.slice(w * 7, w * 7 + 7).map((day, col) => {
                const more = fit.more[col] ?? 0
                return (
                  <div
                    key={day}
                    data-day={day}
                    className={'cl-cal-day' + (monthOf(day) !== month ? ' is-outside' : '') + (day === today ? ' is-today' : '') + (inPreview(day) ? ' is-drop' : '')}
                  >
                    <span className="cl-cal-num">{day1(day) === 1 ? C.date.firstDay(month1(day), 1) : day1(day)}</span>
                    {canWrite && (
                      <button type="button" className="icon-btn cl-cal-add" data-tip={C.date.add} aria-label={C.date.add} onClick={() => create(day)}>
                        <Icon name="plus" size={12} />
                      </button>
                    )}
                    {more > 0 && (
                      <button type="button" className="cl-cal-more" data-tip={C.date.moreTip(more)} onClick={(e) => setMoreAt({ day, el: e.currentTarget })}>
                        {C.date.more(more)}
                      </button>
                    )}
                    {naming?.day === day && (
                      <div className="cl-cal-naming">
                        <CellEditor
                          prop={TITLE_PROP}
                          value={undefined}
                          doc={handle.doc}
                          spaceId={spaceId}
                          onCommit={(value) => {
                            const id = naming.id
                            setNaming(null)
                            // 只敲了空白 = 没起名：不发改名（改名会触发一次全站页面列表重拉）
                            if (typeof value === 'string' && value.trim()) void handle.renameRow(id, value)
                          }}
                          onDone={() => setNaming(null)}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
              {fit.shown.map(renderItem)}
            </div>
          )
        })}
      </div>
      {moreAt && (
        <Popover anchor={moreAt.el} onClose={() => setMoreAt(null)}>
          <div className="cl-menu cl-cal-list">
            <div className="pop-section">{C.date.dayTitle(month1(moreAt.day), day1(moreAt.day), C.date.weekdays[weekdayOf(moreAt.day)] ?? '')}</div>
            {moreItems.map((item) => (
              <button
                key={item.row.id}
                type="button"
                className="pop-row"
                onClick={() => {
                  setMoreAt(null)
                  onOpenRow(item.row.id)
                }}
              >
                <PageIcon icon={item.row.icon} placeholder={item.row.has_body} />
                <span className="cl-cal-name">{item.row.title || COPY.untitled}</span>
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  )
}
