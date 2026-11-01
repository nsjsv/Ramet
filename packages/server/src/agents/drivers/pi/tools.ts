// ---------- pi / omp 的内置工具 → 步骤的种类 / 一行标题 / 中性视图 ----------
// 工具名与参数以实测（pi 1.4.0 / omp 18.14.1）与各自的工具定义为准；两家同名工具的参数形状基本一致，差异在这里按字段兼容。
// 认不出的工具落 other，参数原样进 view.raw，不猜。子代理（omp 的 task）与计划（omp 的 todo）要跨事件记账，在 events.ts 里处理。

import type { ToolDiff, ToolView } from '@ramet/shared/run-model'
import type { StepKind, StepStatus } from '../../types.js'
import { clipDiffs, clipText, clipValue, NOTE_MAX, oneLine, rec, str, stripAnsi, TITLE_MAX } from '../tool-text.js'

const KINDS: Record<string, StepKind> = {
  read: 'read',
  ls: 'search',
  find: 'search',
  glob: 'search',
  grep: 'search',
  bash: 'execute',
  eval: 'execute',
  python: 'execute',
  edit: 'edit',
  write: 'edit',
  web_search: 'fetch',
  fetch: 'fetch',
  web_fetch: 'fetch',
  // 子代理与其它驱动同口径（think）
  task: 'think',
}

/** 唤起子代理的工具（omp）：RPC 模式下是后台作业，工具当场结束、子代理随后才跑完 */
export const SUBAGENT_TOOL = 'task'
/** 计划清单工具（omp）：内容走 plan 原语，不产生步骤 */
export const PLAN_TOOL = 'todo'
/** 提问工具（omp rpc-ui）：问题经扩展 UI 的 ask 对话框到达 */
export const ASK_TOOL = 'ask'
/** 实时输出要进步骤 output 的工具：partialResult 是到此刻为止的全部输出 */
export const STREAMING_TOOLS: ReadonlySet<string> = new Set(['bash', 'eval', 'python'])

/** pi 的 MCP 工具名 `mcp__<服务>__<工具>`（服务名本身可能带下划线，工具名取最后一段） */
function mcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice(5)
  const cut = rest.lastIndexOf('__')
  return cut > 0 ? { server: rest.slice(0, cut), tool: rest.slice(cut + 2) } : { server: rest, tool: '' }
}

const clipTitle = (text: string): string => (text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text)

export type ToolFace = { kind: StepKind; title: string; detail?: string; view: ToolView; truncated?: boolean }
export type ToolDone = { status: StepStatus; view: ToolView; note?: string; truncated?: boolean }

/** 编辑类的 diff：pi 1.x 的 edit 是 edits[{oldText, newText}]，老版本与 omp 的替换模式是顶层的 oldText / newText（或下划线写法）；
 *  write 是整份新内容（旧内容不知道，old 为空） */
function diffsOf(name: string, input: Record<string, unknown>, path: string): ToolDiff[] | undefined {
  const pair = (e: Record<string, unknown>): ToolDiff => ({
    path: str(e.path) || path,
    old: str(e.oldText) || str(e.old_text) || str(e.old_string),
    new: str(e.newText) || str(e.new_text) || str(e.new_string),
  })
  if (name === 'write') return [{ path, old: '', new: str(input.content) }]
  if (name !== 'edit') return undefined
  if (Array.isArray(input.edits)) return input.edits.map(rec).map(pair)
  if ('oldText' in input || 'old_text' in input || 'newText' in input || 'new_text' in input) return [pair(input)]
  return undefined
}

/** 子代理那一步的一行字：第一个任务的说明 → 任务正文里第一行不是 markdown 标题的文字 → 任务名 → 标题本身。
 *  omp 的任务正文常以「# Target」这类标题开头，直接取第一行，标签上就只剩一个标题词 */
