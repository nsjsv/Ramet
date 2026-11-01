#!/usr/bin/env node
// 假 claude：伪装成 Claude Code 的可执行文件，供 Claude Agent SDK 用 pathToClaudeCodeExecutable 拉起（测试用）。
// SDK 对 .mjs 路径用 node 起它，参数形如：
//   --output-format stream-json --verbose --input-format stream-json [--model m] [--permission-prompt-tool stdio]
//   [--resume=<id>] [--session-id=<id>] [--fork-session] [--mcp-config <json>] [--permission-mode m]
//   [--allow-dangerously-skip-permissions] [--include-partial-messages] [--max-thinking-tokens n | --thinking adaptive|disabled]
//   [--effort e] [--setting-sources=…] [--allowedTools …] [--disallowedTools …] [--tools …] …
// stdin / stdout 各是一行一个 JSON（严格按 LF 分帧）：
//   SDK → CLI：control_request（initialize / interrupt / set_model / set_permission_mode / set_max_thinking_tokens /
//             stop_task / list_models；其余回 error）、control_response（答我们发的 can_use_tool / elicitation）、user（一轮的提示词）
//   CLI → SDK：control_response、control_request（can_use_tool / elicitation）、control_cancel_request（取消还没答的请求）、
//             以及一轮的 system / stream_event / assistant / user / result 消息（见 claude-turn.mjs）
// 行为（触发词）全在剧本 scenario.mjs 里，这里只管协议与会话。
// 会话持久化：与真 CLI 同一布局（搬会话的端口规则 drivers/claude/session-port.ts 对真假两边是同一份）——
//   <配置目录>/projects/<cwd 把非字母数字换成 -，超 200 字符截断加哈希>/<sessionId>.jsonl，每轮追加一行（轮数与提示词）；
//   配置目录 = CLAUDE_CONFIG_DIR，再缺省 FAKE_CLAUDE_HOME，再缺省系统临时目录下的 ramet-fake-claude。
//   --resume 只在当前 cwd 的项目目录里找（找不到 = 像真 CLI 一样报错退出），--session-id 撞上已有会话同样报错退出。
// 环境变量：FAKE_CLAUDE_VERSION = `--version` 报的版本（缺省 2.1.312）；FAKE_MODE = 缺省权限模式；FAKE_MODE_LOCKED=1 = set_permission_mode 应答成功但不生效；
//   FAKE_COMMAND = 斜杠命令名（缺省 fake-cmd，另带一条带参命令）。
// 协议层自己认的触发词：「进程崩溃」= 发完 init 就以退出码 3 退出（stderr 留一句），测宿主的崩溃处理。

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { claudeTurn } from './claude-turn.mjs'
import { commandList, newSession, runTurn } from './scenario.mjs'

const BOOLEAN_FLAGS = new Set([
  'verbose', 'include-partial-messages', 'strict-mcp-config', 'fork-session', 'allow-dangerously-skip-permissions',
  'continue', 'no-session-persistence', 'await-initialize', 'session-mirror', 'include-hook-events', 'debug', 'debug-to-stderr',
])

/** `--k=v`、`--k v`、布尔开关三种写法（SDK 对以 - 开头的值改用 `--k=v`） */
export function parseArgs(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq > 0) o[a.slice(2, eq)] = a.slice(eq + 1)
    else if (BOOLEAN_FLAGS.has(a.slice(2))) o[a.slice(2)] = true
    else o[a.slice(2)] = argv[++i] ?? ''
  }
  return o
}

function die(message) {
  process.stderr.write(message + '\n')
  process.exit(1)
}

