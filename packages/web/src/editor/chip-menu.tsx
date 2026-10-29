/* ---------- 弹出菜单（chip 的下拉：agent / 模型 / 思考 / 权限模式 / 工作目录面板）----------
 * 一个外壳一套行为：position: fixed，优先在 anchor 上方（输入卡在页底），放不下再翻到下方，高度封顶后内部滚动，
 * 水平夹在视口内；Esc / 点外面 / 窗口变化 / 页面滚动即关；↑↓ Home End 在可选项之间移焦点。
 * side 是侧边子菜单（模型 › 思考）：贴在 anchor 所在菜单的右侧，放不下翻到左侧。点子菜单不算点了父菜单的外面，
 * Esc 只关焦点所在的那一层。
 * 挂到 document.body（portal）：文档模式的 chip 在 ProseMirror widget 里，菜单不能被正文容器裁剪，
 * 也不能让 PM 把菜单里的点击当成编辑器事件。 */

import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const GAP = 6
const EDGE = 8
/** 子菜单与父菜单的间距；顶边上移一个菜单内边距加边框，让子菜单第一行与 anchor 那一行对齐 */
const SIDE_GAP = 4
const SIDE_LIFT = 7
/** 菜单封顶高度，再长（模型列表）就在菜单里滚 */
const MAX_HEIGHT = 360

interface Props {
  /** 定位锚（chip 按钮）。点它不算点外面：chip 自己负责开合，否则 pointerdown 关了 click 又开 */
  anchor: HTMLElement
  onClose: () => void
  label: string
  className?: string
  /** 打开时把焦点放到已选项 / 第一项，带输入框的面板（工作目录）自己管焦点 */
  focusItem?: boolean
  /** 侧边子菜单：anchor 是父菜单里的一项 */
  side?: boolean
  children: ReactNode
}

/** 菜单项的选择器：role=menuitemradio / menuitem，跳过禁用项（aria-disabled） */
const ITEM = '[role^="menuitem"]:not([aria-disabled="true"])'
/** 所有 ChipMenu 根节点都带这个属性，父子菜单靠它认出彼此 */
const MENU = '[data-chip-menu]'

function inMenu(node: unknown): boolean {
  return node instanceof Element && node.closest(MENU) != null
}

/** 焦点放到菜单里的已选项（没有就第一项）并滚进可视区，列表封顶后已选项可能在下面看不见 */
function focusChecked(menu: HTMLElement): void {
  const target = menu.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu.querySelector<HTMLElement>(ITEM)
  if (!target) return
  target.focus({ preventScroll: true })
  // 菜单是 position: fixed，即菜单项的 offsetParent
  const top = target.offsetTop
  const bottom = top + target.offsetHeight
  if (top < menu.scrollTop || bottom > menu.scrollTop + menu.clientHeight) {
    menu.scrollTop = top - (menu.clientHeight - target.offsetHeight) / 2
  }
}

export function ChipMenu({ anchor, onClose, label, className, focusItem = true, side = false, children }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  // onClose 每次渲染都是新函数，事件监听只装一次，用 ref 读最新的
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // 绘制前完成定位，不闪。放在上方时用 bottom 锚定，内容后来变高（目录列表加载）只会向上长
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const a = anchor.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    if (side) {
      const parent = (anchor.closest(MENU) ?? anchor).getBoundingClientRect()
      const cap = Math.min(MAX_HEIGHT, vh - 2 * EDGE)
      el.style.maxHeight = `${cap}px`
      el.style.top = `${Math.max(EDGE, Math.min(a.top - SIDE_LIFT, vh - EDGE - Math.min(el.scrollHeight, cap)))}px`
      const width = el.offsetWidth
      const right = parent.right + SIDE_GAP
      el.style.left = `${right + width <= vw - EDGE ? right : Math.max(EDGE, parent.left - SIDE_GAP - width)}px`
      el.dataset.placement = 'side'
      return
    }
    const roomAbove = a.top - GAP - EDGE
    const roomBelow = vh - a.bottom - GAP - EDGE
    const height = Math.min(el.scrollHeight, MAX_HEIGHT)
    const above = height <= roomAbove || roomAbove >= roomBelow
    const room = Math.min(MAX_HEIGHT, Math.max(120, above ? roomAbove : roomBelow))
    el.style.maxHeight = `${room}px`
    if (above) el.style.bottom = `${vh - a.top + GAP}px`
    else el.style.top = `${a.bottom + GAP}px`
    const width = el.offsetWidth
    el.style.left = `${Math.max(EDGE, Math.min(a.left, vw - width - EDGE))}px`
    el.dataset.placement = above ? 'above' : 'below'
  }, [anchor, side])

  useEffect(() => {
    const el = ref.current
    if (el && focusItem) focusChecked(el)
  }, [focusItem])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      // 点在任一层菜单里都不算外面：父菜单不因点子菜单而关，子菜单换一项时由宿主重新锚定
      if (!target || inMenu(target) || anchor.contains(target)) return
      closeRef.current()
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 焦点在另一层菜单里：归那一层关
      const active = document.activeElement
      if (active && !ref.current?.contains(active) && inMenu(active)) return
      e.preventDefault()
      closeRef.current()
      anchor.focus({ preventScroll: true })
    }
    const onScroll = (e: Event) => {
      // 菜单自己的列表滚动不算，父菜单也不管子菜单里的滚动；子菜单则要关，父菜单一滚它的 anchor 就挪走了
      if (e.target instanceof Node && ref.current?.contains(e.target)) return
      if (!side && inMenu(e.target)) return
      closeRef.current()
    }
    const onResize = () => closeRef.current()
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [anchor, side])

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])]
    if (items.length === 0) return
    // 在输入框里打字时，Home / End 归输入框
    if ((e.key === 'Home' || e.key === 'End') && e.target instanceof HTMLInputElement) return
    e.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLElement)
    let next = at
    if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    else next = at < 0 ? 0 : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus({ preventScroll: true })
  }

  return createPortal(
    <div
      ref={ref}
      className={`menu${className ? ` ${className}` : ''}`}
      data-chip-menu=""
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  )
}
