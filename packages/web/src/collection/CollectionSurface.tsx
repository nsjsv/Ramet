// ---------- 集合的内容区：视图标签（右侧是工具栏）+ 当前视图（整页集合与正文里的集合块共用） ----------
// 只吃 handle / readOnly / spaceId / onOpenRow，嵌入块复用时不依赖页面路由。
// 当前看哪个视图是个人偏好，按集合记在 localStorage（不进文档），记的视图被删了就回到第一个。
// 按视图的 layout 分流（LAYOUT_VIEW），还没有界面的布局按表格画；数据与设置是同一份，换布局不丢东西。
import { useContext, useEffect, useMemo, useState, type ComponentType } from 'react'
import { pickView, type CollectionSchema, type CollectionView } from '@ramet/shared/collection-model'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { useCollectionError, useCollectionSchema, useCollectionStatus, type CollectionHandle } from './collection-store'
import BoardView from './board/BoardView'
import { BulkSlot } from './bulk-slot'
import CalendarView from './calendar/CalendarView'
import GalleryView from './gallery/GalleryView'
import { isReadyLayout, type ReadyLayout } from './layouts'
import ListView from './list/ListView'
import { RelationContext, useCollectionRefs, type RelationCtx } from './relation-ctx'
import TableView from './table/TableView'
import TimelineView from './timeline/TimelineView'
import Toolbar from './toolbar/Toolbar'
import ViewTabs from './ViewTabs'

const C = COPY.collection

type ViewProps = {
  handle: CollectionHandle
  schema: CollectionSchema
  view: CollectionView
  readOnly: boolean
  spaceId: string | null
  onOpenRow: (rowId: string) => void
  /** 只有表格与列表接（整页集合后退回到原位置按行锚定） */
  registerMore?: (more: (() => void) | null) => void
}

const LAYOUT_VIEW: Record<ReadyLayout, ComponentType<ViewProps>> = {
  table: TableView,
  board: BoardView,
  list: ListView,
  gallery: GalleryView,
  calendar: CalendarView,
  timeline: TimelineView,
}

type Props = {
  handle: CollectionHandle
  readOnly: boolean
  spaceId: string | null
  onOpenRow: (rowId: string) => void
  /** 整页集合：后退恢复滚动位置时续取用（见 CollectionPage） */
  registerMore?: (more: (() => void) | null) => void
  /** 正文里的集合块：受控，看哪个视图由块定（块按块 id 记在本机，见 block-view.tsx）；缺省 = 按集合记的个人偏好（localStorage） */
  viewId?: string
  onViewChange?: (viewId: string) => void
  /** false = 只能切换视图，不能新建 / 改名 / 删除 / 排序视图（链接视图块） */
  manageViews?: boolean
}

const viewKey = (cid: string): string => `ramet.collection.view.${cid}`

function readViewChoice(cid: string): string | null {
  try {
    return localStorage.getItem(viewKey(cid))
  } catch {
    return null
  }
}

export default function CollectionSurface({ handle, readOnly, spaceId, onOpenRow, registerMore, viewId, onViewChange, manageViews = true }: Props) {
  const schema = useCollectionSchema(handle)
  const status = useCollectionStatus(handle)
  const error = useCollectionError(handle)
  const [choice, setChoice] = useState<string | null>(() => readViewChoice(handle.id))
  // 批量操作栏的插槽：外面（正文里的集合块）给了就用外面的（盖块标题行），没给就盖在视图标签栏上
  const outerSlot = useContext(BulkSlot)
  const [ownSlot, setOwnSlot] = useState<HTMLElement | null>(null)
  const refs = useCollectionRefs(handle)
  // 关联格、汇总格、属性设置要的上下文（relation-ctx.ts）：本集合、空间、refs、按页面 id 打开别的行
  const relation = useMemo<RelationCtx>(() => ({ cid: handle.id, spaceId, refs, open: onOpenRow }), [handle.id, spaceId, refs, onOpenRow])
  useEffect(() => setChoice(readViewChoice(handle.id)), [handle.id])
  const controlled = viewId !== undefined
  const select = (next: string): void => {
    if (controlled) {
      onViewChange?.(next)
      return
    }
    setChoice(next)
    try {
      localStorage.setItem(viewKey(handle.id), next)
    } catch (err) {
      console.error(err) // 隐私模式 / 配额满：只是不记住，不影响切换
    }
  }

  if (status === 'denied') return <div className="collection-empty">{C.notFound}</div>
  if (!schema) return <div className="collection-empty">{C.loading}</div>
  const view = pickView(schema, controlled ? viewId : choice)
  const Layout = isReadyLayout(view.layout) ? LAYOUT_VIEW[view.layout] : TableView
  return (
    <RelationContext.Provider value={relation}>
      <div className="collection-surface">
        <div className="cl-viewbar">
          <ViewTabs
            doc={handle.doc}
            schema={schema}
            activeId={view.id}
            onSelect={select}
            readOnly={readOnly}
            manage={manageViews}
          />
          <Toolbar doc={handle.doc} schema={schema} view={view} readOnly={readOnly} spaceId={spaceId} />
          {!outerSlot && <div ref={setOwnSlot} className="cl-bulk-slot" />}
        </div>
        {error && (
          <div className="cl-error" role="alert">
            <span>{error}</span>
            <button type="button" className="icon-btn" title={C.dismiss} aria-label={C.dismiss} onClick={handle.clearError}>
              <Icon name="x" size={14} />
            </button>
          </div>
        )}
        <BulkSlot.Provider value={outerSlot ?? ownSlot}>
          <Layout
            key={view.id}
            handle={handle}
            schema={schema}
            view={view}
            readOnly={readOnly}
            spaceId={spaceId}
            onOpenRow={onOpenRow}
            registerMore={registerMore}
          />
        </BulkSlot.Provider>
      </div>
    </RelationContext.Provider>
  )
}
