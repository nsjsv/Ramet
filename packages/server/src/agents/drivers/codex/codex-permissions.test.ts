/* ---------- Codex 原生驱动：审批 / 提问 / MCP 表单 / 配置项（假 codex 说 app-server 的 JSON-RPC）----------
 * 三类审批的决定值（允许一次 / 本会话总是允许 / 拒绝，没人作答按拒绝而不是中断整轮）；requestUserInput 多题 + 其他 + 密码字段；
 * MCP 表单；模型 / 推理强度 / 权限预设下一轮生效、初始值跟着用户自己的配置；受限会话没有配置项；版本过低 ready 失败。不连库。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, expect, test } from 'vitest'
import type { AgentConfig, AgentEvent, ConfigOption, PermissionEvent } from '../../types.js'
import { CodexThreadConfig, presetOf } from './config.js'
import { CodexDriver } from './driver.js'
import type { Model } from './protocol.js'

const FAKE_CODEX = fileURLToPath(new URL('../../fake/codex.mjs', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'codex-perm-test-'))
const cwd = mkdtempSync(join(tmpdir(), 'codex-perm-cwd-'))
afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const drivers: CodexDriver[] = []
afterEach(() => {
  for (const d of drivers.splice(0)) d.kill()
})

function driver(env: Record<string, string> = {}): { d: CodexDriver; events: AgentEvent[] } {
  const cfg: AgentConfig = { id: 'codex', label: 'Codex', command: FAKE_CODEX, driver: 'codex', env: { FAKE_CODEX_HOME: home, ...env } }
  const d = new CodexDriver(cfg)
  drivers.push(d)
  const events: AgentEvent[] = []
  d.on((ev) => events.push(ev))
  return { d, events }
}

const textOf = (events: AgentEvent[]): string => events.flatMap((e) => (e.type === 'text' && !e.parentId ? [e.delta] : [])).join('')
const text = (t: string) => [{ type: 'text' as const, text: t }]
const valueOf = (options: ConfigOption[], id: string): string | undefined => options.find((o) => o.id === id)?.currentValue
const valuesOf = (options: ConfigOption[], id: string): string[] | undefined => options.find((o) => o.id === id)?.options.map((v) => v.value)

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
async function asking(d: CodexDriver, events: AgentEvent[], sessionId: string, prompt: string): Promise<{ perm: PermissionEvent; run: Promise<unknown> }> {
  const before = events.length
  const run = d.prompt(sessionId, text(prompt))
  const perm = await until(() => events.slice(before).find((e): e is PermissionEvent => e.type === 'permission'))
  return { perm, run }
}

/** 一轮的回复（从 before 之后的事件里取） */
async function replyOf(events: AgentEvent[], before: number, run: Promise<unknown>): Promise<string> {
  await run
  return textOf(events.slice(before))
}

test('命令审批：codex 给了 acceptForSession 才摆「本会话总是允许」；三个选项各自回到 codex', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  let before = events.length
  let { perm, run } = await asking(d, events, sessionId, '需要权限 审批可总是')
  expect(perm.options.map((o) => o.optionId)).toEqual(['allow', 'allow-always', 'reject'])
  expect(perm.toolCall).toEqual({ toolCallId: 't1', title: 'npm test -- --run', kind: 'execute' })
  d.respondPermission(perm.requestId, 'allow-always')
  expect(await replyOf(events, before, run)).toBe('granted:allow_always\n')

  before = events.length
  ;({ perm, run } = await asking(d, events, sessionId, '需要权限 审批可总是'))
  d.respondPermission(perm.requestId, 'allow')
  expect(await replyOf(events, before, run)).toBe('granted:allow_once\n')

  before = events.length
  ;({ perm, run } = await asking(d, events, sessionId, '需要权限'))
  expect(perm.options.map((o) => o.optionId)).toEqual(['allow', 'reject'])
  d.respondPermission(perm.requestId, 'reject')
  expect(await replyOf(events, before, run)).toBe('granted:reject_once\n')
})

test('没人作答就被收掉的审批按「拒绝」应答（decline），不中断整轮', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  const before = events.length
  const { perm, run } = await asking(d, events, sessionId, '需要权限')
  expect(d.respondPermission(perm.requestId, null)).toBe(true)
  expect(await run).toMatchObject({ stopReason: 'end_turn' })
  expect(textOf(events.slice(before))).toBe('granted:reject_once\n')
})

test('改文件审批：允许一次 / 本会话总是允许 / 拒绝', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  for (const [optionId, reply] of [
    ['allow-always', 'granted:allow_always\n'],
    ['reject', 'granted:reject_once\n'],
  ] as const) {
    const before = events.length
    const { perm, run } = await asking(d, events, sessionId, '需要权限 审批改文件 审批可总是')
    expect(perm.options.map((o) => o.optionId)).toEqual(['allow', 'allow-always', 'reject'])
    expect(perm.toolCall).toMatchObject({ toolCallId: 't1', kind: 'edit' })
    d.respondPermission(perm.requestId, optionId)
    expect(await replyOf(events, before, run)).toBe(reply)
  }
})

