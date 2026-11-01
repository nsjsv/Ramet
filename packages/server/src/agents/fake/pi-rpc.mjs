#!/usr/bin/env node
// 假 pi / omp：伪装成 `pi --mode rpc` / `omp --mode rpc-ui`，说 pi 系的 JSONL RPC（测试用）。
// FAKE_PI_DIALECT=omp 切 omp 方言，否则是 pi。stdin / stdout 一行一个 JSON、严格按 LF 分帧：
//   命令 {id?, type, …} → 应答 {id, type:'response', command, success, data? | error}；会话事件不带 id；
//   扩展 UI 请求 {type:'extension_ui_request', id, method, …} 等 {type:'extension_ui_response', id, …}。
// 行为（触发词）全在剧本 scenario.mjs 里，一轮的编码在 pi-turn.mjs，这里只管进程、命令、会话与持久化。照实测的行为：
//   - 没有可用模型（FAKE_PI_NO_MODEL=1）时 prompt 当场失败，不进事件流
//   - --session <路径>：文件在就恢复（以记录首行的 cwd 为工作目录，那个目录不存在就报错退出），不在就静默新建；会话文件在第一轮收尾后才落盘
//   - -e <扩展>：真的 import 它，交给一个只实现 registerMcpServer 的桩（验证驱动扩展的契约）；--no-mcp 时注册得到 extension_error
//   - --no-tools：工具表为空（剧本照跑，只是 get_state 里看得出来）
//   - abort 的应答在这一轮收尾事件之后才回
//   - omp：启动先发 ready；negotiate_protocol 之后超过 FAKE_PI_MAX_FRAME（缺省 1 MiB）的帧拆成 rpc_chunk；
//     open_session {sessionDir}：目录里最新的记录在就恢复（记录的 cwd 与进程 cwd 不同则 cancelled:true），没有就新建；
//     审批模式取 --approval-mode / --yolo（缺省 FAKE_OMP_APPROVAL，再缺省 yolo）；只有 rpc-ui 模式才有 ask
// 会话持久化：FAKE_PI_HOME（缺省系统临时目录下的 ramet-fake-pi）。
// 环境变量：FAKE_PI_VERSION = `--version` 报的版本（pi 缺省 1.4.0、omp 缺省 18.14.1）；FAKE_COMMAND = 斜杠命令名（缺省 fake-cmd）；
//   FAKE_PI_MCP = 用户 mcp.json 里的服务（JSON，{名字: {command, args, env}}，同名时压过扩展注册的，同真 pi）。
// 协议层自己认的触发词：「进程崩溃」= agent_start 之后以退出码 3 退出；omp 的「报工具」= 回显宿主工具名 `tools:<a,b>`、
//   「调宿主工具:<名>」= 发一次 host_tool_call，回显 `host:<结果文字>`。

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { piTurn } from './pi-turn.mjs'
import { commandList, newSession, runTurn } from './scenario.mjs'

const DIALECT = process.env.FAKE_PI_DIALECT === 'omp' ? 'omp' : 'pi'
const OMP = DIALECT === 'omp'
const VERSION = process.env.FAKE_PI_VERSION ?? (OMP ? '18.14.1' : '1.4.0')
const argv = process.argv.slice(2)
if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write(OMP ? `omp/${VERSION}\n` : `${VERSION}\n`)
  process.exit(0)
}

// ---------- 启动参数 ----------
const flag = (name) => argv.includes(name)
const values = (...names) => argv.flatMap((a, i) => (names.includes(a) && argv[i + 1] !== undefined ? [argv[i + 1]] : []))
const value = (...names) => values(...names).at(-1)
const MODE = value('--mode')
if (MODE !== 'rpc' && MODE !== 'rpc-ui') {
  process.stderr.write(`fake ${DIALECT} only speaks --mode rpc / rpc-ui\n`)
  process.exit(2)
}
const HOME = process.env.FAKE_PI_HOME ?? join(tmpdir(), 'ramet-fake-pi')
const MAX_FRAME = Number(process.env.FAKE_PI_MAX_FRAME ?? 1048576)
const NO_MCP = flag('--no-mcp')
const NO_TOOLS = flag('--no-tools')
const approvalMode = flag('--yolo') || flag('--auto-approve') ? 'yolo' : value('--approval-mode') ?? process.env.FAKE_OMP_APPROVAL ?? 'yolo'

