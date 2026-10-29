// 终端本地回显预测（mosh 式 type-ahead）：纯逻辑，不碰 DOM / xterm。
// 远端 shell 的回显要走 浏览器 → 中心 → connector → 中心 → 浏览器 一圈（主机约 0.35s，沙箱约 1s），打字手感差。
// 这里在按键当帧算出「服务器处理完这些按键后，这一行会是什么样」，交给 typeahead-view.ts 画成浮层；真实屏幕永远只写服务器的数据。
//
// 只预测两种操作：行尾追加可打印 ASCII、退格。其余输入（回车 / Tab / 方向键 / ESC 序列 / Ctrl 组合 / 非 ASCII / 行中间插入等）
// 是「屏障」：清掉预测、暂停，等服务器跟上（停顿约一个往返）再恢复。
//
// 确认靠状态比对而不是逐字节匹配（zsh 语法高亮会重画整行、自动建议会在光标后补灰字）：服务器每批输出解析完，读光标所在行
// 「本行起点 → 光标」的字符与光标列，和基线依次应用待确认操作得到的 S0…Sn 比，命中 Sk 就确认前 k 个；对不上超过宽限 / 超时就作废。
//
// 密码（mosh / VS Code 同款规则）：每行第一个字只入账不显示，等服务器回显确认过（verified）才显示后续预测；换行、判错、超时都要重新确认。
// 显示还要求回显延迟中位数 >= 30ms（低延迟时预测只会闪一下），降到 15ms 以下才关。

/** 读屏幕的最小接口：y 是绝对行号（含回滚区），cell 的 ch 为空串 = 从没写过的格 */
export interface Screen {
  readonly alternate: boolean
  readonly cols: number
  readonly cursor: { readonly x: number; readonly y: number }
  /** faint = 像自动建议的灰字（变暗，或前景是调色板 8）：可以被预测覆盖 */
  cell(y: number, x: number): { ch: string; faint: boolean }
}

/** 要画的浮层：cells 是要盖住的格（ch = ' ' 表示盖成空白）；cursor = 假光标列，null = 与真光标重合 */
export interface Overlay {
  y: number
  cells: Array<{ x: number; ch: string }>
  cursor: number | null
}

type Op = { kind: 'char'; ch: string; at: number } | { kind: 'del'; at: number }
/** 一行的状态：text 是 [startX, cursor) 每格一个元素（空格归一成 ' '） */
type LineState = { text: string[]; cursor: number }

export const SHOW_MS = 30
export const HIDE_MS = 15
const MIN_SAMPLES = 2
const KEEP_SAMPLES = 24
/** 还没有延迟样本时，屏障至少等这么久 */
const DEFAULT_LATENCY_MS = 300
/** 对不上之后给的宽限：一次回显可能被拆成两批到达 */
export const MISMATCH_GRACE_MS = 150
/** 待确认操作的超时下限（实际 = max(它, 3 × 延迟中位数)） */
export const TIMEOUT_MIN_MS = 1000
/** 服务器输出停下来多久才算安静（屏障解除条件之一） */
const QUIET_MS = 30

const PRINTABLE = /^[\x20-\x7e]$/
const norm = (ch: string): string => ch || ' '
const sameLine = (a: LineState, b: LineState): boolean =>
  a.cursor === b.cursor && a.text.length === b.text.length && a.text.every((ch, i) => ch === b.text[i])

export class TypeAhead {
  private anchor: { y: number; startX: number } | null = null
  private base: LineState = { text: [], cursor: 0 }
  private ops: Op[] = []
  private verified = false
  private barrierAt: number | null = null
  private unverifyOnLift = false
  private mismatchAt: number | null = null
  private pendingWrites = 0
  private lastWriteAt = -Infinity
  private samples: number[] = []
  private showing = false

