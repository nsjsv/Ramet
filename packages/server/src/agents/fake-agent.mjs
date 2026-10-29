// 假 ACP agent:测试用,stdio 上说最小 ACP 协议(NDJSON JSON-RPC 2.0)。
// 行为由 prompt 文本驱动:
//   含「需要权限」 → 发 session/request_permission,应答结果回显 'granted:<optionId|cancelled>'
//                  默认审批带命令预览（rawInput.command）；另含「审批改文件」= 带 diff + 路径，「审批无预览」= 只有标题
//   含「三十步」   → 32 个连续 tool_call（每步 150ms），测运行条封顶与正文位置稳定
//   含「用工具」   → 发两次 tool_call + 两次 tool_call_update(含只有 status 的增量),再输出
//                  'tool-done'(测过程事件合并与归档)
//   含「计划验收」 → 先报一份计划（读代码 进行中 / 写测试 待办），再报更新后的整份（读代码 完成 / 写测试 进行中），
//                  最后回 '计划好了'（测 ACP plan 作为 run 原语整份替换，并随回复块的 plan 属性落盘）
//   含「markdown」 → 分片吐 markdown(标题/列表/加粗/行内代码/代码块),测轮次结束的块结构重写
//   含「详情验收」 → ~15s 慢速走一遍「ACP 详情」全形状(测适配器原样保留 + RunRecord 合并):
//                  完整 thought → 中间正文 → 子代理正文/思考【先于父工具】(dt-2,验 childBuf) →
//                  tool_call(两次 locations/rawInput/_meta) → 只有 status 的 update(字段不能被抹) →
//                  content(文字+diff)+rawOutput → 子代理正文/思考(parentToolUseId 归属) →
//                  子代理 tool_call(pi rawInput)+update(omp rawOutput progress) → plan →
//                  current_mode_update → config_option_update → usage_update(带 cost) → 流式最终段;
//                  PromptResponse 带 _meta 与 usage(含 cachedWriteTokens:0 / thoughtTokens)。
// 含「慢慢来」   → 分 10 片慢速输出(测 stop 取消)
//   含「断线续」   → 先吐 before，睡 8 秒，再吐 after(测中心重启后续上；取消在睡眠里认)
//   含「报目录」   → 先回一行 `cwd:<session/new 收到的 cwd>`(测工作区覆盖真的传到了 agent)
//   含「报 MCP」   → 回 `mcp:<name> <脚本名> <中心地址>`(测 read_page 真的随会话交到 agent)
//   含「报引用」   → 回 `res:<resource 块数>`(测 @/[[ 不整页粘贴：引用页正文不进 prompt)
//   含「回显提示词」→ 把收到的提示词文字包进代码块原样回复(测块引用解析：agent 拿到的是原块当前内容)
//   否则          → 输出 'turn:full|delta'(全文重放里同时含两问文本;增量只有最后一问)
//   含「失败」     → 以 JSON-RPC 错误收尾（测本轮失败）；「失败一次」= 同一段提示词只失败第一次（测重试）
//   含「终端命令」 → 经 ACP terminal/create 跑一条会打印 hello-term（stdout）与 err-line（stderr）的 node 命令，tool_call 里嵌 terminal 内容，
//                  等它退出后回显 `term:<退出码>:<输出>`，release（测实时输出进 run、输出合并、退出码）
//                  「终端长命令」= 每 100ms 打印 tick 的长命令（60 秒），等它退出（用户点「停止这条命令」→ terminal/kill → 退出），回显 `term-exit:<退出码>:<信号>`
//                  「终端越界」= cwd 给工作区之外（/），回显 `term-denied:<错误信息>`；「终端截断」= outputByteLimit 100 + 打印 1000 个 x，
//                  回显 `term-trunc:<truncated>:<输出长度>`；「终端环境」= 回显命令进程里 RAMET_* 环境变量的个数 `env-ramet:<n>`
//   带队（/带队，测试靠 MCP 真调中心的 submit_plan / send_back；这几条都先于下面所有触发词判定）：
//   含「[Ramet 带队·出计划]」 → 计划轮：读用户消息里 `PLANFILE=<json 文件路径>`（文件内容 = submit_plan 的参数；多份用 `PLANFILE2=` 再交一次覆盖），
//                  经 MCP 调 submit_plan，回显 `plan-submitted` / `plan-error:<原因>`；没有 PLANFILE 则回 `no-plan`；`报工具` 回显组长此刻的 MCP 工具名
//   含「[Ramet 带队·组员]」 → 组员：任务编号取 `任务编号：<id>`，行为看「任务说明」里的词：`工作:慢<毫秒>`（慢速、认取消）/ `工作:出错`（JSON-RPC 错误）/
//                  `工作:审批`（先要一次审批，回显 approved:<optionId|cancelled>）/ `工作:报目录`（回显 cwd:<会话目录>）/ `工作:报工具`（回显 MCP 工具名）；
//                  默认回 `delivered:<id>`（返工的是 `redelivered:<id>:<第几次>`，带前置结果的追加 ` pre:<前置任务 id>`）
//   含「[Ramet 带队·交叉审查]」 → 组长：回显每个任务的状态 `review:<id>=<已交付|出错|没有执行|已取消>;…`；目标里有 `SENDBACK=<id>x<次数>` 就经 MCP 连调那么多次 send_back，
//                  回显每次的结果 `sb:<outcome>:<output>`，被拒回显 `sb-error:<原因>`；`报工具` 回显组长此刻的 MCP 工具名；
//                  目标里有 `审查等待<毫秒>` = 审查完再睡这么久才收尾（认取消）
//   含「报工具」   → 回显本会话 MCP 的工具名 `tools:<a,b,c>`（测 submit_plan / send_back 只在带队组长的凭证里）
//   含「退出计划」 → 发 claude ExitPlanMode 形状的审批（带 exit-plan-bypass 选项）；答后只发 current_mode_update
//                  （不发 config_option_update）把 mode 切过去，回显 'plan-exit:<optionId>'
//   含「后台审批」 → 发一条审批但不等它，prompt 立刻 end_turn（审批比 prompt 活得久：测 busy 含待批）
//   含「报后台审批」→ 回显那条后台审批的应答结果 'bg:<optionId|cancelled|pending>'（审批发出过而应答还在路上时最多等 1 秒：
//                  客户端写出应答和紧跟着的下一条 prompt 没有先后保证，不等会随机回 pending）
//   含「报视图」   → 回 `view:<用户消息行数>:<回复行数>@<会话 id>`（数提示词里 '>> ' / '> ' 开头的行：测重新生成时
//                  agent 看到的「视图」只有目标回复之前的内容；会话 id 证明重做新建了会话）
//   含「随手读文件:<路径>」/「随手写文件:<路径>」/「随手终端」 → 经 ACP fs/read_text_file / fs/write_text_file / terminal/create 向客户端要，
//                  回显 `read-ok:<内容>` / `read-denied:<原因>`（写、终端同理 write-ok|write-denied、term-ok|term-denied；测随手 AI 的受限会话）
//   含「随手审批」 → 发 session/request_permission（allow_once / reject_once），回显 `perm:<optionId|cancelled>`
//   含「报图片」   → 回显这一轮 prompt 里的图片块 `images:<块数>:<mimeType,…>`（环境变量 FAKE_IMAGE=1 才在 initialize 里声明
//                  promptCapabilities.image；不声明时客户端应把图片块丢掉 → `images:0:`）
//   含「随手工具」 → 发一个 tool_call（不经审批），睡 3 秒（认取消）再回显 'tool-ran'（测随手 AI 见到工具调用就中止）
//   提问（ACP elicitation/create，form 模式；initialize 没声明 clientCapabilities.elicitation.form 时一律回显 `ask:unsupported`、不发）：
//   含「表单提问:<形状>」 → 按各家 agent 的形状发一张表单（形状见 ASK_SHAPES：claude / codex / opencode / omp / omp-select /
//                  omp-confirm / weird），带 toolCallId 的先发对应的 tool_call；回显 `ask:<action>:<content JSON>`
//   含「表单撤回」 → 发一张表单，300ms 后用 $/cancel_request 撤回它，回显 `ask-withdrawn:<客户端的应答 action>`
//   含「表单超时」 → 发一张表单不等应答就 end_turn（omp 超时后不通知客户端）；「报表单超时」回显那张表单迟到的应答 `ask-late:<action|pending>`
//   含「随手慢」   → 约 20 秒慢速输出（认取消；测随手 AI 的超时）
// 环境变量 FAKE_MODE = 新会话的初始 mode（缺省 default；bypassPermissions 测随手 AI 的免确认档）；
//   FAKE_MODE_LOCKED=1 = 改 mode 的请求被忽略（切不走，测随手 AI 拒绝运行）
// 启动参数 argv[2] = 命令名（argv[3] = 'arg' 时另推一条带参命令）：session/new|load 应答之后推一条 available_commands_update（两个实例命令名不同）
// config 带 mode（default / bypassPermissions，category=mode）。多条审批并发按 id 分开答，互不串。
// 收到 session/cancel → 只取消该会话在飞的 prompt，以 stopReason 'cancelled' 收尾。

