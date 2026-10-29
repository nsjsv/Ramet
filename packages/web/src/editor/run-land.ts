// ---------- 运行条的收尾与补位（纯动画，只动 transform / opacity） ----------
// 运行条在回复块里位于抬头之下、正文之上，所以它消失时只有下面的东西上移，抬头不动。
// 收尾序列（时长全走令牌，减弱动效直接到终态）：
//   1. 托盘折回胶囊，胶囊里的字淡出（--d-2）
//   2. 用量标签从胶囊的位置飞到它自己的位置（标签才是真元素：结构化块落下后它已在原位），旧胶囊缩小淡出
//   3. 运行条摘出布局（agent 报过计划的话计划卡留在原位，全部完成的折成一行，见 plan-card.ts 的 retireStrip），
//      下面的正文与后续块用 FLIP 平移补位（--d-3），不做 height 动画
// 起点或终点不在视野内就不飞。
import { easeOut, flip, followersAfter, motionMs, reducedMotion } from '../motion'
import { retireStrip } from './plan-card'

const inView = (r: DOMRect): boolean => r.width > 0 && r.bottom > 0 && r.top < window.innerHeight

const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms))

/** 收尾：`chip` = 用量标签（可为 null / 不在视野内就只淡出）；resolve 时运行条已摘出布局 */
export async function landStrip(opts: { strip: HTMLElement; pill: HTMLElement; tray: HTMLElement; chip: HTMLElement | null }): Promise<void> {
  const { strip, pill, tray, chip } = opts
  if (reducedMotion()) {
    retireStrip(strip)
    return
  }
  const d2 = motionMs('--d-2')
  const d3 = motionMs('--d-3')
  const easing = easeOut()
  const from = pill.getBoundingClientRect()
  const to = chip?.getBoundingClientRect()
  const fly = chip !== null && to !== undefined && inView(from) && inView(to)

  // 1. 托盘折回、胶囊内容淡出
  if (tray.offsetParent) {
    tray.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-8px) scaleY(0.9)' }], { duration: d2, easing, fill: 'forwards' })
  }
  for (const child of pill.children) child.animate([{ opacity: 1 }, { opacity: 0 }], { duration: d2, easing, fill: 'forwards' })
  await wait(d2)

  // 2. 用量标签飞过去，旧胶囊缩小淡出
  if (fly && chip && to) {
    const dx = from.left - to.left
    const dy = from.top + from.height / 2 - (to.top + to.height / 2)
    chip.animate([{ transform: `translate(${dx}px, ${dy}px)`, opacity: 0 }, { opacity: 1, offset: 0.35 }, { transform: 'none', opacity: 1 }], { duration: d3, easing })
  }
  pill.style.transformOrigin = 'left center'
  pill.animate([{ transform: 'none', opacity: 1 }, { transform: 'scale(0.6)', opacity: 0 }], { duration: d2, easing, fill: 'forwards' })
  await wait(d2)

  // 3. 摘出布局，下面的内容补位
  flip(followersAfter(strip), () => retireStrip(strip))
}
