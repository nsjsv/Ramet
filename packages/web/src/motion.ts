/* ---------- 动效共用 ----------
 * 时长与曲线的唯一来源是 CSS 令牌（styles/base.css 的 --d-* / --ease-*）：JS 动画、「等退场动画演完再摘 DOM」
 * 的定时器都从这里读；prefers-reduced-motion 下令牌归零，JS 跟着直接到终态。只动 transform / opacity。 */

/** 系统要求减弱动效 */
export function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/* CSS <time>：数字 + ms | s；无单位只有 0 合法（200、1.2.3s、calc()、var() 都不是） */
const CSS_TIME = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)(ms|s)?$/i

/** CSS <time> 文本 → 毫秒（`200ms`、`.2s`、`0.32s`、`1e2ms`）；认不出返回 null */
export function cssTimeMs(text: string): number | null {
  const m = CSS_TIME.exec(text.trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2]?.toLowerCase()
  if (unit === 'ms') return n
  if (unit === 's') return n * 1000
  return n === 0 ? 0 : null
}

/** 时长令牌的毫秒数（减弱动效时为 0）。
 * 生产构建的 CSS 压缩会把 `200ms` 改写成 `.2s`（dev 不压缩，看不出来），
 * 所以必须按 CSS <time> 语法读，不能 parseFloat 当毫秒，否则读成 0.2ms，定时器近乎立即触发。
 * 读不出就报错并退回 0（动画直接到终态，同减弱动效）。 */
export function motionMs(token: `--d-${1 | 2 | 3}`): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token)
  const ms = cssTimeMs(raw)
  if (ms === null) {
    console.error(`motion: 令牌 ${token} 读不出时长：${JSON.stringify(raw)}`)
    return 0
  }
  return ms
}

/** 退出曲线令牌（WAAPI 的 easing 字符串）；读不出退回 ease-out */
export function easeOut(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim() || 'ease-out'
}

/** 容器边界：到 ProseMirror 根为止（文档编辑器与聊天视图的消息流都挂在它下面） */
const ROOT = 'ProseMirror'
/** 一次 FLIP 最多量这么多个元素（几百个 rect 同步读一遍不值） */
const FOLLOW_CAP = 200

/** `el` 之后、同一棵消息流里所有会被它的高度变化带动的元素（逐层收集后续兄弟，到根为止）：交给 flip 做补位 */
export function followersAfter(el: Element): Element[] {
  const out: Element[] = []
  for (let p: Element | null = el; p && !p.classList.contains(ROOT); p = p.parentElement) {
    for (let n = p.nextElementSibling; n && out.length < FOLLOW_CAP; n = n.nextElementSibling) out.push(n)
  }
  return out
}

const FLIP_ID = 'flip'
let flipping = 0

/** FLIP：记下位置 → mutate（必须同步改完 DOM，React 用 flushSync）→ transform 从旧位置滑回。只平移不缩放。
 * 正在演的上一轮 FLIP 先取消（起点取当前视觉位置，打断后接着滑）；不动 CSS 过渡。
 * 演出期间 <html data-flipping>：.main 不出横向滚动条（列宽变了，平移起点会超出右缘） */
export function flip(els: Iterable<Element>, mutate: () => void): void {
  const ms = motionMs('--d-3')
  if (!ms) return mutate()
  const live = [...els]
  const before = live.map((el) => el.getBoundingClientRect())
  mutate()
  const easing = easeOut()
  const runs: Animation[] = []
  live.forEach((el, i) => {
    for (const a of el.getAnimations()) if (a.id === FLIP_ID) a.cancel()
    const now = el.getBoundingClientRect()
    const dx = before[i]!.left - now.left
    const dy = before[i]!.top - now.top
    if (!el.isConnected || (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5)) return
    runs.push(el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { id: FLIP_ID, duration: ms, easing }))
  })
  if (!runs.length) return
  flipping++
  document.documentElement.dataset.flipping = ''
  void Promise.allSettled(runs.map((a) => a.finished)).then(() => {
    if (--flipping === 0) delete document.documentElement.dataset.flipping
  })
}

