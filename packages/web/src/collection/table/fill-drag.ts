/* ---------- 填充柄的拖动：按下小方块 → 跟着鼠标算拖过的行 → 松手填充（TableView 用） ----------
 * 鼠标所在的行按纵坐标在看得见的行里找（落在分组头 / 表格外也认最近的一行），只看上下、不看左右。
 * 拖到视口上下边缘时页面自己滚（滚动后按最后的鼠标位置重算）；Esc 取消。 */
import { useEffect, useRef, useState } from 'react'
import type { CellBox } from './cell-range'
import { fillSpan, type FillSpan } from './fill'

const EDGE = 48
const SPEED = 14

type Opts = {
  /** 表格根：在它里面找 .cl-row[data-row-id] */
  table: React.RefObject<HTMLElement | null>
  /** 行 id → 看得见的行的下标（折叠段里的行没有） */
  indexOf: (rowId: string) => number | undefined
  onFill: (box: CellBox, span: FillSpan) => void
}

export function useFillDrag(opts: Opts): { span: FillSpan | null; start: (e: React.MouseEvent, box: CellBox) => void } {
  const [span, setSpan] = useState<FillSpan | null>(null)
  const latest = useRef(opts)
  latest.current = opts
  const stop = useRef<(() => void) | null>(null)
  useEffect(() => () => stop.current?.(), [])

  const start = (e: React.MouseEvent, box: CellBox): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    stop.current?.()
    let y = e.clientY
    let cur: FillSpan | null = null
    let frame = 0

    const rowAt = (): number | undefined => {
      const els = [...(latest.current.table.current?.querySelectorAll<HTMLElement>('.cl-row[data-row-id]') ?? [])]
      let best: { at: number; d: number } | undefined
      for (const el of els) {
        const at = latest.current.indexOf(el.dataset.rowId ?? '')
        if (at === undefined) continue
        const r = el.getBoundingClientRect()
        const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0
        if (!best || d < best.d) best = { at, d }
        if (d === 0) break
      }
      return best?.at
    }
    const update = (): void => {
      const at = rowAt()
      const next = at === undefined ? null : fillSpan(box, at)
      if (next?.r0 === cur?.r0 && next?.r1 === cur?.r1) return
      cur = next
      setSpan(next)
    }
    // 贴着视口上下边缘：页面跟着滚，滚完按同一个鼠标位置重算
    const tick = (): void => {
      const dy = y > window.innerHeight - EDGE ? SPEED : y < EDGE ? -SPEED : 0
      if (dy !== 0) {
        window.scrollBy(0, dy)
        update()
      }
      frame = requestAnimationFrame(tick)
    }
    const move = (ev: MouseEvent): void => {
      y = ev.clientY
      update()
    }
    const end = (commit: boolean): void => {
      cancelAnimationFrame(frame)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('keydown', key, true)
      document.body.classList.remove('is-cl-filling')
      stop.current = null
      setSpan(null)
      if (commit && cur) latest.current.onFill(box, cur)
    }
    const up = (): void => end(true)
    const key = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      end(false)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    window.addEventListener('keydown', key, true)
    document.body.classList.add('is-cl-filling')
    stop.current = () => end(false)
    frame = requestAnimationFrame(tick)
  }

  return { span, start }
}
