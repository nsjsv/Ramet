/* ---------- Claude 原生驱动：审批 / 提问 / 计划审批 / MCP 表单 / 配置项（真 SDK + 假 claude）----------
 * 审批的「总是允许」与 CLI 的两个提示（不许给「总是」、不许一键批准）；AskUserQuestion 多题多选 + 自由输入的答案回到 CLI；
 * ExitPlanMode 的选项来自 CLI 的模式建议、批准后模式跟着变；MCP elicitation 表单；模型 / 模式 / 思考强度改了下一轮生效、
 * 进程重起后仍生效；用户自己的默认模式不被覆盖；会话记录不在时 load 失败；CLI 版本太旧 ready 失败。不连库。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, expect, test } from 'vitest'
import type { AgentConfig, AgentEvent, ConfigOption, PermissionEvent } from '../../types.js'
import { ClaudeDriver } from './driver.js'

const FAKE_CLAUDE = fileURLToPath(new URL('../../fake/claude.mjs', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'claude-perm-test-'))
const cwd = mkdtempSync(join(tmpdir(), 'claude-perm-cwd-'))
afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const drivers: ClaudeDriver[] = []
afterEach(() => {
  for (const d of drivers.splice(0)) d.kill()
})

function driver(env: Record<string, string> = {}): { d: ClaudeDriver; events: AgentEvent[] } {
  const cfg: AgentConfig = { id: 'claude', label: 'Claude', command: FAKE_CLAUDE, driver: 'claude', env: { FAKE_CLAUDE_HOME: home, ...env } }
  const d = new ClaudeDriver(cfg)
  drivers.push(d)
  const events: AgentEvent[] = []
  d.on((ev) => events.push(ev))
  return { d, events }
}

const textOf = (events: AgentEvent[]): string => events.flatMap((e) => (e.type === 'text' && !e.parentId ? [e.delta] : [])).join('')
const text = (t: string) => [{ type: 'text' as const, text: t }]
const valueOf = (options: ConfigOption[], id: string): string | undefined => options.find((o) => o.id === id)?.currentValue

async function until<T>(get: () => T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = get()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error('等不到')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** 发一轮并等到第一条审批 / 提问 */
async function asking(d: ClaudeDriver, events: AgentEvent[], sessionId: string, prompt: string): Promise<{ perm: PermissionEvent; run: Promise<unknown> }> {
  const before = events.length
  const run = d.prompt(sessionId, text(prompt))
  const perm = await until(() => events.slice(before).find((e): e is PermissionEvent => e.type === 'permission'))
  return { perm, run }
}

test('审批：有建议规则时多一个「总是允许」，批准把规则带回 CLI；CLI 说不许给「总是」就没有；toolCall 只有 id / 标题 / 种类', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  let { perm, run } = await asking(d, events, sessionId, '需要权限 审批可总是')
  expect(perm.options.map((o) => o.optionId)).toEqual(['allow', 'allow-always', 'reject'])
  expect(perm.options[1]).toMatchObject({ kind: 'allow_always' })
  expect(perm.toolCall).toEqual({ toolCallId: 't1', title: 'npm test -- --run', kind: 'execute' })
  expect(perm.view).toMatchObject({ tool: 'Bash', command: 'npm test -- --run' })
  expect(perm.defaultToNo).toBeUndefined()
  d.respondPermission(perm.requestId, 'allow-always')
  await run
  expect(textOf(events)).toBe('granted:allow_always\n')

  events.length = 0
  ;({ perm, run } = await asking(d, events, sessionId, '需要权限 审批可总是 审批禁总是'))
  expect(perm.options.map((o) => o.optionId)).toEqual(['allow', 'reject'])
  d.respondPermission(perm.requestId, 'allow')
  await run
  expect(textOf(events)).toBe('granted:allow_once\n')
})

