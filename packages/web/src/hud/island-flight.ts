/* ---------- 岛的飞行：右上角 ⇄ 回复抬头停靠位（幽灵 FLIP，同 run-land.ts 的做法）----------
 * 浮的岛与停靠的岛是两个元素（一个在 React 的 ref 里，一个是 ProseMirror decoration），不跨 DOM 树搬真元素：
 * 克隆起点当幽灵、量终点，只补间 transform / opacity；落地时终点那个真元素淡入。
 * 起点或终点不在视野内、减弱动效 → 不飞，直接到位。终点可能晚到（收尾事务稍后才把停靠的岛画出来）：最多等 WAIT_MS。 */
import { easeOut, motionMs, reducedMotion } from '../motion'

const WAIT_MS = 1500

const inView = (r: DOMRect): boolean => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight

function waitFor(find: () => HTMLElement | null): Promise<HTMLElement | null> {
  const t0 = performance.now()
  return new Promise((resolve) => {
    const tick = (): void => {
      const el = find()
      if (el || performance.now() - t0 > WAIT_MS) return resolve(el)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

/** 从 fromRect（起点元素 from 的克隆）飞到 to；to 在飞行期间先藏起来，落地后淡入 */
function fly(from: HTMLElement, fromRect: DOMRect, to: HTMLElement): void {
  const toRect = to.getBoundingClientRect()
  const ms = motionMs('--d-3') * 1.5
  if (!ms || reducedMotion() || !inView(fromRect) || !inView(toRect)) return
  const ghost = from.cloneNode(true) as HTMLElement
  ghost.classList.add('island-ghost')
  Object.assign(ghost.style, {
    position: 'fixed',
    left: `${fromRect.left}px`,
    top: `${fromRect.top}px`,
    width: `${fromRect.width}px`,
    height: `${fromRect.height}px`,
    margin: '0',
    zIndex: '60',
    pointerEvents: 'none',
    transformOrigin: 'top left',
  })
  document.body.append(ghost)
  to.style.opacity = '0'
  const dx = toRect.left - fromRect.left
  const dy = toRect.top - fromRect.top
  const sx = toRect.width / fromRect.width
  const sy = toRect.height / fromRect.height
  const anim = ghost.animate(
    [
      { transform: 'none', opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.6 },
    ],
    { duration: ms, easing: easeOut(), fill: 'forwards' },
  )
  const land = (): void => {
    ghost.remove()
    to.style.opacity = ''
    to.animate([{ opacity: 0 }, { opacity: 1 }], { duration: motionMs('--d-1'), easing: 'ease-out' })
  }
  void anim.finished.then(land, land)
}

/** 抬起：停靠的岛 → 右上角（面板随后展开）。dock = 被点的停靠岛；右上角的岛这一帧还没画出来，等它出现 */
export function liftIsland(dock: HTMLElement): void {
  const rect = dock.getBoundingClientRect()
  const ghostSource = dock.cloneNode(true) as HTMLElement
  void waitFor(() => document.querySelector<HTMLElement>('.hud .island')).then((to) => {
    if (to) fly(ghostSource, rect, to)
  })
}

/** 回家：右上角的岛 → 它那条回复抬头的停靠位。float = 即将被摘掉的浮岛（先量、先克隆），replyId 认停靠位 */
export function dockIsland(float: HTMLElement, replyId: string): void {
  const rect = float.getBoundingClientRect()
  const ghostSource = float.cloneNode(true) as HTMLElement
  void waitFor(() => document.querySelector<HTMLElement>(`.island.is-docked[data-reply="${CSS.escape(replyId)}"]`)).then((to) => {
    if (to) fly(ghostSource, rect, to)
  })
}
