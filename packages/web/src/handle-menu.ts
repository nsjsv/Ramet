/* ---------- 手柄菜单的外壳：编辑器块手柄（editor/block-menu.ts）与集合表格行手柄（collection/row-menu.ts）共用 ----------
 * 一个挂 document.body 的卡片（.block-menu，样式在 styles/editor-widgets.css）：贴在手柄左侧、竖向对齐手柄中线，
 * 左边放不下翻到右侧；点外部 / Esc / 页面滚动关闭；同一手柄再点 = 关。菜单项左侧带图标格；
 * 「飞出」项（转换、移到…）点一下在主菜单旁弹出 / 收起独立面板（.block-menu-sub），面板项与主菜单项一样点完即关。
 * 菜单内容由调用方在 open 的 build 回调里拼：外壳只管弹层的生命周期、定位与菜单项的统一外观。 */
import { iconSvg, type IconName } from './icons'
import { motionMs } from './motion'

export type MenuIcon = { svg: IconName } | { text: string }
export type MenuEntry = { label: string; icon: MenuIcon; run: () => void }

export interface MenuBuilder {
  /** 菜单根元素：调用方把菜单项 append 进来（也可以放别的内容，如编辑信息） */
  readonly el: HTMLElement
  /** 菜单项（不自动 append）：按下不抢焦点，点击先关菜单再执行 */
  item(label: string, icon: MenuIcon, run: () => void): HTMLButtonElement
  /** 飞出项（不自动 append）：点开 / 收起旁边的面板，面板项由 entries 现算 */
  flyout(label: string, icon: MenuIcon, entries: () => MenuEntry[]): HTMLButtonElement
  /** 内容变高以后重新定位 */
  place(): void
  /** 这份菜单还开着（异步回填内容前判断） */
  alive(): boolean
}

export interface HandleMenu {
  /** 在 anchor（手柄）旁弹菜单；同一 anchor 已开着 = 关掉 */
  open(anchor: Element, build: (m: MenuBuilder) => void): void
  close(): void
  destroy(): void
}

/** 菜单项左侧的图标格：图标表里的图，或短文字（H1–H3） */
export function menuIcon(icon: MenuIcon): HTMLElement {
  const ic = document.createElement('span')
  ic.className = 'block-menu-ic'
  ic.setAttribute('aria-hidden', 'true')
  if ('svg' in icon) ic.innerHTML = iconSvg(icon.svg, 16)
  else ic.textContent = icon.text
  return ic
}

