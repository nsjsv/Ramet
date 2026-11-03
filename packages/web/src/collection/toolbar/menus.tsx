/* ---------- 排序 / 分组 / 显示属性三个菜单，新建属性菜单 ----------
 * 排序是多级（拖动调先后）；有排序时表格不能拖行（手动顺序只在没有排序时生效）。
 * 分组只认状态与单选。显示属性：拖动调列顺序、眼睛开关显示、点名字编辑属性定义、新建属性。
 * 都写这个视图在集合文档里的设置（所有成员看到同一份）。
 * 新建关联先选目标集合、经服务端建（relation-settings.tsx 的 RelationCreate），不先建一个没有目标的关联；
 * 新建公式同理，在编辑弹窗里写好保存才建，取消不留下一个空公式（也不在集合页的版本历史里留一加一删）。 */
import { useMemo, useState } from 'react'
import type * as Y from 'yjs'
import { findProp, sortable, TITLE_PROP, type CollectionProp, type CollectionSchema, type CollectionView, type PropType, type Sort } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { Icon } from '../../icons'
import { FormulaEditor } from '../FormulaEditor'
import PropEditor from '../PropEditor'
import { moveTo, TITLE_ICON, TYPE_ICON, TYPE_ORDER } from '../prop-meta'
import { RelationCreate } from '../relation-settings'
import { useReorder } from '../reorder'
import { addProp, groupChoices, newPropId, setGroupBy, setShown, setSorts, shownProps, toggleShown } from '../schema-ops'

const C = COPY.collection

type MenuProps = { doc: Y.Doc; schema: CollectionSchema; view: CollectionView }

export function SortMenu({ doc, schema, view }: MenuProps) {
  // 排不了的（关联、列表输出的汇总）不列：写进去解析时也会被丢掉
  const props = [TITLE_PROP, ...schema.props].filter(sortable)
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

/** 新属性在这个视图里显示（显式列表时追加；属性定义还没同步到也先记下，解析时认出来就显示） */
function showNew(doc: Y.Doc, schema: CollectionSchema, view: CollectionView, id: string): void {
  if (view.shown !== null) setShown(doc, view.id, [...shownProps(schema, view), id])
}

/** 新建属性：选类型 → 建好（名字 = 类型名）；在这个视图里显示，返回新属性 id。init 见 schema-ops 的 addProp */
export function createProp(doc: Y.Doc, schema: CollectionSchema, view: CollectionView, type: PropType, init?: Parameters<typeof addProp>[3]): string {
  const id = addProp(doc, C.types[type], type, init)
  showNew(doc, schema, view, id)
  return id
}

/** 还没建的公式属性（只在编辑器里）：放进一份临时定义，补全、校验、预览都按它 */
function draftFormula(doc: Y.Doc, schema: CollectionSchema): CollectionProp {
  const pos = schema.props.reduce((max, p) => Math.max(max, p.pos), -1) + 1
  return { id: newPropId(doc), name: C.types.formula, type: 'formula', pos, options: [], cfg: { expr: '' } }
}

/** 新建属性菜单：选类型即建；「关联」先选目标集合、定好开关再经服务端建（中途返回 / 关掉不留下任何属性）；
 *  「公式」先打开公式编辑弹窗（空公式没什么可看的），「保存」才连同表达式建出属性，取消 / Esc 回到类型列表、什么都不留 */
/** 建出来还不能用、必须先在设置里选好的类型：建完直接打开它的设置 */
const NEEDS_SETUP: ReadonlySet<PropType> = new Set(['rollup'])

/** onCreated 的 setup = 这个属性建完还要设置（调用方应打开它的属性设置，而不是关掉菜单） */
export function NewPropMenu({ doc, schema, view, onCreated }: MenuProps & { onCreated: (id: string, setup: boolean) => void }) {
  const [relation, setRelation] = useState(false)
  const [formula, setFormula] = useState<CollectionProp | null>(null)
  const draft = useMemo(() => (formula ? { ...schema, props: [...schema.props, formula] } : null), [schema, formula])
  if (formula && draft) {
    return (
      <>
        <TypeList onPick={() => undefined} />
        <FormulaEditor
          doc={doc}
          schema={draft}
          prop={formula}
          view={view}
          onSave={(expr) => onCreated(createProp(doc, schema, view, 'formula', { id: formula.id, cfg: { expr } }), false)}
          onClose={() => setFormula(null)}
        />
      </>
    )
  }
  if (relation) {
    return (
      <RelationCreate
        onBack={() => setRelation(false)}
        onCreated={(id) => {
          showNew(doc, schema, view, id)
          onCreated(id, false)
        }}
      />
    )
  }
  return (
    <TypeList
      onPick={(type) => {
        if (type === 'relation') setRelation(true)
        else if (type === 'formula') setFormula(draftFormula(doc, schema))
        else onCreated(createProp(doc, schema, view, type), NEEDS_SETUP.has(type))
      }}
    />
  )
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
  if (page === 'types') return <NewPropMenu doc={doc} schema={schema} view={view} onCreated={(id) => setPage(id)} />
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