test('要权限审批：允许 = 本轮、本会话允许 = scope session、拒绝 = 空的 permissions', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  for (const [optionId, reply] of [
    ['allow', 'granted:allow_once\n'],
    ['allow-always', 'granted:allow_always\n'],
    ['reject', 'granted:reject_once\n'],
  ] as const) {
    const before = events.length
    const { perm, run } = await asking(d, events, sessionId, '需要权限 审批要权限 审批可总是')
    expect(perm.title).toBe('访问网络')
    expect(perm.options.map((o) => o.optionId)).toEqual(['allow', 'allow-always', 'reject'])
    d.respondPermission(perm.requestId, optionId)
    expect(await replyOf(events, before, run)).toBe(reply)
  }
})

test('requestUserInput：每题一个选择字段 + 「其他」，没选项的密码题是 secret 文本框；答案按 codex TUI 的写法回去；跳过 = 空答案', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  let before = events.length
  let { perm, run } = await asking(d, events, sessionId, '提问')
  expect(perm.form?.toolCallId).toMatch(/^call_ask_/)
  expect(perm.toolCall).toMatchObject({ toolCallId: perm.form?.toolCallId, kind: 'other' })
  expect(perm.options.map((o) => o.optionId)).toEqual(['accept', 'decline'])
  const fields = perm.form!.fields
  expect(fields.map((f) => f.key)).toEqual(['question_0', 'question_0_custom', 'question_1', 'question_1_custom', 'question_2'])
  expect(fields[0]).toMatchObject({ kind: 'choice', multi: false, title: '包管理器', options: [{ value: 'npm' }, { value: 'pnpm' }] })
  expect(fields[4]).toMatchObject({ kind: 'text', title: 'Token', secret: true })
  d.respondPermission(perm.requestId, 'accept', { question_0: 'pnpm', question_1: 'Docs', question_1_custom: 'Bench', question_2: 'sk-1' })
  expect(await replyOf(events, before, run)).toBe(
    'answers:' + JSON.stringify({ '用哪个包管理器？': 'pnpm', '要哪些功能？': 'Docs, user_note: Bench', 'API token？': 'sk-1' }) + '\n',
  )

  // 只写了「其他」：选项记成「以上都不是」
  before = events.length
  ;({ perm, run } = await asking(d, events, sessionId, '提问'))
  d.respondPermission(perm.requestId, 'accept', { question_0_custom: 'yarn' })
  expect(await replyOf(events, before, run)).toBe('answers:' + JSON.stringify({ '用哪个包管理器？': 'None of the above, user_note: yarn' }) + '\n')

  before = events.length
  ;({ perm, run } = await asking(d, events, sessionId, '提问'))
  d.respondPermission(perm.requestId, 'decline')
  expect(await replyOf(events, before, run)).toBe('answers:declined\n')
})

test('MCP 表单：走同一份归一，答案原样回到 codex；跳过 = decline', async () => {
  const { d, events } = driver()
  const { sessionId } = await d.newSession(cwd)
  let before = events.length
  let { perm, run } = await asking(d, events, sessionId, '表单提问:opencode')
  expect(perm.form?.fields.map((f) => f.key)).toEqual(['pm', 'pm_custom'])
  d.respondPermission(perm.requestId, 'accept', { pm: 'bun' })
  expect(await replyOf(events, before, run)).toBe('ask:accept:{"pm":"bun"}\n')

  before = events.length
  ;({ perm, run } = await asking(d, events, sessionId, '表单提问:opencode'))
  d.respondPermission(perm.requestId, 'decline')
  expect(await replyOf(events, before, run)).toBe('ask:decline:null\n')
})