const MODELS = [
  { id: 'm1', name: 'M1', provider: 'fake', api: 'openai-completions', reasoning: true, input: ['text', 'image'], contextWindow: 200000, maxTokens: 16384 },
  { id: 'm2', name: 'M2', provider: 'fake', api: 'openai-completions', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 8192 },
]
const levelsOf = (m) => (m?.reasoning ? ['off', 'minimal', 'low', 'medium', 'high', ...(OMP ? ['xhigh'] : [])] : ['off'])
const findModel = (key) => MODELS.find((m) => `${m.provider}/${m.id}` === key || m.id === key)
const COMMANDS = commandList(process.env.FAKE_COMMAND ?? 'fake-cmd', true)

// ---------- 输出（omp 协商 v2 后超大帧分块） ----------
let v2 = false
let chunkSeq = 0
function out(frame) {
  const line = JSON.stringify(frame)
  const bytes = Buffer.from(line, 'utf8')
  if (!v2 || bytes.length + 1 <= MAX_FRAME) return void process.stdout.write(line + '\n')
  const size = Math.max(1, Math.floor(((MAX_FRAME - 200) * 3) / 4))
  const parts = []
  for (let i = 0; i < bytes.length; i += size) parts.push(bytes.subarray(i, i + size))
  const chunkId = `rpc-${++chunkSeq}`
  parts.forEach((p, index) => process.stdout.write(JSON.stringify({ type: 'rpc_chunk', chunkId, index, count: parts.length, byteLength: bytes.length, data: p.toString('base64') }) + '\n'))
}
const reply = (id, command, data) => out({ ...(id !== undefined ? { id } : {}), type: 'response', command, success: true, ...(data !== undefined ? { data } : {}) })
const fail = (id, command, error) => out({ ...(id !== undefined ? { id } : {}), type: 'response', command, success: false, error })

// ---------- 扩展 UI / 宿主工具的应答等待 ----------
let uiSeq = 0
const uiWaiting = new Map() // id → resolve
function ui(req) {
  const id = `ui-${++uiSeq}`
  const { promise, resolve: done } = Promise.withResolvers()
  uiWaiting.set(id, done)
  out({ type: 'extension_ui_request', id, ...req })
  return promise
}
/** 撤回所有在等的对话框（abort）：omp 通知宿主关掉，pi 不通知 */
function withdrawUi() {
  for (const [id, done] of [...uiWaiting]) {
    uiWaiting.delete(id)
    if (OMP) out({ type: 'extension_ui_request', id: `ui-${++uiSeq}`, method: 'cancel', targetId: id })
    done(null)
  }
}
let hostSeq = 0
const hostWaiting = new Map()
function hostCall(toolName, args) {
  const id = `host_${++hostSeq}`
  const { promise, resolve: done } = Promise.withResolvers()
  hostWaiting.set(id, done)
  out({ type: 'host_tool_call', id, toolCallId: `call_host_${hostSeq}`, toolName, arguments: args })
  return promise
}

// ---------- 扩展（-e）与 MCP ----------
async function loadExtensions() {
  const registered = new Map()
  const stub = new Proxy(
    { registerMcpServer: (name, cfg) => registered.set(name, cfg) },
    { get: (target, prop) => target[prop] ?? (() => undefined) },
  )
  for (const path of values('-e', '--extension')) {
    const mod = await import(pathToFileURL(resolve(path)).href)
    await mod.default?.(stub)
  }
  const user = JSON.parse(process.env.FAKE_PI_MCP ?? '{}')
  if (NO_MCP) {
    for (const name of registered.keys()) {
      out({ type: 'extension_error', extensionPath: values('-e', '--extension')[0] ?? '', event: 'register_mcp_server', error: `MCP server "${name}" is registered, but no loaded extension connects MCP servers` })
    }
    return []
  }
  // 同名时用户 mcp.json 的压过扩展注册的（真 pi 的规则）
  const merged = new Map([...registered, ...Object.entries(user)])
  return [...merged].filter(([, c]) => typeof c.command === 'string').map(([name, c]) => ({ name, command: c.command, args: c.args ?? [], env: c.env ?? {}, exposure: c.exposure }))
}

