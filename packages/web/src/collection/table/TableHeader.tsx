/* ---------- 表头：列名（点开列菜单 = 属性定义编辑）、拖右缘改列宽、行尾「＋」新建属性、全选 ----------
 * 拖宽：拖动中只改表格的本地样式（onResize 每帧改一个 CSS 变量），松手才写一次集合文档（onResized）。 */
import { useState } from 'react'
import type * as Y from 'yjs'
import {
  COLUMN_WIDTH_MAX,
  COLUMN_WIDTH_MIN,
  TITLE_PROP_ID,
  type CollectionProp,
  type CollectionSchema,
  type CollectionView,
} from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { Icon } from '../../icons'
import PropEditor from '../PropEditor'
import { Popover, usePopover } from '../popover'
import { columnWidth, TITLE_ICON, TYPE_ICON } from '../prop-meta'
import { createProp, TypeList } from '../toolbar/menus'

const C = COPY.collection

type Props = {
  doc: Y.Doc
  schema: CollectionSchema
  view: CollectionView
  cols: CollectionProp[]
  readOnly: boolean
  /** 全选框：all = 已加载的行都选了，some = 选了一部分 */
  picked: 'none' | 'some' | 'all'
  onPickAll: () => void
  onResize: (propId: string, width: number) => void
  onResized: (propId: string, width: number) => void
}

export default function TableHeader({ doc, schema, view, cols, readOnly, picked, onPickAll, onResize, onResized }: Props) {
  const [anchor, open, close] = usePopover()
  const [dragging, setDragging] = useState<string | null>(null)
  const menuFor = anchor?.dataset.prop
  const menuProp = menuFor ? schema.props.find((p) => p.id === menuFor) : undefined

  const startResize = (e: React.PointerEvent, prop: CollectionProp): void => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = columnWidth(view, prop)
    let width = startW
    setDragging(prop.id)
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent): void => {
      width = Math.round(Math.min(COLUMN_WIDTH_MAX, Math.max(COLUMN_WIDTH_MIN, startW + ev.clientX - startX)))
      onResize(prop.id, width)
    }
    const up = (): void => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      setDragging(null)
      onResized(prop.id, width)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  return (
    <div className="cl-row cl-head" role="row">
      <div className="cl-gutter">
        {!readOnly && (
          <input
            type="checkbox"
            className="cl-pick"
            aria-label={C.select.all}
            title={C.select.all}
            checked={picked === 'all'}
            ref={(el) => {
              if (el) el.indeterminate = picked === 'some'
            }}
            onChange={onPickAll}
          />
        )}
      </div>
      {cols.map((prop) => {
        const isTitle = prop.id === TITLE_PROP_ID
        const clickable = !readOnly && !isTitle
        return (
          <div key={prop.id} role="columnheader" className={'cl-th' + (dragging === prop.id ? ' is-resizing' : '')}>
            <button
              type="button"
              className="cl-th-btn"
              data-prop={prop.id}
              disabled={!clickable}
              title={clickable ? C.props.edit : undefined}
              onClick={(e) => open(e.currentTarget)}
            >
              <Icon name={isTitle ? TITLE_ICON : TYPE_ICON[prop.type]} size={14} />
              <span>{prop.name || C.types[prop.type]}</span>
            </button>
            {!readOnly && <span className="cl-resize" role="separator" aria-orientation="vertical" onPointerDown={(e) => startResize(e, prop)} />}
          </div>
        )
      })}
      <div className="cl-th cl-th-add">
        {!readOnly && (
          <button type="button" className="cl-th-btn" data-prop="" title={C.props.add} aria-label={C.props.add} onClick={(e) => open(e.currentTarget)}>
            <Icon name="plus" size={14} />
          </button>
        )}
      </div>
      {anchor && menuProp && (
        <Popover anchor={anchor} onClose={close}>
          <PropEditor doc={doc} schema={schema} prop={menuProp} view={view} onClose={close} />
        </Popover>
      )}
      {anchor && menuFor === '' && (
        <Popover anchor={anchor} onClose={close}>
          <TypeList
            onPick={(type) => {
              createProp(doc, schema, view, type)
              close()
            }}
          />
        </Popover>
      )}
    </div>
  )
}
