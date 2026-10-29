// ---------- 行页面版本预览里的属性区：那个版本的属性值（只读），与当前不同的标出来 ----------
// 按当前属性定义列（顺序同行页面属性区），值用 CellView 只读展示。
// 那个版本读不出值且与当前相同的属性不画；那个版本是空、现在有值的画一个「空」（恢复会清掉它，要看得见）。
import type * as Y from 'yjs'
import { readValue, type CollectionRow } from '@ramet/shared/collection-model'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { CellView } from './cells/CellView'
import { useCollection, useCollectionSchema } from './collection-store'
import { isComputed, TYPE_ICON } from './prop-meta'
import { useRowProps } from './RowProperties'

const C = COPY.collection
const H = C.history

type Props = {
  collectionId: string
  spaceId: string | null
  /** 那个版本的 props（快照里 Y.Map('props') 的 JSON） */
  props: Record<string, unknown>
  /** 这一行当前的文档 */
  getDoc: () => Y.Doc | undefined
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const own = (record: Record<string, unknown>, key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined)

export default function SnapshotProps({ collectionId, spaceId, props, getDoc }: Props) {
  const schema = useCollectionSchema(useCollection(collectionId))
  const current = useRowProps(getDoc())
  if (!schema) return null
  // CellView 要的「行」：只有 props 有意义（创建 / 编辑时间是现算的，这里不画）
  const row: CollectionRow = { id: '', title: '', icon: null, props, position: null, created_at: '', edited_at: '', has_body: false }
  const items = schema.props.flatMap((prop) => {
    if (isComputed(prop.type)) return []
    const then = own(props, prop.id)
    const now = own(current, prop.id)
    const differs = !same(then, now)
    // 读不出值：原本就空 =「空」；有原值但按当前类型解读不了 =「已失效的值」（恢复照样写回原值）
    const blank = readValue(prop, then) === undefined ? (then === undefined || then === null ? H.empty : H.invalid) : null
    return blank !== null && !differs ? [] : [{ prop, blank, differs }]
  })
  if (items.length === 0) return null
  return (
    <div className="vh-props" aria-label={H.snapshotProps}>
      {items.map(({ prop, blank, differs }) => (
        <div key={prop.id} className={'vh-prop' + (differs ? ' is-diff' : '')}>
          <span className="vh-prop-name" title={prop.name || C.types[prop.type]}>
            <Icon name={TYPE_ICON[prop.type]} size={14} />
            <span>{prop.name || C.types[prop.type]}</span>
          </span>
          <span className="vh-prop-value">
            {blank !== null ? <span className="cl-text is-dim">{blank}</span> : <CellView prop={prop} row={row} spaceId={spaceId} />}
          </span>
          {differs && <span className="vh-prop-diff" title={H.differs} aria-label={H.differs} />}
        </div>
      ))}
    </div>
  )
}