test('审批：CLI 要求不许一键批准时拒绝排在最前（主按钮落在拒绝上），事件带 defaultToNo', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  const { perm, run } = await asking(d, events, sessionId, '需要权限 审批默认拒')
  expect(perm.options.map((o) => o.optionId)).toEqual(['reject', 'allow'])
  expect(perm.defaultToNo).toBe(true)
  d.respondPermission(perm.requestId, 'reject')
  await run
  expect(textOf(events)).toBe('granted:reject_once\n')
})

test('AskUserQuestion：多题（单选 + 多选）各带一个「其他」，答案按题干回到 CLI；多选的「其他」并进勾选项；跳过 = 拒绝', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  let { perm, run } = await asking(d, events, sessionId, '提问')
  const form = perm.form!
  expect(perm.options.map((o) => o.optionId)).toEqual(['accept', 'decline'])
  expect(form.message).toBe('请回答下面这些问题')
  expect(form.toolCallId).toMatch(/^toolu_ask_/)
  expect(perm.toolCall).toEqual({ toolCallId: form.toolCallId, title: 'AskUserQuestion', kind: 'other' })
  expect(form.fields.map((f) => [f.key, f.kind, f.kind === 'choice' ? f.multi : null])).toEqual([
    ['question_0', 'choice', false],
    ['question_0_custom', 'text', null],
    ['question_1', 'choice', true],
    ['question_1_custom', 'text', null],
  ])
  expect(form.fields[0]).toMatchObject({ title: '包管理器', description: '用哪个包管理器？', options: [{ value: 'npm', label: 'npm', description: '默认' }, { value: 'pnpm', label: 'pnpm', description: '更快' }] })
  expect(form.required).toEqual([])
  d.respondPermission(perm.requestId, 'accept', { question_0: 'pnpm', question_0_custom: '锁版本', question_1: ['Lint', 'Docs'], question_1_custom: 'Bench' })
  await run
  expect(textOf(events)).toBe('answers:' + JSON.stringify({ '用哪个包管理器？': 'pnpm', '要哪些功能？': 'Lint, Docs, Bench' }) + '\n')

  // 单选没选、只写了「其他」：「其他」就是答案
  events.length = 0
  ;({ perm, run } = await asking(d, events, sessionId, '提问'))
  d.respondPermission(perm.requestId, 'accept', { question_0_custom: 'bun' })
  await run
  expect(textOf(events)).toBe('answers:' + JSON.stringify({ '用哪个包管理器？': 'bun' }) + '\n')

  events.length = 0
  ;({ perm, run } = await asking(d, events, sessionId, '提问'))
  d.respondPermission(perm.requestId, 'decline')
  await run
  expect(textOf(events)).toBe('answers:declined\n')
})

test('ExitPlanMode：选项来自 CLI 的模式建议（不提权的在前），批准并切到 bypass 后模式跟着变；继续规划 = 拒绝', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  let { perm, run } = await asking(d, events, sessionId, '退出计划')
  expect(perm.options.map((o) => o.optionId)).toEqual(['exit-plan:default', 'exit-plan:bypassPermissions', 'reject'])
  expect(perm.toolCall).toEqual({ toolCallId: 'plan-1', title: 'ExitPlanMode', kind: 'switch_mode' })
  d.respondPermission(perm.requestId, 'exit-plan:bypassPermissions')
  await run
  expect(textOf(events)).toBe('plan-exit:exit-plan-bypass\n')
  expect(valueOf(d.sessionState(sessionId).configs, 'mode')).toBe('bypassPermissions')
  expect(events.some((e) => e.type === 'config' && valueOf(e.options, 'mode') === 'bypassPermissions')).toBe(true)

  // 回到逐步确认（bypass 下不再问），再来一次选「继续规划」
  await d.setConfigOption(sessionId, 'mode', 'default')
  events.length = 0
  ;({ perm, run } = await asking(d, events, sessionId, '退出计划'))
  d.respondPermission(perm.requestId, 'reject')
  await run
  expect(textOf(events)).toBe('plan-exit:reject\n')
})

