/* ---------- 假 codex 对得上 app-server 协议 ----------
 * 用驱动将来要用的 JSON-RPC 客户端（drivers/codex/rpc.ts）拉起 fake/codex.mjs：握手、线程、回合的通知流、三类审批、
 * 提问、子代理与单独停止、中断撤回待批、跨进程 resume、按线程注入 MCP。不连库。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, expect, test } from 'vitest'
import { probeVersion } from '../drivers/cli-version.js'
import type { ServerNotifications, ThreadItem, TurnStartParams } from '../drivers/codex/protocol.js'
import { CodexRpc, RpcError, type ServerRequestHandler } from '../drivers/codex/rpc.js'

const FAKE_CODEX = fileURLToPath(new URL('./codex.mjs', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'fake-codex-test-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))
const opened: CodexRpc[] = []
afterEach(() => {
  for (const r of opened.splice(0)) r.kill()
})

type Note = { method: string; params: unknown }

/** 一个 app-server 连接：收齐通知，服务端请求交给可替换的 handler */
async function connect(opts: { experimental?: boolean; env?: Record<string, string> } = {}) {
  const notes: Note[] = []
  const box: { handler: ServerRequestHandler } = { handler: () => { throw new RpcError(-32601, 'no handler') } }
  const rpc = new CodexRpc({
    id: 'codex',
    command: process.execPath,
    args: [FAKE_CODEX, 'app-server'],
    env: { FAKE_CODEX_HOME: home, ...opts.env },
    onRequest: (m, p, s) => box.handler(m, p, s),
    onNotification: (n) => notes.push(n),
  })
  opened.push(rpc)
  await rpc.request('initialize', {
    clientInfo: { name: 'ramet', title: null, version: '0' },
    capabilities: { experimentalApi: opts.experimental ?? true, requestAttestation: false },
  })
  rpc.notify('initialized')
  /** 发一轮、等它的 turn/completed；onNote 在每条通知到达时回调（可用来中途中断） */
  async function turn(threadId: string, text: string, onNote?: (n: Note, turnId: string) => void, extra: Partial<TurnStartParams> = {}) {
    const from = notes.length
    const { turn: t } = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], ...extra })
    for (let seen = from; ; ) {
      while (seen < notes.length) {
        const n = notes[seen++]!
        onNote?.(n, t.id)
        if (n.method === 'turn/completed') {
          const p = n.params as ServerNotifications['turn/completed']
          if (p.threadId === threadId && p.turn.id === t.id) {
            const mine = notes.slice(from, seen)
            const text = mine
              .filter((x) => x.method === 'item/agentMessage/delta' && (x.params as { threadId: string }).threadId === threadId)
              .map((x) => (x.params as { delta: string }).delta)
              .join('')
            return { text, status: p.turn.status, notes: mine, turnId: t.id }
          }
        }
      }
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  return { rpc, notes, box, turn }
}

const items = (notes: Note[], method: 'item/started' | 'item/completed'): ThreadItem[] =>
  notes.filter((n) => n.method === method).map((n) => (n.params as { item: ThreadItem }).item)

test('--version 读 FAKE_CODEX_VERSION；缺省 0.159.3', async () => {
  expect(await probeVersion(FAKE_CODEX)).toBe('0.159.3')
  expect(await probeVersion(FAKE_CODEX, { FAKE_CODEX_VERSION: '0.100.0' })).toBe('0.100.0')
})

test('握手 → thread/start → 一轮：userMessage / agentMessage 流 / 用量 / turn/completed；第二轮是增量', async () => {
  const { rpc, turn } = await connect()
  const started = await rpc.request('thread/start', { cwd: home })
  expect(started.thread.path).toContain(started.thread.id)
  expect(started.approvalPolicy).toBe('on-request')
  const first = await turn(started.thread.id, '你好')
  expect(first.status).toBe('completed')
  expect(first.text).toBe('turn:full model=m1 thinking=low mode=on-request/workspace-write\n')
  expect(items(first.notes, 'item/started').map((i) => i.type)).toEqual(['userMessage', 'agentMessage'])
  expect(items(first.notes, 'item/completed').find((i) => i.type === 'agentMessage')).toMatchObject({ text: first.text })
  const usage = first.notes.find((n) => n.method === 'thread/tokenUsage/updated')!.params as ServerNotifications['thread/tokenUsage/updated']
  expect(usage.tokenUsage.last).toMatchObject({ inputTokens: 2, outputTokens: first.text.length })
  expect((await turn(started.thread.id, '再来')).text).toContain('turn:delta')
  // 在跑的回合上再发一条被拒：宿主必须串行
  const { turn: busy } = await rpc.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: '慢慢来', text_elements: [] }] })
  const again = await rpc.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'x', text_elements: [] }] }).catch((e: unknown) => e)
  expect((again as RpcError).message).toContain('active turn')
  await rpc.request('turn/interrupt', { threadId: started.thread.id, turnId: busy.id })
})

