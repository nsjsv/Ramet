/* ---------- 筛选菜单：多个条件同时满足（没有「或」条件组） ----------
 * 条件的形状与一个属性能用的运算见 @ramet/shared/collection-model（filterOps / opNeedsValue；汇总、公式按输出类型给运算）；
 * 值没填完的条件照样存着（界面要能接着编辑），只是不参与筛选。文字类的值失焦 / Enter 才写。
 * 关联的比较值是对方集合的一行：用行选择器的单选形态选。 */
import { useEffect, useState } from 'react'
import type * as Y from 'yjs'
import {
  filterOps,
  findProp,
  idList,
  opNeedsValue,
  rollupOutput,
  STATUS_GROUPS,
  TITLE_PROP,
  type CollectionProp,
  type CollectionSchema,
  type CollectionView,
  type Condition,
  type FilterOp,
} from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { Icon } from '../../icons'
import { spaceMembers } from '../../people'
import { usePeopleTick } from '../cells/CellView'
import { RelationChip } from '../cells/RelationCell'
import { RelationPicker } from '../cells/RelationPicker'
import { useCollectionPages } from '../collection-store'
import { Popover, usePopover } from '../popover'
import { parseNumberInput } from '../prop-meta'
import { pageIndex } from '../relation-model'
import { setFilter } from '../schema-ops'

const C = COPY.collection

/** 失焦 / Enter 提交的值输入（可以是空：清掉值） */
function CommitInput({ value, kind, onCommit }: { value: string; kind: 'text' | 'number'; onCommit: (text: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const bad = kind === 'number' && parseNumberInput(draft) === undefined
  return (
    <input
      className={'cl-input' + (bad ? ' is-bad' : '')}
      value={draft}
      placeholder={C.filter.value}
      inputMode={kind === 'number' ? 'decimal' : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value && !bad) onCommit(draft)
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur()
      }}
    />
  )
}

function opLabel(prop: CollectionProp, op: FilterOp): string {
  // 数字比大小用符号（文字「等于」与 > < 并列读着别扭）
  const numeric =
    prop.type === 'number' ||
    prop.type === 'unique_id' ||
    (prop.type === 'rollup' && rollupOutput(prop.cfg.fn) === 'number') ||
    (prop.type === 'formula' && prop.output === 'number')
  if (numeric && op === 'eq') return '='
  if (numeric && op === 'neq') return '≠'
  return C.ops[op]
}

/** 关联的比较值：对方集合的一行（显示它的图标与标题，点开单选） */
function RelationValue({ prop, value, onValue }: { prop: CollectionProp; value: string | undefined; onValue: (v: string | undefined) => void }) {
  const pages = useCollectionPages()
  const [anchor, open, close] = usePopover()
  const page = value ? pageIndex(pages).get(value) : undefined
  return (
    <>
      <button type="button" className="cl-input cl-rel-value" onClick={(e) => open(e.currentTarget)}>
        {page ? <RelationChip page={page} /> : <span className="cl-text is-dim">{value ? C.relation.missing : C.filter.pick}</span>}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={close} className="cl-cell-pop">
          <RelationPicker prop={prop} value={value ? [value] : undefined} pickOne onChange={(v) => onValue(idList(v ?? undefined)?.[0])} onDone={close} />
        </Popover>
      )}
    </>
  )
}

