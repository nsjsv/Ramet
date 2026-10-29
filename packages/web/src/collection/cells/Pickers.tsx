// ---------- 选项 / 人员选择器（单元格编辑弹层的内容；行页面属性区共用） ----------
// 单选、状态：点一下即选中并关闭；多选、人员：点一下切换、弹层留着。输入框筛选，↑↓ 移动，Enter 选中。
// 选项选择器里打一个没有的名字按 Enter = 新建选项并选中（写集合文档，viewer 没有这个入口）。
import { useEffect, useMemo, useRef, useState } from 'react'
import type * as Y from 'yjs'
import { STATUS_GROUPS, type CollectionOption, type CollectionProp, type PropValue } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { Avatar } from '../../Avatar'
import { Icon } from '../../icons'
import { spaceMembers, type Person } from '../../people'
import { nextColor } from '../prop-meta'
import { addOption } from '../schema-ops'
import { OptionChip, usePeopleTick } from './CellView'

const C = COPY.collection.cell

type Item = { key: string; render: () => React.ReactNode; pick: () => void; on: boolean }

/** 选择器的公共骨架：筛选框 + 列表（可分节）+ 键位 */
function PickerList({
  query,
  setQuery,
  placeholder,
  sections,
  onEnterNew,
  head,
  onClear,
  onPaste,
}: {
  query: string
  setQuery: (q: string) => void
  placeholder: string
  sections: { title?: string; items: Item[] }[]
  /** 没有完全匹配的项时 Enter 做什么（新建选项）；null = 不能新建 */
  onEnterNew: (() => void) | null
  head?: React.ReactNode
  onClear?: () => void
  onPaste?: (text: string) => boolean
}) {
  const flat = sections.flatMap((s) => s.items)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => setActive(0), [query])
  useEffect(() => input.current?.focus(), [])
  return (
    <div className="cl-picker">
      {head}
      <input
        ref={input}
        className="cl-picker-q"
        value={query}
        placeholder={placeholder}
        onChange={(e) => setQuery(e.target.value)}
        onPaste={(e) => {
          if (query === '' && onPaste?.(e.clipboardData.getData('text/plain'))) e.preventDefault()
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.nativeEvent.isComposing) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const n = flat.length + (onEnterNew ? 1 : 0)
            if (n) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            if (active < flat.length) flat[active]?.pick()
            else onEnterNew?.()
          }
        }}
      />
      <div className="cl-picker-list">
        {sections.map((s, si) => (
          <div key={si}>
            {s.title && s.items.length > 0 && <div className="pop-section">{s.title}</div>}
            {s.items.map((item) => {
              const i = flat.indexOf(item)
              return (
                <button
                  key={item.key}
                  type="button"
                  className={'pop-row cl-picker-row' + (i === active ? ' is-active' : '')}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={item.pick}
                >
                  {item.render()}
                  {item.on && <Icon name="check" size={14} className="cl-picker-check" />}
                </button>
              )
            })}
          </div>
        ))}
        {onEnterNew && (
          <button
            type="button"
            className={'pop-row cl-picker-row' + (active === flat.length ? ' is-active' : '')}
            onMouseEnter={() => setActive(flat.length)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onEnterNew}
          >
            <Icon name="plus" size={14} />
            {C.create(query.trim())}
          </button>
        )}
      </div>
      {onClear && (
        <button type="button" className="pop-row cl-picker-clear" onMouseDown={(e) => e.preventDefault()} onClick={onClear}>
          {C.clear}
        </button>
      )}
    </div>
  )
}

const has = (text: string, q: string): boolean => !q || text.toLowerCase().includes(q.toLowerCase())

