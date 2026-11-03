// ---------- 卡片 / 列表行上的名称与属性：就地改名、就地改值（看板卡片、画廊卡片、列表行共用） ----------
// 可编辑时点名称文字 = 就地改名，点属性 = 就地改值（编辑器由 CellEditor 按类型选：输入框就地替换，弹层贴着属性弹出，
// 复选框点一下即切换）；点条目以外的地方（空白、系统生成的属性）打开行页面。只读时调用方直接打开，不经这里。
// 属性空值不画（正在编辑的那一项除外）；复选框只有一个勾，旁边带上属性名才看得懂勾的是什么。
import { useState } from 'react'
import type * as Y from 'yjs'
import { rowValue, TITLE_PROP, TITLE_PROP_ID, type CollectionProp, type CollectionRow, type PropValue } from '@ramet/shared/collection-model'
import { COPY } from '../copy'
import { hasValue } from './board/board-model'
import { CellEditor } from './cells/CellEditor'
import { CellView } from './cells/CellView'
import { editorKind } from './cells/editor-kind'

/** 正在编辑的项：属性 id（名称 = TITLE_PROP_ID）+ 选择器弹层贴着的元素 */
type Editing = { propId: string; el: HTMLElement }

export type ItemEdit = {
  editing: Editing | null
  /** 正在改名（点了名称文字） */
  renaming: boolean
  stop: () => void
  /** 点在条目上：名称文字 = 改名，可改的属性 = 改值，别处 = 打开 */
  clickAt: (target: HTMLElement) => void
}

export function useItemEdit(
  row: CollectionRow,
  props: readonly CollectionProp[],
  onOpen: () => void,
  onSet: (propId: string, value: PropValue | null) => void,
): ItemEdit {
  const [editing, setEditing] = useState<Editing | null>(null)
  const clickAt = (target: HTMLElement): void => {
    // 名称文字带 data-item-name（各视图的名称样式各用各的类名）
    const name = target.closest<HTMLElement>('[data-item-name]')
    if (name) {
      setEditing({ propId: TITLE_PROP_ID, el: name })
      return
    }
    const field = target.closest<HTMLElement>('[data-prop]')
    const prop = field ? props.find((x) => x.id === field.dataset.prop) : undefined
    const kind = prop ? editorKind(prop) : 'none'
    if (!field || !prop || kind === 'none') {
      onOpen()
      return
    }
    if (kind === 'toggle') {
      onSet(prop.id, rowValue(row, prop) === true ? null : true)
      return
    }
    setEditing({ propId: prop.id, el: field })
  }
  return { editing, renaming: editing?.propId === TITLE_PROP_ID, stop: () => setEditing(null), clickAt }
}

type NameProps = {
  row: CollectionRow
  edit: ItemEdit
  /** 刚新建的行：标题就地输入，起始为空（Enter / 失焦改名，Esc 或留空不改） */
  fresh: boolean
  doc: Y.Doc
  spaceId: string | null
  /** 名称文字的类名 */
  className: string
  /** 输入框按展示时的宽度折行（卡片）；列表行是单行 */
  wrap?: boolean
  onRename: (title: string) => void
  onNameDone: () => void
}

/** 名称：改名中是输入框，否则是文字（空标题显示「未命名」） */
export function ItemName({ row, edit, fresh, doc, spaceId, className, wrap, onRename, onNameDone }: NameProps) {
  if (!fresh && !edit.renaming) {
    return (
      <span className={className + (row.title ? '' : ' is-empty')} data-item-name="">
        {row.title || COPY.untitled}
      </span>
    )
  }
  return (
    <CellEditor
      prop={TITLE_PROP}
      value={fresh ? undefined : row.title}
      doc={doc}
      spaceId={spaceId}
      wrap={wrap}
      onCommit={(value) => {
        edit.stop()
        onRename(typeof value === 'string' ? value : '')
      }}
      onDone={() => {
        edit.stop()
        if (fresh) onNameDone()
      }}
    />
  )
}

type FieldsProps = {
  row: CollectionRow
  props: readonly CollectionProp[]
  edit: ItemEdit
  doc: Y.Doc
  spaceId: string | null
  /** 每一项的类名 */
  className: string
  /** 输入框折行（卡片） */
  wrap?: boolean
  onSet: (propId: string, value: PropValue | null) => void
}

/** 显示的属性（有值的，加上正在编辑的那一项）+ 弹层编辑器 */
export function ItemFields({ row, props, edit, doc, spaceId, className, wrap, onSet }: FieldsProps) {
  const { editing } = edit
  const editProp = editing && editing.propId !== TITLE_PROP_ID ? props.find((x) => x.id === editing.propId) : undefined
  return (
    <>
      {props
        .filter((prop) => hasValue(row, prop) || prop.id === editProp?.id)
        .map((prop) => (
          <div
            key={prop.id}
            className={className + (editorKind(prop) === 'none' ? ' is-locked' : '') + (prop.id === editProp?.id ? ' is-editing' : '')}
            data-type={prop.type}
            data-prop={prop.id}
          >
            {prop.id === editProp?.id && editorKind(prop) === 'inline' ? (
              <CellEditor
                prop={prop}
                value={rowValue(row, prop)}
                doc={doc}
                spaceId={spaceId}
                wrap={wrap}
                onCommit={(value) => {
                  edit.stop()
                  onSet(prop.id, value)
                }}
                onDone={edit.stop}
              />
            ) : (
              <CellView prop={prop} row={row} spaceId={spaceId} />
            )}
            {(prop.type === 'checkbox' || (prop.type === 'formula' && prop.output === 'boolean')) && <span className="cl-card-label">{prop.name}</span>}
          </div>
        ))}
      {editing && editProp && editorKind(editProp) === 'popover' && (
        <CellEditor
          prop={editProp}
          value={rowValue(row, editProp)}
          doc={doc}
          spaceId={spaceId}
          anchor={editing.el}
          onCommit={(value) => onSet(editProp.id, value)}
          onDone={edit.stop}
        />
      )}
    </>
  )
}
