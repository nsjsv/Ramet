// ---------- 日历 / 时间线的日期属性：还没选时的空状态、视图设置里的「按哪个日期属性」 ----------
// 可选的是日期、创建时间、编辑时间（dateChoices）；一个都没有就给「新建日期属性」（建好直接选上）。
// 选择写集合文档（所有成员同一份，同筛选排序）；viewer 只看说明。
import type * as Y from 'yjs'
import type { CollectionSchema, CollectionView } from '@ramet/shared/collection-model'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { LAYOUT_ICON } from './layouts'
import { TYPE_ICON } from './prop-meta'
import { addProp, dateChoices, setDateBy } from './schema-ops'

const C = COPY.collection

type Props = { doc: Y.Doc; schema: CollectionSchema; view: CollectionView }

/** 新建一个日期属性并让这个视图按它排 */
function createDateProp(doc: Y.Doc, viewId: string): void {
  setDateBy(doc, viewId, addProp(doc, C.types.date, 'date'))
}

/** 视图还没有（可用的）日期属性：说明 + 可选的属性 / 新建入口 */
export function DateSetup({ doc, schema, view, readOnly }: Props & { readOnly: boolean }) {
  const choices = dateChoices(schema)
  return (
    <div className="cl-board-setup">
      <div className="cl-board-setup-head">
        <Icon name={LAYOUT_ICON[view.layout]} size={16} />
        <span>{choices.length > 0 ? C.date.needDate : C.date.noDateProp}</span>
      </div>
      {!readOnly && choices.length > 0 && (
        <div className="cl-board-choices">
          <span>{C.date.pick}</span>
          {choices.map((prop) => (
            <button key={prop.id} type="button" className="cl-bar-btn" onClick={() => setDateBy(doc, view.id, prop.id)}>
              <Icon name={TYPE_ICON[prop.type]} size={14} />
              {prop.name || C.types[prop.type]}
            </button>
          ))}
        </div>
      )}
      {!readOnly && choices.length === 0 && (
        <div className="cl-board-choices">
          <button type="button" className="cl-bar-btn" onClick={() => createDateProp(doc, view.id)}>
            <Icon name="plus" size={14} />
            {C.date.create}
          </button>
        </div>
      )}
    </div>
  )
}

/** 视图设置弹层里（接在「布局」后面）：按哪个日期属性排 */
export function DateSettings({ doc, schema, view }: Props) {
  const choices = dateChoices(schema)
  return (
    <>
      <div className="pop-section">{C.date.dateBy}</div>
      {choices.map((p) => (
        <button key={p.id} type="button" className="pop-row" onClick={() => setDateBy(doc, view.id, p.id)}>
          <Icon name={TYPE_ICON[p.type]} size={14} />
          {p.name || C.types[p.type]}
          {view.dateBy === p.id && <Icon name="check" size={14} className="cl-picker-check" />}
        </button>
      ))}
      {choices.length === 0 && (
        <button type="button" className="pop-row" onClick={() => createDateProp(doc, view.id)}>
          <Icon name="plus" size={14} />
          {C.date.create}
        </button>
      )}
    </>
  )
}
