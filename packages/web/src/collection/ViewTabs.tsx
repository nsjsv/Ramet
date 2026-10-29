// ---------- 视图标签：切换、新建、改名、换布局、删除、拖动排序 ----------
// 当前看哪个视图是个人偏好（localStorage，见 CollectionSurface），视图本身与顺序写集合文档（所有人同一份）。
// 点当前标签再点一次打开它的设置；viewer 只能切换。
import type * as Y from 'yjs'
import { COLLECTION_LAYOUTS, type CollectionLayout, type CollectionSchema, type CollectionView } from '@ramet/shared/collection-model'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { Popover, usePopover } from './popover'
import { NameInput } from './PropEditor'
import { useReorder } from './reorder'
import { addView, deleteView, moveView, renameView, setLayout } from './schema-ops'

const C = COPY.collection.views

type Props = {
  doc: Y.Doc
  schema: CollectionSchema
  activeId: string
  onSelect: (viewId: string) => void
  readOnly: boolean
  /** false = 只能切换（链接视图块：展示的是集合本身的视图，块里不管理视图） */
  manage?: boolean
}

export const LAYOUT_ICON = { table: 'table', board: 'columns' } as const

/** 视图没起名时的叫法：按布局 */
const defaultName = (layout: CollectionLayout): string => (layout === 'board' ? C.newBoard : C.newTable)
const nameOf = (view: CollectionView): string => view.name || defaultName(view.layout)

export default function ViewTabs({ doc, schema, activeId, onSelect, readOnly: viewOnly, manage = true }: Props) {
  const readOnly = viewOnly || !manage
  const [anchor, open, close] = usePopover()
  const [addAnchor, openAdd, closeAdd] = usePopover()
  const ids = schema.views.map((v) => v.id)
  const drag = useReorder(ids, (id, index) => moveView(doc, id, index), 'x', !readOnly)
  const editing = anchor ? schema.views.find((v) => v.id === anchor.dataset.view) : undefined
  return (
    <div className="cl-tabs" role="tablist">
      {schema.views.map((v) => (
        <button
          key={v.id}
          type="button"
          role="tab"
          data-view={v.id}
          aria-selected={v.id === activeId}
          className={'cl-tab' + (v.id === activeId ? ' is-active' : '')}
          title={v.id === activeId && !readOnly ? C.more : undefined}
          onClick={(e) => {
            if (v.id !== activeId) onSelect(v.id)
            else if (!readOnly) open(e.currentTarget)
          }}
          {...drag(v.id)}
        >
          <Icon name={LAYOUT_ICON[v.layout]} size={14} />
          <span>{nameOf(v)}</span>
        </button>
      ))}
      {!readOnly && (
        <button
          type="button"
          className="cl-tab cl-tab-add"
          title={C.add}
          aria-label={C.add}
          aria-expanded={addAnchor !== null}
          onClick={(e) => openAdd(e.currentTarget)}
        >
          <Icon name="plus" size={14} />
        </button>
      )}
      {addAnchor && !readOnly && (
        <Popover anchor={addAnchor} onClose={closeAdd}>
          <div className="cl-menu">
            <div className="pop-section">{C.add}</div>
            {COLLECTION_LAYOUTS.map((layout) => (
              <button
                key={layout}
                type="button"
                className="pop-row"
                onClick={() => {
                  closeAdd()
                  onSelect(addView(doc, defaultName(layout), layout))
                }}
              >
                <Icon name={LAYOUT_ICON[layout]} size={14} />
                {C.layouts[layout]}
              </button>
            ))}
          </div>
        </Popover>
      )}
      {anchor && editing && !readOnly && (
        <Popover anchor={anchor} onClose={close}>
          <div className="cl-menu">
            <NameInput value={editing.name} placeholder={C.name} autoFocus onCommit={(name) => renameView(doc, editing.id, name)} />
            <div className="pop-section">{C.layout}</div>
            {COLLECTION_LAYOUTS.map((layout) => (
              <button key={layout} type="button" className="pop-row" onClick={() => setLayout(doc, editing.id, layout)}>
                <Icon name={LAYOUT_ICON[layout]} size={14} />
                {C.layouts[layout]}
                {editing.layout === layout && <Icon name="check" size={14} className="cl-picker-check" />}
              </button>
            ))}
            <button
              type="button"
              className="pop-row is-danger"
              disabled={schema.views.length <= 1}
              title={schema.views.length <= 1 ? C.lastOne : undefined}
              onClick={() => {
                if (!window.confirm(C.confirmRemove(nameOf(editing)))) return
                const rest = schema.views.filter((v) => v.id !== editing.id)
                if (deleteView(doc, editing.id) && rest[0]) onSelect(rest[0].id)
                close()
              }}
            >
              <Icon name="trash" size={14} />
              {C.remove}
            </button>
          </div>
        </Popover>
      )}
    </div>
  )
}