// ---------- 会话 ----------
const encodeCwd = (cwd) => `--${cwd.replace(/^\/+/, '').replace(/[/\\:]/g, '-')}--`
const defaultFile = (id) => join(HOME, 'sessions', encodeCwd(process.cwd()), `${new Date().toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`)

let mcp = []
let cur = null // { s, file, model, thinking, prompts }

function readSession(file) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { header: lines.find((l) => l.type === 'session'), turns: lines.filter((l) => l.type === 'turn') }
}

function openSession(file) {
  const exists = file && existsSync(file)
  const id = exists ? readSession(file).header.id : randomUUID()
  // pi 恢复的会话以记录里的 cwd 为准（同真 pi）；omp 在 open_session 里核对它与进程 cwd 一致
  const s = newSession({ id, cwd: (!OMP && exists && readSession(file).header?.cwd) || process.cwd(), mcp, configs: [] })
  const model = findModel(value('--model') ?? '') ?? MODELS[0]
  cur = { s, file: file ?? defaultFile(id), model, thinking: value('--thinking') ?? (model.reasoning ? 'medium' : 'off'), prompts: [] }
  if (exists) {
    const { turns } = readSession(file)
    const last = turns.at(-1)
    if (last) {
      cur.model = findModel(last.model) ?? cur.model
      cur.thinking = last.thinking ?? cur.thinking
    }
    s.turns = last?.turns ?? turns.length
    s.resumedFrom = id
    cur.prompts = turns.map((t) => t.text)
  }
  syncConfigs()
  return exists
}

function syncConfigs() {
  const s = cur.s
  s.model = `${cur.model.provider}/${cur.model.id}`
  s.configs = [{ id: 'model', currentValue: s.model }, { id: 'thinking', currentValue: cur.thinking }, ...(OMP ? [{ id: 'mode', currentValue: approvalMode }] : [])]
}

function persist(text) {
  mkdirSync(dirname(cur.file), { recursive: true })
  if (!existsSync(cur.file)) appendFileSync(cur.file, JSON.stringify({ type: 'session', version: 3, id: cur.s.id, cwd: cur.s.cwd }) + '\n')
  appendFileSync(cur.file, JSON.stringify({ type: 'turn', text, turns: cur.s.turns, model: cur.s.model, thinking: cur.thinking }) + '\n')
}

function stateData() {
  const ctx = cur.s.context
  return {
    model: cur.model, thinkingLevel: cur.thinking, isStreaming: !!running, isCompacting: false,
    steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time', sessionFile: cur.file, sessionId: cur.s.id,
    autoCompactionEnabled: true, messageCount: cur.prompts.length * 2, pendingMessageCount: 0,
    ...(OMP ? { isSettled: !running, hasPendingAsyncWork: false, queuedMessageCount: 0 } : {}),
    ...(ctx ? { contextUsage: { tokens: ctx.used, contextWindow: ctx.size, percent: (ctx.used / ctx.size) * 100 } } : {}),
    tools: NO_TOOLS ? [] : ['read', 'bash', 'edit', 'write', ...(OMP && MODE === 'rpc-ui' ? ['ask', 'task', 'todo'] : [])],
  }
}

// ---------- 一轮 ----------
let running = null // 在跑的一轮的 Promise
const askDialog = { enabled: false }
let subLevel = 'off'
let hostTools = []
const subagents = new Map()

function blocksOf(message, images) {
  return [{ type: 'text', text: message }, ...(images ?? []).map((img) => ({ type: 'image', mimeType: img.mimeType }))]
}

