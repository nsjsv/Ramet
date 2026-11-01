// ---------- Claude Agent SDK 的消息 → AgentEvent ----------
// 一个会话一个翻译器（要记住这个会话里的工具调用、子代理、哪些消息已经逐字流过）。只翻译「一轮的过程」与
// 斜杠命令；一轮的收尾（result）由驱动认领（resolve prompt），这里只把它折成用量与 info。
// 形状对照 sdk.d.ts 的 SDKMessage；消息内容块按字段读、不信类型（CLI 版本漂移时缺字段不能抛）。
//
//   stream_event 的 text / thinking delta          → text / thought（子代理里的带 parentId）
//   assistant 的 text / thinking（没逐字流过的）    → text / thought（子代理的消息只有整块）
//   assistant 的 tool_use                          → tool（kind / 标题 / 视图由 tools.ts 算，status in_progress）
//   TodoWrite 的 tool_use                          → plan（不产生步骤，它的结果也不产生）
//   user 的 tool_result                            → tool 增量（completed / failed、结果、退出码、原样输出）
//   system/task_*                                  → 唤起它的那一步的 status / activity，view.handle = task_id（可停）
//   system/commands_changed                        → commands（会话级）
//   system/compact_boundary、api_retry、status、mirror_error → info
//   result                                         → usage（上下文）+ info（用量 / 花费 / stop reason）

import { normalizePlan, type RunInfo } from '@ramet/shared/run-model'
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentCommand, AgentEvent, StepStatus, TurnUsage } from '../../types.js'
import { clipValue, rec, str } from '../tool-text.js'
import { isSubagentTool, PLAN_TOOL, todoEntries, toolResultFace, toolUseFace } from './tools.js'

type ToolSeen = { name: string; input: unknown; parentId?: string }

/** Anthropic 的 stop_reason → 一轮的 stopReason（end_turn / max_tokens / refusal …，前端按这套认） */
function stopReasonOf(raw: string | null | undefined): string {
  if (raw === 'max_tokens' || raw === 'refusal') return raw
  return 'end_turn'
}

/** result.usage → TurnUsage：只取 CLI 报了的项；total 是四项之和（都是实报的数，不是估算） */
function turnUsage(msg: SDKResultMessage): TurnUsage | undefined {
  const u = rec(msg.usage)
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const input = num(u.input_tokens)
  const output = num(u.output_tokens)
  if (input === undefined || output === undefined) return undefined
  const cacheRead = num(u.cache_read_input_tokens)
  const cacheWrite = num(u.cache_creation_input_tokens)
  let thought: number | undefined
  for (const m of Object.values(rec(msg.modelUsage))) {
    const t = num(rec(m).thinkingTokens)
    if (t !== undefined) thought = (thought ?? 0) + t
  }
  return {
    total: input + output + (cacheRead ?? 0) + (cacheWrite ?? 0),
    input,
    output,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(thought !== undefined ? { thought } : {}),
  }
}

/** 子代理 / 后台任务的结局 → 步骤状态 */
function taskStatus(raw: string): StepStatus | undefined {
  if (raw === 'completed') return 'completed'
  if (raw === 'failed' || raw === 'stopped' || raw === 'killed') return 'failed'
  if (raw === 'running' || raw === 'pending') return 'in_progress'
  return undefined
}

/** 进 info 的原样元数据（info.acp 是「agent 原样元数据」那一格，原生驱动按消息子类型存最近一份） */
function metaInfo(key: string, msg: Record<string, unknown>): RunInfo {
  const { type: _t, subtype: _s, uuid: _u, session_id: _id, ...rest } = msg
  const { value, truncated } = clipValue(rest)
  return { acp: { [key]: value }, ...(truncated ? { truncated: true } : {}) }
}

export type ResultSummary = { stopReason: string; usage?: TurnUsage; error?: string }

export class ClaudeEvents {
  private readonly tools = new Map<string, ToolSeen>()
  /** TodoWrite 的调用：结果到了也不建步骤 */
  private readonly planCalls = new Set<string>()
  /** 已经按 stream_event 逐字发过的 assistant 消息（message.id）：整块到达时不再重复发正文 */
  private readonly streamed = new Set<string>()
  /** task_id → 唤起它的 tool_use_id（task_updated 不带 tool_use_id） */
  private readonly taskTools = new Map<string, string>()
  /** 还在跑的子代理 / 后台任务：停止只对它们有意义 */
  readonly liveTasks = new Set<string>()
  /** 主线程最后一次 API 调用的 token 数（上下文占用） */
  private contextUsed: number | undefined

  constructor(
    private readonly sessionId: string,
    private readonly emit: (ev: AgentEvent) => void,
    private readonly onCommands: (list: AgentCommand[]) => void,
  ) {}

