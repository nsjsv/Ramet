/* ---------- 框选工具栏的「颜色」下拉 ----------
 * 两组：文字颜色、背景（各「默认」+ 9 色），点一下作用于当前文字选区（color-marks.ts 的 setColorMark）。
 * 下拉挂 body，与「转换成」同一套开合惯例：按钮 mousedown preventDefault（编辑器焦点与选区不丢），视图更新就收起。 */

import type { EditorView } from '@milkdown/kit/prose/view'
import { COLOR_NAMES } from '@ramet/shared/md-dialect'
import { colorInSelection, setColorMark } from './color-marks'

const LABELS: Record<string, string> = {
  gray: '灰',
  brown: '棕',
  orange: '橙',
  yellow: '黄',
  green: '绿',
  blue: '蓝',
  purple: '紫',
  pink: '粉',
  red: '红',
}

export function createColorMenu(view: EditorView): { button: HTMLButtonElement; close: () => void } {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'sel-color'
  button.setAttribute('aria-label', '颜色')
  button.innerHTML = '<span class="sel-color-a">A</span>'
  let panel: HTMLElement | null = null

  const close = (): void => {
    panel?.remove()
    panel = null
    button.classList.remove('on')
    document.removeEventListener('mousedown', onOutside, true)
  }
  function onOutside(e: MouseEvent): void {
    if (!panel?.contains(e.target as Node) && !button.contains(e.target as Node)) close()
  }
  const swatch = (name: 'text_color' | 'highlight', color: string, current: string): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `color-swatch ${name === 'text_color' ? 'is-text' : 'is-bg'}${color === current ? ' is-current' : ''}`
    b.dataset.color = color || 'default'
    b.title = color ? LABELS[color]! : '默认'
    b.textContent = name === 'text_color' ? 'A' : ''
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', () => {
      close()
      setColorMark(name, color)(view.state, view.dispatch)
      view.focus()
    })
    return b
  }
  button.addEventListener('mousedown', (e) => e.preventDefault())
  button.addEventListener('click', () => {
    if (panel) return close()
    const box = document.createElement('div')
    box.className = 'pop-card color-menu'
    for (const name of ['text_color', 'highlight'] as const) {
      const title = document.createElement('div')
      title.className = 'pop-section'
      title.textContent = name === 'text_color' ? '文字颜色' : '背景'
      const row = document.createElement('div')
      row.className = 'color-row'
      const current = colorInSelection(view.state, name)
      row.append(swatch(name, '', current), ...COLOR_NAMES.map((c) => swatch(name, c, current)))
      box.append(title, row)
    }
    document.body.append(box)
    const rect = button.getBoundingClientRect()
    box.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - box.offsetWidth - 8))}px`
    const below = rect.bottom + 6
    box.style.top = `${below + box.offsetHeight > window.innerHeight - 8 ? Math.max(8, rect.top - box.offsetHeight - 6) : below}px`
    panel = box
    button.classList.add('on')
    document.addEventListener('mousedown', onOutside, true)
  })
  return { button, close }
}
