/* ---------- 表格 nodeView：「⋯」菜单 + 拖列宽 + 底部 / 右侧「+」条 + 横向滚动 ----------
 * dom = div.table-block（定位块，宽 = 正文列，不裁剪）
 *   ├ button.table-menu-btn（外壳，contenteditable=false；光标在表格里时显示，钉在表格可见段的右上角）
 *   └ div.table-scroll（横向可滚，伸出正文列铺到画面两边，table-scroll.ts）
 *       ├ table > colgroup（nodeView 自管）+ tbody（contentDOM）
 *       ├ div.table-col-line（外壳：指针所在 / 正在拖的列分隔线高亮，pointer-events: none）
 *       └ div.table-add × 2（外壳：底部加行 / 右侧加列，table-grow.ts）
 * 菜单动作全在 table-ops.ts（纯命令，单事务可撤销）；这里只负责摆按钮、算可用性、调命令。
 * 拖列宽：指针落在列分隔线左右 5px 内，包裹层挂 is-col-resize（光标变成 col-resize）并高亮这根线；按下开始拖，期间只改 colgroup
 * 与 table 的宽（ignoreMutation 忽略，PM 不会重画回去），松手一次 setNodeMarkup 写 colwidths（table-widths.ts）。
 * 公开页不挂本 nodeView：表格 toDOM 已按 colwidths 画 colgroup（block-id.ts 的 tableIdSchema）。 */

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $view } from '@milkdown/kit/utils'
import { iconSvg } from '../icons'
import { tableIdSchema } from './block-id'
import { tableGrow } from './table-grow'
import { tableScroll } from './table-scroll'
import {
  addCol,
  addRow,
  alignColumn,
  availability,
  columnAlign,
  deleteCol,
  deleteRow,
  moveCol,
  moveRow,
  removeTable,
  tableInfo,
} from './table-ops'
import { formatColWidths, measureColWidths, MIN_COL_WIDTH, usableWidths } from './table-widths'

const EDGE = 5

type MenuItem = { label: string; run: Parameters<typeof runCommand>[1]; enabled: boolean; checked?: boolean; danger?: boolean }

function runCommand(view: EditorView, command: (state: EditorView['state'], dispatch?: EditorView['dispatch']) => boolean): void {
  command(view.state, view.dispatch)
  view.focus()
}

// 菜单挂 body，一次只开一个
let openMenu: (() => void) | null = null

/** measured 是这张表各列现宽，没调过列宽的表格插列时定下来（table-ops 的 addCol） */
function showMenu(view: EditorView, anchor: HTMLElement, measured: number[]): void {
  openMenu?.()
  const info = tableInfo(view.state)
  if (!info) return
  const can = availability(info)
  const align = columnAlign(view.state)
  const sections: Array<{ title: string; items: MenuItem[] }> = [
    {
      title: '行',
      items: [
        { label: '上方插入一行', run: addRow('above'), enabled: can.rowAbove },
        { label: '下方插入一行', run: addRow('below'), enabled: can.rowBelow },
        { label: '上移', run: moveRow(-1), enabled: can.rowUp },
        { label: '下移', run: moveRow(1), enabled: can.rowDown },
        { label: '删除这一行', run: deleteRow, enabled: can.rowDelete, danger: true },
      ],
    },
    {
      title: '列',
      items: [
        { label: '左侧插入一列', run: addCol('left', measured), enabled: can.colLeft },
        { label: '右侧插入一列', run: addCol('right', measured), enabled: can.colRight },
        { label: '左移', run: moveCol(-1), enabled: can.colMoveLeft },
        { label: '右移', run: moveCol(1), enabled: can.colMoveRight },
        { label: '删除这一列', run: deleteCol, enabled: can.colDelete, danger: true },
      ],
    },
    {
      title: '这一列对齐',
      items: (['left', 'center', 'right'] as const).map((a) => ({
        label: { left: '左对齐', center: '居中', right: '右对齐' }[a],
        run: alignColumn(a),
        enabled: true,
        checked: align === a,
      })),
    },
    { title: '表格', items: [{ label: '删除表格', run: removeTable, enabled: true, danger: true }] },
  ]

  const box = document.createElement('div')
  box.className = 'pop-card table-menu'
  for (const section of sections) {
    const head = document.createElement('div')
    head.className = 'pop-section'
    head.textContent = section.title
    box.append(head)
    for (const item of section.items) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'pop-row' + (item.danger ? ' is-danger' : '')
      row.disabled = !item.enabled
      const name = document.createElement('span')
      name.className = 'pop-t'
      name.textContent = item.label
      row.append(name)
      if (item.checked) row.insertAdjacentHTML('beforeend', `<span class="pop-aside">${iconSvg('check', 14)}</span>`)
      row.addEventListener('mousedown', (e) => e.preventDefault()) // 不抢编辑器焦点：命令按当前格执行
      row.addEventListener('click', () => {
        close()
        runCommand(view, item.run)
      })
      box.append(row)
    }
  }
  const close = (): void => {
    box.remove()
    document.removeEventListener('mousedown', onOutside, true)
    document.removeEventListener('keydown', onKey, true)
    if (openMenu === close) openMenu = null
  }
  function onOutside(e: MouseEvent): void {
    if (!box.contains(e.target as Node) && !anchor.contains(e.target as Node)) close()
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') close()
  }
  document.body.append(box)
  const rect = anchor.getBoundingClientRect()
  box.style.left = `${Math.max(8, Math.min(rect.right - box.offsetWidth, window.innerWidth - box.offsetWidth - 8))}px`
  const below = rect.bottom + 4
  box.style.top = `${below + box.offsetHeight > window.innerHeight - 8 ? Math.max(8, rect.top - box.offsetHeight - 4) : below}px`
  document.addEventListener('mousedown', onOutside, true)
  document.addEventListener('keydown', onKey, true)
  openMenu = close
}

