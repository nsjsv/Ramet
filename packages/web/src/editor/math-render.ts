// KaTeX 渲染。行内 / 块级公式的画法只有这一处：nodeView、编辑弹层的预览、静态宿主（rich-render.ts）都调 renderMath。
// KaTeX 按需加载（lazy.ts，连样式表）；按「显示模式 + LaTeX」缓存 HTML。throwOnError: false，写错的公式
// KaTeX 自己标红显示原文，不抛；空公式画一个占位提示。

import { katexReady, loadKatex, type Katex } from './lazy'

const cache = new Map<string, string>()

function toHtml(katex: Katex, latex: string, display: boolean): string {
  const key = `${display ? 'D' : 'I'}\u0000${latex}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const html = katex.renderToString(latex, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false })
  if (cache.size > 500) cache.clear()
  cache.set(key, html)
  return html
}

/** 把 latex 画进 el（库没到先显示原文，到了再画）；空 = 占位提示 */
export function renderMath(el: HTMLElement, latex: string, display: boolean): void {
  const source = latex.trim()
  el.classList.toggle('is-empty', !source)
  if (!source) {
    el.textContent = display ? '输入 LaTeX 公式' : '公式'
    return
  }
  const katex = katexReady()
  delete el.dataset.mathPending
  if (katex) {
    el.innerHTML = toHtml(katex, source, display)
    return
  }
  el.textContent = source
  el.dataset.mathPending = source
  void loadKatex().then(
    (k) => {
      // 等库期间这块又被改成别的公式了：以最后一次请求为准
      if (el.dataset.mathPending === source) el.innerHTML = toHtml(k, source, display)
    },
    () => undefined,
  )
}
