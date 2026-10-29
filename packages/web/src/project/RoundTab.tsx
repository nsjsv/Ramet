import { HudEmbedded } from '../hud/HudLayer'

/* ---------- 本轮分页：项目面板开着时，右上角工作台的面板收进这里（同一个 HudPanel 的嵌入模式）----------
 * 看的是哪一轮跟右上角一致：点过岛 / 停靠的岛就是那一轮，否则是这一页在飞的那一轮；没有就给一句说明。 */
export default function RoundTab({ pageId, canStop }: { pageId: string; canStop: boolean }) {
  return <HudEmbedded pageId={pageId} canStop={canStop} />
}
