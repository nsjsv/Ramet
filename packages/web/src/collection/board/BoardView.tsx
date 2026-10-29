// ---------- 看板视图 ----------
// 按视图的 groupBy（状态 / 单选）分列，「无值」列在最前；每列各自取窗口（BoardColumn）。
// - 拖卡片：跨列改分组属性的值；无排序时同时落在指针处（一次 PATCH set + after / before）；有排序时列内不能拖、跨列只改值；
//   落回原处什么都不发（board-model 的 dropPlan）。拖放数据只在组件的 ref 里（同表格拖行），不进 dataTransfer 的自定义类型。
// - 列内「＋」：新行带上这一列的值（无值列不带）；新行在这一列已加载的窗口里就地输入标题，否则打开行页面。
// - 卡片上直接改标题和属性（BoardCard），打开行页面走卡片的「打开」按钮；viewer 点卡片就是打开。
// - 没分组（或分组属性已不能分列）：空状态，可点选分组属性；viewer 只看提示。
// - 多选（collection/selection.ts）：⌘ / Ctrl 点卡片切换（卡片上不放勾选框），Shift 点从锚点连选（列从左到右、列内从上到下的已加载卡片），
//   列的空白处拖动框选；选中后上方出批量操作栏（BulkBar）。拖动仍只挪一张。
// 改变布局的动画（拖动落下）用 motion.ts 的 flip()，不做 width / height / margin 过渡。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type * as Y from 'yjs'
import type { CollectionRow, CollectionSchema, CollectionView } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { Icon } from '../../icons'
import { flip } from '../../motion'
import BulkBar from '../BulkBar'
import type { CollectionHandle } from '../collection-store'
import { useMarquee } from '../marquee'
import { InBulkSlot } from '../bulk-slot'
import { useRowPicking } from '../selection'
import { TYPE_ICON } from '../prop-meta'
import { groupChoices, setGroupBy } from '../schema-ops'
import BoardColumn from './BoardColumn'
import { boardColumns, cardProps, dropPlan, type BoardDrag, type BoardDropAt } from './board-model'

const C = COPY.collection

type Props = {
  handle: CollectionHandle
  schema: CollectionSchema
  view: CollectionView
  readOnly: boolean
  spaceId: string | null
  onOpenRow: (rowId: string) => void
}

/** 看板还不能分列：说明 + 可选的分组属性（viewer 只看说明） */
function BoardSetup({ doc, schema, view, readOnly }: { doc: Y.Doc; schema: CollectionSchema; view: CollectionView; readOnly: boolean }) {
  const choices = groupChoices(schema)
  return (
    <div className="cl-board-setup">
      <div className="cl-board-setup-head">
        <Icon name="columns" size={16} />
        <span>{C.board.needGroup}</span>
      </div>
      {!readOnly && choices.length > 0 && (
        <div className="cl-board-choices">
          <span>{C.board.pickGroup}</span>
          {choices.map((prop) => (
            <button key={prop.id} type="button" className="cl-bar-btn" onClick={() => setGroupBy(doc, view.id, prop.id)}>
              <Icon name={TYPE_ICON[prop.type]} size={14} />
              {prop.name || C.types[prop.type]}
            </button>
          ))}
        </div>
      )}
      {!readOnly && choices.length === 0 && <div className="cl-hint">{C.group.empty}</div>}
    </div>
  )
}

const sameAt = (a: BoardDropAt | null, b: BoardDropAt | null): boolean =>
  a === b || (a !== null && b !== null && a.key === b.key && a.targetId === b.targetId && a.below === b.below)

