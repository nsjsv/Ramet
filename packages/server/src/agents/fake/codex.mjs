#!/usr/bin/env node
// 假 codex：伪装成 codex 可执行文件，说 `codex app-server` 的 stdio JSON-RPC（测试用）。
// 只认 `app-server` 子命令（其余参数如 `-c k=v` 忽略）与 `--version`。stdin / stdout 一行一个 JSON、严格按 LF 分帧、
// 不带 "jsonrpc" 字段（与真 app-server 一致）：
//   客户端 → 我们：initialize / thread/start|resume|read|unsubscribe / turn/start|interrupt / model/list / config/read；
//                 以及对我们发出的服务端请求的应答
//   我们 → 客户端：应答、通知（形状见 codex-turn.mjs）、服务端请求（审批 / 提问 / 表单）
// 行为（触发词）全在剧本 scenario.mjs 里，这里只管协议、线程与持久化。照真 app-server 实测的行为：
//   - thread/start|resume 的 config.mcp_servers 只对该线程生效，与用户配置深合并（{enabled:false} 关掉用户的某个服务）
//   - 线程已加载且还有订阅时 resume 只是重新挂上、忽略 config；unsubscribe 之后再 resume 才按新 config 重新加载
//   - 没有任何轮次的线程不落盘：换进程 resume 报 -32600 no rollout found；thread/resume 的 path 要求 experimentalApi
//   - turn 级覆盖（model / effort / approvalPolicy / sandboxPolicy）对之后的回合持续生效
//   - turn/interrupt 撤回该回合还没答的服务端请求（serverRequest/resolved）；对子代理线程 interrupt = 只停这个子代理
// 会话持久化：与真 codex 同一布局（搬会话的端口规则 drivers/codex/session-port.ts 对真假两边是同一份）——
//   <CODEX_HOME，缺省 FAKE_CODEX_HOME，再缺省系统临时目录下的 ramet-fake-codex>/sessions/YYYY/MM/DD/rollout-<时间>-<threadId>.jsonl，
//   第一个回合开始时落盘、每轮收尾追加一行；resume 按 threadId 在 sessions/ 下找。thread/resume {path} 按那个文件恢复，之后的回合也追加在它上面。
// 环境变量：FAKE_CODEX_VERSION = `--version` 报的版本（缺省 0.159.3）；FAKE_CODEX_CONFIG = 用户 config.toml 的 JSON 形状
//   （model / approval_policy / sandbox_mode / model_reasoning_effort / mcp_servers），config/read 原样返回并作为线程缺省值；
//   FAKE_LOAD_FAIL=1 = 没加载着的线程一律 resume 不上（会话记录没了：测宿主降级为新建会话 + 全文重放）。
// 协议层自己认的触发词：「进程崩溃」= turn/started 之后以退出码 3 退出（stderr 留一句），测宿主的崩溃处理。

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { codexTurn } from './codex-turn.mjs'
import { newSession, runTurn } from './scenario.mjs'

const VERSION = process.env.FAKE_CODEX_VERSION ?? '0.159.3'
if (process.argv.includes('--version')) {
  process.stdout.write(`codex-cli ${VERSION}\n`)
  process.exit(0)
}
if (!process.argv.slice(2).includes('app-server')) {
  process.stderr.write('fake codex only speaks `codex app-server`\n')
  process.exit(2)
}

const HOME = process.env.CODEX_HOME || process.env.FAKE_CODEX_HOME || join(tmpdir(), 'ramet-fake-codex')
const USER_CONFIG = JSON.parse(process.env.FAKE_CODEX_CONFIG ?? '{}')
const MODELS = [
  {
    id: 'm1', model: 'm1', displayName: 'M1', description: '假模型一', hidden: false, isDefault: true, inputModalities: ['text', 'image'],
    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '快' }, { reasoningEffort: 'high', description: '深' }], defaultReasoningEffort: 'low',
  },
  {
    id: 'm2', model: 'm2', displayName: 'M2', description: '假模型二', hidden: false, isDefault: false, inputModalities: ['text'],
    supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '中' }], defaultReasoningEffort: 'medium',
  },
]

// ---------- 输出 ----------
const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const reply = (id, result) => out({ id, result })
const fail = (id, code, message) => out({ id, error: { code, message } })
const note = (method, params) => out({ method, params, emittedAtMs: Date.now() })

