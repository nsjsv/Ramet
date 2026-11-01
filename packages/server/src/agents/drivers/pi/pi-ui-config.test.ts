/* ---------- pi / omp 原生驱动：扩展 UI 对话框与配置项（假 CLI fake/pi-rpc.mjs）----------
 * 对话框：pi 的 select 一律是提问（标题像审批也不算）；input / editor = 文字提问；omp 审批 select 挂在主线或子代理里那一步上、
 * 拒绝 / 停止；ask 的 recommended 作默认值、只填「其他」、跳过。
 * 配置：模型 / 思考档位的选项与当前值、当场生效与下一轮生效、换模型后档位跟着变、进程重起后补发；omp 审批档换档重起、
 * 跟随配置不传参数、在跑的一轮不打断；受限会话没有配置项。不连库。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import type { AgentEvent, AskContent, ConfigOption, PermissionEvent } from '../../types.js'
import { askAnswers, askForm, approvalTool, PiUi, type UiHost } from './ui.js'
import { RpcAgentDriver } from './driver.js'
import type { PiDialect, UiAnswer, UiDialogRequest } from './protocol.js'

const FAKE = fileURLToPath(new URL('../../fake/pi-rpc.mjs', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'pi-ui-home-'))
const sessions = mkdtempSync(join(tmpdir(), 'pi-ui-sessions-'))
const cwd = mkdtempSync(join(tmpdir(), 'pi-ui-cwd-'))
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

const textOf = (events: AgentEvent[]): string => events.flatMap((e) => (e.type === 'text' && !e.parentId ? [e.delta] : [])).join('')
const text = (t: string) => [{ type: 'text' as const, text: t }]
const valueOf = (options: ConfigOption[], id: string): string | undefined => options.find((o) => o.id === id)?.currentValue
const valuesOf = (options: ConfigOption[], id: string): string[] | undefined => options.find((o) => o.id === id)?.options.map((v) => v.value)
const lastConfig = (events: AgentEvent[]): ConfigOption[] | undefined =>
  events.filter((e): e is Extract<AgentEvent, { type: 'config' }> => e.type === 'config').at(-1)?.options

async function until<T>(get: () => T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = get()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error('等不到')
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function asking(d: RpcAgentDriver, events: AgentEvent[], sessionId: string, prompt: string): Promise<{ perm: PermissionEvent; run: Promise<unknown> }> {
  const before = events.length
  const run = d.prompt(sessionId, text(prompt))
  const perm = await until(() => events.slice(before).find((e): e is PermissionEvent => e.type === 'permission'))
  return { perm, run }
}

/** 直接驱动 PiUi：记下挂起的卡片，按需作答 */
function ui(dialect: PiDialect, restricted = false) {
  const held: Array<{ event: PermissionEvent; settle: (optionId: string | null, content?: AskContent) => void; turnOf?: string }> = []
  let n = 0
  const host: UiHost = {
    sessionId: 's1',
    dialect,
    restricted,
    nextId: () => `perm-${n++}`,
    hold: (event, settle, _signal, turnOf) => void held.push({ event, settle, ...(turnOf ? { turnOf } : {}) }),
    inTurn: () => true,
    claimLive: () => undefined,
    claimRequested: () => undefined,
    faceOf: () => undefined,
  }
  const handle = (req: Record<string, unknown>): Promise<UiAnswer> =>
    Promise.resolve(new PiUi(host).handle({ type: 'extension_ui_request', id: 'x', ...req } as UiDialogRequest, new AbortController().signal))
  return { held, handle }
}

