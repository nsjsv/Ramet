// ---------- 单元格的展示（表格、看板卡片与行页面属性区共用） ----------
// 读值一律经 rowValue（→ readValue）：类型对不上、选项已删的读成空，原值不动。
// 链接类（链接、邮箱、电话、文件）点了不进编辑：表格 / 卡片的点击判定见到 a / button 就放过。
import { useEffect, useState } from 'react'
import {
  fileList,
  findOption,
  formatNumber,
  idList,
  rowValue,
  type CollectionOption,
  type CollectionProp,
  type CollectionRow,
} from '@ramet/shared/collection-model'
import { Avatar } from '../../Avatar'
import { Icon } from '../../icons'
import { personOf, subscribePeople } from '../../people'
import { agentLabel } from '../../default-agent'
import { formatDate, formatStamp, hrefOf } from '../prop-meta'
import { FileItem } from './file-item'
import { ButtonCell } from './ButtonCell'
import { FormulaCell } from './FormulaCell'
import { RelationCell } from './RelationCell'
import { RollupCell } from './RollupCell'

/** 选项的小色块（颜色 = 选项色；状态多一个圆点） */
export function OptionChip({ option, status = false }: { option: CollectionOption; status?: boolean }) {
  return (
    <span className={'cl-opt' + (status ? ' is-status' : '')} data-color={option.color} data-tip={option.name}>
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
    <span className="cl-person" data-tip={person?.username ?? userId}>
      <Avatar person={person} size={18} />
      <span className="cl-person-name">{person?.username ?? '…'}</span>
    </span>
  )
}

type Props = { prop: CollectionProp; row: CollectionRow; spaceId: string | null }

const stop = (e: React.MouseEvent): void => e.stopPropagation()

/** 邮箱 / 电话：mailto: / tel: 链接（电话去掉空白，拨号程序不认） */
function contactHref(prop: CollectionProp, value: string): string {
  return prop.type === 'email' ? `mailto:${value}` : `tel:${value.replace(/\s+/g, '')}`
}

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
    case 'multi_select': {
      const ids = idList(value)
      return ids ? (
        <span className="cl-chips">
          {ids.map((id) => {
            const option = findOption(prop, id)
            return option ? <OptionChip key={id} option={option} /> : null
          })}
        </span>
      ) : null
    }
    case 'person':
    case 'created_by': {
      const ids = idList(value)
      return ids ? <PersonList spaceId={spaceId} ids={ids} /> : null
    }
    case 'edited_by': {
      const ids = idList(value)
      if (!ids) return null
      // agent 改的：agent 名在前，后面是让它改的人
      return row.edited_agent ? (
        <span className="cl-chips">
          <span className="cl-agent" data-tip={agentLabel(row.edited_agent)}>
            <Icon name="bot" size={14} />
            <span className="cl-person-name">{agentLabel(row.edited_agent)}</span>
          </span>
          <PersonList spaceId={spaceId} ids={ids} />
        </span>
      ) : (
        <PersonList spaceId={spaceId} ids={ids} />
      )
    }
    case 'email':
    case 'phone':
      return typeof value === 'string' ? (
        <a className="cl-link" href={contactHref(prop, value)} onClick={stop}>
          {value}
        </a>
      ) : null
    case 'files': {
      const files = fileList(value)
      return files ? (
        <span className="cl-files">
          {files.map((file) => (
            <FileItem key={file.id} file={file} />
          ))}
        </span>
      ) : null
    }
    case 'unique_id':
      return typeof value === 'number' ? <span className="cl-text">{formatNumber(prop, value)}</span> : null
    case 'date':
      return typeof value === 'string' ? <span className="cl-text">{formatDate(value)}</span> : null
    case 'url': {
      if (typeof value !== 'string') return null
      const href = hrefOf(value)
      return href ? (
        <a className="cl-link" href={href} target="_blank" rel="noopener noreferrer" onClick={stop}>
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
    case 'relation':
      return <RelationCell prop={prop} row={row} />
    case 'rollup':
      return <RollupCell prop={prop} row={row} spaceId={spaceId} />
    case 'formula':
      return <FormulaCell prop={prop} row={row} />
    case 'button':
      return <ButtonCell prop={prop} row={row} />
    default:
      return typeof value === 'string' ? <span className="cl-text">{value}</span> : null
  }
}