let nextRequestId = 0
/** 我们发出、等客户端应答的服务端请求：id → { resolve, threadId, turnId } */
const waiting = new Map()
function request(method, params) {
  const id = nextRequestId++
  const { promise, resolve } = Promise.withResolvers()
  waiting.set(id, { resolve, threadId: params.threadId, turnId: params.turnId })
  out({ id, method, params })
  return { id, done: promise }
}
/** 撤回一条还没答的请求（回合被中断 / MCP 服务自己取消）：通知客户端，按 null 了结 */
function withdraw(id) {
  const w = waiting.get(id)
  if (!w) return
  waiting.delete(id)
  note('serverRequest/resolved', { threadId: w.threadId, requestId: id })
  w.resolve(null)
}

// ---------- 线程 ----------
let initialized = false
let experimental = false
/** 已加载的线程：id → { id, s, settings, subscribed, turn, usage, prompts } */
const threads = new Map()
/** 子代理线程：id → { parent, taskId, turnId, done } */
const children = new Map()

/** 按 threadId 找已有的 rollout（sessions/ 下任意深度）；没有 = null */
function findRollout(id, dir = join(HOME, 'sessions')) {
  if (!existsSync(dir)) return null
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const hit = findRollout(id, p)
      if (hit) return hit
    } else if (e.name.startsWith('rollout-') && e.name.endsWith(`-${id}.jsonl`)) return p
  }
  return null
}
/** 新线程第一次落盘的位置（真 codex 的日期目录 + 带时间的文件名） */
function newRolloutPath(id) {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = d.toISOString().slice(0, 19).replace(/:/g, '-')
  return join(HOME, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()), `rollout-${stamp}-${id.replace(/[^\w-]/g, '_')}.jsonl`)
}
/** 线程的记录文件：按文件恢复的就是那个文件，否则已有的 rollout，再否则新位置 */
const rolloutOf = (id) => threads.get(id)?.file ?? findRollout(id) ?? newRolloutPath(id)
const policyName = (p) => (typeof p === 'string' ? p : 'granular')
const SANDBOX_OF_POLICY = { dangerFullAccess: 'danger-full-access', readOnly: 'read-only', workspaceWrite: 'workspace-write', externalSandbox: 'workspace-write' }
const sandboxPolicy = (mode) =>
  mode === 'danger-full-access' ? { type: 'dangerFullAccess' }
    : mode === 'read-only' ? { type: 'readOnly', networkAccess: false }
      : { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }

function defaults() {
  return {
    model: USER_CONFIG.model ?? 'm1',
    effort: USER_CONFIG.model_reasoning_effort ?? null,
    approvalPolicy: USER_CONFIG.approval_policy ?? 'on-request',
    sandbox: USER_CONFIG.sandbox_mode ?? 'workspace-write',
  }
}

/** 线程设置 → 剧本读的 configs（「审批模式」与缺省回复回显它们） */
function syncConfigs(t) {
  const model = MODELS.find((m) => m.id === t.settings.model)
  t.s.configs = [
    { id: 'model', currentValue: t.settings.model },
    { id: 'thinking', currentValue: t.settings.effort ?? model?.defaultReasoningEffort ?? 'default' },
    { id: 'mode', currentValue: `${policyName(t.settings.approvalPolicy)}/${t.settings.sandbox}` },
  ]
}

/** 线程的 config.mcp_servers 深合并进用户配置 → 剧本的统一形状（线程给的排前面，enabled:false 的去掉） */
function mcpOf(config) {
  const user = USER_CONFIG.mcp_servers ?? {}
  const mine = config?.mcp_servers ?? {}
  const names = [...Object.keys(mine), ...Object.keys(user).filter((n) => !(n in mine))]
  return names
    .map((name) => ({ name, ...(user[name] ?? {}), ...(mine[name] ?? {}) }))
    .filter((m) => m.enabled !== false && typeof m.command === 'string')
    .map((m) => ({ name: m.name, command: m.command, args: m.args ?? [], env: m.env ?? {} }))
}

