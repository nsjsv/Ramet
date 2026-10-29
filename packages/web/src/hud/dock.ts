/* ---------- 回复抬头停靠的岛 ----------
 * 一轮跑完，右上角的岛飞进这里停靠：「✓ 总览 用时 · 步骤 N · 任务 a/b · 改动 n +x −y · 协作 n」。
 * 数据只读回复块属性（stats / plan / run / agent），不拉 record；点任何一段，飞回右上角并展开面板的对应分页。
 * 也是两个动画的落点：运行条收尾（run-land.ts）与过程页出门变形（run-door.ts，认 `.island.is-docked[data-run]`）。
 * 没有过程页（run）的老块只展示、不能点（面板要按过程页拉 record）。 */
import { decodeStats } from '@ramet/shared/reply-stats'
import { statsTip } from '../editor/run-format'
import { dockView } from './hud-model'
import { openHud } from './hud-store'
import { createIsland } from './island'
import { liftIsland } from './island-flight'

export function buildDock(attrs: { id: unknown; agent: unknown; stats: unknown; plan: unknown; run: unknown }, pageId: string): HTMLElement | null {
  const view = dockView(attrs)
  if (!view) return null
  const replyId = typeof attrs.id === 'string' ? attrs.id : ''
  const runId = typeof attrs.run === 'string' && attrs.run ? attrs.run : null
  const island = createIsland('dock', {
    tab: (tab, el) => {
      if (!runId) return
      liftIsland(el)
      openHud(tab, { pageId, replyId, runId })
    },
  })
  island.paint(view)
  island.el.dataset.reply = replyId
  if (runId) island.el.dataset.run = runId
  else island.el.classList.add('is-static')
  // 用量明细（输入 / 输出 / 缓存 / 上下文）挂在「总览」那一段的悬停提示上
  const tip = statsTip(decodeStats(attrs.stats), false)
  island.el.querySelector<HTMLElement>('[data-tab="overview"]')?.setAttribute('title', tip)
  return island.el
}