  constructor(
    private readonly screen: Screen,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** 用户敲的字（在发给服务器之前调用） */
  onInput(data: string): void {
    const t = this.now()
    this.expire()
    if (this.screen.alternate) return this.clear(t, true)
    this.touchAnchor()
    for (const ch of data) {
      const ok = PRINTABLE.test(ch) ? this.predictChar(ch, t) : ch === '\x7f' || ch === '\b' ? this.predictDel(t) : false
      if (!ok) return this.barrier(t, ch === '\r')
    }
  }

  /** 不经键盘写进终端的输入（⌘J 建议的命令）：位置无法预测，当屏障 */
  onExternalInput(): void {
    this.barrier(this.now(), false)
  }

  /** 一批服务器输出交给 xterm 之前 / 解析完之后 */
  beforeWrite(): void {
    this.pendingWrites++
  }

  afterWrite(): void {
    this.pendingWrites = Math.max(0, this.pendingWrites - 1)
    this.lastWriteAt = this.now()
    this.evaluate()
  }

  /** 尺寸变化 / 切换缓冲区：预测作废、本行重新确认，等服务器重画完再说。起点留着（还在同一行就还有用；换行了 evaluate 会丢掉） */
  reset(): void {
    this.fail(this.now())
  }

  /** 定时器到点（deadline）时调：超时作废、宽限到期重新比对 */
  expire(): void {
    const t = this.now()
    const first = this.ops[0]
    if (first && t - first.at >= this.timeoutMs()) return this.fail(t)
    if (this.mismatchAt !== null && t - this.mismatchAt >= MISMATCH_GRACE_MS) this.evaluate()
  }

  /** 下一次需要调 expire 的时刻；null = 不需要 */
  deadline(): number | null {
    const first = this.ops[0]
    if (!first) return null
    const timeout = first.at + this.timeoutMs()
    return this.mismatchAt === null ? timeout : Math.min(timeout, this.mismatchAt + MISMATCH_GRACE_MS)
  }

  /** 最近的回显延迟样本（ms，预测被服务器确认所花的时间）：诊断模式下终端角落显示它的 p50 / p95 */
  get samplesMs(): readonly number[] {
    return this.samples
  }

  /** 现在该画什么；null = 什么都不画 */
  overlay(): Overlay | null {
    const anchor = this.anchor
    if (!this.showing || !this.verified || !anchor || this.ops.length === 0) return null
    const { x: serverX, y } = this.screen.cursor
    if (y !== anchor.y) return null
    const want = this.stateAfter(this.ops.length)
    const cells: Overlay['cells'] = []
    for (let x = anchor.startX; x < Math.max(want.cursor, serverX); x++) {
      const ch = x < want.cursor ? want.text[x - anchor.startX]! : ' '
      const real = this.screen.cell(y, x)
      if (ch !== norm(real.ch) || real.faint) cells.push({ x, ch })
    }
    return { y, cells, cursor: want.cursor === serverX ? null : want.cursor }
  }

  private predictChar(ch: string, t: number): boolean {
    if (!this.ready(t)) return false
    const x = this.stateAfter(this.ops.length).cursor
    if (x >= this.screen.cols - 1) return false // 不预测折行
    // 基线光标右边的格必须空着（或是自动建议的灰字）：撞上右侧提示符就停
    if (x >= this.base.cursor && !this.free(x)) return false
    this.ops.push({ kind: 'char', ch, at: t })
    return true
  }

  private predictDel(t: number): boolean {
    if (!this.ready(t)) return false
    const s = this.stateAfter(this.ops.length)
    // 删到本行开始输入的位置：shell 不会删提示符，这一下什么都不发生——忽略它，前面的预测照常（按住退格删整行时每次都会删过头）
    if (s.cursor <= this.anchor!.startX) return true
    // 只删单格 ASCII（宽字符 zsh 一次退两格，模型对不上）
    if (!PRINTABLE.test(s.text.at(-1) ?? '')) return false
    this.ops.push({ kind: 'del', at: t })
    return true
  }

  /** 这一行按下的第一个键（不管是什么键）记下起点：↑ 翻出历史命令再删，起点得是提示符末尾而不是命令末尾 */
  private touchAnchor(): void {
    if (this.ops.length > 0 || this.pendingWrites > 0) return
    const { x, y } = this.screen.cursor
    if (this.anchor && this.anchor.y === y) return
    this.anchor = { y, startX: x }
    this.verified = false
  }

  /** 能不能在服务器当前状态上继续预测；第一个操作入队时拍基线 */
  private ready(t: number): boolean {
    if (this.barrierAt !== null) {
      const settled = t - this.barrierAt >= this.latency() && this.pendingWrites === 0 && t - this.lastWriteAt >= QUIET_MS
      if (!settled) {
        this.barrierAt = t // 屏障期间的输入同样没法预测，屏障顺延
        return false
      }
      this.barrierAt = null
      if (this.unverifyOnLift) this.verified = false // 回车之后还停在这一行（程序没换行）：照样重新确认
      this.unverifyOnLift = false
    }
    if (this.ops.length > 0) return true
    if (this.pendingWrites > 0) return false // 屏幕还没追上已经收到的输出，拍不了基线
    const { x, y } = this.screen.cursor
    if (!this.anchor || this.anchor.y !== y) {
      this.anchor = { y, startX: x }
      this.verified = false
    } else if (x < this.anchor.startX) {
      this.anchor.startX = x
    }
    if (!this.tailClear(y, x)) return false // 光标在行中间：插入会把右边整体右移，浮层表达不了
    this.base = { text: this.read(y, this.anchor.startX, x), cursor: x }
    this.mismatchAt = null
    return true
  }

  /** 光标右边是不是「空的」：遇到连续两个空格 / 行尾前没撞上普通字符就算空（右侧提示符隔着一大段空白，不算） */
  private tailClear(y: number, x: number): boolean {
    let blanks = 0
    for (let i = x; i < this.screen.cols && blanks < 2; i++) {
      const c = this.screen.cell(y, i)
      if (c.faint) blanks = 0
      else if (norm(c.ch) === ' ') blanks++
      else return false
    }
    return true
  }

  private free(x: number): boolean {
    const c = this.screen.cell(this.anchor!.y, x)
    return c.faint || norm(c.ch) === ' '
  }

  private evaluate(): void {
    const t = this.now()
    const anchor = this.anchor
    if (!anchor) return
    if (this.screen.alternate) return this.clear(t, true)
    const { x, y } = this.screen.cursor
    if (y !== anchor.y) {
      // 换行了（回车、命令输出、清屏）：新的一行要重新确认
      this.ops = []
      this.anchor = null
      this.verified = false
      this.mismatchAt = null
      return
    }
    if (this.ops.length === 0) return
    const server: LineState = { text: x >= anchor.startX ? this.read(y, anchor.startX, x) : [], cursor: x }
    let k = -1
    for (let i = this.ops.length; i >= 0; i--) {
      if (sameLine(this.stateAfter(i), server)) {
        k = i
        break
      }
    }
    if (k < 0) {
      // 有屏障在路上（Tab / ↑ / 没预测的字…）：对不上算在它头上——服务器先处理完我们的预测再处理它，不是猜错，静默撤掉
      if (this.barrierAt !== null) {
        this.ops = []
        this.mismatchAt = null
        return
      }
      this.mismatchAt ??= t
      if (t - this.mismatchAt >= MISMATCH_GRACE_MS) this.fail(t)
      return
    }
    this.mismatchAt = null
    if (k === 0) return
    this.base = this.stateAfter(k)
    for (const op of this.ops.splice(0, k)) this.sample(t - op.at)
    // 打字或退格被服务器照着回显了：这一行确实在回显（不回显的密码输入里，字和退格都不会改变屏幕）
    this.verified = true
  }

  private stateAfter(n: number): LineState {
    const text = [...this.base.text]
    let cursor = this.base.cursor
    for (const op of this.ops.slice(0, n)) {
      if (op.kind === 'char') {
        text.push(op.ch)
        cursor++
      } else {
        text.pop()
        cursor--
      }
    }
    return { text, cursor }
  }

  private read(y: number, from: number, to: number): string[] {
    const out: string[] = []
    for (let x = from; x < to; x++) out.push(norm(this.screen.cell(y, x).ch))
    return out
  }

  /** 不可预测的输入：只是不再加新的预测，已有的照常显示、照常确认（服务器会先处理它们）。回车 = 之后这一行要重新确认 */
  private barrier(t: number, newline: boolean): void {
    this.barrierAt = t
    if (newline) this.unverifyOnLift = true
  }

  /** 清掉预测并立屏障。lose = 连起点一起丢（alternate） */
  private clear(t: number, lose: boolean): void {
    this.ops = []
    this.mismatchAt = null
    this.barrierAt = t
    if (lose) {
      this.verified = false
      this.anchor = null
    }
  }

  /** 猜错 / 超时：作废并要求重新确认（不回显的输入就是这样一直不显示的） */
  private fail(t: number): void {
    this.clear(t, false)
    this.verified = false
  }

  private sample(ms: number): void {
    this.samples.push(ms)
    if (this.samples.length > KEEP_SAMPLES) this.samples.shift()
    if (this.samples.length < MIN_SAMPLES) return
    const m = this.median()
    if (m >= SHOW_MS) this.showing = true
    else if (m < HIDE_MS) this.showing = false
  }

  private median(): number {
    const sorted = [...this.samples].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)] ?? DEFAULT_LATENCY_MS
  }

  private latency(): number {
    return this.samples.length ? this.median() : DEFAULT_LATENCY_MS
  }

  private timeoutMs(): number {
    return Math.max(TIMEOUT_MIN_MS, 3 * this.latency())
  }
}
