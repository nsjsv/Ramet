/* ---------- RemoteAgent 会话级副本 + hub 路由（桩 socket，不起服务、不碰库）----------
 * 不变量：connector 上的 AcpAgent 是会话级状态的事实源，中心的 RemoteAgent 只是副本，
 * 由 session 帧 / new|load 应答 / hello 后的 sessions 快照维护；接口与 AcpAgent 一致（sessionState / busy / 事件）。
 * 实例归 hub：中心刚重启、还没有人绑定时 session 帧也有地方落。 */
import { expect, test } from 'vitest'
import type { Pool } from 'pg'
import type { WebSocket } from 'ws'
import { ConnectorHub } from './hub.js'
import { assertCanUse, type MachinePass } from './machine-access.js'
import type { CenterMsg } from './protocol.js'
import type { AgentEvent, PermissionEvent, SessionEvent, SessionState } from './types.js'

// 桩：hub 只在 attach 里用 pool.query 碰一下 last_seen_at（失败也被吞），这里的用例不关心它
const stubPool = { query: async () => ({ rows: [] }) } as unknown as Pool
// 凭据只能由 assertCanUse 签出：桩库对能不能用一律答能（授权判定本身在 machine-access.test.ts 测）
const allowPool = { query: async () => ({ rowCount: 1, rows: [] }) } as unknown as Pool
const passFor = (connectorId = 'c1', userId = 'u1'): Promise<MachinePass> => assertCanUse(allowPool, { id: userId }, connectorId, 'agent')

/** 挂一条桩 connector；返回 hub 发给它的全部帧 */
function attach(hub: ConnectorHub, id = 'c1', caps?: string[]): CenterMsg[] {
  const sent: CenterMsg[] = []
  // 桩 socket：hub 只用 readyState / send / close
  const ws = { readyState: 1, send: (data: string) => sent.push(JSON.parse(data)), close: () => undefined } as unknown as WebSocket
  hub.attach({ id, spaceId: 'sp', ownerId: null, name: 'box', defaultCwd: '/', agents: [], ws, ...(caps ? { caps } : {}) })
  return sent
}

const perm = (requestId: string, sessionId = 's1'): PermissionEvent => ({
  type: 'permission',
  requestId,
  title: '写文件',
  options: [{ optionId: 'allow', name: '允许' }],
  sessionId,
})

const resolved = (requestId: string, sessionId = 's1'): SessionEvent => ({ type: 'permission_resolved', requestId, sessionId })

/** 收到的 permission_resolved 的 [sessionId, requestId]，按发出顺序 */
const resolvedPairs = (events: AgentEvent[]): Array<[string | undefined, string]> =>
  events.flatMap((ev) => (ev.type === 'permission_resolved' ? [[ev.sessionId, ev.requestId] as [string | undefined, string]] : []))

test('session 帧在没有人绑定时也落进副本（中心刚重启）；busy = 在飞 || 副本里有待批', () => {
  const hub = new ConnectorHub(stubPool)
  attach(hub)
  hub.handle('c1', { t: 'session', agent: 'claude', sessionId: 's1', ev: { type: 'commands', list: [{ name: 'x' }] } })
  const agent = hub.remote('c1', 'claude')
  expect(agent.sessionState('s1').commands).toEqual([{ name: 'x' }])
  expect(agent.sessionState('没见过').approvals).toEqual([])
  expect(agent.busy).toBe(false)

  hub.handle('c1', { t: 'session', agent: 'claude', sessionId: 's1', ev: perm('perm-0') })
  expect(agent.busy).toBe(true) // 待批期间不许被闲置回收
  expect(agent.sessionState('s1').approvals.map((a) => a.requestId)).toEqual(['perm-0'])

  hub.handle('c1', { t: 'session', agent: 'claude', sessionId: 's1', ev: resolved('perm-0') })
  expect(agent.busy).toBe(false)
  expect(agent.sessionState('s1').approvals).toEqual([])
})

test('hub.remote：同 connector 同 agent 是同一个实例；session 帧按 agent 路由，同名 requestId 不串', () => {
  const hub = new ConnectorHub(stubPool)
  attach(hub)
  attach(hub, 'c2')
  const claude = hub.remote('c1', 'claude')
  const omp = hub.remote('c1', 'omp')
  expect(hub.remote('c1', 'claude')).toBe(claude)
  expect(omp).not.toBe(claude)
  expect(hub.remote('c2', 'claude')).not.toBe(claude)

  hub.handle('c1', { t: 'session', agent: 'claude', sessionId: 's1', ev: perm('perm-0') })
  hub.handle('c1', { t: 'session', agent: 'omp', sessionId: 's1', ev: perm('perm-0') })
  expect(claude.sessionState('s1').approvals).toHaveLength(1)
  expect(omp.sessionState('s1').approvals).toHaveLength(1)
  hub.handle('c1', { t: 'session', agent: 'claude', sessionId: 's1', ev: resolved('perm-0') })
  expect(claude.busy).toBe(false)
  expect(omp.busy).toBe(true)
  expect(hub.remote('c2', 'claude').busy).toBe(false)
})

