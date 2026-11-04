// ---------- 悬停提示：元素写上 data-tip="文字" 就有，替代浏览器自带的 title 小窗 ----------
// 全局一个委托监听 + 一个挂在 body 上的浮层（fixed），不给每个按钮包组件：列表里按钮再多也不多挂监听，也不改 DOM 结构。
// 默认在元素上方居中，上方放不下翻到下方，左右夹在视口里；显示期间逐帧跟着元素走（布局变动、元素被卸掉都能跟上）。
// 停留 DELAY_MS 才出；刚收起一个又移到下一个上，立刻出（沿工具栏扫过去不用每个都等）。
// 只认鼠标 / 触控笔：触屏点一下也派发 pointerover，提示会闪出来且收不掉。键盘 Tab 聚焦（:focus-visible）也出。
// 按下、按键、滚轮、窗口失焦都收起（只认用户滚动：对话流式输出时的自动滚动不该把提示收掉）；点过的元素在指针移开前不再出；元素弹着自己的菜单（aria-expanded=true）不出，免得压住菜单。
// 浮层只是视觉提示（aria-hidden），读屏靠元素自己的 aria-label。

const DELAY_MS = 500
const WARM_MS = 400
const GAP = 6
const EDGE = 8

let tip: HTMLDivElement | null = null
let shown: HTMLElement | null = null
let pending: HTMLElement | null = null
let muted: HTMLElement | null = null
let timer = 0
let frame = 0
let hiddenAt = -Infinity

function tipEl(): HTMLDivElement {
  if (!tip) {
    tip = document.createElement('div')
    tip.className = 'tip'
    tip.setAttribute('aria-hidden', 'true')
    document.body.append(tip)
  }
  return tip
}

function tipTarget(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element ? node.closest<HTMLElement>('[data-tip]') : null
}

function blocked(anchor: HTMLElement): boolean {
  return !anchor.isConnected || !anchor.dataset.tip || anchor.getAttribute('aria-expanded') === 'true'
}

function place(anchor: HTMLElement, box: HTMLDivElement): void {
  const r = anchor.getBoundingClientRect()
  const w = box.offsetWidth
  const h = box.offsetHeight
  const above = r.top - GAP - h >= EDGE
  const top = above ? r.top - GAP - h : r.bottom + GAP
  const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, EDGE), window.innerWidth - EDGE - w)
  box.style.left = `${Math.round(left)}px`
  box.style.top = `${Math.round(top)}px`
  box.dataset.side = above ? 'top' : 'bottom'
}

function follow(): void {
  frame = 0
  if (!shown || !tip) return
  if (blocked(shown)) {
    hide()
    return
  }
  const text = shown.dataset.tip ?? ''
  if (tip.textContent !== text) tip.textContent = text
  place(shown, tip)
  frame = requestAnimationFrame(follow)
}

function show(anchor: HTMLElement): void {
  if (blocked(anchor)) return
  const box = tipEl()
  box.textContent = anchor.dataset.tip ?? ''
  place(anchor, box)
  box.classList.add('is-on')
  shown = anchor
  frame = requestAnimationFrame(follow)
}

function hide(): void {
  window.clearTimeout(timer)
  timer = 0
  pending = null
  cancelAnimationFrame(frame)
  frame = 0
  if (shown) hiddenAt = performance.now()
  shown = null
  tip?.classList.remove('is-on')
}

function schedule(anchor: HTMLElement): void {
  if (performance.now() - hiddenAt < WARM_MS) {
    show(anchor)
    return
  }
  pending = anchor
  timer = window.setTimeout(() => {
    pending = null
    show(anchor)
  }, DELAY_MS)
}

export function installTips(): void {
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return
    const anchor = tipTarget(e.target)
    if (anchor !== muted) muted = null
    if (anchor !== null && (anchor === shown || anchor === pending)) return
    hide()
    if (anchor && anchor !== muted && e.buttons === 0) schedule(anchor)
  })
  document.addEventListener('pointerout', (e) => {
    if (e.relatedTarget === null) hide() // 移出窗口
  })
  document.addEventListener(
    'pointerdown',
    (e) => {
      muted = tipTarget(e.target)
      hide()
    },
    true,
  )
  document.addEventListener('focusin', (e) => {
    const anchor = tipTarget(e.target)
    if (anchor && anchor === e.target && anchor.matches(':focus-visible') && anchor !== shown) {
      hide()
      show(anchor)
    }
  })
  document.addEventListener('focusout', (e) => {
    if (shown && e.target === shown) hide()
  })
  document.addEventListener('keydown', hide, true)
  document.addEventListener('wheel', hide, { capture: true, passive: true })
  window.addEventListener('blur', hide)
}
