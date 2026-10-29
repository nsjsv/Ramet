// ---------- 随手 AI 的小浮层（⌘J）----------
// 纯 DOM，不依赖 ProseMirror：正文选区浮层与对话输入框 / `>>` 草稿的状态条共用。挂在 body 上 fixed 定位，
// 跟着锚点走，放不下就翻到上方。样式在 styles/quick.css，动画只有 CSS，JS 不用等动画结束。
// 两种形态：
//   input   = 输入框 + 预设 + 状态行（正文：选中改写 / 光标处起草）
//   status  = 只有状态行（输入框 / 草稿：固定指令，一键整理）
// 阶段：input（等指令）→ running（流式生成，Esc 取消）→ review（预览在文档里，↵ 收下、Esc 不要；改了指令再 ↵ = 重来）
//       → error（带原因，必要时给「去设置」）。
// 键位：输入法组字中的回车不算；Esc 在任何阶段都关（running 时先中止请求，由调用方的 onClose 负责）；
// 点浮层外面也关。按钮 mousedown 一律 preventDefault，不抢输入框焦点。

import { COPY } from '../copy'
import { iconSvg } from '../icons'
import { isQuickKey } from './quick-keys'

const Q = COPY.quick

export interface QuickPreset {
  id: string
  label: string
}

export type PopPhase =
  | { kind: 'input' }
  /** text = 自定义状态文字（如「正在写入文件…」）；给了就不显示"Esc 取消"（这件事取消不了） */
  | { kind: 'running'; text?: string }
  | { kind: 'review' }
  | { kind: 'error'; message: string; settings?: boolean }

export interface PopoverOptions {
  /** 有输入框 + 预设（正文）；false = 只有状态行（输入框 / 草稿） */
  input: boolean
  presets?: QuickPreset[]
  placeholder?: string
  /** 浮层锚在哪（视口坐标）；放不下翻上方。null = 暂时量不到，保持原位 */
  anchor: () => DOMRect | null
  /** 输入框里回车 / 点预设：instruction 是输入框当前文字，preset 是点中的预设（直接打字时 undefined） */
  onRun?: (instruction: string, preset?: QuickPreset) => void
  onAccept?: () => void
  /** 关闭（Esc / 不要 / 点外面）。运行中也走这里：调用方负责中止请求、清预览 */
  onClose: () => void
  onSettings?: () => void
}

const VIEW_MARGIN = 8
const GAP = 8

export class QuickPopover {
  readonly el: HTMLElement
  private input: HTMLInputElement | null = null
  private presetsEl: HTMLElement | null = null
  private status: HTMLElement
  private phase: PopPhase = { kind: 'input' }
  /** 上一次执行用的指令：review 阶段输入框的字没变 = 回车收下，变了 = 重来 */
  private ranWith = ''
  private destroyed = false

  constructor(private opts: PopoverOptions) {
    this.el = document.createElement('div')
    this.el.className = 'pop-card quick-pop' + (opts.input ? '' : ' is-status')
    this.el.setAttribute('role', 'dialog')
    this.el.setAttribute('aria-label', Q.popTitle)
    // 输入框自己除外：要能点进去选字
    this.el.addEventListener('mousedown', (e) => {
      if (e.target !== this.input) e.preventDefault()
    })
    if (opts.input) this.buildInput(opts)
    this.status = document.createElement('div')
    this.status.className = 'quick-status'
    this.el.append(this.status)
    document.body.append(this.el)
    document.addEventListener('mousedown', this.onOutside, true)
    document.addEventListener('keydown', this.onEscape, true)
    window.addEventListener('resize', this.reposition)
    window.addEventListener('scroll', this.reposition, true)
    this.setPhase({ kind: 'input' })
  }

