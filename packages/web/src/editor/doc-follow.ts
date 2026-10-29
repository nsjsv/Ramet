/* ---------- 文档模式：运行中跟住正在生成的回复 ----------
 * 正在生成的回复块（.agent-reply.is-live，ai-block.ts 的实时视图插件挂的类）长高时：块底越过可视区底边上方
 * LINE_GAP 的那条线、且越过不到 REACH，就把 .main 往下带到刚好露出；越过更多说明用户往上翻着看别处，不拽。
 * 跟的是这一块的末尾，不是页底。对话模式有自己的贴底跟随（chat-follow.ts），那时文档视图是 display:none，这里不动。 */

const LINE_GAP = 24
const REACH = 240

export function createDocFollow(root: HTMLElement): { sync(): void; destroy(): void } {
  const watched = new Set<Element>()
  const nudge = (el: HTMLElement): void => {
    if (!el.isConnected || el.offsetParent === null) return
    const scroller = el.closest<HTMLElement>('.main')
    if (!scroller) return
    const over = el.getBoundingClientRect().bottom - (scroller.getBoundingClientRect().bottom - LINE_GAP)
    if (over > 0 && over < REACH) scroller.scrollTop += over
  }
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) if (entry.target instanceof HTMLElement) nudge(entry.target)
  })
  return {
    /** 视图每次更新后对一遍：新进 live 的块开始观察，离开 live 的停止观察 */
    sync() {
      const live = new Set<Element>(root.querySelectorAll(':scope > .agent-reply.is-live'))
      for (const el of watched) {
        if (live.has(el)) continue
        observer.unobserve(el)
        watched.delete(el)
      }
      for (const el of live) {
        if (watched.has(el)) continue
        observer.observe(el)
        watched.add(el)
      }
    },
    destroy() {
      observer.disconnect()
      watched.clear()
    },
  }
}
