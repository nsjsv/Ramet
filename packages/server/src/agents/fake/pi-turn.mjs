// 假 pi / omp 的一轮：把剧本（scenario.mjs）的动作翻成 pi 系 RPC 的会话事件与扩展 UI 请求。
// 形状以 drivers/pi/protocol.ts 为准，并照实测（pi 1.4.0 / omp 18.14.1）的先后：
//   - 正文 / 思考 = assistant 消息：message_start → message_update（text_* / thinking_*）→ message_end；
//     工具调用是 assistant 消息里的 toolCall 块（toolcall_start / toolcall_end），消息收尾后才 tool_execution_start；
//     tool_execution_update 的 partialResult 是累计值；结束后 toolResult 消息 + turn_end，下一段话开新的 turn。
//   - pi 没有审批与子代理：剧本要审批时发扩展的 confirm（权限扩展的做法）；omp 的审批是 select「Allow tool: <名>」，
//     approvalMode 为 yolo 时不问。
//   - omp 提问：开了 ask 对话框就发一条 method:'ask'（先于 ask 工具的 tool_execution_start），否则逐题 select。
//   - omp 子代理是后台作业：task 工具当场结束、主回合先让出（prompt_result sessionSettled:false），子代理帧随后到，
//     子代理结束后 omp 注入 async-result 消息再起一段，最后才 session_settled。
//   - omp 的计划 = todo 工具结束时 details.phases。

let seq = 0
const nextId = (prefix) => `${prefix}_${++seq}`

const PI_TOOL = { read: 'read', execute: 'bash', edit: 'edit', search: 'grep', delete: 'bash', move: 'bash' }

/** 剧本里按 kind（read / edit / execute …）描述的工具 → pi 系的工具名与参数 */
function shapeOf(t) {
  const path = t.locations?.[0]?.path ?? t.input?.file_path ?? t.input?.path
  const diff = (t.content ?? []).find((c) => c.diff)?.diff
  const name = PI_TOOL[t.kind] ?? (t.name ? t.name.toLowerCase() : 'tool')
  if (name === 'read') return { name, args: { path: path ?? t.title ?? '' } }
  if (name === 'bash') return { name, args: { command: t.input?.command ?? t.title ?? '' } }
  if (name === 'edit') return { name, args: { path: diff?.path ?? path ?? t.title ?? '', edits: diff ? [{ oldText: diff.old ?? '', newText: diff.new }] : [] } }
  if (name === 'grep') return { name, args: { pattern: t.input?.pattern ?? t.title ?? '' } }
  return { name, args: t.input ?? {} }
}

const textOf = (t, failed) => (t.content ?? []).filter((c) => c.text !== undefined).map((c) => c.text).join('\n') || (failed ? 'failed' : 'ok')
const usageOf = (u) => ({
  input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, reasoning: u.thought,
  totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})

/**
 * 一轮的编码器。host 由进程层提供：
 *   out(frame)、dialect（'pi' | 'omp'）、promptId（omp 的 prompt_result 要带）、turnOpen（已发过 turn_start）、
 *   ui(request) → Promise<答案帧 | null>（null = 被撤回）、approvalMode、askDialog、subLevel、
 *   subagents（id → { taskId, toolId, status }，get_subagents / cancel_subagent 用）
 * s = 剧本会话状态
 */
