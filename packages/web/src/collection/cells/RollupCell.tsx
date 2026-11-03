// ---------- 汇总格：按输出类型显示（数字 / 占比 / 日期 / 目标属性的值逐个显示） ----------
// 值只由服务端算（row.computed，经 rowValue → readRollup 规整）。列表输出要按目标属性的样子画（选项的颜色、成员头像、
// 文件名），目标属性的定义在 refs 里（本集合的客户端没有对方集合的文档）；refs 还没到时按文字画。
import {
  findOption,
  rollupOutput,
  rowValue,
  type CollectionProp,
  type CollectionRow,
  type RollupItem,
} from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { rollupDate, rollupNumber, rollupTarget } from '../relation-model'
import { useRelationCtx } from '../relation-ctx'
import { shownText } from '../value-text'
import { OptionChip, PersonList } from './CellView'
import { FileItem } from './file-item'

const U = COPY.collection.rollup

/** 列表输出的一项：选项画色块、成员画头像、文件画文件名，其余按目标属性的文字口径 */
function Item({ target, item, spaceId }: { target: CollectionProp | null; item: RollupItem; spaceId: string | null }) {
  if (typeof item === 'object') return <FileItem file={item} />
  if (!target) return <span className="cl-text">{String(item)}</span>
  switch (target.type) {
    case 'select':
    case 'status':
    case 'multi_select': {
      const option = typeof item === 'string' ? findOption(target, item) : undefined
      return option ? <OptionChip option={option} status={target.type === 'status'} /> : null
    }
    case 'person':
    case 'created_by':
    case 'edited_by':
      return typeof item === 'string' ? <PersonList spaceId={spaceId} ids={[item]} /> : null
    case 'checkbox':
      return <span className={'check-box' + (item === true ? ' is-on' : '')} aria-checked={item === true} role="checkbox" />
    default:
      return <span className="cl-text">{shownText(target, item, spaceId)}</span>
  }
}

export function RollupCell({ prop, row, spaceId }: { prop: CollectionProp; row: CollectionRow; spaceId: string | null }) {
  const ref = useRelationCtx()?.refs?.[prop.id]
  // 还没选完三项（刚建出来）和配置后失效是两回事：前者只是提示去设置，别说成「失效」
  if (!prop.cfg.relation || !prop.cfg.prop || !prop.cfg.fn) return <span className="cl-text is-dim">{U.unset}</span>
  if (ref?.state === 'broken') return <span className="cl-text is-dim">{U.broken}</span>
  const value = rowValue(row, prop)
  if (value === undefined) return null
  const target = rollupTarget(ref)
  switch (rollupOutput(prop.cfg.fn)) {
    case 'number':
      return typeof value === 'number' ? <span className="cl-text is-num">{rollupNumber(prop.cfg.fn, value, target, U.days)}</span> : null
    case 'date':
      return typeof value === 'string' ? <span className="cl-text">{rollupDate(value)}</span> : null
    case 'list':
      return Array.isArray(value) ? (
        <span className="cl-chips">
          {(value as RollupItem[]).map((item, i) => (
            <Item key={i} target={target} item={item} spaceId={spaceId} />
          ))}
        </span>
      ) : null
  }
}