import readline from 'node:readline'
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const rl = readline.createInterface({ input: process.stdin, terminal: false })
const sessions = new Map()
let sessionCount = 0
/** 审批请求 id → resolve：多个会话 / 多条审批并发各答各的 */
const permResponders = new Map()
/** 「失败一次」已经失败过的提示词 */
const failedOnce = new Set()
let bgOutcome = null
/** 客户端在 initialize 里声明了 elicitation.form */
let elicitForm = false
/** 「表单超时」那张表单迟到的应答 */
let lateAsk = null
/** 后台审批发出过（应答可能还在路上） */
let bgAsked = false
const COMMAND = process.argv[2] ?? ''
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
    {
      id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: process.env.FAKE_MODE ?? 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'bypassPermissions', name: 'Bypass permissions' },
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
/** 子代理自己的正文/思考:靠 `_meta.claudeCode.parentToolUseId` 归到唤起它的那次工具调用 */
function childChunk(sessionId, parentId, kind, text) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: kind === 'thought' ? 'agent_thought_chunk' : 'agent_message_chunk',
        content: { type: 'text', text },
        _meta: { claudeCode: { parentToolUseId: parentId } },
      },
    },
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 客户端请求的应答（terminal/* 等 agent→client 的请求）：id → resolve({result,error}) */
const callResponders = new Map()
/** 向客户端发一个请求，返回 {result,error} */
function clientCall(method, params) {
  const { promise, resolve } = Promise.withResolvers()
  const reqId = nextMsgId++
  callResponders.set(reqId, resolve)
  send({ jsonrpc: '2.0', id: reqId, method, params })
  return promise
}
const NODE_CMD = (code) => ({ command: process.execPath, args: ['-e', code] })

