// 假 claude 的一轮：把剧本（scenario.mjs）的动作翻成 Claude Code stream-json 的输出消息。
// 形状以 @anthropic-ai/claude-agent-sdk 的 sdk.d.ts 为准：
//   - 每个写完的内容块一条 `assistant`（同一次 API 消息的块共用 message.id）；开了 --include-partial-messages 时
//     主线程另有 `stream_event`（message_start / content_block_* / message_delta / message_stop）逐字流；
//     子代理里的消息只有整块的 `assistant`，带 parent_tool_use_id
//   - 工具调用 = assistant 里的 tool_use 块（一次 API 消息到 tool_use 为止），结果 = `user` 里的 tool_result
//   - 子代理 = Agent 工具 + system/task_started / task_progress / task_notification
//   - 审批 / AskUserQuestion = 向宿主发 control_request {subtype:'can_use_tool'}，提问表单 = {subtype:'elicitation'}
//   - 一轮以 `result` 收尾，前后有 session_state_changed（running → idle，等人时 requires_action）

import { randomUUID } from 'node:crypto'

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/** 剧本里按 kind（read / edit / execute …）描述的工具 → Claude 内置工具名与输入（剧本给了 name 就用它的） */
export function claudeTool(t) {
  if (t.name) return { name: t.name, input: t.input ?? {} }
  const path = t.locations?.[0]?.path
  const diff = t.content?.find((c) => c.diff)?.diff
  switch (t.kind) {
    case 'read': return { name: 'Read', input: { file_path: path ?? t.title ?? '' } }
    case 'edit': return diff
      ? { name: 'Edit', input: { file_path: diff.path, old_string: diff.old, new_string: diff.new } }
      : { name: 'Write', input: { file_path: path ?? '', content: '' } }
    case 'execute': return { name: 'Bash', input: { command: t.input?.command ?? t.title ?? '', ...(t.input?.description ? { description: t.input.description } : {}) } }
    case 'search': return { name: 'Grep', input: { pattern: t.title ?? '' } }
    case 'switch_mode': return { name: 'ExitPlanMode', input: { plan: t.title ?? '' } }
    default: return { name: 'mcp__fake__' + (t.kind ?? 'other'), input: t.input ?? {} }
  }
}

/** 工具结果的文字：content 里的文字 > diff 的说明 > output > 缺省 */
function resultText(t, failed) {
  const texts = (t.content ?? []).filter((c) => c.text !== undefined).map((c) => c.text)
  if (texts.length > 0) return texts.join('\n')
  const diff = t.content?.find((c) => c.diff)?.diff
  if (diff) return `The file ${diff.path} has been updated.`
  if (typeof t.output === 'string') return t.output
  if (t.output !== undefined) return JSON.stringify(t.output)
  return failed ? 'failed' : 'ok'
}

/**
 * 一轮的编码器。host 由进程层提供：
 *   out(msg)、base() → {uuid, session_id}、partial、model()、mode()、
 *   control(request) → { id, done: Promise<{ok}|{error}|null> }（null = 被取消）、cancelControl(id)、tasks（在跑的子代理 id 集合）
 */
