/* ---------- 执行端会话级状态（AcpAgent + 真子进程，不起服务、不碰库）----------
 * 命令 / config / 待批审批按会话缓存在执行端，不论有没有监听者；审批没有超时，只在
 * 答 / 取消该会话 / 进程退出时结束，每次移除都发 permission_resolved；busy = 在飞 prompt 或有待批。
 * 等待一律等事件本身（或同一条 NDJSON 流上后发请求的应答，流按序处理，先写出的通知必已处理完），
 * 不等一段时间；时间相关的用假时钟。 */
import { afterEach, expect, test, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { AcpAgent } from './acp.js'
import { IdleRecycler } from './idle.js'
import type { AgentEvent, PermissionEvent } from './types.js'

const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))

const spawned: AcpAgent[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const agent of spawned.splice(0)) agent.kill()
})

function spawnAgent(command = 'fake-cmd', ...extra: string[]): AcpAgent {
  const agent = new AcpAgent({ id: 'claude', label: 'Claude', command: process.execPath, args: [FAKE_AGENT, command, ...extra] })
  spawned.push(agent)
  return agent
}

/** 录下适配器的全部事件，并能等到某种事件（出现 count 次）—— 等的是事件本身，没有定时器 */
function tape(agent: AcpAgent) {
  const events: AgentEvent[] = []
  const wakers: Array<() => void> = []
  agent.on((ev) => {
    events.push(ev)
    for (const wake of wakers.splice(0)) wake()
  })
  return {
    events,
    async when(match: (ev: AgentEvent) => boolean, count = 1): Promise<void> {
      while (events.filter(match).length < count) {
        const { promise, resolve } = Promise.withResolvers<void>()
        wakers.push(resolve)
        await promise
      }
    },
  }
}

function permissionOf(events: AgentEvent[], sessionId?: string): PermissionEvent {
  const ev = events.find((e): e is PermissionEvent => e.type === 'permission' && (!sessionId || e.sessionId === sessionId))
  if (!ev) throw new Error('没有收到审批事件')
  return ev
}

const say = (text: string) => [{ type: 'text' as const, text }]

test('命令按会话缓存：没有监听者也不丢；两个 agent 各是各的命令', async () => {
  const a = spawnAgent('claude-cmd')
  const b = spawnAgent('other-cmd')
  const sa = (await a.newSession(process.cwd())).sessionId
  const sb = (await b.newSession(process.cwd())).sessionId
  // fake 在 session/new 应答之后才推 available_commands_update；此刻没有任何监听者。
  // 后发的请求（改配置）的应答回来时，先写出的那条通知必已处理完
  await a.setConfigOption(sa, 'model', 'm1')
  await b.setConfigOption(sb, 'model', 'm1')
  expect(a.sessionState(sa).commands).toEqual([{ name: 'claude-cmd', description: 'claude-cmd 命令' }])
  expect(b.sessionState(sb).commands).toEqual([{ name: 'other-cmd', description: 'other-cmd 命令' }])
  expect(a.sessionState('不存在')).toEqual({ commands: [], configs: [], approvals: [] })
  expect(a.knownSessions()).toEqual([sa])

  // session/load 一个本进程没见过的会话同样会推命令（晚绑定的人用快照补齐）
  await a.loadSession('sess-loaded', process.cwd())
  await a.setConfigOption('sess-loaded', 'model', 'm1')
  expect(a.sessionState('sess-loaded').commands).toEqual([{ name: 'claude-cmd', description: 'claude-cmd 命令' }])
  expect(new Set(a.knownSessions())).toEqual(new Set([sa, 'sess-loaded']))
})

test('命令的参数提示（ACP input.hint）透传成 input；没有提示的命令不带这个字段', async () => {
  const a = spawnAgent('claude-cmd', 'arg')
  const sa = (await a.newSession(process.cwd())).sessionId
  await a.setConfigOption(sa, 'model', 'm1')
  expect(a.sessionState(sa).commands).toEqual([
    { name: 'claude-cmd', description: 'claude-cmd 命令' },
    { name: 'claude-cmd-arg', description: 'claude-cmd 带参命令', input: '参数' },
  ])
})

