/* ---------- 假 pi / omp 对得上 pi 系 RPC 协议 ----------
 * 用驱动将来要用的客户端（drivers/pi/rpc.ts）拉起 fake/pi-rpc.mjs：pi 方言的一轮、扩展 UI 往返、-e 扩展注册 MCP、
 * 按路径恢复会话；omp 方言的 ready / v2 分块、open_session、ask、审批 select、后台子代理与单独停止、宿主工具。不连库。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, expect, test } from 'vitest'
import { probeVersion } from '../drivers/cli-version.js'
import type { PiDialect, PiEvent, UiDialogRequest } from '../drivers/pi/protocol.js'
import { PiRpc, PiRpcError, type HostToolHandler, type UiDialogHandler } from '../drivers/pi/rpc.js'

const FAKE = fileURLToPath(new URL('./pi-rpc.mjs', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'fake-pi-test-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))
const opened: PiRpc[] = []
afterEach(() => {
  for (const r of opened.splice(0)) r.kill()
})

/** 测试用的扩展：同驱动扩展的契约（读环境变量、读完即删、registerMcpServer） */
const EXT = join(home, 'ext.mjs')
writeFileSync(
  EXT,
  `export default function (pi) {
    const cfg = JSON.parse(process.env.RAMET_PI_MCP ?? '{}')
    delete process.env.RAMET_PI_MCP
    for (const [name, c] of Object.entries(cfg)) pi.registerMcpServer(name, c)
  }\n`,
)

type Opts = { dialect?: PiDialect; args?: string[]; env?: Record<string, string>; cwd?: string }

