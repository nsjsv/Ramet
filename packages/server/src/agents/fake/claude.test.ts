/* ---------- 假 claude 对得上真 SDK ----------
 * 用真实的 Claude Agent SDK query() + pathToClaudeCodeExecutable 拉起 fake/claude.mjs：
 * 流式正文、can_use_tool 允许 / 拒绝、interrupt、resume、子代理与 stop_task、AskUserQuestion、切模型 / 模式。
 * 这一层对不上，Claude 驱动的测试就全是假的。不连库。
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, test } from 'vitest'
import { query, type CanUseTool, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

const FAKE_CLAUDE = fileURLToPath(new URL('./claude.mjs', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'fake-claude-test-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

/** 流式输入：测试往里推用户消息，close 后 SDK 关掉 CLI 的 stdin */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private closed = false
  push(text: string): void {
    this.items.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null })
    this.wake?.()
  }
  close(): void {
    this.closed = true
    this.wake?.()
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.items.shift()
      if (next) yield next
      else if (this.closed) return
      else await new Promise<void>((r) => { this.wake = r })
    }
  }
}

function start(options: Options = {}): { q: Query; inbox: Inbox } {
  const inbox = new Inbox()
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  const q = query({
    prompt: inbox,
    options: { pathToClaudeCodeExecutable: FAKE_CLAUDE, cwd: home, includePartialMessages: true, env: { ...env, FAKE_CLAUDE_HOME: home }, ...options },
  })
  return { q, inbox }
}

/** 读到这一轮的 result 为止（含），可选在每条消息上回调 */
async function untilResult(q: Query, onMessage?: (m: SDKMessage) => void | Promise<void>): Promise<SDKMessage[]> {
  const got: SDKMessage[] = []
  for (;;) {
    const { value, done } = await q.next()
    if (done) throw new Error('流在 result 之前结束了：' + JSON.stringify(got.map((m) => m.type)))
    got.push(value)
    await onMessage?.(value)
    if (value.type === 'result') return got
  }
}

function resultOf(msgs: SDKMessage[]): { subtype: string; text: string } {
  const r = msgs.at(-1)
  if (r?.type !== 'result') throw new Error('不是 result')
  return { subtype: r.subtype, text: r.subtype === 'success' ? r.result : '' }
}

async function finish(q: Query, inbox: Inbox): Promise<void> {
  inbox.close()
  for (;;) if ((await q.next()).done) return
}

test('一轮流式正文：init → stream_event 逐字 → assistant 整块 → result；第二轮是增量', async () => {
  const sessionId = randomUUID()
  const { q, inbox } = start({ sessionId })
  inbox.push('你好')
  const msgs = await untilResult(q)
  const init = msgs.find((m) => m.type === 'system' && m.subtype === 'init')
  expect(init && init.type === 'system' && init.subtype === 'init' ? init.session_id : '').toBe(sessionId)
  const deltas = msgs.flatMap((m) =>
    m.type === 'stream_event' && m.event.type === 'content_block_delta' && m.event.delta.type === 'text_delta' ? [m.event.delta.text] : [])
  expect(deltas.join('')).toBe('turn:full model=m1 thinking=adaptive mode=default\n')
  const block = msgs.find((m) => m.type === 'assistant')
  expect(block?.type === 'assistant' ? block.message.content : null).toEqual([{ type: 'text', text: 'turn:full model=m1 thinking=adaptive mode=default\n' }])
  expect(resultOf(msgs)).toEqual({ subtype: 'success', text: 'turn:full model=m1 thinking=adaptive mode=default\n' })
  expect((await q.supportedModels()).map((m) => m.value)).toEqual(['m1', 'm2'])
  expect((await q.supportedCommands()).map((c) => c.name)).toEqual(['fake-cmd', 'fake-cmd-arg'])

  inbox.push('再来')
  expect(resultOf(await untilResult(q)).text).toBe('turn:delta model=m1 thinking=adaptive mode=default\n')
  await finish(q, inbox)
})

test('can_use_tool：允许一次 / 拒绝都回到 CLI，工具结果跟着变', async () => {
  const calls: { toolName: string; command: unknown; toolUseID: string }[] = []
  const canUseTool: CanUseTool = async (toolName, input, opts) => {
    calls.push({ toolName, command: input.command, toolUseID: opts.toolUseID })
    return calls.length === 1 ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: '不行' }
  }
  const { q, inbox } = start({ canUseTool })
  inbox.push('需要权限')
  expect(resultOf(await untilResult(q)).text).toBe('granted:allow_once\n')
  inbox.push('需要权限')
  const second = await untilResult(q)
  expect(resultOf(second).text).toBe('granted:reject_once\n')
  expect(calls).toEqual([
    { toolName: 'Bash', command: 'npm test -- --run', toolUseID: 't1' },
    { toolName: 'Bash', command: 'npm test -- --run', toolUseID: 't1' },
  ])
  const denied = second.find((m) => m.type === 'user' && Array.isArray(m.message.content))
  expect(denied?.type === 'user' ? denied.message.content : null).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: '不行', is_error: true }])
  await finish(q, inbox)
})

