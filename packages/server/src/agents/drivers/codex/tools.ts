// ---------- codex 的条目（ThreadItem）→ 步骤的种类 / 一行标题 / 中性视图 ----------
// 条目形状以 protocol.ts（由 app-server 自带的生成器裁剪）为准。codex 读文件 / 搜索也是跑命令，种类按 commandActions 认：
// 全是读 → read，全是搜索 / 列目录 → search，其余（含混合）→ execute。认不出的条目落 other，原样进 view.raw，不猜。
// 子代理（collabAgentToolCall）的步骤要跨线程记账，在 events.ts 里处理。

import type { ToolDiff, ToolView } from '@ramet/shared/run-model'
import type { StepKind, StepStatus } from '../../types.js'
import { clipDiffs, clipText, clipValue, NOTE_MAX, oneLine, rec, str, stripAnsi, TITLE_MAX } from '../tool-text.js'
import type { CommandAction, FileUpdateChange, ThreadItem } from './protocol.js'

/** 不是步骤的条目：正文 / 思考由 events 单独翻译，计划走 turn/plan/updated，子代理生命周期由子线程自己的回合事件表达 */
const NOT_STEPS: ReadonlySet<string> = new Set([
  'userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction', 'subAgentActivity', 'collabAgentToolCall',
  'sleep', 'functionCallOutput', 'hookPrompt', 'enteredReviewMode', 'exitedReviewMode',
])

export function isStepItem(item: { type: string }): boolean {
  return !NOT_STEPS.has(item.type)
}

export type ItemFace = { kind: StepKind; title: string; detail?: string; view: ToolView; truncated?: boolean }
export type ItemDone = { status: StepStatus; view: ToolView; note?: string; truncated?: boolean }

/** `/bin/bash -lc '…'` 这类外壳只是 codex 的执行方式，给人看时去掉；原样命令仍在 view.raw */
export function stripShell(command: string): string {
  const m = /^(?:\S*\/)?(?:bash|zsh|sh)\s+-l?c\s+([\s\S]+)$/.exec(command.trim())
  if (!m) return command.trim()
  const body = m[1]!.trim()
  if (body.length >= 2 && body.startsWith("'") && body.endsWith("'")) return body.slice(1, -1).replace(/'\\''/g, "'")
  if (body.length >= 2 && body.startsWith('"') && body.endsWith('"')) return body.slice(1, -1)
  return body
}

function commandKind(actions: CommandAction[]): StepKind {
  if (actions.length === 0) return 'execute'
  if (actions.every((a) => a.type === 'read')) return 'read'
  if (actions.every((a) => a.type === 'search' || a.type === 'listFiles')) return 'search'
  return 'execute'
}

const clipTitle = (text: string): string => (text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text)

// ---------- 改文件的 diff ----------

/** unified diff → 每个 hunk 一对新旧文字（上下文行两边都有）。`\ No newline at end of file` 去掉前一行的换行 */
function hunksOf(diff: string): Array<{ old: string; new: string }> {
  const out: Array<{ old: string[]; new: string[] }> = []
  let cur: { old: string[]; new: string[] } | null = null
  let previous = ' '
  const strip = (lines: string[]) => {
    const last = lines.at(-1)
    if (last !== undefined) lines[lines.length - 1] = last.replace(/\n$/, '')
  }
  const lines = diff.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const line of lines) {
    if (line.startsWith('@@')) {
      cur = { old: [], new: [] }
      out.push(cur)
      previous = ' '
      continue
    }
    if (!cur) continue // 文件头（diff --git / --- / +++ / index）
    const sign = line[0] ?? ' '
    if (sign === '\\') {
      if (previous !== '+') strip(cur.old)
      if (previous !== '-') strip(cur.new)
      continue
    }
    if (sign !== ' ' && sign !== '-' && sign !== '+') continue
    const text = `${line.slice(1)}\n`
    if (sign !== '+') cur.old.push(text)
    if (sign !== '-') cur.new.push(text)
    previous = sign
  }
  return out.map((h) => ({ old: h.old.join(''), new: h.new.join('') }))
}

