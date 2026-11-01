// ---------- 审批请求里「要做什么」的最小摘要 ----------
// 原生驱动把详情放在审批事件的 view（中性步骤视图），toolCall 只有 {toolCallId, title, kind}；
// 老 connector 经 ACP 发来的 toolCall 是 agent 原样给的一大包（rawInput / content / locations / _meta…）。
// 审计（manager 的 approvalDetail）和收件箱（inbox.ts）只需要其中的命令 / 路径 / 说明，不整包往外吐：
// 这里统一抽一次（view 优先，缺的字段再从 toolCall 推），字段限长、只认字符串。
import type { ToolView } from '@ramet/shared/run-model'

export type ApprovalPreview = {
  /** 工具类别（execute / edit / read …） */
  kind?: string
  /** rawInput.command：要执行的命令行 */
  command?: string
  /** 要改 / 读的文件：rawInput.file_path / path，或 locations[0].path */
  path?: string
  /** rawInput.description：agent 对这一步的说明 */
  description?: string
}

const COMMAND_MAX = 500
const PATH_MAX = 300
const DESCRIPTION_MAX = 200
/** 没有 rawInput 的 `other` 类审批（Ramet 自己的「记住这条？」）：说明取 content 里的文字，整条记忆都要让人看见 */
const CONTENT_NOTE_MAX = 2000

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v ? v.slice(0, max) : undefined)
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)

/** 老 connector 发来的 ACP ToolCallContent 里第一段文字：`{type:'content', content:{type:'text', text}}` */
function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  for (const item of content) {
    const inner = obj(obj(item)?.content)
    const text = str(inner?.text, CONTENT_NOTE_MAX)
    if (text) return text
  }
  return undefined
}

export function approvalPreview(toolCall: Record<string, unknown> | undefined, view?: ToolView): ApprovalPreview {
  if (!toolCall && !view) return {}
  const raw = obj(toolCall?.rawInput)
  const location = Array.isArray(toolCall?.locations) ? obj(toolCall.locations[0]) : undefined
  const out: ApprovalPreview = {}
  const kind = str(toolCall?.kind, 40)
  const command = str(view?.command, COMMAND_MAX) ?? str(raw?.command, COMMAND_MAX)
  const path = str(view?.path, PATH_MAX) ?? str(view?.diffs?.[0]?.path, PATH_MAX)
    ?? str(raw?.file_path, PATH_MAX) ?? str(raw?.path, PATH_MAX) ?? str(location?.path, PATH_MAX)
  const description = str(view?.description, DESCRIPTION_MAX) ?? str(raw?.description, DESCRIPTION_MAX)
    ?? (kind === 'other' && !raw ? contentText(toolCall?.content) : undefined)
  if (kind) out.kind = kind
  if (command) out.command = command
  if (path) out.path = path
  if (description) out.description = description
  return out
}
