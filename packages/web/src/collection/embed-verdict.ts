/* ---------- 正文里的集合块该画什么（纯函数） ----------
 * 数据只有两处：页面列表（集合活着且我看得见就在里面）与状态接口 GET /api/collections/:id/state
 * （不在列表里时才问：区分「在回收站」与「无法加载」）。
 * collection_inline 只有「父页是本页」才显示数据：挪走的、克隆 / 模板复制出来的块不链接回源数据。
 * collection_link 不论集合挂在哪都显示（它本来就是别处集合的一个视图）。 */
import type { Page, Space } from '../api'
import { spaceReadOnly } from '../space-role'
import type { CollectionState } from './collection-api'

export type BlockVerdict =
  /** 正常显示集合 */
  | { kind: 'show'; spaceId: string | null }
  | { kind: 'loading' }
  /** 刚从斜杠菜单建、服务端还没建好（先插块后建集合的中间态） */
  | { kind: 'creating' }
  | { kind: 'failed' }
  | { kind: 'trashed' }
  /** 内联集合的父页不是本页 */
  | { kind: 'elsewhere' }
  /** 没有权限或不存在 */
  | { kind: 'unavailable' }

export type VerdictInput = {
  link: boolean
  hostId: string
  collectionId: string
  /** 页面列表；null = 还没到 */
  pages: readonly Page[] | null
  /** 状态接口的结果：undefined = 没问 / 在途，null = 404 或失败 */
  state: CollectionState | null | undefined
  /** 本端正在建这个集合 / 建失败了 */
  creating: boolean
  failed: boolean
}

export function blockVerdict(o: VerdictInput): BlockVerdict {
  if (o.failed) return { kind: 'failed' }
  if (!o.collectionId) return { kind: 'unavailable' }
  if (o.pages === null) return { kind: 'loading' }
  const listed = o.pages.find((p) => p.id === o.collectionId)
  if (listed) {
    if (listed.kind !== 'collection') return { kind: 'unavailable' }
    if (!o.link && listed.parent_id !== o.hostId) return { kind: 'elsewhere' }
    return { kind: 'show', spaceId: listed.space_id }
  }
  // 不在列表里：自己刚建、列表还没跟上
  if (o.creating) return { kind: 'creating' }
  if (o.state === undefined) return { kind: 'loading' }
  if (o.state === null) return { kind: 'unavailable' }
  if (!o.link && o.state.parent_id !== o.hostId) return { kind: 'elsewhere' }
  if (o.state.state === 'trashed') return { kind: 'trashed' }
  // 活着但不在我的列表里（列表陈旧）：照常显示
  return { kind: 'show', spaceId: null }
}

/** 需不需要问状态接口：页面列表到了、集合不在里面、也不是本端正在建的 */
export function needsState(o: Pick<VerdictInput, 'pages' | 'collectionId' | 'creating' | 'failed'>): boolean {
  return o.pages !== null && !!o.collectionId && !o.creating && !o.failed && !o.pages.some((p) => p.id === o.collectionId)
}

/** 块里能不能改集合（改值、属性与视图定义、改名、恢复）：宿主页可写，且集合所在空间里我不是 viewer
 *  （与 PageRoute 同一个口径 spaceReadOnly；空间未知时以服务端为准，见 space-role.ts） */
export function blockWritable(hostEditable: boolean, spaces: readonly Space[] | null, collectionSpaceId: string | null | undefined): boolean {
  return hostEditable && !spaceReadOnly(spaces, collectionSpaceId)
}
