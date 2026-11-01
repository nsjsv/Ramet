// 假 codex 的一轮：把剧本（scenario.mjs）的动作翻成 codex app-server 的通知与服务端请求。
// 形状以 drivers/codex/protocol.ts（由 `codex app-server generate-ts --experimental` 裁剪）为准：
//   - 正文 = agentMessage 条目（item/started → item/agentMessage/delta… → item/completed），思考 = reasoning 条目（summaryTextDelta）
//   - 工具 = commandExecution（读文件 / 搜索也是命令，带 commandActions）/ fileChange（unified diff）/ webSearch / mcpToolCall；
//     命令的实时输出 = item/commandExecution/outputDelta
//   - 子代理 = 独立线程：父线程上 collabAgentToolCall(spawnAgent) 立刻完成，子线程自己 turn/started → 条目 → turn/completed，
//     父线程再以 subAgentActivity 与 collabAgentToolCall(wait) 报结果；停单个子代理 = 对子线程 turn/interrupt
//   - 审批 = item/commandExecution|fileChange|permissions/requestApproval；提问 = item/tool/requestUserInput（实验）；
//     表单 = mcpServer/elicitation/request；计划 = turn/plan/updated；用量 = thread/tokenUsage/updated
//   - approvalPolicy 为 never 时不发审批：完全访问沙箱里直接执行，其余沙箱按拒绝（命令被沙箱挡掉）

let itemSeq = 0
const nextItemId = (prefix) => `${prefix}_${++itemSeq}`

/** 剧本里按 kind（read / edit / execute …）描述的工具 → codex 的条目形状（不含 status 等收尾字段） */
function shapeOf(t, cwd) {
  const name = t.name
  const path = t.locations?.[0]?.path ?? t.input?.file_path ?? ''
  const diffs = (t.content ?? []).filter((c) => c.diff).map((c) => c.diff)
  if (t.kind === 'edit' || name === 'Edit' || name === 'Write') {
    const changes = diffs.length > 0
      ? diffs.map((d) => ({ path: d.path, kind: { type: 'update', move_path: null }, diff: unifiedDiff(d) }))
      : [{ path: path || t.title || '', kind: { type: 'add' }, diff: '' }]
    return { type: 'fileChange', changes }
  }
  const command = (cmd, action) => ({
    type: 'commandExecution', command: cmd, cwd, processId: null, source: 'agent', commandActions: [action],
  })
  if (t.kind === 'read' || name === 'Read') {
    const cmd = `cat ${path || t.title || ''}`
    return command(cmd, { type: 'read', command: cmd, name: (path || '').split('/').pop() ?? '', path })
  }
  if (t.kind === 'search' || name === 'Grep') {
    const cmd = `rg ${t.input?.pattern ?? t.title ?? ''}`
    return command(cmd, { type: 'search', command: cmd, query: t.input?.pattern ?? t.title ?? null, path: null })
  }
  if (t.kind === 'execute' || name === 'Bash') {
    const cmd = t.input?.command ?? t.title ?? ''
    return command(cmd, { type: 'unknown', command: cmd })
  }
  if (t.kind === 'fetch') return { type: 'webSearch', query: t.title ?? '', action: { type: 'search', query: t.title ?? '' } }
  return { type: 'mcpToolCall', server: 'fake', tool: name ?? t.kind ?? 'other', arguments: t.input ?? {}, durationMs: null }
}

function unifiedDiff(d) {
  const lines = (s, sign) => (s ? s.split('\n').map((l) => sign + l).join('\n') + '\n' : '')
  return `--- a/${d.path}\n+++ b/${d.path}\n@@ -1 +1 @@\n${lines(d.old, '-')}${lines(d.new, '+')}`
}

