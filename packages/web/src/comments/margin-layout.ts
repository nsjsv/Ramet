/* ---------- 右侧评论栏的几何（纯函数，CommentMargin 用；卡片贴画面右缘）----------
 * 尺寸与 styles/comments.css 的 `.cm-margin` / `[data-cm-margin]` 同口径，改一处要同改。 */

/** 卡片宽 */
export const CARD_W = 280
/** 卡片与正文之间的空隙 */
export const CARD_GAP = 48
/** 卡片加上与正文的最小间隔：画面右侧要留给评论栏的宽度 = 它 + --cm-right */
export const MARGIN_W = CARD_W + CARD_GAP
/** 进宽模式后正文列内容盒至少还剩这么宽（720 正文 + 40 gutter 的下限），再窄就回到浮层 */
export const MIN_CONTENT = 600
/** 已经是宽模式时阈值放宽这么多：滚动条出现 / 消失在边界上时不来回切 */
export const HYSTERESIS = 24
/** 卡片的上内边距（同 .cm-card 的 padding-top）：卡片往上提这么多，第一行字和高亮那行齐平 */
export const CARD_PAD = 10
/** 相邻卡片的竖向间距 */
export const STACK_GAP = 8

/** 放得下评论栏吗。available = 列父元素的内容盒宽；padLeft / right = 列的左内边距与评论栏右侧余量（--cm-right） */
export function marginFits(available: number, padLeft: number, right: number, wasWide: boolean): boolean {
  const room = available - padLeft - right - MARGIN_W
  return room >= MIN_CONTENT - (wasWide ? HYSTERESIS : 0)
}

export type CardBox = { id: string; ideal: number; height: number }

/** 卡片排布：items 已按锚点顺序排好。
 *  没有激活的：从上往下，压到上一张就往下推；
 *  有激活的：它钉在自己的锚点高度，下面的照样往下推，上面的从它开始往上让。 */
export function stackCards(items: CardBox[], active: string | null, gap = STACK_GAP): Map<string, number> {
  const tops = new Map<string, number>()
  const pivot = active ? items.findIndex((c) => c.id === active) : -1
  const start = Math.max(0, pivot)
  let floor = -Infinity
  for (let i = start; i < items.length; i++) {
    const c = items[i]!
    const top = i === pivot ? c.ideal : Math.max(c.ideal, floor)
    tops.set(c.id, top)
    floor = top + c.height + gap
  }
  if (pivot > 0) {
    let ceil = tops.get(items[pivot]!.id)!
    for (let i = pivot - 1; i >= 0; i--) {
      const c = items[i]!
      const top = Math.min(c.ideal, ceil - gap - c.height)
      tops.set(c.id, top)
      ceil = top
    }
  }
  return tops
}
