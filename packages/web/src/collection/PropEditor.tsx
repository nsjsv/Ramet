// ---------- 属性定义编辑：改名、改类型、选项、隐藏、左右移、删除 ----------
// 直接写集合文档（schema-ops.ts），经协同连接同步给所有人；viewer 不会打开它（入口在界面上禁用）。
// 名字与选项名在失焦 / Enter 时才写，不是每个键一笔协同增量。
import { useEffect, useState } from 'react'
import type * as Y from 'yjs'
import { COLOR_NAMES, type ColorName } from '@ramet/shared/md-dialect'
import {
  STATUS_GROUPS,
  typeHasOptions,
  type CollectionOption,
  type CollectionProp,
  type CollectionSchema,
  type CollectionView,
  type PropType,
  type StatusGroup,
} from '@ramet/shared/collection-model'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { isComputed, moveTo, nextColor, TYPE_ICON, TYPE_ORDER } from './prop-meta'
import { useReorder, type ReorderProps } from './reorder'
import {
  addOption,
  deleteOption,
  deleteProp,
  moveOption,
  renameProp,
  setPropType,
  setShown,
  shownProps,
  toggleShown,
  updateOption,
} from './schema-ops'

const C = COPY.collection

/** 失焦或 Enter 才提交的名字输入；外部值变了（别人改了名）且自己没在打字时跟着变 */
export function NameInput({
  value,
  onCommit,
  placeholder,
  autoFocus,
  className,
}: {
  value: string
  onCommit: (name: string) => void
  placeholder?: string
  autoFocus?: boolean
  className?: string
}) {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])
  const commit = (): void => {
    setEditing(false)
    if (draft.trim() && draft !== value) onCommit(draft)
    else setDraft(value)
  }
  return (
    <input
      className={'cl-name-input' + (className ? ` ${className}` : '')}
      value={draft}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') {
          setDraft(value)
          setEditing(false)
        }
      }}
    />
  )
}

function ColorDots({ value, onPick }: { value: ColorName; onPick: (c: ColorName) => void }) {
  return (
    <div className="cl-colors" role="radiogroup" aria-label={C.prop.color}>
      {COLOR_NAMES.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={c === value}
          title={C.colors[c]}
          className={'cl-color' + (c === value ? ' is-on' : '')}
          data-color={c}
          onClick={() => onPick(c)}
        />
      ))}
    </div>
  )
}

function OptionRow({ doc, prop, option, drag }: { doc: Y.Doc; prop: CollectionProp; option: CollectionOption; drag: ReorderProps }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="cl-option-row" {...drag}>
      <span className="cl-grip" aria-hidden="true">
        <Icon name="handle" size={10} />
      </span>
      <button type="button" className="cl-color is-on" data-color={option.color} title={C.prop.color} onClick={() => setOpen((v) => !v)} />
      <NameInput value={option.name} placeholder={C.prop.optionName} onCommit={(name) => updateOption(doc, prop.id, option.id, { name })} />
      <button type="button" className="icon-btn" title={C.prop.removeOption} onClick={() => deleteOption(doc, prop.id, option.id)}>
        <Icon name="x" size={14} />
      </button>
      {open && (
        <ColorDots
          value={option.color}
          onPick={(color) => {
            updateOption(doc, prop.id, option.id, { color })
            setOpen(false)
          }}
        />
      )}
    </div>
  )
}

/** 一组选项（状态是三组之一，别的类型只有一组）：拖动排序、加选项 */
function OptionGroup({ doc, prop, group, options }: { doc: Y.Doc; prop: CollectionProp; group?: StatusGroup; options: CollectionOption[] }) {
  const drag = useReorder(
    options.map((o) => o.id),
    (id, index) => moveOption(doc, prop.id, id, index, group),
  )
  return (
    <div className="cl-option-group">
      {group && <div className="pop-section">{C.statusGroups[group]}</div>}
      {options.map((o) => (
        <OptionRow key={o.id} doc={doc} prop={prop} option={o} drag={drag(o.id)} />
      ))}
      <button
        type="button"
        className="pop-row cl-add"
        onClick={() => addOption(doc, prop.id, C.prop.newOption(prop.options.length + 1), nextColor(prop.options.map((o) => o.color)), group)}
      >
        <Icon name="plus" size={14} />
        {C.prop.addOption}
      </button>
    </div>
  )
}

type Props = {
  doc: Y.Doc
  schema: CollectionSchema
  prop: CollectionProp
  /** 在哪个视图里打开的：给了才有「隐藏 / 左移 / 右移」 */
  view?: CollectionView
  onClose: () => void
}

export default function PropEditor({ doc, schema, prop, view, onClose }: Props) {
  const shown = view ? shownProps(schema, view) : []
  const at = shown.indexOf(prop.id)
  const move = (delta: number): void => {
    if (view && at >= 0) setShown(doc, view.id, moveTo(shown, prop.id, at + delta))
  }
  return (
    <div className="cl-prop-editor">
      <NameInput value={prop.name} placeholder={C.prop.name} autoFocus onCommit={(name) => renameProp(doc, prop.id, name)} />
      <label className="cl-field">
        <span>{C.prop.type}</span>
        <select value={prop.type} onChange={(e) => setPropType(doc, prop.id, e.target.value as PropType)}>
          {TYPE_ORDER.map((t) => (
            <option key={t} value={t}>
              {C.types[t]}
            </option>
          ))}
        </select>
        <Icon name={TYPE_ICON[prop.type]} size={14} />
      </label>
      {isComputed(prop.type) && <div className="cl-hint">{C.prop.readonlyType}</div>}
      {typeHasOptions(prop.type) && (
        <div className="cl-options">
          <div className="pop-section">{C.prop.options}</div>
          {prop.type === 'status' ? (
            STATUS_GROUPS.map((g) => <OptionGroup key={g.id} doc={doc} prop={prop} group={g.id} options={prop.options.filter((o) => o.group === g.id)} />)
          ) : (
            <OptionGroup doc={doc} prop={prop} options={prop.options} />
          )}
        </div>
      )}
      <div className="cl-sep" />
      {view && at >= 0 && (
        <>
          <button type="button" className="pop-row" disabled={at === 0} onClick={() => move(-1)}>
            <Icon name="arrow-up" size={14} className="cl-rot-left" />
            {C.prop.moveLeft}
          </button>
          <button type="button" className="pop-row" disabled={at === shown.length - 1} onClick={() => move(1)}>
            <Icon name="arrow-down" size={14} className="cl-rot-left" />
            {C.prop.moveRight}
          </button>
          <button
            type="button"
            className="pop-row"
            onClick={() => {
              toggleShown(doc, view.id, prop.id, false)
              onClose()
            }}
          >
            <Icon name="eye-off" size={14} />
            {C.prop.hide}
          </button>
        </>
      )}
      <button
        type="button"
        className="pop-row is-danger"
        onClick={() => {
          if (!window.confirm(C.prop.confirmRemove(prop.name || C.types[prop.type]))) return
          deleteProp(doc, prop.id)
          onClose()
        }}
      >
        <Icon name="trash" size={14} />
        {C.prop.remove}
      </button>
    </div>
  )
}