function applyOverrides(t, p) {
  if (p.model) t.settings.model = p.model
  if (p.effort !== undefined && p.effort !== null) t.settings.effort = p.effort
  if (p.approvalPolicy) t.settings.approvalPolicy = p.approvalPolicy
  if (p.sandbox) t.settings.sandbox = p.sandbox
  if (p.sandboxPolicy) t.settings.sandbox = SANDBOX_OF_POLICY[p.sandboxPolicy.type] ?? t.settings.sandbox
  syncConfigs(t)
}

function threadObj(id, { cwd, settings, parentThreadId = null, status = 'idle', turns = [] } = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    id, sessionId: id, parentThreadId, forkedFromId: null, preview: '', ephemeral: false, historyMode: 'paginated',
    modelProvider: 'openai', model: settings?.model ?? null, reasoningEffort: settings?.effort ?? null,
    createdAt: now, updatedAt: now, status: { type: status }, path: rolloutOf(id), cwd: cwd ?? process.cwd(),
    cliVersion: VERSION, originator: 'ramet', source: parentThreadId ? 'subAgent' : 'vscode', agentNickname: null, agentRole: null,
    gitInfo: null, name: null, turns,
  }
}

function openResponse(t) {
  return {
    thread: threadObj(t.id, { cwd: t.s.cwd, settings: t.settings }),
    model: t.settings.model, modelProvider: 'openai', serviceTier: null, cwd: t.s.cwd, runtimeWorkspaceRoots: [t.s.cwd],
    instructionSources: [], approvalPolicy: t.settings.approvalPolicy, approvalsReviewer: 'user', sandbox: sandboxPolicy(t.settings.sandbox),
    activePermissionProfile: null, reasoningEffort: t.settings.effort,
  }
}

function announceMcp(t) {
  for (const m of t.s.mcp) note('mcpServer/startupStatus/updated', { threadId: t.id, name: m.name, status: 'starting', error: null, failureReason: null })
  for (const m of t.s.mcp) note('mcpServer/startupStatus/updated', { threadId: t.id, name: m.name, status: 'ready', error: null, failureReason: null })
}

function readRollout(file) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const meta = lines.find((l) => l.type === 'meta')
  const turns = lines.filter((l) => l.type === 'turn')
  return { meta, turns }
}

/** 记录文件在第一个回合开始时建出来（真 codex 边跑边写：回合中途进程死了，记录也已经在盘上，下次能 resume） */
function ensureRollout(t) {
  if (existsSync(t.file)) return
  mkdirSync(dirname(t.file), { recursive: true })
  appendFileSync(t.file, JSON.stringify({ type: 'meta', id: t.id, cwd: t.s.cwd }) + '\n')
}

function persist(t, text) {
  ensureRollout(t)
  appendFileSync(t.file, JSON.stringify({ type: 'turn', text, settings: t.settings, turns: t.s.turns }) + '\n')
}

function startThread(id, p) {
  const t = { id, s: null, settings: defaults(), subscribed: true, turn: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thought: 0 }, prompts: [] }
  // 记录文件在线程打开时就定下（按文件恢复的由调用方改成那个文件），之后的回合都追加在它上面
  t.file = findRollout(id) ?? newRolloutPath(id)
  t.s = newSession({ id, cwd: p.cwd ?? process.cwd(), mcp: mcpOf(p.config), configs: [] })
  // 空的 environments = 不给这个线程环境访问（受限会话用），剧本里读写文件 / 终端本来就不支持
  t.s.noEnv = Array.isArray(p.environments) && p.environments.length === 0
  applyOverrides(t, p)
  threads.set(id, t)
  return t
}

function onThreadStart(id, p) {
  const t = startThread(randomUUID(), p)
  reply(id, openResponse(t))
  note('thread/started', { thread: threadObj(t.id, { cwd: t.s.cwd, settings: t.settings }) })
  announceMcp(t)
}