export default function BoardView({ handle, schema, view, readOnly, spaceId, onOpenRow }: Props) {
  const board = useMemo(() => boardColumns(schema, view), [schema, view])
  const props = useMemo(() => cardProps(schema, view), [schema, view])
  const dragRef = useRef<BoardDrag | null>(null)
  const [dragging, setDragging] = useState<BoardDrag | null>(null)
  const [dropAt, setDropAt] = useState<BoardDropAt | null>(null)
  const [naming, setNaming] = useState<string | null>(null)
  const boardRef = useRef<HTMLDivElement>(null)
  const picking = useRowPicking()
  const { picked, prune, clear } = picking

  // 选中的卡片被删 / 挪走 / 不在任何已加载的窗口里了：摘掉（窗口由各列 watch，这里只听变化）
  useEffect(() => handle.subscribe(() => prune((id) => handle.findRow(id) !== undefined)), [handle, prune])
  useEffect(() => {
    if (picked.size === 0) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || (e.target as Element | null)?.closest?.('input, textarea, [contenteditable]')) return
      clear()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picked.size, clear])

  /** 连选的顺序：各列已加载的卡片，列从左到右、列内从上到下 */
  const order = useCallback(
    (): string[] => (board?.columns ?? []).flatMap((col) => handle.windowState(view.id, col.key).window?.rows.map((r) => r.id) ?? []),
    [board, handle, view.id],
  )
  const marquee = useMarquee({
    root: boardRef,
    item: '[data-card]',
    idOf: (el) => el.dataset.card,
    avoid: '.cl-card, .cl-cell-pop, .cl-col-head, .cl-col-foot, .cl-more',
    disabled: readOnly || !board,
    current: () => picking.picked,
    onBox: picking.setBox,
    onClick: clear,
  })

  if (!board) return <BoardSetup doc={handle.doc} schema={schema} view={view} readOnly={readOnly} />

  const endDrag = (): void => {
    dragRef.current = null
    setDragging(null)
    setDropAt(null)
  }

  /** 两列里的卡片（及列底按钮）：落下时它们的位置会变，交给 flip 补位 */
  const cardEls = (keys: string[]): Element[] =>
    keys.flatMap((key) => [...(boardRef.current?.querySelectorAll(`.cl-col[data-col="${CSS.escape(key)}"] :is(.cl-card, .cl-col-foot, .cl-more)`) ?? [])])

  const drop = (at: BoardDropAt, rows: readonly CollectionRow[]): void => {
    const drag = dragRef.current
    endDrag()
    if (!drag) return
    const plan = dropPlan(view, drag, at, rows)
    if (!plan) return
    flip(cardEls([drag.from, at.key]), () =>
      flushSync(() => {
        if (plan.neighbors) void handle.moveRow(drag.rowId, plan.neighbors.after, plan.neighbors.before, plan.set ?? undefined)
        else if (plan.set) void handle.setValues(drag.rowId, plan.set)
      }),
    )
  }

  const create = (key: string): void => {
    const set = key && view.groupBy ? { [view.groupBy]: key } : undefined
    // 乐观新建：卡片立即出现，不等服务端（store 把确认前的改名排在确认之后发）
    const created = handle.createRow(set ? { set } : {}, { viewId: view.id, group: key })
    if (!created) return
    // 新卡片在这一列已加载的窗口里就地输入标题；落在还没加载的那一段（排序决定的位置）就等建成后打开它的页面
    if (handle.windowState(view.id, key).window?.rows.some((r) => r.id === created.id)) setNaming(created.id)
    else void created.ready.then((row) => row && onOpenRow(row.id))
  }

  return (
    <>
      {picked.size > 0 && !readOnly && (
        <InBulkSlot>
          <BulkBar
            handle={handle}
            schema={schema}
            spaceId={spaceId}
            picked={picked}
            onClear={clear}
            animate={(run) => flip(cardEls(board.columns.map((c) => c.key)), () => flushSync(run))}
          />
        </InBulkSlot>
      )}
      {marquee.layer}
      <div ref={boardRef} className="cl-board" onPointerDown={marquee.onPointerDown}>
        {board.columns.map((col) => (
          <BoardColumn
            key={col.key}
            handle={handle}
            view={view}
            col={col}
            status={board.prop.type === 'status'}
            cardProps={props}
            spaceId={spaceId}
            readOnly={readOnly}
            dragging={dragging}
            dragNow={() => dragRef.current}
            dropAt={dropAt}
            naming={naming}
            picked={picked}
            onPick={(rowId, shift) => picking.pick(rowId, shift, order())}
            onOpenRow={onOpenRow}
            onCreate={create}
            onRename={(rowId, title) => {
              setNaming(null)
              // 只敲了空白 = 没起名：不发改名（改名会触发一次全站页面列表重拉）
              if (title.trim()) void handle.renameRow(rowId, title)
            }}
            onNameDone={() => setNaming(null)}
            onDragStart={(drag) => {
              dragRef.current = drag
              // 推迟一帧再变淡：dragstart 里同步改样式，浏览器截的拖动影像也会是淡的
              requestAnimationFrame(() => {
                if (dragRef.current === drag) setDragging(drag)
              })
            }}
            onDragEnd={endDrag}
            onHover={(key, at) =>
              setDropAt((cur) => {
                if (at === null) return cur?.key === key ? null : cur
                return sameAt(cur, at) ? cur : at
              })
            }
            onDrop={drop}
          />
        ))}
      </div>
    </>
  )
}
