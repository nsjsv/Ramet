/* ---------- ACP 终端（agent 用 terminal/* 在客户端机器上跑命令）----------
 * 三层：
 *   1) AcpTerminals 本体（真子进程）：create / output / wait_for_exit / kill / release 往返，输出按 outputByteLimit 从头截断（落在字符边界），
 *      cwd 必须在会话工作区之内（相对路径 / 越界 / 经符号链接绕出去 / 别的会话都拒绝），环境变量里没有 RAMET_*，找不到命令像 shell 一样 127，
 *      终端属于发请求的会话，bind 之后输出实时转发（合并窗口、总量上限）、退出状态只转发一次；
 *   2) 经假 agent 的完整往返（AcpAgent + 真 ACP 流）：tool_call 嵌 terminal → 实时输出 → 退出 → release；用户停止命令 → agent 的 wait_for_exit 返回；
 *   3) 事件进 run：terminal 事件折成 `child`(terminal) 与 `step`，输出落进这一步的 output、不改 activity、退出状态进 acp.terminalExit，不触发换段。 */
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import type { RunEvent } from '@ramet/shared/run-model'
import { AcpAgent } from './acp.js'
import { AcpTerminals, TerminalError } from './acp-terminals.js'
import { projectAgentEvent } from './remote-run.js'
import { RunRecord } from './run-record.js'
import { createRunState } from './run-state.js'
import type { AgentEvent } from './types.js'

const win = process.platform === 'win32'
const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))
const node = (code: string) => ({ command: process.execPath, args: ['-e', code] })

const made: AcpTerminals[] = []
const agents: AcpAgent[] = []
afterEach(() => {
  for (const t of made.splice(0)) t.killAll()
  for (const a of agents.splice(0)) a.kill()
})

function setup(cwd?: string) {
  const dir = cwd ?? realpathSync(mkdtempSync(join(tmpdir(), 'ramet-term-')))
  const events: AgentEvent[] = []
  const terms = new AcpTerminals({ emit: (ev) => events.push(ev), sessionCwd: (sid) => (sid === 's1' || sid === 's2' ? dir : undefined) })
  made.push(terms)
  const run = async (c: ReturnType<typeof node> | { command: string; args?: string[] }, extra: Record<string, unknown> = {}) => {
    const { terminalId } = await terms.create({ sessionId: 's1', ...c, ...extra })
    const exit = await terms.waitForExit({ sessionId: 's1', terminalId })
    return { terminalId, exit, out: terms.output({ sessionId: 's1', terminalId }) }
  }
  return { dir, events, terms, run }
}

