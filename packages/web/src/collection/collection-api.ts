// ---------- 集合的 REST 客户端与协同连接 ----------
// 类型一律从 @ramet/shared/collection-* 引（两端同源）。单独成文件是因为 api.ts 逼近 800 行闸门，集合的接口也只有集合的 store / 侧栏在用。
// 属性定义与视图不走 REST：经集合文档的协同连接直接改（schema-ops.ts），viewer 的连接服务端只读。
import { HocuspocusProvider } from '@hocuspocus/provider'
import type * as Y from 'yjs'
import type { CollectionRow, PropValue } from '@ramet/shared/collection-model'
import type { RowsWindow } from '@ramet/shared/collection-query'
import { ApiError, request, type Page } from '../api'
import { collabUrl } from '../editor/collab-url'
import { personOf } from '../people'
import type { CollectionLink, CollectionTransport, RowsQuery } from './collection-store'

/** 改值：属性 id → 新值，null = 清空（服务端 validateValue 全部通过才写，任一非法整个 400） */
export type RowSet = Record<string, PropValue | null>

export type NewCollectionInput = {
  space_id: string
  /** 客户端生成的 uuid v4（内联集合先插块后建）；缺省由服务端生成 */
  id?: string
  parent_id?: string | null
  inline?: boolean
  title?: string
}

/** id = 客户端生成的 uuid v4（乐观新建：先插行、进入命名，不等这一趟；已被占用 409） */
export type NewRowInput = { id?: string; title?: string; set?: RowSet; after?: string | null; before?: string | null }
export type RowPatch = { set?: RowSet; title?: string; after?: string | null; before?: string | null }

const base = (cid: string): string => `/api/collections/${encodeURIComponent(cid)}`

/** 集合的状态（GET /api/collections/:id/state：按 id 直达，含回收站；非成员 / 不存在 404） */
export type CollectionState = { state: 'live' | 'trashed'; parent_id: string | null; title: string; inline: boolean }

export const collectionApi = {
  /** 集合块判定「在回收站」与「无法加载」用；404 = null（没有权限或不存在，不泄露是哪种） */
  state: (cid: string): Promise<CollectionState | null> =>
    request<CollectionState>(`${base(cid)}/state`).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) return null
      throw err
    }),
  /** 建集合页（整页或内联）：广播 changed，返回页面元数据 + inline */
  create: (input: NewCollectionInput) =>
    request<Page & { inline: boolean }>('/api/collections', { method: 'POST', body: JSON.stringify(input) }),
  /** 窗口查询：tz = 比 UTC 快多少分钟（创建 / 编辑时间按它折成日期，与客户端套增量同一口径） */
  rows: (cid: string, q: RowsQuery) => {
    const params = new URLSearchParams({ view: q.view, limit: String(q.limit), tz: String(q.tz) })
    if (q.group !== undefined) params.set('group', q.group)
    if (q.cursor) params.set('cursor', q.cursor)
    return request<RowsWindow>(`${base(cid)}/rows?${params.toString()}`)
  },
  createRow: (cid: string, input: NewRowInput) =>
    request<CollectionRow>(`${base(cid)}/rows`, { method: 'POST', body: JSON.stringify(input) }),
  patchRow: (cid: string, rowId: string, patch: RowPatch) =>
    request<CollectionRow>(`${base(cid)}/rows/${encodeURIComponent(rowId)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  trashRows: (cid: string, ids: string[]) =>
    request<{ trashed: string[] }>(`${base(cid)}/rows/trash`, { method: 'POST', body: JSON.stringify({ ids }) }),
  setRows: (cid: string, ids: string[], set: RowSet) =>
    request<{ rows: CollectionRow[] }>(`${base(cid)}/rows/set`, { method: 'POST', body: JSON.stringify({ ids, set }) }),
  duplicateRows: (cid: string, ids: string[]) =>
    request<{ created: { from: string; id: string }[] }>(`${base(cid)}/rows/duplicate`, { method: 'POST', body: JSON.stringify({ ids }) }),
  moveRows: (cid: string, ids: string[], to: string) =>
    request<{ moved: string[] }>(`${base(cid)}/rows/move`, { method: 'POST', body: JSON.stringify({ ids, to }) }),
}

/** 集合文档 page:<cid> 的协同连接：不挂 IndexedDB（只有属性定义与视图，体积小）。
 *  doc = 冷缓存里留下的文档（collection-cache.ts），同步只走差量。provider 2.15.3 的 destroy() 只摘自己挂在 doc 上的
 *  update 监听、拆自己建的 awareness，不销毁 document，所以拆掉后可以交给下一条连接 */
function connect(cid: string, doc?: Y.Doc): CollectionLink {
  const provider = new HocuspocusProvider({ url: collabUrl(), name: `page:${cid}`, ...(doc ? { document: doc } : {}) })
  return {
    doc: provider.document,
    provider,
    // 'synced' 在断线时也会发一次（state: false，provider 2.15 的 onClose 把 synced 置回 false）：只认同步完成
    onSynced: (cb) =>
      provider.on('synced', ({ state }: { state: boolean }) => {
        if (state) cb()
      }),
    onStateless: (cb) => provider.on('stateless', ({ payload }: { payload: string }) => cb(payload)),
    onDenied: (cb) =>
      // 4401 / 4403 = 服务端拒绝（非成员 / 不存在）；载荷形态见 editor-session.ts
      provider.on('close', (payload: { event?: { code?: number } }) => {
        const code = payload?.event?.code
        if (code === 4401 || code === 4403) cb()
      }),
    destroy: () => {
      // y-prosemirror 1.3.7 的 yCursorPlugin 把 awareness 广播延迟派发、守卫失效。
      // 最后一个使用者走了，这条连接上没人再需要 awareness，先静音，迟到的广播就不会打进已拆的标题视图
      const aw = provider.awareness as { emit?: (event: string, ...args: unknown[]) => void } | null
      if (aw?.emit) aw.emit = () => {}
      provider.destroy()
    },
  }
}

export const collectionTransport: CollectionTransport = {
  connect,
  rows: collectionApi.rows,
  createRow: collectionApi.createRow,
  patchRow: collectionApi.patchRow,
  trashRows: collectionApi.trashRows,
  setRows: collectionApi.setRows,
  duplicateRows: collectionApi.duplicateRows,
  moveRows: collectionApi.moveRows,
  nameOf: (spaceId, userId) => personOf(spaceId, userId)?.username,
}