function onThreadResume(id, p) {
  const path = p.path || ''
  if (path && !experimental) return fail(id, -32600, 'thread/resume.path requires experimentalApi capability')
  let t = path ? null : threads.get(p.threadId)
  if (t?.subscribed) {
    // 已加载且有订阅：只是重新挂上，config 覆盖不生效
    return reply(id, openResponse(t))
  }
  if (t) {
    note('thread/status/changed', { threadId: t.id, status: { type: 'notLoaded' } })
    threads.delete(t.id)
  }
  const file = path || findRollout(p.threadId)
  if (!file || !existsSync(file) || process.env.FAKE_LOAD_FAIL === '1') return fail(id, -32600, `no rollout found for thread id ${p.threadId}`)
  const { meta, turns } = readRollout(file)
  t = startThread(meta.id, { ...p, cwd: p.cwd ?? meta.cwd })
  t.file = file
  const last = turns.at(-1)?.settings
  if (last) {
    t.settings = { ...last }
    applyOverrides(t, p)
  }
  // 剧本自己数轮次（只有部分触发词推进它）：照它记下的数恢复
  t.s.turns = turns.at(-1)?.turns ?? turns.length
  t.s.resumedFrom = meta.id
  t.prompts = turns.map((x) => x.text)
  note('thread/status/changed', { threadId: t.id, status: { type: 'idle' } })
  reply(id, openResponse(t))
  announceMcp(t)
}

function onThreadRead(id, p) {
  const t = threads.get(p.threadId)
  const file = t?.file ?? findRollout(p.threadId)
  if (!t && !file) return fail(id, -32600, `no rollout found for thread id ${p.threadId}`)
  const prompts = t ? t.prompts : readRollout(file).turns.map((x) => x.text)
  const turns = p.includeTurns
    ? prompts.map((text, i) => ({
        id: `turn-${i + 1}`, status: 'completed', error: null, startedAt: null, completedAt: null, durationMs: null,
        items: [{ type: 'userMessage', id: `user-${i + 1}`, content: [{ type: 'text', text, text_elements: [] }] }],
      }))
    : []
  const meta = t ? { cwd: t.s.cwd, settings: t.settings } : { cwd: readRollout(file).meta.cwd }
  reply(id, { thread: threadObj(p.threadId, { ...meta, status: t ? (t.turn ? 'active' : 'idle') : 'notLoaded', turns }) })
}

// ---------- 一轮 ----------
const mimeOfPath = (path) => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' })[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'

function blocksOf(input) {
  // 引用页的正文是文字附件（`<context ref>` 文字块，驱动的写法）：剧本把它当 resource 数
  return (input ?? []).map((b) =>
    b.type === 'text' && b.text.startsWith('\n<context ref=') ? { type: 'resource' }
      : b.type === 'text' ? { type: 'text', text: b.text }
        : b.type === 'image' ? { type: 'image', mimeType: /^data:([^;,]+)/.exec(b.url ?? '')?.[1] ?? 'image/*' }
          : b.type === 'localImage' ? { type: 'image', mimeType: mimeOfPath(b.path ?? '') }
            : { type: b.type })
}

let turnSeq = 0
const host = (t) => ({
  note, request, withdraw, experimental,
  spawnChild: () => {
    const threadId = randomUUID()
    const turnId = `turn-${++turnSeq}`
    children.set(threadId, { parent: t, taskId: null, turnId, done: false })
    return { threadId, turnId }
  },
  bindTask: (childId, taskId) => {
    const c = children.get(childId)
    if (c) c.taskId = taskId
  },
  endChild: (childId) => {
    const c = children.get(childId)
    if (c) c.done = true
  },
  threadObj: (childId, parentThreadId) => threadObj(childId, { cwd: t.s.cwd, settings: t.settings, parentThreadId, status: 'active' }),
})

async function runOne(t, turnId, input) {
  const blocks = blocksOf(input)
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  note('turn/started', { threadId: t.id, turn: { id: turnId, items: [], status: 'inProgress', error: null, startedAt: Date.now(), completedAt: null, durationMs: null } })
  note('thread/status/changed', { threadId: t.id, status: { type: 'active', activeFlags: [] } })
  ensureRollout(t)
  const user = { type: 'userMessage', id: `user-${turnId}`, content: input }
  note('item/started', { threadId: t.id, turnId, item: user, startedAtMs: Date.now() })
  note('item/completed', { threadId: t.id, turnId, item: user, completedAtMs: Date.now() })
  if (text.includes('进程崩溃')) {
    // 协议层自己的行为（剧本不认）：app-server 半路死掉，测宿主把在飞的一轮收成出错、进程重起后 resume
    process.stderr.write('fake codex crashed on purpose\n')
    process.stdout.write('', () => process.exit(3))
    return
  }
  const turn = codexTurn(host(t), t, turnId)
  let r
  try {
    r = await runTurn(turn.io, t.s, text, blocks)
  } catch (e) {
    r = { error: e instanceof Error ? e.message : String(e) }
  }
  // 先落盘再报收尾：宿主收到 turn/completed 就可能杀掉进程（换实例 resume），真 codex 的会话记录是边跑边写的
  t.prompts.push(text)
  persist(t, text)
  turn.finish(r, { promptChars: text.length })
  t.turn = null
  note('thread/status/changed', { threadId: t.id, status: { type: 'idle' } })
}

