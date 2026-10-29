/* ---------- 收藏（模块级单源）----------
 * 收藏是用户私有、跨页的：侧栏列表、块菜单、对话气泡、过程页步骤、顶栏星标都读写这一份。
 * 这里存全部空间的收藏（星标判定不分空间）；侧栏只列当前空间的，在 FavoritesList 里按 spaceId 过滤。
 * 非 React 的 DOM 小部件（块菜单、气泡、步骤块）用 isFavorite / subscribeFavorites，React 用 useFavorites。
 * 切换是乐观的：先改本地（星标立刻变），再请求；失败回滚。列表现读原块内容由服务端给，这里只缓存。 */

import { useSyncExternalStore } from 'react'
import { api, type FavoriteView } from './api'

type State = { list: FavoriteView[]; loaded: boolean }

let state: State = { list: [], loaded: false }
/** pageId#blockId（整页 blockId 为空）→ 收藏 id */
let index = new Map<string, string>()
const listeners = new Set<() => void>()

const keyOf = (pageId: string, blockId: string): string => `${pageId}#${blockId}`

function set(next: State): void {
  state = next
  index = new Map(next.list.map((f) => [keyOf(f.pageId, f.blockId ?? ''), f.id]))
  listeners.forEach((l) => l())
}

export function subscribeFavorites(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export const favoritesState = (): State => state

/** 这个页面 / 块收藏了吗（blockId 缺省表示整页） */
export const isFavorite = (pageId: string, blockId = ''): boolean => index.has(keyOf(pageId, blockId))

export function useFavorites(): State {
  return useSyncExternalStore(subscribeFavorites, favoritesState)
}

/** 本地改动的版本号：每次乐观改动 / 回滚 / 请求完成都 +1。拉列表的结果只在发起之后没有任何本地改动时才落地，
 *  否则一份在改动之前发出去的旧响应会把刚亮起的星标冲掉（改动完成时会再拉一次，以服务端为准） */
let rev = 0
/** 拉列表串行排队：保证后发的结果后落地 */
let chain: Promise<void> = Promise.resolve()

/** 拉一次。失败保持现状，下次再试 */
export function loadFavorites(): Promise<void> {
  const startRev = rev
  chain = chain.then(async () => {
    try {
      const list = await api.listFavorites()
      if (startRev === rev) set({ list, loaded: true })
    } catch (err) {
      console.error(err)
    }
  })
  return chain
}

/** 乐观切换收藏 / 取消，返回切换后的状态；失败回滚并返回原状态 */
export async function toggleFavorite(pageId: string, blockId = ''): Promise<boolean> {
  const key = keyOf(pageId, blockId)
  const existing = index.get(key)
  const before = state
  rev++
  try {
    if (existing) {
      set({ ...state, list: state.list.filter((f) => f.id !== existing) })
      await api.removeFavorite(existing)
      rev++
      void loadFavorites()
      return false
    }
    // 先占位（星标立刻亮），请求回来后用服务端的列表替换（带上块的当前文字 / 类型）
    set({
      loaded: state.loaded,
      list: [
        {
          id: `pending:${key}`,
          pageId,
          spaceId: null,
          blockId: blockId || null,
          blockType: '',
          text: '',
          title: '',
          gone: false,
          createdAt: new Date().toISOString(),
        },
        ...state.list,
      ],
    })
    await api.addFavorite(pageId, blockId || undefined)
    rev++
    void loadFavorites()
    return true
  } catch (err) {
    console.error(err)
    rev++
    set(before)
    return Boolean(existing)
  }
}

const REFRESH_MS = 30_000

/** 外壳挂载时调：先拉一次，之后窗口回到前台时（距上次拉取 ≥ 30 秒）再拉。原块的当前文字由服务端现读，
 *  不用定时轮询。返回清理函数 */
export function startFavoritesSync(): () => void {
  let last = Date.now()
  void loadFavorites()
  const onFocus = (): void => {
    if (document.visibilityState === 'hidden' || Date.now() - last < REFRESH_MS) return
    last = Date.now()
    void loadFavorites()
  }
  window.addEventListener('focus', onFocus)
  document.addEventListener('visibilitychange', onFocus)
  return () => {
    window.removeEventListener('focus', onFocus)
    document.removeEventListener('visibilitychange', onFocus)
  }
}
