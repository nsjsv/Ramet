/* ---------- 计划视图 store：按 planId 缓存一份 TeamPlanView（计划卡读它） ----------
 * 数据从三处来，谁新谁说了算（version 单调递增，GET 返回时发现期间有人 put 过就丢掉自己这份）：
 *   - GET /api/pages/:id/team/:planId（卡片出现时拉一次）
 *   - 页面 SSE 的 team_plan 事件（提交 / 改 / 取消 / 开工 / 收尾时服务端广播整份视图，agent-bar.tsx 收到后 put）
 *   - 自己 PATCH / cancel 的响应（put）
 * 回复块上的 team 属性只是计划轮那一刻的草稿快照，开工 / 改 / 取消之后以这里为准。
 * 不依赖 React / DOM，fetcher 注入；组件用 useSyncExternalStore 订阅。 */

import type { TeamPlanView } from '@ramet/shared/run-model'

export type PlanEntry = {
  /** idle 是还没问过；missing 是服务端说没有这份计划或看不到（404）；failed 是别的错 */
  state: 'idle' | 'loading' | 'ready' | 'missing' | 'failed'
  view: TeamPlanView | null
  /** 每次 put 递增 */
  version: number
}

const EMPTY: PlanEntry = { state: 'idle', view: null, version: 0 }

export type Fetcher = (pageId: string, planId: string) => Promise<TeamPlanView>

export function createPlanStore(fetcher: Fetcher) {
  const entries = new Map<string, PlanEntry>()
  /** 正在拉的计划，同一份不并发拉两次（静态卡与运行条里的卡常同时出现） */
  const inflight = new Set<string>()
  const listeners = new Set<() => void>()
  const emit = (): void => listeners.forEach((l) => l())
  const set = (planId: string, next: PlanEntry): void => {
    entries.set(planId, next)
    emit()
  }

  const store = {
    /** 当前条目，没问过返回同一个 EMPTY（useSyncExternalStore 要求没变就返回同一个引用） */
    get: (planId: string): PlanEntry => entries.get(planId) ?? EMPTY,

    subscribe(cb: () => void): () => void {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },

    /** 收到一份视图（SSE / PATCH / cancel）：整份替换 */
    put(view: TeamPlanView): void {
      if (!view || typeof view.planId !== 'string' || !view.planId) return
      const prev = entries.get(view.planId) ?? EMPTY
      set(view.planId, { state: 'ready', view, version: prev.version + 1 })
    },

    /** 拉一份，已经在拉或拉到了就不重复（要强制刷新用 refresh） */
    ensure(pageId: string, planId: string): void {
      const cur = entries.get(planId) ?? EMPTY
      if (cur.state === 'loading' || cur.state === 'ready') return
      void store.refresh(pageId, planId)
    },

    async refresh(pageId: string, planId: string): Promise<void> {
      if (inflight.has(planId)) return
      inflight.add(planId)
      const started = entries.get(planId) ?? EMPTY
      if (!started.view && started.state !== 'loading') set(planId, { ...started, state: 'loading' })
      try {
        const view = await fetcher(pageId, planId)
        const now = entries.get(planId) ?? EMPTY
        // 请求期间已经有更新的视图（SSE / PATCH）到了：它们比这份 GET 新，丢掉这份
        if (now.version > started.version) return
        set(planId, { state: 'ready', view, version: now.version + 1 })
      } catch (err) {
        const now = entries.get(planId) ?? EMPTY
        if (now.version > started.version) return
        const status = (err as { status?: number } | null)?.status
        set(planId, { ...now, state: status === 404 ? 'missing' : 'failed' })
      } finally {
        inflight.delete(planId)
      }
    },

    /** 这一页的事件流断开了（离开页面）：错过的 team_plan 不会重放，缓存的视图可能过期，标成没拉过，
     *  下次卡片出现时 ensure 会重拉（旧视图先留着显示，不闪） */
    invalidate(pageId: string): void {
      for (const [planId, entry] of entries) {
        if (entry.state === 'ready' && entry.view?.pageId === pageId) entries.set(planId, { ...entry, state: 'idle' })
      }
    },

    /** 事件流（重）连上：断流期间的 team_plan 丢了，这一页上还没收尾的计划（草稿 / 进行中）逐个重拉 */
    refreshPage(pageId: string): void {
      for (const [planId, entry] of [...entries]) {
        const status = entry.view?.status
        if (entry.view?.pageId === pageId && (status === 'draft' || status === 'running')) void store.refresh(pageId, planId)
      }
    },

    /** 测试用 */
    clear(): void {
      entries.clear()
      emit()
    },
  }
  return store
}
