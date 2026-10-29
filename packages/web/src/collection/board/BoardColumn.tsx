// ---------- 看板的一列：列头（选项 / 「无值」+ 计数 + ＋）、卡片、滚到底续取、列底「新建」 ----------
// 每列一个按组取的窗口（useRowsWindow，store 按 (视图, 组) 引用计数）；计数 = 窗口的 total（这一组命中筛选的全部行，含没加载的），窗口没到时不显示。
// 拖放：整列接 dragover / drop，指针下的卡片（data-card）按上半 / 下半定前后，空白处接在已加载的末尾；落点什么都不用做（落回原处）就不画提示。
// 列内滚动，续取的哨兵以这一列的滚动容器为 root。
import { useEffect, useRef } from 'react'
import type { CollectionProp, CollectionRow, CollectionView } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { Icon } from '../../icons'
import { OptionChip } from '../cells/CellView'
import { useRowsWindow, type CollectionHandle } from '../collection-store'
import BoardCard from './BoardCard'
import { canDrop, dropPlan, type BoardColumnDef, type BoardDrag, type BoardDropAt } from './board-model'

const C = COPY.collection

type Props = {
  handle: CollectionHandle
  view: CollectionView
  col: BoardColumnDef
  /** 分组属性是状态（列头的选项 chip 带圆点） */
  status: boolean
  cardProps: readonly CollectionProp[]
  spaceId: string | null
  readOnly: boolean
  /** 正在拖的卡片（渲染用）；dragNow 是事件里读的同一份（ref，不等重渲） */
  dragging: BoardDrag | null
  dragNow: () => BoardDrag | null
  dropAt: BoardDropAt | null
  naming: string | null
  picked: ReadonlySet<string>
  /** 勾选 / ⌘ 点 = 切换；shift = 连选 */
  onPick: (rowId: string, shift: boolean) => void
  onOpenRow: (rowId: string) => void
  onCreate: (key: string) => void
  onRename: (rowId: string, title: string) => void
  onNameDone: () => void
  onDragStart: (drag: BoardDrag) => void
  onDragEnd: () => void
  /** 指针在这一列上的落点（null = 离开这一列，或落下什么都不用做） */
  onHover: (key: string, at: BoardDropAt | null) => void
  onDrop: (at: BoardDropAt, rows: readonly CollectionRow[]) => void
}

export default function BoardColumn(p: Props) {
  const { handle, view, col } = p
  const rows = useRowsWindow(handle, view.id, col.key)
  const win = rows.window
  const loadMore = rows.loadMore
  const bodyRef = useRef<HTMLDivElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const manual = view.sorts.length === 0
  const cards = win?.rows ?? []

  // 滚到底续取：列不单独滚动，哨兵进视口（提前 200px；root 缺省 = 视口，外层滚动容器的裁剪也算进去）就取下一页
  useEffect(() => {
    const el = sentinel.current
    if (!el || !win?.next) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore()
    }, { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [win, loadMore])

  /** 指针所在的落点：卡片上按上半 / 下半定前后，别处 = 列的末尾 */
  const pointAt = (e: React.DragEvent): BoardDropAt => {
    // 拖放事件的 target 可能是文字节点（Firefox）：从它的父元素找
    const node = e.target as Node
    const el = node instanceof Element ? node : node.parentElement
    const card = el?.closest<HTMLElement>('[data-card]')
    if (card && bodyRef.current?.contains(card)) {
      const r = card.getBoundingClientRect()
      return { key: col.key, targetId: card.dataset.card ?? null, below: e.clientY > r.top + r.height / 2 }
    }
    return { key: col.key, targetId: null, below: true }
  }
  const accepts = (): BoardDrag | null => {
    const drag = p.dragNow()
    return drag && win && canDrop(view, drag, col.key) ? drag : null
  }

  const target = p.dropAt?.key === col.key ? p.dropAt : null
  // 横线画在哪张卡片的前 / 后：落在列尾 = 末张之后；有排序时落点没有位置含义，只高亮整列
  const lineId = manual && target ? (target.targetId ?? cards.at(-1)?.id ?? null) : null
  const lineBelow = target?.targetId === null || target?.below === true
  return (
    <div
      className={'cl-col' + (target ? ' is-drop-target' : '')}
      data-col={col.key}
      data-color={col.option?.color}
      onDragOver={(e) => {
        const drag = accepts()
        if (!drag) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const at = pointAt(e)
        p.onHover(col.key, dropPlan(view, drag, at, cards) ? at : null)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) p.onHover(col.key, null)
      }}
      onDrop={(e) => {
        if (!accepts()) return
        e.preventDefault()
        p.onDrop(pointAt(e), cards)
      }}
    >
      <div className="cl-col-head">
        {col.option ? <OptionChip option={col.option} status={p.status} /> : <span className="cl-section-none">{C.group.noValue}</span>}
        {win && <span className="cl-section-count">{win.total}</span>}
        {!p.readOnly && (
          <button type="button" className="icon-btn cl-col-add" title={C.board.add} aria-label={C.board.add} onClick={() => p.onCreate(col.key)}>
            <Icon name="plus" size={14} />
          </button>
        )}
      </div>
      <div ref={bodyRef} className="cl-col-body">
        {!win && <div className="collection-empty">{rows.error ? C.notFound : C.loading}</div>}
        {cards.map((row) => (
          <BoardCard
            key={row.id}
            row={row}
            props={p.cardProps}
            doc={handle.doc}
            spaceId={p.spaceId}
            readOnly={p.readOnly}
            canDrag={!p.readOnly}
            dragging={p.dragging?.rowId === row.id}
            drop={lineId === row.id ? (lineBelow ? 'after' : 'before') : null}
            naming={p.naming === row.id}
            picked={p.picked.has(row.id)}
            pickable={!p.readOnly}
            onPick={(shift) => p.onPick(row.id, shift)}
            onOpen={() => p.onOpenRow(row.id)}
            onRename={(title) => p.onRename(row.id, title)}
            onNameDone={p.onNameDone}
            onSet={(propId, value) => void handle.setValues(row.id, { [propId]: value })}
            onDragStart={() => p.onDragStart({ rowId: row.id, from: col.key })}
            onDragEnd={p.onDragEnd}
          />
        ))}
        {win?.next && (
          <div ref={sentinel} className="cl-more">
            <button type="button" className="cl-bar-btn" disabled={rows.loadingMore} onClick={loadMore}>
              {rows.loadingMore ? C.loading : C.loadMore}
            </button>
          </div>
        )}
        {win && !p.readOnly && (
          <button type="button" className="cl-col-foot" onClick={() => p.onCreate(col.key)}>
            <Icon name="plus" size={14} />
            {C.newRow}
          </button>
        )}
      </div>
    </div>
  )
}
