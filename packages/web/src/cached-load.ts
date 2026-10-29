// ---------- 列表页先显示上次的内容 ----------
// 按 key 记住上次取到的（模块级、只在内存里），首帧先画它，挂载时照常后台重取，免得每次进来先闪一屏「加载中」。
// key 由页面自己定（带上空间 / 页面 id，换空间不串），null 表示先不取；至多 MAX_KEYS 个，最久没用的先丢。
// 登出 / 换账号时调 resetCachedLoads()（App 与集合缓存同一处调），之前发出的请求回来了也不再写进缓存。
import { useCallback, useEffect, useRef, useState } from 'react'

const MAX_KEYS = 20

export type LoadCache = {
  peek: <T>(key: string) => T | undefined
  put: (key: string, value: unknown) => void
  /** 取一次：成功写进缓存（期间 reset 过就不写，ok 仍为 true，stale = true 表示这份不该再显示给新身份） */
  fetch: <T>(key: string, load: () => Promise<T>) => Promise<{ ok: true; data: T; stale: boolean } | { ok: false; error: unknown }>
  reset: () => void
}

export function createLoadCache(max = MAX_KEYS): LoadCache {
  const map = new Map<string, unknown>()
  let gen = 0
  const put = (key: string, value: unknown): void => {
    map.delete(key) // 重新插入 = 挪到最近使用
    map.set(key, value)
    for (const old of map.keys()) {
      if (map.size <= max) break
      map.delete(old)
    }
  }
  return {
    peek: <T>(key: string) => {
      if (!map.has(key)) return undefined
      const value = map.get(key)
      put(key, value)
      return value as T
    },
    put,
    fetch: async <T>(key: string, load: () => Promise<T>) => {
      const born = gen
      try {
        const data = await load()
        if (born !== gen) return { ok: true as const, data, stale: true }
        put(key, data)
        return { ok: true as const, data, stale: false }
      } catch (error) {
        return { ok: false as const, error }
      }
    },
    reset: () => {
      gen++
      map.clear()
    },
  }
}

const shared = createLoadCache()
export const resetCachedLoads = shared.reset

export type CachedLoad<T> = {
  /** 上次的（或刚取到的）数据；这个 key 从没取到过 = null */
  data: T | null
  /** 最近一次取数失败的原因（成功后清掉）；页面自己决定怎么提示 */
  error: unknown
  /** 重取（写操作之后、广播信号来了）；不抛错，失败记进 error */
  reload: () => Promise<void>
  /** 本地改动后直接换成新值（同时更新缓存） */
  set: (data: T) => void
}

type State<T> = { key: string | null; data: T | null; error: unknown }

/** 挂载、key 变、deps 变时后台重取；首帧先给这个 key 上次的值 */
export function useCachedLoad<T>(key: string | null, load: () => Promise<T>, deps: readonly unknown[] = []): CachedLoad<T> {
  const initial = (k: string | null): State<T> => ({ key: k, data: k === null ? null : (shared.peek<T>(k) ?? null), error: null })
  const [state, setState] = useState<State<T>>(() => initial(key))
  const keyRef = useRef(key)
  keyRef.current = key
  const loadRef = useRef(load)
  loadRef.current = load

  const reload = useCallback(async (): Promise<void> => {
    const k = keyRef.current
    if (k === null) return
    const res = await shared.fetch(k, loadRef.current)
    if (keyRef.current !== k) return
    if (res.ok) {
      if (!res.stale) setState({ key: k, data: res.data, error: null })
    } else setState((s) => ({ ...(s.key === k ? s : initial(k)), error: res.error }))
    // initial 每次渲染新建，但只读模块缓存：不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const set = useCallback((data: T): void => {
    const k = keyRef.current
    if (k === null) return
    shared.put(k, data)
    setState({ key: k, data, error: null })
  }, [])

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reload, ...deps])

  // 换 key 的那一帧：直接给新 key 的缓存（没有就是 null），别让上一个 key 的数据在新 key 名下闪一下
  const shown = state.key === key ? state : initial(key)
  return { data: shown.data, error: shown.error, reload, set }
}
