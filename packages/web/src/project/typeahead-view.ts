// 本地回显预测的 xterm 一侧：读屏幕 + 画浮层，状态机在 typeahead.ts（纯逻辑）。
// Screen 读 buffer.active，浮层用 decoration（要 allowProposedApi）盖在预测的格子上，从不往终端缓冲区写东西；
// 猜错 / 作废就是销毁 decoration，真实屏幕始终是服务器的。浮层样式与正常文字一致，有假光标时给宿主加 term-typeahead，
// CSS 把 xterm 自己的光标藏掉。localStorage['ramet:typeahead'] = 'off' 时整个关闭（排查用）。

import type { IDecoration, IMarker, Terminal } from '@xterm/xterm'
import { TypeAhead, type Overlay, type Screen } from './typeahead'

const OFF_KEY = 'ramet:typeahead'
/** 前景是调色板 8（亮黑）：zsh-autosuggestions / fish 的自动建议默认就是它 */
const SUGGESTION_PALETTE = 8

function disabled(): boolean {
  try {
    return localStorage.getItem(OFF_KEY) === 'off'
  } catch {
    return false
  }
}

export function xtermScreen(term: Terminal): Screen {
  return {
    get alternate() {
      return term.buffer.active.type === 'alternate'
    },
    get cols() {
      return term.cols
    },
    get cursor() {
      const b = term.buffer.active
      return { x: b.cursorX, y: b.baseY + b.cursorY }
    },
    cell(y, x) {
      const c = term.buffer.active.getLine(y)?.getCell(x)
      if (!c) return { ch: '', faint: false }
      return { ch: c.getChars(), faint: c.isDim() !== 0 || (c.isFgPalette() && c.getFgColor() === SUGGESTION_PALETTE) }
    },
  }
}

export class TermTypeAhead {
  private readonly core: TypeAhead
  private readonly off = disabled()
  private deco: IDecoration | null = null
  private marker: IMarker | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly term: Terminal,
    private readonly host: HTMLElement,
  ) {
    this.core = new TypeAhead(xtermScreen(term))
  }

  /** 用户敲的字：先预测（当帧画出来），再由调用方发给服务器 */
  input(data: string): void {
    if (this.off) return
    this.core.onInput(data)
    this.sync()
  }

  /** 不经键盘写进终端的输入（⌘J 建议的命令） */
  external(): void {
    if (this.off) return
    this.core.onExternalInput()
    this.sync()
  }

  /** 服务器输出：交给 xterm 之前调 beforeWrite，write 的回调里调 afterWrite */
  beforeWrite(): void {
    if (!this.off) this.core.beforeWrite()
  }

  afterWrite(): void {
    if (this.off) return
    this.core.afterWrite()
    this.sync()
  }

  reset(): void {
    if (this.off) return
    this.core.reset()
    this.sync()
  }

  /** 回显延迟样本（诊断模式的 p50 / p95 用） */
  echoSamples(): readonly number[] {
    return this.core.samplesMs
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.clearDeco()
  }

  private sync(): void {
    this.draw(this.core.overlay())
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const at = this.core.deadline()
    if (at === null) return
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.core.expire()
        this.sync()
      },
      Math.max(0, at - performance.now()) + 5,
    )
  }

  private clearDeco(): void {
    this.deco?.dispose()
    this.marker?.dispose()
    this.deco = this.marker = null
    this.host.classList.remove('term-typeahead')
  }

  private draw(o: Overlay | null): void {
    this.clearDeco()
    if (!o || (o.cells.length === 0 && o.cursor === null)) return
    const xs = [...o.cells.map((c) => c.x), ...(o.cursor === null ? [] : [o.cursor])]
    const left = Math.min(...xs)
    const width = Math.max(...xs) - left + 1
    const b = this.term.buffer.active
    const marker = this.term.registerMarker(o.y - (b.baseY + b.cursorY))
    const deco = this.term.registerDecoration({ marker, x: left, width, layer: 'top' })
    if (!deco) {
      marker.dispose()
      return
    }
    this.marker = marker
    this.deco = deco
    if (o.cursor !== null) this.host.classList.add('term-typeahead')
    const { theme = {}, fontFamily, fontSize, fontWeight, letterSpacing } = this.term.options
    const cursorCh = o.cursor === null ? '' : (b.getLine(o.y)?.getCell(o.cursor)?.getChars() ?? '')
    deco.onRender((el) => {
      if (el.childElementCount > 0) return // onRender 每次重绘都会触发，内容只填一次
      Object.assign(el.style, {
        fontFamily: fontFamily ?? '',
        fontSize: `${fontSize ?? 13}px`,
        fontWeight: String(fontWeight ?? 'normal'),
        letterSpacing: `${letterSpacing ?? 0}px`,
        lineHeight: el.style.height,
        pointerEvents: 'none',
      })
      const put = (x: number, ch: string, fg: string, bg: string): void => {
        const span = document.createElement('span')
        span.className = 'term-typeahead-cell'
        span.textContent = ch
        span.style.left = `${((x - left) / width) * 100}%`
        span.style.width = `${100 / width}%`
        span.style.color = fg
        span.style.background = bg
        el.appendChild(span)
      }
      const fg = theme.foreground ?? ''
      const bg = theme.background ?? ''
      for (const c of o.cells) put(c.x, c.ch, fg, bg)
      if (o.cursor !== null) put(o.cursor, cursorCh || ' ', theme.cursorAccent ?? bg, theme.cursor ?? fg)
    })
  }
}
