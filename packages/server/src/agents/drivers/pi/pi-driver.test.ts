/* ---------- pi / omp 原生驱动：假 CLI（fake/pi-rpc.mjs）说 pi 系的 JSONL RPC ----------
 * 两种方言各一遍：流式正文与用量、斜杠命令、工具步骤视图与实时输出、取消、换实例按会话记录恢复只发新消息、
 * 记录不在时 loadSession 抛错、受限会话、进程崩溃后恢复。pi：扩展注册 MCP（撞名避让）、confirm 审批。
 * omp：宿主工具往返、子代理归属与单独停止、等会话静止才收尾、ask 提问、审批 select。不连库。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import { mergeView, type ToolView } from '@ramet/shared/run-model'
import type { AgentEvent, PermissionEvent } from '../../types.js'
import type { PiDialect } from './protocol.js'
import { RpcAgentDriver } from './driver.js'

const FAKE = fileURLToPath(new URL('../../fake/pi-rpc.mjs', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'pi-driver-home-'))
const sessions = mkdtempSync(join(tmpdir(), 'pi-driver-sessions-'))
const cwd = mkdtempSync(join(tmpdir(), 'pi-driver-cwd-'))
// 会话记录不落到真的 ~/.ramet 里
process.env.RAMET_SESSIONS_DIR = sessions
afterAll(() => {
  for (const dir of [home, sessions, cwd]) rmSync(dir, { recursive: true, force: true })
})

const drivers: RpcAgentDriver[] = []
afterEach(() => {
  for (const d of drivers.splice(0)) d.kill()
})

function driver(dialect: PiDialect, extraEnv: Record<string, string> = {}): { d: RpcAgentDriver; events: AgentEvent[] } {
  const env = { FAKE_PI_HOME: home, ...(dialect === 'omp' ? { FAKE_PI_DIALECT: 'omp' } : {}), ...extraEnv }
  const d = new RpcAgentDriver({ id: dialect, label: dialect, command: FAKE, driver: dialect, env }, dialect)
  drivers.push(d)
  const events: AgentEvent[] = []
  d.on((ev) => events.push(ev))
  return { d, events }
}

const textOf = (events: AgentEvent[], parentId?: string): string =>
  events.flatMap((e) => (e.type === 'text' && e.parentId === parentId ? [e.delta] : [])).join('')

type StepView = { kind?: string; title?: string; status?: string; parentId?: string; activity?: string; note?: string; detail?: string; view?: ToolView }
/** 把 tool 原料事件按 id 合并成步骤（RunRecord 的合并语义：缺省保持、视图按字段合并） */
function steps(events: AgentEvent[]): Map<string, StepView> {
  const out = new Map<string, StepView>()
  for (const e of events) {
    if (e.type !== 'tool') continue
    const prev = out.get(e.id) ?? {}
    const next: StepView = { ...prev }
    for (const k of ['kind', 'title', 'status', 'parentId', 'activity', 'note', 'detail'] as const) {
      if (e[k] !== undefined) next[k] = e[k]
    }
    if (e.view) next.view = mergeView(prev.view, e.view)
    out.set(e.id, next)
  }
  return out
}

async function until<T>(get: () => T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = get()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error('等不到')
    await new Promise((r) => setTimeout(r, 20))
  }
}

const text = (t: string) => [{ type: 'text' as const, text: t }]
const tool = (url: string, token = 'tok') => ({ mcp: { url, token } })
const permission = (events: AgentEvent[]) => until(() => events.find((e): e is PermissionEvent => e.type === 'permission'))

