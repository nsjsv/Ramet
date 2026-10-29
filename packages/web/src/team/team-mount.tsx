/* ---------- 把带队卡片挂进非 React 的宿主（widget / 聊天气泡 / 运行条里没有 React root，同 message-chips.tsx）----------
 * mountTeam 给运行条用，一个实例活到这一轮的运行条被销毁，set() 每次换 props 重新 render。
 * buildTeamStrip 是回复块收尾后的静态条（回复块的 team 属性），装饰 / 气泡每次重建时调用，destroy 时用 disposeTeamStrips 卸载 root。
 * 卸载一律异步：destroy 可能发生在 React 渲染途中（PM 更新在 effect 里触发），同步卸载 React 会警告。 */

import { createRoot, type Root } from 'react-dom/client'
import type { TeamState } from '@ramet/shared/run-model'
import { TeamCard, type TeamCardProps } from './TeamCard'

type Hosted = HTMLElement & { __teamRoot?: Root }

export interface TeamMount {
  el: HTMLElement
  set(props: TeamCardProps): void
  dispose(): void
}

export function mountTeam(props: TeamCardProps): TeamMount {
  const el: Hosted = document.createElement('div')
  el.className = 'team-host'
  el.contentEditable = 'false'
  const root = createRoot(el)
  el.__teamRoot = root
  root.render(<TeamCard {...props} />)
  return {
    el,
    set: (next) => root.render(<TeamCard {...next} />),
    dispose: () => {
      el.__teamRoot = undefined
      queueMicrotask(() => root.unmount())
    },
  }
}

/** 回复块上的带队快照做成一个只含团队卡的静态条（外层沿用 .run-strip 的间距与对齐，同 plan-card.ts 的 buildPlanStrip） */
export function buildTeamStrip(team: TeamState, opts: { pageId: string; canAct: boolean }): HTMLElement {
  const strip = document.createElement('div')
  strip.className = 'run-strip is-team'
  strip.contentEditable = 'false'
  strip.append(mountTeam({ pageId: opts.pageId, team, canAct: opts.canAct, ended: true }).el)
  return strip
}

/** 装饰 / 气泡 widget 的 destroy 回调，卸载里面的团队卡 */
export function disposeTeamStrips(dom: Node): void {
  if (!(dom instanceof HTMLElement)) return
  for (const host of dom.querySelectorAll<Hosted>('.team-host')) {
    const root = host.__teamRoot
    host.__teamRoot = undefined
    if (root) queueMicrotask(() => root.unmount())
  }
}