/** 一处文件改动 → 视图的 diffs。add 的 diff 字段是新文件全文、delete 是旧文件全文，只有 update 是 unified diff */
export function changeDiffs(change: FileUpdateChange): ToolDiff[] {
  const kind = change.kind.type
  if (kind === 'add') return [{ path: change.path, old: '', new: change.diff }]
  if (kind === 'delete') return [{ path: change.path, old: change.diff, new: '' }]
  const target = (change.kind.type === 'update' ? change.kind.move_path : null) ?? change.path
  // 改名时 codex 在 diff 末尾附一句「Moved to: …」，不是内容
  const hunks = hunksOf(change.diff.replace(/\n\nMoved to: .*$/, ''))
  if (hunks.length === 0) return [{ path: target, old: '', new: '' }]
  return hunks.map((h) => ({ path: target, ...h }))
}

function fileDiffs(changes: FileUpdateChange[]): { diffs: ToolDiff[]; truncated: boolean } {
  return clipDiffs(changes.flatMap(changeDiffs))
}

function fileKind(changes: FileUpdateChange[]): StepKind {
  if (changes.length > 0 && changes.every((c) => c.kind.type === 'delete')) return 'delete'
  if (changes.length > 0 && changes.every((c) => c.kind.type === 'update' && c.kind.move_path)) return 'move'
  return 'edit'
}

function fileTitle(changes: FileUpdateChange[]): string {
  const first = changes[0]?.path ?? ''
  if (!first) return '修改文件'
  return changes.length > 1 ? `${clipTitle(first)} 等 ${changes.length} 个文件` : clipTitle(first)
}

// ---------- 起始 / 收尾 ----------

/** MCP / 动态工具的结果内容：只取文字块 */
function contentText(items: unknown): string {
  if (!Array.isArray(items)) return ''
  return items.map(rec).map((b) => str(b.text)).filter(Boolean).join('\n')
}

function mcpLabel(server: string, tool: string): string {
  return tool ? `${server}: ${tool}` : server
}

/** 条目开始（item/started）：种类、一行标题（不带动作词，前端按 kind 配）、主路径与视图 */
export function itemFace(item: ThreadItem): ItemFace {
  let truncated = false
  const raw = (value: unknown): unknown => {
    const c = clipValue(value)
    if (c.truncated) truncated = true
    return c.value
  }
  const done = (face: Omit<ItemFace, 'truncated'>): ItemFace => ({ ...face, ...(truncated ? { truncated: true } : {}) })

  switch (item.type) {
    case 'commandExecution': {
      const actions = Array.isArray(item.commandActions) ? item.commandActions : []
      const kind = commandKind(actions)
      const command = stripShell(str(item.command))
      const view: ToolView = { tool: 'commandExecution', command, raw: { input: raw({ command: item.command, cwd: item.cwd, commandActions: actions }) } }
      if (item.cwd) view.cwd = item.cwd
      const read = actions.find((a): a is Extract<CommandAction, { type: 'read' }> => a.type === 'read')
      const search = actions.find((a): a is Extract<CommandAction, { type: 'search' }> => a.type === 'search')
      const list = actions.find((a): a is Extract<CommandAction, { type: 'listFiles' }> => a.type === 'listFiles')
      let title = oneLine(command)
      if (kind === 'read' && read?.path) {
        view.path = read.path
        title = clipTitle(read.path)
      } else if (kind === 'search' && search?.query) {
        view.query = search.query
        if (search.path) view.cwd = search.path
        title = oneLine(search.query)
      } else if (kind === 'search' && list?.path) {
        view.path = list.path
        title = clipTitle(list.path)
      }
      return done({ kind, title: title || 'command', ...(view.path ? { detail: clipTitle(view.path) } : {}), view })
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      const { diffs, truncated: clipped } = fileDiffs(changes)
      if (clipped) truncated = true
      const path = changes[0]?.path
      const view: ToolView = { tool: 'fileChange', diffs, raw: { input: raw(changes) } }
      if (path) view.path = path
      return done({ kind: fileKind(changes), title: fileTitle(changes), ...(path ? { detail: clipTitle(path) } : {}), view })
    }
    case 'mcpToolCall':
      return done({
        kind: 'other',
        title: mcpLabel(item.server, item.tool),
        view: { tool: `${item.server}.${item.tool}`, raw: { input: raw(item.arguments) } },
      })
    case 'dynamicToolCall':
      return done({ kind: 'other', title: item.tool || 'tool', view: { tool: item.tool, raw: { input: raw(item.arguments) } } })
    case 'webSearch': {
      const action = rec(item.action)
      const queries = Array.isArray(action.queries) ? action.queries.filter((q): q is string => typeof q === 'string') : []
      const query = str(item.query) || str(action.query) || queries.join(', ') || str(action.url)
      return done({
        kind: 'fetch',
        title: oneLine(query) || 'web search',
        view: { tool: 'webSearch', ...(query ? { query } : {}), raw: { input: raw(item.action) } },
      })
    }
    case 'imageView':
      return done({ kind: 'read', title: clipTitle(item.path), detail: clipTitle(item.path), view: { tool: 'imageView', path: item.path } })
    default: {
      // 新版本多出来的条目：标题用类型名，载荷原样放进「高级」
      const type = str((item as { type?: unknown }).type) || 'item'
      return done({ kind: 'other', title: type, view: { tool: type, raw: { input: raw(item) } } })
    }
  }
}