test('三类审批：命令允许 / 拒绝、改文件、要权限（本会话），决定值映射回剧本的选项', async () => {
  const { rpc, box, turn } = await connect()
  const { thread } = await rpc.request('thread/start', { cwd: home })
  const seen: Array<{ method: string; params: Record<string, unknown> }> = []
  const answers: unknown[] = [{ decision: 'accept' }, { decision: 'decline' }, { decision: 'acceptForSession' }, { permissions: { network: { enabled: true } }, scope: 'session' }]
  box.handler = (method, params) => {
    seen.push({ method, params: params as Record<string, unknown> })
    return answers[seen.length - 1]
  }
  expect((await turn(thread.id, '需要权限')).text).toBe('granted:allow_once\n')
  const declined = await turn(thread.id, '需要权限')
  expect(declined.text).toBe('granted:reject_once\n')
  expect(items(declined.notes, 'item/completed').find((i) => i.type === 'commandExecution')).toMatchObject({ status: 'declined' })
  expect((await turn(thread.id, '需要权限 审批改文件')).text).toBe('granted:allow_once\n')
  expect((await turn(thread.id, '需要权限 审批要权限 审批可总是')).text).toBe('granted:allow_always\n')
  expect(seen.map((x) => x.method)).toEqual([
    'item/commandExecution/requestApproval',
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
  ])
  expect(seen[0]!.params).toMatchObject({ threadId: thread.id, itemId: 't1', kind: 'command', command: 'npm test -- --run', availableDecisions: ['accept', 'decline', 'cancel'] })
  expect(seen[3]!.params).toMatchObject({ permissions: { network: { enabled: true } } })
})

test('turn/interrupt：撤回这一轮还没答的审批（serverRequest/resolved），回合以 interrupted 收尾', async () => {
  const { rpc, box, turn } = await connect()
  const { thread } = await rpc.request('thread/start', { cwd: home })
  let aborted = false
  // 回合 id 取审批请求自己带的：审批可能先于 turn/start 的应答到达，那时通知回调还没拿到回合 id
  box.handler = (_m, params, signal) =>
    new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        aborted = true
        resolve({ decision: 'cancel' })
      })
      void rpc.request('turn/interrupt', { threadId: thread.id, turnId: (params as { turnId: string }).turnId })
    })
  const r = await turn(thread.id, '需要权限')
  expect(r.status).toBe('interrupted')
  expect(aborted).toBe(true)
  expect(r.notes.some((n) => n.method === 'serverRequest/resolved')).toBe(true)
})

test('提问（实验）：三题含一道密码题，答案按题干回到剧本；不开实验 API 就没有这个能力', async () => {
  const { rpc, box, turn } = await connect()
  const { thread } = await rpc.request('thread/start', { cwd: home })
  let questions: Array<{ id: string; isOther: boolean; isSecret: boolean; options: unknown }> = []
  box.handler = (_m, params) => {
    questions = (params as { questions: typeof questions }).questions
    return { answers: { q0: { answers: ['pnpm'] }, q1: { answers: ['Lint', 'Test'] }, q2: { answers: ['sk-123'] } } }
  }
  const r = await turn(thread.id, '提问')
  expect(questions.map((q) => [q.id, q.isOther, q.isSecret])).toEqual([['q0', true, false], ['q1', true, false], ['q2', false, true]])
  expect(JSON.parse(r.text.replace(/^answers:/, ''))).toEqual({ '用哪个包管理器？': 'pnpm', '要哪些功能？': 'Lint, Test', 'API token？': 'sk-123' })

  const plain = await connect({ experimental: false })
  const t2 = await plain.rpc.request('thread/start', { cwd: home })
  expect((await plain.turn(t2.thread.id, '提问')).text).toContain('turn:full')
})

test('子代理：独立线程的条目带子线程 id；对子线程 turn/interrupt 只停子代理，主回合照常收尾', async () => {
  const { rpc, turn } = await connect()
  const { thread } = await rpc.request('thread/start', { cwd: home })
  let child = ''
  const r = await turn(thread.id, '起子代理慢', (n) => {
    if (n.method === 'turn/started' && (n.params as { threadId: string }).threadId !== thread.id && !child) {
      const p = n.params as ServerNotifications['turn/started']
      child = p.threadId
      setTimeout(() => void rpc.request('turn/interrupt', { threadId: p.threadId, turnId: p.turn.id }), 200)
    }
  })
  expect(r.status).toBe('completed')
  expect(r.text).toBe('subagent:stopped\n')
  const spawn = items(r.notes, 'item/started').find((i) => i.type === 'collabAgentToolCall')
  expect(spawn).toMatchObject({ tool: 'spawnAgent', senderThreadId: thread.id, receiverThreadIds: [child] })
  const childItems = r.notes.filter((n) => n.method === 'item/started' && (n.params as { threadId: string }).threadId === child)
  expect(childItems.map((n) => (n.params as { item: ThreadItem }).item.type)).toContain('commandExecution')
  const childDone = r.notes.find((n) => n.method === 'turn/completed' && (n.params as { threadId: string }).threadId === child)
  expect((childDone!.params as ServerNotifications['turn/completed']).turn.status).toBe('interrupted')
  const wait = items(r.notes, 'item/completed').find((i) => i.type === 'collabAgentToolCall' && i.tool === 'wait')
  expect(wait).toMatchObject({ agentsStates: { [child]: { status: 'interrupted' } } })
})

