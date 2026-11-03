// ---------- 按日期范围取全：日历 / 时间线一个范围里的行要全拿到才能排版 ----------
// 每个范围是 store 里的一个窗口（watchWindow(viewId, { range })，增量照常套，行改了日期自然进 / 出）。
// 窗口没取完就接着续取，直到取完或到 RANGE_ROWS_CAP（界面提示只显示了前这么多条）；没人看的范围不续取。
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { CollectionRow } from '@ramet/shared/collection-model'
import type { CollectionHandle, WindowState } from './collection-store'
import { RANGE_ROWS_CAP } from './collection-windows'

export type RangeRows = {
  /** 每个范围一份，顺序同传入的 ranges；还没取到的是空列表 */
  lists: CollectionRow[][]
  /** 有范围的首屏还没到 */
  loading: boolean
  /** 有范围的行超过上限，只取了前 RANGE_ROWS_CAP 条 */
  capped: boolean
  /** 有范围取数失败（取第一个原因） */
  error: string | null
}

/** 还要不要续取：窗口没取完、没在取、上次没失败、还没到上限 */
export function wantsMore(state: WindowState): boolean {
  const win = state.window
  return !!win?.next && !state.loading && !state.loadingMore && state.error === null && win.rows.length < RANGE_ROWS_CAP
}

/** 几个窗口的状态合成一份 */
export function rangeRowsOf(states: readonly WindowState[]): RangeRows {
  return {
    lists: states.map((s) => s.window?.rows ?? []),
    loading: states.some((s) => s.window === null && s.error === null),
    capped: states.some((s) => !!s.window?.next && s.window.rows.length >= RANGE_ROWS_CAP),
    error: states.find((s) => s.error !== null)?.error ?? null,
  }
}

const EMPTY: RangeRows = { lists: [], loading: true, capped: false, error: null }
const noSubscribe = (): (() => void) => () => undefined

/** 一个视图的几个日期范围（时间线的各块）：挂载期间都看着，没取完的接着取 */
export function useRangeWindows(handle: CollectionHandle | null, viewId: string | null, ranges: readonly string[]): RangeRows {
  // 范围的写法里没有 '|'：拼成一个字符串当依赖，调用方每次渲染给新数组也不会反复重挂
  const key = ranges.join('|')
  useEffect(() => {
    if (!handle || viewId === null || key === '') return
    const list = key.split('|')
    const offs = list.map((range) => handle.watchWindow(viewId, { range }))
    const pump = (): void => {
      for (const range of list) if (wantsMore(handle.windowState(viewId, { range }))) handle.loadMore(viewId, { range })
    }
    pump()
    const unsubscribe = handle.subscribe(pump)
    return () => {
      unsubscribe()
      offs.forEach((off) => off())
    }
  }, [handle, viewId, key])

  // 快照要稳定（useSyncExternalStore 每次读都比引用）：各窗口状态都没换就给上一份
  const cache = useRef<{ key: string; states: WindowState[]; out: RangeRows } | null>(null)
  const snapshot = (): RangeRows => {
    if (!handle || viewId === null || key === '') return EMPTY
    const states = key.split('|').map((range) => handle.windowState(viewId, { range }))
    const prev = cache.current
    if (prev && prev.key === key && prev.states.every((s, i) => s === states[i])) return prev.out
    const out = rangeRowsOf(states)
    cache.current = { key, states, out }
    return out
  }
  return useSyncExternalStore(handle?.subscribe ?? noSubscribe, snapshot)
}

/** 一个日期范围（日历的一屏） */
export function useRangeRows(handle: CollectionHandle | null, viewId: string | null, range: string): RangeRows & { rows: CollectionRow[] } {
  const out = useRangeWindows(handle, viewId, [range])
  return { ...out, rows: out.lists[0] ?? [] }
}