  handle(msg: SDKMessage): void {
    switch (msg.type) {
      case 'stream_event':
        return this.onStream(msg.event as unknown, msg.parent_tool_use_id)
      case 'assistant':
        return this.onAssistant(rec(msg.message), msg.parent_tool_use_id)
      case 'user':
        return this.onUser(rec(msg.message).content, msg.parent_tool_use_id, msg.tool_use_result)
      case 'system':
        return this.onSystem(msg as unknown as Record<string, unknown>)
      default:
    }
  }

  private text(kind: 'text' | 'thought', delta: string, parentId: string | null): void {
    if (!delta) return
    this.emit({ type: kind, delta, sessionId: this.sessionId, ...(parentId ? { parentId } : {}) })
  }

  private onStream(raw: unknown, parentId: string | null): void {
    const ev = rec(raw)
    if (ev.type === 'message_start') {
      const id = str(rec(ev.message).id)
      if (id) this.streamed.add(id)
      return
    }
    if (ev.type !== 'content_block_delta') return
    const delta = rec(ev.delta)
    if (delta.type === 'text_delta') this.text('text', str(delta.text), parentId)
    else if (delta.type === 'thinking_delta') this.text('thought', str(delta.thinking), parentId)
  }

  private onAssistant(message: Record<string, unknown>, parentId: string | null): void {
    const streamed = this.streamed.has(str(message.id))
    if (parentId === null) this.noteContext(rec(message.usage))
    for (const block of Array.isArray(message.content) ? message.content.map(rec) : []) {
      if (block.type === 'text') {
        if (!streamed) this.text('text', str(block.text), parentId)
      } else if (block.type === 'thinking') {
        if (!streamed) this.text('thought', str(block.thinking), parentId)
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
        this.onToolUse(str(block.id), str(block.name), block.input, parentId)
      } else if (typeof block.tool_use_id === 'string' && str(block.type).endsWith('_tool_result')) {
        // 服务端工具（网页搜索等）的结果就在同一条 assistant 里
        this.onToolResult(block.tool_use_id, block.content, undefined, block.is_error === true || rec(block.content).type === 'web_search_tool_result_error')
      }
    }
  }

  /** 主线程一次 API 调用的输入 + 缓存 + 输出 = 此刻上下文里的 token 数 */
  private noteContext(usage: Record<string, unknown>): void {
    const parts = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'].map((k) => usage[k])
    if (typeof usage.input_tokens !== 'number') return
    this.contextUsed = parts.reduce<number>((sum, v) => sum + (typeof v === 'number' ? v : 0), 0)
  }

  private onToolUse(id: string, name: string, input: unknown, parentId: string | null): void {
    if (!id) return
    if (name === PLAN_TOOL) {
      this.planCalls.add(id)
      const { entries, truncated } = normalizePlan(todoEntries(input))
      this.emit({ type: 'plan', entries, ...(truncated ? { truncated: true } : {}), sessionId: this.sessionId })
      return
    }
    this.tools.set(id, { name, input, ...(parentId ? { parentId } : {}) })
    const face = toolUseFace(name, input)
    this.emit({
      type: 'tool',
      id,
      kind: face.kind,
      title: face.title,
      status: 'in_progress',
      ...(face.detail ? { detail: face.detail } : {}),
      view: face.view,
      ...(face.truncated ? { truncated: true } : {}),
      ...(parentId ? { parentId } : {}),
      sessionId: this.sessionId,
    })
  }

  private onUser(content: unknown, _parentId: string | null, structured: unknown): void {
    if (!Array.isArray(content)) return
    const results = content.map(rec).filter((b) => b.type === 'tool_result' && typeof b.tool_use_id === 'string')
    // 结构化结果（tool_use_result）只对应一个工具结果：一条消息里有多个时不知道归谁，只用文字
    const single = results.length === 1 ? structured : undefined
    for (const b of results) this.onToolResult(str(b.tool_use_id), b.content, single, b.is_error === true)
  }

  private onToolResult(id: string, content: unknown, structured: unknown, isError: boolean): void {
    if (this.planCalls.has(id)) return
    const seen = this.tools.get(id)
    const face = toolResultFace(seen?.name ?? '', seen?.input, content, structured, isError)
    this.emit({
      type: 'tool',
      id,
      status: isError ? 'failed' : 'completed',
      view: face.view,
      ...(face.note ? { note: face.note } : {}),
      ...(face.truncated ? { truncated: true } : {}),
      // 子代理正在做的那一行（activity）收尾时清掉，一行字回到标题
      ...(seen && isSubagentTool(seen.name) ? { activity: '' } : {}),
      sessionId: this.sessionId,
    })
  }