async function runOne(promptId, message, images) {
  const s = cur.s
  const blocks = blocksOf(message, images)
  const host = {
    out, dialect: DIALECT, promptId, turnOpen: true, ui, approvalMode, askDialog: askDialog.enabled && MODE === 'rpc-ui', subLevel, subagents,
  }
  out({ type: 'agent_start' })
  out({ type: 'turn_start' })
  const turn = piTurn(host, s)
  const user = { role: 'user', content: blocks.map((b) => (b.type === 'text' ? b : { type: 'image', data: '', mimeType: b.mimeType })), timestamp: Date.now() }
  out({ type: 'message_start', message: user })
  out({ type: 'message_end', message: user })
  if (message.includes('进程崩溃')) {
    process.stderr.write(`fake ${DIALECT} crashed on purpose\n`)
    process.stdout.write('', () => process.exit(3))
    return
  }
  let r
  try {
    s.cancelled = false
    if (OMP && message.includes('调宿主工具:')) {
      const name = message.match(/调宿主工具:(\S+)/)?.[1] ?? ''
      const res = await hostCall(name, { text: 'hello' })
      turn.io.say(`host:${res.isError ? 'error:' : ''}${(res.result?.content ?? []).map((c) => c.text ?? '').join('')}\n`)
      r = { stop: 'end_turn' }
    } else if (OMP && message.includes('报工具')) {
      turn.io.say(`tools:${hostTools.map((t) => t.name).join(',')}\n`)
      r = { stop: 'end_turn' }
    } else {
      r = await runTurn(turn.io, s, message, blocks)
    }
  } catch (e) {
    r = { error: e instanceof Error ? e.message : String(e) }
  }
  // 先落盘再报收尾：宿主收到收尾就可能杀掉进程（换实例恢复），真 pi 的会话记录是边跑边写的
  cur.prompts.push(message)
  persist(message)
  turn.finish(r, { promptChars: message.length })
}

function onPrompt(id, p) {
  if (process.env.FAKE_PI_NO_MODEL === '1') {
    return fail(id, 'prompt', 'No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key.')
  }
  // 真 pi 遇到在跑的回合要求 streamingBehavior；宿主应当串行，这里直接拒绝，免得宿主的错被掩盖
  if (running) return fail(id, 'prompt', 'Agent is already processing. Specify streamingBehavior to queue the message.')
  reply(id, 'prompt', OMP ? undefined : { disposition: 'started' })
  running = runOne(id, p.message ?? '', p.images).finally(() => {
    running = null
  })
}

async function onAbort(id) {
  if (running) {
    cur.s.cancelled = true
    withdrawUi()
    for (const w of [...hostWaiting.values()]) w({ result: { content: [{ type: 'text', text: 'aborted' }] }, isError: true })
    hostWaiting.clear()
    await running
  }
  reply(id, 'abort')
}

// ---------- 命令 ----------
function onCommand(id, type, p) {
  switch (type) {
    case 'prompt': return onPrompt(id, p)
    case 'abort': return void onAbort(id)
    case 'get_state': return reply(id, type, stateData())
    case 'get_messages': return reply(id, type, { messages: cur.prompts.map((text) => ({ role: 'user', content: [{ type: 'text', text }] })) })
    case 'get_available_models': return reply(id, type, { models: MODELS })
    case 'get_available_thinking_levels': return reply(id, type, { levels: levelsOf(cur.model) })
    case 'set_model': {
      const m = findModel(`${p.provider}/${p.modelId}`)
      if (!m) return fail(id, type, `Model not found: ${p.provider}/${p.modelId}`)
      cur.model = m
      if (!levelsOf(m).includes(cur.thinking)) {
        cur.thinking = 'off'
        out({ type: 'thinking_level_changed', level: 'off' })
      }
      syncConfigs()
      return reply(id, type, m)
    }
    case 'set_thinking_level': {
      // 真 pi 把超出模型能力的档位夹到能力范围内
      const levels = levelsOf(cur.model)
      cur.thinking = levels.includes(p.level) ? p.level : levels.at(-1)
      syncConfigs()
      out({ type: 'thinking_level_changed', level: cur.thinking })
      return reply(id, type)
    }
    case 'get_session_stats': {
      const u = cur.s.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      const ctx = cur.s.context
      return reply(id, type, {
        sessionFile: cur.file, sessionId: cur.s.id, userMessages: cur.prompts.length, assistantMessages: cur.prompts.length,
        tokens: { ...u, total: u.input + u.output + u.cacheRead + u.cacheWrite }, cost: 0,
        ...(ctx ? { contextUsage: { tokens: ctx.used, contextWindow: ctx.size, percent: (ctx.used / ctx.size) * 100 } } : {}),
      })
    }
    case 'set_session_name': return reply(id, type)
    case 'new_session':
      openSession(undefined)
      return reply(id, type, { cancelled: false })
    case 'switch_session':
      openSession(p.sessionPath)
      return reply(id, type, { cancelled: false })
  }
  if (!OMP) {
    if (type === 'get_commands') {
      return reply(id, type, { commands: COMMANDS.map((c) => ({ name: c.name, description: c.description, source: 'prompt', sourceInfo: { path: join(HOME, 'prompts', `${c.name}.md`), source: 'local', scope: 'user', origin: 'top-level' } })) })
    }
    return fail(id, type, `Unknown command: ${type}`)
  }
  switch (type) {
    case 'negotiate_protocol':
      if (p.protocolVersion !== 2) return fail(id, type, 'Unsupported protocol version')
      reply(id, type, { protocolVersion: 2 })
      v2 = true
      return
    case 'get_available_commands': return reply(id, type, { commands: ompCommands() })
    case 'set_ask_dialog':
      askDialog.enabled = p.enabled === true
      return reply(id, type, { enabled: askDialog.enabled })
    case 'set_subagent_subscription':
      subLevel = p.level
      return reply(id, type, { level: subLevel })
    case 'get_subagents':
      return reply(id, type, { subagents: [...subagents].map(([sid, e]) => ({ id: sid, agent: 'task', status: e.status, task: e.task, parentToolCallId: e.toolId })) })
    case 'cancel_subagent': {
      const e = subagents.get(p.subagentId)
      if (!e || e.status !== 'running') return reply(id, type, { cancelled: false })
      cur.s.stoppedTasks.add(e.taskId)
      e.status = 'aborted'
      return reply(id, type, { cancelled: true })
    }
    case 'set_host_tools':
      hostTools = p.tools ?? []
      return reply(id, type, { toolNames: hostTools.map((t) => t.name) })
    case 'open_session': return onOpenSession(id, p)
  }
  return fail(id, type, `Unknown command: ${type}`)
}