async function connect(opts: Opts = {}) {
  const dialect = opts.dialect ?? 'pi'
  const events: PiEvent[] = []
  const box: { ui: UiDialogHandler; host: HostToolHandler } = {
    ui: () => null,
    host: async () => ({ content: [{ type: 'text', text: 'none' }] }),
  }
  const rpc = new PiRpc({
    id: dialect,
    dialect,
    command: process.execPath,
    args: [FAKE, '--mode', dialect === 'omp' ? 'rpc-ui' : 'rpc', ...(opts.args ?? [])],
    env: { FAKE_PI_HOME: home, ...(dialect === 'omp' ? { FAKE_PI_DIALECT: 'omp' } : {}), ...opts.env },
    cwd: opts.cwd ?? home,
    onEvent: (e) => events.push(e),
    onUiDialog: (req, signal) => box.ui(req, signal),
    onHostTool: (call, signal, progress) => box.host(call, signal, progress),
  })
  opened.push(rpc)
  await rpc.ready()
  /** 发一轮、等它收尾（pi：agent_settled；omp：session_settled）；onEvent 在每条事件到达时回调 */
  async function turn(text: string, onEvent?: (e: PiEvent) => void) {
    const from = events.length
    const ack = await rpc.request('prompt', { message: text })
    for (let seen = from; ; ) {
      while (seen < events.length) {
        const e = events[seen++]!
        onEvent?.(e)
        if (e.type === (dialect === 'omp' ? 'session_settled' : 'agent_settled')) {
          const mine = events.slice(from, seen)
          const said = mine
            .flatMap((x) => (x.type === 'message_update' && x.assistantMessageEvent.type === 'text_delta' ? [x.assistantMessageEvent.delta] : []))
            .join('')
          return { ack, text: said, events: mine }
        }
      }
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  return { rpc, events, box, turn }
}

const types = (events: PiEvent[]) => events.map((e) => e.type)

test('--version：pi 报裸版本号、omp 报 omp/<版本>，都读 FAKE_PI_VERSION', async () => {
  expect(await probeVersion(FAKE)).toBe('1.4.0')
  expect(await probeVersion(FAKE, { FAKE_PI_DIALECT: 'omp' })).toBe('18.14.1')
  expect(await probeVersion(FAKE, { FAKE_PI_VERSION: '1.0.0' })).toBe('1.0.0')
})

test('pi：get_state → 一轮的事件流（assistant 消息、用量、agent_settled）；第二轮是增量；在跑时再发 prompt 被拒', async () => {
  const { rpc, turn } = await connect()
  const state = await rpc.request('get_state', {})
  expect(state).toMatchObject({ model: { provider: 'fake', id: 'm1' }, thinkingLevel: 'medium', isStreaming: false })
  const first = await turn('你好')
  expect(first.ack).toEqual({ disposition: 'started' })
  expect(first.text).toBe('turn:full model=fake/m1 thinking=medium\n')
  expect(types(first.events)).toEqual([
    'agent_start', 'turn_start', 'message_start', 'message_end', 'message_start', 'message_update', 'message_update', 'message_update',
    'message_end', 'turn_end', 'agent_end', 'agent_settled',
  ])
  const end = first.events.findLast((e) => e.type === 'message_end')
  expect(end).toMatchObject({ message: { role: 'assistant', stopReason: 'stop', usage: { input: 2, output: first.text.length } } })
  expect((await turn('再来')).text).toContain('turn:delta')
  await rpc.request('prompt', { message: '慢慢来' })
  const busy = await rpc.request('prompt', { message: 'x' }).catch((e: unknown) => e)
  expect(busy).toBeInstanceOf(PiRpcError)
  // abort 的应答在收尾之后
  await rpc.request('abort', {})
  expect((await rpc.request('get_state', {})).isStreaming).toBe(false)
})

test('pi：剧本要审批时发扩展的 confirm，答案回到剧本；工具步骤是 bash 的执行事件；拒绝时工具以 blocked by user 结束', async () => {
  const { box, turn } = await connect()
  const seen: UiDialogRequest[] = []
  const answers = [{ confirmed: true }, { confirmed: false }]
  box.ui = (req) => {
    seen.push(req)
    return answers[seen.length - 1] ?? null
  }
  const ok = await turn('需要权限')
  expect(ok.text).toBe('granted:allow_once\n')
  expect(seen[0]).toMatchObject({ method: 'confirm', title: '运行命令', message: 'npm test -- --run' })
  expect(ok.events.find((e) => e.type === 'tool_execution_start')).toMatchObject({ toolName: 'bash', args: { command: 'npm test -- --run' } })
  const no = await turn('需要权限')
  expect(no.text).toBe('granted:reject_once\n')
  expect(no.events.find((e) => e.type === 'tool_execution_end')).toMatchObject({ isError: true, result: { content: [{ text: 'blocked by user' }] } })
})

test('pi：-e 扩展按会话注册 MCP（读完环境变量即删），--no-mcp 时得到 extension_error；工具调用落成 read / bash 的执行事件', async () => {
  const mcp = JSON.stringify({ ramet: { command: process.execPath, args: ['/x/mcp/ramet.mjs'], env: { RAMET_PAGE_URL: 'http://h/A' }, exposure: 'direct' } })
  const a = await connect({ args: ['-e', EXT], env: { RAMET_PI_MCP: mcp } })
  expect((await a.turn('报 MCP')).text).toBe('mcp:ramet ramet.mjs http://h/A env:RAMET_PAGE_URL\n')
  const used = await a.turn('用工具')
  expect(used.text).toBe('tool-done\n')
  const starts = used.events.flatMap((e) => (e.type === 'tool_execution_start' ? [[e.toolName, e.args]] : []))
  expect(starts).toEqual([['read', { path: 'packages/server/src/agents/acp.ts' }], ['bash', { command: '跑测试' }]])
  expect(used.events.filter((e) => e.type === 'tool_execution_end')).toHaveLength(2)

  const b = await connect({ args: ['-e', EXT, '--no-mcp', '--no-tools'], env: { RAMET_PI_MCP: mcp } })
  expect((await b.turn('报 MCP')).text).toContain('mcp:none')
  expect(b.events.find((e) => e.type === 'extension_error')).toMatchObject({ event: 'register_mcp_server' })
})

test('pi：--session <路径> 不存在时新建、第一轮后才落盘；换进程按同一路径恢复，只发新消息', async () => {
  const file = join(home, 'pi-sessions', 'abc.jsonl')
  const a = await connect({ args: ['--session', file] })
  const st = await a.rpc.request('get_state', {})
  expect(st.sessionFile).toBe(file)
  await a.turn('你好')
  a.rpc.kill()
  const b = await connect({ args: ['--session', file] })
  expect((await b.turn('报会话')).text).toBe(`session:${st.sessionId} resumed:${st.sessionId} prior:1\n`)
})

test('没有可用模型：prompt 当场失败，不进事件流', async () => {
  const { rpc, events } = await connect({ env: { FAKE_PI_NO_MODEL: '1' } })
  const r = await rpc.request('prompt', { message: 'hi' }).catch((e: unknown) => e)
  expect(r).toBeInstanceOf(PiRpcError)
  expect((r as Error).message).toContain('No API key found')
  expect(events).toEqual([])
})

test('omp：ready → v2 → open_session 新建 / 换进程恢复（cwd 不同则 cancelled）；一轮以 prompt_result + session_settled 收尾', async () => {
  const dir = join(home, 'omp-sessions', 's1')
  const a = await connect({ dialect: 'omp' })
  expect(await a.rpc.negotiate()).toBe(true)
  const opened1 = await a.rpc.request('open_session', { sessionDir: dir })
  expect(opened1).toMatchObject({ cancelled: false, resumed: false })
  expect(opened1.sessionFile.startsWith(dir)).toBe(true)
  const first = await a.turn('你好')
  expect(first.ack).toBeUndefined()
  expect(first.text).toBe('turn:full model=fake/m1 thinking=medium mode=yolo\n')
  expect(types(first.events).slice(-2)).toEqual(['prompt_result', 'session_settled'])
  expect(first.events.find((e) => e.type === 'prompt_result')).toMatchObject({ status: 'completed', sessionSettled: true })
  a.rpc.kill()

  const b = await connect({ dialect: 'omp' })
  expect(await b.rpc.request('open_session', { sessionDir: dir })).toMatchObject({ cancelled: false, resumed: true, sessionId: opened1.sessionId })
  expect((await b.turn('报会话')).text).toBe(`session:${opened1.sessionId} resumed:${opened1.sessionId} prior:1\n`)

  const otherCwd = join(home, 'elsewhere')
  mkdirSync(otherCwd, { recursive: true })
  const c = await connect({ dialect: 'omp', cwd: otherCwd })
  expect(await c.rpc.request('open_session', { sessionDir: dir })).toMatchObject({ cancelled: true, resumed: false })
})

test('omp：ask 对话框多题多选 + 自由输入；没开对话框时逐题 select；审批是 select「Allow tool」，yolo 时不问', async () => {
  const { rpc, box, turn } = await connect({ dialect: 'omp', args: ['--approval-mode', 'always-ask'] })
  await rpc.request('set_ask_dialog', { enabled: true })
  const asked: UiDialogRequest[] = []
  box.ui = (req) => {
    asked.push(req)
    if (req.method === 'ask') return { answers: [{ id: 'q0', selectedOptions: [], customInput: 'yarn' }, { id: 'q1', selectedOptions: ['Lint', 'Docs'] }] }
    if (req.method === 'select' && req.title.startsWith('Allow tool:')) return { value: req.options[1]! }
    return null
  }
  const q = await turn('提问')
  expect(asked[0]).toMatchObject({ method: 'ask', questions: [{ id: 'q0', question: '用哪个包管理器？' }, { id: 'q1', multi: true }] })
  expect(JSON.parse(q.text.replace(/^answers:/, ''))).toEqual({ '用哪个包管理器？': 'yarn', '要哪些功能？': 'Lint, Docs' })
  // ask 的 UI 请求先于 ask 工具的执行开始（toolCall 已在 assistant 消息里）
  expect(q.events.find((e) => e.type === 'tool_execution_start')).toMatchObject({ toolName: 'ask' })

  const p = await turn('需要权限 审批可总是')
  expect(p.text).toBe('granted:allow_always\n')
  expect(asked[1]).toMatchObject({ method: 'select', title: 'Allow tool: bash\nCommand: npm test -- --run', options: ['Approve', 'Approve bash for this session', 'Deny'] })

  const yolo = await connect({ dialect: 'omp' })
  yolo.box.ui = () => {
    throw new Error('yolo 下不该问')
  }
  expect((await yolo.turn('需要权限')).text).toBe('granted:allow_once\n')
  // 没开 ask 对话框：逐题 select
  const seen: string[] = []
  yolo.box.ui = (req) => {
    seen.push(req.method)
    return req.method === 'select' ? { value: req.options[0]! } : null
  }
  expect((await yolo.turn('提问')).text).toBe('answers:{"用哪个包管理器？":"npm","要哪些功能？":"Lint"}\n')
  expect(seen).toEqual(['select', 'select'])
})

test('omp 子代理：task 是后台作业（先 prompt_result sessionSettled:false）；子代理帧带 parentToolCallId；cancel_subagent 只停它', async () => {
  const { rpc, turn } = await connect({ dialect: 'omp' })
  await rpc.request('set_subagent_subscription', { level: 'events' })
  let sub = ''
  const r = await turn('起子代理慢', (e) => {
    if (e.type === 'subagent_lifecycle' && e.payload.status === 'started') {
      sub = e.payload.id
      setTimeout(() => void rpc.request('cancel_subagent', { subagentId: e.payload.id }), 200)
    }
  })
  expect(r.text).toContain('subagent:stopped\n')
  const result = r.events.find((e) => e.type === 'prompt_result')
  expect(result).toMatchObject({ status: 'completed', sessionSettled: false })
  const task = r.events.find((e) => e.type === 'tool_execution_end' && e.toolName === 'task')
  expect(task).toMatchObject({ result: { details: { async: { state: 'running', jobId: sub } } } })
  const lifecycle = r.events.flatMap((e) => (e.type === 'subagent_lifecycle' ? [e.payload] : []))
  expect(lifecycle.map((l) => l.status)).toEqual(['started', 'aborted'])
  expect(lifecycle[0]!.parentToolCallId).toBe((task as { toolCallId: string }).toolCallId)
  expect(r.events.some((e) => e.type === 'subagent_event' && e.payload.event.type === 'tool_execution_start')).toBe(true)
  // 子代理结束后 omp 注入 async-result 再起一段
  expect(r.events.some((e) => e.type === 'message_end' && e.message.role === 'custom')).toBe(true)
  expect(types(r.events).at(-1)).toBe('session_settled')
  expect(await rpc.request('cancel_subagent', { subagentId: sub })).toEqual({ cancelled: false })
})

test('omp 宿主工具：set_host_tools 后调用往返；v2 下超大帧拆块、客户端拼回', async () => {
  const { rpc, box, turn } = await connect({ dialect: 'omp', env: { FAKE_PI_MAX_FRAME: '600' } })
  await rpc.negotiate()
  expect(await rpc.request('set_host_tools', { tools: [{ name: 'read_page', description: 'read', parameters: { type: 'object' }, loadMode: 'essential' }] })).toEqual({
    toolNames: ['read_page'],
  })
  expect((await turn('报工具')).text).toBe('tools:read_page\n')
  box.host = async (call) => ({ content: [{ type: 'text', text: `${call.toolName}:${String(call.arguments.text)}` }] })
  expect((await turn('调宿主工具:read_page')).text).toBe('host:read_page:hello\n')
  const long = '长'.repeat(500)
  expect((await turn(`回显提示词 ${long}`)).text).toContain(long)
})

test('进程崩溃：在飞的一轮没有收尾，进程以退出码 3 结束并留下 stderr', async () => {
  let exit: { reason: string; crashed: boolean } | null = null
  const rpc = new PiRpc({
    id: 'pi', dialect: 'pi', command: process.execPath, args: [FAKE, '--mode', 'rpc'], env: { FAKE_PI_HOME: home }, cwd: home,
    onEvent: () => undefined, onUiDialog: () => null, onExit: (e) => (exit = e),
  })
  opened.push(rpc)
  await rpc.request('prompt', { message: '进程崩溃' })
  await rpc.done
  expect(exit).toMatchObject({ crashed: true })
  expect(exit!.reason).toContain('退出码 3')
  expect(exit!.reason).toContain('fake pi crashed on purpose')
})
