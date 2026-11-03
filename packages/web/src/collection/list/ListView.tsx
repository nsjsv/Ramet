// ---------- 列表视图 ----------
// 一行一条（ListRow）：图标 + 标题，视图里显示的属性紧凑排在右侧。行窗口同表格：一个不按组取的窗口（useRowsWindow），
// 分组时组序在前，按表格的 sectionsOf 分段，段可折叠（折叠状态本机记忆，与同一视图的表格共用一份）；滚到底续取，
// 整页集合后退回原位置按 data-row-id 锚定（registerMore，同表格）。
// · 点标题文字就地改名、点属性就地改值、点别处打开行页面；viewer 点哪都是打开，没有手柄、勾选框与新建
// · 行首手柄：点开行菜单（同表格，行已勾选时作用于全部勾选的行）；无排序时拖动排序，分组时只能同组内拖
// · 多选（collection/selection.ts）：勾选框 / ⌘ / Ctrl 点行切换，Shift 从锚点连选（只算看得见的行），行外的空白处拖动框选，
//   正文列外拖选经 bandSelect 转进来；选中后出批量操作栏（BulkBar）
// · 每段底部「新建」：分组时带上这一段的分组值；新行在已加载的窗口里就地输入标题，否则建成后打开它的页面
// 改变布局的动画（折叠段、拖行落下、删行）用 motion.ts 的 flip()，不做 width / height / margin 过渡。
import { useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { CollectionRow, CollectionSchema, CollectionView } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { createHandleMenu } from '../../handle-menu'
import { Icon } from '../../icons'
import { flip } from '../../motion'
import { usePersistentSet } from '../../tree-state'
import { cardProps } from '../board/board-model'
import BulkBar from '../BulkBar'
import { InBulkSlot } from '../bulk-slot'
import { OptionChip } from '../cells/CellView'
import { useCollectionPages, useRowsWindow, type CollectionHandle } from '../collection-store'
import { useLoadMore } from '../load-more'
import { useMarquee } from '../marquee'
import { openRowMenu } from '../row-menu'
import { useEscapeClear, usePruneToWindow, useRowPicking } from '../selection'
import { sectionsOf, type Section } from '../table/table-model'
import ListRow, { type RowDropHandlers } from './ListRow'
import { listDrop, newRowSet, visibleRows, type ListDrag } from './list-model'

const C = COPY.collection

type Props = {
  handle: CollectionHandle
  schema: CollectionSchema
  view: CollectionView
  readOnly: boolean
  spaceId: string | null
  onOpenRow: (rowId: string) => void
  /** 整页集合登记「多取一些」：后退恢复滚动位置时锚行还没加载就续取（collection/CollectionPage.tsx） */
  registerMore?: (more: (() => void) | null) => void
}

export default function ListView({ handle, schema, view, readOnly, spaceId, onOpenRow, registerMore }: Props) {
  const rows = useRowsWindow(handle, view.id)
  const win = rows.window
  const loadMore = rows.loadMore
  const props = useMemo(() => cardProps(schema, view), [schema, view])
  const sections = useMemo(() => (win ? sectionsOf(win, schema, view) : []), [win, schema, view])
  const [folded, toggleFold] = usePersistentSet(`ramet.collection.fold.${handle.id}.${view.id}`)
  const visible = useMemo(() => visibleRows(sections, folded), [sections, folded])
  const picking = useRowPicking()
  const { picked, prune, clear } = picking
  /** 行手柄菜单（一个列表一份弹层，卸载时关掉） */
  const [rowMenu] = useState(createHandleMenu)
  useEffect(() => () => rowMenu.destroy(), [rowMenu])
  const pages = useCollectionPages()
  const [naming, setNaming] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; below: boolean } | null>(null)
  const dragRow = useRef<ListDrag | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const canDrag = !readOnly && view.sorts.length === 0

  useEffect(() => {
    registerMore?.(loadMore)
    return () => registerMore?.(null)
  })

  useLoadMore(sentinel, win, loadMore)

  usePruneToWindow(win, prune)
  useEscapeClear(picked.size > 0, clear)

  const marquee = useMarquee({
    root: wrapRef,
    item: '.cl-list-row[data-row-id]',
    idOf: (el) => el.dataset.rowId,
    // 行的内容区点了是打开 / 改名改值，分组头、新建、续取各有各的点击；行首槽和行外的空白处才起框
    avoid: '.cl-list-main, .cl-handle, .cl-section-head, .cl-list-foot, .cl-more, .cl-cell-pop',
    disabled: readOnly,
    current: () => picking.picked,
    onBox: picking.setBox,
    onClick: clear,
  })

  if (!win) return <div className="collection-empty">{rows.error ? C.notFound : C.loading}</div>

  const rowEls = (): Element[] => [...(listRef.current?.querySelectorAll('.cl-list-row, .cl-section-head, .cl-list-foot') ?? [])]

  const newRow = (section: Section): void => {
    const set = newRowSet(view, section)
    // 乐观新建：行立即插进窗口，不等服务端（store 把确认前的改名排在确认之后发）
    const created = handle.createRow(set ? { set } : {}, { viewId: view.id })
    if (!created) return
    // 新行落在已加载的窗口里就就地输入标题；落在还没加载的那一段（排序决定的位置）就等建成后打开它的页面
    if (handle.windowState(view.id).window?.rows.some((r) => r.id === created.id)) setNaming(created.id)
    else void created.ready.then((row) => row && onOpenRow(row.id))
  }

  const fold = (key: string): void => flip(rowEls(), () => flushSync(() => toggleFold(key)))

  const endDrag = (): void => {
    dragRow.current = null
    setDropAt(null)
  }
  const belowOf = (e: React.DragEvent<HTMLElement>): boolean => {
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientY > r.top + r.height / 2
  }
  /** 整行接拖放：只接同一段里拖来的行；落下后什么都不用做（落回原处）就不画提示 */
  const dropTarget = (section: Section, row: CollectionRow): RowDropHandlers => ({
    onDragOver: (e) => {
      const from = dragRow.current
      if (!from || from.section !== section.key) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const below = belowOf(e)
      const moves = listDrop(from, section, row.id, below) !== null
      setDropAt((cur) => {
        if (!moves) return cur?.id === row.id ? null : cur
        return cur && cur.id === row.id && cur.below === below ? cur : { id: row.id, below }
      })
    },
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt((cur) => (cur?.id === row.id ? null : cur))
    },
    onDrop: (e) => {
      const from = dragRow.current
      if (!from) return
      e.preventDefault()
      const neighbors = listDrop(from, section, row.id, belowOf(e))
      endDrag()
      if (neighbors) flip(rowEls(), () => flushSync(() => void handle.moveRow(from.id, neighbors.after, neighbors.before)))
    },
  })

  const renderRow = (section: Section, row: CollectionRow) => (
    <ListRow
      key={row.id}
      row={row}
      props={props}
      doc={handle.doc}
      spaceId={spaceId}
      readOnly={readOnly}
      canDrag={canDrag}
      drop={dropAt?.id === row.id ? (dropAt.below ? 'after' : 'before') : null}
      dropTarget={dropTarget(section, row)}
      naming={naming === row.id}
      picked={picked.has(row.id)}
      onPick={(shift) => picking.pick(row.id, shift, visible.map((r) => r.id))}
      onOpen={() => onOpenRow(row.id)}
      onMenu={(anchor) =>
        openRowMenu(rowMenu, anchor, {
          handle,
          spaceId,
          pages,
          ids: picked.has(row.id) ? [...picked] : [row.id],
          onOpenRow,
          onDone: clear,
          animate: (run) => flip(rowEls(), () => flushSync(run)),
        })
      }
      onRename={(title) => {
        setNaming(null)
        // 只敲了空白 = 没起名：不发改名（改名会触发一次全站页面列表重拉）
        if (title.trim()) void handle.renameRow(row.id, title)
      }}
      onNameDone={() => setNaming(null)}
      onSet={(propId, value) => void handle.setValues(row.id, { [propId]: value })}
      onDragStart={() => {
        dragRow.current = { id: row.id, section: section.key }
      }}
      onDragEnd={endDrag}
    />
  )

  const groupProp = view.groupBy ? schema.props.find((p) => p.id === view.groupBy) : undefined
  return (
    <div ref={wrapRef} className="cl-list-wrap" onPointerDown={marquee.onPointerDown}>
      {marquee.layer}
      {picked.size > 0 && !readOnly && (
        <InBulkSlot>
          <BulkBar handle={handle} schema={schema} spaceId={spaceId} picked={picked} onClear={clear} animate={(run) => flip(rowEls(), () => flushSync(run))} />
        </InBulkSlot>
      )}
      <div ref={listRef} className="cl-list">
        {sections.map((section) => {
          const closed = section.key !== null && folded.has(section.key)
          return (
            <div key={section.key ?? '-'} className="cl-section">
              {section.key !== null && (
                <div className="cl-section-head">
                  <button type="button" className="icon-btn" title={C.fold} aria-expanded={!closed} onClick={() => fold(section.key!)}>
                    <Icon name="chevron" size={12} className={'chev' + (closed ? '' : ' open')} />
                  </button>
                  {section.option ? (
                    <OptionChip option={section.option} status={groupProp?.type === 'status'} />
                  ) : (
                    <span className="cl-section-none">{C.group.noValue}</span>
                  )}
                  <span className="cl-section-count">{section.count}</span>
                </div>
              )}
              {!closed && section.rows.map((row) => renderRow(section, row))}
              {!closed && !readOnly && (
                <button type="button" className="cl-list-foot" onClick={() => newRow(section)}>
                  <Icon name="plus" size={14} />
                  {C.newRow}
                </button>
              )}
            </div>
          )
        })}
        {win.rows.length === 0 && sections.length <= 1 && <div className="collection-empty">{C.noRows}</div>}
      </div>
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
