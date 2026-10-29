/* ---------- 表格底部 / 右侧的「+」条：点一下加一行 / 一列，按住往外拉加多行 / 多列、往回收删末尾空行 / 空列 ----------
 * 两条都挂在横向滚动层（table-view.ts 的 div.table-scroll）里、绝对定位，跟着表格一起横向滚动：
 *   底部条贴在表格下沿，宽 = 表格宽（滚动层底部 padding 给它留了位，不压下一个块）；
 *   右侧条贴着表格右缘，高 = 表格高（落在滚动层右边伸出的那段里，table-scroll.ts 保证至少伸出条宽）。
 * 平时透明，只有指针落在条自己的命中区里才显示（CSS :hover），碰表格别处不出。
 * 拖动只画预览（挂 body 的 fixed：跟手的条、新增区虚线格 / 要收掉的行列标红、「几行 × 几列」标签），
 * 松手一个事务写入（table-ops 的 growRows / growCols），一步撤销，拖回起点等于不变。与拖列宽一样，拖的过程中不碰文档。
 * 往外按预估行高 / 新列宽一格一格吸附；往回按末尾每行 / 每列的实际尺寸吸附（过半算一格），只收到 shrinkable* 为止。 */

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { iconSvg } from '../icons'
import { growCols, growRows, NEW_COL_WIDTH, shrinkableCols, shrinkableRows } from './table-ops'
import { measureColWidths } from './table-widths'

type Axis = 'row' | 'col'

/** 按下后移动不到这么多像素，松手算点击（加 1） */
const CLICK_SLOP = 3
/** 量不出行高时的兜底（单行正文格：上下 padding 7 + 一行字 + 底线） */
const FALLBACK_ROW = 36

type Deps = {
  view: EditorView
  block: HTMLElement
  scroller: HTMLElement
  table: HTMLTableElement
  tbody: HTMLElement
  getNode: () => PMNode
  getPos: () => number | undefined
}

export type TableGrow = {
  /** 挂进滚动层 */
  bars: HTMLElement[]
  /** 按表格当前尺寸重新摆两条（table-scroll.ts 在表格尺寸 / 伸出量变了时调） */
  layout: () => void
  /** 事件目标落在条上：nodeView 的 stopEvent 据此不让 PM 处理 */
  owns: (target: Node) => boolean
  destroy: () => void
}

