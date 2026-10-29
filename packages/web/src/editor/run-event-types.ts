// ---------- SSE 里哪些事件是「一轮的事件」（交给共享 reducer applyRunEvent 归约） ----------
// 页面 SSE 上混着三类东西：一轮的事件（RunEvent）、会话级事件（commands / config / 审批）、页面级事件（status / run 快照 / team_plan …）。
// 只有第一类能进 applyRunEvent。这张表用 `satisfies Record<RunEvent['type'], true>` 与 RunEvent 的联合类型逐项对上：
// shared 里加了新的事件类型而这里漏了，编译直接报错，不会静默丢事件。
import type { RunEvent } from '@ramet/shared/run-model'

const RUN_EVENT_TYPES = {
  reply: true,
  think: true,
  said: true,
  step: true,
  child: true,
  info: true,
  plan: true,
  team: true,
} satisfies Record<RunEvent['type'], true>

export function isRunEventType(type: unknown): type is RunEvent['type'] {
  return typeof type === 'string' && Object.hasOwn(RUN_EVENT_TYPES, type)
}
