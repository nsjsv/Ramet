/* ---------- 行的多选（表格与看板共用） ----------
 * 选择只在组件里（不进 store / 文档）：勾选 / ⌘ 点 = 切换并设锚点；Shift = 从锚点连选到这一行（按调用方给的可见顺序）；
 * 框选 = 一次给出整批（additive = 并到已有选择上）。被删 / 挪走 / 不在已加载窗口里的行由调用方 prune 掉。 */
import { useCallback, useRef, useState } from 'react'

/** 锚点到 to 之间（含两端）的 id；锚点不在顺序里 = 只有 to */
export function rangeIds(order: readonly string[], anchor: string | null, to: string): string[] {
  const a = anchor === null ? -1 : order.indexOf(anchor)
  const b = order.indexOf(to)
  if (a < 0 || b < 0) return [to]
  return order.slice(Math.min(a, b), Math.max(a, b) + 1)
}

export type Box = { left: number; top: number; right: number; bottom: number }

/** 与框相交的条目（边贴边不算） */
export function hitIds(items: readonly (Box & { id: string })[], box: Box): string[] {
  return items.filter((r) => r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top).map((r) => r.id)
}

/** 摘掉不再存活的；没变化 = null（调用方据此不 setState，免得重渲循环） */
export function pruneIds(picked: ReadonlySet<string>, alive: (id: string) => boolean): Set<string> | null {
  const next = new Set([...picked].filter(alive))
  return next.size === picked.size ? null : next
}

export type RowPicking = {
  picked: ReadonlySet<string>
  /** 单击勾选 / ⌘ 点：切换；shift = 从锚点连选（并入，不取消已选的） */
  pick: (id: string, shift: boolean, order: readonly string[]) => void
  /** 框选：base = 起框时的选择（追加模式），ids = 框里的 */
  setBox: (base: ReadonlySet<string>, ids: readonly string[]) => void
  replace: (ids: Iterable<string>) => void
  prune: (alive: (id: string) => boolean) => void
  clear: () => void
}

export function useRowPicking(): RowPicking {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  const anchor = useRef<string | null>(null)
  const pick = useCallback((id: string, shift: boolean, order: readonly string[]) => {
    setPicked((cur) => {
      const next = new Set(cur)
      if (shift && anchor.current !== null) {
        for (const x of rangeIds(order, anchor.current, id)) next.add(x)
        return next
      }
      anchor.current = id
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const setBox = useCallback((base: ReadonlySet<string>, ids: readonly string[]) => {
    setPicked(new Set([...base, ...ids]))
    if (ids.length > 0) anchor.current = ids[0]!
  }, [])
  const replace = useCallback((ids: Iterable<string>) => setPicked(new Set(ids)), [])
  const prune = useCallback((alive: (id: string) => boolean) => {
    setPicked((cur) => pruneIds(cur, alive) ?? cur)
  }, [])
  const clear = useCallback(() => {
    anchor.current = null
    setPicked((cur) => (cur.size === 0 ? cur : new Set()))
  }, [])
  return { picked, pick, setBox, replace, prune, clear }
}
