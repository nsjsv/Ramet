// ---------- 批量操作栏：选中行以后出现在视图上方（表格与看板共用） ----------
// 值编辑器就是单元格的 CellEditor：单选、状态点一下即应用；多选、人员、文件、日期先改好草稿再「应用」（整体替换）；
// 输入框 Enter 应用。系统生成的属性与反向关联不在「改哪个属性」里（editor-kind.ts 的 bulkEditable）。
// 写都走 store：改值乐观，复制 / 移动 / 删除随后重取页面列表窗口。
import { useState } from 'react'
import type { Page } from '../api'
import type { CollectionProp, CollectionSchema, PropValue } from '@ramet/shared/collection-model'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { CellEditor } from './cells/CellEditor'
import { bulkEditable, editorKind, pickOnce } from './cells/editor-kind'
import type { CollectionHandle } from './collection-store'
import { useCollectionPages } from './collection-store'
import { CollectionChooser } from './CollectionPicker'
import { Popover, usePopover } from '../ui/popover'
import { TYPE_ICON } from './prop-meta'
import { moveRowsConfirmed, moveTargets, trashRowsConfirmed, type Animate } from './row-actions'

const C = COPY.collection
const S = C.select

type Props = {
  handle: CollectionHandle
  schema: CollectionSchema
  spaceId: string | null
  picked: ReadonlySet<string>
  onClear: () => void
  /** 删 / 挪之前：表格用它做 flip 补位（缺省直接执行） */
  animate?: Animate
}

/** 一个属性的批量值编辑器；底部按钮按下时不抢焦点（输入框失焦会先提交一次）。
 *  一次要改很多行，只有明确的动作才写：输入框 Enter、单选 / 状态点选、底部「清空」「应用」。
 *  其余弹层编辑器（多选、人员、文件、日期）报来的值一律只是草稿，它们自己的「清空」「今天」也只改草稿 */
function ValueEditor({ prop, handle, spaceId, onApply }: { prop: CollectionProp; handle: CollectionHandle; spaceId: string | null; onApply: (value: PropValue | null) => void }) {
  const kind = editorKind(prop)
  const [draft, setDraft] = useState<PropValue | null>(null)
  if (kind === 'toggle') {
    return (
      <div className="cl-menu">
        <button type="button" className="pop-row" onClick={() => onApply(true)}>
          <Icon name="checkbox" size={14} />
          {S.checked}
        </button>
        <button type="button" className="pop-row" onClick={() => onApply(null)}>
          {S.unchecked}
        </button>
      </div>
    )
  }
  const inline = kind === 'inline'
  const direct = inline || pickOnce(prop)
  const editor = (
    <CellEditor
      prop={prop}
      value={draft ?? undefined}
      doc={handle.doc}
      spaceId={spaceId}
      live
      onCommit={direct ? onApply : setDraft}
      // onDone 只是编辑器自己收尾（输入框取消、选择器里的「清空」、日期 Enter），不写任何行
      onDone={() => undefined}
    />
  )
  return (
    <div className="cl-bulk-editor">
      {inline ? <div className="cl-bulk-input">{editor}</div> : editor}
      <div className="cl-bulk-foot">
        <button type="button" className="cl-bar-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => onApply(null)}>
          {C.cell.clear}
        </button>
        {!direct && (
          <button type="button" className="cl-bar-btn is-on" onMouseDown={(e) => e.preventDefault()} onClick={() => onApply(draft)}>
            {S.apply}
          </button>
        )}
      </div>
    </div>
  )
}

export default function BulkBar({ handle, schema, spaceId, picked, onClear, animate }: Props) {
  const [anchor, open, close] = usePopover()
  const [editing, setEditing] = useState<CollectionProp | null>(null)
  const pages = useCollectionPages()
  const which = anchor?.dataset.menu
  const ids = [...picked]
  const editable = schema.props.filter(bulkEditable)
  const targets = moveTargets(pages, handle, spaceId)

  const shut = (): void => {
    close()
    setEditing(null)
  }
  const apply = (prop: CollectionProp, value: PropValue | null): void => {
    shut()
    void handle.setValuesMany(ids, { [prop.id]: value })
  }
  const remove = (): void => trashRowsConfirmed(handle, ids, onClear, animate)
  const duplicate = (): void => {
    void handle.duplicateRows(ids)
    onClear()
  }
  const moveTo = (to: Page): void => {
    shut()
    moveRowsConfirmed(handle, ids, to, onClear, animate)
  }

  return (
    <div className="cl-picked-bar cl-bulk">
      <span>{S.count(picked.size)}</span>
      <button type="button" data-menu="edit" className="cl-bar-btn" aria-expanded={which === 'edit'} onClick={(e) => open(e.currentTarget)}>
        <Icon name="edit" size={14} />
        {S.edit}
      </button>
      <button type="button" className="cl-bar-btn" onClick={duplicate}>
        <Icon name="copy" size={14} />
        {S.duplicate}
      </button>
      <button type="button" data-menu="move" className="cl-bar-btn" aria-expanded={which === 'move'} onClick={(e) => open(e.currentTarget)}>
        <Icon name="swap" size={14} />
        {S.move}
      </button>
      <button type="button" className="cl-bar-btn is-danger" onClick={remove}>
        <Icon name="trash" size={14} />
        {S.remove}
      </button>
      <button type="button" className="cl-bar-btn" onClick={onClear}>
        {S.cancel}
      </button>
      {anchor && which === 'edit' && (
        <Popover anchor={anchor} onClose={shut} className="cl-bar-pop">
          {editing ? (
            <ValueEditor key={editing.id} prop={editing} handle={handle} spaceId={spaceId} onApply={(value) => apply(editing, value)} />
          ) : (
            <div className="cl-menu">
              <div className="pop-section">{S.editPick}</div>
              {editable.map((p) => (
                <button key={p.id} type="button" className="pop-row" onClick={() => setEditing(p)}>
                  <Icon name={TYPE_ICON[p.type]} size={14} />
                  {p.name || C.types[p.type]}
                </button>
              ))}
              {editable.length === 0 && <div className="cl-hint">{S.noEditable}</div>}
            </div>
          )}
        </Popover>
      )}
      {anchor && which === 'move' && (
        <CollectionChooser
          anchor={anchor}
          collections={targets}
          title={S.movePick}
          empty={S.moveEmpty}
          onPick={moveTo}
          onClose={shut}
        />
      )}
    </div>
  )
}
