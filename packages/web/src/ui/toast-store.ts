/* ---------- Toast 的数据与计时（纯逻辑，不碰 DOM；视图在 toast.tsx）----------
 * 一条 toast：显示 → 到时（或点叉）标记 leaving 演退场 → 退场时长后摘掉。悬停暂停计时，移开后接着走剩下的。 */

export type ToastKind = 'info' | 'success' | 'error'

export interface ToastItem {
  id: number
  message: string
  kind: ToastKind
  /** 正在演退场：还在列表里，但不再算进上限 */
  leaving: boolean
}

/** 同时最多显示几条：再来新的，最早那条先退场 */
export const TOAST_MAX = 3
/** 缺省停留时长：出错的要读完、可能还要照着做，留久一点 */
export const TOAST_MS: Record<ToastKind, number> = { info: 3500, success: 3500, error: 6000 }
/** 悬停移开后至少还留这么久：不然剩几十毫秒的那条一移开就没了，像是被鼠标碰掉的 */
const MIN_AFTER_PAUSE = 1500

interface Timer {
  left: number
  since: number
  handle: ReturnType<typeof setTimeout> | null
  paused: boolean
}

/** exitMs：退场动画时长（读 CSS 令牌；减弱动效时为 0 → 直接摘） */
export function createToastStore(exitMs: () => number) {
  let items: readonly ToastItem[] = []
  let seq = 0
  const timers = new Map<number, Timer>()
  const subs = new Set<() => void>()
  const set = (next: readonly ToastItem[]): void => {
    items = next
    for (const fn of subs) fn()
  }

  function arm(id: number): void {
    const t = timers.get(id)
    if (!t || t.paused || t.handle) return
    t.since = Date.now()
    t.handle = setTimeout(() => dismiss(id), t.left)
  }

  function dismiss(id: number): void {
    const t = timers.get(id)
    if (t?.handle) clearTimeout(t.handle)
    timers.delete(id)
    if (!items.some((x) => x.id === id && !x.leaving)) return
    set(items.map((x) => (x.id === id ? { ...x, leaving: true } : x)))
    const drop = (): void => set(items.filter((x) => x.id !== id))
    const ms = exitMs()
    if (ms > 0) setTimeout(drop, ms)
    else drop()
  }

  function push(message: string, kind: ToastKind, duration: number = TOAST_MS[kind]): number {
    // 同一句话还在显示：只重新计时，不叠第二条（连着几次拖放被拒、几个文件都传失败时不刷屏）
    const same = items.find((x) => !x.leaving && x.message === message && x.kind === kind)
    const t = same && timers.get(same.id)
    if (same && t) {
      if (t.handle) clearTimeout(t.handle)
      t.handle = null
      t.left = duration
      arm(same.id)
      return same.id
    }
    const id = ++seq
    set([...items, { id, message, kind, leaving: false }])
    timers.set(id, { left: duration, since: 0, handle: null, paused: false })
    arm(id)
    const live = items.filter((x) => !x.leaving)
    for (const old of live.slice(0, Math.max(0, live.length - TOAST_MAX))) dismiss(old.id)
    return id
  }

  function pause(id: number): void {
    const t = timers.get(id)
    if (!t || t.paused) return
    t.paused = true
    if (!t.handle) return
    clearTimeout(t.handle)
    t.handle = null
    t.left = Math.max(0, t.left - (Date.now() - t.since))
  }

  function resume(id: number): void {
    const t = timers.get(id)
    if (!t || !t.paused) return
    t.paused = false
    t.left = Math.max(t.left, MIN_AFTER_PAUSE)
    arm(id)
  }

  return {
    push,
    dismiss,
    pause,
    resume,
    subscribe(fn: () => void): () => void {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    snapshot: (): readonly ToastItem[] => items,
  }
}