/** 各家 agent 的提问形状（claude-agent-acp / codex-acp / opencode v2 / omp，见 agents/ask-form.ts 文件头） */
const ASK_SHAPES = {
  claude: {
    toolCallId: 'ask-claude', message: '用哪个包管理器？',
    requestedSchema: { type: 'object', properties: {
      question_0: { type: 'string', title: '包管理器', oneOf: [{ const: 'npm', title: 'npm', description: '默认' }, { const: 'pnpm', title: 'pnpm' }] },
      question_0_custom: { type: 'string', title: 'Other', description: 'Type your own answer (optional).' },
      question_1: { type: 'array', title: '功能', description: '要哪些功能？', items: { anyOf: [{ const: 'lint', title: 'Lint' }, { const: 'test', title: 'Test' }] } },
    } },
  },
  codex: {
    toolCallId: 'ask-codex', message: 'Codex needs your input to continue.',
    requestedSchema: { type: 'object', required: ['env', 'token'], properties: {
      env: { type: 'string', title: '部署到哪？', oneOf: [{ const: 'staging', title: 'staging' }, { const: 'None of the above', title: 'None of the above' }] },
      env_note: { type: 'string', title: 'Additional answer or note', _meta: { codex: { questionId: 'env', role: 'user_note' } } },
      token: { type: 'string', title: 'API token', _meta: { codex: { isSecret: true } } },
    } },
  },
  opencode: {
    toolCallId: 'ask-opencode', message: 'Which package manager?',
    requestedSchema: { type: 'object', required: ['pm'], properties: {
      pm: { type: 'string', title: 'Package manager', oneOf: [{ const: 'bun', title: 'Bun' }, { const: 'npm', title: 'npm' }] },
      pm_custom: { type: 'string', title: 'Custom answer' },
    } },
  },
  omp: {
    message: '选一个方案',
    requestedSchema: { type: 'object', properties: {
      q0: { type: 'string', title: '方案', oneOf: [{ const: 'A', title: 'A' }, { const: 'B', title: 'B' }], default: 'A' },
      q0__other: { type: 'string' },
      q1: { type: 'string', description: 'editor', default: 'line1\nline2' },
    } },
  },
  'omp-select': { message: 'Approve tool call: bash', requestedSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string', enum: ['Approve', 'Deny'] } } } },
  'omp-confirm': { message: '继续吗？', requestedSchema: { type: 'object', required: ['value'], properties: { value: { type: 'boolean' } } } },
  // 必填字段的类型认不出：客户端应直接回 cancel
  weird: { message: '怪表单', requestedSchema: { type: 'object', required: ['x'], properties: { x: { type: 'object' } } } },
}

function askParams(shape, sessionId) {
  return { mode: 'form', sessionId, ...ASK_SHAPES[shape] }
}

/** 向客户端要一个审批，返回它的 outcome（selected / cancelled） */
function askPermission(sessionId, { toolCall, options }) {
  const { promise, resolve } = Promise.withResolvers()
  const reqId = nextMsgId++
  permResponders.set(reqId, resolve)
  send({ jsonrpc: '2.0', id: reqId, method: 'session/request_permission', params: { sessionId, toolCall, options } })
  return promise
}

/** 命令名由启动参数给（没给 = 不推命令） */
function announceCommands(sessionId) {
  if (!COMMAND) return
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: 'available_commands_update', availableCommands: [
          { name: COMMAND, description: COMMAND + ' 命令' },
          // argv[3] === 'arg' 时多推一条带参命令（input.hint），测命令参数透传
          ...(process.argv[3] === 'arg' ? [{ name: COMMAND + '-arg', description: COMMAND + ' 带参命令', input: { hint: '参数' } }] : []),
        ] },
    },
  })
}

/** 把会话切到另一个 mode：只推 current_mode_update（真 agent 的 ExitPlanMode 就是这样），不推 config_option_update */
function setMode(sessionId, state, mode) {
  const opt = state.configs.find((c) => c.id === 'mode')
  if (opt) opt.currentValue = mode
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: mode } } })
}


/** 用本会话收到的 mcpServers[0] 拉起 Ramet 的 MCP 进程（就是真 agent 的做法），跑 fn(client)，再关掉 */
async function withMcp(state, fn) {
  const spec = (state.mcp ?? [])[0]
  if (!spec) return null
  const client = new Client({ name: 'fake-agent', version: '0.0.1' })
  await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env: Object.fromEntries((spec.env ?? []).map((e) => [e.name, e.value])) }))
  try {
    return await fn(client)
  } finally {
    await client.close().catch(() => undefined)
  }
}
const toolText = (res) => (res.content ?? []).map((c) => c.text ?? '').join('')
const mcpToolNames = (state) => withMcp(state, async (c) => (await c.listTools()).tools.map((t) => t.name))

/** 睡 ms 毫秒，认取消；被取消返回 true */
async function napCancellable(state, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (state.cancelled) return true
    await sleep(25)
  }
  return state.cancelled
}

