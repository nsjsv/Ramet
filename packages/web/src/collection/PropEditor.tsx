// ---------- 属性定义编辑：改名、改类型、选项、编号前缀、关联 / 汇总设置、公式、隐藏、左右移、删除 ----------
// 直接写集合文档（schema-ops.ts），经协同连接同步给所有人；viewer 不会打开它（入口在界面上禁用）。
// 名字、选项名与编号前缀在失焦 / Enter 时才写，不是每个键一笔协同增量。
// 关联例外：定义跨两份集合文档，改成关联（先选目标集合）、从关联改走、删关联都经服务端（relation-settings.tsx 的口径），
// 两侧一起改；反向关联不能改类型（它的类型是对方那边的正向关联定的），只能删。
import { useEffect, useState } from 'react'
import type * as Y from 'yjs'
import { COLOR_NAMES, type ColorName } from '@ramet/shared/md-dialect'
import {
  cleanPrefix,
  isComputedProp,
  isReverseRelation,
  NUMBER_PREFIX_MAX,
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
import { collectionApi } from './collection-api'
import { useCollectionPages } from './collection-store'
import { CollectionChooser } from './CollectionPicker'
import { FormulaField } from './FormulaEditor'
import { NameInput } from './name-input'
import { usePopover } from '../ui/popover'
import { confirmDialog } from '../ui/dialog'
import { Select } from '../ui/Select'
import { moveTo, nextColor, TYPE_ICON, TYPE_ORDER } from './prop-meta'
import { useRelationCtx } from './relation-ctx'
import { relatableCollections } from './relation-model'
import { collectionName, RelationSettings, RollupSettings } from './relation-settings'
import { useReorder, type ReorderProps } from './reorder'
import {
  addOption,
  deleteOption,
  deleteProp,
  moveOption,
  renameProp,
  setPropCfg,
  setPropType,
  setShown,
  shownProps,
  toggleShown,
  updateOption,
} from './schema-ops'

const C = COPY.collection
const R = C.relation

/** 自动编号的前缀：只收 [A-Za-z0-9_-]（打别的字直接不进框），失焦 / Enter 写；可以清空 */
function PrefixField({ doc, prop }: { doc: Y.Doc; prop: CollectionProp }) {
  const value = prop.cfg.prefix ?? ''
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])
  const commit = (): void => {
    setEditing(false)
    if (draft !== value) setPropCfg(doc, prop.id, { prefix: cleanPrefix(draft) })
  }
  return (
    <label className="cl-field">
      <span>{C.prop.prefix}</span>
      <input
        className="cl-input cl-prefix-input"
        value={draft}
        placeholder={C.prop.prefixHint}
        maxLength={NUMBER_PREFIX_MAX}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(cleanPrefix(e.target.value))}
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
    </label>
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
          data-tip={C.colors[c]} aria-label={C.colors[c]}
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
      <button type="button" className="cl-color is-on" data-color={option.color} data-tip={C.prop.color} aria-label={C.prop.color} onClick={() => setOpen((v) => !v)} />
      <NameInput value={option.name} placeholder={C.prop.optionName} onCommit={(name) => updateOption(doc, prop.id, option.id, { name })} />
      <button type="button" className="icon-btn" data-tip={C.prop.removeOption} aria-label={C.prop.removeOption} onClick={() => deleteOption(doc, prop.id, option.id)}>
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
  const ctx = useRelationCtx()
  const pages = useCollectionPages()
  const [retarget, openRetarget, closeRetarget] = usePopover()
  const [error, setError] = useState<string | null>(null)
  const shown = view ? shownProps(schema, view) : []
  const at = shown.indexOf(prop.id)
  const move = (delta: number): void => {
    if (view && at >= 0) setShown(doc, view.id, moveTo(shown, prop.id, at + delta))
  }
  const name = prop.name || C.types[prop.type]
  const reverse = isReverseRelation(prop)
  /** 对方集合里有对应的属性（双向关联的两侧）：改走 / 删除要说明那边也会少一个属性 */
  const paired = prop.type === 'relation' && (reverse || !!prop.cfg.reverse)
  const other = collectionName(pages, prop.cfg.target) ?? R.broken
  const call = (fn: () => Promise<unknown>, then: () => void): void =>
    void fn().then(then, (err: unknown) => setError(err instanceof Error && err.message ? err.message : C.writeFailed))
  // 确认框是异步的：开着时属性可能被别人改 / 删了。下面的写都按 prop.id 落到活文档 / 服务端（属性没了是空操作），
  // 不拿 await 之前读到的对象整份写回
  const changeType = async (type: PropType, el: HTMLElement): Promise<void> => {
    if (type === prop.type) return
    // 改成关联要先有目标：选好集合后经服务端改（PATCH 带 target），取消就什么都不变
    if (type === 'relation') {
      if (ctx) openRetarget(el)
      return
    }
    if (paired && ctx) {
      if (!(await confirmDialog({ message: R.confirmRetype(other), danger: true, confirmLabel: COPY.dialog.proceed }))) return
      call(() => collectionApi.patchRelation(ctx.cid, prop.id, { two_way: false }), () => setPropType(doc, prop.id, type))
      return
    }
    setPropType(doc, prop.id, type)
  }
  const remove = async (): Promise<void> => {
    if (prop.type === 'relation' && ctx) {
      const message = paired ? R.confirmRemove(name, other) : C.prop.confirmRemove(name)
      if (!(await confirmDialog({ message, danger: true }))) return
      call(() => collectionApi.deleteRelation(ctx.cid, prop.id), onClose)
      return
    }
    if (!(await confirmDialog({ message: C.prop.confirmRemove(name), danger: true }))) return
    deleteProp(doc, prop.id)
    onClose()
  }
  return (
    <div className="cl-prop-editor">
      <NameInput value={prop.name} placeholder={C.prop.name} autoFocus onCommit={(name) => renameProp(doc, prop.id, name)} />
      <label className="cl-field">
        <span>{C.prop.type}</span>
        <Select
          size="sm"
          label={C.prop.type}
          value={prop.type}
          disabled={reverse}
          tip={reverse ? R.reverseType : undefined}
          options={TYPE_ORDER.map((t) => ({ value: t, label: C.types[t] }))}
          onChange={(t, trigger) => void changeType(t, trigger)}
        />
        <Icon name={TYPE_ICON[prop.type]} size={14} />
      </label>
      {prop.type === 'unique_id' && <PrefixField doc={doc} prop={prop} />}
      {isComputedProp(prop) && prop.type !== 'relation' && prop.type !== 'rollup' && prop.type !== 'formula' && <div className="cl-hint">{C.prop.readonlyType}</div>}
      {prop.type === 'relation' && <RelationSettings prop={prop} schema={schema} />}
      {prop.type === 'rollup' && <RollupSettings doc={doc} schema={schema} prop={prop} />}
      {prop.type === 'formula' && <FormulaField doc={doc} schema={schema} prop={prop} view={view} />}
      {error && <div className="cl-hint is-error">{error}</div>}
      {retarget && ctx && (
        <CollectionChooser
          anchor={retarget}
          collections={relatableCollections(pages, ctx.spaceId)}
          title={R.pickTarget}
          empty={R.noTargets}
          onClose={closeRetarget}
          onPick={(page) => {
            closeRetarget()
            call(() => collectionApi.patchRelation(ctx.cid, prop.id, { target: page.id }), () => setError(null))
          }}
        />
      )}
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
      <button type="button" className="pop-row is-danger" onClick={remove}>
        <Icon name="trash" size={14} />
        {C.prop.remove}
      </button>
    </div>
  )
}
