/* ---------- 激活的串（浮层 / 右侧卡片）：点外面、按 Esc 收起 ----------
 * 点到高亮不收（高亮的点击会直接换成那个串）、框选菜单不收（正要点「评论」开草稿）、
 * 确认框不收（删除确认是在这个串里点出来的，收了串就没了着落）。 */

import { useEffect, useRef } from 'react'
import { closePopover } from './comments-store'

const KEEP = '.comment-mark, .selection-menu, .ui-dialog'

export function useDismiss(enabled: boolean, isInside: (target: Element) => boolean): void {
  const inside = useRef(isInside)
  inside.current = isInside
  useEffect(() => {
    if (!enabled) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Element | null
      if (!target || inside.current(target) || target.closest?.(KEEP)) return
      closePopover()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) closePopover()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [enabled])
}