function onTurnStart(id, p) {
  const t = threads.get(p.threadId)
  if (!t) return fail(id, -32600, `thread not found: ${p.threadId}`)
  // 真 app-server 遇到在跑的回合会把新输入并进去；宿主应当串行发送，这里直接拒绝，免得宿主的错被掩盖
  if (t.turn) return fail(id, -32600, `thread ${p.threadId} already has an active turn`)
  applyOverrides(t, p)
  const turnId = `turn-${++turnSeq}`
  t.turn = { id: turnId }
  reply(id, { turn: { id: turnId, items: [], status: 'inProgress', error: null, startedAt: Date.now(), completedAt: null, durationMs: null } })
  void runOne(t, turnId, p.input)
}

function onTurnInterrupt(id, p) {
  const child = children.get(p.threadId)
  if (child) {
    if (child.done || child.turnId !== p.turnId) return fail(id, -32600, `no active turn ${p.turnId} on thread ${p.threadId}`)
    if (child.taskId) child.parent.s.stoppedTasks.add(child.taskId)
    return reply(id, {})
  }
  const t = threads.get(p.threadId)
  if (!t?.turn || t.turn.id !== p.turnId) return fail(id, -32600, `no active turn ${p.turnId} on thread ${p.threadId}`)
  t.s.cancelled = true
  for (const [reqId, w] of [...waiting]) if (w.threadId === t.id && w.turnId === p.turnId) withdraw(reqId)
  reply(id, {})
}

function onRequest(id, method, p) {
  if (method === 'initialize') {
    if (initialized) return fail(id, -32600, 'Already initialized')
    initialized = true
    experimental = p?.capabilities?.experimentalApi === true
    return reply(id, { userAgent: `ramet/${VERSION} (fake)`, codexHome: HOME, platformFamily: 'unix', platformOs: process.platform })
  }
  if (!initialized) return fail(id, -32600, 'Not initialized')
  switch (method) {
    case 'thread/start': return onThreadStart(id, p ?? {})
    case 'thread/resume': return onThreadResume(id, p ?? {})
    case 'thread/read': return onThreadRead(id, p ?? {})
    case 'thread/unsubscribe': {
      const t = threads.get(p?.threadId)
      if (!t) return reply(id, { status: 'notLoaded' })
      if (!t.subscribed) return reply(id, { status: 'notSubscribed' })
      t.subscribed = false
      return reply(id, { status: 'unsubscribed' })
    }
    case 'turn/start': return onTurnStart(id, p ?? {})
    case 'turn/interrupt': return onTurnInterrupt(id, p ?? {})
    case 'model/list': return reply(id, { data: MODELS, nextCursor: null })
    case 'config/read':
      return reply(id, {
        config: { model: null, approval_policy: null, sandbox_mode: null, model_reasoning_effort: null, mcp_servers: {}, ...USER_CONFIG },
        origins: {}, layers: null,
      })
    default:
      return fail(id, -32601, `unknown method ${method}`)
  }
}

function onLine(line) {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, method } = msg
  if (typeof method === 'string') {
    if (id === undefined) return // 通知（initialized 等）
    return onRequest(id, method, msg.params)
  }
  // 客户端对我们服务端请求的应答
  const w = waiting.get(id)
  if (!w) return
  waiting.delete(id)
  note('serverRequest/resolved', { threadId: w.threadId, requestId: id })
  w.resolve(msg.error !== undefined ? { error: msg.error } : (msg.result ?? {}))
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
// stdin 关了（宿主退出 / kill）：等 stdout 写完再退
process.stdin.on('end', () => {
  if (buf) onLine(buf)
  process.stdout.write('', () => process.exit(0))
})
process.stdout.on('error', () => process.exit(0))
