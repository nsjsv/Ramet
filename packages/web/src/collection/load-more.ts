// ---------- 滚到底续取：哨兵进视口就取下一页（表格、列表、画廊、看板的列、时间线的「未排期」共用） ----------
import { useEffect, type RefObject } from 'react'
import type { RowsWindow } from '@ramet/shared/collection-query'

/** 哨兵进视口（提前 margin）就续取。root 缺省 = 视口：外层滚动容器的裁剪也算进去。
 *  依赖 win：每取回一页哨兵可能仍在视口里（一页没填满屏幕），换一个观察者才会再报一次相交 */
export function useLoadMore(sentinel: RefObject<HTMLElement | null>, win: RowsWindow | null, loadMore: () => void, margin = '300px'): void {
  useEffect(() => {
    const el = sentinel.current
    if (!el || !win?.next) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore()
    }, { rootMargin: margin })
    io.observe(el)
    return () => io.disconnect()
  }, [sentinel, win, loadMore, margin])
}