  private onSystem(msg: Record<string, unknown>): void {
    switch (msg.subtype) {
      case 'task_started':
        return this.taskStarted(msg)
      case 'task_progress':
        return this.taskProgress(msg)
      case 'task_updated':
        return this.taskUpdated(msg)
      case 'task_notification':
        return this.taskEnded(msg)
      case 'commands_changed': {
        const list = Array.isArray(msg.commands) ? commandsOf(msg.commands) : []
        return this.onCommands(list)
      }
      case 'compact_boundary':
      case 'api_retry':
      case 'mirror_error':
        return this.emit({ type: 'info', info: metaInfo(str(msg.subtype), msg), sessionId: this.sessionId })
      case 'status':
        // 只有压缩结果值得留；纯状态心跳（status: null）每轮都有，不进 info
        if (msg.compact_result !== undefined || msg.status !== null) {
          this.emit({ type: 'info', info: metaInfo('status', msg), sessionId: this.sessionId })
        }
        return
      default:
    }
  }

  private stepOfTask(msg: Record<string, unknown>): string | undefined {
    const taskId = str(msg.task_id)
    const toolId = str(msg.tool_use_id) || this.taskTools.get(taskId)
    return toolId || undefined
  }

  private taskStarted(msg: Record<string, unknown>): void {
    const taskId = str(msg.task_id)
    if (!taskId) return
    this.liveTasks.add(taskId)
    const toolId = str(msg.tool_use_id)
    if (!toolId) return
    this.taskTools.set(taskId, toolId)
    this.emit({ type: 'tool', id: toolId, status: 'in_progress', view: { handle: taskId }, sessionId: this.sessionId })
  }

  private taskProgress(msg: Record<string, unknown>): void {
    const toolId = this.stepOfTask(msg)
    const activity = str(msg.summary).trim() || str(msg.last_tool_name)
    if (!toolId || !activity) return
    this.emit({ type: 'tool', id: toolId, activity, sessionId: this.sessionId })
  }

  private taskUpdated(msg: Record<string, unknown>): void {
    const patch = rec(msg.patch)
    const status = taskStatus(str(patch.status))
    if (status && status !== 'in_progress') this.liveTasks.delete(str(msg.task_id))
    const toolId = this.stepOfTask(msg)
    if (!toolId || !status) return
    const error = str(patch.error)
    this.emit({ type: 'tool', id: toolId, status, ...(error ? { note: error.slice(0, 120) } : {}), sessionId: this.sessionId })
  }

  private taskEnded(msg: Record<string, unknown>): void {
    const taskId = str(msg.task_id)
    this.liveTasks.delete(taskId)
    const toolId = this.stepOfTask(msg)
    const status = taskStatus(str(msg.status))
    if (!toolId || !status) return
    const stopped = msg.status === 'stopped'
    const summary = str(msg.summary).trim()
    this.emit({
      type: 'tool',
      id: toolId,
      status,
      activity: '',
      ...(stopped ? { note: '已停止' } : status === 'failed' && summary ? { note: summary.slice(0, 120) } : {}),
      sessionId: this.sessionId,
    })
  }

  /** 一轮的 result：上下文占用与本轮用量 / 花费 / stop reason 发成事件，返回给驱动认领这一轮 */
  result(msg: SDKResultMessage, cancelled: boolean): ResultSummary {
    const usage = turnUsage(msg)
    const size = Math.max(0, ...Object.values(rec(msg.modelUsage)).map((m) => Number(rec(m).contextWindow) || 0))
    if (this.contextUsed !== undefined && size > 0) {
      this.emit({
        type: 'usage',
        used: this.contextUsed,
        size,
        ...(typeof msg.total_cost_usd === 'number' ? { cost: { amount: msg.total_cost_usd, currency: 'USD' } } : {}),
        sessionId: this.sessionId,
      })
    }
    let summary: ResultSummary
    if (cancelled) summary = { stopReason: 'cancelled' }
    else if (msg.subtype === 'success') {
      summary = msg.is_error ? { stopReason: 'end_turn', error: msg.result || '请求失败' } : { stopReason: stopReasonOf(msg.stop_reason) }
    } else if (msg.subtype === 'error_max_turns') summary = { stopReason: 'max_turn_requests' }
    else summary = { stopReason: 'end_turn', error: msg.errors.join('\n') || msg.subtype }
    const meta = metaInfo('result', {
      subtype: msg.subtype,
      is_error: msg.is_error,
      stop_reason: msg.stop_reason,
      num_turns: msg.num_turns,
      duration_ms: msg.duration_ms,
      total_cost_usd: msg.total_cost_usd,
      usage: msg.usage,
      modelUsage: msg.modelUsage,
    })
    this.emit({
      type: 'info',
      info: { ...meta, ...(usage ? { usage } : {}), stopReason: summary.stopReason },
      sessionId: this.sessionId,
    })
    return { ...summary, ...(usage ? { usage } : {}) }
  }
}

/** SDK 的斜杠命令 → AgentCommand（argumentHint 空串 = 不带参数） */
export function commandsOf(list: unknown[]): AgentCommand[] {
  return list.map(rec).filter((c) => str(c.name)).map((c) => ({
    name: str(c.name),
    description: str(c.description) || null,
    ...(str(c.argumentHint) ? { input: str(c.argumentHint) } : {}),
  }))
}