describe.each(['pi', 'omp'] as const)('%s', (dialect) => {
  test('流式正文、用量与 stop reason；建会话就有斜杠命令；会话事件都带 sessionId', async () => {
    const { d, events } = driver(dialect)
    expect(d.pristine).toBe(true)
    await d.ready()
    expect(d.alive).toBe(true)
    const { sessionId } = await d.newSession(cwd)
    const names = d.sessionState(sessionId).commands.map((c) => c.name)
    expect(names).toEqual(['fake-cmd', 'fake-cmd-arg'])
    if (dialect === 'omp') expect(d.sessionState(sessionId).commands[1]).toMatchObject({ input: '参数' })
    const res = await d.prompt(sessionId, text('你好'))
    const reply = textOf(events)
    expect(reply).toBe(`turn:full model=fake/m1 thinking=medium${dialect === 'omp' ? ' mode=yolo' : ''}\n`)
    expect(res.stopReason).toBe('end_turn')
    expect(res.usage).toMatchObject({ input: 2, output: reply.length, cacheRead: 0 })
    expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(0)
    expect(events.every((e) => !('sessionId' in e) || e.sessionId === sessionId)).toBe(true)
    const info = events.filter((e): e is Extract<AgentEvent, { type: 'info' }> => e.type === 'info').at(-1)
    expect(info?.info).toMatchObject({ stopReason: 'end_turn', usage: { input: 2 } })
    expect(d.busy).toBe(false)
    events.length = 0
    await d.prompt(sessionId, text('再来'))
    expect(textOf(events)).toContain('turn:delta')
    await expect(d.prompt('no-such-session', text('你好'))).rejects.toThrow(/Unsupported session/)
    await expect(d.setConfigOption(sessionId, 'model', 'x')).rejects.toThrow(/没有这个选项/)
    await expect(d.setConfigOption(sessionId, 'nope', 'x')).rejects.toThrow(/没有这个配置项/)
  })

  test('工具步骤：读 = read（路径），命令 = execute（命令 / 结果 / 退出码）；命令的累计输出换算成增量进 terminal；上下文占用', async () => {
    const { d, events } = driver(dialect)
    const { sessionId } = await d.newSession(cwd)
    await d.prompt(sessionId, text('多段'))
    const s = steps(events)
    expect(s.get('m-1')).toMatchObject({ kind: 'read', title: '读 doc.ts', detail: '读 doc.ts', status: 'completed', view: { tool: 'read', path: '读 doc.ts' } })
    expect(s.get('m-2')).toMatchObject({ kind: 'execute', title: '跑测试', status: 'failed', note: '2 failed · doc.test.ts', view: { tool: 'bash', command: '跑测试', exit: { code: 1, signal: null } } })
    expect(s.get('m-2')?.view?.result).toBe('\n2 failed · doc.test.ts\n详情')
    const live = events.filter((e): e is Extract<AgentEvent, { type: 'terminal' }> => e.type === 'terminal' && e.id === 'm-2')
    expect(live.length).toBeGreaterThan(1)
    expect(live.map((e) => e.delta).join('')).toBe('\n2 failed · doc.test.ts\n详情')
    expect(events.some((e) => e.type === 'thought' && e.delta === '先想想')).toBe(true)
    expect(textOf(events)).toBe('我先看看\n## 结论\n\n**好了**')
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ used: 38000, size: 200000 })

    events.length = 0
    await d.prompt(sessionId, text('用工具'))
    expect(steps(events).get('call-1')).toMatchObject({ kind: 'read', status: 'completed', view: { path: 'packages/server/src/agents/acp.ts' } })
    expect(textOf(events)).toBe('tool-done\n')
  })

  test('取消：打标记 + abort，本轮按取消收尾；排着的下一轮照常', async () => {
    const { d, events } = driver(dialect)
    const { sessionId } = await d.newSession(cwd)
    const run = d.prompt(sessionId, text('慢慢来'))
    await until(() => (events.some((e) => e.type === 'text') ? true : undefined))
    expect(d.busy).toBe(true)
    d.cancel(sessionId)
    expect((await run).stopReason).toBe('cancelled')
    expect(d.busy).toBe(false)
    events.length = 0
    expect((await d.prompt(sessionId, text('你好'))).stopReason).toBe('end_turn')
  })

  test('换实例按会话记录恢复，只发新消息；记录不在时 loadSession 抛错（CLI 自己会静默新建）', async () => {
    const a = driver(dialect)
    const { sessionId } = await a.d.newSession(cwd)
    // 没跑过一轮的会话不落盘
    const b0 = driver(dialect)
    await expect(b0.d.loadSession(sessionId, cwd)).rejects.toThrow(/没有会话/)
    await a.d.prompt(sessionId, text('报会话'))
    const first = /^session:(\S+) resumed:no prior:0\n$/.exec(textOf(a.events))
    expect(first).not.toBeNull()
    expect(a.d.sessionLocation(sessionId)).toBe(join(sessions, dialect, dialect === 'pi' ? `${sessionId}.jsonl` : sessionId))
    a.d.kill()

    const b = driver(dialect)
    await b.d.loadSession(sessionId, cwd)
    await b.d.prompt(sessionId, text('报会话'))
    expect(textOf(b.events)).toBe(`session:${first![1]} resumed:${first![1]} prior:1\n`)
    await expect(b.d.loadSession('00000000-0000-0000-0000-000000000000', cwd)).rejects.toThrow(/没有会话/)
    if (dialect === 'omp') {
      // 会话记录的工作目录与进程的不同：omp 只回 cancelled，驱动按失败处理
      const other = join(cwd, 'elsewhere')
      mkdirSync(other, { recursive: true })
      const c = driver(dialect)
      await expect(c.d.loadSession(sessionId, other)).rejects.toThrow(/工作目录/)
    }
  })

  test('受限会话：不给工具 / MCP，审批一律拒绝且不发事件，不对外露面；丢弃时连会话记录一起删', async () => {
    const { d, events } = driver(dialect, { FAKE_OMP_APPROVAL: 'always-ask' })
    const { sessionId } = await d.newRestrictedSession(cwd)
    expect(d.isRestricted(sessionId)).toBe(true)
    await d.prompt(sessionId, text('需要权限'))
    expect(textOf(events)).toBe('granted:reject_once\n')
    expect(events.some((e) => e.type === 'permission')).toBe(false)
    expect(d.knownSessions()).not.toContain(sessionId)
    expect(d.sessionState(sessionId).commands).toEqual([])
    events.length = 0
    await d.prompt(sessionId, text('报 MCP'))
    expect(textOf(events)).toContain('mcp:none')
    const at = d.sessionLocation(sessionId)!
    expect(existsSync(at)).toBe(true)
    d.discardSession(sessionId)
    expect(existsSync(at)).toBe(false)
  })

  test('进程崩溃：在飞的一轮以带 stderr 的错误收尾；下一轮重起并接上会话记录', async () => {
    const { d, events } = driver(dialect)
    const { sessionId } = await d.newSession(cwd)
    await d.prompt(sessionId, text('你好'))
    await expect(d.prompt(sessionId, text('进程崩溃'))).rejects.toThrow(/退出码 3.*crashed on purpose/)
    expect(d.busy).toBe(false)
    events.length = 0
    await d.prompt(sessionId, text('报会话'))
    expect(textOf(events)).toMatch(/^session:(\S+) resumed:\1 prior:1\n$/)
  })

  test('版本低于最低要求：ready 拒绝并把自己标成死的', async () => {
    const { d } = driver(dialect, { FAKE_PI_VERSION: '1.0.0' })
    await expect(d.ready()).rejects.toThrow(/太旧/)
    expect(d.alive).toBe(false)
  })
})