describe('对话框（不起进程）', () => {
  test('pi 的 select 是提问（标题像审批也不当审批），选项说明带上；omp 同样形状的才是审批', async () => {
    const req: Extract<UiDialogRequest, { method: 'select' }> = { type: 'extension_ui_request', id: 'x', method: 'select', title: 'Allow tool: bash', options: ['Approve', 'Deny'] }
    expect(approvalTool(req, 'pi')).toBeNull()
    expect(approvalTool(req, 'omp')).toBe('bash')
    expect(approvalTool({ ...req, options: ['Approve File', 'Deny'] }, 'omp')).toBeNull()

    const { held, handle } = ui('pi')
    const answer = handle({ method: 'select', title: 'Allow tool: bash', options: ['Approve', 'Deny'], optionDetails: [{ description: '同意' }, {}] })
    const card = await until(() => held[0])
    expect(card.event.form?.fields).toEqual([
      { key: 'value', kind: 'choice', options: [{ value: 'Approve', label: 'Approve', description: '同意' }, { value: 'Deny', label: 'Deny' }], multi: false },
    ])
    expect(card.event.options.map((o) => o.optionId)).toEqual(['accept', 'decline'])
    expect(card.turnOf).toBe('s1')
    card.settle('accept', { value: 'Deny' })
    expect(await answer).toEqual({ value: 'Deny' })
  })

  test('input / editor = 文字提问（密码、预填）；跳过 / 收掉 = cancelled；受限会话不发卡', async () => {
    const { held, handle } = ui('pi')
    const a = handle({ method: 'input', title: 'Token?', secret: true })
    const b = handle({ method: 'editor', title: '改一下', prefill: '原文' })
    await until(() => (held.length === 2 ? true : undefined))
    expect(held[0]!.event.form?.fields).toEqual([{ key: 'value', kind: 'text', secret: true }])
    expect(held[1]!.event.form?.fields).toEqual([{ key: 'value', kind: 'text', default: '原文' }])
    held[0]!.settle('accept', { value: 'sk-1' })
    held[1]!.settle(null)
    expect(await a).toEqual({ value: 'sk-1' })
    expect(await b).toEqual({ cancelled: true })

    const r = ui('pi', true)
    expect(await r.handle({ method: 'confirm', title: 'Run?', message: 'rm' })).toEqual({ confirmed: false })
    expect(await r.handle({ method: 'input', title: 'x' })).toEqual({ cancelled: true })
    expect(r.held).toEqual([])
  })

  test('ask：recommended 作默认选中（多选题是数组），只填「其他」的单选以它为准，没答的题回空选项', () => {
    const questions = [
      { id: 'pm', question: 'Which package manager?', header: 'PM', options: [{ label: 'npm', description: 'default' }, { label: 'pnpm' }], recommended: 1 },
      { id: 'feat', question: 'Which features?', options: [{ label: 'Lint' }, { label: 'Docs' }], multi: true, recommended: 0 },
      { id: 'name', question: 'Project name?', options: [] },
    ]
    const form = askForm(questions, 'call_ask_1')!
    expect(form.toolCallId).toBe('call_ask_1')
    expect(form.fields.map((f) => [f.key, f.kind, 'default' in f ? f.default : undefined])).toEqual([
      ['question_0', 'choice', 'pnpm'],
      ['question_0_custom', 'text', undefined],
      ['question_1', 'choice', ['Lint']],
      ['question_1_custom', 'text', undefined],
      ['question_2', 'text', undefined],
    ])
    expect(askAnswers(questions, { question_0: 'npm', question_0_custom: 'yarn', question_1: ['Lint', 'Docs'], question_1_custom: 'Bench', question_2: 'demo' })).toEqual([
      { id: 'pm', selectedOptions: [], customInput: 'yarn' },
      { id: 'feat', selectedOptions: ['Lint', 'Docs'], customInput: 'Bench' },
      { id: 'name', selectedOptions: [], customInput: 'demo' },
    ])
    expect(askAnswers(questions, {})).toEqual([
      { id: 'pm', selectedOptions: [] },
      { id: 'feat', selectedOptions: [] },
      { id: 'name', selectedOptions: [] },
    ])
  })
})