test('MCP elicitation：表单走同一份归一，答案原样回到 CLI；跳过 = decline', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  let { perm, run } = await asking(d, events, sessionId, '表单提问:opencode')
  expect(perm.form).toMatchObject({ message: 'Which package manager?', required: ['pm'] })
  expect(perm.form?.fields.map((f) => f.key)).toEqual(['pm', 'pm_custom'])
  d.respondPermission(perm.requestId, 'accept', { pm: 'npm' })
  await run
  expect(textOf(events)).toBe('ask:accept:{"pm":"npm"}\n')

  events.length = 0
  ;({ perm, run } = await asking(d, events, sessionId, '表单提问:opencode'))
  d.respondPermission(perm.requestId, 'decline')
  await run
  expect(textOf(events)).toBe('ask:decline:null\n')
})

test('配置项：改模型 / 模式 / 思考强度当场生效（发 config 事件），下一轮与进程重起后都还是新值；不认识的值被拒', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  let options = await d.setConfigOption(sessionId, 'model', 'm2')
  expect(valueOf(options, 'model')).toBe('m2')
  // m2 不支持 effort：没有思考强度这一项
  expect(options.some((o) => o.id === 'effort')).toBe(false)
  expect(events.some((e) => e.type === 'config' && valueOf(e.options, 'model') === 'm2')).toBe(true)
  options = await d.setConfigOption(sessionId, 'mode', 'acceptEdits')
  expect(valueOf(options, 'mode')).toBe('acceptEdits')
  await d.prompt(sessionId, text('审批模式'))
  expect(textOf(events)).toBe('perm-mode:acceptEdits model:m2\n')

  options = await d.setConfigOption(sessionId, 'model', 'm1')
  options = await d.setConfigOption(sessionId, 'effort', 'high')
  expect(valueOf(options, 'effort')).toBe('high')
  await expect(d.setConfigOption(sessionId, 'effort', 'max')).rejects.toThrow(/没有这个选项/)
  await expect(d.setConfigOption(sessionId, 'nope', 'x')).rejects.toThrow(/没有这个配置项/)

  // 进程没了，下一轮 resume 重起时带上选过的值
  await expect(d.prompt(sessionId, text('进程崩溃'))).rejects.toThrow()
  events.length = 0
  await d.prompt(sessionId, text('你好'))
  expect(textOf(events)).toMatch(/model=m1 thinking=high mode=acceptEdits/)
})

test('用户自己的默认模式不被覆盖：没选过就不传，第一轮 CLI 报的模式成为当前值', async () => {
  const { d, events } = driver({ FAKE_MODE: 'acceptEdits' })
  const { sessionId } = await d.newSession(cwd)
  await d.prompt(sessionId, text('审批模式'))
  expect(textOf(events)).toBe('perm-mode:acceptEdits model:m1\n')
  expect(valueOf(d.sessionState(sessionId).configs, 'mode')).toBe('acceptEdits')
})

test('受限会话固定在逐步确认，不吃用户配置里的模式', async () => {
  const { d, events } = driver({ FAKE_MODE: 'acceptEdits' })
  const { sessionId } = await d.newRestrictedSession(cwd)
  await d.prompt(sessionId, text('审批模式'))
  expect(textOf(events)).toBe('perm-mode:default model:m1\n')
})

test('加载 CLI 那边没有记录的会话：失败带原因，会话不留在驱动里', async () => {
  const { d } = driver()
  await expect(d.loadSession('00000000-0000-4000-8000-000000000000', cwd)).rejects.toThrow(/No conversation found|claude/)
  await expect(d.prompt('00000000-0000-4000-8000-000000000000', text('你好'))).rejects.toThrow(/Unsupported session/)
})

test('CLI 版本低于最低版本：ready 失败并给出原因', async () => {
  const { d } = driver({ FAKE_CLAUDE_VERSION: '2.0.1' })
  await expect(d.ready()).rejects.toThrow(/2\.0\.1.*太旧/)
  expect(d.alive).toBe(false)
})
