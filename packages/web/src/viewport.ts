/* ---------- 软键盘与视口 ----------
 * 手机上键盘弹出时，输入卡不能被盖住。两条路各管一类浏览器：
 *   - Chrome 安卓：index.html 的 viewport 带 interactive-widget=resizes-content，键盘出来布局视口自己缩，100dvh 跟着缩；
 *   - iOS Safari：键盘不改布局视口，只缩 visualViewport。这里把「被键盘盖住的高度」写成 --kb，.app 的高度减去它
 *     （styles/mobile.css），钉底的输入卡就留在键盘上面。
 * 两条路不会叠加：Chrome 那条里 innerHeight 本身就缩了，算出来的 --kb 恒为 0。 */

/** 被键盘（或别的系统界面）盖住的底部高度：布局视口底 − 可视视口底 */
export function keyboardInset(innerHeight: number, vv: { height: number; offsetTop: number }): number {
  return Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop))
}

/** 跟踪键盘高度写到 :root 的 --kb。返回清理函数 */
export function trackKeyboardInset(): () => void {
  const vv = window.visualViewport
  if (!vv) return () => undefined
  const root = document.documentElement
  const update = (): void => {
    root.style.setProperty('--kb', `${keyboardInset(window.innerHeight, vv)}px`)
    // iOS 聚焦输入框时可能把布局视口整体上推（offsetTop > 0）：键盘收起后拉回，别留半截空白
    if (vv.offsetTop === 0 && window.scrollY !== 0) window.scrollTo(0, 0)
  }
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  update()
  return () => {
    vv.removeEventListener('resize', update)
    vv.removeEventListener('scroll', update)
    root.style.removeProperty('--kb')
  }
}
