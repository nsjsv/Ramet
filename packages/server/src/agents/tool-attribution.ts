// ---------- 各家 ACP 子代理进度 → 同一步骤上的归属 ----------
// 不打开不稳定的 subagent 子会话。各家已经把过程放在父会话的工具更新里，形状不同：
//   claude  `_meta.claudeCode.parentToolUseId`（子步骤 / 子正文归到那次 Agent|Task）
//   omp     `rawOutput.details.progress`（currentTool、intent；整段替换 activity）
//   codex   `rawInput.agentsStates`（status / message）或 `activityKind`
//   opencode `rawInput.subagent_type` + `description`
//   pi      子代理扩展的 `agent` + `task`（没有 parent 编号，进度就是这一步的 activity）
// 正文、diff、整段 raw 输出仍不往外送。

const ACTIVITY_MAX = 160

export type ToolFace = {
  parentId?: string
  activity?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function clip(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return flat.length > ACTIVITY_MAX ? flat.slice(0, ACTIVITY_MAX) : flat
}

function ompActivity(rawOutput: unknown): string | undefined {
  const details = record(record(rawOutput)?.details)
  const progress = details?.progress
  const snap = Array.isArray(progress) ? record(progress[0]) : record(progress)
  if (!snap) return undefined
  const tool = text(snap.currentTool)
  const intent = text(snap.currentToolIntent) ?? text(snap.lastIntent)
  if (tool && intent) return clip(`${tool} · ${intent}`)
  if (tool) return clip(tool)
  if (intent) return clip(intent)
  const recent = Array.isArray(snap.recentTools) ? record(snap.recentTools[0]) : undefined
  const recentTool = text(recent?.tool)
  const recentIntent = text(recent?.intent)
  if (recentTool && recentIntent) return clip(`${recentTool} · ${recentIntent}`)
  if (recentTool) return clip(recentTool)
  return undefined
}

function codexActivity(rawInput: unknown): string | undefined {
  const input = record(rawInput)
  if (!input) return undefined
  const states = record(input.agentsStates)
  if (states) {
    for (const value of Object.values(states)) {
      const state = record(value)
      if (!state) continue
      const message = text(state.message)
      if (message) return clip(message)
      const status = text(state.status)
      if (status && status !== 'completed' && status !== 'shutdown') return clip(status)
    }
  }
  const kind = text(input.activityKind)
  return kind ? clip(kind) : undefined
}

function openCodeActivity(rawInput: unknown): string | undefined {
  const input = record(rawInput)
  if (!input) return undefined
  const type = text(input.subagent_type)
  if (!type) return undefined
  const description = text(input.description)
  return clip(description ? `${type} · ${description}` : type)
}

/** pi 的 ACP 适配器不单开子会话；扩展把子任务写在工具参数的 agent + task 上 */
function piActivity(rawInput: unknown): string | undefined {
  const input = record(rawInput)
  if (!input || text(input.subagent_type) || record(input.agentsStates)) return undefined
  const agent = text(input.agent)
  const task = text(input.task)
  if (!agent || !task) return undefined
  return clip(`${agent} · ${task}`)
}

export function toolFace(update: { _meta?: unknown; rawInput?: unknown; rawOutput?: unknown }): ToolFace {
  const face: ToolFace = {}
  const claude = record(record(update._meta)?.claudeCode)
  const parentId = text(claude?.parentToolUseId)
  if (parentId) face.parentId = parentId
  const activity = ompActivity(update.rawOutput) ?? codexActivity(update.rawInput) ?? openCodeActivity(update.rawInput) ?? piActivity(update.rawInput)
  if (activity) face.activity = activity
  return face
}

/** 子代理自己的正文/思考：归到唤起它的那次工具调用，不进父回复 */
export function chunkParent(update: { _meta?: unknown }): string | undefined {
  return text(record(record(update._meta)?.claudeCode)?.parentToolUseId)
}