if (process.argv.includes('--version')) {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? '2.1.312'} (Claude Code)\n`)
  process.exit(0)
}
const args = parseArgs(process.argv.slice(2))
if (args['input-format'] !== 'stream-json' || args['output-format'] !== 'stream-json') {
  die('fake claude only speaks --input-format stream-json --output-format stream-json')
}
const HOME = (process.env.CLAUDE_CONFIG_DIR || process.env.FAKE_CLAUDE_HOME || join(tmpdir(), 'ramet-fake-claude')).normalize('NFC')
const persist = !args['no-session-persistence']
/** 项目目录名：与 SDK 同一规则（非字母数字换成 -，超过 200 字符截断再接 cwd 的 32 位哈希） */
function projectDirName(cwd) {
  const flat = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (flat.length <= 200) return flat
  let h = 0
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0
  return `${flat.slice(0, 200)}-${Math.abs(h).toString(36)}`
}
const fileOf = (id) => join(HOME, 'projects', projectDirName(process.cwd()), `${id.replace(/[^\w-]/g, '_')}.jsonl`)
/** 记录：每轮一行 {turns, prompt}；读回来只要最后一行的轮数 */
function loadSaved(id) {
  if (!existsSync(fileOf(id))) return null
  const lines = readFileSync(fileOf(id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { turns: lines.at(-1)?.turns ?? 0 }
}

// ---------- 会话：新建（宿主可指定 id）/ 恢复 / 分叉 ----------
let saved = null
let sessionId
if (args.resume) {
  saved = loadSaved(args.resume)
  if (!saved) die(`No conversation found with session ID: ${args.resume}`)
  sessionId = args['fork-session'] ? (args['session-id'] || randomUUID()) : args.resume
} else {
  sessionId = args['session-id'] || randomUUID()
  if (persist && loadSaved(sessionId)) die(`Session ID ${sessionId} is already in use.`)
}
const initialMode = args['permission-mode'] ?? process.env.FAKE_MODE ?? 'default'
if (initialMode === 'bypassPermissions' && !args['allow-dangerously-skip-permissions']) {
  die('--permission-mode bypassPermissions requires --allow-dangerously-skip-permissions')
}

/** --mcp-config（JSON 串或文件路径）→ 剧本的统一形状 */
function mcpOf(raw) {
  if (!raw) return []
  const cfg = JSON.parse(raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf8'))
  return Object.entries(cfg.mcpServers ?? {}).map(([name, v]) => ({ name, command: v.command, args: v.args ?? [], env: v.env ?? {} }))
}

const s = newSession({ id: sessionId, cwd: process.cwd(), mcp: mcpOf(args['mcp-config']) })
s.turns = saved?.turns ?? 0
s.resumedFrom = args.resume ?? null
const config = (id) => s.configs.find((c) => c.id === id)
config('model').currentValue = args.model && args.model !== 'default' ? args.model : 'm1'
config('mode').currentValue = initialMode
config('thinking').currentValue = args.effort ?? args['max-thinking-tokens'] ?? args.thinking ?? 'adaptive'

const MODELS = [
  { value: 'm1', displayName: 'M1', description: '假模型一', supportsEffort: true, supportedEffortLevels: ['low', 'high'], supportsAdaptiveThinking: true },
  { value: 'm2', displayName: 'M2', description: '假模型二', supportsEffort: false },
]
const COMMANDS = commandList(process.env.FAKE_COMMAND ?? 'fake-cmd', true)
  .map((c) => ({ name: c.name, description: c.description, argumentHint: c.hint ?? '' }))
const TOOLS = ['Agent', 'AskUserQuestion', 'Bash', 'Edit', 'ExitPlanMode', 'Glob', 'Grep', 'Read', 'TodoWrite', 'Write']

// ---------- 输出与控制请求 ----------
function out(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}
const base = () => ({ uuid: randomUUID(), session_id: s.id })

let nextControl = 0
/** 我们发出、等宿主应答的控制请求：request_id → resolve */
const waiting = new Map()
function control(request) {
  const id = `fake-ctl-${++nextControl}`
  const { promise, resolve } = Promise.withResolvers()
  waiting.set(id, resolve)
  out({ type: 'control_request', request_id: id, request })
  return { id, done: promise }
}
/** 取消一条还没答的请求：通知宿主；settle = 立刻按「取消」（null）了结（中断一轮时用），否则仍等宿主的应答 */
function cancelControl(id, settle = true) {
  if (!waiting.has(id)) return
  out({ type: 'control_cancel_request', request_id: id })
  if (!settle) return
  waiting.get(id)(null)
  waiting.delete(id)
}

const tasks = new Set()
let costUSD = 0
let turn = null

function interrupt() {
  if (turn) s.cancelled = true
  for (const id of [...waiting.keys()]) cancelControl(id)
}

function onControl(request_id, req) {
  const ok = (response = {}, extra = {}) => out({ type: 'control_response', response: { subtype: 'success', request_id, response, ...extra } })
  const err = (error) => out({ type: 'control_response', response: { subtype: 'error', request_id, error } })
  switch (req.subtype) {
    case 'initialize':
      return ok(
        { commands: COMMANDS, agents: [], output_style: 'default', available_output_styles: ['default'], models: MODELS, account: { apiProvider: 'firstParty', tokenSource: 'none' } },
        { pending_permission_requests: [], pending_user_dialog_requests: [] },
      )
    case 'interrupt':
      interrupt()
      return ok({ still_queued: [] })
    case 'set_model':
      config('model').currentValue = req.model && req.model !== 'default' ? req.model : 'm1'
      return ok()
    case 'set_permission_mode':
      if (req.mode === 'bypassPermissions' && !args['allow-dangerously-skip-permissions']) {
        return err('Cannot set permission mode to bypassPermissions because the session was not launched with --allow-dangerously-skip-permissions')
      }
      if (process.env.FAKE_MODE_LOCKED !== '1') config('mode').currentValue = req.mode
      return ok()
    case 'apply_flag_settings':
      // 思考强度：effortLevel 为 null = 回到模型默认
      if (req.settings && 'effortLevel' in req.settings) config('thinking').currentValue = req.settings.effortLevel ?? 'adaptive'
      return ok()
    case 'set_max_thinking_tokens':
      config('thinking').currentValue = req.max_thinking_tokens == null ? 'adaptive' : String(req.max_thinking_tokens)
      return ok()
    case 'stop_task':
      if (!tasks.has(req.task_id)) return err(`No task found with ID: ${req.task_id}`)
      s.stoppedTasks.add(req.task_id)
      return ok()
    case 'list_models':
      return ok({ models: MODELS })
    default:
      return err(`Unsupported control request subtype: ${req.subtype}`)
  }
}

// ---------- 一轮 ----------
function blocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  // 引用页的正文是文字附件（`<context ref>` 文字块，驱动的写法）：剧本把它当 resource 数
  return (content ?? []).map((b) =>
    b.type === 'text' && b.text.startsWith('\n<context ref=') ? { type: 'resource' }
      : b.type === 'text' ? { type: 'text', text: b.text }
      : b.type === 'image' ? { type: 'image', mimeType: b.source?.media_type }
        : b.type === 'document' ? { type: 'resource' }
          : { type: b.type })
}

async function runOne(msg) {
  const blocks = blocksOf(msg.message?.content)
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  const started = Date.now()
  out({
    type: 'system', subtype: 'init', apiKeySource: 'none', claude_code_version: '2.1.312-fake', cwd: s.cwd, tools: TOOLS,
    mcp_servers: s.mcp.map((m) => ({ name: m.name, status: 'connected' })), model: config('model').currentValue,
    permissionMode: config('mode').currentValue, slash_commands: COMMANDS.map((c) => c.name), output_style: 'default',
    skills: [], plugins: [], capabilities: ['interrupt_receipt_v1'], ...base(),
  })
  if (text.includes('进程崩溃')) {
    // 协议层自己的行为（剧本不认）：CLI 半路死掉，测宿主把在飞的一轮收成出错、下一轮 resume 重起
    process.stderr.write('fake claude crashed on purpose\n')
    process.stdout.write('', () => process.exit(3))
    return
  }
  const host = {
    out, base, control, cancelControl, tasks,
    partial: !!args['include-partial-messages'],
    model: () => config('model').currentValue,
    mode: () => config('mode').currentValue,
  }
  turn = claudeTurn(host, s)
  turn.state('running')
  let r
  try {
    r = await runTurn(turn.io, s, text, blocks)
  } catch (e) {
    r = { error: e instanceof Error ? e.message : String(e) }
  }
  costUSD += 0.001
  turn.finish(r, { started, promptChars: text.length, costUSD })
  turn = null
  if (persist) {
    mkdirSync(dirname(fileOf(s.id)), { recursive: true })
    appendFileSync(fileOf(s.id), JSON.stringify({ type: 'turn', sessionId: s.id, cwd: s.cwd, turns: s.turns, prompt: text }) + '\n')
  }
}

// 真 CLI 在一轮进行中收到的新提示词排队，上一轮收尾后再跑
const queue = []
let pumping = false
let inputEnded = false
async function pump() {
  if (pumping) return
  pumping = true
  while (queue.length > 0) await runOne(queue.shift())
  pumping = false
  if (inputEnded) exit()
}
// 等 stdout 写完再退，免得最后几条消息丢在管道里
const exit = () => process.stdout.write('', () => process.exit(0))

function onLine(line) {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.type === 'control_request') return onControl(msg.request_id, msg.request ?? {})
  if (msg.type === 'control_response') {
    const res = msg.response ?? {}
    const resolve = waiting.get(res.request_id)
    if (!resolve) return
    waiting.delete(res.request_id)
    return resolve(res.subtype === 'success' ? { ok: res.response ?? {} } : { error: res.error ?? 'error' })
  }
  if (msg.type === 'user') {
    queue.push(msg)
    return void pump()
  }
}

// 严格按 LF 分帧：JSON 字符串里的 U+2028 / U+2029 不算换行
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
process.stdin.on('end', () => {
  if (buf) onLine(buf)
  inputEnded = true
  if (!pumping) exit()
})
process.stdout.on('error', () => process.exit(0))