export function tableGrow({ view, block, scroller, table, tbody, getNode, getPos }: Deps): TableGrow {
  const makeBar = (axis: Axis): HTMLElement => {
    const bar = document.createElement('div')
    bar.className = `table-add is-${axis}`
    bar.contentEditable = 'false'
    bar.title = axis === 'row' ? '点击加一行，拖动加多行' : '点击加一列，拖动加多列'
    bar.innerHTML = iconSvg('plus', 14)
    return bar
  }
  const rowBar = makeBar('row')
  const colBar = makeBar('col')

  /* 用滚动层的内容坐标摆位（滚动层 position: relative），条才跟着表格滚 */
  const layout = (): void => {
    rowBar.style.left = `${table.offsetLeft}px`
    rowBar.style.top = `${table.offsetTop + table.offsetHeight}px`
    rowBar.style.width = `${table.offsetWidth}px`
    colBar.style.left = `${table.offsetLeft + table.offsetWidth}px`
    colBar.style.top = `${table.offsetTop}px`
    colBar.style.height = `${table.offsetHeight}px`
  }

  /** 新行高的估计：正文行里最矮的那行（多半就是单行） */
  const rowStep = (): number => {
    let min = Infinity
    for (const tr of [...tbody.children].slice(1)) min = Math.min(min, (tr as HTMLElement).offsetHeight)
    return Number.isFinite(min) && min > 0 ? min : FALLBACK_ROW
  }

  /** 末尾 count 行 / 列的实际高 / 宽，从最后一条往前排 */
  const trailingSizes = (axis: Axis, count: number): number[] => {
    if (count < 1) return []
    const items = axis === 'row' ? [...tbody.children] : [...(tbody.firstElementChild?.children ?? [])]
    return items
      .slice(-count)
      .reverse()
      .map((el) => (axis === 'row' ? (el as HTMLElement).offsetHeight : el.getBoundingClientRect().width))
  }

  let cancelDrag: (() => void) | null = null

  const start = (axis: Axis, event: MouseEvent): void => {
    if (!view.editable || event.button !== 0) return
    event.preventDefault() // 不抢编辑器焦点 / 不起选区
    event.stopPropagation()
    const node = getNode()
    const rows = node.childCount
    const cols = node.firstChild?.childCount ?? 0 // 表头行的格数
    const step = axis === 'row' ? rowStep() : NEW_COL_WIDTH
    const back = trailingSizes(axis, axis === 'row' ? shrinkableRows(node) : shrinkableCols(node))
    const bar = axis === 'row' ? rowBar : colBar
    const origin = axis === 'row' ? event.clientY : event.clientX
    let n = 1 // 没拖动算点击，加一
    let shrunk = 0 // 往回收掉的像素（n < 0 时）
    let moved = false

    const ghost = document.createElement('div')
    ghost.className = `table-grow-ghost is-${axis}`
    ghost.style.setProperty('--step', `${step}px`)
    const handle = document.createElement('div')
    handle.className = `table-grow-handle is-${axis}`
    handle.innerHTML = iconSvg('plus', 14)
    const label = document.createElement('div')
    label.className = 'table-grow-label'
    bar.classList.add('is-dragging')

    const paint = (e: MouseEvent): void => {
      // 表格看得见的那段，宽表格两头可能滚在滚动层外
      const t = table.getBoundingClientRect()
      const s = scroller.getBoundingClientRect()
      const left = Math.max(t.left, s.left)
      const right = Math.min(t.right, s.right)
      const place = (el: HTMLElement, x: number, y: number, width: number | null, height: number | null): void => {
        el.style.left = `${x}px`
        el.style.top = `${y}px`
        if (width !== null) el.style.width = `${width}px`
        if (height !== null) el.style.height = `${height}px`
      }
      if (axis === 'row') {
        const edge = n >= 0 ? t.bottom + n * step : t.bottom - shrunk
        place(ghost, left, Math.min(edge, t.bottom), right - left, Math.abs(edge - t.bottom))
        place(handle, left, edge, right - left, null)
      } else {
        const edge = n >= 0 ? right + n * step : right - shrunk
        place(ghost, Math.min(edge, right), t.top, Math.abs(edge - right), t.height)
        place(handle, edge, t.top, null, t.height)
      }
      ghost.hidden = n === 0
      ghost.classList.toggle('is-remove', n < 0)
      label.textContent = `${rows + (axis === 'row' ? n : 0)} 行 × ${cols + (axis === 'col' ? n : 0)} 列`
      label.style.left = `${e.clientX + 14}px`
      label.style.top = `${e.clientY + 14}px`
    }
    const move = (e: MouseEvent): void => {
      const d = (axis === 'row' ? e.clientY : e.clientX) - origin
      if (!moved && Math.abs(d) < CLICK_SLOP) return
      if (!moved) {
        document.body.append(ghost, handle, label)
        block.classList.add('is-growing') // 原位的条藏起来，由跟手的 handle 顶上
      }
      moved = true
      if (d >= 0) {
        n = Math.round(d / step)
        shrunk = 0
      } else {
        let k = 0
        shrunk = 0
        while (k < back.length && -d >= shrunk + back[k]! / 2) shrunk += back[k++]!
        n = -k
      }
      paint(e)
    }
    const end = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      ghost.remove()
      handle.remove()
      label.remove()
      bar.classList.remove('is-dragging')
      block.classList.remove('is-growing')
      cancelDrag = null
    }
    const up = (): void => {
      end()
      const pos = getPos()
      if (n === 0 || pos === undefined || view.isDestroyed) return
      const command = axis === 'row' ? growRows(pos, n) : growCols(pos, n, measureColWidths(tbody))
      command(view.state, view.dispatch)
      // 加出来的列超出滚动层：滚到最右让人看见
      if (axis === 'col' && n > 0 && scroller.scrollWidth > scroller.clientWidth) scroller.scrollLeft = scroller.scrollWidth
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    cancelDrag = end
  }
  rowBar.addEventListener('mousedown', (e) => start('row', e))
  colBar.addEventListener('mousedown', (e) => start('col', e))

  return {
    bars: [rowBar, colBar],
    layout,
    owns: (target) => rowBar.contains(target) || colBar.contains(target),
    destroy: () => cancelDrag?.(),
  }
}
