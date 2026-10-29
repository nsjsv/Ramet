// ---------- 批量操作栏：选中行以后出现在视图上方（表格与看板共用） ----------
// 值编辑器复用单元格的：单选、状态点一下即应用；多选、人员先勾好再「应用」（整体替换）；文本类输入框 Enter 应用。
// 写都走 store：改值乐观，复制 / 移动 / 删除随后重取页面列表窗口。
import { useState } from 'react'
import type { Page } from '../api'
import type { CollectionProp, CollectionSchema, PropValue } from '@ramet/shared/collection-model'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { InlineInput } from './cells/InlineInput'
import { OptionPicker, PersonPicker } from './cells/Pickers'
import type { CollectionHandle } from './collection-store'
import { useCollectionPages } from './collection-store'
import { CollectionChooser } from './CollectionPicker'
import { Popover, usePopover } from './popover'
import { isComputed, TYPE_ICON } from './prop-meta'
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

/** 一个属性的批量值编辑器；底部按钮按下时不抢焦点（输入框失焦会先提交一次） */
function ValueEditor({ prop, handle, spaceId, onApply }: { prop: CollectionProp; handle: CollectionHandle; spaceId: string | null; onApply: (value: PropValue | null) => void }) {
  const [draft, setDraft] = useState<PropValue | null>(null)
  if (prop.type === 'checkbox') {
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
  const multi = prop.type === 'multi_select' || prop.type === 'person'
  const body =
    prop.type === 'person' ? (
      <PersonPicker value={draft ?? undefined} spaceId={spaceId} onChange={setDraft} />
    ) : prop.type === 'multi_select' ? (
      <OptionPicker prop={prop} value={draft ?? undefined} doc={handle.doc} onChange={setDraft} onDone={() => {}} />
    ) : prop.type === 'select' || prop.type === 'status' ? (
      <OptionPicker prop={prop} value={undefined} doc={handle.doc} onChange={onApply} onDone={() => {}} />
    ) : (
      <div className="cl-bulk-input">
        <InlineInput prop={prop} initial="" onCommit={onApply} onCancel={() => {}} />
      </div>
    )
  return (
    <div className="cl-bulk-editor">
      {body}
      <div className="cl-bulk-foot">
        <button type="button" className="cl-bar-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => onApply(null)}>
          {C.cell.clear}
        </button>
        {multi && (
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
  const editable = schema.props.filter((p) => !isComputed(p.type))
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