describe('pi', () => {
  test('扩展按会话注册 Ramet 的 MCP（exposure: direct）；用户配置里已有 ramet 时换名', async () => {
    const { d, events } = driver('pi')
    const { sessionId } = await d.newSession(cwd, [tool('http://center.test/A')])
    await d.prompt(sessionId, text('报 MCP'))
    expect(textOf(events)).toBe('mcp:ramet ramet.mjs http://center.test/A env:RAMET_PAGE_URL,RAMET_PAGE_TOKEN\n')

    const agentDir = join(home, 'pi-agent')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { ramet: { url: 'http://user.example/mcp' } } }))
    const user = JSON.stringify({ ramet: { command: 'user-mcp', args: [] } })
    const b = driver('pi', { PI_CODING_AGENT_DIR: agentDir, FAKE_PI_MCP: user })
    const s2 = await b.d.newSession(cwd, [tool('http://center.test/B')])
    await b.d.prompt(s2.sessionId, text('报 MCP'))
    expect(textOf(b.events)).toBe('mcp:ramet-page ramet.mjs http://center.test/B env:RAMET_PAGE_URL,RAMET_PAGE_TOKEN\n')
  })

  test('扩展的 confirm 挂成审批卡（确认 / 拒绝），答案回到 pi；停止时收掉待批', async () => {
    const { d, events } = driver('pi')
    const { sessionId } = await d.newSession(cwd)
    const run = d.prompt(sessionId, text('需要权限'))
    const perm = await permission(events)
    expect(perm).toMatchObject({ title: '运行命令', view: { description: 'npm test -- --run' } })
    expect(perm.options.map((o) => o.optionId)).toEqual(['allow', 'reject'])
    expect(d.busy).toBe(true)
    d.respondPermission(perm.requestId, 'allow')
    await run
    expect(textOf(events)).toBe('granted:allow_once\n')

    events.length = 0
    const run2 = d.prompt(sessionId, text('需要权限'))
    const perm2 = await permission(events)
    d.cancel(sessionId)
    expect((await run2).stopReason).toBe('cancelled')
    expect(events.some((e) => e.type === 'permission_resolved' && e.requestId === perm2.requestId)).toBe(true)
    expect(d.busy).toBe(false)
  })
})