test('setConfigOption 更新缓存并发 config 事件（中心镜像是这些事件的投影）', async () => {
  const agent = spawnAgent()
  const { sessionId } = await agent.newSession(process.cwd())
  const { events } = tape(agent)
  const options = await agent.setConfigOption(sessionId, 'model', 'm2')
  expect(options.find((o) => o.id === 'model')?.currentValue).toBe('m2')
  expect(agent.sessionState(sessionId).configs.find((o) => o.id === 'model')?.currentValue).toBe('m2')
  const configs = events.filter((e): e is Extract<AgentEvent, { type: 'config' }> => e.type === 'config')
  expect(configs.length).toBeGreaterThanOrEqual(1)
  expect(configs.at(-1)!.sessionId).toBe(sessionId)
  expect(configs.at(-1)!.options.find((o) => o.id === 'model')?.currentValue).toBe('m2')
})

test('current_mode_update 只改写 category=mode 那一项并发一次 config 事件（info 快照照旧留着）', async () => {
  const agent = spawnAgent()
  const { sessionId } = await agent.newSession(process.cwd())
  const t = tape(agent)
  // 「退出计划」→ 审批；选 exit-plan-bypass 后 fake 只推 current_mode_update（不推 config_option_update）
  const prompt = agent.prompt(sessionId, say('退出计划'))
  await t.when((e) => e.type === 'permission')
  expect(agent.respondPermission(permissionOf(t.events).requestId, 'exit-plan-bypass')).toBe(true)
  await prompt

  const configs = t.events.filter((e): e is Extract<AgentEvent, { type: 'config' }> => e.type === 'config')
  expect(configs).toHaveLength(1)
  const options = configs[0]!.options
  expect(options.find((o) => o.category === 'mode')?.currentValue).toBe('bypassPermissions')
  expect(options.find((o) => o.id === 'model')?.currentValue).toBe('m1')
  expect(agent.sessionState(sessionId).configs.find((o) => o.category === 'mode')?.currentValue).toBe('bypassPermissions')
  expect(t.events.some((e) => e.type === 'info' && JSON.stringify(e.info).includes('current_mode_update'))).toBe(true)
})

test('审批：带 sessionId、busy 含待批、答后发 permission_resolved、再答返回 false', async () => {
  const agent = spawnAgent()
  const { sessionId } = await agent.newSession(process.cwd())
  const t = tape(agent)
  expect(agent.busy).toBe(false)

  const prompt = agent.prompt(sessionId, say('需要权限'))
  await t.when((e) => e.type === 'permission')
  const perm = permissionOf(t.events)
  expect(perm.sessionId).toBe(sessionId)
  expect(agent.busy).toBe(true)
  expect(agent.sessionState(sessionId).approvals.map((a) => a.requestId)).toEqual([perm.requestId])
  expect(agent.sessionState('别的会话').approvals).toEqual([])

  expect(agent.respondPermission(perm.requestId, 'allow_once')).toBe(true)
  expect(agent.respondPermission(perm.requestId, 'allow_once')).toBe(false)
  await prompt
  expect(t.events.filter((e) => e.type === 'permission_resolved')).toEqual([
    { type: 'permission_resolved', requestId: perm.requestId, sessionId },
  ])
  expect(agent.sessionState(sessionId).approvals).toEqual([])
  expect(agent.busy).toBe(false)
})

