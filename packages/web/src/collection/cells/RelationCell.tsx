// ---------- 关联格：对方行的图标 + 标题 chip，点了打开那一行（别的集合的行也按页面 id 直接打开） ----------
// 值经 rowValue（computed 优先，乐观写之后、回声之前退回存储值），标题与图标从页面列表取（relation-model.ts 的 linkedPages）。
// 关联已失效（对方集合不在了、挪到别的空间、反向关联对不上）：灰字「关联已失效」，不画任何行（服务端也不给它们的标题）。
// chip 是按钮：表格 / 卡片的点击判定见到 button 就放过，不会顺手进编辑。
import { idList, rowValue, type CollectionProp, type CollectionRow } from '@ramet/shared/collection-model'
import type { Page } from '../../api'
import { COPY } from '../../copy'
import { PageIcon } from '../../PageIcon'
import { useCollectionPages } from '../collection-store'
import { linkedPages } from '../relation-model'
import { useRelationBroken, useRelationCtx } from '../relation-ctx'

const R = COPY.collection.relation

export function RelationChip({ page, onOpen }: { page: Page; onOpen?: (pageId: string) => void }) {
  const label = page.title || COPY.untitled
  const body = (
    <>
      <PageIcon icon={page.icon} placeholder />
      <span className="cl-rel-name">{label}</span>
    </>
  )
  if (!onOpen) {
    return (
      <span className="cl-rel" data-tip={label}>
        {body}
      </span>
    )
  }
  return (
    <button
      type="button"
      className="cl-rel is-link"
      data-tip={label}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(page.id)
      }}
    >
      {body}
    </button>
  )
}

export function RelationCell({ prop, row }: { prop: CollectionProp; row: CollectionRow }) {
  const ctx = useRelationCtx()
  const pages = useCollectionPages()
  const broken = useRelationBroken(prop)
  if (broken) return <span className="cl-text is-dim">{R.broken}</span>
  const linked = linkedPages(idList(rowValue(row, prop)) ?? [], prop.cfg.target, pages)
  if (linked.length === 0) return null
  return (
    <span className="cl-chips">
      {linked.map((page) => (
        <RelationChip key={page.id} page={page} onOpen={ctx?.open} />
      ))}
    </span>
  )
}