test('interrupt：在飞的一轮以 error_during_execution 收尾，下一条消息照常跑', async () => {
  const { q, inbox } = start()
  inbox.push('慢慢来')
  let interrupted = false
  const msgs = await untilResult(q, async (m) => {
    if (!interrupted && m.type === 'stream_event' && m.event.type === 'content_block_delta') {
      interrupted = true
      await q.interrupt()
    }
  })
  expect(resultOf(msgs).subtype).toBe('error_during_execution')
  const pieces = msgs.filter((m) => m.type === 'stream_event' && m.event.type === 'content_block_delta').length
  expect(pieces).toBeLessThan(10)
  inbox.push('你好')
  expect(resultOf(await untilResult(q)).text).toMatch(/^turn:full/)
  await finish(q, inbox)
})

test('resume：同一会话 id 接着跑，轮数接上', async () => {
  const sessionId = randomUUID()
  const first = start({ sessionId })
  first.inbox.push('报会话')
  expect(resultOf(await untilResult(first.q)).text).toBe(`session:${sessionId} resumed:no prior:0\n`)
  await finish(first.q, first.inbox)

  const second = start({ resume: sessionId })
  second.inbox.push('报会话')
  expect(resultOf(await untilResult(second.q)).text).toBe(`session:${sessionId} resumed:${sessionId} prior:1\n`)
  second.inbox.push('你好')
  expect(resultOf(await untilResult(second.q)).text).toMatch(/^turn:delta/)
  await finish(second.q, second.inbox)
})

test('子代理：Agent 工具 + task 生命周期，子代理里的步骤带 parent_tool_use_id；stop_task 只停子代理', async () => {
  const { q, inbox } = start()
  inbox.push('起子代理')
  const msgs = await untilResult(q)
  const started = msgs.find((m) => m.type === 'system' && m.subtype === 'task_started')
  const toolId = started?.type === 'system' && started.subtype === 'task_started' ? started.tool_use_id : undefined
  expect(toolId).toBeTruthy()
  const inner = msgs.filter((m) => m.type === 'assistant' && m.parent_tool_use_id === toolId)
  expect(inner.flatMap((m) => (m.type === 'assistant' ? m.message.content.map((b) => (b.type === 'tool_use' ? b.name : b.type)) : []))).toEqual(['text', 'Read', 'Bash'])
  const done = msgs.find((m) => m.type === 'system' && m.subtype === 'task_notification')
  expect(done?.type === 'system' && done.subtype === 'task_notification' ? done.status : null).toBe('completed')
  expect(resultOf(msgs).text).toBe('subagent:completed\n')

  inbox.push('起子代理慢')
  const slow = await untilResult(q, async (m) => {
    if (m.type === 'system' && m.subtype === 'task_started') await q.stopTask(m.task_id)
  })
  const stopped = slow.find((m) => m.type === 'system' && m.subtype === 'task_notification')
  expect(stopped?.type === 'system' && stopped.subtype === 'task_notification' ? stopped.status : null).toBe('stopped')
  expect(resultOf(slow)).toEqual({ subtype: 'success', text: 'subagent:stopped\n' })
  await finish(q, inbox)
})

test('AskUserQuestion：两题（一题多选），答案经 updatedInput.answers 回到 CLI', async () => {
  const canUseTool: CanUseTool = async (toolName, input) => {
    expect(toolName).toBe('AskUserQuestion')
    const qs = input.questions as { question: string; multiSelect: boolean }[]
    expect(qs.map((x) => x.multiSelect)).toEqual([false, true])
    return { behavior: 'allow', updatedInput: { ...input, answers: { [qs[0]!.question]: 'pnpm', [qs[1]!.question]: 'Lint, Test' } } }
  }
  const { q, inbox } = start({ canUseTool })
  inbox.push('提问')
  expect(resultOf(await untilResult(q)).text).toBe('answers:{"用哪个包管理器？":"pnpm","要哪些功能？":"Lint, Test"}\n')
  await finish(q, inbox)
})

test('切模型 / 切模式在下一轮生效；没带跳过确认的开关切不进 bypassPermissions', async () => {
  const { q, inbox } = start({ model: 'm1', permissionMode: 'default' })
  await q.setModel('m2')
  await q.setPermissionMode('acceptEdits')
  await expect(q.setPermissionMode('bypassPermissions')).rejects.toThrow(/allow-dangerously-skip-permissions/)
  inbox.push('审批模式')
  expect(resultOf(await untilResult(q)).text).toBe('perm-mode:acceptEdits model:m2\n')
  await finish(q, inbox)
})