function statusOf(raw: unknown): StepStatus {
  if (raw === 'failed' || raw === 'declined' || raw === 'interrupted') return 'failed'
  if (raw === 'inProgress') return 'in_progress'
  return 'completed'
}

/** 条目收尾（item/completed）：状态、结果文字、退出码、最终的 diff */
export function itemDone(item: ThreadItem): ItemDone {
  const status = statusOf((item as { status?: unknown }).status)
  const view: ToolView = {}
  let truncated = false
  let note = ''
  const result = (text: string) => {
    if (!text) return
    const c = clipText(text)
    view.result = c.text
    if (c.truncated) truncated = true
  }
  switch (item.type) {
    case 'commandExecution': {
      // 命令输出几乎总以换行结尾，结果里不留这个尾巴
      const output = stripAnsi(item.aggregatedOutput ?? '').trimEnd()
      result(output)
      if (typeof item.exitCode === 'number') view.exit = { code: item.exitCode, signal: null }
      view.raw = {
        input: clipValue({ command: item.command, cwd: item.cwd, commandActions: item.commandActions }).value,
        output: { status: item.status, exitCode: item.exitCode, durationMs: item.durationMs, processId: item.processId },
      }
      if (item.status === 'declined') note = '已拒绝'
      else if (status === 'failed') note = oneLine(output, NOTE_MAX) || (typeof item.exitCode === 'number' ? `退出码 ${item.exitCode}` : '')
      break
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      const clipped = fileDiffs(changes)
      view.diffs = clipped.diffs
      if (clipped.truncated) truncated = true
      if (item.status === 'declined') note = '已拒绝'
      break
    }
    case 'mcpToolCall': {
      result(stripAnsi(contentText(item.result?.content)))
      const out = clipValue(item.result ?? item.error)
      if (out.truncated) truncated = true
      view.raw = { input: clipValue(item.arguments).value, output: out.value }
      if (item.error?.message) note = oneLine(item.error.message, NOTE_MAX)
      break
    }
    case 'dynamicToolCall': {
      result(stripAnsi(contentText(item.contentItems)))
      if (item.success === false) return { status: 'failed', view, note: oneLine(view.result ?? '', NOTE_MAX) || '失败', ...(truncated ? { truncated: true } : {}) }
      break
    }
    default:
  }
  return { status, view, ...(note ? { note } : {}), ...(truncated ? { truncated: true } : {}) }
}
