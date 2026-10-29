/* ---------- 让位：工作台面板挡住正文列时，正文列整体左移 ----------
 * 不用 transform 挪正文列：它会成为 position:fixed 后代的包含块，编辑器里的浮层（斜杠菜单等）全会错位。
 * 改的是布局：给 .main 加右内边距（正文列 margin:auto 居中，自然左移），再用 flip() 把这一步平移过去（只在动画期间有 transform）。
 * 手机宽度下面板是底部抽屉，不让位；左边没地方可让就让到贴边为止。
 * 全宽页（.full-width，正文列铺满 .main）没有左右余量可分：右内边距加多少、右缘就缩回多少，缩到 MIN_FULL 为止。 */
import { flip } from '../motion'

const GAP = 16
const MOBILE = 760
const MIN_FULL = 480

function pad(main: HTMLElement, px: number): void {
  const page = main.querySelector<HTMLElement>('.editor-page')
  const set = (): void => {
    if (px > 0) main.style.setProperty('padding-right', `${px}px`)
    else main.style.removeProperty('padding-right')
  }
  if (page) flip([page], set)
  else set()
}

/** 面板开着（panel = 浮着的面板）→ 算要让多少；关了 → 复位。返回清理函数（复位） */
export function makeRoom(panel: HTMLElement | null): () => void {
  const main = document.querySelector<HTMLElement>('.main')
  if (!main) return () => undefined
  const measure = (): void => {
    const page = main.querySelector<HTMLElement>('.editor-page')
    if (!panel || !page || window.innerWidth <= MOBILE) return pad(main, 0)
    const current = parseFloat(main.style.paddingRight) || 0
    const p = panel.getBoundingClientRect()
    const c = page.getBoundingClientRect()
    const m = main.getBoundingClientRect()
    const full = page.classList.contains('full-width')
    // 不让位时正文列的右缘 = 现在的右缘 + 已经让出去的（居中列是一半：margin:auto 两边各分一半；全宽列是全部）
    const right = c.right + (full ? current : current / 2)
    const need = right + GAP - p.left
    if (need <= 0) return pad(main, 0)
    // 居中列：加 2x 内边距才左移 x，左边能让的空间有限；全宽列：加 x 缩 x，留够最小宽度
    const room = full ? c.width + current - MIN_FULL : c.left + current / 2 - m.left
    const px = Math.round(Math.min(need, Math.max(0, room)) * (full ? 1 : 2))
    if (Math.abs(px - current) > 1) pad(main, px)
  }
  measure()
  window.addEventListener('resize', measure)
  // 面板开着时切全宽（正文列 class 变了）：两种列的让位算法不同，重算。
  // 切换带 FLIP 平移，演出期间量到的 rect 含 transform —— 等正文列的动画演完再量（期间已复位就不量了）
  const page = main.querySelector<HTMLElement>('.editor-page')
  let alive = true
  const watch = new MutationObserver(() => {
    if (!page) return
    void Promise.allSettled(page.getAnimations().map((a) => a.finished)).then(() => {
      if (alive) measure()
    })
  })
  if (page) watch.observe(page, { attributes: true, attributeFilter: ['class'] })
  return () => {
    window.removeEventListener('resize', measure)
    alive = false
    watch.disconnect()
    pad(main, 0)
  }
}