function ValueInput({ prop, cond, spaceId, onValue }: { prop: CollectionProp; cond: Condition; spaceId: string | null; onValue: (v: string | number | undefined) => void }) {
  usePeopleTick()
  if (!opNeedsValue(cond.op)) return null
  const raw = cond.value
  const pick = (choices: { id: string; name: string }[]) => (
    <select value={typeof raw === 'string' ? raw : ''} onChange={(e) => onValue(e.target.value || undefined)}>
      <option value="">{C.filter.pick}</option>
      {choices.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  )
  const dateInput = <input className="cl-input" type="date" value={typeof raw === 'string' ? raw : ''} onChange={(e) => onValue(e.target.value || undefined)} />
  const numberInput = (
    <CommitInput
      kind="number"
      value={typeof raw === 'number' ? String(raw) : ''}
      onCommit={(t) => {
        const n = parseNumberInput(t)
        onValue(typeof n === 'number' ? n : undefined)
      }}
    />
  )
  switch (prop.type) {
    case 'select':
    case 'multi_select':
      return pick(prop.options)
    case 'status':
      return cond.op === 'in_group' ? pick(STATUS_GROUPS.map((g) => ({ id: g.id, name: C.statusGroups[g.id] }))) : pick(prop.options)
    // 创建者 / 最后编辑者与人员同形：比的是用户 id
    case 'person':
    case 'created_by':
    case 'edited_by':
      return pick((spaceId ? spaceMembers(spaceId) : null)?.map((m) => ({ id: m.id, name: m.username })) ?? [])
    case 'relation':
      return <RelationValue prop={prop} value={typeof raw === 'string' ? raw : undefined} onValue={onValue} />
    case 'date':
    case 'created_time':
    case 'edited_time':
      return dateInput
    // 自动编号按数字比（不带前缀）
    case 'number':
    case 'unique_id':
      return numberInput
    // 汇总按输出类型：日期输出比一天，数字输出比数（列表输出只有为空 / 不为空，走不到这里）
    case 'rollup':
      return rollupOutput(prop.cfg.fn) === 'date' ? dateInput : numberInput
    // 公式按输出类型：数字比数、日期比一天，文本与列表的「包含」比文字（是否只有勾选 / 未勾选，走不到这里）
    case 'formula':
      if (prop.output === 'number') return numberInput
      if (prop.output === 'date') return dateInput
      break
  }
  return <CommitInput kind="text" value={typeof raw === 'string' ? raw : ''} onCommit={(t) => onValue(t || undefined)} />
}

export function FilterMenu({ doc, schema, view, spaceId }: { doc: Y.Doc; schema: CollectionSchema; view: CollectionView; spaceId: string | null }) {
  const props = [TITLE_PROP, ...schema.props]
  const conds = view.filter.all
  const write = (next: Condition[]): void => setFilter(doc, view.id, { all: next })
  const replace = (i: number, cond: Condition): void => write(conds.map((c, j) => (j === i ? cond : c)))
  return (
    <div className="cl-menu cl-filter">
      {conds.length === 0 && <div className="cl-hint">{C.filter.empty}</div>}
      {conds.map((cond, i) => {
        const prop = findProp(schema, cond.prop) ?? TITLE_PROP
        return (
          <div key={i} className="cl-cond">
            <select
              value={prop.id}
              onChange={(e) => {
                const next = findProp(schema, e.target.value) ?? TITLE_PROP
                replace(i, { prop: next.id, op: filterOps(next)[0] ?? 'empty' })
              }}
            >
              {props.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || C.types[p.type]}
                </option>
              ))}
            </select>
            <select
              value={cond.op}
              onChange={(e) => {
                const op = e.target.value as FilterOp
                // 换运算时值的形状可能变（状态的「属于组」比的是组）：不合用的交给 parseCollection 当没填
                replace(i, cond.value === undefined || op === 'in_group' || cond.op === 'in_group' ? { prop: prop.id, op } : { ...cond, op })
              }}
            >
              {filterOps(prop).map((op) => (
                <option key={op} value={op}>
                  {opLabel(prop, op)}
                </option>
              ))}
            </select>
            <ValueInput
              prop={prop}
              cond={cond}
              spaceId={spaceId}
              onValue={(value) => replace(i, value === undefined ? { prop: cond.prop, op: cond.op } : { ...cond, value })}
            />
            <button type="button" className="icon-btn" title={C.filter.remove} onClick={() => write(conds.filter((_, j) => j !== i))}>
              <Icon name="x" size={14} />
            </button>
          </div>
        )
      })}
      <button type="button" className="pop-row cl-add" onClick={() => write([...conds, { prop: TITLE_PROP.id, op: 'contains' }])}>
        <Icon name="plus" size={14} />
        {C.filter.add}
      </button>
    </div>
  )
}
