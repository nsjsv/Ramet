// ---------- 关联 / 汇总的界面上下文：本集合是谁、在哪个空间、服务端给的 refs、怎么打开别的行 ----------
// 格子（CellView / CellEditor）只拿行与属性，关联的 chip 要知道「已失效」、汇总要知道目标属性的定义、点 chip 要能打开
// 别的集合的行，属性设置要知道本集合 id 去调关联端点。一层层传参要穿过表格 / 看板 / 列表 / 画廊 / 工具栏，
// 所以由集合的内容区（CollectionSurface）与行页面属性区各自提供一份。没有提供（版本预览）= 只读展示，chip 不可点。
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { CollectionProp, CollectionRefs } from '@ramet/shared/collection-model'
import type { CollectionHandle } from './collection-store'
import type { RowState } from './row-watch'

export type RelationCtx = {
  /** 本集合 */
  cid: string
  spaceId: string | null
  refs: CollectionRefs | null
  /** 按页面 id 打开一行（别的集合的行也一样） */
  open: (pageId: string) => void
}

export const RelationContext = createContext<RelationCtx | null>(null)

export function useRelationCtx(): RelationCtx | null {
  return useContext(RelationContext)
}

/** 关联已失效：没有目标，或服务端判定对不上（它知道对方集合在不在、在不在同一个空间） */
export function useRelationBroken(prop: CollectionProp): boolean {
  const ctx = useRelationCtx()
  return !prop.cfg.target || ctx?.refs?.[prop.id]?.state === 'broken'
}

const noSubscribe = (): (() => void) => () => undefined

/** 窗口响应里最近一份 refs */
export function useCollectionRefs(handle: CollectionHandle | null): CollectionRefs | null {
  return useSyncExternalStore(handle?.subscribe ?? noSubscribe, () => handle?.refs() ?? null)
}

/** 行页面属性区的这一行（带计算值）与 refs：挂载期间让 store 单独取这一行；rowId = null 不取。
 *  行取 findRow 那一份（窗口里跟得上增量的优先，没有再用单独取的）：改反向关联时 store 按 findRow 换算增删，
 *  显示的与换算的不是同一份的话，别人刚加的会被当成要删的 */
export function useCollectionRow(handle: CollectionHandle | null, rowId: string | null): RowState {
  useEffect(() => (rowId === null ? undefined : handle?.watchRow(rowId)), [handle, rowId])
  const subscribe = handle?.subscribe ?? noSubscribe
  const row = useSyncExternalStore(subscribe, () => (handle && rowId !== null ? (handle.findRow(rowId) ?? null) : null))
  const refs = useSyncExternalStore(subscribe, () => (handle && rowId !== null ? handle.refs() : null))
  return useMemo(() => ({ row, refs }), [row, refs])
}
