// ---------- 横向滚动层伸出正文列：量出 --bleed-l / --bleed-r ----------
// 宽内容（表格、集合块的看板）比正文列宽时横向滚动：滚动层伸出正文列、铺到画面（.main 的可视内容区）两边，
// 再用同量的内边距把内容推回正文列，起点与正文左缘对齐，滚动中内容滑进两侧留白，不在正文列边上截断。
// 伸出量写成 target 上的 --bleed-l / --bleed-r（CSS 同时用作负外边距和内边距）；右边给右轨（文档导航）让出 RAIL，手机宽度铺到屏幕边。
// 只有顶层块（含 AI 回复里的）伸出去；列表 / 引用 / 用户消息里的伸出去会越过缩进和色条，只在自身宽度里滚。

import type { EditorView } from '@milkdown/kit/prose/view'

/** 右轨让位，同全宽页的右内边距（editor.css 的 .editor-page.full-width） */
const RAIL = 96
const MOBILE = '(max-width: 768px)'

type Deps = {
  view: EditorView
  /** 正文里的块（量它两边到画面边的距离） */
  block: HTMLElement
  /** 写 --bleed-l / --bleed-r 的元素 */
  target: HTMLElement
  /** 右边至少伸出多少（表格右侧「+」条要落脚） */
  minRight?: number
  /** 尺寸变了也要重量的元素（块本身和 .main 总会观察） */
  observe?: readonly Element[]
  /** 量完之后（伸出量写好了） */
  onLayout?: () => void
}

export function trackBleed({ view, block, target, minRight = 0, observe = [], onLayout }: Deps): () => void {
  let alive = true
  let waiting = false
  let main: HTMLElement | null | undefined // undefined = 还没挂进文档，没找过

  /** [左, 右] 伸出量：正文列（= 块）两边到画面边的距离 */
  const bleed = (): [number, number] => {
    if (!main) return [0, minRight]
    const host = block.parentElement
    const top = host === view.dom || (host?.parentElement === view.dom && host.classList.contains('agent-reply'))
    if (!top) return [0, minRight]
    const m = main.getBoundingClientRect()
    const cs = getComputedStyle(main)
    const left = m.left + main.clientLeft + parseFloat(cs.paddingLeft) // 侧栏停靠时 .main 用左内边距让位
    const right = m.left + main.clientLeft + main.clientWidth - parseFloat(cs.paddingRight) - (matchMedia(MOBILE).matches ? 0 : RAIL)
    const b = block.getBoundingClientRect()
    return [Math.max(0, b.left - left), Math.max(minRight, right - b.right)]
  }

  const measure = (): void => {
    if (!alive || !block.offsetParent) return // 没挂上或不可见（对话模式、源码模式下编辑器 display:none）
    if (main === undefined) {
      main = view.dom.closest('.editor-page')?.closest<HTMLElement>('.main') ?? null
      if (main) resize.observe(main) // 窗口变宽、侧栏收放、工作台让位都改 .main 的内容宽
    }
    // 侧栏收放、全宽切换、工作台让位都给正文列演 FLIP 平移（motion.ts），演出期间 rect 带 transform，等演完再量（同 hud/make-room.ts）
    const running = block.closest('.editor-page')?.getAnimations() ?? []
    if (running.length) {
      if (waiting) return
      waiting = true
      void Promise.allSettled(running.map((a) => a.finished)).then(() => {
        waiting = false
        measure()
      })
      return
    }
    const [left, right] = bleed()
    target.style.setProperty('--bleed-l', `${left}px`)
    target.style.setProperty('--bleed-r', `${right}px`)
    onLayout?.()
  }
  const resize = new ResizeObserver(measure)
  resize.observe(block) // 全宽切换改正文列宽
  for (const el of observe) resize.observe(el)

  return () => {
    alive = false
    resize.disconnect()
  }
}
