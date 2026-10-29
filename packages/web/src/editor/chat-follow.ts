/* ---------- 聊天模式：跟随到底 + 输入框自动长高 ----------
 * 跟随的判据只有一个：视图是否贴底（距底 <= 40px）。贴底时内容变高（流式正文、状态条展开、
 * 新消息）就保持在底部，每帧最多滚一次；用户往上翻离开贴底就不再跟随，出现回到最新。
 * 程序滚动只会把视图滚到底（贴底），所以不需要区分谁滚的，滚完仍贴底，跟随自然保持。
 * 文档模式不用这个：那边跟的是正在生成的块末尾，用户往上翻远了就不拽（doc-follow.ts）。 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { reducedMotion } from '../motion'

const STICK_PX = 40

/** 滚动口是页面主滚动口 .main（与文档模式同一个，滚动条贴画面右缘） */
function pageScroller(content: HTMLElement | null): HTMLElement | null {
  return content?.closest<HTMLElement>('.main') ?? null
}

export function useChatFollow(
  contentRef: RefObject<HTMLElement | null>,
  tick: number,
): { away: boolean; toLatest: (instant?: boolean) => void } {
  const following = useRef(true)
  // 回到最新的平滑滚动途中视图不贴底，这期间的滚动事件不算用户上翻
  const jumping = useRef(false)
  const [away, setAway] = useState(false)

  useEffect(() => {
    const content = contentRef.current
    const scroller = pageScroller(content)
    if (!scroller || !content) return
    let raf = 0
    // 跟随自己滚到的位置：它的滚动事件异步到达，那时流式内容可能又长了一截（不再贴底），
    // 不能拿它判用户上翻，只有 scrollTop 离开了这里写下的值，才是用户自己动的
    let ownTop = -1
    const atBottom = (): boolean => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= STICK_PX
    const onScroll = (): void => {
      if (jumping.current) {
        if (atBottom()) jumping.current = false
        return
      }
      if (Math.abs(scroller.scrollTop - ownTop) < 1) return
      following.current = atBottom()
      setAway(!following.current)
    }
    const stick = (): void => {
      raf = 0
      if (!following.current) return
      scroller.scrollTop = scroller.scrollHeight
      ownTop = scroller.scrollTop
    }
    const onGrow = (): void => {
      if (following.current && !raf) raf = requestAnimationFrame(stick)
    }
    // 用户亲手滚（滚轮 / 触摸）立刻打断平滑回底
    const interrupt = (): void => {
      jumping.current = false
    }
    const observer = new ResizeObserver(onGrow)
    observer.observe(content)
    scroller.addEventListener('scroll', onScroll, { passive: true })
    scroller.addEventListener('wheel', interrupt, { passive: true })
    scroller.addEventListener('touchmove', interrupt, { passive: true })
    following.current = true
    setAway(false)
    stick()
    return () => {
      observer.disconnect()
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('wheel', interrupt)
      scroller.removeEventListener('touchmove', interrupt)
      cancelAnimationFrame(raf)
    }
  }, [contentRef, tick])

  /** instant 为 true 时直接跳到底（发送时消息要从输入框飞到气泡，终点不能跟着平滑滚动漂） */
  const toLatest = useCallback((instant = false) => {
    const scroller = pageScroller(contentRef.current)
    if (!scroller) return
    following.current = true
    setAway(false)
    const smooth = !instant && !reducedMotion()
    jumping.current = smooth
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [contentRef])

  return { away, toLatest }
}