test('配置项：模型 / 推理强度 / 权限预设，改了发 config 事件、下一轮生效；换模型时推理档换成新模型支持的；不认识的值被拒', async () => {
  const { d, events } = driver()
  const { sessionId, configOptions } = await d.newSession(cwd)
  expect(valueOf(configOptions, 'model')).toBe('m1')
  expect(valuesOf(configOptions, 'model')).toEqual(['m1', 'm2'])
  expect(valueOf(configOptions, 'effort')).toBe('low')
  expect(valuesOf(configOptions, 'effort')).toEqual(['low', 'high'])
  expect(valueOf(configOptions, 'mode')).toBe('auto')
  expect(valuesOf(configOptions, 'mode')).toEqual(['auto', 'read-only', 'full-access'])

  let options = await d.setConfigOption(sessionId, 'model', 'm2')
  expect(valueOf(options, 'model')).toBe('m2')
  expect(valueOf(options, 'effort')).toBe('medium')
  expect(events.some((e) => e.type === 'config' && valueOf(e.options, 'model') === 'm2')).toBe(true)
  options = await d.setConfigOption(sessionId, 'mode', 'read-only')
  expect(valueOf(options, 'mode')).toBe('read-only')
  let before = events.length
  await d.prompt(sessionId, text('你好'))
  expect(textOf(events.slice(before))).toMatch(/model=m2 thinking=medium mode=on-request\/read-only/)

  await expect(d.setConfigOption(sessionId, 'effort', 'high')).rejects.toThrow(/没有这个选项/)
  await expect(d.setConfigOption(sessionId, 'mode', 'custom')).rejects.toThrow(/没有这个选项/)
  await expect(d.setConfigOption(sessionId, 'nope', 'x')).rejects.toThrow(/没有这个配置项/)
  // 选当前值不算覆盖，不发事件
  const configs = events.filter((e) => e.type === 'config').length
  await d.setConfigOption(sessionId, 'mode', 'read-only')
  expect(events.filter((e) => e.type === 'config').length).toBe(configs)

  // 完全访问：codex 不再要审批，直接执行
  await d.setConfigOption(sessionId, 'mode', 'full-access')
  before = events.length
  await d.prompt(sessionId, text('需要权限'))
  expect(textOf(events.slice(before))).toBe('granted:allow_once\n')
  expect(events.slice(before).some((e) => e.type === 'permission')).toBe(false)

  // 同一进程里重新加载（unsubscribe + resume）：选过的值还在
  await d.loadSession(sessionId, cwd)
  before = events.length
  await d.prompt(sessionId, text('审批模式'))
  expect(textOf(events.slice(before))).toBe('perm-mode:never/danger-full-access model:m2\n')
})

test('初始值跟着用户自己的配置：对不上任何预设显示「自定义」且不覆盖；完全访问的配置显示成完全访问', async () => {
  const custom = driver({ FAKE_CODEX_CONFIG: JSON.stringify({ model: 'm2', approval_policy: 'untrusted', sandbox_mode: 'workspace-write' }) })
  const a = await custom.d.newSession(cwd)
  expect(valueOf(a.configOptions, 'model')).toBe('m2')
  expect(valueOf(a.configOptions, 'effort')).toBe('medium')
  expect(valueOf(a.configOptions, 'mode')).toBe('custom')
  expect(valuesOf(a.configOptions, 'mode')).toEqual(['auto', 'read-only', 'full-access', 'custom'])
  await custom.d.prompt(a.sessionId, text('审批模式'))
  expect(textOf(custom.events)).toBe('perm-mode:untrusted/workspace-write model:m2\n')

  const full = driver({ FAKE_CODEX_CONFIG: JSON.stringify({ approval_policy: 'never', sandbox_mode: 'danger-full-access' }) })
  const b = await full.d.newSession(cwd)
  expect(valueOf(b.configOptions, 'mode')).toBe('full-access')
})

test('受限会话没有配置项，也改不了', async () => {
  const { d } = driver()
  const { sessionId, configOptions } = await d.newRestrictedSession(cwd)
  expect(configOptions).toEqual([])
  expect(d.sessionState(sessionId).configs).toEqual([])
  await expect(d.setConfigOption(sessionId, 'mode', 'full-access')).rejects.toThrow(/Unsupported session/)
})

test('codex 报的设置变了（thread/settings/updated）：当前值跟着变，用户选过的覆盖优先', () => {
  const models = [
    { id: 'm1', model: 'm1', displayName: 'M1', description: '', hidden: false, isDefault: true, inputModalities: [], defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'high', description: '' }] },
  ] satisfies Model[]
  const c = new CodexThreadConfig({ model: 'm1', effort: null, approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false } })
  expect(valueOf(c.options(models), 'mode')).toBe('read-only')
  expect(c.note(models, { effort: 'high' })).toBe(true)
  expect(valueOf(c.options(models), 'effort')).toBe('high')
  expect(c.note(models, { effort: 'high' })).toBe(false)
  c.set(models, 'effort', 'low')
  expect(c.note(models, { effort: 'high' })).toBe(false)
  expect(valueOf(c.options(models), 'effort')).toBe('low')
  expect(presetOf('on-request', { type: 'workspaceWrite', writableRoots: ['/x'], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false })).toBe('auto')
  expect(presetOf({ granular: { sandbox_approval: true, rules: true, skill_approval: true, request_permissions: true, mcp_elicitations: true } }, { type: 'dangerFullAccess' })).toBe('custom')
  expect(presetOf('never', { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false })).toBe('custom')
})

test('codex 版本低于最低版本：ready 失败并给出原因', async () => {
  const { d } = driver({ FAKE_CODEX_VERSION: '0.158.0' })
  await expect(d.ready()).rejects.toThrow(/0\.158\.0.*太旧/)
  expect(d.alive).toBe(false)
})