describe.skipIf(win)('AcpTerminals 本体', () => {
  test('create → wait_for_exit → output：stdout 与 stderr 合并，退出码，exitStatus', async () => {
    const { run } = setup()
    const { exit, out } = await run(node("console.log('a'); console.error('b'); process.exit(3)"))
    expect(exit).toEqual({ exitCode: 3, signal: null })
    expect(out.output.split('\n').filter(Boolean).sort()).toEqual(['a', 'b'])
    expect(out).toMatchObject({ truncated: false, exitStatus: { exitCode: 3, signal: null } })
  })

  test('运行中 output 没有 exitStatus；命令行形式（没给 args、有管道）交给 shell 跑', async () => {
    const { terms } = setup()
    const { terminalId } = await terms.create({ sessionId: 's1', ...node('setTimeout(()=>{}, 30000)') })
    expect(terms.output({ sessionId: 's1', terminalId }).exitStatus).toBeNull()
    const { terminalId: piped } = await terms.create({ sessionId: 's1', command: 'echo hello | tr a-z A-Z' })
    await terms.waitForExit({ sessionId: 's1', terminalId: piped })
    expect(terms.output({ sessionId: 's1', terminalId: piped }).output.trim()).toBe('HELLO')
  })

  test('起始目录：默认是会话工作区；给了就必须在它之内（子目录可以）；相对路径 / 越界 / 经符号链接绕出去 / 不存在 / 别的会话 都拒绝', async () => {
    const { dir, terms, run } = setup()
    mkdirSync(join(dir, 'sub'))
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ramet-term-out-')))
    symlinkSync(outside, join(dir, 'escape'))
    const pwd = node('console.log(process.cwd())')
    expect((await run(pwd)).out.output.trim()).toBe(dir)
    expect((await run(pwd, { cwd: join(dir, 'sub') })).out.output.trim()).toBe(join(dir, 'sub'))
    for (const cwd of ['sub', outside, '/', join(dir, 'escape'), join(dir, 'nope'), join(dir, '..'), `${dir}\0`]) {
      await expect(terms.create({ sessionId: 's1', ...pwd, cwd }), cwd).rejects.toBeInstanceOf(TerminalError)
    }
    // 同前缀的兄弟目录不算在工作区之内
    const sibling = `${dir}-sibling`
    mkdirSync(sibling)
    await expect(terms.create({ sessionId: 's1', ...pwd, cwd: sibling })).rejects.toBeInstanceOf(TerminalError)
    // 不认识的会话
    await expect(terms.create({ sessionId: 'nope', ...pwd })).rejects.toBeInstanceOf(TerminalError)
  })

  test('环境变量：本进程的去掉所有 RAMET_*，agent 给的叠上去（agent 自己给的也生效，包括 RAMET_ 开头的——那是它明确要的）', async () => {
    process.env.RAMET_TERM_TEST_SECRET = 'must-not-leak'
    try {
      const { run } = setup()
      const probe = node("console.log(JSON.stringify({leak: process.env.RAMET_TERM_TEST_SECRET ?? null, mine: process.env.MINE ?? null, path: typeof process.env.PATH}))")
      const { out } = await run(probe, { env: [{ name: 'MINE', value: 'yes' }] })
      expect(JSON.parse(out.output)).toEqual({ leak: null, mine: 'yes', path: 'string' })
    } finally {
      delete process.env.RAMET_TERM_TEST_SECRET
    }
  })

  test('outputByteLimit：从头截断保留最后的，标 truncated；多字节字符不被切坏；没给上限用默认值', async () => {
    const { run } = setup()
    const small = await run(node("process.stdout.write('0123456789'.repeat(100))"), { outputByteLimit: 100 })
    expect(small.out.truncated).toBe(true)
    expect(small.out.output).toBe('0123456789'.repeat(10))
    const multi = await run(node("process.stdout.write('你好世界'.repeat(50))"), { outputByteLimit: 10 })
    expect(multi.out.truncated).toBe(true)
    expect(Buffer.byteLength(multi.out.output)).toBeLessThanOrEqual(10)
    expect(multi.out.output).not.toContain('�')
    expect(multi.out.output).toMatch(/^[你好世界]+$/)
    const plain = await run(node("console.log('x'.repeat(5000))"))
    expect(plain.out).toMatchObject({ truncated: false })
    expect(plain.out.output.trim().length).toBe(5000)
  })

  test('kill：命令退出（SIGTERM），终端仍然有效（output / wait_for_exit 还能用）；release 之后终端就没了；release 一条还在跑的会先杀掉它', async () => {
    const { terms, events } = setup()
    const { terminalId } = await terms.create({ sessionId: 's1', ...node("console.log('up'); setInterval(()=>{}, 1000)") })
    terms.bind('s1', terminalId, 'tool-1')
    terms.kill({ sessionId: 's1', terminalId })
    expect(await terms.waitForExit({ sessionId: 's1', terminalId })).toEqual({ exitCode: null, signal: 'SIGTERM' })
    expect(terms.output({ sessionId: 's1', terminalId }).exitStatus).toEqual({ exitCode: null, signal: 'SIGTERM' })
    expect(events.filter((e) => e.type === 'terminal' && e.exit).length).toBe(1)
    terms.release({ sessionId: 's1', terminalId })
    expect(() => terms.output({ sessionId: 's1', terminalId })).toThrow(TerminalError)
    // release 杀掉还在跑的
    const { terminalId: running } = await terms.create({ sessionId: 's1', ...node('setInterval(()=>{}, 1000)') })
    terms.release({ sessionId: 's1', terminalId: running })
    expect(terms.count).toBe(0)
  })

  test('kill 连子孙一起收（进程组）：命令起的后台子进程也被杀掉', async () => {
    const { dir, terms } = setup()
    // 外层 node 起一个会写文件的孙进程；被杀后文件不该再被更新
    const marker = join(dir, 'alive.txt')
    const grandchild = `require('fs').writeFileSync(${JSON.stringify(marker)}, String(Date.now())); setInterval(()=>require('fs').writeFileSync(${JSON.stringify(marker)}, String(Date.now())), 50)`
    const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio:'ignore'}); setInterval(()=>{}, 1000)`
    const { terminalId } = await terms.create({ sessionId: 's1', ...node(parent) })
    const { statSync } = await import('node:fs')
    for (let i = 0; i < 100; i++) {
      try {
        statSync(marker)
        break
      } catch {
        await new Promise((r) => setTimeout(r, 30))
      }
    }
    terms.kill({ sessionId: 's1', terminalId })
    await terms.waitForExit({ sessionId: 's1', terminalId })
    await new Promise((r) => setTimeout(r, 300))
    const before = statSync(marker).mtimeMs
    await new Promise((r) => setTimeout(r, 300))
    expect(statSync(marker).mtimeMs).toBe(before) // 孙进程不再写了
  })

  test('终端属于发请求的会话：别的会话碰不到它（output / wait / kill / release 都拒绝），用户停止也要会话对得上', async () => {
    const { terms } = setup()
    const { terminalId } = await terms.create({ sessionId: 's1', ...node('setInterval(()=>{}, 1000)') })
    for (const call of [
      () => terms.output({ sessionId: 's2', terminalId }),
      () => terms.kill({ sessionId: 's2', terminalId }),
      () => terms.release({ sessionId: 's2', terminalId }),
    ]) expect(call).toThrow(TerminalError)
    await expect(terms.waitForExit({ sessionId: 's2', terminalId })).rejects.toBeInstanceOf(TerminalError)
    expect(terms.killByUser('s2', terminalId)).toBe(false)
    expect(terms.killByUser('s1', 'no-such')).toBe(false)
    expect(terms.killByUser('s1', terminalId)).toBe(true)
    await terms.waitForExit({ sessionId: 's1', terminalId })
    expect(terms.killByUser('s1', terminalId)).toBe(false) // 已经退出了
  })

  test('找不到命令：像 shell 一样退出码 127，原因写进输出，不是 JSON-RPC 错误', async () => {
    const { run } = setup()
    const { exit, out } = await run({ command: 'definitely-not-a-command-xyz', args: ['x'] })
    expect(exit.exitCode).toBe(127)
    expect(out.output).toContain('definitely-not-a-command-xyz')
  })

  test('同时存在的终端有上限（忘了 release 不能无限堆）', async () => {
    const { terms } = setup()
    for (let i = 0; i < 32; i++) await terms.create({ sessionId: 's1', ...node('setTimeout(()=>{}, 30000)') })
    await expect(terms.create({ sessionId: 's1', ...node('1') })).rejects.toBeInstanceOf(TerminalError)
    terms.killAll()
    expect(terms.count).toBe(0)
  })
})

describe.skipIf(win)('绑定到工具步骤后的实时转发', () => {
  const deltas = (events: AgentEvent[]): string =>
    events.flatMap((e) => (e.type === 'terminal' && e.delta ? [e.delta] : [])).join('')

  test('bind 之前攒下的输出在 bind 时一并发出，之后的实时转发（合并），退出状态只发一次，之后不再有输出', async () => {
    const { terms, events } = setup()
    const { terminalId } = await terms.create({ sessionId: 's1', ...node("console.log('early'); setTimeout(()=>{console.log('late'); process.exit(2)}, 300)") })
    await new Promise((r) => setTimeout(r, 120))
    expect(events).toEqual([]) // 还没绑定：什么都不发
    terms.bind('s1', terminalId, 'tool-9')
    expect(deltas(events)).toBe('') // 窗口合并：下一拍才发出
    await terms.waitForExit({ sessionId: 's1', terminalId })
    await new Promise((r) => setTimeout(r, 150))
    expect(deltas(events).replace(/\r/g, '')).toBe('early\nlate\n')
    expect(events.every((e) => e.type === 'terminal' && e.id === 'tool-9' && e.sessionId === 's1')).toBe(true)
    const exits = events.filter((e) => e.type === 'terminal' && e.exit)
    expect(exits).toEqual([{ type: 'terminal', id: 'tool-9', exit: { terminalId, exitCode: 2, signal: null }, sessionId: 's1' }])
    expect(events.at(-1)).toBe(exits[0]) // 退出是最后一条
    terms.bind('s1', terminalId, 'tool-9') // 重复绑定同一步：无事发生
    await new Promise((r) => setTimeout(r, 50))
    expect(events.filter((e) => e.type === 'terminal' && e.exit)).toHaveLength(1)
  })

  test('已经退出才 bind：输出与退出状态一次发齐', async () => {
    const { terms, events } = setup()
    const { terminalId } = await terms.create({ sessionId: 's1', ...node("console.log('done')") })
    await terms.waitForExit({ sessionId: 's1', terminalId })
    terms.bind('s1', terminalId, 'tool-1')
    await new Promise((r) => setTimeout(r, 150))
    expect(deltas(events).trim()).toBe('done')
    expect(events.filter((e) => e.type === 'terminal' && e.exit)).toHaveLength(1)
  })

  test('实时转发有总量上限：命令狂刷也只转发前 256000 字符，并标一次 truncated；完整输出仍在执行端按 outputByteLimit 保留', async () => {
    const { terms, events } = setup()
    const { terminalId } = await terms.create({ sessionId: 's1', ...node("for (let i = 0; i < 40; i++) process.stdout.write('y'.repeat(10000))"), outputByteLimit: 2_000_000 })
    terms.bind('s1', terminalId, 'tool-1')
    await terms.waitForExit({ sessionId: 's1', terminalId })
    await new Promise((r) => setTimeout(r, 200))
    expect(deltas(events).length).toBe(256_000)
    expect(events.filter((e) => e.type === 'terminal' && e.truncated)).toHaveLength(1)
    expect(terms.output({ sessionId: 's1', terminalId }).output.length).toBe(400_000) // agent 经 terminal/output 仍拿得到全部
  })

  test('别的会话 / 不存在的终端 bind 无效', async () => {
    const { terms, events } = setup()
    const { terminalId } = await terms.create({ sessionId: 's1', ...node("console.log('x')") })
    terms.bind('s2', terminalId, 'tool-1')
    terms.bind('s1', 'no-such', 'tool-1')
    await terms.waitForExit({ sessionId: 's1', terminalId })
    await new Promise((r) => setTimeout(r, 150))
    expect(events).toEqual([])
  })
})


function spawnAgent(): AcpAgent {
  const agent = new AcpAgent({ id: 'fake', label: 'Fake', command: process.execPath, args: [FAKE_AGENT, 'fake-cmd'] })
  agents.push(agent)
  return agent
}

async function when(events: AgentEvent[], match: (e: AgentEvent) => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!events.some(match)) {
    if (Date.now() > deadline) throw new Error(`等待事件超时，已收：${JSON.stringify(events.slice(-5))}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** 假 agent 发的那条 tool_call 里嵌的 terminalId（先收窄事件类型再取） */
function embeddedTerminalId(events: AgentEvent[]): string {
  const tool = events.find((e) => e.type === 'tool' && e.id === 'term-1')
  const content = tool?.type === 'tool' ? tool.acp?.content : undefined
  const first: unknown = Array.isArray(content) ? content[0] : undefined
  const id = first && typeof first === 'object' ? (first as { terminalId?: unknown }).terminalId : undefined
  if (typeof id !== 'string') throw new Error('tool_call 里没有嵌 terminal')
  return id
}

const textOf = (events: AgentEvent[]): string => events.flatMap((e) => (e.type === 'text' && !e.parentId ? [e.delta] : [])).join('')

describe.skipIf(win)('经假 agent 的完整往返（AcpAgent + ACP 流）', () => {
  async function session(cwd?: string) {
    const dir = cwd ?? realpathSync(mkdtempSync(join(tmpdir(), 'ramet-term-agent-')))
    const agent = spawnAgent()
    const events: AgentEvent[] = []
    agent.on((e) => events.push(e))
    const { sessionId } = await agent.newSession(dir)
    return { agent, events, sessionId, dir, prompt: (text: string) => agent.prompt(sessionId, [{ type: 'text', text }]) }
  }

  test('terminal/create → tool_call 嵌 terminal → 实时输出事件 → 退出事件 → release；agent 拿到合并后的输出与退出码', async () => {
    const { events, prompt } = await session()
    await prompt('终端命令')
    expect(textOf(events)).toContain('term:0:err-line|hello-term')
    const tool = events.find((e) => e.type === 'tool' && e.id === 'term-1')
    expect(tool).toMatchObject({ type: 'tool', kind: 'execute', acp: { content: [{ type: 'terminal', terminalId: expect.any(String) }] } })
    const live = events.filter((e) => e.type === 'terminal')
    expect(live.every((e) => e.id === 'term-1')).toBe(true)
    expect(live.flatMap((e) => (e.delta ? [e.delta] : [])).join('').replace(/\r/g, '').split('\n').filter(Boolean).sort()).toEqual(['err-line', 'hello-term'])
    const exit = live.find((e) => e.exit)
    expect(exit).toMatchObject({ exit: { exitCode: 0, signal: null, terminalId: embeddedTerminalId(events) } })
    // 步骤先出现、输出后到（输出事件在 tool 事件之后）
    expect(events.indexOf(tool!)).toBeLessThan(events.indexOf(live[0]!))
  })

  test('用户「停止这条命令」：terminal/kill → agent 的 wait_for_exit 返回（SIGTERM），本轮照常收尾；会话对不上 / 不存在 → false', async () => {
    const { agent, events, sessionId, prompt } = await session()
    const done = prompt('终端长命令')
    await when(events, (e) => e.type === 'terminal' && Boolean(e.delta?.includes('tick')))
    const terminalId = embeddedTerminalId(events)
    expect(agent.killCommand('another-session', terminalId)).toBe(false)
    expect(agent.killCommand(sessionId, 'no-such-terminal')).toBe(false)
    expect(agent.killCommand(sessionId, terminalId)).toBe(true)
    await done
    expect(textOf(events)).toContain('term-exit:null:SIGTERM')
    expect(events.some((e) => e.type === 'terminal' && e.exit?.signal === 'SIGTERM')).toBe(true)
    expect(agent.killCommand(sessionId, terminalId)).toBe(false) // 已经退了（也已经 release）
  })

  test('cwd 越界：create 被拒（invalid params，带人话），agent 拿到错误；工作区之外什么都没跑', async () => {
    const { events, prompt } = await session()
    await prompt('终端越界')
    expect(textOf(events)).toMatch(/term-denied:.*工作区之外/)
    expect(events.some((e) => e.type === 'tool')).toBe(false)
  })

  test('outputByteLimit 经 ACP 生效：agent 取到的 output 被截断并标 truncated', async () => {
    const { events, prompt } = await session()
    await prompt('终端截断')
    const m = /term-trunc:(true|false):(\d+)/.exec(textOf(events))
    expect(m?.[1]).toBe('true')
    expect(Number(m?.[2])).toBeLessThanOrEqual(100)
  })

  test('命令进程的环境里没有 RAMET_*（即便适配器进程所在环境有）', async () => {
    process.env.RAMET_TERM_AGENT_LEAK = '1'
    try {
      const { events, prompt } = await session()
      await prompt('终端环境')
      expect(textOf(events)).toContain('env-ramet:0')
    } finally {
      delete process.env.RAMET_TERM_AGENT_LEAK
    }
  })

  test('适配器被 kill：它起的命令一并杀掉', async () => {
    const { agent, events, prompt } = await session()
    void prompt('终端长命令').catch(() => undefined)
    await when(events, (e) => e.type === 'terminal' && Boolean(e.delta?.includes('tick')))
    const before = events.filter((e) => e.type === 'terminal' && e.delta).length
    agent.kill()
    await new Promise((r) => setTimeout(r, 600))
    const after = events.filter((e) => e.type === 'terminal' && e.delta).length
    await new Promise((r) => setTimeout(r, 400))
    expect(events.filter((e) => e.type === 'terminal' && e.delta).length).toBe(after) // 不再有新输出
    expect(after).toBeGreaterThanOrEqual(before)
  })
})


describe('terminal 事件折进 run（RunRecord / projectAgentEvent）', () => {
  function recorder() {
    const events: RunEvent[] = []
    const rec = new RunRecord('reply-1', Date.now(), (ev) => events.push(ev))
    const run = createRunState({ pageId: 'p1', userId: 'u1', adapterKey: 'fake', remote: null })
    const feed = (ev: AgentEvent, seq?: number) => projectAgentEvent(run, rec, ev, seq, 's1')
    return { rec, events, feed }
  }
  const execTool: AgentEvent = { type: 'tool', id: 'c1', kind: 'execute', title: 'npm test', status: 'in_progress', sessionId: 's1' }

  test('输出追加到这一步的 output，不改 activity（一行文字始终是命令本身），退出状态进 acp.terminalExit，不触发换段', () => {
    const { rec, events, feed } = recorder()
    feed({ type: 'text', delta: '开始跑测试', sessionId: 's1' })
    feed(execTool)
    feed({ type: 'terminal', id: 'c1', delta: 'PASS a\n', sessionId: 's1' })
    feed({ type: 'terminal', id: 'c1', delta: 'PASS b\n', sessionId: 's1' })
    feed({ type: 'terminal', id: 'c1', exit: { terminalId: 'T', exitCode: 1, signal: null }, sessionId: 's1' })
    feed({ type: 'text', delta: '，测试没过', sessionId: 's1' }) // 退出通知之后继续说同一句话：不能被劈成两段
    rec.close()
    const step = rec.state.entries.find((e) => e.k === 'tool')
    expect(step).toMatchObject({ output: 'PASS a\nPASS b\n', acp: { terminalExit: { terminalId: 'T', exitCode: 1, signal: null } } })
    expect(step).not.toHaveProperty('activity')
    expect(rec.state.entries.map((e) => e.k)).toEqual(['say', 'tool']) // 换段只发生在工具调用那一刻（开始跑测试 → 工具），退出通知没有再换
    expect(events.filter((e) => e.type === 'said')).toHaveLength(1)
    // 相邻输出合批成一条 child(terminal)
    expect(events.filter((e) => e.type === 'child')).toEqual([{ type: 'child', id: 'c1', kind: 'terminal', d: 'PASS a\nPASS b\n', t: expect.any(Number) }])
  })

  test('步骤不存在（还没出现 / 超出步数上限）时输出与退出状态被丢弃，不会凭空造出一步', () => {
    const { rec, feed } = recorder()
    feed({ type: 'terminal', id: 'ghost', delta: 'x', sessionId: 's1' })
    feed({ type: 'terminal', id: 'ghost', exit: { terminalId: 'T', exitCode: 0, signal: null }, sessionId: 's1' })
    rec.close()
    expect(rec.state.entries).toEqual([])
  })

  test('转发被截断：步骤标 truncated（可见，不静默）；终端事件占 seq、别的会话的丢掉', () => {
    const { rec, feed } = recorder()
    feed(execTool, 0)
    feed({ type: 'terminal', id: 'c1', truncated: true, sessionId: 's1' }, 1)
    feed({ type: 'terminal', id: 'c1', delta: '串台', sessionId: 's2' }, 2)
    rec.close()
    expect(rec.state.entries[0]).toMatchObject({ truncated: true })
    expect(rec.state.entries[0]).not.toHaveProperty('output')
  })

  test('快照 + 之后的事件 = 终态（前端 store 用同一个 reducer）', () => {
    const { rec, events, feed } = recorder()
    feed(execTool)
    rec.flush()
    const snapshot = structuredClone(rec.state)
    const mark = events.length
    feed({ type: 'terminal', id: 'c1', delta: 'out', sessionId: 's1' })
    feed({ type: 'terminal', id: 'c1', exit: { terminalId: 'T', exitCode: 0, signal: null }, sessionId: 's1' })
    rec.close()
    // 前端：拿到快照，再按序应用后续事件
    const client = snapshot
    return import('@ramet/shared/run-model').then(({ applyRunEvent }) => {
      for (const ev of events.slice(mark)) applyRunEvent(client, ev)
      expect(client).toEqual(rec.state)
    })
  })
})
