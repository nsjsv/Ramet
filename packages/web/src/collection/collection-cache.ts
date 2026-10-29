// ---------- 集合连接的保活与冷缓存（回访秒开） ----------
// 两层，都只在内存里（刷新页面即失效）：
// - 热保活：最后一个使用者走了不立刻拆，留 keepMs；期间再 open 原样复用（连接、schema、窗口都在，增量照常套）。
//   空闲的至多 keepMax 个（每个都占一条 WS，流量贵），超出按最早空闲的先拆。
// - 冷缓存：真正拆掉时把 Y.Doc 与各窗口最后一份状态收进 LRU（至多 coldMax 个集合）；再 open 时交给新连接打底
//   （provider 2.15.3 的 destroy() 不销毁传进去的 document，同步只走差量），schema 与旧窗口先画，同步后重取。
// 被拒绝（denied）的不保活也不进冷缓存；reset（登出 / 换账号）清空两层，之前建的连接释放时也不再进缓存。
import type * as Y from 'yjs'
import type { CollectionStatus, WindowState } from './collection-store'

/** 拆掉的集合留下来的东西：文档（同步过的）+ 各窗口最后一份 */
export type ColdCollection = {
  doc: Y.Doc
  wins: { viewId: string; group: string | undefined; state: WindowState }[]
}

export type PooledCore = {
  status: () => CollectionStatus
  acquire: () => void
  /** 真正拆掉；keep = 收进冷缓存（null = 没什么可留的） */
  teardown: (keep: boolean) => ColdCollection | null
}

export type CacheOptions = { keepMs?: number; keepMax?: number; coldMax?: number }

const KEEP_MS = 2 * 60_000
const KEEP_MAX = 4
const COLD_MAX = 10

export type CorePool<C extends PooledCore> = {
  /** 取（或建）这个集合的 core 并 acquire 一次 */
  open: (cid: string) => C
  forEach: (fn: (core: C) => void) => void
  reset: () => void
}

/** make 建 core：cold = 冷缓存里的打底（可能没有），onIdle = 引用归零时调 */
export function createCorePool<C extends PooledCore>(
  make: (cid: string, cold: ColdCollection | undefined, onIdle: () => void) => C,
  opts: CacheOptions = {},
): CorePool<C> {
  const keepMs = opts.keepMs ?? KEEP_MS
  const keepMax = opts.keepMax ?? KEEP_MAX
  const coldMax = opts.coldMax ?? COLD_MAX
  const cores = new Map<string, C>()
  /** 空闲的 core → 到期定时器；Map 的插入序 = 空闲先后 */
  const idle = new Map<string, ReturnType<typeof setTimeout>>()
  const cold = new Map<string, ColdCollection>()
  /** reset 一次加一：之前建的 core 释放时直接拆、不留 */
  let gen = 0

  function retire(cid: string, keep: boolean): void {
    const timer = idle.get(cid)
    if (timer !== undefined) clearTimeout(timer)
    idle.delete(cid)
    const core = cores.get(cid)
    if (!core) return
    cores.delete(cid)
    const left = core.teardown(keep)
    if (!left) return
    cold.delete(cid)
    cold.set(cid, left)
    for (const old of cold.keys()) {
      if (cold.size <= coldMax) break
      cold.delete(old)
    }
  }

  function open(cid: string): C {
    let core = cores.get(cid)
    if (core) {
      const timer = idle.get(cid)
      if (timer !== undefined) clearTimeout(timer)
      idle.delete(cid)
    } else {
      const left = cold.get(cid)
      cold.delete(cid)
      const born = gen
      const created: C = make(cid, left, () => {
        if (cores.get(cid) !== created) return
        if (born !== gen || created.status() === 'denied') {
          retire(cid, false)
          return
        }
        idle.set(cid, setTimeout(() => retire(cid, true), keepMs))
        for (const old of idle.keys()) {
          if (idle.size <= keepMax) break
          retire(old, true)
        }
      })
      core = created
      cores.set(cid, core)
    }
    core.acquire()
    return core
  }

  return {
    open,
    forEach: (fn) => cores.forEach(fn),
    reset: () => {
      gen++
      for (const cid of [...idle.keys()]) retire(cid, false)
      cold.clear()
    },
  }
}
