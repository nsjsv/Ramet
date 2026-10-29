// ---------- 单元格的展示（表格、看板卡片与行页面属性区共用） ----------
// 读值一律经 rowValue（→ readValue）：类型对不上、选项已删的读成空，原值不动。
import { useEffect, useState } from 'react'
import { findOption, rowValue, type CollectionOption, type CollectionProp, type CollectionRow } from '@ramet/shared/collection-model'
import { Avatar } from '../../Avatar'
import { personOf, subscribePeople } from '../../people'
import { formatStamp, hrefOf } from '../prop-meta'

/** 选项的小色块（颜色 = 选项色；状态多一个圆点） */
export function OptionChip({ option, status = false }: { option: CollectionOption; status?: boolean }) {
  return (
    <span className={'cl-opt' + (status ? ' is-status' : '')} data-color={option.color} title={option.name}>
      {status && <i className="cl-opt-dot" aria-hidden="true" />}
      <span className="cl-opt-name">{option.name || ' '}</span>
    </span>
  )
}

/** 成员名单到了要重画（people.ts 先回 null、取到再通知） */
export function usePeopleTick(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => subscribePeople(() => setTick((t) => t + 1)), [])
  return tick
}

/** 人员列表（只有人员格订阅成员名单，别的格不因成员取到而重画） */
export function PersonList({ spaceId, ids }: { spaceId: string | null; ids: readonly string[] }) {
  usePeopleTick()
  return (
    <span className="cl-chips">
      {ids.map((id) => (
        <PersonChip key={id} spaceId={spaceId} userId={id} />
      ))}
    </span>
  )
}

function PersonChip({ spaceId, userId }: { spaceId: string | null; userId: string }) {
  const person = personOf(spaceId, userId)
  return (
    <span className="cl-person" title={person?.username ?? userId}>
      <Avatar person={person} size={18} />
      <span className="cl-person-name">{person?.username ?? '…'}</span>
    </span>
  )
}

type Props = { prop: CollectionProp; row: CollectionRow; spaceId: string | null }

export function CellView({ prop, row, spaceId }: Props) {
  const value = rowValue(row, prop)
  switch (prop.type) {
    case 'checkbox':
      return (
        <span className={'check-box' + (value === true ? ' is-on' : '')} aria-checked={value === true} role="checkbox" />
      )
    case 'select':
    case 'status': {
      const option = typeof value === 'string' ? findOption(prop, value) : undefined
      return option ? <OptionChip option={option} status={prop.type === 'status'} /> : null
    }
    case 'multi_select':
      return Array.isArray(value) ? (
        <span className="cl-chips">
          {value.map((id) => {
            const option = findOption(prop, id)
            return option ? <OptionChip key={id} option={option} /> : null
          })}
        </span>
      ) : null
    case 'person':
      return Array.isArray(value) ? <PersonList spaceId={spaceId} ids={value} /> : null
    case 'url': {
      if (typeof value !== 'string') return null
      const href = hrefOf(value)
      return href ? (
        <a className="cl-link" href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          {value}
        </a>
      ) : (
        <span className="cl-text">{value}</span>
      )
    }
    case 'created_time':
    case 'edited_time':
      return typeof value === 'string' ? <span className="cl-text is-dim">{formatStamp(value)}</span> : null
    case 'number':
      return typeof value === 'number' ? <span className="cl-text is-num">{String(value)}</span> : null
    default:
      return typeof value === 'string' ? <span className="cl-text">{value}</span> : null
  }
}
