/* ---------- 框选：在集合视图的空白处按下拖动，选中与框相交的行 / 卡片（表格与看板共用） ----------
 * 移动 ≥ 4px 才算框选，否则是一次空白处单击（清空选择）。Shift / ⌘ / Ctrl 起框 = 追加到已有选择上。
 * 不 preventDefault 按下事件（会压掉兼容的 mousedown，弹层的外点关闭就失灵了）：手势期间拦 selectstart 不起文字选区。
 * 正文里的集合块：nodeView 的 stopEvent 吃掉块里的事件，ProseMirror 不会起选区。
 * 框是 portal 到 body 的 position: fixed 元素（祖先有 transform 时 fixed 会错位）。
 * 正文列外拖选（editor/block-select.ts）起于集合块旁、没拖出这块时，经 bandSelect 把选框转过来选条目（不整块选）。 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { hitIds, type Box } from './selection'

/** 这些元素上按下不起框（交给它们自己的点击 / 拖动） */
const NO_START = 'button, input, textarea, select, a, label, [contenteditable], [draggable="true"], .cl-bulk'
const THRESHOLD = 4

/* ---------- 带状选择：列外拖选转给块里的框选根 ---------- */

const BAND_EVENT = 'ramet:marquee-band'
const ROOT_ATTR = 'data-marquee'
/** 列外拖选框（视口坐标）；null = 清掉带状选出的条目 */
export type Band = Box | null
type BandDetail = { band: Band; done: boolean }

/** 给块里的框选根派一次带状选择：同样按与框相交判定，框还没伸到条目上就什么都不选
 *  （只看竖直范围的话，框远在表格左边也会选中整排行）；done = 松手，选到了就把焦点交给视图（Options.focus）。
 *  块里没有框选根（加载中、只读）= false，调用方照旧整块选 */
export function bandSelect(block: Element, band: Band, done = false): boolean {
  const roots = block.querySelectorAll(`[${ROOT_ATTR}]`)
  const detail: BandDetail = { band, done }
  roots.forEach((el) => el.dispatchEvent(new CustomEvent(BAND_EVENT, { detail })))
  return roots.length > 0
}

/** root 里与框相交的条目 id */
function hitsIn(root: HTMLElement, o: Pick<Options, 'item' | 'idOf'>, box: Box): string[] {
  const items = [...root.querySelectorAll<HTMLElement>(o.item)].flatMap((node) => {
    const id = o.idOf(node)
    if (!id) return []
    const r = node.getBoundingClientRect()
    return [{ id, left: r.left, top: r.top, right: r.right, bottom: r.bottom }]
  })
  return [...new Set(hitIds(items, box))]
}

type Options = {
  root: React.RefObject<HTMLElement | null>
  /** 条目的选择器与 id（data 属性） */
  item: string
  idOf: (el: HTMLElement) => string | undefined
  /** 视图自己的额外禁区（如表格的单元格） */
  avoid?: string
  disabled: boolean
  /** 起框时的选择（追加模式的底） */
  current: () => ReadonlySet<string>
  onBox: (base: ReadonlySet<string>, ids: string[]) => void
  onClick: () => void
  /** 带状选择松手后焦点给谁（表格：表格本身，Esc 等键位才收得到）；缺省 = 只把焦点移出正文 */
  focus?: () => void
}

export function useMarquee(o: Options): { onPointerDown: (e: React.PointerEvent) => void; layer: React.ReactNode } {
  const [box, setBox] = useState<Box | null>(null)
  const opts = useRef(o)
  opts.current = o
  const stop = useRef<(() => void) | null>(null)
  useEffect(() => () => stop.current?.(), [])

  // 带状选择的接收端：root 在加载完才挂上、disabled 会变，每次渲染重挂（只是增删一个监听）
  useEffect(() => {
    const el = o.root.current
    if (!el || o.disabled) return
    const onBand = (e: Event): void => {
      const { band, done } = (e as CustomEvent<BandDetail>).detail
      const ids = band ? hitsIn(el, opts.current, band) : []
      opts.current.onBox(new Set(), ids)
      if (!done || ids.length === 0) return
      // 列外按下被 preventDefault，焦点还在正文里：不挪走的话随后的退格删的是正文的字
      const { focus } = opts.current
      if (focus) focus()
      else if (document.activeElement instanceof HTMLElement && document.activeElement.isContentEditable) document.activeElement.blur()
    }
    el.setAttribute(ROOT_ATTR, '')
    el.addEventListener(BAND_EVENT, onBand)
    return () => {
      el.removeAttribute(ROOT_ATTR)
      el.removeEventListener(BAND_EVENT, onBand)
    }
  })

  const onPointerDown = (e: React.PointerEvent): void => {
    const { disabled, avoid, root } = opts.current
    const target = e.target as Element
    if (disabled || e.button !== 0 || !root.current || target.closest(NO_START) || (avoid && target.closest(avoid))) return
    const x0 = e.clientX
    const y0 = e.clientY
    const additive = e.shiftKey || e.metaKey || e.ctrlKey
    const base = additive ? new Set(opts.current.current()) : new Set<string>()
    let active = false
    let frame = 0
    let last: PointerEvent | null = null

    const update = (): void => {
      frame = 0
      const ev = last
      const el = opts.current.root.current
      if (!ev || !el) return
      const next = { left: Math.min(x0, ev.clientX), top: Math.min(y0, ev.clientY), right: Math.max(x0, ev.clientX), bottom: Math.max(y0, ev.clientY) }
      setBox(next)
      opts.current.onBox(base, hitsIn(el, opts.current, next))
    }
    const move = (ev: PointerEvent): void => {
      if (!active && Math.hypot(ev.clientX - x0, ev.clientY - y0) < THRESHOLD) return
      if (!active) window.getSelection()?.removeAllRanges()
      active = true
      last = ev
      if (!frame) frame = requestAnimationFrame(update)
    }
    const up = (): void => {
      const clicked = !active
      done()
      if (clicked && !additive) opts.current.onClick()
    }
    const done = (): void => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', done)
      document.removeEventListener('selectstart', noSelect)
      stop.current = null
      setBox(null)
    }
    const noSelect = (ev: Event): void => ev.preventDefault()
    stop.current?.()
    stop.current = done
    document.addEventListener('selectstart', noSelect)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', done)
  }

  const layer = box
    ? createPortal(
        <div className="cl-marquee" style={{ left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top }} />,
        document.body,
      )
    : null
  return { onPointerDown, layer }
}