describe('omp 对话框（假 omp）', () => {
  test('子代理里的工具要审批：卡片挂在子代理那一步上；拒绝回到 omp，那一步失败', async () => {
    const { d, events } = driver('omp', { FAKE_OMP_APPROVAL: 'always-ask' })
    const { sessionId } = await d.newSession(cwd)
    const { perm, run } = await asking(d, events, sessionId, '起子代理审批')
    expect(perm.options.map((o) => o.optionId)).toEqual(['allow', 'allow-always', 'reject'])
    expect(perm.toolCall?.toolCallId).toMatch(/^Sub\d+#toolu_agent_1_s1$/)
    expect(perm.toolCall).toEqual({ toolCallId: perm.toolCall?.toolCallId, title: 'src/run-finalize.ts', kind: 'read' })
    const step = events.find((e) => e.type === 'tool' && e.id === perm.toolCall?.toolCallId)
    expect(step).toMatchObject({ parentId: 'toolu_agent_1' })
    d.respondPermission(perm.requestId, 'reject')
    await run
    expect(textOf(events)).toContain('sub-perm:reject_once\n')
    const last = events.filter((e) => e.type === 'tool' && e.id === perm.toolCall?.toolCallId && e.status).at(-1)
    expect(last).toMatchObject({ status: 'failed' })
  })

  test('审批：允许一次 / 拒绝回到 omp；停止时挂着的审批收掉', async () => {
    const { d, events } = driver('omp', { FAKE_OMP_APPROVAL: 'always-ask' })
    const { sessionId } = await d.newSession(cwd)
    let { perm, run } = await asking(d, events, sessionId, '需要权限')
    expect(perm.options.map((o) => o.optionId)).toEqual(['allow', 'allow-always', 'reject'])
    d.respondPermission(perm.requestId, 'allow')
    await run
    expect(textOf(events)).toBe('granted:allow_once\n')

    events.length = 0
    ;({ perm, run } = await asking(d, events, sessionId, '需要权限'))
    d.respondPermission(perm.requestId, 'reject')
    await run
    expect(textOf(events)).toBe('granted:reject_once\n')

    events.length = 0
    ;({ perm, run } = await asking(d, events, sessionId, '需要权限'))
    d.cancel(sessionId)
    expect(await run).toMatchObject({ stopReason: 'cancelled' })
    expect(events.some((e) => e.type === 'permission_resolved' && e.requestId === perm.requestId)).toBe(true)
    expect(d.busy).toBe(false)
  })

  test('ask：跳过 = cancelled（omp 当作用户取消）', async () => {
    const { d, events } = driver('omp')
    const { sessionId } = await d.newSession(cwd)
    const { perm, run } = await asking(d, events, sessionId, '提问')
    d.respondPermission(perm.requestId, 'decline')
    await run
    expect(textOf(events)).toBe('answers:declined\n')
  })
})

describe.each(['pi', 'omp'] as const)('%s 配置项', (dialect) => {
  test('模型（provider/id）与思考档位来自 CLI；切思考档位当场生效；换到不支持推理的模型后档位项消失', async () => {
    const { d, events } = driver(dialect)
    const { sessionId, configOptions } = await d.newSession(cwd)
    events.length = 0
    expect(valueOf(configOptions, 'model')).toBe('fake/m1')
    expect(valuesOf(configOptions, 'model')).toEqual(['fake/m1', 'fake/m2'])
    expect(valueOf(configOptions, 'thinking')).toBe('medium')
    expect(valuesOf(configOptions, 'thinking')).toEqual(['off', 'minimal', 'low', 'medium', 'high', ...(dialect === 'omp' ? ['xhigh'] : [])])
    expect(configOptions.find((o) => o.id === 'thinking')?.category).toBe('thought_level')
    expect(valueOf(configOptions, 'mode')).toBe(dialect === 'omp' ? 'config' : undefined)

    // 选当前值不算覆盖、不发事件
    expect(valueOf(await d.setConfigOption(sessionId, 'thinking', 'medium'), 'thinking')).toBe('medium')
    expect(events.some((e) => e.type === 'config')).toBe(false)

    const after = await d.setConfigOption(sessionId, 'thinking', 'high')
    expect(valueOf(after, 'thinking')).toBe('high')
    expect(valueOf(lastConfig(events) ?? [], 'thinking')).toBe('high')
    await d.prompt(sessionId, text('你好'))
    expect(textOf(events)).toContain('thinking=high')

    events.length = 0
    const m2 = await d.setConfigOption(sessionId, 'model', 'fake/m2')
    expect(valueOf(m2, 'model')).toBe('fake/m2')
    expect(m2.some((o) => o.id === 'thinking')).toBe(false)
    await d.prompt(sessionId, text('审批模式'))
    expect(textOf(events)).toContain('model:fake/m2')
    await expect(d.setConfigOption(sessionId, 'thinking', 'high')).rejects.toThrow(/没有这个配置项/)
  })

  test('进程重起后补发选过的值（omp 换审批档会重起进程；pi 用崩溃重起）', async () => {
    const { d, events } = driver(dialect)
    const { sessionId } = await d.newSession(cwd)
    if (dialect === 'omp') {
      await d.setConfigOption(sessionId, 'thinking', 'low')
      await d.setConfigOption(sessionId, 'mode', 'always-ask')
    } else {
      // 会话记录里记的是 medium：重起后接上记录，选过的 low 要再交一次
      await d.prompt(sessionId, text('你好'))
      await d.setConfigOption(sessionId, 'thinking', 'low')
      await expect(d.prompt(sessionId, text('进程崩溃'))).rejects.toThrow(/退出码 3/)
    }
    events.length = 0
    await d.prompt(sessionId, text('你好'))
    expect(textOf(events)).toContain(`thinking=low${dialect === 'omp' ? ' mode=always-ask' : ''}`)
  })

  test('受限会话没有配置项、不能改', async () => {
    const { d } = driver(dialect)
    const { sessionId, configOptions } = await d.newRestrictedSession(cwd)
    expect(configOptions).toEqual([])
    await expect(d.setConfigOption(sessionId, 'model', 'fake/m2')).rejects.toThrow(/受限会话/)
    await d.prompt(sessionId, text('你好'))
    expect(d.sessionState(sessionId).configs).toEqual([])
  })
})

describe('omp 审批档', () => {
  test('四档：跟随配置（不传参数）/ 每一步都确认 / 改动前确认 / 跳过全部确认；换档在下一轮按新参数重起，接着同一份会话', async () => {
    const { d, events } = driver('omp', { FAKE_OMP_APPROVAL: 'write' })
    const { sessionId, configOptions } = await d.newSession(cwd)
    expect(valuesOf(configOptions, 'mode')).toEqual(['config', 'always-ask', 'write', 'yolo'])
    expect(configOptions.find((o) => o.id === 'mode')?.category).toBe('mode')
    await d.prompt(sessionId, text('审批模式'))
    expect(textOf(events)).toBe('perm-mode:write model:fake/m1\n')

    events.length = 0
    expect(valueOf(await d.setConfigOption(sessionId, 'mode', 'yolo'), 'mode')).toBe('yolo')
    await d.prompt(sessionId, text('报会话 审批模式'))
    // 重起的进程打开的是同一份会话记录
    expect(textOf(events)).toMatch(/^session:\S+ resumed:\S+ prior:1\n$/)
    events.length = 0
    await d.prompt(sessionId, text('审批模式'))
    expect(textOf(events)).toBe('perm-mode:yolo model:fake/m1\n')

    events.length = 0
    expect(valueOf(await d.setConfigOption(sessionId, 'mode', 'config'), 'mode')).toBe('config')
    await d.prompt(sessionId, text('审批模式'))
    expect(textOf(events)).toBe('perm-mode:write model:fake/m1\n')
    await expect(d.setConfigOption(sessionId, 'mode', 'always-ask-cached')).rejects.toThrow(/没有这个选项/)
  })

  test('在跑的一轮里换档不打断它，下一轮才换', async () => {
    const { d, events } = driver('omp')
    const { sessionId } = await d.newSession(cwd)
    const run = d.prompt(sessionId, text('慢慢来'))
    await until(() => (events.some((e) => e.type === 'text') ? true : undefined))
    await d.setConfigOption(sessionId, 'mode', 'always-ask')
    expect(await run).toMatchObject({ stopReason: 'end_turn' })
    expect(textOf(events)).toContain('piece9')
    events.length = 0
    await d.prompt(sessionId, text('审批模式'))
    expect(textOf(events)).toBe('perm-mode:always-ask model:fake/m1\n')
  })
})