/** 飞入：el 已在新位置，从 from 飞过来，不透明度 0.4 → 1（对话发送：消息从输入框飞到气泡）。
 *  anchor = 用来对齐的那部分（默认 el 自己）：起点让 anchor 的左上角压在 from 的左上角。
 *  时长取 --d-3 的 1.125 倍（约 360ms）；减弱动效时什么都不做 */
export function flyFrom(el: HTMLElement, from: DOMRect, anchor: HTMLElement = el): void {
  const ms = motionMs('--d-3') * 1.125
  if (!ms) return
  const to = anchor.getBoundingClientRect()
  el.animate(
    [{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`, opacity: 0.4 }, { transform: 'none', opacity: 1 }],
    { duration: ms, easing: easeOut() },
  )
}

/** 引用飞行：一个小胶囊从 from（点的按钮）飞到 to；落点不在视口就不飞。
 *  to 是真胶囊（文档草稿里的块引用）时飞行期间先藏起来、落地再显现 —— 用 WAAPI 压不透明度，不改 to 的属性
 *  （它是 PM 管的节点 DOM，改属性会被当成内容变动重读）；to 是输入框时胶囊落进去后淡掉。时长取 --d-3 的 1.3 倍（约 420ms） */
export function flyGhost(from: DOMRect, to: HTMLElement, label: string, opts: { reveal: boolean }): void {
  const ms = motionMs('--d-3') * 1.3
  if (!ms) return
  const b = to.getBoundingClientRect()
  if (b.top < 0 || b.bottom > window.innerHeight) return
  const ghost = document.createElement('span')
  ghost.className = 'fly-ghost'
  ghost.textContent = `↳ ${label}`
  // 落进输入框：放在框内左上（真记号是框里的文字，没有元素可对齐）
  ghost.style.left = `${opts.reveal ? b.left : b.left + 8}px`
  ghost.style.top = `${opts.reveal ? b.top : b.top + 6}px`
  document.body.append(ghost)
  if (opts.reveal) to.animate([{ opacity: 0 }, { opacity: 0 }], { duration: ms })
  const start = `translate(${from.left - b.left}px, ${from.top - b.top}px) scale(0.6)`
  const frames: Keyframe[] = opts.reveal
    ? [{ transform: start, opacity: 0 }, { opacity: 1, offset: 0.25 }, { transform: 'none', opacity: 1 }]
    : [{ transform: start, opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 1, offset: 0.8 }, { transform: 'none', opacity: 0 }]
  const anim = ghost.animate(frames, { duration: ms, easing: easeOut() })
  void anim.finished.finally(() => ghost.remove())
}

/** el 之后的内容（逐层往外取后续兄弟，到 root 为止）：删掉 el 时要补位的那些元素 */
export function followersOf(el: Element, root: Element): Element[] {
  const out: Element[] = []
  for (let p: Element | null = el; p && p !== root && p !== document.body; p = p.parentElement) {
    for (let n = p.nextElementSibling; n; n = n.nextElementSibling) out.push(n)
  }
  return out
}

/** 删除：先淡出，再让后面的内容平滑补位（flip 包住 apply）。淡出用 WAAPI 不改 el 的属性（它常是 PM 管的节点 DOM，
 *  改属性会被当成内容变动重读）。apply 自己在执行前重找目标（动画期间文档可能被协同端改了）；没删成就恢复不透明。
 *  减弱动效时直接 apply */
export function vanish(el: HTMLElement, followers: () => Element[], apply: () => void): void {
  const ms = motionMs('--d-2')
  if (!ms) return apply()
  const fade = el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-4px) scale(0.98)' }], {
    duration: ms,
    easing: easeOut(),
    fill: 'forwards',
  })
  const done = (): void => {
    flip(followers(), apply)
    if (el.isConnected) fade.cancel()
  }
  void fade.finished.then(done, done)
}