export function createHandleMenu(): HandleMenu {
  let menu: HTMLElement | null = null
  let openedAnchor: Element | null = null // 当前菜单属于哪个手柄（同手柄再点 = 关闭）
  let sub: HTMLElement | null = null // 飞出面板（独立 fixed 弹层，随主菜单同开同关）
  let subOwner: HTMLElement | null = null

  function closeSub(): void {
    if (!sub) return
    const panel = sub
    sub = null
    subOwner?.classList.remove('expanded')
    subOwner = null
    panel.classList.add('closing')
    window.setTimeout(() => panel.remove(), motionMs('--d-1')) // 与 .closing 的退场动画同一个令牌
  }

  function onDocMouseDown(e: Event): void {
    const target = e.target as Node | null
    // 菜单内 / 飞出面板内与锚（手柄）上的按下不算「点外」（锚上再按 = 开关或换块重弹，交给宿主触发逻辑）。
    // touchstart 同注册：部分触屏 tap 不合成 mousedown，只靠它关不掉菜单
    if (menu && target && (menu.contains(target) || sub?.contains(target) || openedAnchor?.contains(target))) return
    close()
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') close()
  }

  function onScroll(e: Event): void {
    // 菜单 / 面板自身内部滚动（max-height + overflow-y:auto）不是页面滚动，不能当作关闭时机
    const target = e.target as Node | null
    if (menu && target && menu.contains(target)) return
    if (sub && target && sub.contains(target)) return
    close()
  }

  /** 关菜单：先播淡出动画再摘 DOM；监听立刻摘（动画期间不再响应） */
  function close(): void {
    if (!menu) return
    document.removeEventListener('mousedown', onDocMouseDown, true)
    document.removeEventListener('touchstart', onDocMouseDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('scroll', onScroll, true)
    closeSub()
    const el = menu
    menu = null
    openedAnchor = null
    el.classList.add('closing')
    window.setTimeout(() => el.remove(), motionMs('--d-1')) // 与 block-menu-out 同一个令牌
  }

  function open(anchor: Element, build: (m: MenuBuilder) => void): void {
    // 同一手柄再点 = 开关：直接关掉，不做「消失又重弹」的闪烁
    if (menu && anchor === openedAnchor) {
      close()
      return
    }
    close() // 换手柄重弹：先关旧的再开新的
    const el = document.createElement('div')
    el.className = 'block-menu'

    const item = (label: string, icon: MenuIcon, run: () => void): HTMLButtonElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.append(menuIcon(icon), label)
      btn.addEventListener('mousedown', (e) => e.preventDefault()) // 不抢编辑器 / 表格焦点（同 slash 惯例）
      btn.addEventListener('click', () => {
        close()
        run()
      })
      return btn
    }

    // 飞出面板定位：左侧贴主菜单右缘、与飞出项顶对齐；右缘放不下翻到菜单左侧
    // （两侧都放不下钳回视口内）；底缘放不下向上收（面板底对齐飞出项底）
    const placeSub = (owner: HTMLElement): void => {
      if (!sub) return
      const mRect = el.getBoundingClientRect()
      const tRect = owner.getBoundingClientRect()
      const width = sub.offsetWidth
      const height = sub.offsetHeight
      const fitsRight = mRect.right + 4 + width <= window.innerWidth - 8
      const fitsLeft = mRect.left - 4 - width >= 8
      let left = fitsRight || !fitsLeft ? mRect.right + 4 : mRect.left - 4 - width
      left = Math.min(Math.max(left, 8), Math.max(8, window.innerWidth - 8 - width))
      const top = tRect.top + height > window.innerHeight - 8 ? Math.max(8, tRect.bottom - height - 6) : tRect.top
      sub.style.left = `${left}px`
      sub.style.top = `${top}px`
    }

    const flyout = (label: string, icon: MenuIcon, entries: () => MenuEntry[]): HTMLButtonElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'block-menu-turn'
      btn.append(menuIcon(icon))
      const text = document.createElement('span')
      text.textContent = label
      btn.append(text)
      btn.insertAdjacentHTML('beforeend', iconSvg('chevron', 8))
      btn.addEventListener('mousedown', (e) => e.preventDefault())
      btn.addEventListener('click', () => {
        const mine = subOwner === btn
        closeSub()
        if (mine) return
        const panel = document.createElement('div')
        panel.className = 'block-menu-sub'
        for (const entry of entries()) panel.appendChild(item(entry.label, entry.icon, entry.run))
        document.body.appendChild(panel)
        sub = panel
        subOwner = btn
        btn.classList.add('expanded')
        placeSub(btn) // 先挂载再量尺寸定位
      })
      return btn
    }

    // 锚定手柄左侧、菜单竖向居中对齐手柄中线；左边界：全宽页可以盖住侧栏（只守视口），
    // 非全宽守停靠侧栏的右缘。左侧放不下才翻到手柄右侧（再放不下钳回视口内）；上下超出视口就钳回视口内
    const place = (): void => {
      const rect = anchor.getBoundingClientRect()
      const width = el.offsetWidth
      const height = el.offsetHeight
      const sidebar = anchor.closest('.editor-page.full-width') ? null : document.querySelector('.app:not(.sidebar-collapsed) .sidebar')
      const minLeft = (sidebar ? sidebar.getBoundingClientRect().right : 0) + 8
      let left = rect.left - 6 - width
      if (left < minLeft) left = rect.right + 6
      left = Math.max(8, Math.min(left, window.innerWidth - 8 - width))
      const mid = rect.top + rect.height / 2
      const top = Math.max(8, Math.min(mid - height / 2, window.innerHeight - 8 - height))
      el.style.left = `${left}px`
      el.style.top = `${top}px`
    }

    build({ el, item, flyout, place, alive: () => menu === el })
    document.body.appendChild(el)
    place()
    menu = el
    openedAnchor = anchor
    document.addEventListener('mousedown', onDocMouseDown, true)
    document.addEventListener('touchstart', onDocMouseDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('scroll', onScroll, true)
  }

  return { open, close, destroy: close }
}