test('session 帧先更新副本再发事件（带 sessionId）；kill() 只摘监听，副本继续更新', () => {
  const hub = new ConnectorHub(stubPool)
  attach(hub)
  const agent = hub.remote('c1', 'claude')
  const got: AgentEvent[] = []
  agent.on((ev) => got.push(ev))
  hub.handle('c1', { t: 'session', agent: 'claude', sessionId: 's1', ev: { type: 'commands', list: [{ name: 'x' }] } })
  expect(got).toEqual([{ type: 'commands', list: [{ name: 'x' }], sessionId: 's1' }])

  agent.kill()
  hub.handle('c1', { t: 'session', agent: 'claude', sessionId: 's1', ev: perm('perm-0') })
  expect(got).toHaveLength(1)
  expect(agent.busy).toBe(true)
  expect(agent.sessionState('s1').approvals).toHaveLength(1)
})

test('new 应答里的 state 播种副本（不发事件：调用方紧接着 bind）', async () => {
  const pass = await passFor()
  const hub = new ConnectorHub(stubPool)
  const sent = attach(hub)
  const agent = hub.remote('c1', 'claude')
  const got: AgentEvent[] = []
  agent.on((ev) => got.push(ev))
  const state: SessionState = {
    commands: [{ name: 'x' }],
    configs: [{ id: 'model', name: 'Model', currentValue: 'm1', options: [{ value: 'm1', name: 'M1' }] }],
    approvals: [perm('perm-3', 's9')],
  }

  const created = agent.newSession(pass, '/tmp')
  const req = sent[0]
  if (req?.t !== 'new') throw new Error('没有发出 new 请求')
  expect(req.actor).toBe('u1') // 帧里的操作人取自凭据
  hub.handle('c1', { t: 'res', rid: req.rid, sessionId: 's9', state })
  await expect(created).resolves.toEqual({ sessionId: 's9', configOptions: state.configs })
  expect(agent.sessionState('s9')).toEqual(state)
  expect(agent.busy).toBe(true)
  expect(got).toEqual([])
})

test('sessions 快照对账：快照里没有的会话当已结束（待批补发 resolved），在的会话整份替换并重发', () => {
  const hub = new ConnectorHub(stubPool)
  attach(hub)
  const agent = hub.remote('c1', 'claude')
  hub.handle('c1', { t: 'session', agent: 'claude', sessionId: 's1', ev: perm('perm-0', 's1') })
  hub.handle('c1', { t: 'session', agent: 'claude', sessionId: 's1', ev: perm('perm-1', 's1') })
  hub.handle('c1', { t: 'session', agent: 'claude', sessionId: 's2', ev: perm('perm-0', 's2') })
  const got: AgentEvent[] = []
  agent.on((ev) => got.push(ev))

  // 断线期间：s1 的 perm-0 已经结束，s2 整个没了
  const after: SessionState = { commands: [{ name: 'c' }], configs: [], approvals: [perm('perm-1', 's1')] }
  hub.handle('c1', { t: 'sessions', list: [{ agent: 'claude', sessionId: 's1', state: after }] })

  expect(resolvedPairs(got)).toEqual([['s1', 'perm-0'], ['s2', 'perm-0']])
  expect(got.filter((e) => e.type === 'permission').map((e) => e.requestId)).toEqual(['perm-1'])
  expect(got.some((e) => e.type === 'commands' && e.sessionId === 's1')).toBe(true)
  expect(agent.sessionState('s1')).toEqual(after)
  expect(agent.sessionState('s2')).toEqual({ commands: [], configs: [], approvals: [] })
  expect(agent.busy).toBe(true) // s1 还有 perm-1
})

test('sessions 快照里完全没有的 agent（它的会话全结束了）也要对账', () => {
  const hub = new ConnectorHub(stubPool)
  attach(hub)
  const claude = hub.remote('c1', 'claude')
  const omp = hub.remote('c1', 'omp')
  hub.handle('c1', { t: 'session', agent: 'claude', sessionId: 's1', ev: perm('perm-0') })
  hub.handle('c1', { t: 'session', agent: 'omp', sessionId: 's1', ev: perm('perm-0') })
  const got: AgentEvent[] = []
  claude.on((ev) => got.push(ev))

  const ompState: SessionState = { commands: [], configs: [], approvals: [perm('perm-0')] }
  hub.handle('c1', { t: 'sessions', list: [{ agent: 'omp', sessionId: 's1', state: ompState }] })
  expect(resolvedPairs(got)).toEqual([['s1', 'perm-0']])
  expect(claude.busy).toBe(false)
  expect(omp.busy).toBe(true)
})

