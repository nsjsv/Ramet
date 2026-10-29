/* ---------- 带队卡片（回复里 / 过程页里的同一个组件）----------
 * 一份 TeamState 快照进来，draft 画计划卡（PlanCard，数据以计划视图 store 为准），其余画进度卡（ProgressCard）。
 * 计划轮那条回复上的快照恒是草稿，执行轮那条回复上的快照从 running 起，所以只看快照自己的状态，不看 store。 */

import type { TeamState } from '@ramet/shared/run-model'
import { PlanCard } from './PlanCard'
import { ProgressCard } from './ProgressCard'
import { isPlanSnapshot } from './team-model'

export interface TeamCardProps {
  pageId: string
  /** 来源快照：运行中 = RunState.team；收尾后 = 回复块 team 属性；过程页 = record.team */
  team: TeamState
  /** 实时视图：本机时钟下本轮开始的时刻（进行中的条据此伸长）；静态没有 */
  startedAt?: number
  /** 这一轮已经结束（实时视图收尾；静态恒真） */
  ended?: boolean
  /** 页面可写（才有开工 / 改 / 取消）；viewer 为 false */
  canAct: boolean
  /** 过程页 / 公开页：只画快照，不拉计划视图、不订阅页面事件、不能操作 */
  snapshotOnly?: boolean
}

export function TeamCard({ pageId, team, startedAt, ended = true, canAct, snapshotOnly = false }: TeamCardProps) {
  if (isPlanSnapshot(team)) return <PlanCard pageId={pageId} team={team} canAct={canAct && !snapshotOnly} snapshotOnly={snapshotOnly} />
  return <ProgressCard team={team} startedAt={startedAt} ended={ended} />
}