export function piTurn(host, s) {
  const omp = host.dialect === 'omp'
  let msg = null // 开着的 assistant 消息 { content }
  // 进程层已经发过这一轮的 turn_start（用户消息在它之后）
  let turnOpen = host.turnOpen === true
  let over = false
  let background = false // omp：主回合已经让出，子代理还在跑
  let mainText = 0
  const messages = []
  const tools = new Map() // 工具 id → { name, args, output, done, parent }
  const subs = new Map() // Agent 工具 id → 子代理 { id, taskId }
  const msgId = () => (omp ? { messageId: nextId('msg') } : {})
  const out = (frame) => {
    if (!over) host.out(frame)
  }

  function openMessage() {
    if (msg) return
    if (!turnOpen) {
      out({ type: 'turn_start' })
      turnOpen = true
    }
    msg = { role: 'assistant', content: [], provider: 'fake', model: s.model, ids: msgId() }
    out({ type: 'message_start', message: { ...strip(msg), stopReason: 'pending' }, ...msg.ids })
  }
  const strip = (m) => ({ role: m.role, content: m.content.map((b) => ({ ...b })), provider: m.provider, model: m.model })

  function closeBlock() {
    const i = msg.content.length - 1
    const b = msg.content[i]
    if (!b || b.closed) return
    b.closed = true
    if (b.type === 'text') out({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: i, content: b.text }, ...msg.ids })
    if (b.type === 'thinking') out({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: i, content: b.thinking }, ...msg.ids })
  }

  function closeMessage(stopReason, extra = {}) {
    if (!msg) return null
    closeBlock()
    const final = { ...strip(msg), content: msg.content.map(({ closed: _closed, ...b }) => b), stopReason, timestamp: Date.now(), ...extra }
    out({ type: 'message_end', message: final, ...msg.ids })
    messages.push(final)
    msg = null
    return final
  }

  function append(kind, text) {
    openMessage()
    const last = msg.content.at(-1)
    const type = kind === 'text' ? 'text' : 'thinking'
    if (!last || last.type !== type || last.closed) {
      closeBlock()
      msg.content.push(type === 'text' ? { type, text: '' } : { type, thinking: '' })
      out({ type: 'message_update', assistantMessageEvent: { type: `${type}_start`, contentIndex: msg.content.length - 1 }, ...msg.ids })
    }
    const i = msg.content.length - 1
    if (type === 'text') msg.content[i].text += text
    else msg.content[i].thinking += text
    if (type === 'text') mainText += text.length
    out({ type: 'message_update', assistantMessageEvent: { type: `${type}_delta`, contentIndex: i, delta: text }, ...msg.ids })
  }

  /** 子代理里的事件（omp，订阅到 events 级才发） */
  function subEvent(parentId, event) {
    const sub = subs.get(parentId)
    if (!sub || host.subLevel !== 'events') return
    out({ type: 'subagent_event', payload: { id: sub.id, event } })
  }

  /** 把一个工具调用放进 assistant 消息并收尾这条消息，然后开始执行 */
  function callTool(id, name, args) {
    openMessage()
    closeBlock()
    const toolCall = { type: 'toolCall', id, name, arguments: args }
    msg.content.push({ ...toolCall, closed: true })
    const i = msg.content.length - 1
    out({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: i, id, toolName: name }, ...msg.ids })
    out({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: i, toolCall }, ...msg.ids })
    closeMessage('toolUse')
  }

  function execStart(id, name, args) {
    out({ type: 'tool_execution_start', toolCallId: id, toolName: name, args })
    tools.set(id, { name, args, output: '', done: false })
  }

  function execEnd(id, { text, failed, details }) {
    const tool = tools.get(id)
    if (!tool || tool.done) return
    tool.done = true
    const content = [{ type: 'text', text: tool.output || text }]
    const result = { content, details: details ?? {} }
    if (tool.name === 'bash' && !omp) result.structuredContent = { output: tool.output || text, truncated: false, exit_code: failed ? 1 : 0 }
    if (tool.name === 'bash' && omp && failed) result.details = { ...result.details, exitCode: 1 }
    if (tool.parent) {
      subEvent(tool.parent, { type: 'tool_execution_end', toolCallId: id, toolName: tool.name, result, isError: failed })
      return
    }
    out({ type: 'tool_execution_end', toolCallId: id, toolName: tool.name, result, isError: failed })
    const toolResult = { role: 'toolResult', toolCallId: id, toolName: tool.name, content, details: result.details, isError: failed }
    out({ type: 'message_start', message: toolResult, ...msgId() })
    out({ type: 'message_end', message: toolResult, ...msgId() })
    messages.push(toolResult)
    out({ type: 'turn_end', message: messages.findLast((m) => m.role === 'assistant') ?? null, toolResults: [toolResult] })
    turnOpen = false
  }

  function toolStart(t) {
    if (over) return
    if (t.parentId) {
      if (!omp || !subs.has(t.parentId)) return
      const { name, args } = shapeOf(t)
      tools.set(t.id, { name, args, output: '', done: false, parent: t.parentId })
      subEvent(t.parentId, { type: 'tool_execution_start', toolCallId: t.id, toolName: name, args })
      return
    }
    if (t.name === 'Agent' && omp) return spawn(t)
    const { name, args } = shapeOf(t)
    callTool(t.id, name, args)
    execStart(t.id, name, args)
    if (t.status === 'completed' || t.status === 'failed') execEnd(t.id, { text: textOf(t, t.status === 'failed'), failed: t.status === 'failed' })
  }

  function toolUpdate(t) {
    const tool = tools.get(t.id)
    if (!tool || tool.done) return
    const texts = (t.content ?? []).filter((c) => c.text !== undefined).map((c) => c.text)
    const final = t.status === 'completed' || t.status === 'failed'
    // 命令的输出边跑边到：真 CLI 的 bash 每来一段就发一次到此刻为止的全部输出（累计值），剧本一次给全的也按行拆开发
    const pieces = texts.length === 0 ? [] : !final ? [texts.join('\n') + '\n'] : tool.name === 'bash' && !tool.output ? texts.join('\n').split(/(?<=\n)/) : []
    for (const piece of pieces) {
      tool.output += piece
      const ev = { type: 'tool_execution_update', toolCallId: t.id, toolName: tool.name, args: tool.args, partialResult: { content: [{ type: 'text', text: tool.output }], details: {} } }
      if (tool.parent) subEvent(tool.parent, ev)
      else out(ev)
    }
    if (t.status === 'completed' || t.status === 'failed') execEnd(t.id, { text: textOf(t, t.status === 'failed'), failed: t.status === 'failed' })
  }

  // ---------- omp 子代理（后台作业） ----------

  function spawn(t) {
    const id = `Sub${++seq}`
    subs.set(t.id, { id, taskId: null })
    const args = { context: t.title ?? '', tasks: [{ name: id, task: t.input?.prompt ?? t.title ?? '', solutionSpace: 'anything' }] }
    callTool(t.id, 'task', args)
    execStart(t.id, 'task', args)
    execEnd(t.id, { text: `Spawned agent \`${id}\` (job \`${id}\`).`, failed: false, details: { results: [], async: { state: 'running', jobId: id, type: 'task' } } })
    // 主回合先让出：agent 回一句再结束这一段
    append('text', '已派出子代理。')
    closeMessage('stop')
    if (turnOpen) {
      out({ type: 'turn_end', message: messages.at(-1), toolResults: [] })
      turnOpen = false
    }
    out({ type: 'agent_end', messages: messages.splice(0), isTerminal: false, yielded: true, awaitingAsyncWork: true })
    out({ type: 'prompt_result', id: host.promptId, agentInvoked: true, status: 'completed', sessionSettled: false })
    background = true
  }

  function task(op) {
    const sub = subs.get(op.toolId)
    if (!sub) return
    const lifecycle = (status) => {
      if (host.subLevel === 'off') return
      out({ type: 'subagent_lifecycle', payload: { id: sub.id, agent: 'task', agentSource: 'bundled', status, parentToolCallId: op.toolId, index: 0, detached: true } })
    }
    if (op.op === 'start') {
      sub.taskId = op.id
      host.subagents.set(sub.id, { taskId: op.id, toolId: op.toolId, status: 'running', task: op.prompt ?? '' })
      return lifecycle('started')
    }
    if (op.op === 'progress') {
      if (host.subLevel === 'off') return
      out({ type: 'subagent_progress', payload: { index: 0, agent: 'task', agentSource: 'bundled', task: op.description ?? '', parentToolCallId: op.toolId, progress: { id: sub.id, status: 'running', toolCount: op.toolUses ?? 0, recentTools: op.lastTool ? [{ tool: op.lastTool }] : [] } } })
      return
    }
    const stopped = op.status !== 'completed'
    const entry = host.subagents.get(sub.id)
    if (entry) entry.status = stopped ? 'aborted' : 'completed'
    lifecycle(stopped ? 'aborted' : 'completed')
    // omp 把后台作业的结果作为一条 custom 消息注入，再起一段让 agent 接着说
    out({ type: 'agent_start' })
    const notice = {
      role: 'custom', customType: 'async-result', display: false,
      content: `<system-notice>\nBackground job ${sub.id} has completed.\n<task-result id="${sub.id}" status="${stopped ? 'cancelled' : 'completed'}">\n<output>\n${op.summary ?? ''}\n</output>\n</task-result>\n</system-notice>`,
    }
    out({ type: 'message_start', message: notice, ...msgId() })
    out({ type: 'message_end', message: notice, ...msgId() })
  }

  // ---------- 审批 / 提问 ----------

  async function approve({ tool, options }) {
    if (!tools.has(tool.id)) toolStart({ ...tool, status: 'in_progress' })
    const name = tools.get(tool.id)?.name ?? 'tool'
    const allowOnce = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind.startsWith('allow'))
    const allowAlways = options.find((o) => o.kind === 'allow_always')
    const reject = options.find((o) => o.kind.startsWith('reject'))
    const settle = (granted) => {
      if (!granted) execEnd(tool.id, { text: 'blocked by user', failed: true })
      return granted
    }
    if (omp && host.approvalMode === 'yolo') return settle(true) ? allowOnce?.id ?? null : null
    let answer
    if (omp) {
      const detail = tool.input?.command ? `\nCommand: ${tool.input.command}` : ''
      const session = `Approve ${name} for this session`
      answer = await host.ui({ method: 'select', title: `Allow tool: ${name}${detail}`, options: ['Approve', session, 'Deny'] })
      if (answer === null) return null
      const v = answer.value
      if (v === 'Approve') return settle(true) && allowOnce?.id
      if (v === session) return settle(true) && (allowAlways ?? allowOnce)?.id
      settle(false)
      return reject?.id ?? null
    }
    answer = await host.ui({ method: 'confirm', title: tool.title ?? `Allow ${name}?`, message: tool.input?.command ?? tool.title ?? '' })
    if (answer === null) return null
    if (answer.confirmed === true) return settle(true) && allowOnce?.id
    settle(false)
    return reject?.id ?? null
  }

  async function ask(list) {
    if (!omp) return { declined: true }
    const questions = list.map((q, i) => ({
      id: `q${i}`, question: q.question, header: q.header,
      options: (q.options ?? []).map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
      ...(q.multiSelect ? { multi: true } : {}),
    }))
    const callId = nextId('call_ask')
    callTool(callId, 'ask', { i: 'ask', questions })
    let answers
    if (host.askDialog) {
      const r = await host.ui({ method: 'ask', questions })
      if (r === null) return null
      answers = r.cancelled ? null : r.answers ?? []
    } else {
      // 没开 ask 对话框：omp 逐题 select
      answers = []
      for (const q of questions) {
        const r = await host.ui({ method: 'select', title: q.question, options: q.options.map((o) => o.label) })
        if (r === null) return null
        if (r.cancelled) {
          answers = null
          break
        }
        answers.push({ id: q.id, selectedOptions: [r.value] })
      }
    }
    execStart(callId, 'ask', { questions })
    if (answers === null) {
      execEnd(callId, { text: 'User cancelled', failed: false })
      return { declined: true }
    }
    const byId = new Map(answers.map((a) => [a.id, a]))
    const result = {}
    for (const q of questions) {
      const a = byId.get(q.id)
      const parts = [...(a?.selectedOptions ?? []), ...(a?.customInput ? [a.customInput] : [])]
      if (parts.length > 0) result[q.question] = parts.join(', ')
    }
    execEnd(callId, { text: 'User answers:\n' + JSON.stringify(result), failed: false, details: { results: answers } })
    return result
  }

  function plan(entries) {
    if (!omp) return
    const id = nextId('call_todo')
    const phases = [{ name: 'Todos', tasks: entries.map((e) => ({ content: e.content, status: e.status })) }]
    callTool(id, 'todo', { op: 'init', list: [{ phase: 'Todos', items: entries.map((e) => e.content) }] })
    execStart(id, 'todo', { op: 'init' })
    execEnd(id, { text: `Remaining items (${entries.length})`, failed: false, details: { op: 'init', phases, storage: 'session' } })
  }

  const io = {
    caps: { elicitForm: false, subagents: omp, questions: omp, secretQuestions: false, permissionProfiles: false },
    say: (text, pid) => (pid ? subEvent(pid, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } }) : append('text', text)),
    think: (text, pid) => (pid ? subEvent(pid, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: text } }) : append('thought', text)),
    toolStart,
    toolUpdate,
    plan,
    context: (c) => {
      s.context = c
    },
    // pi 系没有 agent 自己切 mode / 推配置这回事
    mode: () => undefined,
    approve,
    ask,
    elicit: () => {
      throw new Error('pi 系没有表单提问')
    },
    task,
  }

  /** 收尾：最后一条 assistant 消息带用量与 stopReason，然后按方言报 agent_settled / prompt_result + session_settled */
  function finish(r, { promptChars }) {
    const u = r.usage ?? {}
    const usage = usageOf({ input: u.input ?? promptChars, output: u.output ?? mainText, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, thought: u.thought ?? 0 })
    s.usage = s.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    for (const k of Object.keys(s.usage)) s.usage[k] += usage[k]
    const cancelled = r.error === undefined && r.stop === 'cancelled'
    openMessage()
    if (r.error !== undefined) closeMessage('error', { usage, errorMessage: r.error })
    else if (cancelled) closeMessage('aborted', { usage, errorMessage: omp ? 'Interrupted by user' : 'Request was aborted' })
    else closeMessage('stop', { usage })
    out({ type: 'turn_end', message: messages.at(-1), toolResults: [] })
    out({ type: 'agent_end', messages: messages.splice(0), willRetry: false, ...(omp ? { isTerminal: true, yielded: true } : {}) })
    if (!omp) {
      out({ type: 'agent_settled', aborted: cancelled })
    } else {
      const status = r.error !== undefined ? 'error' : cancelled ? 'aborted' : 'completed'
      if (!background) {
        out({
          type: 'prompt_result', id: host.promptId, agentInvoked: true, status,
          ...(r.error !== undefined ? { error: { message: r.error, retryable: false } } : {}), sessionSettled: true,
        })
      }
      out({ type: 'session_settled' })
    }
    over = true
  }

  return { io, finish }
}
