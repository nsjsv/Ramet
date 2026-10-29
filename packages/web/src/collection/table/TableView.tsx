/* ---------- 表格视图 ----------
 * 行窗口来自集合 store（useRowsWindow：首屏 + 滚到底续取 + 增量）；写全走 store（乐观 + REST）。
 * · 单元格（同 Notion）：单击 / Enter / F2 编辑，Esc 退回选中态；选中后直接打字 = 用打的字替换原内容（选择器格作筛选词），
 *   空格切换复选框；Enter / 失焦提交。选择器弹着、筛选框空着时 ⌘V 直接粘进格子（认不出才进筛选框）。方向键 / Tab 在格子间移动，⌘ / Ctrl+方向键到边，Home / End 到行首行尾
 * · 格子选区（table/cell-range.ts）：拖过格子 / Shift+点 / Shift+方向键选出矩形，⌘A 全选；退格清空选区，⌘C 复制成 TSV，
 *   ⌘X 剪切，⌘V 粘贴（一格内容填满选区；多行内容超出末行就续建新行，分组视图 / 没加载完的窗口不续）；
 *   选区里编辑一格 = 同列选区里的每一行都写这个值（名称列只改这一行）
 * · ⌘Z / ⌘⇧Z / ⌘Y：撤销 / 重做格子改动（table/undo.ts；行的增删挪不进栈）
 * · 填充柄（table/fill.ts、fill-drag.ts）：选区右下角的小方块，往下 / 往上拖把选区内容按列填进拖过的行（等差的数字 / 日期续成序列）
 * · 行首手柄：点开行菜单（row-menu.ts，外壳与编辑器块手柄菜单同一份 handle-menu.ts；行已勾选时作用于全部勾选的行）；
 *   无排序时还能拖动排序（手动顺序只在没有排序时生效）；分组时同组内拖动
 * · 分组按组分段，段可折叠（折叠状态本机记忆）
 * · 多选（collection/selection.ts）：勾选框悬停才出现（已勾的常显），Shift 点勾选框从锚点连选（只算看得见的行），行首槽 / 空白处拖动框选；
 *   选中后上方出批量操作栏（BulkBar：编辑属性 / 复制 / 移到… / 删除）
 * 改变布局的动画（折叠段、拖行落下、删行）一律 motion.ts 的 flip()，不做 width / height / margin 过渡。 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { rowValue, TITLE_PROP_ID, type CollectionProp, type CollectionRow, type CollectionSchema, type CollectionView, type PropValue } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { Icon } from '../../icons'
import { flip } from '../../motion'
import { usePersistentSet } from '../../tree-state'
import { OptionChip } from '../cells/CellView'
import BulkBar from '../BulkBar'
import { useCollectionPages, useRowsWindow, type CollectionHandle } from '../collection-store'
import { createHandleMenu } from '../../handle-menu'
import { openRowMenu } from '../row-menu'
import { useMarquee } from '../marquee'
import { InBulkSlot } from '../bulk-slot'
import { useRowPicking } from '../selection'
import { setWidth } from '../schema-ops'
import { isComputed } from '../prop-meta'
import TableCell from './TableCell'
import TableHeader from './TableHeader'
import { boxOf, boxSize, type CellBox } from './cell-range'
import { applyChanges, changesBox, clearBox, copyBox, fillBox, pasteBox, setCells, type CellChange } from './range-ops'
import { createUndoStack } from './undo'
import { useFillDrag } from './fill-drag'
import { columnsOf, dropNeighbors, ROW_DRAG_TYPE, gridTemplate, moveCursor, sectionsOf, type Section } from './table-model'

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

type Cursor = { rowId: string; propId: string }

const PICKER_TYPES = new Set(['select', 'multi_select', 'status', 'person'])

export default function TableView({ handle, schema, view, readOnly, spaceId, onOpenRow, registerMore }: Props) {
  const rows = useRowsWindow(handle, view.id)
  const win = rows.window
  const cols = useMemo(() => columnsOf(schema, view), [schema, view])
  const sections = useMemo(() => (win ? sectionsOf(win, schema, view) : []), [win, schema, view])
  const [folded, toggleFold] = usePersistentSet(`ramet.collection.fold.${handle.id}.${view.id}`)
  const [cursor, setCursor] = useState<Cursor | null>(null)
  /** 格子选区的锚点（null = 选区就是光标这一格） */
  const [anchor, setAnchor] = useState<Cursor | null>(null)
  /** 按下鼠标开始拖选的那一格：拖过别的格子时作锚点 */
  const cellDrag = useRef<Cursor | null>(null)
  const [editing, setEditing] = useState(false)
  /** 打字进编辑时打的那个字（交给格子的输入框 / 选择器） */
  const [seed, setSeed] = useState<string | undefined>(undefined)
  const [history] = useState(createUndoStack)
  const picking = useRowPicking()
  const picked = picking.picked
  /** 行手柄菜单（一个表格一份弹层，卸载时关掉） */
  const [rowMenu] = useState(createHandleMenu)
  useEffect(() => () => rowMenu.destroy(), [rowMenu])
  const pages = useCollectionPages()
  const [dropAt, setDropAt] = useState<{ id: string; below: boolean } | null>(null)
  const dragRow = useRef<{ id: string; section: string | null } | null>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  /** 正在拖宽的列：渲染也按它算模板，拖动中别的更新进来时列宽不跳回去 */
  const resizing = useRef<{ id: string; width: number } | null>(null)
  const canDrag = !readOnly && view.sorts.length === 0
  const focusTable = (): void => tableRef.current?.focus({ preventScroll: true })
  const loadMore = rows.loadMore

  // 看得见的行（折叠的段不算），键盘导航与格子选区按它走
  const visible = useMemo(() => sections.flatMap((s) => (s.key !== null && folded.has(s.key) ? [] : s.rows)), [sections, folded])
  const rowIndex = useMemo(() => new Map(visible.map((r, i) => [r.id, i])), [visible])

  /** 选区设成这个矩形（一格 = 没有锚点） */
  const selectBox = (b: CellBox): void => {
    const top = visible[b.r0]
    const bottom = visible[b.r1]
    const left = cols[b.c0]
    const right = cols[b.c1]
    if (!top || !bottom || !left || !right) return
    setAnchor(boxSize(b) > 1 ? { rowId: top.id, propId: left.id } : null)
    setCursor({ rowId: bottom.id, propId: right.id })
  }
  /** 做一次格子改动：写进去 + 进撤销栈 */
  const apply = (changes: CellChange[]): void => {
    if (changes.length === 0) return
    applyChanges(handle, changes, 'after')
    history.push(changes)
  }
  const replay = (redo: boolean): void => {
    const step = redo ? history.redo() : history.undo()
    if (!step) return
    applyChanges(handle, step, redo ? 'after' : 'before')
    const b = changesBox(step, rowIndex, cols)
    if (b) selectBox(b)
  }

  // 填充柄松手：填进拖过的行，选区扩到填过的范围
  const filling = useFillDrag({
    table: tableRef,
    indexOf: (id) => rowIndex.get(id),
    onFill: (box, span) => {
      apply(fillBox({ handle, rows: visible, cols, box, spaceId }, span))
      selectBox({ r0: Math.min(box.r0, span.r0), r1: Math.max(box.r1, span.r1), c0: box.c0, c1: box.c1 })
      focusTable()
    },
  })

  useEffect(() => {
    registerMore?.(loadMore)
    return () => registerMore?.(null)
  })

  // 滚到底续取：哨兵进视口（提前 300px）就取下一页
  useEffect(() => {
    const el = sentinel.current
    if (!el || !win?.next) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore()
    }, { rootMargin: '300px' })
    io.observe(el)
    return () => io.disconnect()
  }, [win, loadMore])

  useEffect(() => {
    const up = (): void => {
      cellDrag.current = null
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  // 编辑中点任何别处 = 只结束编辑（同 Notion）：这一下整个吞掉（按下、松开、click 都不往下传，别的元素拿不到焦点、
  // 点击也不生效），焦点回表格，格子保持选中，随后 ⌘C / ⌘V / 退格对着它。
  // 只放过编辑中这一格本身和弹层（选择器）里的点击。输入框靠失焦提交：先聚焦表格让它失焦，再收编辑态
  const endEdit = useRef<() => void>(() => {})
  useEffect(() => {
    if (!editing) return
    const swallow = (e: Event): void => {
      e.stopPropagation()
      if (e.type === 'click' || e.type === 'mouseup') e.preventDefault()
    }
    const release = (): void => {
      window.removeEventListener('pointerup', swallow, true)
      window.removeEventListener('mouseup', swallow, true)
      window.removeEventListener('click', swallow, true)
    }
    const onDown = (e: Event): void => {
      const target = e.target as Element | null
      if (!target || target.closest('.cl-pop, .cl-cell.is-selected')) return
      e.preventDefault()
      e.stopPropagation()
      window.addEventListener('pointerup', swallow, true)
      window.addEventListener('mouseup', swallow, true)
      window.addEventListener('click', swallow, true)
      // click 紧跟在 mouseup 之后派发；松开后放掉，拖出去没有 click 也不会误吞下一次点击
      window.addEventListener('mouseup', () => setTimeout(release, 0), { capture: true, once: true })
      tableRef.current?.focus({ preventScroll: true })
      endEdit.current()
    }
    // pointerdown 只拦传播（拦默认会连带取消随后的 mousedown）；收尾在 mousedown 里做
    const onPointerDown = (e: Event): void => {
      const target = e.target as Element | null
      if (target && !target.closest('.cl-pop, .cl-cell.is-selected')) e.stopPropagation()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [editing])

  // 勾选的行被删了 / 挪出窗口：摘掉
  const { prune } = picking
  useEffect(() => {
    if (!win) return
    const alive = new Set(win.rows.map((r) => r.id))
    prune((id) => alive.has(id))
  }, [win, prune])

  const marquee = useMarquee({
    root: wrapRef,
    item: '.cl-row[data-row-id]',
    idOf: (el) => el.dataset.rowId,
    // 单元格（行尾的空白格除外）、表头、分组头、新建行：各有各的点击
    avoid: '.cl-cell:not(.cl-cell-pad), .cl-handle, .cl-head, .cl-section-head, .cl-foot, .cl-more',
    disabled: readOnly,
    current: () => picking.picked,
    onBox: picking.setBox,
    onClick: picking.clear,
    focus: () => tableRef.current?.focus({ preventScroll: true }),
  })

  if (!win) {
    return <div className="collection-empty">{rows.error ? C.notFound : C.loading}</div>
  }

  const rowEls = (): Element[] => [...(tableRef.current?.querySelectorAll('.cl-row:not(.cl-head), .cl-section-head, .cl-foot') ?? [])]

  // 格子选区：光标与锚点在看得见的行 / 显示的列里的下标（锚点不在了 = 没有选区）
  const posOf = (at: Cursor | null) => {
    if (!at) return null
    const row = visible.findIndex((r) => r.id === at.rowId)
    const col = cols.findIndex((p) => p.id === at.propId)
    return row < 0 || col < 0 ? null : { row, col }
  }
  const curPos = posOf(cursor)
  const box = curPos ? boxOf(posOf(anchor) ?? curPos, curPos) : null
  const ranged = box !== null && boxSize(box) > 1
  const grid = box ? { handle, rows: visible, cols, box, spaceId } : null
  // 填充柄画在选区右下角那一格；选区里全是计算列就不画
  const fillable = box !== null && !readOnly && !editing && cols.slice(box.c0, box.c1 + 1).some((p) => !isComputed(p.type))
  const fillSpan = filling.span

  const commit = (row: CollectionRow, prop: CollectionProp, value: PropValue | null): void => {
    // 选区里编辑：同列选区里的每一行都写这个值（名称列只改这一行）
    const col = cols.findIndex((p) => p.id === prop.id)
    const inBox = prop.id !== TITLE_PROP_ID && ranged && box && col >= box.c0 && col <= box.c1
    apply(setCells(inBox ? visible.slice(box.r0, box.r1 + 1) : [row], prop, value))
  }
  const selectCell = (row: CollectionRow, prop: CollectionProp, shift: boolean): void => {
    const at = { rowId: row.id, propId: prop.id }
    setAnchor(shift && cursor ? (anchor ?? cursor) : null)
    setCursor(at)
    if (!shift) cellDrag.current = at
  }
  const extendTo = (row: CollectionRow, prop: CollectionProp): void => {
    const from = cellDrag.current
    if (!from || editing) return
    setAnchor(from)
    setCursor({ rowId: row.id, propId: prop.id })
  }
  const startEdit = (row: CollectionRow, prop: CollectionProp, typed?: string): void => {
    if (readOnly || isComputed(prop.type)) return
    setCursor({ rowId: row.id, propId: prop.id })
    if (prop.type === 'checkbox') {
      commit(row, prop, rowValue(row, prop) === true ? null : true)
      return
    }
    setSeed(typed)
    setEditing(true)
  }
  const stopEdit = (): void => {
    setEditing(false)
    setSeed(undefined)
    focusTable()
  }
  endEdit.current = stopEdit

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // 弹层（portal）里的按键也会沿 React 树冒泡到这里：只认表格 DOM 里的
    if (editing || !e.currentTarget.contains(e.target as Node) || e.nativeEvent.isComposing) return
    const mod = e.metaKey || e.ctrlKey
    const lower = e.key.toLowerCase()
    if (mod && !e.altKey && (lower === 'z' || lower === 'y')) {
      e.preventDefault()
      if (!readOnly) replay(lower === 'y' || e.shiftKey)
      return
    }
    if (mod && !e.altKey && lower === 'a' && visible.length > 0) {
      e.preventDefault()
      selectBox({ r0: 0, r1: visible.length - 1, c0: 0, c1: cols.length - 1 })
      return
    }
    if (e.key === 'Escape') {
      if (ranged) setAnchor(null)
      else if (picked.size > 0) picking.clear()
      else setCursor(null)
      return
    }
    if (!cursor) return
    const r = visible.findIndex((row) => row.id === cursor.rowId)
    const c = cols.findIndex((col) => col.id === cursor.propId)
    const row = visible[r]
    const prop = cols[c]
    if (!row || !prop) return
    const next = moveCursor({ row: r, col: c }, e.shiftKey && e.key === 'Tab' ? 'ArrowLeft' : e.key, visible.length, cols.length, mod)
    // Tab 到了行首 / 行尾就放行（焦点离开表格），别把键盘困在里面
    if (next && !(e.key === 'Tab' && next.row === r && next.col === c)) {
      e.preventDefault()
      const to = visible[next.row]
      const col = cols[next.col]
      if (!to || !col) return
      // Shift+方向键扩选区（锚点留在原处）；别的移动收起选区
      setAnchor(e.shiftKey && e.key !== 'Tab' ? (anchor ?? cursor) : null)
      setCursor({ rowId: to.id, propId: col.id })
      return
    }
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault()
      if (mod) onOpenRow(row.id)
      else startEdit(row, prop)
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && !readOnly && grid) {
      e.preventDefault()
      apply(clearBox(grid))
    } else if (e.key.length === 1 && !mod && !e.altKey && !readOnly && !isComputed(prop.type)) {
      // 选中格子直接打字：复选框只认空格（切换）；别的格用打的字开始编辑
      if (prop.type === 'checkbox' && e.key !== ' ') return
      e.preventDefault()
      startEdit(row, prop, prop.type === 'checkbox' ? undefined : e.key)
    }
  }

  /** 往选区里粘贴；一格都认不出 = false（什么都没写） */
  const pasteText = (text: string): boolean => {
    if (readOnly || !grid) return false
    // 续建新行只在不分组、窗口已取完时（新行接在看得见的末尾）
    const pasted = pasteBox(grid, text, !view.groupBy && !win.next)
    if (!pasted.recognized) return false
    apply(pasted.changes)
    for (const input of pasted.extra) handle.createRow(input, { viewId: view.id })
    if (pasted.area) selectBox(pasted.area)
    return true
  }

  const onResize = (id: string, width: number): void => {
    resizing.current = { id, width }
    tableRef.current?.style.setProperty('--cl-cols', gridTemplate(cols, view, resizing.current))
  }
  const onResized = (id: string, width: number): void => {
    setWidth(handle.doc, view.id, id, width)
    resizing.current = null
  }

  const allPicked = picked.size === 0 ? 'none' : picked.size >= win.rows.length ? 'all' : 'some'

  const newRow = (section: Section): void => {
    const set = section.key && view.groupBy ? { [view.groupBy]: section.key } : undefined
    // 乐观新建：行立即插进窗口，不等服务端（store 把确认前的改名排在确认之后发）
    const created = handle.createRow(set ? { set } : {}, { viewId: view.id })
    if (!created) return
    // 新行在已加载的窗口里（窗口到底、排在末行之前，或手动排序时接在已加载的末行之后）就直接进入名称编辑；
    // 落在还没加载的那一段（排序决定的位置）就等建成后打开它的页面，免得点了看不到
    if (handle.windowState(view.id).window?.rows.some((r) => r.id === created.id)) {
      setCursor({ rowId: created.id, propId: TITLE_PROP_ID })
      setEditing(true)
    } else void created.ready.then((row) => row && onOpenRow(row.id))
  }

  const drop = (section: Section, target: CollectionRow, below: boolean): void => {
    const from = dragRow.current
    dragRow.current = null
    setDropAt(null)
    if (!from || from.section !== section.key) return
    const neighbors = dropNeighbors(section.rows, from.id, target.id, below)
    if (!neighbors) return
    flip(rowEls(), () => flushSync(() => void handle.moveRow(from.id, neighbors.after, neighbors.before)))
  }

  const fold = (key: string): void => flip(rowEls(), () => flushSync(() => toggleFold(key)))

  const renderRow = (section: Section, row: CollectionRow, rowIndex: number) => (
    <div
      key={row.id}
      role="row"
      data-row-id={row.id}
      className={
        'cl-row' +
        (picked.has(row.id) ? ' is-picked' : '') +
        (dropAt?.id === row.id ? (dropAt.below ? ' is-drop-after' : ' is-drop-before') : '')
      }
      onDragOver={(e) => {
        const from = dragRow.current
        if (!from || from.section !== section.key) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const r = e.currentTarget.getBoundingClientRect()
        const below = e.clientY > r.top + r.height / 2
        setDropAt((cur) => (cur && cur.id === row.id && cur.below === below ? cur : { id: row.id, below }))
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt((cur) => (cur?.id === row.id ? null : cur))
      }}
      onDrop={(e) => {
        e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        drop(section, row, e.clientY > r.top + r.height / 2)
      }}
    >
      <div className="cl-gutter">
        {!readOnly && (
          <span
            className="cl-handle"
            role="button"
            draggable={canDrag}
            title={canDrag ? C.handle.tipDrag : C.handle.tip}
            aria-haspopup="menu"
            onClick={(e) =>
              openRowMenu(rowMenu, e.currentTarget, {
                handle,
                spaceId,
                pages,
                ids: picked.has(row.id) ? [...picked] : [row.id],
                onOpenRow,
                onDone: picking.clear,
                animate: (run) => flip(rowEls(), () => flushSync(run)),
              })
            }
            onDragStart={(e) => {
              dragRow.current = { id: row.id, section: section.key }
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData(ROW_DRAG_TYPE, row.id)
              const el = e.currentTarget.closest('.cl-row')
              if (el) e.dataTransfer.setDragImage(el, 20, 16)
            }}
            onDragEnd={() => {
              dragRow.current = null
              setDropAt(null)
            }}
          >
            <Icon name="handle" size={16} />
          </span>
        )}
        {!readOnly && (
          <input
            type="checkbox"
            className="cl-pick"
            aria-label={C.select.row}
            checked={picked.has(row.id)}
            onChange={(e) => picking.pick(row.id, (e.nativeEvent as MouseEvent).shiftKey === true, visible.map((r) => r.id))}
          />
        )}
      </div>
      {cols.map((prop, colIndex) => {
        const selected = cursor?.rowId === row.id && cursor.propId === prop.id
        return (
          <TableCell
            key={prop.id}
            row={row}
            prop={prop}
            doc={handle.doc}
            spaceId={spaceId}
            selected={selected}
            inRange={ranged && box !== null && rowIndex >= box.r0 && rowIndex <= box.r1 && colIndex >= box.c0 && colIndex <= box.c1}
            inFill={fillSpan !== null && box !== null && rowIndex >= fillSpan.r0 && rowIndex <= fillSpan.r1 && colIndex >= box.c0 && colIndex <= box.c1}
            onFillStart={fillable && box && rowIndex === box.r1 && colIndex === box.c1 ? (e) => filling.start(e, box) : undefined}
            editing={selected && editing}
            seed={selected && editing ? seed : undefined}
            readOnly={readOnly}
            onSelect={(shift) => {
              if (editing && !selected) {
                setEditing(false)
                setSeed(undefined)
              }
              selectCell(row, prop, shift)
              focusTable()
            }}
            onExtend={() => extendTo(row, prop)}
            onEdit={() => startEdit(row, prop)}
            onStop={stopEdit}
            onCommit={(value) => {
              commit(row, prop, value)
              // 格内输入提交即结束；选择器自己决定（单选选完就关，多选 / 人员留着继续选）
              if (!PICKER_TYPES.has(prop.type)) stopEdit()
            }}
            onPaste={(text) => {
              const done = pasteText(text)
              if (done) stopEdit()
              return done
            }}
            onOpen={() => onOpenRow(row.id)}
          />
        )
      })}
      <div className="cl-cell cl-cell-pad" />
    </div>
  )

  const groupProp = view.groupBy ? schema.props.find((p) => p.id === view.groupBy) : undefined
  return (
    <div ref={wrapRef} className={'cl-table-wrap' + (picked.size > 0 ? ' has-picked' : '')} onPointerDown={marquee.onPointerDown}>
      {marquee.layer}
      {picked.size > 0 && !readOnly && (
        <InBulkSlot>
          <BulkBar
            handle={handle}
            schema={schema}
            spaceId={spaceId}
            picked={picked}
            onClear={picking.clear}
            animate={(run) => flip(rowEls(), () => flushSync(run))}
          />
        </InBulkSlot>
      )}
      <div
        ref={tableRef}
        className="cl-table"
        role="grid"
        tabIndex={0}
        style={{ '--cl-cols': gridTemplate(cols, view, resizing.current) } as React.CSSProperties}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          // 焦点去了表格和弹层以外的地方（点进正文、别的输入框）：格子不再显示选中，免得看着选中、快捷键却到不了。
          // relatedTarget 为空（切走窗口等）不收，回来还能接着 ⌘V
          const to = e.relatedTarget as Element | null
          if (editing || !to || e.currentTarget.contains(to) || to.closest('.cl-pop')) return
          setCursor(null)
          setAnchor(null)
        }}
        onCopy={(e) => {
          if (editing || !grid || !e.currentTarget.contains(e.target as Node)) return
          e.preventDefault()
          e.clipboardData.setData('text/plain', copyBox(grid))
        }}
        onCut={(e) => {
          if (editing || !grid || !e.currentTarget.contains(e.target as Node)) return
          e.preventDefault()
          e.clipboardData.setData('text/plain', copyBox(grid))
          if (!readOnly) apply(clearBox(grid))
        }}
        onPaste={(e) => {
          if (editing || readOnly || !e.currentTarget.contains(e.target as Node)) return
          e.preventDefault()
          pasteText(e.clipboardData.getData('text/plain'))
        }}
      >
        <TableHeader
          doc={handle.doc}
          schema={schema}
          view={view}
          cols={cols}
          readOnly={readOnly}
          picked={allPicked}
          onPickAll={() => (allPicked === 'all' ? picking.clear() : picking.replace(win.rows.map((r) => r.id)))}
          onResize={onResize}
          onResized={onResized}
        />
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
              {!closed && section.rows.map((row) => renderRow(section, row, rowIndex.get(row.id) ?? -1))}
              {!closed && !readOnly && (
                <button type="button" className="cl-foot" onClick={() => newRow(section)}>
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