describe('omp', () => {
  let center: Server | null = null
  afterEach(() => {
    center?.close()
    center = null
  })

  /** 假中心：Ramet MCP 进程会问它这把凭证能用哪些工具、读页面 */
  async function fakeCenter(): Promise<string> {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url?.startsWith('/api/ramet/tools')) return res.end(JSON.stringify({ tools: ['read_page'], agents: [] }))
      if (req.url?.startsWith('/api/pages/')) return res.end(JSON.stringify({ title: '页面', offset: 1, limit: 200, total: 1, lines: [`auth=${req.headers.authorization}`] }))
      res.statusCode = 404
      res.end('{}')
    })
    center = server
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  }

  test('宿主工具：驱动当 MCP 客户端，set_host_tools 交给 omp，调用经 MCP 转到中心再回来', async () => {
    const url = await fakeCenter()
    const { d, events } = driver('omp')
    const { sessionId } = await d.newSession(cwd, [tool(url, 'secret')])
    await d.prompt(sessionId, text('报工具'))
    expect(textOf(events)).toBe('tools:ramet_read_page\n')
    events.length = 0
    await d.prompt(sessionId, text('调宿主工具:ramet_read_page'))
    expect(textOf(events)).toBe('host:# 页面\n行 1–1/1\n1\tauth=Bearer secret\n')
    events.length = 0
    await d.prompt(sessionId, text('调宿主工具:ramet_nope'))
    expect(textOf(events)).toBe('host:error:没有宿主工具 ramet_nope\n')
  })

  test('子代理：task 是后台作业，等会话静止才收尾；子代理的正文 / 步骤挂在 task 那一步下，那一步可停（handle = 子代理 id）', async () => {
    const { d, events } = driver('omp')
    const { sessionId } = await d.newSession(cwd)
    const res = await d.prompt(sessionId, text('起子代理'))
    expect(res.stopReason).toBe('end_turn')
    // 子代理跑完之后 omp 才续上的那一段也在这一轮里
    expect(textOf(events)).toBe('已派出子代理。\n\nsubagent:completed\n')
    const s = steps(events)
    const step = s.get('toolu_agent_1')
    expect(step).toMatchObject({ kind: 'think', title: '找出 run-finalize 的收尾出口', status: 'completed', view: { tool: 'task' } })
    expect(step?.view?.handle).toMatch(/^Sub\d+$/)
    expect(textOf(events, 'toolu_agent_1')).toBe('子代理：开始查找。')
    const children = [...s.entries()].filter(([, v]) => v.parentId === 'toolu_agent_1')
    expect(children.map(([id, v]) => [id.split('#')[1], v.kind, v.status])).toEqual([
      ['toolu_agent_1_s1', 'read', 'completed'],
      ['toolu_agent_1_s2', 'execute', 'completed'],
    ])
    expect(d.killCommand(sessionId, step!.view!.handle!)).toBe(false)

    events.length = 0
    const run = d.prompt(sessionId, text('起子代理慢'))
    const handle = await until(() => steps(events).get('toolu_agent_2')?.view?.handle)
    expect(d.killCommand('other-session', handle)).toBe(false)
    expect(d.killCommand(sessionId, handle)).toBe(true)
    const done = await run
    expect(done.stopReason).toBe('end_turn')
    expect(textOf(events)).toContain('subagent:stopped\n')
    expect(steps(events).get('toolu_agent_2')).toMatchObject({ status: 'failed', note: '已停止' })
  })

  test('ask：每题一个选择（多选题 multi）+「其他」，挂在 ask 那一步上；答案按 omp 的形状回去', async () => {
    const { d, events } = driver('omp')
    const { sessionId } = await d.newSession(cwd)
    const run = d.prompt(sessionId, text('提问'))
    const perm = await permission(events)
    expect(perm.form?.fields.map((f) => [f.key, f.kind, f.kind === 'choice' ? f.multi : null])).toEqual([
      ['question_0', 'choice', false],
      ['question_0_custom', 'text', null],
      ['question_1', 'choice', true],
      ['question_1_custom', 'text', null],
    ])
    const toolCallId = perm.form?.toolCallId
    expect(toolCallId).toMatch(/^call_ask_/)
    expect(perm.toolCall).toMatchObject({ toolCallId })
    expect(steps(events).get(toolCallId!)).toMatchObject({ title: '用哪个包管理器？' })
    d.respondPermission(perm.requestId, 'accept', { question_0_custom: 'yarn', question_1: ['Lint', 'Docs'] })
    await run
    expect(textOf(events)).toBe('answers:{"用哪个包管理器？":"yarn","要哪些功能？":"Lint, Docs"}\n')
    expect(steps(events).get(toolCallId!)).toMatchObject({ status: 'completed' })
  })

  test('审批 select（Allow tool）：挂在正在执行的那一步上，摆允许一次 / 本会话总是允许 / 拒绝', async () => {
    const { d, events } = driver('omp', { FAKE_OMP_APPROVAL: 'always-ask' })
    const { sessionId } = await d.newSession(cwd)
    const run = d.prompt(sessionId, text('需要权限 审批可总是'))
    const perm = await permission(events)
    expect(perm.options.map((o) => o.optionId)).toEqual(['allow', 'allow-always', 'reject'])
    const step = [...steps(events).entries()].find(([, v]) => v.view?.tool === 'bash')
    expect(perm.toolCall).toEqual({ toolCallId: step?.[0], title: 'npm test -- --run', kind: 'execute' })
    expect(perm.view).toMatchObject({ command: 'npm test -- --run' })
    d.respondPermission(perm.requestId, 'allow-always')
    await run
    expect(textOf(events)).toBe('granted:allow_always\n')
  })
})
