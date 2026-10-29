/* ---------- 代码块的 nodeView：顶栏 + 代码 + Mermaid 图 ----------
 * dom = div.code-block
 *   ├ div.code-head（外壳，contenteditable=false）：语言按钮（点开可搜索的下拉）·（mermaid）图 / 代码 · 换行 · 复制
 *   ├ pre.code-src > code（contentDOM：编辑器照常管）
 *   └ div.mermaid-view（外壳，只在 language = mermaid 时出现）
 * 高亮是 code-highlight.ts 的装饰，落在 contentDOM 里，与这里无关。
 * mermaid：默认只显示图；光标在块里（active-block.ts 给块挂 is-active）或点了「代码」（show-code）时同时显示源码。
 * 换行：节点 attr `wrap`（默认开，block-id.ts）；可编辑时切换写回文档（协作者 / 公开页同看），关掉时外壳挂 is-nowrap。
 * 只读视图（公开页 / viewer / 历史预览）语言按钮不可点，复制与图 / 代码切换照常，换行只改自己这一眼、不写回。
 * 外壳上的点击不改选区与焦点（mousedown preventDefault，同 run-step-view.ts）；ignoreMutation 只忽略外壳自己的变动（shell-mutation.ts）。
 * 两个宿主（editor-session.ts、PublicPage.tsx）都 .use(codeBlockView) 与 activeBlock。 */

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $view } from '@milkdown/kit/utils'
import { copyText } from '../clipboard'
import { iconSvg } from '../icons'
import { codeBlockIdSchema } from './block-id'
import { filterLangs, langLabel, type CodeLang } from './code-langs'
import { onMermaidTheme, renderMermaid } from './mermaid-render'
import { shellMutationFilter } from './shell-mutation'

const isMermaid = (node: PMNode): boolean => String(node.attrs.language ?? '').trim().toLowerCase() === 'mermaid'

function shell<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = cls
  el.contentEditable = 'false'
  return el
}

/* ---------- 语言下拉（挂 body，一次只开一个） ---------- */

let openPicker: { el: HTMLElement; close: () => void } | null = null

