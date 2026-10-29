/* ---------- 筛选菜单：多个条件同时满足（没有「或」条件组） ----------
 * 条件的形状与各类型可用的运算见 @ramet/shared/collection-model（FILTER_OPS / opNeedsValue）；
 * 值没填完的条件照样存着（界面要能接着编辑），只是不参与筛选。文字类的值失焦 / Enter 才写。 */
import { useEffect, useState } from 'react'
import type * as Y from 'yjs'
import {
  FILTER_OPS,
  findProp,
  opNeedsValue,
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
import { parseNumberInput } from '../prop-meta'
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
  if (prop.type === 'number' && op === 'eq') return '='
  if (prop.type === 'number' && op === 'neq') return '≠'
  return C.ops[op]
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
  switch (prop.type) {
    case 'select':
    case 'multi_select':
      return pick(prop.options)
    case 'status':
      return cond.op === 'in_group' ? pick(STATUS_GROUPS.map((g) => ({ id: g.id, name: C.statusGroups[g.id] }))) : pick(prop.options)
    case 'person':
      return pick((spaceId ? spaceMembers(spaceId) : null)?.map((m) => ({ id: m.id, name: m.username })) ?? [])
    case 'date':
    case 'created_time':
    case 'edited_time':
      return <input className="cl-input" type="date" value={typeof raw === 'string' ? raw : ''} onChange={(e) => onValue(e.target.value || undefined)} />
    case 'number':
      return (
        <CommitInput
          kind="number"
          value={typeof raw === 'number' ? String(raw) : ''}
          onCommit={(t) => {
            const n = parseNumberInput(t)
            onValue(typeof n === 'number' ? n : undefined)
          }}
        />
      )
    default:
      return <CommitInput kind="text" value={typeof raw === 'string' ? raw : ''} onCommit={(t) => onValue(t || undefined)} />
  }
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
                replace(i, { prop: next.id, op: FILTER_OPS[next.type][0] ?? 'empty' })
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
              {FILTER_OPS[prop.type].map((op) => (
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