test('cancel(sessionId) 只结束该会话的待批：同一进程上另一个会话的审批不受影响', async () => {
  const agent = spawnAgent()
  const a = (await agent.newSession(process.cwd())).sessionId
  const b = (await agent.newSession(process.cwd())).sessionId
  const t = tape(agent)
  const pa = agent.prompt(a, say('需要权限 A'))
  const pb = agent.prompt(b, say('需要权限 B'))
  await t.when((e) => e.type === 'permission', 2)
  // 同一个进程里的两条审批：requestId 各不相同，归属靠 sessionId
  expect(permissionOf(t.events, a).requestId).not.toBe(permissionOf(t.events, b).requestId)

  agent.cancel(a)
  await pa
  const resolved = t.events.filter((e) => e.type === 'permission_resolved')
  expect(resolved.map((e) => e.sessionId)).toEqual([a])
  expect(agent.sessionState(a).approvals).toEqual([])
  expect(agent.sessionState(b).approvals).toHaveLength(1) // B 页同 agent 的审批还在等
  expect(agent.busy).toBe(true)

  expect(agent.respondPermission(permissionOf(t.events, b).requestId, 'allow_once')).toBe(true)
  await pb
  expect(agent.busy).toBe(false)
})

test('进程退出：待批按取消结束并发 permission_resolved（不再有人能答）', async () => {
  const agent = spawnAgent()
  const { sessionId } = await agent.newSession(process.cwd())
  const t = tape(agent)
  const prompt = agent.prompt(sessionId, say('需要权限'))
  const settled = expect(prompt).rejects.toThrow()
  await t.when((e) => e.type === 'permission')
  const perm = permissionOf(t.events)

  agent.kill()
  await t.when((e) => e.type === 'permission_resolved')
  await settled
  expect(t.events.filter((e) => e.type === 'permission_resolved')).toEqual([
    { type: 'permission_resolved', requestId: perm.requestId, sessionId },
  ])
  expect(agent.sessionState(sessionId).approvals).toEqual([])
  expect(agent.busy).toBe(false)
})

test('审批没有超时：假时钟推进一小时仍在等、闲置回收不收；答后继续，之后才被回收', async () => {
  const agent = spawnAgent()
  const { sessionId } = await agent.newSession(process.cwd()) // 子进程握手走真实时钟
  const t = tape(agent)

  // 从这里起时钟归测试：只换 setTimeout/clearTimeout（Date、setImmediate、I/O 都是真的）
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const reclaimed: string[] = []
  const idle = new IdleRecycler((key) => key === 'a' && agent.busy, (key) => reclaimed.push(key))
  idle.arm('a')

  // 「后台审批」：这一轮正常结束，审批还挂着 —— 没有在飞 prompt，但有待批
  await agent.prompt(sessionId, say('后台审批'))
  await t.when((e) => e.type === 'permission')
  expect(agent.busy).toBe(true)
  const [approval] = agent.sessionState(sessionId).approvals

  // 审批不超时，闲置回收也不会收走有待批的进程：11 分钟后仍在等
  await vi.advanceTimersByTimeAsync(11 * 60_000)
  expect(reclaimed).toEqual([])
  expect(agent.sessionState(sessionId).approvals).toHaveLength(1)
  expect(t.events.filter((e) => e.type === 'permission_resolved')).toEqual([])
  // 多个续期窗口过去仍然如此
  await vi.advanceTimersByTimeAsync(60 * 60_000)
  expect(reclaimed).toEqual([])
  expect(agent.sessionState(sessionId).approvals).toHaveLength(1)

  // 答了之后继续：agent 收到的是我们选的选项
  expect(agent.respondPermission(approval!.requestId, 'allow_once')).toBe(true)
  expect(agent.busy).toBe(false)
  const texts: string[] = []
  agent.on((ev) => {
    if (ev.type === 'text') texts.push(ev.delta)
  })
  await agent.prompt(sessionId, say('报后台审批'))
  expect(texts.join('')).toContain('bg:allow_once')

  // 不忙了，下一个续期窗口才真的回收
  await vi.advanceTimersByTimeAsync(2 * 60_000)
  expect(reclaimed).toEqual(['a'])
})
