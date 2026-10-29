// 失败原因：按回复块 id 暂存，失败条（运行中 / 已收尾）读它。
// 原因只在运行时经 SSE 的 error 事件到达（带 replyId 的那种），事件不落库，所以刷新后只剩固定文案。
// 独立成模块：agent-bar（收事件）与 reply-fail（画失败条）都要用，而 reply-fail 又依赖 agent-bar 的重新生成，
// 放在任何一边都会绕成环。

const reasons = new Map<string, string>()
const MAX_REASONS = 50

/** 记下失败原因（覆盖旧的：重试复用同一块 id，新一轮的原因要盖掉上一轮的） */
export function rememberFailReason(replyId: string, reason: string | undefined): void {
  const text = reason?.trim()
  if (!replyId || !text) return
  reasons.delete(replyId)
  reasons.set(replyId, text)
  if (reasons.size > MAX_REASONS) reasons.delete(reasons.keys().next().value as string)
}

/** 没有更具体的原因时的兜底（status 事件自带的通用文案）：已有原因就不覆盖 */
export function rememberFailReasonIfAbsent(replyId: string, reason: string | undefined): void {
  if (!reasons.has(replyId)) rememberFailReason(replyId, reason)
}

/** 新一轮开始：上一轮的原因作废 */
export function forgetFailReason(replyId: string): void {
  reasons.delete(replyId)
}

export function failReasonOf(replyId: string): string | undefined {
  return reasons.get(replyId)
}