function taskTitle(input: Record<string, unknown>): string {
  const first = rec(Array.isArray(input.tasks) ? input.tasks[0] : undefined)
  const described = str(first.description)
  if (described) return oneLine(described)
  const lines = (str(first.task) || str(first.assignment) || str(input.context) || str(input.description) || str(input.prompt))
    .split('\n').map((l) => l.trim()).filter(Boolean)
  const prose = lines.find((l) => !/^#{1,6}\s/.test(l))
  return oneLine(prose ?? (str(first.name) || str(first.id) || (lines[0] ?? '').replace(/^#{1,6}\s+/, '')))
}

function askTitle(input: Record<string, unknown>): string {
  const first = rec(Array.isArray(input.questions) ? input.questions[0] : undefined)
  return oneLine(str(first.question) || str(first.header))
}

/** 一次工具调用开始：种类、一行标题（不带动作词，前端按 kind 配）、detail（主路径）与视图 */
export function toolFace(name: string, rawArgs: unknown): ToolFace {
  const input = rec(rawArgs)
  const mcp = mcpName(name)
  const kind: StepKind = KINDS[name] ?? 'other'
  const view: ToolView = { tool: name }
  let truncated = false

  const path = str(input.path) || str(input.file_path) || str(input.filePath)
  if (path && (kind === 'read' || kind === 'edit' || name === 'ls')) view.path = path
  if (name === 'bash') {
    const command = str(input.command).trim()
    if (command) view.command = command
    if (str(input.cwd)) view.cwd = str(input.cwd)
  } else if (name === 'eval' || name === 'python') {
    const code = str(input.code) || str(input.command)
    if (code.trim()) view.command = code.trim()
  } else if (name === 'grep' || name === 'find' || name === 'glob') {
    const pattern = str(input.pattern) || str(input.query)
    if (pattern) view.query = pattern
    if (path) view.cwd = path
  } else if (kind === 'fetch') {
    const query = str(input.query) || str(input.url)
    if (query) view.query = query
  }
  const description = str(input.description).trim() || str(input.intent).trim()
  if (description && name !== SUBAGENT_TOOL) view.description = description
  const diffs = diffsOf(name, input, path)
  if (diffs) {
    const clipped = clipDiffs(diffs)
    view.diffs = clipped.diffs
    if (clipped.truncated) truncated = true
  }
  const raw = clipValue(rawArgs)
  if (raw.truncated) truncated = true
  view.raw = { input: raw.value }

  let title: string
  if (view.command) title = oneLine(view.command)
  else if (view.path) title = clipTitle(view.path)
  else if (view.query) title = oneLine(view.query)
  else if (name === SUBAGENT_TOOL) title = taskTitle(input) || '子代理'
  else if (name === ASK_TOOL) title = askTitle(input) || '提问'
  else if (mcp) title = mcp.tool ? `${mcp.server}: ${mcp.tool}` : mcp.server
  else title = name

  return {
    kind,
    title,
    ...(view.path ? { detail: clipTitle(view.path) } : {}),
    view,
    ...(truncated ? { truncated: true } : {}),
  }
}

/** 工具结果的 content：只取文字块 */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map(rec).filter((b) => b.type === 'text').map((b) => str(b.text)).join('\n')
}

/** 命令的退出码：pi 的 bash 在 structuredContent.exit_code；omp 只在失败时于 details.exitCode 给出，成功没有这个字段 */
function exitCodeOf(result: Record<string, unknown>): number | undefined {
  const pi = rec(result.structuredContent).exit_code
  if (typeof pi === 'number') return pi
  const omp = rec(result.details).exitCode
  return typeof omp === 'number' ? omp : undefined
}

/** 后台作业（omp 的 task）：工具结束时子代理还在跑 */
export function isAsyncRunning(result: unknown): boolean {
  return rec(rec(rec(result).details).async).state === 'running'
}

/** 工具结束：状态、结果文字、退出码、原样输出 */
export function toolDone(name: string, rawArgs: unknown, rawResult: unknown, isError: boolean): ToolDone {
  const result = rec(rawResult)
  const view: ToolView = {}
  let truncated = false
  // 命令输出几乎总以换行结尾，结果里不留这个尾巴
  const text = stripAnsi(contentText(result.content)).trimEnd()
  if (text) {
    const clipped = clipText(text)
    view.result = clipped.text
    if (clipped.truncated) truncated = true
  }
  if (name === 'bash') {
    const code = exitCodeOf(result)
    if (code !== undefined) view.exit = { code, signal: null }
    else if (!isError) view.exit = { code: 0, signal: null }
  }
  const out = clipValue({
    ...(result.details !== undefined ? { details: result.details } : {}),
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    ...(result.details === undefined && result.structuredContent === undefined ? { content: result.content } : {}),
  })
  if (out.truncated) truncated = true
  view.raw = { input: clipValue(rawArgs).value, output: out.value }
  const note = isError ? oneLine(text, NOTE_MAX) || (view.exit ? `退出码 ${view.exit.code}` : '失败') : ''
  return { status: isError ? 'failed' : 'completed', view, ...(note ? { note } : {}), ...(truncated ? { truncated: true } : {}) }
}

/** omp todo 工具结果的 details.phases → plan 条目的原料（交给 normalizePlan 归一）。
 *  omp 多出来的两种状态没有对应的格子：放弃的记成完成并注明（不再要做），受阻的记成待办并带上原因 */
export function todoEntries(rawResult: unknown): unknown[] {
  const phases = rec(rec(rawResult).details).phases
  if (!Array.isArray(phases)) return []
  return phases.map(rec).flatMap((phase) =>
    (Array.isArray(phase.tasks) ? phase.tasks : []).map(rec).map((t) => {
      const content = str(t.content)
      if (t.status === 'abandoned') return { content: `${content}（已放弃）`, status: 'completed' }
      if (t.status === 'blocked') return { content: str(t.blocker) ? `${content}（受阻：${str(t.blocker)}）` : `${content}（受阻）`, status: 'pending' }
      return { content, status: str(t.status) }
    }),
  )
}

/** 累计输出 → 这次新到的部分。partialResult 每次给到此刻为止的全部输出；工具只留最后若干行时前缀会变，
 *  那就按上一次的末尾在新文字里找接续点，找不到才整段当新的（宁可重复一点，不丢输出） */
export function outputDelta(prev: string, next: string): string {
  if (next.startsWith(prev)) return next.slice(prev.length)
  const tail = prev.slice(-200)
  const at = tail ? next.lastIndexOf(tail) : -1
  return at >= 0 ? next.slice(at + tail.length) : next
}