export function OptionPicker({
  prop,
  value,
  doc,
  onChange,
  onDone,
  seed = '',
  onPaste,
}: {
  prop: CollectionProp
  value: PropValue | undefined
  /** 集合文档：给了才能新建选项 */
  doc: Y.Doc | null
  onChange: (value: PropValue | null) => void
  onDone: () => void
  /** 筛选框的起始文字（表格里选中格子直接打字进来的那个字） */
  seed?: string
  /** 筛选框是空的时候粘贴：交给调用方当「往格子里粘贴」；返回 true = 已处理（不进筛选框） */
  onPaste?: (text: string) => boolean
}) {
  const [query, setQuery] = useState(seed)
  const multi = prop.type === 'multi_select'
  const selected = useMemo(() => new Set(Array.isArray(value) ? value : typeof value === 'string' ? [value] : []), [value])
  const pick = (option: CollectionOption): void => {
    if (!multi) {
      onChange(option.id)
      onDone()
      return
    }
    const next = selected.has(option.id) ? [...selected].filter((id) => id !== option.id) : [...selected, option.id]
    onChange(next.length ? next : null)
  }
  const item = (option: CollectionOption): Item => ({
    key: option.id,
    on: selected.has(option.id),
    render: () => <OptionChip option={option} status={prop.type === 'status'} />,
    pick: () => pick(option),
  })
  const matched = prop.options.filter((o) => has(o.name, query.trim()))
  const sections =
    prop.type === 'status'
      ? STATUS_GROUPS.map((g) => ({ title: COPY.collection.statusGroups[g.id], items: matched.filter((o) => o.group === g.id).map(item) }))
      : [{ items: matched.map(item) }]
  const name = query.trim()
  const exact = prop.options.some((o) => o.name === name)
  const create =
    doc && name && !exact
      ? () => {
          const id = addOption(doc, prop.id, name, nextColor(prop.options.map((o) => o.color)))
          setQuery('')
          if (!id) return
          if (!multi) {
            onChange(id)
            onDone()
          } else onChange([...selected, id])
        }
      : null
  const head =
    multi && selected.size > 0 ? (
      <div className="cl-picker-head">
        {prop.options
          .filter((o) => selected.has(o.id))
          .map((o) => (
            <OptionChip key={o.id} option={o} />
          ))}
      </div>
    ) : null
  return (
    <PickerList
      query={query}
      setQuery={setQuery}
      placeholder={C.search}
      sections={sections}
      onEnterNew={create}
      onPaste={onPaste}
      head={head}
      onClear={
        selected.size > 0
          ? () => {
              onChange(null)
              onDone()
            }
          : undefined
      }
    />
  )
}

export function PersonPicker({
  value,
  spaceId,
  onChange,
  seed = '',
  onPaste,
}: {
  value: PropValue | undefined
  spaceId: string | null
  onChange: (value: PropValue | null) => void
  seed?: string
  onPaste?: (text: string) => boolean
}) {
  usePeopleTick()
  const [query, setQuery] = useState(seed)
  const selected = new Set(Array.isArray(value) ? value : [])
  // 候选 = 空间成员（服务端只认成员；agent 不是成员，不在候选里）
  const members: Person[] = (spaceId ? spaceMembers(spaceId) : null) ?? []
  const items: Item[] = members
    .filter((m) => has(m.username, query.trim()))
    .map((m) => ({
      key: m.id,
      on: selected.has(m.id),
      render: () => (
        <span className="cl-person">
          <Avatar person={m} size={18} />
          <span className="cl-person-name">{m.username}</span>
        </span>
      ),
      pick: () => {
        const next = selected.has(m.id) ? [...selected].filter((id) => id !== m.id) : [...selected, m.id]
        onChange(next.length ? next : null)
      },
    }))
  return (
    <>
      <PickerList
        query={query}
        setQuery={setQuery}
        placeholder={C.searchPeople}
        sections={[{ items }]}
        onEnterNew={null}
        onPaste={onPaste}
        onClear={selected.size > 0 ? () => onChange(null) : undefined}
      />
      {members.length === 0 && <div className="cl-picker-empty">{C.noMembers}</div>}
    </>
  )
}
