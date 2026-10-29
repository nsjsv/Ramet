// ---------- 静态宿主的富渲染 ----------
// 对话气泡、历史预览、AI 实时回复（LiveMarkdown）、同步块都是 DOMSerializer 序列化出来的静态 DOM，没有 nodeView。
// 这里把需要「画」的块补画上，与编辑器里的 nodeView / 装饰用同一套渲染函数：
//   - 代码高亮（code-highlight.ts 的 hydrateCode）；
//   - mermaid：`pre[data-language=mermaid]` 换成「图 + 收起的源码」（mermaid-render.ts）；
//   - 公式：行内 `[data-math-inline]` 就地画，块 `[data-math-block]` 在源码前插一个画好的结果、源码藏起（math-render.ts）。
// 所有步骤幂等（重复调用不重画）。
// opts.mermaid = false：还在流式生成的块不画图（每来一段字就重画一次，半截代码还会报错）。

import { hydrateCode } from './code-highlight'
import { renderMath } from './math-render'
import { renderMermaid } from './mermaid-render'

function hydrateMermaid(root: HTMLElement): void {
  const pres = [...(root.matches('pre[data-language="mermaid"]') ? [root] : []), ...root.querySelectorAll<HTMLElement>('pre[data-language="mermaid"]')]
  for (const pre of pres) {
    if (!pre.parentElement || pre.closest('.mermaid-static, .code-block')) continue
    const wrap = document.createElement('div')
    wrap.className = 'mermaid-static'
    const view = document.createElement('div')
    view.className = 'mermaid-view'
    const details = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = '源码'
    pre.replaceWith(wrap)
    details.append(summary, pre)
    wrap.append(view, details)
    void renderMermaid(view, pre.textContent ?? '')
  }
}

function within(root: HTMLElement, selector: string): HTMLElement[] {
  return [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll<HTMLElement>(selector)]
}

function hydrateMath(root: HTMLElement): void {
  for (const el of within(root, '[data-math-inline]')) {
    const latex = el.dataset.latex ?? el.textContent ?? ''
    if (el.dataset.mathDone === latex) continue
    renderMath(el, latex, false)
    el.dataset.mathDone = latex
  }
  for (const el of within(root, '[data-math-block]')) {
    const pre = el.querySelector(':scope > pre')
    const latex = pre?.textContent ?? ''
    if (el.dataset.mathDone === latex) continue
    let out = el.querySelector<HTMLElement>(':scope > .math-render')
    if (!out) {
      out = document.createElement('div')
      out.className = 'math-render'
      el.prepend(out)
    }
    el.classList.add('is-rendered')
    renderMath(out, latex, true)
    el.dataset.mathDone = latex
  }
}

export function hydrateRich(root: HTMLElement, opts: { mermaid?: boolean } = {}): void {
  hydrateCode(root)
  hydrateMath(root)
  if (opts.mermaid !== false) hydrateMermaid(root)
}
