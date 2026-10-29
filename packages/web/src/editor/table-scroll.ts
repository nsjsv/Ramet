/* ---------- 表格横向滚动 ----------
 * 表格比正文列宽时横向滚动；滚动层伸出正文列铺到画面两边（伸出量由 bleed.ts 量，写成滚动层上的 --bleed-l / --bleed-r，table.css 用）。
 * 右边至少伸出 BAR：右侧「+」条（table-grow.ts）在滚动层里贴着表格右缘，要有地方落脚。
 * 表格看得见的那段写成表格块上的 --table-l / --table-r / --table-b（块坐标，跟着横向滚动更新），
 * 「⋯」钉在它右上角，块选中高亮只盖它（table.css）。 */

import type { EditorView } from '@milkdown/kit/prose/view'
import { trackBleed } from './bleed'

/** 右侧「+」条的宽（table.css 的 .table-add.is-col） */
const BAR = 18

type Deps = {
  view: EditorView
  block: HTMLElement
  scroller: HTMLElement
  table: HTMLElement
  /** 伸出量 / 表格尺寸变了：「+」条重新摆位 */
  onLayout: () => void
}

export function tableScroll({ view, block, scroller, table, onLayout }: Deps): () => void {
  // 表格与滚动层可视区的交集（块坐标，滚动层的 offsetParent 就是表格块）。底边量到表格为止，不含「+」条留位和横向滚动条
  const placeVisible = (): void => {
    const tableLeft = scroller.offsetLeft + table.offsetLeft - scroller.scrollLeft
    const left = Math.max(tableLeft, scroller.offsetLeft)
    const right = Math.min(tableLeft + table.offsetWidth, scroller.offsetLeft + scroller.clientWidth)
    block.style.setProperty('--table-l', `${left}px`)
    block.style.setProperty('--table-r', `${block.clientWidth - right}px`)
    block.style.setProperty('--table-b', `${block.clientHeight - scroller.offsetTop - table.offsetTop - table.offsetHeight}px`)
  }

  const stop = trackBleed({
    view,
    block,
    target: scroller,
    minRight: BAR,
    observe: [table], // 打字撑高、拖列宽、加减行列
    onLayout: () => {
      onLayout()
      placeVisible()
    },
  })
  scroller.addEventListener('scroll', placeVisible, { passive: true })

  return () => {
    stop()
    scroller.removeEventListener('scroll', placeVisible)
  }
}