const ompCommands = () => COMMANDS.map((c) => ({ name: c.name, description: c.description, source: 'custom', ...(c.hint ? { input: { hint: c.hint } } : {}) }))

function onOpenSession(id, p) {
  const dir = p.sessionDir
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort() : []
  const newest = files.at(-1)
  if (newest) {
    const file = join(dir, newest)
    // 记录里的 cwd 与进程 cwd 不同：真 omp 不报错，回 cancelled:true，当前会话不变
    if (readSession(file).header.cwd !== process.cwd()) {
      return reply(id, 'open_session', { cancelled: true, resumed: false, sessionId: cur.s.id, sessionFile: cur.file })
    }
    openSession(file)
    return reply(id, 'open_session', { cancelled: false, resumed: true, sessionId: cur.s.id, sessionFile: cur.file })
  }
  const sid = randomUUID()
  openSession(join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${sid}.jsonl`))
  return reply(id, 'open_session', { cancelled: false, resumed: false, sessionId: cur.s.id, sessionFile: cur.file })
}

function onLine(line) {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch (e) {
    return fail(undefined, 'parse', `Failed to parse command: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (msg.type === 'extension_ui_response') {
    const done = uiWaiting.get(msg.id)
    if (!done) return // 已撤回 / 未知：真 CLI 也是忽略
    uiWaiting.delete(msg.id)
    const { type: _t, id: _i, ...answer } = msg
    return done(answer)
  }
  if (msg.type === 'host_tool_result') {
    const done = hostWaiting.get(msg.id)
    if (!done) return
    hostWaiting.delete(msg.id)
    return done({ result: msg.result, isError: msg.isError === true })
  }
  if (msg.type === 'host_tool_update') return
  const { id, type, ...params } = msg
  onCommand(id, type, params)
}

// ---------- 启动 ----------
if (OMP) out({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: MAX_FRAME, maxReassembledFrameBytes: 67108864 })
mcp = await loadExtensions()
// 真 pi（SessionManager.open）拿记录首行的 cwd 当运行时的工作目录；那个目录不存在时 rpc 模式直接报错退出
const sessionArg = value('--session')
if (!OMP && sessionArg && existsSync(sessionArg)) {
  const headerCwd = readSession(sessionArg).header?.cwd
  if (headerCwd && !existsSync(headerCwd)) {
    process.stderr.write(`Session working directory does not exist: ${headerCwd}\n`)
    process.exit(1)
  }
}
openSession(sessionArg)
if (OMP) out({ type: 'available_commands_update', commands: ompCommands() })

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    onLine(line)
  }
})
// stdin 关了（宿主退出 / kill）：等 stdout 写完再退
process.stdin.on('end', () => {
  if (buf) onLine(buf)
  process.stdout.write('', () => process.exit(0))
})
process.stdout.on('error', () => process.exit(0))
