// 假 ACP agent:测试用,stdio 上说最小 ACP 协议(NDJSON JSON-RPC 2.0)。
// 行为由 prompt 文本驱动:
//   含「需要权限」 → 发 session/request_permission,应答结果回显 'granted:<optionId|cancelled>'
//   含「用工具」   → 发两次 tool_call + 两次 tool_call_update(含只有 status 的增量),再输出
//                  'tool-done'(测过程事件合并与归档)
//   含「markdown」 → 分片吐 markdown(标题/列表/加粗/行内代码/代码块),测轮次结束的块结构重写
//   含「慢慢来」   → 分 10 片慢速输出(测 stop 取消)
//   含「报目录」   → 先回一行 `cwd:<session/new 收到的 cwd>`(测工作区覆盖真的传到了 agent)
//   否则          → 输出 'turn:full|delta'(全文重放里同时含两问文本;增量只有最后一问)
// 收到 session/cancel → 在飞 prompt 以 stopReason 'cancelled' 收尾。

import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin, terminal: false })
const sessions = new Map()
let sessionCount = 0
let permResponder = null
let nextMsgId = 9000

// 每个 session 独立的 config 状态(model/thinking 各两档)
function defaultConfigs() {
  return [
    {
      id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm1',
      options: [
        { value: 'm1', name: 'M1' },
        { value: 'm2', name: 'M2' },
      ],
    },
    {
      id: 'thinking', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: 'low',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
  ]
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}
function chunk(sessionId, text) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  })
}

function thought(sessionId, text) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } },
  })
}

/** 工具调用过程:与 chunk 同一条 session/update 通道,负载是 tool_call / tool_call_update */
function tool(sessionId, update) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update },
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function handlePrompt(id, { sessionId, prompt }) {
  const state = sessions.get(sessionId)
  if (!state) {
    // 真实 ACP agent 不认没 session/new 过、也没 session/load 过的会话（omp 回 -32603
    // 「Unsupported ACP session」）。假 agent 也照做，否则「中心跳过 load 直接 prompt」这类
    // 只在真实 agent 上炸的 bug 在测试里永远看不出来。
    return send({
      jsonrpc: '2.0', id,
      error: { code: -32603, message: 'Internal error', data: { details: `Unsupported ACP session: ${sessionId}` } },
    })
  }
  state.cancelled = false // 新一轮 prompt 重置取消标记(取消只作用于在飞轮次)
  const text = prompt.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  if (text.includes('需要权限')) {
    const reqId = nextMsgId++
    const outcome = await new Promise((resolve) => {
      permResponder = resolve
      send({
        jsonrpc: '2.0', id: reqId, method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId: 't1', title: '写文件', kind: 'edit' },
          options: [
            { optionId: 'allow_once', name: '允许', kind: 'allow_once' },
            { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' },
          ],
        },
      })
    })
    if (state.cancelled) return reply(id, { stopReason: 'cancelled' })
    chunk(sessionId, 'granted:' + (outcome.outcome === 'cancelled' ? 'cancelled' : outcome.optionId) + '\n')
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('用工具')) {
    // 两次调用:一次只有 tool_call(全量),一次只带 status 的 tool_call_update(增量)——
    // 后者专门验合并(缺字段不能被默认值打回)。中间夹 sleep:给测试留出"运行中接第二个
    // SSE 订阅"的窗口(订阅快照必须带已收集的步骤)
    tool(sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 'call-1', title: '读 acp.ts', kind: 'read', status: 'pending',
      locations: [{ path: 'packages/server/src/agents/acp.ts' }],
    })
    await sleep(300)
    tool(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'in_progress' })
    tool(sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 'call-2', title: '跑测试', kind: 'execute', status: 'completed',
    })
    await sleep(300)
    tool(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' })
    chunk(sessionId, 'tool-done\n')
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('markdown')) {
    // 轮次计数照常推进:它是「增量还是全文重放」的判据,漏掉会让下一轮被误判成全量
    state.turns = (state.turns ?? 0) + 1
    // 逐片吐 markdown(流式阶段落成纯段落,轮次结束由服务端重写成块结构)
    for (const piece of ['# 标题\n', '\n', '- 第一项\n', '- 第二项\n', '\n', '**加粗**与`代码`\n', '\n', '[甲](https://a.dev)[乙](https://b.dev)\n', '\n', '```ts\n', 'const a = 1\n', '```\n']) {
      chunk(sessionId, piece)
    }
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('演示')) {
    // 浏览器验收用的慢速完整流程:思考 → 说一句 → 工具 → 思考 → 结构化的最后一段(实时 markdown / 换段 / 收回)
    const say = async (s) => {
      for (const piece of s.match(/[\s\S]{1,5}/g)) {
        if (state.cancelled) return false
        chunk(sessionId, piece)
        await sleep(55)
      }
      return true
    }
    const stopped = () => reply(id, { stopReason: 'cancelled' })
    thought(sessionId, '先看看文档结构，再决定怎么改。')
    await sleep(900)
    if (!(await say('我先看看 `ReplyWriter` 怎么落块，再查收尾在哪条路径上。'))) return stopped()
    await sleep(500)
    tool(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'd-1', title: '搜索 ReplyWriter', kind: 'search', status: 'in_progress' })
    await sleep(900)
    tool(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'd-1', status: 'completed' })
    tool(sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 'd-2', title: '读取 agents/doc.ts', kind: 'read', status: 'in_progress',
      locations: [{ path: 'packages/server/src/agents/doc.ts' }],
    })
    await sleep(900)
    tool(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'd-2', status: 'completed' })
    for (const t of ['停止和出错两条出口', '都跳过了收尾，', '要挪到共用的地方；', '顺便确认 hash ', '落在最终结构上，', '再补测试。']) {
      thought(sessionId, t)
      await sleep(1200)
    }
    if (state.cancelled) return stopped()
    const final = '## 原因\n\n停止和出错两条出口都跳过了 `rewrite`。\n\n## 改动\n\n- 收尾挪到三条出口共用的 `finally`\n- 补了 **42** 个测试\n\n| 出口 | 结果 |\n| --- | --- |\n| 正常 | 结构化 |\n| 停止 | 结构化 |\n'
    if (!(await say(final))) return stopped()
    tool(sessionId, { sessionUpdate: 'usage_update', used: 38000, size: 200000 })
    return reply(id, {
      stopReason: 'end_turn',
      usage: { totalTokens: 13200, inputTokens: 9800, outputTokens: 1400, cachedReadTokens: 2000, cachedWriteTokens: 0 },
    })
  }
  if (text.includes('破折')) {
    const piece = async (s, ms=2500) => { chunk(sessionId, s); await sleep(ms) }
    await piece('结果如下：\n')
    await piece('-')
    await piece(' 没有工具调用', 1500)
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('多段')) {
    // 换段 + 思考 + 用量:说一句 → 工具 → 只吐空白(不换段)→ 思考 → 失败的工具 → 新的一段
    thought(sessionId, '先想想')
    chunk(sessionId, '我先看看')
    tool(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'm-1', title: '读 doc.ts', kind: 'read', status: 'completed' })
    chunk(sessionId, '\n')
    thought(sessionId, '再想想')
    tool(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'm-2', title: '跑测试', kind: 'execute', status: 'pending' })
    tool(sessionId, {
      sessionUpdate: 'tool_call_update', toolCallId: 'm-2', status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: '\n2 failed · doc.test.ts\n详情' } }],
    })
    chunk(sessionId, '## 结论\n\n')
    chunk(sessionId, '**好了**')
    tool(sessionId, { sessionUpdate: 'usage_update', used: 38000, size: 200000 })
    return reply(id, {
      stopReason: 'end_turn',
      usage: { totalTokens: 1500, inputTokens: 1000, outputTokens: 200, cachedReadTokens: 300 },
    })
  }
  if (text.includes('慢慢来')) {
    for (let i = 0; i < 10; i++) {
      if (state.cancelled) return reply(id, { stopReason: 'cancelled' })
      chunk(sessionId, `piece${i}\n`)
      await sleep(150)
    }
    return reply(id, { stopReason: 'end_turn' })
  }
  // 首轮 prompt 必是全文重放(新 session);后续同 session 的轮次是增量
  state.turns = (state.turns ?? 0) + 1
  const cfg = (state.configs ?? []).map((c) => `${c.id}=${c.currentValue}`).join(' ')
  if (text.includes('报目录')) chunk(sessionId, 'cwd:' + (state.cwd ?? '?') + '\n')
  chunk(sessionId, 'turn:' + (state.turns === 1 ? 'full' : 'delta') + (cfg ? ' ' + cfg : '') + '\n')
  return reply(id, { stopReason: 'end_turn' })
}

rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, method, params } = msg
  if (method === undefined && id >= 9000 && permResponder) {
    const responder = permResponder
    permResponder = null
    responder(msg.result?.outcome ?? { outcome: 'cancelled' })
    return
  }
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: 'fake', title: 'Fake', version: '0.0.1' },
    })
  }
  if (method === 'session/new') {
    const sid = 'sess-' + ++sessionCount
    // cwd 记下来：含「报目录」的 prompt 会把它回显出来（工作区覆盖的端到端断言靠这条）
    sessions.set(sid, { cancelled: false, cwd: params.cwd, configs: defaultConfigs() })
    return reply(id, { sessionId: sid, configOptions: sessions.get(sid).configs })
  }
  if (method === 'session/load') {
    if (!sessions.has(params.sessionId)) sessions.set(params.sessionId, { cancelled: false, foreign: true, configs: defaultConfigs() })
    return reply(id, { configOptions: sessions.get(params.sessionId).configs })
  }
  if (method === 'session/set_config_option') {
    const state = sessions.get(params.sessionId)
    if (!state || !state.configs) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown session or config not supported' } })
    const opt = state.configs.find((c) => c.id === params.configId)
    if (!opt) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown configId ${params.configId}` } })
    opt.currentValue = params.value?.type === 'id' ? params.value.value : String(params.value)
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: params.sessionId, update: { sessionUpdate: 'config_option_update', configOptions: state.configs } },
    })
    return reply(id, { configOptions: state.configs })
  }
  if (method === 'session/cancel') {
    for (const s of sessions.values()) s.cancelled = true
    return
  }
  if (method === 'session/prompt') return void handlePrompt(id, params)
})