/** 带队：计划轮 / 组员 / 组长交叉审查三种提示词的行为（见文件头）。处理了返回 true */
async function handleTeam(id, sessionId, state, text) {
  if (text.includes('[Ramet 带队·出计划]')) {
    // 全文重放里有历次的用户消息：只看最后一条 `/带队`
    const last = text.slice(Math.max(0, text.lastIndexOf('>> /带队')))
    const files = [last.match(/PLANFILE=(\S+)/)?.[1], last.match(/PLANFILE2=(\S+)/)?.[1]].filter(Boolean)
    if (files.length === 0) {
      chunk(sessionId, 'no-plan\n')
      reply(id, { stopReason: 'end_turn' })
      return true
    }
    for (const file of files) {
      const plan = JSON.parse(readFileSync(file, 'utf8'))
      const res = await withMcp(state, (c) => c.callTool({ name: 'submit_plan', arguments: plan }, undefined, { timeout: 120_000 }))
      chunk(sessionId, (res?.isError ? 'plan-error:' + toolText(res) : 'plan-submitted') + '\n')
    }
    if (text.includes('报工具')) chunk(sessionId, 'tools:' + ((await mcpToolNames(state)) ?? []).join(',') + '\n')
    reply(id, { stopReason: 'end_turn' })
    return true
  }
  if (text.includes('[Ramet 带队·组员]')) {
    const taskId = text.match(/任务编号：(\S+)/)?.[1] ?? '?'
    const detail = (text.match(/任务说明：\n([\s\S]*?)(?:\n\n前置任务已经做完|\n\n你上一次交付的结果|$)/)?.[1] ?? '')
    const redo = text.match(/第 (\d+) 次返工/)?.[1]
    const pre = [...text.matchAll(/### 任务 (\S+)「/g)].map((m) => m[1])
    if (detail.includes('工作:出错')) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error', data: { details: '假组员按要求出错' } } })
      return true
    }
    const slow = detail.match(/工作:慢(\d+)/)?.[1]
    if (slow && (await napCancellable(state, Number(slow)))) {
      reply(id, { stopReason: 'cancelled' })
      return true
    }
    if (detail.includes('工作:审批')) {
      const outcome = await askPermission(sessionId, {
        toolCall: { toolCallId: 'w-' + taskId, title: '运行命令', kind: 'execute', rawInput: { command: 'echo ' + taskId } },
        options: [
          { optionId: 'allow_once', name: '允许', kind: 'allow_once' },
          { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' },
        ],
      })
      if (state.cancelled) {
        reply(id, { stopReason: 'cancelled' })
        return true
      }
      chunk(sessionId, 'approved:' + (outcome.outcome === 'cancelled' ? 'cancelled' : outcome.optionId) + '\n')
    }
    if (detail.includes('工作:报目录')) chunk(sessionId, 'cwd:' + (state.cwd ?? '?') + '\n')
    if (detail.includes('工作:报工具')) chunk(sessionId, 'tools:' + ((await mcpToolNames(state)) ?? []).join(',') + '\n')
    chunk(sessionId, (redo ? `redelivered:${taskId}:${redo}` : `delivered:${taskId}`) + (pre.length > 0 ? ' pre:' + pre.join(',') : '') + '\n')
    reply(id, { stopReason: 'end_turn' })
    return true
  }
  if (text.includes('[Ramet 带队·交叉审查]')) {
    const status = [...text.slice(text.lastIndexOf('[Ramet 带队·交叉审查]')).matchAll(/### 任务 (\S+)「.*?」· 负责人 .*? · (已交付|出错|没有执行|已取消|没有做完)/g)].map((m) => `${m[1]}=${m[2]}`)
    chunk(sessionId, 'review:' + status.join(';') + '\n')
    const back = text.slice(text.lastIndexOf('[Ramet 带队·交叉审查]')).match(/SENDBACK=(\S+?)x(\d+)/)
    if (back) {
      for (let i = 0; i < Number(back[2]); i++) {
        const res = await withMcp(state, (c) => c.callTool({ name: 'send_back', arguments: { taskId: back[1], feedback: '请改进第 ' + (i + 1) + ' 版' } }, undefined, { timeout: 120_000 }))
        const body = toolText(res ?? { content: [] })
        chunk(sessionId, (res?.isError ? 'sb-error:' : 'sb:') + body.replace(/\n/g, ' ') + '\n')
      }
    }
    if (text.includes('报工具')) chunk(sessionId, 'tools:' + ((await mcpToolNames(state)) ?? []).join(',') + '\n')
    // 目标里有 `审查等待<毫秒>`：审查完不马上收尾（认取消），测试趁这段时间拿这一轮的凭证直接打端点
    const hold = text.slice(text.lastIndexOf('[Ramet 带队·交叉审查]')).match(/审查等待(\d+)/)?.[1]
    if (hold && (await napCancellable(state, Number(hold)))) {
      reply(id, { stopReason: 'cancelled' })
      return true
    }
    reply(id, { stopReason: 'end_turn' })
    return true
  }
  return false
}

async function handlePrompt(id, { sessionId, prompt }) {
  const state = sessions.get(sessionId)
  if (!state) {
    // 真实 ACP agent 不认没 session/new 或 session/load 过的会话（omp 回 -32603 Unsupported ACP session）。
    // 假 agent 也照做，否则「中心跳过 load 直接 prompt」这类只在真 agent 上炸的 bug 测不出来。
    return send({
      jsonrpc: '2.0', id,
      error: { code: -32603, message: 'Internal error', data: { details: `Unsupported ACP session: ${sessionId}` } },
    })
  }
  state.cancelled = false // 新一轮 prompt 重置取消标记(取消只作用于在飞轮次)
  const text = prompt.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  if (await handleTeam(id, sessionId, state, text)) return
  if (text.includes('报工具')) {
    chunk(sessionId, 'tools:' + ((await mcpToolNames(state)) ?? []).join(',') + '\n')
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('失败')) {
    const once = text.includes('失败一次')
    if (!once || !failedOnce.has(text)) {
      failedOnce.add(text)
      return send({
        jsonrpc: '2.0', id,
        error: { code: -32603, message: 'Internal error', data: { details: '假 agent 按要求失败' } },
      })
    }
  }
  if (text.includes('随手读文件') || text.includes('随手写文件')) {
    const reading = text.includes('随手读文件')
    const path = text.match(/随手(?:读|写)文件:(\S+)/)?.[1] ?? ''
    const r = reading
      ? await clientCall('fs/read_text_file', { sessionId, path })
      : await clientCall('fs/write_text_file', { sessionId, path, content: 'written-by-agent' })
    const tag = reading ? 'read' : 'write'
    chunk(sessionId, r.error ? `${tag}-denied:` + (r.error.data?.details ?? r.error.message) + '\n' : reading ? 'read-ok:' + r.result.content + '\n' : 'write-ok\n')
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('随手终端')) {
    const r = await clientCall('terminal/create', { sessionId, ...NODE_CMD("console.log('x')") })
    chunk(sessionId, r.error ? 'term-denied:' + (r.error.data?.details ?? r.error.message) + '\n' : 'term-ok\n')
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('报图片')) {
    const imgs = prompt.filter((b) => b.type === 'image')
    chunk(sessionId, `images:${imgs.length}:${imgs.map((b) => b.mimeType).join(',')}\n`)
    return reply(id, { stopReason: 'end_turn' })
  }
  if (/表单提问|表单撤回|表单超时/.test(text) && !elicitForm) {
    chunk(sessionId, 'ask:unsupported\n')
    return reply(id, { stopReason: 'end_turn' })
  }
  const shape = text.match(/表单提问:([\w-]+)/)?.[1]
  if (shape && ASK_SHAPES[shape]) {
    const params = askParams(shape, sessionId)
    // 真 agent（claude / codex / opencode）先发 tool_call，提问挂在它上面
    if (params.toolCallId) tool(sessionId, { sessionUpdate: 'tool_call', toolCallId: params.toolCallId, title: params.message, kind: 'other', status: 'pending' })
    const r = await clientCall('elicitation/create', params)
    if (params.toolCallId) tool(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: params.toolCallId, status: 'completed' })
    chunk(sessionId, 'ask:' + (r.result?.action ?? 'error') + ':' + JSON.stringify(r.result?.content ?? null) + '\n')
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('表单撤回')) {
    const reqId = nextMsgId // clientCall 用的就是这个 id
    const pending = clientCall('elicitation/create', askParams('opencode', sessionId))
    await sleep(300)
    send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: reqId } })
    const r = await pending
    chunk(sessionId, 'ask-withdrawn:' + (r.result?.action ?? 'error') + '\n')
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('报表单超时')) {
    for (let i = 0; i < 100 && lateAsk === null; i++) await sleep(10)
    chunk(sessionId, 'ask-late:' + (lateAsk ?? 'pending') + '\n')
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('表单超时')) {
    void clientCall('elicitation/create', askParams('omp-select', sessionId)).then((r) => {
      lateAsk = r.result?.action ?? 'error'
    })
    chunk(sessionId, 'ask-timeout\n')
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('随手审批')) {
    const outcome = await askPermission(sessionId, {
      toolCall: { toolCallId: 'q1', title: '运行命令', kind: 'execute', rawInput: { command: 'rm -rf /tmp/x' } },
      options: [
        { optionId: 'allow_once', name: '允许', kind: 'allow_once' },
        { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' },
      ],
    })
    chunk(sessionId, 'perm:' + (outcome.outcome === 'cancelled' ? 'cancelled' : outcome.optionId) + '\n')
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('随手工具')) {
    tool(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'q-tool', title: '读文件', kind: 'read', status: 'in_progress' })
    const until = Date.now() + 3000
    while (Date.now() < until) {
      if (state.cancelled) return reply(id, { stopReason: 'cancelled' })
      await sleep(50)
    }
    chunk(sessionId, 'tool-ran\n')
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('随手慢')) {
    const until = Date.now() + 20000
    while (Date.now() < until) {
      if (state.cancelled) return reply(id, { stopReason: 'cancelled' })
      chunk(sessionId, 's')
      await sleep(100)
    }
    return reply(id, { stopReason: 'end_turn' })
  }
  if (['终端命令', '终端长命令', '终端越界', '终端截断', '终端环境'].some((k) => text.includes(k))) {
    const long = text.includes('终端长命令')
    const denied = text.includes('终端越界')
    const trunc = text.includes('终端截断')
    const envProbe = text.includes('终端环境')
    const cmd = long
      ? NODE_CMD("let i=0;setInterval(()=>console.log('tick '+(i++)),100);setTimeout(()=>{},60000)")
      : trunc
        ? NODE_CMD("console.log('x'.repeat(1000))")
        : envProbe
          ? NODE_CMD("console.log(Object.keys(process.env).filter(k=>/^RAMET_/i.test(k)).length)")
          : NODE_CMD("console.log('hello-term');console.error('err-line')")
    const created = await clientCall('terminal/create', {
      sessionId,
      ...cmd,
      ...(denied ? { cwd: '/' } : {}),
      ...(trunc ? { outputByteLimit: 100 } : {}),
    })
    if (created.error) {
      chunk(sessionId, 'term-denied:' + (created.error.data?.details ?? created.error.message) + '\n')
      return reply(id, { stopReason: 'end_turn' })
    }
    const terminalId = created.result.terminalId
    tool(sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 'term-1', title: '运行命令', kind: 'execute', status: 'in_progress',
      content: [{ type: 'terminal', terminalId }], rawInput: { command: 'node -e …' },
    })
    const exited = await clientCall('terminal/wait_for_exit', { sessionId, terminalId })
    const out = await clientCall('terminal/output', { sessionId, terminalId })
    tool(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'term-1', status: 'completed' })
    await clientCall('terminal/release', { sessionId, terminalId })
    const o = out.result?.output ?? ''
    if (long) chunk(sessionId, 'term-exit:' + exited.result?.exitCode + ':' + exited.result?.signal + '\n')
    else if (trunc) chunk(sessionId, 'term-trunc:' + out.result?.truncated + ':' + o.length + '\n')
    else if (envProbe) chunk(sessionId, 'env-ramet:' + o.trim() + '\n')
    else chunk(sessionId, 'term:' + exited.result?.exitCode + ':' + o.trim().split('\n').sort().join('|') + '\n')
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('退出计划')) {
    const outcome = await askPermission(sessionId, {
      toolCall: { toolCallId: 'plan-1', title: '退出计划模式', kind: 'switch_mode' },
      options: [
        { optionId: 'exit-plan-bypass', name: '跳过全部确认并开始', kind: 'allow_always' },
        { optionId: 'exit-plan-default', name: '逐步确认并开始', kind: 'allow_once' },
        { optionId: 'reject', name: '继续规划', kind: 'reject_once' },
      ],
    })
    if (state.cancelled || outcome.outcome === 'cancelled') return reply(id, { stopReason: 'cancelled' })
    const to = { 'exit-plan-bypass': 'bypassPermissions', 'exit-plan-default': 'default' }[outcome.optionId]
    if (to) setMode(sessionId, state, to)
    chunk(sessionId, 'plan-exit:' + outcome.optionId + '\n')
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('报后台审批')) {
    for (let i = 0; i < 100 && bgOutcome === null && bgAsked; i++) await sleep(10)
    chunk(sessionId, 'bg:' + (bgOutcome ?? 'pending') + '\n')
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('后台审批')) {
    // 不 await：这一轮立刻正常结束，审批还挂着（答复到达时只记下结果）
    bgAsked = true
    void askPermission(sessionId, {
      toolCall: { toolCallId: 'bg-1', title: '后台任务', kind: 'execute' },
      options: [
        { optionId: 'allow_once', name: '允许', kind: 'allow_once' },
        { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' },
      ],
    }).then((outcome) => {
      bgOutcome = outcome.outcome === 'cancelled' ? 'cancelled' : outcome.optionId
    })
    chunk(sessionId, 'bg-started\n')
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('报视图')) {
    state.turns = (state.turns ?? 0) + 1 // 轮次计数照常推进：它是「增量还是全文重放」的判据
    const lines = text.split('\n')
    chunk(sessionId, `view:${lines.filter((l) => l.startsWith('>> ')).length}:${lines.filter((l) => l.startsWith('> ')).length}@${sessionId}\n`)
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('需要权限')) {
    // 「审批改文件」带 diff + 路径（预览走 content / locations）；「审批无预览」只有标题；默认带命令（rawInput.command）
    const toolCall = text.includes('审批改文件')
      ? {
          toolCallId: 't1', title: '修改 src/app.ts', kind: 'edit',
          locations: [{ path: 'src/app.ts', line: 12 }],
          content: [{ type: 'diff', path: 'src/app.ts', oldText: 'const port = 3000', newText: 'const port = Number(process.env.PORT ?? 3000)' }],
        }
      : text.includes('审批无预览')
        ? { toolCallId: 't1', title: '写文件', kind: 'edit' }
        : { toolCallId: 't1', title: '运行命令', kind: 'execute', rawInput: { command: 'npm test -- --run', description: '跑一遍单元测试' } }
    const outcome = await askPermission(sessionId, {
      toolCall,
      options: [
        { optionId: 'allow_once', name: '允许', kind: 'allow_once' },
        { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' },
      ],
    })
    if (state.cancelled) return reply(id, { stopReason: 'cancelled' })
    chunk(sessionId, 'granted:' + (outcome.outcome === 'cancelled' ? 'cancelled' : outcome.optionId) + '\n')
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('计划验收')) {
    state.turns = (state.turns ?? 0) + 1
    tool(sessionId, {
      sessionUpdate: 'plan',
      entries: [
        { content: '读代码', priority: 'high', status: 'in_progress' },
        { content: '写测试', priority: 'medium', status: 'pending' },
      ],
    })
    await sleep(150)
    tool(sessionId, {
      sessionUpdate: 'plan',
      entries: [
        { content: '读代码', priority: 'high', status: 'completed' },
        { content: '写测试', priority: 'medium', status: 'in_progress' },
      ],
    })
    await sleep(150)
    chunk(sessionId, '计划好了')
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('三十步')) {
    // 先说一句，再连续 32 个工具调用（每个 pending → 完成），最后一段正文；每步间隔 150ms，取消在任何一步后都认
    state.turns = (state.turns ?? 0) + 1
    chunk(sessionId, '开始逐个检查。')
    for (let i = 1; i <= 32; i++) {
      if (state.cancelled) return reply(id, { stopReason: 'cancelled' })
      const toolCallId = `many-${i}`
      tool(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: `读取 file-${i}.ts`, kind: 'read', status: 'in_progress', locations: [{ path: `src/file-${i}.ts` }] })
      await sleep(150)
      tool(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' })
    }
    chunk(sessionId, '三十二个文件都检查完了，没有发现问题。\n')
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('用工具')) {
    // 两次调用:一次只有 tool_call(全量),一次只带 status 的 tool_call_update(增量),
    // 后者验合并(缺字段不能被默认值打回)。中间 sleep 留出"运行中接第二个 SSE 订阅"的窗口(订阅快照必须带已收集的步骤)
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
    // 慢速完整流程:思考 → 说一句 → 工具 → 思考 → 结构化的最后一段(实时 markdown / 换段 / 收回)
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
  if (text.includes('详情验收')) {
    // ACP 详情全形状:每步留出时间,cancel 在任何 sleep 后都认。
    // 形状都是 ACP v1 的合法负载(SDK zod 会剥掉未声明字段,所以只用声明过的字段 + _meta 兜未知)。
    const stopped = () => reply(id, { stopReason: 'cancelled' })
    const alive = async (ms) => {
      const until = Date.now() + ms
      while (Date.now() < until) {
        if (state.cancelled) return false
        await sleep(50)
      }
      return !state.cancelled
    }
    const say = async (s, every = 4, gap = 90) => {
      for (const piece of s.match(new RegExp(`[\\s\\S]{1,${every}}`, 'g'))) {
        if (state.cancelled) return false
        chunk(sessionId, piece)
        await sleep(gap)
      }
      return !state.cancelled
    }
    // 整段思考(保留完整文本)
    thought(sessionId, '先看 ReplyWriter 怎么落块,再确认 hash 收尾在哪条出口;最后补用量与 ACP 元数据的展示。')
    if (!(await alive(1200))) return stopped()
    // 中间正文(会被下一段顶成「说明」条目)
    if (!(await say('我先看代码结构。'))) return stopped()
    if (!(await alive(800))) return stopped()
    // 子代理正文/思考比它的父工具先到:靠 childBuf 攒着,工具出现时一并贴上
    childChunk(sessionId, 'dt-2', 'output', '子代理:正在核对 run-finalize 的两条出口。')
    childChunk(sessionId, 'dt-2', 'thought', '子代理:先看 finally 再下结论。')
    if (!(await alive(800))) return stopped()
    // tool_call:两次 locations + rawInput + provider _meta
    tool(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'dt-1',
      title: '读取 run-record.ts',
      kind: 'read',
      status: 'pending',
      locations: [
        { path: 'packages/server/src/agents/run-record.ts', line: 12 },
        { path: 'packages/shared/src/run-model.ts' },
      ],
      rawInput: { file_path: 'packages/server/src/agents/run-record.ts', offset: 0, limit: 200 },
      _meta: { provider: 'fake-acp', traceId: 'tr-detail-1' },
    })
    if (!(await alive(1600))) return stopped()
    // 只有 status 的 update:已有字段(标题/路径/rawInput)必须留着
    tool(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'dt-1', status: 'in_progress' })
    if (!(await alive(1600))) return stopped()
    // content(文字 + diff)+ rawOutput:原样保留,状态完成
    tool(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'dt-1',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: '共 240 行,收尾在 close()。' } },
        {
          type: 'diff',
          path: 'packages/server/src/agents/run-record.ts',
          oldText: 'const ms = this.elapsed()',
          newText: 'const ms = this.elapsed()\ncloseThought(this.state, ms)',
        },
      ],
      rawOutput: '{"lines":240,"hash":"deadbeef"}',
    })
    if (!(await alive(1000))) return stopped()
    // 子代理正文/思考(在 dt-1 已存在后到达;直接追加路径)
    childChunk(sessionId, 'dt-1', 'output', '子代理:已读完 run-record.ts,发现 close() 是唯一出口。')
    childChunk(sessionId, 'dt-1', 'thought', '子代理:要不要顺带看 run-finalize?')
    if (!(await alive(800))) return stopped()
    // 子代理工具:父工具 dt-2 此刻才出现(先到的正文被贴上);dt-child 是 dt-1 的子步骤
    tool(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'dt-2',
      title: '读取 run-finalize.ts',
      kind: 'read',
      status: 'in_progress',
      locations: [{ path: 'packages/server/src/agents/run-finalize.ts' }],
    })
    tool(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'dt-child',
      title: '查收尾出口',
      kind: 'search',
      status: 'in_progress',
      rawInput: { agent: 'scout', task: '搜索 run-finalize 收尾出口' },
      _meta: { claudeCode: { parentToolUseId: 'dt-1' } },
    })
    if (!(await alive(1200))) return stopped()
    // omp rawOutput progress activity + 两个子工具完成
    tool(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'dt-child',
      status: 'completed',
      rawOutput: { details: { progress: { currentTool: 'grep', currentToolIntent: '收尾出口' } } },
    })
    tool(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'dt-2', status: 'completed' })
    if (!(await alive(1600))) return stopped()
    // plan(整个列表替换)
    tool(sessionId, {
      sessionUpdate: 'plan',
      entries: [
        { content: '读 run-record.ts', priority: 'high', status: 'completed' },
        { content: '补详情测试', priority: 'medium', status: 'in_progress' },
      ],
    })
    if (!(await alive(800))) return stopped()
    // 当前模式
    tool(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: 'agent' })
    if (!(await alive(800))) return stopped()
    // 配置项更新(整套)
    tool(sessionId, {
      sessionUpdate: 'config_option_update',
      configOptions: [
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm2', options: [{ value: 'm2', name: 'M2' }] },
      ],
    })
    if (!(await alive(800))) return stopped()
    // 上下文占用 + 会话费用(累积值,非本轮)
    tool(sessionId, {
      sessionUpdate: 'usage_update',
      used: 51234,
      size: 200000,
      cost: { amount: 0.0123, currency: 'USD' },
      _meta: { source: 'fake-acp' },
    })
    if (!(await alive(800))) return stopped()
    // 最终一段(流式,含收尾换段判定)
    if (!(await say('## 结论\n\n收尾只有 `close()` 一条出口,详情字段按 ACP 原样保留,子代理输出与原回复分开。\n', 3, 70))) return stopped()
    return reply(id, {
      stopReason: 'end_turn',
      _meta: { session: 'fake-acp', turns: 3 },
      usage: {
        totalTokens: 20480,
        inputTokens: 15360,
        outputTokens: 2048,
        cachedReadTokens: 3072,
        cachedWriteTokens: 0,
        thoughtTokens: 1024,
      },
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
  if (text.includes('断线续')) {
    // 8 秒窗口给「关掉中心再拉起」留时间。睡眠里认取消，别把 after 吐出去。
    chunk(sessionId, 'before\n')
    const until = Date.now() + 8000
    while (Date.now() < until) {
      if (state.cancelled) return reply(id, { stopReason: 'cancelled' })
      await sleep(100)
    }
    if (state.cancelled) return reply(id, { stopReason: 'cancelled' })
    chunk(sessionId, 'after\n')
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('报 MCP')) {
    // session/new|load 收到的 mcpServers 回显：只回工具名、脚本名、中心地址与环境变量名
    // （回复会落进文档正文，那是别人能读到的地方，凭证值/日志不进去）
    const one = (state.mcp ?? [])[0]
    const env = one?.env ?? []
    const url = env.find((e) => e.name === 'RAMET_PAGE_URL')?.value ?? '?'
    chunk(sessionId, `mcp:${one?.name ?? 'none'} ${(one?.args?.[0] ?? '?').split('/').pop()} ${url} env:${env.map((e) => e.name).join(',')}\n`)
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('报 mcp 命令')) {
    // mcpServers 里的 command/args 原样回显：验「命令是执行端自己拼的」
    // （本地 agent 拿到的必须是中心进程的 process.execPath 与仓库里那份脚本；connector 拿到的必须是它自己的）
    const one = (state.mcp ?? [])[0]
    chunk(sessionId, `cmd:${one?.command ?? '?'} args:${(one?.args ?? []).join(',')}\n`)
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('回显提示词')) {
    // 提示词原样包进代码块（四个反引号，正文里的三引号围栏不会提前闭合）：落文档后逐字保留，测 agent 拿到的内容
    chunk(sessionId, '````\n' + text + '\n````\n')
    return reply(id, { stopReason: 'end_turn' })
  }
  if (text.includes('报引用')) {
    // 提示词里 resource 块的数量：被 @ 的页面正文不进 prompt
    chunk(sessionId, 'res:' + prompt.filter((b) => b.type === 'resource').length + '\n')
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
  if (method === undefined && callResponders.has(id)) {
    const resolve = callResponders.get(id)
    callResponders.delete(id)
    resolve({ result: msg.result, error: msg.error })
    return
  }
  if (method === undefined && permResponders.has(id)) {
    const resolve = permResponders.get(id)
    permResponders.delete(id)
    resolve(msg.result?.outcome ?? { outcome: 'cancelled' })
    return
  }
  if (method === 'initialize') {
    elicitForm = params?.clientCapabilities?.elicitation?.form != null
    return reply(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: process.env.FAKE_IMAGE === '1' } },
      agentInfo: { name: 'fake', title: 'Fake', version: '0.0.1' },
    })
  }
  if (method === 'session/new') {
    const sid = 'sess-' + ++sessionCount
    // cwd 记下来：含「报目录」的 prompt 会把它回显出来（工作区覆盖的端到端断言靠这条）
    // mcp 也记下来：「报 MCP」的 prompt 回显工具名与中心给的读页地址（read_page 交付靠这条）
    sessions.set(sid, { cancelled: false, cwd: params.cwd, mcp: params.mcpServers ?? [], configs: defaultConfigs() })
    reply(id, { sessionId: sid, configOptions: sessions.get(sid).configs })
    return announceCommands(sid)
  }
  if (method === 'session/load') {
    if (!sessions.has(params.sessionId)) sessions.set(params.sessionId, { cancelled: false, foreign: true, configs: defaultConfigs() })
    // 真实 agent 的 session/load 也要吃 mcpServers：这一轮给的工具以 load 时那份为准
    sessions.get(params.sessionId).mcp = params.mcpServers ?? []
    reply(id, { configOptions: sessions.get(params.sessionId).configs })
    return announceCommands(params.sessionId)
  }
  if (method === 'session/set_config_option') {
    const state = sessions.get(params.sessionId)
    if (!state || !state.configs) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown session or config not supported' } })
    const opt = state.configs.find((c) => c.id === params.configId)
    if (!opt) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown configId ${params.configId}` } })
    // FAKE_MODE_LOCKED：mode 改不动（应答照常，值不变）
    if (!(opt.id === 'mode' && process.env.FAKE_MODE_LOCKED === '1')) opt.currentValue = params.value?.type === 'id' ? params.value.value : String(params.value)
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: params.sessionId, update: { sessionUpdate: 'config_option_update', configOptions: state.configs } },
    })
    return reply(id, { configOptions: state.configs })
  }
  if (method === 'session/cancel') {
    const s = sessions.get(params?.sessionId)
    if (s) s.cancelled = true
    return
  }
  if (method === 'session/prompt') return void handlePrompt(id, params)
})