function columnCount(node: PMNode): number {
  return node.firstChild?.childCount ?? 0
}

export const tableView = $view(tableIdSchema.node, () => {
  return (initial: PMNode, view: EditorView, getPos: () => number | undefined) => {
    let node = initial
    const dom = document.createElement('div')
    dom.className = 'table-block'
    const scroller = document.createElement('div')
    scroller.className = 'table-scroll'
    const menuBtn = document.createElement('button')
    menuBtn.type = 'button'
    menuBtn.className = 'table-menu-btn'
    menuBtn.contentEditable = 'false'
    menuBtn.title = '表格操作'
    menuBtn.innerHTML = iconSvg('more', 16)
    const table = document.createElement('table')
    const colgroup = document.createElement('colgroup')
    const tbody = document.createElement('tbody')
    table.append(colgroup, tbody)
    const line = document.createElement('div')
    line.className = 'table-col-line'
    line.contentEditable = 'false'
    line.hidden = true
    const grow = tableGrow({ view, block: dom, scroller, table, tbody, getNode: () => node, getPos })
    scroller.append(table, line, ...grow.bars)
    dom.append(menuBtn, scroller)
    const unscroll = tableScroll({ view, block: dom, scroller, table, onLayout: grow.layout })

    const paintWidths = (widths: number[]): void => {
      table.classList.toggle('has-colwidths', widths.length > 0)
      table.style.width = widths.length ? `${widths.reduce((a, b) => a + b, 0)}px` : ''
      colgroup.replaceChildren(
        ...widths.map((w) => {
          const col = document.createElement('col')
          col.style.width = `${w}px`
          return col
        }),
      )
    }
    const paint = (): void => {
      menuBtn.hidden = !view.editable
      paintWidths(usableWidths(node.attrs.colwidths, columnCount(node)))
    }

    menuBtn.addEventListener('mousedown', (e) => e.preventDefault())
    menuBtn.addEventListener('click', () => showMenu(view, menuBtn, measureColWidths(tbody)))

    /* 拖列宽 */
    // 指针所在列分隔线左侧那一列的下标：落在某格右缘内，或下一格左缘内（首列左框不可拖）
    const edgeAt = (event: MouseEvent): number | null => {
      const cell = (event.target as HTMLElement | null)?.closest('td, th')
      if (!(cell instanceof HTMLTableCellElement) || !tbody.contains(cell)) return null
      const rect = cell.getBoundingClientRect()
      if (rect.right - event.clientX <= EDGE) return cell.cellIndex
      if (event.clientX - rect.left <= EDGE && cell.cellIndex > 0) return cell.cellIndex - 1
      return null
    }
    // 高亮第 col 列的右框，null 收起。线在滚动层的内容坐标里，横向滚动时跟着表格走
    const showLine = (col: number | null): void => {
      dom.classList.toggle('is-col-resize', col !== null)
      const cell = col === null ? undefined : tbody.querySelector('tr')?.children[col]
      if (!cell) {
        line.hidden = true
        return
      }
      line.hidden = false
      const origin = scroller.getBoundingClientRect().left - scroller.scrollLeft
      const border = cell.getBoundingClientRect().right - 0.5 - origin // 1px 右框的中线
      // 最右一列的线往里收：伸出表格右缘会撑出横向滚动条
      const right = table.offsetLeft + table.offsetWidth - line.offsetWidth
      line.style.left = `${Math.min(border - line.offsetWidth / 2, right)}px`
      line.style.top = `${table.offsetTop}px`
      line.style.height = `${table.offsetHeight}px`
    }
    let dragging = false
    dom.addEventListener('mousemove', (event) => {
      if (!view.editable || event.buttons) return
      showLine(edgeAt(event))
    })
    dom.addEventListener('mouseleave', () => {
      if (!dragging) showLine(null) // 拖动中指针出了表格照样跟手，松手再按落点决定
    })
    dom.addEventListener('mousedown', (event) => {
      if (!view.editable || event.button !== 0) return
      const col = edgeAt(event)
      if (col === null) return
      event.preventDefault()
      event.stopPropagation()
      const start = measureColWidths(tbody)
      if (!start.length) return
      const x0 = event.clientX
      let widths = start
      dragging = true
      const move = (e: MouseEvent): void => {
        widths = start.map((w, i) => (i === col ? Math.max(MIN_COL_WIDTH, w + e.clientX - x0) : w))
        paintWidths(widths)
        showLine(col)
      }
      const up = (e: MouseEvent): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        dragging = false
        showLine(edgeAt(e)) // 松手时还停在分隔线上就继续高亮
        const pos = getPos()
        if (pos === undefined || view.isDestroyed) return
        const current = view.state.doc.nodeAt(pos)
        if (!current || current.type !== node.type) return
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, colwidths: formatColWidths(widths) }))
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })

    paint()
    return {
      dom,
      contentDOM: tbody,
      update(next: PMNode) {
        if (next.type !== node.type) return false
        node = next
        paint()
        return true
      },
      stopEvent(event: Event) {
        const target = event.target as Node | null
        if (target && (menuBtn.contains(target) || grow.owns(target))) return true
        return event.type === 'mousedown' && dom.classList.contains('is-col-resize')
      },
      ignoreMutation(mutation: { type: string; target: Node }) {
        if (mutation.type === 'selection') return false
        return !tbody.contains(mutation.target)
      },
      destroy() {
        grow.destroy()
        unscroll()
      },
    }
  }
})
