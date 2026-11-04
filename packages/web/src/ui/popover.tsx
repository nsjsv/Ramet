/* ---------- 集合界面的弹层：贴着触发元素的卡片（视图菜单、工具栏菜单、列菜单、单元格选择器共用） ----------
 * 挂到 document.body（createPortal）：集合页的内容列是 [data-flip]（侧栏开合时 FLIP 平移），带 transform 的祖先
 * 会让 fixed 后代跟着位移（[data-flip] 下不能有 fixed 后代）。
 * 外点 / Esc 关闭；弹层叠着开时只关最上面那层（点里层不关外层）。入场只动 opacity / transform（CSS 令牌）。 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** 打开着的弹层（按打开顺序）：外点判定与 Esc 只认最上面那层 */
const stack: HTMLElement[] = []

type Props = {
  /** 触发元素（点它不算外点，由调用方自己切换开合） */
  anchor: HTMLElement | null
  onClose: () => void
  children: ReactNode
  className?: string
  /** 'below' = 贴在触发元素下面（缺省）；'over' = 盖在它上面（单元格编辑） */
  place?: 'below' | 'over'
  /** 至少与触发元素同宽（下拉列表：比触发器窄会像是挂歪了）；'over' 恒同宽 */
  matchWidth?: boolean
}

export function Popover({ anchor, onClose, children, className, place = 'below', matchWidth = false }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; minWidth?: number } | null>(null)
  const close = useRef(onClose)
  close.current = onClose

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !anchor) return
    const place1 = (): void => {
      const r = anchor.getBoundingClientRect()
      const w = el.offsetWidth
      const h = el.offsetHeight
      const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8))
      let top = place === 'over' ? r.top : r.bottom + 4
      if (top + h > window.innerHeight - 8) top = Math.max(8, (place === 'over' ? r.bottom : r.top - 4) - h)
      const minWidth = place === 'over' || matchWidth ? r.width : undefined
      setPos((prev) => (prev && prev.left === left && prev.top === top && prev.minWidth === minWidth ? prev : { left, top, minWidth }))
    }
    place1()
    // 内容变高（选项多了、筛选条件加了）要重新定位，否则会伸出视口
    const ro = new ResizeObserver(place1)
    ro.observe(el)
    return () => ro.disconnect()
  }, [anchor, place, matchWidth])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    stack.push(el)
    const above = (): HTMLElement[] => stack.slice(stack.indexOf(el))
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node | null
      if (!target || above().some((p) => p.contains(target)) || onTrigger(anchor, target)) return
      close.current()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || stack[stack.length - 1] !== el) return
      e.preventDefault()
      e.stopPropagation()
      close.current()
    }
    // 外面滚动了（.main）：触发元素已经挪走，弹层留在原地会错位
    const onScroll = (e: Event): void => {
      if (e.target instanceof Node && above().some((p) => p.contains(e.target as Node))) return
      close.current()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      stack.splice(stack.indexOf(el), 1)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [anchor])

  return createPortal(
    <div
      ref={ref}
      className={'pop-card cl-pop' + (className ? ` ${className}` : '')}
      style={pos ? { left: pos.left, top: pos.top, minWidth: pos.minWidth } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  )
}

/** 点在触发元素上（不算外点）。以触发元素为控件的 <label>（包着它的、for 指向它的）也算：点 label 的文字会转发成一次点触发元素，
 *  这里先关的话那次点击又把弹层打开。控件是别的元素的 label 照常算外点 */
function onTrigger(anchor: HTMLElement | null, target: Node): boolean {
  if (!anchor) return false
  if (anchor.contains(target)) return true
  const labels = 'labels' in anchor ? (anchor as HTMLButtonElement).labels : null
  return labels ? [...labels].some((l) => l.contains(target)) : false
}

/** 从弹层里打开、盖在它上面的别的浮层（如列菜单里打开的公式编辑弹窗）：挂载期间登记进弹层栈。
 *  下面的弹层把点它、在它里面滚动都当作「点在上层里」，Esc 也只归栈顶 —— 否则点一下弹窗，下面的弹层就关了，
 *  连带卸载打开弹窗的组件，弹窗跟着消失 */
export function usePopoverLayer(el: HTMLElement | null): void {
  useEffect(() => {
    if (!el) return
    stack.push(el)
    return () => {
      const i = stack.indexOf(el)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [el])
}

/** 一个按钮开合一个弹层：返回 [触发元素（null = 关着）, 打开, 关闭] */
export function usePopover(): [HTMLElement | null, (el: HTMLElement) => void, () => void] {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return [anchor, (el) => setAnchor((cur) => (cur === el ? null : el)), () => setAnchor(null)]
}
