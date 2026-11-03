// ---------- 画廊视图 ----------
// 卡片网格（GalleryCard = 预览 + 看板卡片）：CSS grid auto-fill，最小卡片宽按视图的卡片大小（gallery-model 的 CARD_WIDTH），
// 剩余宽度均分给每一列；正文里的集合块同样按正文列宽排，不伸出正文列。画廊不分组（parseView 对画廊读成 groupBy: null）。
// 行窗口一个（useRowsWindow），滚到底续取；预览取页面封面时读页面列表（改封面后列表重拉，卡片跟着变）。
// · 卡片交互同看板：点标题改名、点属性改值、点空白打开，右上「打开」；viewer 点卡片就是打开，没有新建
// · 拖动排序（无排序时）：落在卡片左半 / 右半 = 插在它前 / 后（gallery-model 的 galleryDrop），落点提示是卡片之间的竖线；
//   落回原处什么都不发。拖放数据只在 ref 里（同表格拖行），dataTransfer 只带 ROW_DRAG_TYPE
// · 多选：⌘ / Ctrl 点卡片切换、Shift 连选（卡片上不放勾选框），卡片外的空白处拖动框选，正文列外拖选经 bandSelect 转进来；
//   选中后出批量操作栏（BulkBar）
// · 网格末尾「新建」卡片：新行在已加载的窗口里就地输入标题，否则建成后打开它的页面
// 改变布局的动画（拖动落下、删卡片）用 motion.ts 的 flip()，不做 width / height / margin 过渡。
import { useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { CollectionSchema, CollectionView } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { Icon } from '../../icons'
import { flip } from '../../motion'
import { cardProps } from '../board/board-model'
import BulkBar from '../BulkBar'
import { InBulkSlot } from '../bulk-slot'
import { useCollectionPages, useRowsWindow, type CollectionHandle } from '../collection-store'
import { useLoadMore } from '../load-more'
import { useMarquee } from '../marquee'
import { useEscapeClear, usePruneToWindow, useRowPicking } from '../selection'
import GalleryCard from './GalleryCard'
import { CARD_WIDTH, coversOf, galleryDrop, previewOf, type CardRect, type GalleryDropAt } from './gallery-model'

const C = COPY.collection

type Props = {
  handle: CollectionHandle
  schema: CollectionSchema
  view: CollectionView
  readOnly: boolean
  spaceId: string | null
  onOpenRow: (rowId: string) => void
}

const sameAt = (a: GalleryDropAt | null, b: GalleryDropAt | null): boolean =>
  a === b || (a !== null && b !== null && a.targetId === b.targetId && a.below === b.below)

export default function GalleryView({ handle, schema, view, readOnly, spaceId, onOpenRow }: Props) {
  const rows = useRowsWindow(handle, view.id)
  const win = rows.window
  const loadMore = rows.loadMore
  const props = useMemo(() => cardProps(schema, view), [schema, view])
  const pages = useCollectionPages()
  const covers = useMemo(() => coversOf(pages), [pages])
  const picking = useRowPicking()
  const { picked, prune, clear } = picking
  const [naming, setNaming] = useState<string | null>(null)
  const dragRef = useRef<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<GalleryDropAt | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const canDrag = !readOnly && view.sorts.length === 0

  useLoadMore(sentinel, win, loadMore)

  usePruneToWindow(win, prune)
  useEscapeClear(picked.size > 0, clear)

  const marquee = useMarquee({
    root: wrapRef,
    item: '[data-card]',
    idOf: (el) => el.dataset.card,
    avoid: '.cl-card, .cl-cell-pop, .cl-gallery-add, .cl-more',
    disabled: readOnly,
    current: () => picking.picked,
    onBox: picking.setBox,
    onClick: clear,
  })

  if (!win) return <div className="collection-empty">{rows.error ? C.notFound : C.loading}</div>
  const cards = win.rows

  /** 网格里的卡片与「新建」卡片：落下 / 删除后它们的位置会变，交给 flip 补位 */
  const cardEls = (): Element[] => [...(gridRef.current?.querySelectorAll('.cl-card, .cl-gallery-add') ?? [])]
  const cardRects = (): CardRect[] =>
    [...(gridRef.current?.querySelectorAll<HTMLElement>('[data-card]') ?? [])].map((el) => {
      const r = el.getBoundingClientRect()
      return { id: el.dataset.card ?? '', left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    })

  const endDrag = (): void => {
    dragRef.current = null
    setDragging(null)
    setDropAt(null)
  }

  const create = (): void => {
    // 乐观新建：卡片立即出现，不等服务端（store 把确认前的改名排在确认之后发）
    const created = handle.createRow({}, { viewId: view.id })
    if (!created) return
    if (handle.windowState(view.id).window?.rows.some((r) => r.id === created.id)) setNaming(created.id)
    else void created.ready.then((row) => row && onOpenRow(row.id))
  }

  return (
    <div ref={wrapRef} className="cl-gallery-wrap" onPointerDown={marquee.onPointerDown}>
      {marquee.layer}
      {picked.size > 0 && !readOnly && (
        <InBulkSlot>
          <BulkBar handle={handle} schema={schema} spaceId={spaceId} picked={picked} onClear={clear} animate={(run) => flip(cardEls(), () => flushSync(run))} />
        </InBulkSlot>
      )}
      <div
        ref={gridRef}
        className="cl-gallery"
        style={{ '--card-w': `${CARD_WIDTH[view.cardSize]}px` } as React.CSSProperties}
        onDragOver={(e) => {
          const id = dragRef.current
          if (!id) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const at = galleryDrop(cards, id, e.clientX, e.clientY, cardRects())?.at ?? null
          setDropAt((cur) => (sameAt(cur, at) ? cur : at))
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null)
        }}
        onDrop={(e) => {
          const id = dragRef.current
          if (!id) return
          e.preventDefault()
          const plan = galleryDrop(cards, id, e.clientX, e.clientY, cardRects())
          endDrag()
          if (plan) flip(cardEls(), () => flushSync(() => void handle.moveRow(id, plan.neighbors.after, plan.neighbors.before)))
        }}
      >
        {cards.map((row) => (
          <GalleryCard
            key={row.id}
            row={row}
            props={props}
            preview={previewOf(row, schema, view, covers)}
            doc={handle.doc}
            spaceId={spaceId}
            readOnly={readOnly}
            canDrag={canDrag}
            dragging={dragging === row.id}
            drop={dropAt?.targetId === row.id ? (dropAt.below ? 'after' : 'before') : null}
            naming={naming === row.id}
            picked={picked.has(row.id)}
            pickable={!readOnly}
            onPick={(shift) => picking.pick(row.id, shift, cards.map((r) => r.id))}
            onOpen={() => onOpenRow(row.id)}
            onRename={(title) => {
              setNaming(null)
              // 只敲了空白 = 没起名：不发改名（改名会触发一次全站页面列表重拉）
              if (title.trim()) void handle.renameRow(row.id, title)
            }}
            onNameDone={() => setNaming(null)}
            onSet={(propId, value) => void handle.setValues(row.id, { [propId]: value })}
            onDragStart={() => {
              dragRef.current = row.id
              // 推迟一帧再变淡：dragstart 里同步改样式，浏览器截的拖动影像也会是淡的
              requestAnimationFrame(() => {
                if (dragRef.current === row.id) setDragging(row.id)
              })
            }}
            onDragEnd={endDrag}
          />
        ))}
        {!readOnly && (
          <button type="button" className="cl-gallery-add" onClick={create}>
            <Icon name="plus" size={14} />
            {C.newRow}
          </button>
        )}
      </div>
      {cards.length === 0 && readOnly && <div className="collection-empty">{C.noRows}</div>}
      {win.next && (
        <div ref={sentinel} className="cl-more">
          <button type="button" className="cl-bar-btn" disabled={rows.loadingMore} onClick={loadMore}>
            {rows.loadingMore ? C.loading : C.loadMore}
          </button>
        </div>
      )}
    </div>
  )
}