  private buildInput(opts: PopoverOptions): void {
    const head = document.createElement('div')
    head.className = 'quick-head'
    head.insertAdjacentHTML('beforeend', `<span class="quick-spark">${iconSvg('sparkle', 16)}</span>`)
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'quick-input'
    input.placeholder = opts.placeholder ?? ''
    input.maxLength = 500
    input.setAttribute('aria-label', Q.popTitle)
    input.addEventListener('keydown', (e) => this.onInputKey(e))
    input.addEventListener('input', () => this.syncHint())
    const go = document.createElement('button')
    go.type = 'button'
    go.className = 'quick-go'
    go.title = Q.run
    go.innerHTML = iconSvg('arrow-up', 14)
    go.addEventListener('click', () => this.submit())
    head.append(input, go)
    this.input = input
    this.el.append(head)
    const presets = opts.presets ?? []
    if (presets.length > 0) {
      const row = document.createElement('div')
      row.className = 'quick-presets'
      for (const preset of presets) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'quick-chip'
        chip.textContent = preset.label
        chip.addEventListener('click', () => {
          if (this.phase.kind === 'running') return
          this.ranWith = preset.label
          if (this.input) this.input.value = preset.label
          this.opts.onRun?.(preset.label, preset)
        })
        row.append(chip)
      }
      this.presetsEl = row
      this.el.append(row)
    }
  }

  private onInputKey(e: KeyboardEvent): void {
    // 浮层开着时再按 ⌘J 什么都不做，但不能让浏览器自带的 Ctrl+J（下载页）冒出来
    if (isQuickKey(e)) {
      e.preventDefault()
      return
    }
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return
    e.preventDefault()
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return
    if (this.phase.kind === 'running') return
    if (this.phase.kind === 'review' && this.input?.value.trim() === this.ranWith) {
      this.opts.onAccept?.()
      return
    }
    this.submit()
  }

  private submit(): void {
    const text = this.input?.value.trim() ?? ''
    if (!text || this.phase.kind === 'running') return
    this.ranWith = text
    this.opts.onRun?.(text)
  }

  private onOutside = (e: MouseEvent): void => {
    if (this.el.contains(e.target as Node)) return
    // 状态条形态下用户多半要点回输入框接着写，生成中不因此取消；出错后点别处才收起
    if (!this.opts.input && this.phase.kind !== 'error') return
    this.opts.onClose()
  }

  // 焦点可能在编辑器 / 输入框（状态条形态没有自己的输入框），Esc 在捕获阶段统一接，免得漏给编辑器
  private onEscape = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || e.isComposing) return
    e.preventDefault()
    e.stopPropagation()
    this.opts.onClose()
  }

  /** 输入框的字和上次执行的不同 → 回车是「重新生成」而不是「收下」 */
  private syncHint(): void {
    if (this.phase.kind === 'review') this.renderStatus()
  }

  setPhase(phase: PopPhase): void {
    if (this.destroyed) return
    this.phase = phase
    if (this.input) {
      this.input.disabled = phase.kind === 'running'
      this.input.classList.toggle('is-busy', phase.kind === 'running')
    }
    // 预设只在还没执行时摆，执行后让位给状态行，浮层不长高
    if (this.presetsEl) this.presetsEl.hidden = phase.kind !== 'input' && phase.kind !== 'error'
    this.renderStatus()
    if (phase.kind === 'input' || phase.kind === 'review' || phase.kind === 'error') this.input?.focus()
    this.reposition()
  }

  private renderStatus(): void {
    const p = this.phase
    const el = this.status
    el.replaceChildren()
    el.classList.toggle('is-error', p.kind === 'error')
    el.hidden = p.kind === 'input' && this.opts.input
    const text = (s: string): HTMLElement => {
      const span = document.createElement('span')
      span.className = 'quick-msg'
      span.textContent = s
      return span
    }
    const keys = (s: string): HTMLElement => {
      const k = document.createElement('span')
      k.className = 'quick-keys'
      k.textContent = s
      return k
    }
    const button = (label: string, cls: string, run: () => void): HTMLButtonElement => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = cls
      b.textContent = label
      b.addEventListener('click', run)
      return b
    }
    if (p.kind === 'running') {
      el.insertAdjacentHTML('beforeend', '<span class="quick-dots" aria-hidden="true"><i></i><i></i><i></i></span>')
      el.append(text(p.text ?? (this.opts.input ? Q.running : Q.composerRunning)))
      if (p.text === undefined) el.append(keys(Q.cancelHint))
    } else if (p.kind === 'review') {
      const changed = (this.input?.value.trim() ?? '') !== this.ranWith
      el.append(
        keys(changed ? Q.rerun : Q.review),
        keys(Q.reviewReject),
        button(Q.accept, 'quick-btn is-primary', () => this.opts.onAccept?.()),
        button(Q.reject, 'quick-btn', () => this.opts.onClose()),
      )
    } else if (p.kind === 'error') {
      el.append(text(p.message))
      if (p.settings && this.opts.onSettings) el.append(button(Q.openSettings, 'quick-btn', () => this.opts.onSettings?.()))
      if (!this.opts.input) el.append(keys('Esc'))
    }
  }

  /** 把浮层放到锚点下方（放不下翻到上方），钳在视口内 */
  reposition = (): void => {
    if (this.destroyed) return
    const rect = this.opts.anchor()
    if (!rect) return
    const { offsetWidth: w, offsetHeight: h } = this.el
    const left = Math.max(VIEW_MARGIN, Math.min(rect.left, window.innerWidth - w - VIEW_MARGIN))
    let top = rect.bottom + GAP
    if (top + h > window.innerHeight - VIEW_MARGIN) top = Math.max(VIEW_MARGIN, rect.top - h - GAP)
    this.el.style.left = `${left}px`
    this.el.style.top = `${top}px`
  }

  /** 输入框当前的字（review 阶段用来判断是不是改了指令） */
  value(): string {
    return this.input?.value ?? ''
  }

  focus(): void {
    this.input?.focus()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    document.removeEventListener('mousedown', this.onOutside, true)
    document.removeEventListener('keydown', this.onEscape, true)
    window.removeEventListener('resize', this.reposition)
    window.removeEventListener('scroll', this.reposition, true)
    this.el.remove()
  }
}
