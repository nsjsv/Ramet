/* ---------- Codex 原生驱动：假 codex（fake/codex.mjs）说 app-server 的 JSON-RPC ----------
 * 流式正文、命令步骤视图与实时输出、改文件 diff、子代理归属与单独停止、计划、用量、换实例 resume 只发新消息、
 * 同一进程里换工具凭证（unsubscribe + resume）、取消收掉待批、受限会话、进程崩溃。不连库。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, expect, test } from 'vitest'
import { mergeView, type ToolView } from '@ramet/shared/run-model'
import type { AgentConfig, AgentEvent, PermissionEvent } from '../../types.js'
import { CodexDriver } from './driver.js'

const FAKE_CODEX = fileURLToPath(new URL('../../fake/codex.mjs', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'codex-driver-test-'))
const cwd = mkdtempSync(join(tmpdir(), 'codex-driver-cwd-'))
afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const cfg: AgentConfig = { id: 'codex', label: 'Codex', command: FAKE_CODEX, driver: 'codex', env: { FAKE_CODEX_HOME: home } }
const drivers: CodexDriver[] = []
afterEach(() => {
  for (const d of drivers.splice(0)) d.kill()
})

function driver(extraEnv: Record<string, string> = {}): { d: CodexDriver; events: AgentEvent[] } {
  const d = new CodexDriver({ ...cfg, env: { ...cfg.env, ...extraEnv } })
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
const tool = (token: string) => ({ mcp: { url: `http://center.test/${token}`, token } })

test('流式正文、用量与 stop reason；ready 起进程握手，会话事件都带 sessionId', async () => {
  const { d, events } = driver()
  expect(d.pristine).toBe(true)
  await d.ready()
  expect(d.alive).toBe(true)
  expect(d.pristine).toBe(false)
  const { sessionId } = await d.newSession(cwd)
  const res = await d.prompt(sessionId, text('你好'))
  const reply = 'turn:full model=m1 thinking=low mode=on-request/workspace-write\n'
  expect(res.stopReason).toBe('end_turn')
  expect(res.usage).toMatchObject({ input: 2, output: reply.length, cacheRead: 0 })
  expect(textOf(events)).toBe(reply)
  expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(0)
  expect(events.every((e) => !('sessionId' in e) || e.sessionId === sessionId)).toBe(true)
  expect(events.find((e) => e.type === 'usage')).toMatchObject({ size: 200000 })
  const info = events.filter((e): e is Extract<AgentEvent, { type: 'info' }> => e.type === 'info').at(-1)
  expect(info?.info).toMatchObject({ stopReason: 'end_turn', usage: { input: 2 } })
  expect(d.busy).toBe(false)
  // 同一线程第二轮是增量
  events.length = 0
  await d.prompt(sessionId, text('再来'))
  expect(textOf(events)).toContain('turn:delta')
  await expect(d.prompt('no-such-session', text('你好'))).rejects.toThrow(/Unsupported session/)
})

test('起不来：ready 失败并把自己标成死的', async () => {
  const d = new CodexDriver({ ...cfg, command: join(cwd, 'no-codex') })
  drivers.push(d)
  await expect(d.ready()).rejects.toThrow(/no-codex/)
  expect(d.alive).toBe(false)
  expect(d.pristine).toBe(false)
})

test('工具步骤：读文件 = read（路径），命令 = execute（命令 / 结果 / 退出码）；命令的实时输出进 terminal 事件', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  await d.prompt(sessionId, text('用工具'))
  let s = steps(events)
  expect(s.get('call-1')).toMatchObject({
    kind: 'read',
    title: 'packages/server/src/agents/acp.ts',
    detail: 'packages/server/src/agents/acp.ts',
    status: 'completed',
    view: { tool: 'commandExecution', path: 'packages/server/src/agents/acp.ts', command: 'cat packages/server/src/agents/acp.ts', result: 'ok', exit: { code: 0, signal: null } },
  })
  expect(s.get('call-2')).toMatchObject({ kind: 'execute', title: '跑测试', status: 'completed', view: { command: '跑测试', result: 'ok', exit: { code: 0, signal: null } } })
  expect(textOf(events)).toBe('tool-done\n')

  events.length = 0
  await d.prompt(sessionId, text('多段'))
  s = steps(events)
  expect(s.get('m-2')).toMatchObject({ kind: 'execute', status: 'failed', note: '2 failed · doc.test.ts', view: { exit: { code: 1, signal: null } } })
  expect(s.get('m-2')?.view?.result).toContain('2 failed · doc.test.ts')
  const live = events.filter((e): e is Extract<AgentEvent, { type: 'terminal' }> => e.type === 'terminal' && e.id === 'm-2')
  expect(live.map((e) => e.delta).join('')).toBe('\n2 failed · doc.test.ts\n详情\n')
  // 思考与正文分开，正文不粘连
  expect(events.some((e) => e.type === 'thought' && e.delta === '先想想')).toBe(true)
})

test('审批：命令 / 改文件挂成审批卡（toolCall 只放 id / 标题 / 种类，详情在视图），允许 / 拒绝回到 codex；diff 进步骤视图', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  const run = d.prompt(sessionId, text('需要权限 审批改文件'))
  const perm = await until(() => events.find((e): e is PermissionEvent => e.type === 'permission'))
  expect(perm.toolCall).toEqual({ toolCallId: 't1', title: 'src/app.ts', kind: 'edit' })
  expect(perm.view?.diffs).toEqual([{ path: 'src/app.ts', old: 'const port = 3000\n', new: 'const port = Number(process.env.PORT ?? 3000)\n' }])
  expect(perm.options.map((o) => o.optionId)).toEqual(['allow', 'allow-always', 'reject'])
  expect(d.busy).toBe(true)
  expect(d.respondPermission(perm.requestId, 'allow')).toBe(true)
  await run
  expect(textOf(events)).toBe('granted:allow_once\n')
  expect(steps(events).get('t1')).toMatchObject({ kind: 'edit', status: 'completed', view: { tool: 'fileChange', path: 'src/app.ts' } })

  events.length = 0
  const run2 = d.prompt(sessionId, text('需要权限'))
  const perm2 = await until(() => events.find((e): e is PermissionEvent => e.type === 'permission'))
  expect(perm2.view).toMatchObject({ command: 'npm test -- --run' })
  // 这次 codex 没给「本会话总是允许」
  expect(perm2.options.map((o) => o.optionId)).toEqual(['allow', 'reject'])
  d.respondPermission(perm2.requestId, 'reject')
  await run2
  expect(textOf(events)).toBe('granted:reject_once\n')
  expect(steps(events).get('t1')).toMatchObject({ status: 'failed', note: '已拒绝' })
  expect(events.some((e) => e.type === 'permission_resolved' && e.requestId === perm2.requestId)).toBe(true)
  expect(d.busy).toBe(false)
})

test('子代理：一步可停（handle = 子线程 id），子线程的步骤与正文挂在它下面；单独停掉子代理，主回合照常收尾', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  await d.prompt(sessionId, text('起子代理'))
  const s = steps(events)
  const agent = s.get('toolu_agent_1')
  expect(agent).toMatchObject({ kind: 'think', title: '找出 run-finalize 的收尾出口', status: 'completed', activity: '', view: { tool: 'collabAgent' } })
  const child = agent?.view?.handle
  expect(child).toBeTruthy()
  expect(child).not.toBe(sessionId)
  expect(s.get('toolu_agent_1_s1')).toMatchObject({ kind: 'read', parentId: 'toolu_agent_1', status: 'completed', view: { path: 'src/run-finalize.ts', result: '共 80 行' } })
  expect(s.get('toolu_agent_1_s2')).toMatchObject({ kind: 'execute', parentId: 'toolu_agent_1', view: { command: 'grep -n finally src/run-finalize.ts' } })
  expect(textOf(events, 'toolu_agent_1')).toBe('子代理：开始查找。')
  expect(textOf(events)).toBe('subagent:completed\n')
  // 子线程的事件也归主会话（RunRecord 按 sessionId 认这一轮）
  expect(events.every((e) => !('sessionId' in e) || e.sessionId === sessionId)).toBe(true)
  expect(d.killCommand(sessionId, child!)).toBe(false)

  events.length = 0
  const run = d.prompt(sessionId, text('起子代理慢'))
  const handle = await until(() => (steps(events).get('toolu_agent_2')?.status === 'in_progress' ? steps(events).get('toolu_agent_2')?.view?.handle : undefined))
  await until(() => (d.killCommand(sessionId, handle) ? true : undefined))
  const res = await run
  expect(res.stopReason).toBe('end_turn')
  expect(textOf(events)).toBe('subagent:stopped\n')
  expect(steps(events).get('toolu_agent_2')).toMatchObject({ status: 'failed', note: '已停止' })
  expect(d.killCommand('other-session', handle)).toBe(false)
})

test('计划：turn/plan/updated 变成整份 plan，不产生步骤', async () => {
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

test('恢复：另一个驱动实例 loadSession 后 resume 接着跑，只发新消息；没落盘的线程 load 抛错', async () => {
  const first = driver()
  const { sessionId } = await first.d.newSession(cwd)
  const empty = await first.d.newSession(cwd)
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
  await expect(second.d.loadSession(empty.sessionId, cwd)).rejects.toThrow(/no rollout found/)
})

test('同一进程里重新 load：先 unsubscribe 再 resume，新的工具凭证生效；用户配置里有同名服务时换名注入', async () => {
  const { d, events } = driver({ FAKE_CODEX_CONFIG: JSON.stringify({ mcp_servers: { ramet: { url: 'http://user.test/mcp' } } }) })
  const { sessionId } = await d.newSession(cwd, [tool('A')])
  await d.prompt(sessionId, text('报 MCP'))
  expect(textOf(events)).toBe('mcp:ramet-page ramet.mjs http://center.test/A env:RAMET_PAGE_URL,RAMET_PAGE_TOKEN\n')
  events.length = 0
  await d.loadSession(sessionId, cwd, [tool('B')])
  await d.prompt(sessionId, text('报 MCP'))
  expect(textOf(events)).toBe('mcp:ramet-page ramet.mjs http://center.test/B env:RAMET_PAGE_URL,RAMET_PAGE_TOKEN\n')
  events.length = 0
  await d.prompt(sessionId, [...text('报引用'), { type: 'resource', uri: 'ramet://page/1', mimeType: 'text/markdown', text: '正文', title: '页一' }])
  expect(textOf(events)).toBe('res:1\n')
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

test('同一线程的 prompt 串行：第二条等第一条收尾才发；取消时排着的那条直接按取消收尾', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  const a = d.prompt(sessionId, text('慢慢来'))
  const b = d.prompt(sessionId, text('报会话'))
  expect((await a).stopReason).toBe('end_turn')
  expect((await b).stopReason).toBe('end_turn')
  expect(textOf(events)).toContain(`session:${sessionId}`)

  const c = d.prompt(sessionId, text('慢慢来'))
  const queued = d.prompt(sessionId, text('你好'))
  await until(() => (d.busy ? true : undefined))
  d.cancel(sessionId)
  expect((await c).stopReason).toBe('cancelled')
  expect((await queued).stopReason).toBe('cancelled')
})

test('受限会话：审批一律拒绝、不发事件；用户配置里的 MCP 被关掉；不对中心露面', async () => {
  const { d, events } = driver({ FAKE_CODEX_CONFIG: JSON.stringify({ mcp_servers: { mine: { command: 'node', args: ['x.mjs'] } } }) })
  const { sessionId } = await d.newRestrictedSession(cwd)
  expect(d.isRestricted(sessionId)).toBe(true)
  await d.prompt(sessionId, text('随手审批'))
  expect(textOf(events)).toBe('perm:reject_once\n')
  expect(events.some((e) => e.type === 'permission')).toBe(false)
  events.length = 0
  await d.prompt(sessionId, text('报 MCP'))
  expect(textOf(events)).toBe('mcp:none ? ? env:\n')
  expect(d.knownSessions()).not.toContain(sessionId)
  // 普通会话照样能看到用户自己的 MCP（对照）
  const normal = await d.newSession(cwd)
  events.length = 0
  await d.prompt(normal.sessionId, text('报 MCP'))
  expect(textOf(events)).toBe('mcp:mine x.mjs ? env:\n')
  d.discardSession(sessionId)
  expect(d.isRestricted(sessionId)).toBe(false)
})

test('出错：本轮失败带原因；进程半路退出时在飞的一轮以错误收尾、适配器死掉，新实例 resume 同一个线程', async () => {
  const { d } = driver()
  const { sessionId } = await d.newSession(cwd)
  await expect(d.prompt(sessionId, text('失败'))).rejects.toThrow('假 agent 按要求失败')
  await d.prompt(sessionId, text('你好'))
  await expect(d.prompt(sessionId, text('进程崩溃'))).rejects.toThrow(/退出码 3.*crashed on purpose/)
  expect(d.busy).toBe(false)
  expect(d.alive).toBe(false)
  await expect(d.prompt(sessionId, text('你好'))).rejects.toThrow(/已停止/)

  const next = driver()
  await next.d.loadSession(sessionId, cwd)
  await next.d.prompt(sessionId, text('报会话'))
  expect(textOf(next.events)).toBe(`session:${sessionId} resumed:${sessionId} prior:1\n`)
})