export function claudeTurn(host, s) {
  const { out, base } = host
  const contexts = new Map() // parentId（'' = 主线程）→ { msgId, index, block, open }
  const tools = new Map() // tool_use id → { name, input, parentId, merged }
  const settled = new Set()
  let finalText = ''
  let afterTool = false
  let over = false
  let msgCount = 0
  let toolCount = 0

  const ctxOf = (pid) => {
    const key = pid ?? ''
    if (!contexts.has(key)) contexts.set(key, { msgId: '', index: 0, block: null, open: false })
    return contexts.get(key)
  }
  // 子代理的逐字流不转发给宿主（真 CLI 缺省也不转），只有主线程发 stream_event
  const stream = (pid, event) => {
    if (host.partial && !pid) out({ type: 'stream_event', event, parent_tool_use_id: null, ...base() })
  }
  const state = (st) => {
    if (!over) out({ type: 'system', subtype: 'session_state_changed', state: st, ...base() })
  }
  const assistant = (pid, ctx, block) =>
    out({
      type: 'assistant',
      message: { id: ctx.msgId, type: 'message', role: 'assistant', model: host.model(), content: [block], stop_reason: null, stop_sequence: null, usage: ZERO_USAGE },
      parent_tool_use_id: pid ?? null,
      ...base(),
    })

  function openMessage(pid) {
    const ctx = ctxOf(pid)
    if (ctx.open) return ctx
    ctx.msgId = `msg_fake_${randomUUID().slice(0, 8)}_${++msgCount}`
    ctx.index = 0
    ctx.open = true
    stream(pid, { type: 'message_start', message: { id: ctx.msgId, type: 'message', role: 'assistant', model: host.model(), content: [], stop_reason: null, stop_sequence: null, usage: ZERO_USAGE } })
    return ctx
  }
  function closeBlock(pid) {
    const ctx = ctxOf(pid)
    if (!ctx.block) return
    stream(pid, { type: 'content_block_stop', index: ctx.index })
    const b = ctx.block
    assistant(pid, ctx, b.type === 'text' ? { type: 'text', text: b.text } : { type: 'thinking', thinking: b.text, signature: 'fake-signature' })
    ctx.index += 1
    ctx.block = null
  }
  function endMessage(pid, stopReason) {
    closeBlock(pid)
    const ctx = ctxOf(pid)
    if (!ctx.open) return
    stream(pid, { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 0 } })
    stream(pid, { type: 'message_stop' })
    ctx.open = false
  }
  function append(kind, text, pid) {
    if (over) return
    const ctx = openMessage(pid)
    if (ctx.block?.type !== kind) {
      closeBlock(pid)
      ctx.block = { type: kind, text: '' }
      stream(pid, { type: 'content_block_start', index: ctx.index, content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '', signature: '' } })
    }
    ctx.block.text += text
    stream(pid, { type: 'content_block_delta', index: ctx.index, delta: kind === 'text' ? { type: 'text_delta', text } : { type: 'thinking_delta', thinking: text } })
    if (kind === 'text' && !pid) {
      // result.result 是最后一段话：工具调用之后重新开始
      if (afterTool) finalText = ''
      afterTool = false
      finalText += text
    }
  }

  function toolStart(t) {
    if (over) return
    const pid = t.parentId
    const { name, input } = claudeTool(t)
    closeBlock(pid)
    const ctx = openMessage(pid)
    stream(pid, { type: 'content_block_start', index: ctx.index, content_block: { type: 'tool_use', id: t.id, name, input: {} } })
    stream(pid, { type: 'content_block_delta', index: ctx.index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
    stream(pid, { type: 'content_block_stop', index: ctx.index })
    assistant(pid, ctx, { type: 'tool_use', id: t.id, name, input })
    ctx.index += 1
    endMessage(pid, 'tool_use')
    tools.set(t.id, { name, input, parentId: pid, merged: { ...t } })
    toolCount += 1
    if (!pid) afterTool = true
    if (t.status === 'completed' || t.status === 'failed') toolResult(t.id, t.status === 'failed')
  }
  function toolResult(id, failed, override) {
    const tool = tools.get(id)
    if (!tool || settled.has(id) || over) return
    settled.add(id)
    const text = override ?? resultText(tool.merged, failed)
    out({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(failed ? { is_error: true } : {}) }] },
      parent_tool_use_id: tool.parentId ?? null,
      tool_use_result: tool.merged.output ?? text,
      ...base(),
    })
  }
  function toolUpdate(t) {
    const tool = tools.get(t.id)
    if (!tool) return
    tool.merged = { ...tool.merged, ...t }
    if (t.status === 'completed' || t.status === 'failed') toolResult(t.id, t.status === 'failed')
  }

  /** 向宿主要一次 can_use_tool；返回 null = 取消，否则 {behavior, ...} */
  async function canUseTool(id, extra) {
    const tool = tools.get(id)
    state('requires_action')
    const r = await host.control({ subtype: 'can_use_tool', tool_name: tool.name, input: tool.input, tool_use_id: id, ...extra }).done
    state('running')
    if (r === null) return null
    if (r.error !== undefined) return { behavior: 'deny', message: r.error }
    if (r.ok?.behavior === 'deny' && r.ok.interrupt) s.cancelled = true
    return r.ok ?? { behavior: 'deny', message: 'empty response' }
  }

  async function approve({ tool, options }) {
    if (!tools.has(tool.id)) toolStart({ ...tool, status: 'in_progress' })
    const { name } = tools.get(tool.id)
    const allowOnce = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind.startsWith('allow'))
    const reject = options.find((o) => o.kind.startsWith('reject'))
    const mode = host.mode()
    if (mode === 'bypassPermissions' && allowOnce) {
      toolResult(tool.id, false)
      return allowOnce.id
    }
    if (mode === 'dontAsk' && reject) {
      toolResult(tool.id, true, 'Permission denied (dontAsk)')
      return reject.id
    }
    // 「总是允许」类选项 → permission_suggestions；带 mode 的是切模式（ExitPlanMode 的「批准并切到某档」）
    const suggestions = options
      .filter((o) => o.mode || o.kind === 'allow_always')
      .map((o) => (o.mode
        ? { type: 'setMode', mode: o.mode, destination: 'session' }
        : { type: 'addRules', rules: [{ toolName: name }], behavior: 'allow', destination: 'session' }))
    const input = tools.get(tool.id).input
    const res = await canUseTool(tool.id, {
      ...(suggestions.length > 0 ? { permission_suggestions: suggestions } : {}),
      // 剧本可以要 CLI 的两个提示：不许给「总是允许」、不许一键批准
      ...(tool.suppressAlways ? { suppress_always_allow_rule: true } : {}),
      ...(tool.defaultToNo ? { default_to_no: true } : {}),
      title: tool.title, display_name: name, description: input.description ?? tool.title,
    })
    if (res === null) return null
    if (res.behavior !== 'allow') {
      toolResult(tool.id, true, res.message ?? 'denied')
      return reject?.id ?? null
    }
    toolResult(tool.id, false)
    const perms = res.updatedPermissions ?? []
    const setMode = perms.find((p) => p.type === 'setMode')
    if (setMode) return (options.find((o) => o.mode === setMode.mode) ?? allowOnce).id
    if (perms.length > 0) return (options.find((o) => o.kind === 'allow_always' && !o.mode) ?? allowOnce).id
    return allowOnce.id
  }

  async function ask(questions) {
    const id = `toolu_ask_${randomUUID().slice(0, 8)}`
    toolStart({ id, name: 'AskUserQuestion', status: 'in_progress', input: { questions } })
    const res = await canUseTool(id, {
      title: 'Claude has questions for you', display_name: 'AskUserQuestion',
      description: questions[0]?.question, requires_user_interaction: true,
    })
    if (res === null) return null
    if (res.behavior !== 'allow') {
      toolResult(id, true, res.message ?? 'User declined to answer questions')
      return { declined: true }
    }
    const answers = res.updatedInput?.answers ?? {}
    toolResult(id, false, 'User has answered your questions: ' + Object.entries(answers).map(([q, a]) => `"${q}"="${a}"`).join(', '))
    return answers
  }

  function elicit(form) {
    const req = host.control({ subtype: 'elicitation', mcp_server_name: 'ramet', message: form.message, mode: 'form', requested_schema: form.requestedSchema })
    let fallback
    const answer = new Promise((resolve) => {
      req.done.then((r) => resolve(r === null || r.error !== undefined ? null : (r.ok ?? null)))
      fallback = resolve
    })
    return {
      answer,
      // 撤回后宿主照常会回一个应答（多半是 cancel）；它不回也不能把这一轮挂死
      withdraw: () => {
        host.cancelControl(req.id, false)
        setTimeout(() => fallback({ action: 'cancel' }), 3000).unref()
      },
    }
  }

  function task(op) {
    const usage = { total_tokens: 100 * (op.toolUses ?? 0), tool_uses: op.toolUses ?? 0, duration_ms: 0 }
    if (op.op === 'start') {
      host.tasks.add(op.id)
      out({
        type: 'system', subtype: 'task_started', task_id: op.id, tool_use_id: op.toolId, description: op.description,
        subagent_type: op.subagentType, is_backgrounded: false, spawn_depth: 1, task_type: 'local_agent', prompt: op.prompt, ...base(),
      })
    } else if (op.op === 'progress') {
      out({
        type: 'system', subtype: 'task_progress', task_id: op.id, tool_use_id: op.toolId, description: op.description,
        subagent_type: op.subagentType, usage, last_tool_name: op.lastTool, ...base(),
      })
    } else {
      host.tasks.delete(op.id)
      out({ type: 'system', subtype: 'task_notification', task_id: op.id, tool_use_id: op.toolId, status: op.status, output_file: '', summary: op.summary, usage, ...base() })
    }
  }

  const io = {
    caps: { elicitForm: true, subagents: true, questions: true },
    say: (text, pid) => append('text', text, pid),
    think: (text, pid) => append('thinking', text, pid),
    toolStart,
    toolUpdate,
    plan: (entries) => {
      const id = `toolu_todo_${randomUUID().slice(0, 8)}`
      toolStart({ id, name: 'TodoWrite', input: { todos: entries.map((e) => ({ content: e.content, status: e.status, activeForm: e.content })) } })
      toolResult(id, false, 'Todos have been modified successfully.')
    },
    context: () => undefined,
    mode: (m) => out({ type: 'system', subtype: 'status', status: null, permissionMode: m, ...base() }),
    approve,
    ask,
    elicit,
    task,
  }

  /** 收尾：关掉还开着的消息，发 result 与 idle */
  function finish(r, { started, promptChars, costUSD }) {
    const stopReason = r.error !== undefined ? null : r.stop === 'cancelled' ? null : 'end_turn'
    for (const key of contexts.keys()) endMessage(key || undefined, stopReason ?? 'end_turn')
    if (r.stop === 'cancelled') {
      out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null, ...base() })
    }
    const u = r.usage ?? {}
    const usage = {
      input_tokens: u.input ?? promptChars,
      output_tokens: u.output ?? finalText.length,
      cache_read_input_tokens: u.cacheRead ?? 0,
      cache_creation_input_tokens: u.cacheWrite ?? 0,
    }
    const modelUsage = {
      [host.model()]: {
        inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
        ...(u.thought !== undefined ? { thinkingTokens: u.thought } : {}),
        cacheReadInputTokens: usage.cache_read_input_tokens, cacheCreationInputTokens: usage.cache_creation_input_tokens,
        webSearchRequests: 0, costUSD, contextWindow: 200000, maxOutputTokens: 32000,
      },
    }
    const common = {
      type: 'result', duration_ms: Date.now() - started, duration_api_ms: 0, num_turns: toolCount + 1,
      total_cost_usd: costUSD, usage, modelUsage, permission_denials: [],
    }
    if (r.error !== undefined) out({ ...common, subtype: 'error_during_execution', is_error: true, stop_reason: null, errors: [r.error], ...base() })
    else if (r.stop === 'cancelled') out({ ...common, subtype: 'error_during_execution', is_error: false, stop_reason: null, errors: [], ...base() })
    else out({ ...common, subtype: 'success', is_error: false, result: finalText, stop_reason: stopReason, ...base() })
    state('idle')
    over = true
  }

  return { io, state, finish }
}
