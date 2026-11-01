/* ---------- Claude 原生驱动：真 SDK + 假 claude（fake/claude.mjs）----------
 * 流式正文、工具步骤与视图、审批、子代理归属与单独停止、计划、用量、resume 只发新消息、取消、受限会话、MCP 配置。不连库。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, expect, test } from 'vitest'
import { mergeView, type ToolView } from '@ramet/shared/run-model'
import type { AgentConfig, AgentEvent, PermissionEvent, PromptResult } from '../../types.js'
import { ClaudeDriver } from './driver.js'

const FAKE_CLAUDE = fileURLToPath(new URL('../../fake/claude.mjs', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'claude-driver-test-'))
const cwd = mkdtempSync(join(tmpdir(), 'claude-driver-cwd-'))
afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const cfg: AgentConfig = { id: 'claude', label: 'Claude', command: FAKE_CLAUDE, driver: 'claude', env: { FAKE_CLAUDE_HOME: home } }
const drivers: ClaudeDriver[] = []
afterEach(() => {
  for (const d of drivers.splice(0)) d.kill()
})

function driver(): { d: ClaudeDriver; events: AgentEvent[] } {
  const d = new ClaudeDriver(cfg)
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

test('流式正文、斜杠命令、用量与 stop reason；ready 只做检查，建会话时起进程拿配置项', async () => {
  const { d, events } = driver()
  expect(d.pristine).toBe(true)
  await d.ready()
  expect(d.alive).toBe(true)
  const { sessionId, configOptions } = await d.newSession(cwd)
  expect(configOptions.map((o) => [o.id, o.category, o.currentValue])).toEqual([
    ['model', 'model', 'm1'],
    ['mode', 'mode', 'default'],
    ['effort', 'thought_level', 'default'],
  ])
  // 还没发消息，命令就到了（initialize 应答里有）
  expect(d.sessionState(sessionId).commands.map((c) => c.name)).toEqual(['fake-cmd', 'fake-cmd-arg'])
  expect(events.filter((e) => e.type !== 'commands' && e.type !== 'config')).toEqual([])
  const res = await d.prompt(sessionId, text('你好'))
  expect(res.stopReason).toBe('end_turn')
  expect(res.usage).toMatchObject({ input: 2, output: 'turn:full model=m1 thinking=adaptive mode=default\n'.length })
  const deltas = events.filter((e) => e.type === 'text')
  expect(deltas.length).toBeGreaterThan(0)
  expect(textOf(events)).toBe('turn:full model=m1 thinking=adaptive mode=default\n')
  expect(events.every((e) => !('sessionId' in e) || e.sessionId === sessionId)).toBe(true)
  const info = events.filter((e): e is Extract<AgentEvent, { type: 'info' }> => e.type === 'info').at(-1)
  expect(info?.info).toMatchObject({ stopReason: 'end_turn', usage: { input: 2 } })
  expect(d.sessionState(sessionId).commands.map((c) => c.name)).toEqual(['fake-cmd', 'fake-cmd-arg'])
  expect(d.sessionState(sessionId).commands[1]).toMatchObject({ input: '参数' })
  expect(d.busy).toBe(false)
  await expect(d.prompt('no-such-session', text('你好'))).rejects.toThrow(/Unsupported session/)
})

test('找不到 claude：ready 失败并把自己标成死的', async () => {
  const d = new ClaudeDriver({ ...cfg, command: join(cwd, 'no-claude') })
  await expect(d.ready()).rejects.toThrow(/找不到可执行的 claude/)
  expect(d.alive).toBe(false)
  expect(d.pristine).toBe(false)
})

test('工具步骤：种类、标题、视图（路径 / 命令 / 结果 / 退出码）', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  await d.prompt(sessionId, text('用工具'))
  const s = steps(events)
  expect(s.get('call-1')).toMatchObject({
    kind: 'read',
    title: 'packages/server/src/agents/acp.ts',
    detail: 'packages/server/src/agents/acp.ts',
    status: 'completed',
    view: { tool: 'Read', path: 'packages/server/src/agents/acp.ts', result: 'ok', raw: { input: { file_path: 'packages/server/src/agents/acp.ts' } } },
  })
  expect(s.get('call-2')).toMatchObject({ kind: 'execute', title: '跑测试', status: 'completed', view: { tool: 'Bash', command: '跑测试', result: 'ok', exit: { code: 0, signal: null } } })
  expect(textOf(events)).toBe('tool-done\n')
})

test('审批：事件带视图（diff）与 toolCallId，允许 / 拒绝回到 CLI；步骤跟着收尾', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  const answer = async (optionId: string): Promise<PromptResult> => {
    const before = events.length
    const run = d.prompt(sessionId, text('需要权限 审批改文件'))
    const perm = await until(() => events.slice(before).find((e): e is PermissionEvent => e.type === 'permission'))
    expect(perm.toolCall).toMatchObject({ toolCallId: 't1' })
    expect(perm.view).toMatchObject({ path: 'src/app.ts', diffs: [{ path: 'src/app.ts', old: 'const port = 3000', new: 'const port = Number(process.env.PORT ?? 3000)' }] })
    expect(d.busy).toBe(true)
    expect(d.sessionState(sessionId).approvals).toHaveLength(1)
    expect(d.respondPermission(perm.requestId, optionId)).toBe(true)
    return run
  }
  await answer('allow')
  expect(textOf(events)).toBe('granted:allow_once\n')
  expect(steps(events).get('t1')).toMatchObject({ kind: 'edit', status: 'completed' })
  expect(events.some((e) => e.type === 'permission_resolved')).toBe(true)

  events.length = 0
  await answer('reject')
  expect(textOf(events)).toBe('granted:reject_once\n')
  expect(steps(events).get('t1')).toMatchObject({ status: 'failed', note: '用户拒绝了这一步' })
  expect(d.busy).toBe(false)
})

test('子代理：Agent 步骤可停（handle = task_id），子代理里的步骤与正文挂在它下面；单独停掉子代理，主回合照常收尾', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  await d.prompt(sessionId, text('起子代理'))
  const s = steps(events)
  const agent = s.get('toolu_agent_1')
  expect(agent).toMatchObject({ kind: 'think', title: '查收尾出口', status: 'completed', activity: '', view: { tool: 'Agent', handle: 'task-1' } })
  expect(s.get('toolu_agent_1_s1')).toMatchObject({ kind: 'read', parentId: 'toolu_agent_1', status: 'completed', view: { path: 'src/run-finalize.ts', result: '共 80 行' } })
  expect(s.get('toolu_agent_1_s2')).toMatchObject({ kind: 'execute', parentId: 'toolu_agent_1', view: { command: 'grep -n finally src/run-finalize.ts' } })
  expect(textOf(events, 'toolu_agent_1')).toBe('子代理：开始查找。')
  expect(textOf(events)).toBe('subagent:completed\n')
  // 子代理收尾后不能再停
  expect(d.killCommand(sessionId, 'task-1')).toBe(false)

  events.length = 0
  const run = d.prompt(sessionId, text('起子代理慢'))
  const handle = await until(() => steps(events).get('toolu_agent_2')?.view?.handle)
  expect(handle).toBe('task-2')
  expect(d.killCommand(sessionId, handle)).toBe(true)
  const res = await run
  expect(res.stopReason).toBe('end_turn')
  expect(textOf(events)).toBe('subagent:stopped\n')
  expect(steps(events).get('toolu_agent_2')).toMatchObject({ status: 'failed', note: expect.stringContaining('已停止') })
})

test('计划：TodoWrite 变成整份 plan，不产生步骤', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  await d.prompt(sessionId, text('计划验收'))
  const plans = events.filter((e): e is Extract<AgentEvent, { type: 'plan' }> => e.type === 'plan')
  expect(plans.map((p) => p.entries)).toEqual([
    [{ content: '读代码', status: 'in_progress' }, { content: '写测试', status: 'pending' }],
    [{ content: '读代码', status: 'completed' }, { content: '写测试', status: 'in_progress' }],
  ])
  expect(events.filter((e) => e.type === 'tool')).toEqual([])
  expect(textOf(events)).toBe('计划好了')
})

test('恢复：另一个驱动实例 loadSession 后用 resume 接着跑，只发新消息', async () => {
  const first = driver()
  const { sessionId } = await first.d.newSession(cwd)
  await first.d.prompt(sessionId, text('报会话'))
  expect(textOf(first.events)).toBe(`session:${sessionId} resumed:no prior:0\n`)
  first.d.kill()

  const second = driver()
  await second.d.loadSession(sessionId, cwd)
  await second.d.prompt(sessionId, text('报会话'))
  expect(textOf(second.events)).toBe(`session:${sessionId} resumed:${sessionId} prior:1\n`)
  second.events.length = 0
  await second.d.prompt(sessionId, text('回显提示词 第三条'))
  expect(textOf(second.events)).toBe('````\n回显提示词 第三条\n````\n')
})

test('取消：在飞的一轮按 cancelled 收尾；挂着的审批收掉并广播 resolved；之后照常能发', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  const slow = d.prompt(sessionId, text('慢慢来'))
  await until(() => events.find((e) => e.type === 'text'))
  d.cancel(sessionId)
  expect((await slow).stopReason).toBe('cancelled')
  expect(textOf(events).split('\n').filter(Boolean).length).toBeLessThan(10)

  events.length = 0
  const asking = d.prompt(sessionId, text('需要权限'))
  const perm = await until(() => events.find((e): e is PermissionEvent => e.type === 'permission'))
  d.cancel(sessionId)
  expect((await asking).stopReason).toBe('cancelled')
  expect(events.some((e) => e.type === 'permission_resolved' && e.requestId === perm.requestId)).toBe(true)
  expect(d.sessionState(sessionId).approvals).toEqual([])
  expect(d.busy).toBe(false)

  events.length = 0
  expect((await d.prompt(sessionId, text('你好'))).stopReason).toBe('end_turn')
  expect(textOf(events)).toMatch(/^turn:/)
})

test('受限会话：审批一律拒绝、不发事件；不给 MCP', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newRestrictedSession(cwd)
  expect(d.isRestricted(sessionId)).toBe(true)
  await d.prompt(sessionId, text('随手审批'))
  expect(textOf(events)).toBe('perm:reject_once\n')
  expect(events.some((e) => e.type === 'permission')).toBe(false)
  events.length = 0
  await d.prompt(sessionId, text('报 MCP'))
  expect(textOf(events)).toBe('mcp:none ? ? env:\n')
  expect(d.knownSessions()).not.toContain(sessionId)
})

test('Ramet 工具按 SDK 的 mcpServers 形状交给 claude；引用页是文字附件', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd, [{ mcp: { url: 'http://center.test', token: 'tok' } }])
  await d.prompt(sessionId, text('报 MCP'))
  expect(textOf(events)).toBe('mcp:ramet ramet.mjs http://center.test env:RAMET_PAGE_URL,RAMET_PAGE_TOKEN\n')
  events.length = 0
  await d.prompt(sessionId, [...text('报引用'), { type: 'resource', uri: 'ramet://page/1', mimeType: 'text/markdown', text: '正文', title: '页一' }])
  expect(textOf(events)).toBe('res:1\n')
})

test('出错：本轮失败带原因；CLI 半路退出时在飞的一轮以错误收尾，下一轮用 resume 重起同一个会话', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  await expect(d.prompt(sessionId, text('失败'))).rejects.toThrow('假 agent 按要求失败')
  await d.prompt(sessionId, text('你好'))
  await expect(d.prompt(sessionId, text('进程崩溃'))).rejects.toThrow(/code 3|crashed on purpose/)
  expect(d.busy).toBe(false)
  expect(d.alive).toBe(true)
  events.length = 0
  await d.prompt(sessionId, text('报会话'))
  expect(textOf(events)).toBe(`session:${sessionId} resumed:${sessionId} prior:1\n`)
})
