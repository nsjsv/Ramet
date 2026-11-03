// ---------- 关联的行选择器：候选 = 对方集合的行（页面列表里取），按标题搜，已选的在前 ----------
// 点一行 = 切换（「只能关联一行」时换成它、选完即关）；搜不到可以就地在对方集合里新建同名行再选上。
// 报给调用方的是这一格的整份新值（同别的选择器）：反向关联由 store 按现在的值换算成增删发给服务端（relation-write.ts）。
// pickOne = 筛选条件的比较值：只选一行、选完即关、不能新建。
import { useState } from 'react'
import { idList, isReverseRelation, LIST_MAX, type CollectionProp, type PropValue } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { PageIcon } from '../../PageIcon'
import { collectionApi } from '../collection-api'
import { useCollectionPages } from '../collection-store'
import { useRelationBroken } from '../relation-ctx'
import { relationCandidates, toggleLink } from '../relation-model'
import { PickerList, type Item } from './Pickers'

const R = COPY.collection.relation

/** 一次画多少个候选：集合按 5,000 行设计，全画出来太重，其余靠搜 */
const PICKER_LIMIT = 50

type Props = {
  prop: CollectionProp
  value: PropValue | undefined
  onChange: (value: PropValue | null) => void
  onDone: () => void
  seed?: string
  /** 筛选条件的比较值：只选一行、选完即关、不能新建 */
  pickOne?: boolean
}

export function RelationPicker({ prop, value, onChange, onDone, seed = '', pickOne = false }: Props) {
  const pages = useCollectionPages()
  const [query, setQuery] = useState(seed)
  const [creating, setCreating] = useState(false)
  const broken = useRelationBroken(prop)
  // 已失效（对方集合挪去了别的空间等）：服务端只许清空，列出对方的行只会让人选了再被拒
  const target = broken ? undefined : prop.cfg.target
  const selected = idList(value) ?? []
  const single = pickOne || prop.cfg.single === true
  const { items, more } = relationCandidates(pages, target, selected, query, PICKER_LIMIT)
  const pick = (id: string): void => {
    const next = toggleLink(selected, id, single)
    onChange(next.length > 0 ? next : null)
    if (single) onDone()
  }
  const rows: Item[] = items.map(({ page, on }) => ({
    key: page.id,
    on,
    render: () => (
      <span className="cl-rel">
        <PageIcon icon={page.icon} placeholder />
        <span className="cl-rel-name">{page.title || COPY.untitled}</span>
      </span>
    ),
    pick: () => pick(page.id),
  }))
  const name = query.trim()
  const exact = items.some(({ page }) => page.title === name)
  // 新建的行先经 REST 建好（服务端只认对方集合的活行），再按普通的选中写进去
  const create =
    !pickOne && target && name && !exact && !creating
      ? () => {
          setCreating(true)
          collectionApi.createRow(target, { title: name }).then(
            (row) => {
              setCreating(false)
              setQuery('')
              pick(row.id)
            },
            (err: unknown) => {
              setCreating(false)
              console.error(err)
            },
          )
        }
      : null
  // 反向值可以有几千行：一次清空超出单次增删的上限时不给清空的入口，逐个去掉
  const clearable = selected.length > 0 && !pickOne && !(isReverseRelation(prop) && selected.length > LIST_MAX)
  return (
    <>
      <PickerList
        query={query}
        setQuery={setQuery}
        placeholder={R.search}
        sections={[{ items: rows }]}
        onEnterNew={create}
        onClear={
          clearable
            ? () => {
                onChange(null)
                onDone()
              }
            : undefined
        }
      />
      {more > 0 && <div className="cl-picker-empty">{R.more(more)}</div>}
      {rows.length === 0 && !create && <div className="cl-picker-empty">{broken ? R.broken : name ? R.noMatch : R.empty}</div>}
    </>
  )
}
