// ---------- Claude Code 内置工具 → 步骤的种类 / 一行标题 / 中性视图 ----------
// 工具名与输入输出的形状以 @anthropic-ai/claude-agent-sdk 的 sdk-tools.d.ts 为准（升级 SDK 时对一遍）。
// 认不出的工具落 other，输入原样进 view.raw，不猜。前端只读视图（viewOf），这里是 Claude 步骤视图的唯一来源。

import type { ToolDiff, ToolView } from '@ramet/shared/run-model'
import type { StepKind } from '../../types.js'
import { clipDiffs, clipText, clipValue, NOTE_MAX, oneLine, rec, str, stripAnsi, TITLE_MAX } from '../tool-text.js'

/** `mcp__<server>__<tool>`：服务名本身可能带下划线，工具名取最后一段 */
function mcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice(5)
  const cut = rest.lastIndexOf('__')
  return cut > 0 ? { server: rest.slice(0, cut), tool: rest.slice(cut + 2) } : { server: rest, tool: '' }
}

const KINDS: Record<string, StepKind> = {
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'execute',
  BashOutput: 'execute',
  Monitor: 'execute',
  Grep: 'search',
  Glob: 'search',
  ToolSearch: 'search',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
  // 子代理记成 think，协作统计按「被别的步骤 parentId 引用」认，不看 kind
  Agent: 'think',
  Task: 'think',
  ExitPlanMode: 'switch_mode',
  EnterPlanMode: 'switch_mode',
}

/** 唤起子代理的工具：它的 tool_use_id 是子代理里所有消息的 parent_tool_use_id */
export function isSubagentTool(name: string): boolean {
  return name === 'Agent' || name === 'Task'
}

/** 计划清单工具：内容走 plan 原语，不产生步骤 */
export const PLAN_TOOL = 'TodoWrite'

export type ToolFace = { kind: StepKind; title: string; detail?: string; view: ToolView; truncated?: boolean }

/** 编辑类的 diff：Edit = old_string → new_string；MultiEdit = 每一处一条；Write = 整份（旧内容等结果里的 originalFile 补） */
function diffsOf(name: string, input: Record<string, unknown>, path: string): ToolDiff[] | undefined {
  if (name === 'Edit') return [{ path, old: str(input.old_string), new: str(input.new_string) }]
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.map(rec).map((e) => ({ path, old: str(e.old_string), new: str(e.new_string) }))
  }
  if (name === 'Write') return [{ path, old: '', new: str(input.content) }]
  if (name === 'NotebookEdit') return [{ path, old: '', new: str(input.new_source) }]
  return undefined
}

/** 一次 tool_use：种类、一行标题（不带动作词，前端按 kind 配）、detail（主路径）与视图 */
export function toolUseFace(name: string, rawInput: unknown): ToolFace {
  const input = rec(rawInput)
  const mcp = mcpName(name)
  const kind: StepKind = KINDS[name] ?? 'other'
  const view: ToolView = { tool: name }
  let truncated = false

  const path = str(input.file_path) || str(input.notebook_path)
  if (path) view.path = path
  const command = str(input.command).trim()
  if (command && (name === 'Bash' || name === 'Monitor')) view.command = command
  const description = str(input.description).trim()
  if (description) view.description = description
  if (name === 'Grep' || name === 'Glob') {
    const pattern = str(input.pattern)
    if (pattern) view.query = pattern
    const where = str(input.path)
    if (where) view.cwd = where
  } else if (name === 'WebFetch') {
    if (str(input.url)) view.query = str(input.url)
  } else if (name === 'WebSearch' || name === 'ToolSearch') {
    if (str(input.query)) view.query = str(input.query)
  }
  const diffs = diffsOf(name, input, path)
  if (diffs) {
    const clipped = clipDiffs(diffs)
    view.diffs = clipped.diffs
    if (clipped.truncated) truncated = true
  }
  const raw = clipValue(rawInput)
  if (raw.truncated) truncated = true
  view.raw = { input: raw.value }

  let title: string
  if (view.command) title = oneLine(view.command)
  else if (path) title = path
  else if (view.query) title = oneLine(view.query)
  else if (isSubagentTool(name)) title = oneLine(description || str(input.prompt)) || name
  else if (mcp) title = mcp.tool ? `${mcp.server}: ${mcp.tool}` : mcp.server
  else title = name

  return {
    kind,
    title,
    ...(path ? { detail: path.length > TITLE_MAX ? path.slice(0, TITLE_MAX) : path } : {}),
    view,
    ...(truncated ? { truncated: true } : {}),
  }
}

/** tool_result 的 content：字符串，或文字 / 图片块的数组（只取文字） */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(rec).filter((b) => b.type === 'text').map((b) => str(b.text)).join('\n')
}

/** CLI 把工具层面的错误包在 <tool_use_error> 里（权限拒绝、参数不对），给人看时去掉这层壳 */
function unwrapError(text: string): string {
  const m = /^\s*<tool_use_error>([\s\S]*)<\/tool_use_error>\s*$/.exec(text)
  return m ? m[1]!.trim() : text
}

export type ToolResultFace = { view: ToolView; note?: string; truncated?: boolean }

/** tool_result（+ CLI 附带的结构化 tool_use_result）→ 视图增量：结果文字、退出状态、原样输出；Write 补上旧内容 */
export function toolResultFace(name: string, rawInput: unknown, content: unknown, structured: unknown, isError: boolean): ToolResultFace {
  const input = rec(rawInput)
  const view: ToolView = {}
  let truncated = false
  const text = unwrapError(stripAnsi(resultText(content)))
  if (text) {
    const clipped = clipText(text)
    view.result = clipped.text
    if (clipped.truncated) truncated = true
  }

  const out = rec(structured)
  if (name === 'Bash') {
    // 非零退出码 CLI 记成工具出错、正文以「Exit code N」开头；放到后台的命令立刻返回，那时还没有退出码
    const background = input.run_in_background === true || typeof out.backgroundTaskId === 'string'
    const code = /^Exit code (-?\d+)/m.exec(text)
    if (code) view.exit = { code: Number(code[1]), signal: null }
    else if (!isError && !background && out.interrupted !== true) view.exit = { code: 0, signal: null }
  }
  if (name === 'Write' && typeof out.originalFile === 'string') {
    const path = str(input.file_path)
    const clipped = clipDiffs([{ path, old: out.originalFile, new: str(input.content) }])
    view.diffs = clipped.diffs
    if (clipped.truncated) truncated = true
  }

  if (structured !== undefined || content !== undefined) {
    const raw = clipValue(structured !== undefined ? structured : content)
    if (raw.truncated) truncated = true
    view.raw = { input: clipValue(rawInput).value, output: raw.value }
  }
  const note = isError ? oneLine(text, NOTE_MAX) : ''
  return { view, ...(note ? { note } : {}), ...(truncated ? { truncated: true } : {}) }
}

/** TodoWrite 的 todos → plan 条目的原料（交给 normalizePlan 归一）。Claude 的待办没有优先级 */
export function todoEntries(rawInput: unknown): unknown[] {
  const todos = rec(rawInput).todos
  return Array.isArray(todos) ? todos.map(rec).map((t) => ({ content: str(t.content), status: str(t.status) })) : []
}