test('跨进程 resume 接上轮数；没落盘的线程 resume 报 no rollout found；path 要实验 API', async () => {
  const a = await connect()
  const { thread } = await a.rpc.request('thread/start', { cwd: home })
  const empty = await a.rpc.request('thread/start', { cwd: home })
  await a.turn(thread.id, '你好')
  a.rpc.kill()

  const b = await connect()
  const resumed = await b.rpc.request('thread/resume', { threadId: thread.id, cwd: home, excludeTurns: true })
  expect(resumed.thread.id).toBe(thread.id)
  expect((await b.turn(thread.id, '报会话')).text).toBe(`session:${thread.id} resumed:${thread.id} prior:1\n`)
  const missing = await b.rpc.request('thread/resume', { threadId: empty.thread.id }).catch((e: unknown) => e)
  expect(missing).toBeInstanceOf(RpcError)
  expect((missing as RpcError).message).toBe(`no rollout found for thread id ${empty.thread.id}`)

  const c = await connect({ experimental: false })
  const gated = await c.rpc.request('thread/resume', { threadId: thread.id, path: resumed.thread.path }).catch((e: unknown) => e)
  expect((gated as RpcError).message).toContain('requires experimentalApi')
})

test('MCP 按线程注入：两条线程各拿各的；已加载时 resume 不换配置，unsubscribe 之后才换', async () => {
  const mcp = (token: string) => ({
    mcp_servers: { ramet: { command: process.execPath, args: ['/x/mcp/ramet.mjs'], env: { RAMET_PAGE_URL: `http://h/${token}`, RAMET_PAGE_TOKEN: token } } },
  })
  const { rpc, turn } = await connect({ env: { FAKE_CODEX_CONFIG: JSON.stringify({ mcp_servers: { mine: { command: 'x', args: [] } } }) } })
  const a = await rpc.request('thread/start', { cwd: home, config: mcp('A') })
  const b = await rpc.request('thread/start', { cwd: home, config: mcp('B') })
  expect((await turn(a.thread.id, '报 MCP')).text).toBe('mcp:ramet ramet.mjs http://h/A env:RAMET_PAGE_URL,RAMET_PAGE_TOKEN\n')
  expect((await turn(b.thread.id, '报 MCP')).text).toBe('mcp:ramet ramet.mjs http://h/B env:RAMET_PAGE_URL,RAMET_PAGE_TOKEN\n')

  await rpc.request('thread/resume', { threadId: a.thread.id, config: mcp('C') })
  expect((await turn(a.thread.id, '报 MCP')).text).toContain('http://h/A')
  expect(await rpc.request('thread/unsubscribe', { threadId: a.thread.id })).toEqual({ status: 'unsubscribed' })
  await rpc.request('thread/resume', { threadId: a.thread.id, config: mcp('C') })
  expect((await turn(a.thread.id, '报 MCP')).text).toContain('http://h/C')

  const cfg = await rpc.request('config/read', { cwd: home })
  expect(Object.keys(cfg.config.mcp_servers ?? {})).toEqual(['mine'])
})

test('切模型 / 推理强度 / 权限预设：turn 级覆盖对之后的回合持续生效；never + 只读沙箱下审批直接按拒绝', async () => {
  const { rpc, box, turn } = await connect()
  const { thread } = await rpc.request('thread/start', { cwd: home })
  box.handler = () => {
    throw new Error('never 下不该发审批')
  }
  const first = await turn(thread.id, '审批模式', undefined, {
    model: 'm2', effort: 'medium', approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false },
  })
  expect(first.text).toBe('perm-mode:never/read-only model:m2\n')
  const next = await turn(thread.id, '需要权限')
  expect(next.text).toBe('granted:reject_once\n')
  expect((await turn(thread.id, '审批模式')).text).toBe('perm-mode:never/read-only model:m2\n')
})

test('进程崩溃：在飞的一轮没有 turn/completed，进程以退出码 3 结束并留下 stderr', async () => {
  let exit: { reason: string; crashed: boolean } | null = null
  const rpc = new CodexRpc({
    id: 'codex', command: process.execPath, args: [FAKE_CODEX, 'app-server'], env: { FAKE_CODEX_HOME: home },
    onRequest: () => null, onNotification: () => undefined, onExit: (e) => (exit = e),
  })
  opened.push(rpc)
  await rpc.request('initialize', { clientInfo: { name: 'ramet', title: null, version: '0' }, capabilities: { experimentalApi: true, requestAttestation: false } })
  const { thread } = await rpc.request('thread/start', { cwd: home })
  await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: '进程崩溃', text_elements: [] }] })
  await rpc.done
  expect(exit).toMatchObject({ crashed: true })
  expect(exit!.reason).toContain('退出码 3')
  expect(exit!.reason).toContain('fake codex crashed on purpose')
})