/** 工具结果的文字：content 里的文字 > output > 缺省 */
function resultText(t, failed) {
  const texts = (t.content ?? []).filter((c) => c.text !== undefined).map((c) => c.text)
  if (texts.length > 0) return texts.join('\n')
  if (typeof t.output === 'string') return t.output
  if (t.output !== undefined) return JSON.stringify(t.output)
  return failed ? 'failed' : 'ok'
}

const PLAN_STATUS = { in_progress: 'inProgress', pending: 'pending', completed: 'completed' }
const breakdown = (u) => ({
  totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite,
  inputTokens: u.input, cachedInputTokens: u.cacheRead, cacheWriteInputTokens: u.cacheWrite,
  outputTokens: u.output, reasoningOutputTokens: u.thought,
})

/**
 * 一轮的编码器。host 由进程层提供：
 *   note(method, params)、request(method, params) → { id, done: Promise<result|{error}|null> }（null = 已撤回）、
 *   withdraw(id)、experimental、spawnChild(toolId) → { threadId, turnId }、bindTask(childThreadId, taskId)、endChild(childThreadId)、
 *   threadObj(childThreadId, parentId)
 * t = 线程状态 { id, s, settings: { model, effort, approvalPolicy, sandbox }, usage }
 */
export function codexTurn(host, t, turnId) {
  const s = t.s
  const contexts = new Map() // parentId（'' = 主线程）→ { threadId, turnId, open: { kind, id, text } | null }
  const tools = new Map() // 工具 id → { t, shape, ctx, output, done }
  const children = new Map() // Agent 工具 id → 子线程 { threadId, turnId }
  let over = false
  let mainText = 0

  contexts.set('', { threadId: t.id, turnId, open: null })
  const ctxOf = (pid) => contexts.get(pid ?? '') ?? contexts.get('')
  const note = (method, params) => {
    if (!over) host.note(method, params)
  }
  const scoped = (ctx, extra) => ({ threadId: ctx.threadId, turnId: ctx.turnId, ...extra })

  function closeOpen(ctx) {
    const o = ctx.open
    if (!o) return
    ctx.open = null
    const item = o.kind === 'text'
      ? { type: 'agentMessage', id: o.id, text: o.text, phase: null }
      : { type: 'reasoning', id: o.id, summary: [o.text], content: [] }
    note('item/completed', scoped(ctx, { item, completedAtMs: Date.now() }))
  }

  function append(kind, text, pid) {
    const ctx = ctxOf(pid)
    if (ctx.open?.kind !== kind) {
      closeOpen(ctx)
      const id = nextItemId(kind === 'text' ? 'msg' : 'rs')
      ctx.open = { kind, id, text: '' }
      const item = kind === 'text' ? { type: 'agentMessage', id, text: '', phase: null } : { type: 'reasoning', id, summary: [], content: [] }
      note('item/started', scoped(ctx, { item, startedAtMs: Date.now() }))
      if (kind === 'thought') note('item/reasoning/summaryPartAdded', scoped(ctx, { itemId: id, summaryIndex: 0 }))
    }
    ctx.open.text += text
    if (kind === 'text' && ctx === contexts.get('')) mainText += text.length
    note(kind === 'text' ? 'item/agentMessage/delta' : 'item/reasoning/summaryTextDelta',
      scoped(ctx, { itemId: ctx.open.id, delta: text, ...(kind === 'text' ? {} : { summaryIndex: 0 }) }))
  }

  /** 条目的当前全貌（status：inProgress / completed / failed / declined） */
  function itemOf(tool, status) {
    const { shape } = tool
    const failed = status === 'failed' || status === 'declined'
    const done = status !== 'inProgress'
    switch (shape.type) {
      case 'commandExecution':
        return {
          ...shape, id: tool.t.id, status,
          aggregatedOutput: done ? (tool.output || resultText(tool.t, failed)) : null,
          exitCode: done && status !== 'declined' ? (failed ? 1 : 0) : null, durationMs: done ? 5 : null,
        }
      case 'fileChange':
        return { ...shape, id: tool.t.id, status }
      case 'webSearch':
        return { ...shape, id: tool.t.id }
      default:
        return {
          ...shape, id: tool.t.id, status: status === 'declined' ? 'failed' : status,
          result: done && !failed ? { content: [{ type: 'text', text: resultText(tool.t, false) }], structuredContent: tool.t.output ?? null } : null,
          error: failed ? { message: resultText(tool.t, true) } : null,
        }
    }
  }

  function complete(id, status) {
    const tool = tools.get(id)
    if (!tool || tool.done) return
    tool.done = true
    note('item/completed', scoped(tool.ctx, { item: itemOf(tool, status), completedAtMs: Date.now() }))
  }

  function spawn(tool) {
    const ctx = ctxOf(tool.parentId)
    const child = host.spawnChild(tool.id)
    children.set(tool.id, child)
    contexts.set(tool.id, { threadId: child.threadId, turnId: child.turnId, open: null })
    const base = {
      type: 'collabAgentToolCall', id: tool.id, tool: 'spawnAgent', senderThreadId: ctx.threadId, receiverThreadIds: [child.threadId],
      prompt: tool.input?.prompt ?? tool.title ?? null, model: t.settings.model, reasoningEffort: t.settings.effort,
    }
    note('item/started', scoped(ctx, { item: { ...base, status: 'inProgress', agentsStates: { [child.threadId]: { status: 'pendingInit', message: null } } }, startedAtMs: Date.now() }))
    note('item/completed', scoped(ctx, { item: { ...base, status: 'completed', agentsStates: { [child.threadId]: { status: 'running', message: null } } }, completedAtMs: Date.now() }))
    note('thread/started', { thread: host.threadObj(child.threadId, ctx.threadId) })
    note('turn/started', { threadId: child.threadId, turn: { id: child.turnId, items: [], status: 'inProgress', error: null, startedAt: Date.now(), completedAt: null, durationMs: null } })
    activity(ctx, tool.id, child.threadId, 'started', tool.input?.subagent_type)
  }

  function activity(ctx, toolId, childId, kind, role) {
    const item = { type: 'subAgentActivity', id: nextItemId('act'), kind, agentThreadId: childId, agentPath: '/root/' + (role ?? 'agent').toLowerCase() }
    note('item/started', scoped(ctx, { item, startedAtMs: Date.now() }))
    note('item/completed', scoped(ctx, { item, completedAtMs: Date.now() }))
  }

  function toolStart(tool) {
    if (over) return
    const ctx = ctxOf(tool.parentId)
    closeOpen(ctx)
    if (tool.name === 'Agent') return spawn(tool)
    const entry = { t: { ...tool }, shape: shapeOf(tool, s.cwd), ctx, output: '', done: false }
    tools.set(tool.id, entry)
    note('item/started', scoped(ctx, { item: itemOf(entry, 'inProgress'), startedAtMs: Date.now() }))
    if (tool.status === 'completed' || tool.status === 'failed') complete(tool.id, tool.status)
  }

  function toolUpdate(tool) {
    const entry = tools.get(tool.id)
    if (!entry || entry.done) return
    entry.t = { ...entry.t, ...tool }
    const texts = (tool.content ?? []).filter((c) => c.text !== undefined).map((c) => c.text)
    if (entry.shape.type === 'commandExecution' && texts.length > 0) {
      const delta = texts.join('\n') + '\n'
      entry.output += delta
      note('item/commandExecution/outputDelta', scoped(entry.ctx, { itemId: tool.id, delta }))
    }
    if (entry.shape.type === 'fileChange' && (tool.content ?? []).some((c) => c.diff)) {
      entry.shape = shapeOf(entry.t, s.cwd)
      note('item/fileChange/patchUpdated', scoped(entry.ctx, { itemId: tool.id, changes: entry.shape.changes }))
    }
    if (tool.status === 'completed' || tool.status === 'failed') complete(tool.id, tool.status)
  }

  /** 发一条服务端请求等应答：null = 被撤回（中断）；{error} = 宿主回了错误 */
  const ask = (method, params) => host.request(method, params).done

  async function approve({ tool, options }) {
    if (!tools.has(tool.id)) toolStart({ ...tool, status: 'in_progress' })
    const entry = tools.get(tool.id)
    const allowOnce = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind.startsWith('allow'))
    const allowAlways = options.find((o) => o.kind === 'allow_always')
    const reject = options.find((o) => o.kind.startsWith('reject'))
    const settle = (granted) => {
      complete(tool.id, granted ? 'completed' : 'declined')
      return granted ? allowOnce?.id ?? null : reject?.id ?? null
    }
    if (t.settings.approvalPolicy === 'never') return settle(t.settings.sandbox === 'danger-full-access')
    const ctx = entry?.ctx ?? ctxOf(tool.parentId)
    const common = scoped(ctx, { itemId: tool.id, startedAtMs: Date.now() })
    if (io.caps.permissionProfiles && tool.permissions) {
      const r = await ask('item/permissions/requestApproval', {
        ...common, cwd: s.cwd, reason: tool.title ?? null,
        permissions: { network: tool.permissions.network ? { enabled: true } : null, fileSystem: null },
      })
      if (r === null) return null
      const granted = r.error === undefined && Object.keys(r.permissions ?? {}).length > 0
      if (!granted) return settle(false)
      complete(tool.id, 'completed')
      return (r.scope === 'session' ? allowAlways ?? allowOnce : allowOnce)?.id ?? null
    }
    const r = entry?.shape.type === 'fileChange'
      ? await ask('item/fileChange/requestApproval', { ...common, reason: tool.title ?? null, grantRoot: null })
      : await ask('item/commandExecution/requestApproval', {
          ...common, kind: 'command', command: entry?.shape.command ?? tool.title ?? '', cwd: s.cwd,
          reason: tool.input?.description ?? tool.title ?? null, commandActions: entry?.shape.commandActions ?? [],
          availableDecisions: allowAlways ? ['accept', 'acceptForSession', 'decline', 'cancel'] : ['accept', 'decline', 'cancel'],
        })
    if (r === null) return null
    const decision = r.error !== undefined ? 'decline' : r.decision
    if (decision === 'cancel') {
      // codex 的 cancel = 拒绝并中断这一轮
      complete(tool.id, 'declined')
      s.cancelled = true
      return null
    }
    if (decision === 'decline' || decision === undefined) return settle(false)
    complete(tool.id, 'completed')
    if (decision === 'accept') return allowOnce?.id ?? null
    return (allowAlways ?? allowOnce)?.id ?? null
  }

  async function questions(list) {
    const qs = list.map((q, i) => ({
      id: `q${i}`, header: q.header, question: q.question,
      isOther: !q.secret && (q.options?.length ?? 0) > 0, isSecret: !!q.secret,
      options: q.options?.length ? q.options.map((o) => ({ label: o.label, description: o.description ?? '' })) : null,
    }))
    const r = await ask('item/tool/requestUserInput', {
      ...scoped(contexts.get(''), {}), itemId: nextItemId('call_ask'), questions: qs, isBlocking: true, autoResolutionMs: null,
    })
    if (r === null) return null
    const answers = r.error === undefined ? r.answers ?? {} : {}
    // codex 的提问没有「拒绝」：宿主跳过时回空答案
    if (Object.keys(answers).length === 0) return { declined: true }
    return Object.fromEntries(qs.filter((q) => answers[q.id]).map((q) => [q.question, answers[q.id].answers.join(', ')]))
  }

  function elicit(form) {
    const req = host.request('mcpServer/elicitation/request', {
      ...scoped(contexts.get(''), {}), serverName: 'ramet', mode: 'form', _meta: null, message: form.message, requestedSchema: form.requestedSchema,
    })
    let fallback
    const answer = new Promise((resolve) => {
      fallback = resolve
      req.done.then((r) => resolve(r === null || r.error !== undefined ? null : r))
    })
    return {
      answer,
      // codex 撤回 = serverRequest/resolved，之后宿主不会再应答：按 cancel 了结
      withdraw: () => {
        fallback({ action: 'cancel' })
        host.withdraw(req.id)
      },
    }
  }

  function task(op) {
    const child = children.get(op.toolId)
    if (!child) return
    if (op.op === 'start') return host.bindTask(child.threadId, op.id)
    if (op.op !== 'end') return
    const ctx = contexts.get(op.toolId)
    closeOpen(ctx)
    const stopped = op.status !== 'completed'
    host.endChild(child.threadId)
    note('turn/completed', {
      threadId: child.threadId,
      turn: { id: child.turnId, items: [], status: stopped ? 'interrupted' : 'completed', error: null, startedAt: null, completedAt: Date.now(), durationMs: null },
    })
    const parent = ctxOf(undefined)
    activity(parent, op.toolId, child.threadId, stopped ? 'interrupted' : 'completed')
    const wait = {
      type: 'collabAgentToolCall', id: `${op.toolId}_wait`, tool: 'wait', senderThreadId: parent.threadId, receiverThreadIds: [child.threadId],
      prompt: null, model: null, reasoningEffort: null,
    }
    note('item/started', scoped(parent, { item: { ...wait, status: 'inProgress', agentsStates: { [child.threadId]: { status: 'running', message: null } } }, startedAtMs: Date.now() }))
    note('item/completed', scoped(parent, {
      item: { ...wait, status: 'completed', agentsStates: { [child.threadId]: { status: stopped ? 'interrupted' : 'completed', message: op.summary ?? null } } },
      completedAtMs: Date.now(),
    }))
  }

  function usage(u, contextWindow) {
    for (const k of Object.keys(t.usage)) t.usage[k] += u[k]
    note('thread/tokenUsage/updated', scoped(contexts.get(''), {
      tokenUsage: { total: breakdown(t.usage), last: breakdown(u), modelContextWindow: contextWindow },
    }))
  }

  const io = {
    caps: { elicitForm: true, subagents: true, questions: host.experimental, secretQuestions: true, permissionProfiles: true },
    say: (text, pid) => append('text', text, pid),
    think: (text, pid) => append('thought', text, pid),
    toolStart,
    toolUpdate,
    plan: (entries) => note('turn/plan/updated', scoped(contexts.get(''), {
      explanation: null, plan: entries.map((e) => ({ step: e.content, status: PLAN_STATUS[e.status] ?? 'pending' })),
    })),
    context: (c) => usage({ input: c.used, output: 0, cacheRead: 0, cacheWrite: 0, thought: 0 }, c.size),
    // codex 没有 agent 自己切 mode / 推配置这回事
    mode: () => undefined,
    approve,
    ask: questions,
    elicit,
    task,
  }

  /** 收尾：关掉还开着的条目，报用量，发 turn/completed。之后这一轮的任何动作都不再出声 */
  function finish(r, { promptChars }) {
    for (const ctx of contexts.values()) closeOpen(ctx)
    const u = r.usage ?? {}
    usage({
      input: u.input ?? promptChars, output: u.output ?? mainText, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, thought: u.thought ?? 0,
    }, 200000)
    const main = contexts.get('')
    const error = r.error !== undefined ? { message: r.error, codexErrorInfo: null, additionalDetails: null } : null
    if (error) note('error', scoped(main, { error, willRetry: false }))
    const status = error ? 'failed' : r.stop === 'cancelled' ? 'interrupted' : 'completed'
    note('turn/completed', { threadId: t.id, turn: { id: turnId, items: [], status, error, startedAt: null, completedAt: Date.now(), durationMs: null } })
    over = true
  }

  return { io, finish }
}