test('审批应答按 agent + requestId 发回 connector（带操作人）；connector 不在线返回 false（审批留着以后再答）', async () => {
  const pass = await passFor()
  const hub = new ConnectorHub(stubPool)
  const sent = attach(hub)
  const agent = hub.remote('c1', 'claude')
  expect(agent.respondPermission(pass, 'perm-0', 'allow')).toBe(true)
  expect(sent.at(-1)).toEqual({ t: 'permission', actor: 'u1', agent: 'claude', requestId: 'perm-0', optionId: 'allow' })
  // 提问的答案随帧带过去（中心已校验）
  expect(agent.respondPermission(pass, 'perm-1', 'accept', { pm: 'bun' })).toBe(true)
  expect(sent.at(-1)).toEqual({ t: 'permission', actor: 'u1', agent: 'claude', requestId: 'perm-1', optionId: 'accept', content: { pm: 'bun' } })
  agent.cancel('s1')
  expect(sent.at(-1)).toEqual({ t: 'cancel', agent: 'claude', sessionId: 's1' })

  hub.detach('c1', '已断开')
  expect(agent.respondPermission(pass, 'perm-0', 'allow')).toBe(false)
})

test('非终态断开：副本与待批保留、继续算忙，重连后 sessions 快照对账；终态（撤销）副本整个丢掉', () => {
  const hub = new ConnectorHub(stubPool)
  attach(hub)
  const agent = hub.remote('c1', 'claude')
  hub.handle('c1', { t: 'session', agent: 'claude', sessionId: 's1', ev: perm('perm-0') })

  hub.detach('c1', '已断开')
  expect(hub.remote('c1', 'claude')).toBe(agent)
  expect(agent.alive).toBe(false)
  expect(agent.busy).toBe(true) // 不能当成已结束

  // 重连：断线期间审批已经在 connector 上结束了
  attach(hub)
  expect(agent.alive).toBe(true)
  const got: AgentEvent[] = []
  agent.on((ev) => got.push(ev))
  hub.handle('c1', { t: 'sessions', list: [] })
  expect(resolvedPairs(got)).toEqual([['s1', 'perm-0']])
  expect(agent.busy).toBe(false)

  // 终态：进程不会再回来
  hub.handle('c1', { t: 'session', agent: 'claude', sessionId: 's1', ev: perm('perm-1') })
  hub.detach('c1', '已被撤销', true)
  const fresh = hub.remote('c1', 'claude')
  expect(fresh).not.toBe(agent)
  expect(fresh.busy).toBe(false)
  expect(fresh.sessionState('s1').approvals).toEqual([])
})

test('应答帧和紧跟其后的 session 帧同一批到达：副本按到达顺序落地，旧快照不盖掉新事件', async () => {
  const pass = await passFor()
  const hub = new ConnectorHub(stubPool)
  const sent = attach(hub)
  const agent = hub.remote('c1', 'claude')
  const created = agent.newSession(pass, '/tmp')
  const req = sent[0]
  if (req?.t !== 'new') throw new Error('没有发出 new 请求')
  // 真实链路里这两帧就在同一个 TCP 包里（fake 先写应答、紧接着写 available_commands_update）：
  // 应答的快照里还没有命令，紧跟着的 session 帧才有
  hub.handle('c1', { t: 'res', rid: req.rid, sessionId: 's1', state: { commands: [], configs: [], approvals: [] } })
  hub.handle('c1', { t: 'session', agent: 'claude', sessionId: 's1', ev: { type: 'commands', list: [{ name: 'late' }] } })
  await created
  expect(agent.sessionState('s1').commands).toEqual([{ name: 'late' }])
})

test('prompt 帧里的图片块：声明了 prompt-image 的 connector 原样发，老 connector 剥掉只发文本', async () => {
  const blocks = [
    { type: 'text' as const, text: '看图' },
    { type: 'image' as const, mimeType: 'image/png', data: 'AAAA' },
  ]
  for (const [caps, kinds] of [
    [undefined, ['text']],
    [['prompt-image'], ['text', 'image']],
  ] as const) {
    const hub = new ConnectorHub(stubPool)
    const sent = attach(hub, 'c1', caps ? [...caps] : undefined)
    const pending = hub.remote('c1', 'claude').prompt(await passFor(), 's1', blocks, 'run-1')
    pending.catch(() => undefined)
    const frame = sent.find((m): m is Extract<CenterMsg, { t: 'prompt' }> => m.t === 'prompt')
    expect(frame?.blocks.map((b) => b.type)).toEqual(kinds)
    hub.detach('c1', '测试结束')
  }
})
