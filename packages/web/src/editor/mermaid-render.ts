/* ---------- Mermaid 图 ----------
 * `mermaid` 代码块的图：库按需加载（lazy.ts）；按「主题 + 代码」缓存 svg（同一张图在气泡 / 编辑器 / 历史里只算一次）；
 * 主题跟随系统明暗（dark.css 同口径），切换时清缓存、由订阅者重画。securityLevel 'strict'：图里的 HTML / 点击脚本
 * 由 mermaid 自己清掉（图的代码来自文档，可能是别人 / AI 写的）。语法错误不抛：在图的位置显示错误，代码照旧在。 */

import { loadMermaid } from './lazy'

const DARK = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null
const svgCache = new Map<string, string>()
const themeListeners = new Set<() => void>()
let seq = 0
let initialized: string | null = null

function theme(): 'dark' | 'default' {
  return DARK?.matches ? 'dark' : 'default'
}

DARK?.addEventListener('change', () => {
  svgCache.clear()
  for (const fn of themeListeners) fn()
})

/** 系统明暗切换时回调（图要按新主题重画）；返回取消订阅 */
export function onMermaidTheme(fn: () => void): () => void {
  themeListeners.add(fn)
  return () => themeListeners.delete(fn)
}

/** 把 code 画成图放进 target（异步）。返回时 target 里是图或错误说明；代码为空 = 清空 */
export async function renderMermaid(target: HTMLElement, code: string): Promise<void> {
  const source = code.trim()
  if (!source) {
    target.replaceChildren()
    return
  }
  const mode = theme()
  const cacheKey = `${mode}\u0000${source}`
  const cached = svgCache.get(cacheKey)
  if (cached) {
    target.innerHTML = cached
    return
  }
  try {
    const mermaid = await loadMermaid()
    if (initialized !== mode) {
      mermaid.initialize({ startOnLoad: false, theme: mode, securityLevel: 'strict', fontFamily: 'inherit' })
      initialized = mode
    }
    seq += 1
    const { svg } = await mermaid.render(`ramet-mermaid-${seq}`, source)
    if (svgCache.size > 100) svgCache.clear()
    svgCache.set(cacheKey, svg)
    target.innerHTML = svg
  } catch (err) {
    const box = document.createElement('div')
    box.className = 'mermaid-error'
    const msg = err instanceof Error ? err.message : String(err)
    box.textContent = `图画不出来：${msg.split('\n')[0] ?? ''}`
    target.replaceChildren(box)
  }
}
