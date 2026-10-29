/* ---------- 排序 / 分组 / 显示属性三个菜单 ----------
 * 排序是多级（拖动调先后）；有排序时表格不能拖行（手动顺序只在没有排序时生效）。
 * 分组只认状态与单选。显示属性：拖动调列顺序、眼睛开关显示、点名字编辑属性定义、新建属性。
 * 都写这个视图在集合文档里的设置（所有成员看到同一份）。 */
import { useState } from 'react'
import type * as Y from 'yjs'
import { findProp, TITLE_PROP, type CollectionSchema, type CollectionView, type PropType, type Sort } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { Icon } from '../../icons'
import PropEditor from '../PropEditor'
import { moveTo, TITLE_ICON, TYPE_ICON, TYPE_ORDER } from '../prop-meta'
import { useReorder } from '../reorder'
import { addProp, groupChoices, setGroupBy, setShown, setSorts, shownProps, toggleShown } from '../schema-ops'

const C = COPY.collection

type MenuProps = { doc: Y.Doc; schema: CollectionSchema; view: CollectionView }

export function SortMenu({ doc, schema, view }: MenuProps) {
  const props = [TITLE_PROP, ...schema.props]
  const sorts = view.sorts
  const write = (next: Sort[]): void => setSorts(doc, view.id, next)
  const drag = useReorder(
    sorts.map((s) => s.prop),
    (id, index) => {
      const sort = sorts.find((s) => s.prop === id)
      if (sort) write(moveTo(sorts, sort, index))
    },
  )
  const unused = props.find((p) => !sorts.some((s) => s.prop === p.id))
  return (
    <div className="cl-menu cl-sorts">
      {sorts.length === 0 && <div className="cl-hint">{C.sort.empty}</div>}
      {sorts.map((sort, i) => (
        <div key={sort.prop} className="cl-cond" {...drag(sort.prop)}>
          <span className="cl-grip" aria-hidden="true">
            <Icon name="handle" size={10} />
          </span>
          <select value={sort.prop} onChange={(e) => write(sorts.map((s, j) => (j === i ? { ...s, prop: e.target.value } : s)))}>
            {props
              .filter((p) => p.id === sort.prop || !sorts.some((s) => s.prop === p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || C.types[p.type]}
                </option>
              ))}
          </select>
          <select value={sort.dir} onChange={(e) => write(sorts.map((s, j) => (j === i ? { ...s, dir: e.target.value === 'desc' ? 'desc' : 'asc' } : s)))}>
            <option value="asc">{C.sort.asc}</option>
            <option value="desc">{C.sort.desc}</option>
          </select>
          <button type="button" className="icon-btn" title={C.sort.remove} onClick={() => write(sorts.filter((_, j) => j !== i))}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
      {unused && (
        <button type="button" className="pop-row cl-add" onClick={() => write([...sorts, { prop: unused.id, dir: 'asc' }])}>
          <Icon name="plus" size={14} />
          {C.sort.add}
        </button>
      )}
    </div>
  )
}

export function GroupMenu({ doc, schema, view, onDone }: MenuProps & { onDone: () => void }) {
  const choices = groupChoices(schema)
  const pick = (id: string | null): void => {
    setGroupBy(doc, view.id, id)
    onDone()
  }
  return (
    <div className="cl-menu">
      <div className="pop-section">{C.group.hint}</div>
      <button type="button" className="pop-row" onClick={() => pick(null)}>
        {C.group.none}
        {view.groupBy === null && <Icon name="check" size={14} className="cl-picker-check" />}
      </button>
      {choices.map((p) => (
        <button key={p.id} type="button" className="pop-row" onClick={() => pick(p.id)}>
          <Icon name={TYPE_ICON[p.type]} size={14} />
          {p.name || C.types[p.type]}
          {view.groupBy === p.id && <Icon name="check" size={14} className="cl-picker-check" />}
        </button>
      ))}
      {choices.length === 0 && <div className="cl-hint">{C.group.empty}</div>}
    </div>
  )
}

/** 新建属性：选类型 → 建好（名字 = 类型名）；在这个视图里显示（显式列表时追加），返回新属性 id */
export function createProp(doc: Y.Doc, schema: CollectionSchema, view: CollectionView, type: PropType): string {
  const id = addProp(doc, C.types[type], type)
  if (view.shown !== null) setShown(doc, view.id, [...shownProps(schema, view), id])
  return id
}

export function TypeList({ onPick }: { onPick: (type: PropType) => void }) {
  return (
    <div className="cl-menu">
      <div className="pop-section">{C.prop.type}</div>
      {TYPE_ORDER.map((t) => (
        <button key={t} type="button" className="pop-row" onClick={() => onPick(t)}>
          <Icon name={TYPE_ICON[t]} size={14} />
          {C.types[t]}
        </button>
      ))}
    </div>
  )
}

export function PropsMenu({ doc, schema, view }: MenuProps) {
  const [page, setPage] = useState<'list' | 'types' | string>('list')
  const shown = shownProps(schema, view).filter((id) => findProp(schema, id))
  const hidden = schema.props.filter((p) => !shown.includes(p.id))
  const drag = useReorder(shown, (id, index) => setShown(doc, view.id, moveTo(shown, id, index)))
  const editing = page !== 'list' && page !== 'types' ? schema.props.find((p) => p.id === page) : undefined
  if (editing) {
    return (
      <div className="cl-menu">
        <button type="button" className="pop-row cl-back" onClick={() => setPage('list')}>
          <Icon name="chevron" size={12} className="cl-rot-back" />
          {C.props.back}
        </button>
        <PropEditor doc={doc} schema={schema} prop={editing} view={view} onClose={() => setPage('list')} />
      </div>
    )
  }
  if (page === 'types') return <TypeList onPick={(type) => setPage(createProp(doc, schema, view, type))} />
  const row = (id: string, on: boolean) => {
    const prop = findProp(schema, id)
    if (!prop) return null
    return (
      <div key={id} className="cl-prop-row" {...(on ? drag(id) : {})}>
        <span className="cl-grip" aria-hidden="true">
          {on && <Icon name="handle" size={10} />}
        </span>
        <button type="button" className="cl-prop-name" title={C.props.edit} onClick={() => setPage(id)}>
          <Icon name={TYPE_ICON[prop.type]} size={14} />
          <span>{prop.name || C.types[prop.type]}</span>
        </button>
        <button type="button" className="icon-btn" title={on ? C.props.hide : C.props.show} onClick={() => toggleShown(doc, view.id, id, !on)}>
          <Icon name={on ? 'eye' : 'eye-off'} size={14} />
        </button>
      </div>
    )
  }
  return (
    <div className="cl-menu cl-props">
      <div className="pop-section">{C.props.shown}</div>
      <div className="cl-prop-row is-fixed">
        <span className="cl-grip" />
        <span className="cl-prop-name">
          <Icon name={TITLE_ICON} size={14} />
          <span>{C.props.title}</span>
        </span>
      </div>
      {shown.map((id) => row(id, true))}
      {hidden.length > 0 && <div className="pop-section">{C.props.hidden}</div>}
      {hidden.map((p) => row(p.id, false))}
      <button type="button" className="pop-row cl-add" onClick={() => setPage('types')}>
        <Icon name="plus" size={14} />
        {C.props.add}
      </button>
    </div>
  )
}