function openLangPicker(anchor: HTMLElement, current: string, pick: (lang: CodeLang) => void): void {
  openPicker?.close()
  const box = document.createElement('div')
  box.className = 'pop-card code-lang-menu'
  const input = document.createElement('input')
  input.className = 'code-lang-search'
  input.placeholder = '搜索语言'
  input.spellcheck = false
  const list = document.createElement('div')
  list.className = 'code-lang-list'
  box.append(input, list)
  let rows: CodeLang[] = []
  let active = 0

  const render = (): void => {
    rows = filterLangs(input.value)
    active = Math.min(active, Math.max(rows.length - 1, 0))
    list.replaceChildren(
      ...rows.map((lang, i) => {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'pop-row' + (i === active ? ' is-active' : '') + (langLabel(current) === lang.label ? ' is-current' : '')
        row.textContent = lang.label
        row.addEventListener('mousedown', (e) => e.preventDefault())
        row.addEventListener('click', () => choose(lang))
        return row
      }),
    )
    list.children[active]?.scrollIntoView({ block: 'nearest' })
  }
  const close = (): void => {
    box.remove()
    document.removeEventListener('mousedown', onOutside, true)
    if (openPicker?.el === box) openPicker = null
  }
  const choose = (lang: CodeLang): void => {
    close()
    pick(lang)
  }
  function onOutside(e: MouseEvent): void {
    if (!box.contains(e.target as Node) && !anchor.contains(e.target as Node)) close()
  }
  input.addEventListener('input', () => {
    active = 0
    render()
  })
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % Math.max(rows.length, 1)
      render()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const lang = rows[active]
      if (lang) choose(lang)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  })
  document.body.append(box)
  render()
  const rect = anchor.getBoundingClientRect()
  box.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - box.offsetWidth - 8))}px`
  const below = rect.bottom + 4
  box.style.top = `${below + box.offsetHeight > window.innerHeight - 8 ? Math.max(8, rect.top - box.offsetHeight - 4) : below}px`
  document.addEventListener('mousedown', onOutside, true)
  openPicker = { el: box, close }
  input.focus()
}

/* ---------- nodeView ---------- */

/** 代码块 nodeView 本体：milkdown 宿主经 codeBlockView 注册，历史预览这类原生 EditorView 直接放进 nodeViews */
export function createCodeView(initial: PMNode, view: EditorView, getPos: () => number | undefined) {
  let node = initial
  const dom = document.createElement('div')
  dom.className = 'code-block'
  const head = shell('div', 'code-head')
  const langBtn = document.createElement('button')
  langBtn.type = 'button'
  langBtn.className = 'code-lang'
  const modeBtn = document.createElement('button')
  modeBtn.type = 'button'
  modeBtn.className = 'code-mode'
  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'code-copy'
  copyBtn.title = '复制代码'
  copyBtn.innerHTML = iconSvg('copy', 14)
  const wrapBtn = document.createElement('button')
  wrapBtn.type = 'button'
  wrapBtn.className = 'code-wrap'
  wrapBtn.innerHTML = iconSvg('wrap', 14)
  const gap = document.createElement('span')
  gap.className = 'code-head-gap'
  head.append(langBtn, gap, modeBtn, wrapBtn, copyBtn)
  const pre = document.createElement('pre')
  pre.className = 'code-src'
  const code = document.createElement('code')
  pre.append(code)
  const diagram = shell('div', 'mermaid-view')
  dom.append(head, pre)

  let localWrap: boolean | null = null // 只读视图里点出来的换行状态，不写回文档
  const wraps = (): boolean => (view.editable ? null : localWrap) ?? node.attrs.wrap !== false

  let rendered: string | null = null
  let timer: number | undefined
  const renderDiagram = (immediate = false): void => {
    if (!isMermaid(node)) return
    const source = node.textContent
    if (source === rendered) return
    window.clearTimeout(timer)
    const run = (): void => {
      rendered = source
      void renderMermaid(diagram, source)
    }
    if (immediate) run()
    else timer = window.setTimeout(run, 400) // 打字时不是每个键都重画
  }

  const paint = (): void => {
    const language = String(node.attrs.language ?? '')
    const mermaid = isMermaid(node)
    dom.dataset.language = language
    pre.dataset.language = language
    dom.classList.toggle('is-mermaid', mermaid)
    langBtn.textContent = langLabel(language)
    langBtn.disabled = !view.editable
    modeBtn.hidden = !mermaid
    modeBtn.textContent = dom.classList.contains('show-code') ? '只看图' : '代码'
    const wrap = wraps()
    dom.classList.toggle('is-nowrap', !wrap)
    wrapBtn.classList.toggle('is-on', wrap)
    wrapBtn.setAttribute('aria-pressed', String(wrap))
    wrapBtn.title = wrap ? '自动换行：开' : '自动换行：关'
    if (mermaid && !diagram.isConnected) {
      dom.append(diagram)
      rendered = null
    } else if (!mermaid && diagram.isConnected) {
      diagram.remove()
      diagram.replaceChildren()
    }
    renderDiagram(rendered === null)
  }

  head.addEventListener('mousedown', (e) => e.preventDefault())
  langBtn.addEventListener('click', () => {
    if (!view.editable) return
    openLangPicker(langBtn, String(node.attrs.language ?? ''), (lang) => {
      const pos = getPos()
      if (pos === undefined || view.isDestroyed) return
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, language: lang.id }))
      view.focus()
    })
  })
  wrapBtn.addEventListener('click', () => {
    const next = !wraps()
    const pos = getPos()
    if (view.editable && pos !== undefined) {
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, wrap: next }))
      return
    }
    localWrap = next
    paint()
  })
  copyBtn.addEventListener('click', () => {
    void copyText(node.textContent).then((ok) => {
      if (!ok) return
      copyBtn.innerHTML = iconSvg('check', 14)
      window.setTimeout(() => (copyBtn.innerHTML = iconSvg('copy', 14)), 1200)
    })
  })
  modeBtn.addEventListener('click', () => {
    dom.classList.toggle('show-code')
    paint()
  })
  const offTheme = onMermaidTheme(() => {
    rendered = null
    renderDiagram(true)
  })
  paint()

  return {
    dom,
    contentDOM: code,
    update(next: PMNode) {
      if (next.type !== node.type) return false
      node = next
      paint()
      return true
    },
    stopEvent(event: Event) {
      const target = event.target as Node | null
      return Boolean(target) && (head.contains(target) || diagram.contains(target))
    },
    ignoreMutation: shellMutationFilter(dom, code, [head, diagram]),
    destroy() {
      window.clearTimeout(timer)
      offTheme()
      if (openPicker && langBtn.isConnected === false) openPicker.close()
    },
  }
}

export const codeBlockView = $view(codeBlockIdSchema.node, () => createCodeView)
