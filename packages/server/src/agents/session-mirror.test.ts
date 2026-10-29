/* ---------- 会话镜像（桩适配器，不起服务、不碰库）----------
 * 镜像是执行端会话级状态的投影：每个绑定点用快照播种、常驻监听增量更新、新订阅者回放全量；
 * 审批按 agentId + requestId 认（requestId 只在单个进程内唯一）；换会话时旧会话的待批按取消应答；
 * agent 侧改的 config 值落成页面级意图，但本轮消息级覆盖（临时的）不落。 */
import { EventEmitter } from 'node:events'
import { expect, test } from 'vitest'
import { SessionMirror, type MirrorAdapter, type MirrorHost } from './session-mirror.js'
import type { AgentEvent, ConfigOption, PermissionEvent, SessionState } from './types.js'

const EMPTY: SessionState = { commands: [], configs: [], approvals: [] }

class StubAdapter implements MirrorAdapter {
  private emitter = new EventEmitter()
  states = new Map<string, SessionState>()
  answered: Array<{ requestId: string; optionId: string | null }> = []
  sessionState(id: string): SessionState {
    return this.states.get(id) ?? EMPTY
  }
  respondPermission(requestId: string, optionId: string | null): boolean {
    this.answered.push({ requestId, optionId })
    return true
  }
  on(listener: (ev: AgentEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }
  emit(ev: AgentEvent): void {
    this.emitter.emit('event', ev)
  }
}

const perm = (requestId: string, sessionId: string): PermissionEvent => ({
  type: 'permission',
  requestId,
  title: '写文件',
  options: [{ optionId: 'allow', name: '允许' }],
  sessionId,
})

const cfg = (model: string, mode = 'default'): ConfigOption[] => [
  { id: 'model', name: 'Model', category: 'model', currentValue: model, options: [{ value: 'm1', name: 'M1' }, { value: 'm2', name: 'M2' }] },
  { id: 'mode', name: 'Mode', category: 'mode', currentValue: mode, options: [{ value: 'default', name: 'D' }, { value: 'bypassPermissions', name: 'B' }] },
]

type Sent = Array<{ pageId: string; ev: AgentEvent }>

/** 广播事件上的 agentId（不是每种事件都有这个字段） */
const agentOf = (ev: AgentEvent): string | undefined => ('agentId' in ev ? ev.agentId : undefined)

/** 广播里 permission_resolved 的 requestId，按发出顺序 */
const resolvedIds = (sent: Sent): string[] =>
  sent.flatMap(({ ev }) => (ev.type === 'permission_resolved' ? [ev.requestId] : []))

function setup() {
  const sent: Sent = []
  const persisted: Array<{ pageId: string; agentId: string; values: Record<string, string> }> = []
  const overridden = new Set<string>()
  const folded: Array<{ pageId: string; agentId: string; requestId: string }> = []
  const host: MirrorHost = {
    broadcast: (pageId, ev) => sent.push({ pageId, ev }),
    persist: (pageId, agentId, values) => persisted.push({ pageId, agentId, values }),
    overridden: (_pageId, _agentId, configId) => overridden.has(configId),
    fold: (pageId, agentId, ev) => folded.push({ pageId, agentId, requestId: ev.requestId }),
  }
  return { mirror: new SessionMirror(host), sent, persisted, overridden, folded }
}

test('bind：用执行端快照播种并广播全量，事件都带 agentId；待批并入本轮过程', () => {
  const { mirror, sent, folded } = setup()
  const adapter = new StubAdapter()
  adapter.states.set('s1', { commands: [{ name: 'x' }], configs: cfg('m1'), approvals: [perm('perm-0', 's1')] })
  mirror.bind('p1', 'claude', 's1', adapter)
  expect(sent.map((s) => s.ev)).toEqual([
    { type: 'commands', list: [{ name: 'x' }], agentId: 'claude', sessionId: 's1' },
    { type: 'config', options: cfg('m1'), agentId: 'claude', sessionId: 's1' },
    { ...perm('perm-0', 's1'), agentId: 'claude' },
  ])
  expect(mirror.approval('p1', 'claude', 'perm-0')?.sessionId).toBe('s1')
  expect(mirror.configs('p1', 'claude')).toEqual(cfg('m1'))
  expect(folded).toEqual([{ pageId: 'p1', agentId: 'claude', requestId: 'perm-0' }])

  // 没有任何命令 / 配置也要广播（空数组）：前端据此知道问过了、没有
  sent.length = 0
  mirror.bind('p2', 'omp', 'sx', adapter)
  expect(sent.map((s) => [s.ev.type, agentOf(s.ev)])).toEqual([['commands', 'omp'], ['config', 'omp']])
})

test('常驻监听：按 sessionId 找页面，找不到就丢；之后的 bind 用执行端快照补齐', () => {
  const { mirror, sent, folded } = setup()
  const adapter = new StubAdapter()
  mirror.listen('claude', adapter)

  // 还没有人绑定：事件丢掉，不是报错；没带 sessionId 的同样忽略
  adapter.emit({ type: 'commands', list: [{ name: 'a' }], sessionId: 's1' })
  adapter.emit({ type: 'commands', list: [{ name: 'a' }] })
  expect(sent).toEqual([])

  // 执行端一直缓存着：绑定时的快照里有那条命令
  adapter.states.set('s1', { ...EMPTY, commands: [{ name: 'a' }] })
  mirror.bind('p1', 'claude', 's1', adapter)
  expect(sent[0]?.ev).toMatchObject({ type: 'commands', list: [{ name: 'a' }], agentId: 'claude' })

  // 之后的增量：属于 s1 → p1；别的会话 → 丢；轮次事件（text）不归镜像
  sent.length = 0
  adapter.emit({ type: 'commands', list: [{ name: 'b' }], sessionId: 's1' })
  adapter.emit({ type: 'commands', list: [{ name: 'zzz' }], sessionId: 's2' })
  adapter.emit({ type: 'text', delta: 'hi', sessionId: 's1' })
  expect(sent.map((s) => s.ev)).toEqual([{ type: 'commands', list: [{ name: 'b' }], sessionId: 's1', agentId: 'claude' }])

  // 审批到达：记下、广播、并入过程；同一 requestId 重复到达不会出现两条
  sent.length = 0
  adapter.emit(perm('perm-0', 's1'))
  adapter.emit(perm('perm-0', 's1'))
  expect(sent).toHaveLength(2)
  expect(folded.map((f) => f.requestId)).toEqual(['perm-0', 'perm-0'])
  const replayed: AgentEvent[] = []
  mirror.replay('p1', (ev) => replayed.push(ev))
  expect(replayed.filter((e) => e.type === 'permission')).toHaveLength(1)
})

test('隔离：同一页两个 agent 都是 perm-0 不串；同一 agent 两个页面各是各的；只认 agentId + requestId', () => {
  const { mirror, sent } = setup()
  const fake = new StubAdapter()
  const claude = new StubAdapter()
  mirror.listen('fake', fake)
  mirror.listen('claude', claude)
  fake.states.set('sa', { ...EMPTY, approvals: [perm('perm-0', 'sa')] })
  fake.states.set('sc', { ...EMPTY, approvals: [perm('perm-1', 'sc')] })
  claude.states.set('sb', { ...EMPTY, approvals: [perm('perm-0', 'sb')] })
  mirror.bind('p1', 'fake', 'sa', fake)
  mirror.bind('p1', 'claude', 'sb', claude)
  mirror.bind('p2', 'fake', 'sc', fake)

  expect(mirror.approval('p1', 'fake', 'perm-0')?.sessionId).toBe('sa')
  expect(mirror.approval('p1', 'claude', 'perm-0')?.sessionId).toBe('sb')
  expect(mirror.approval('p2', 'claude', 'perm-0')).toBeUndefined() // 别的页面没有
  expect(mirror.approval('p2', 'fake', 'perm-0')).toBeUndefined() // p2 的 fake 只有 perm-1

  // claude 的 perm-0 结束：只动 p1 的 claude 那条，fake 的 perm-0 和 p2 的 perm-1 都还在
  sent.length = 0
  claude.emit({ type: 'permission_resolved', requestId: 'perm-0', sessionId: 'sb' })
  expect(sent.map((s) => [s.pageId, s.ev.type, agentOf(s.ev)])).toEqual([['p1', 'permission_resolved', 'claude']])
  expect(mirror.approval('p1', 'claude', 'perm-0')).toBeUndefined()
  expect(mirror.approval('p1', 'fake', 'perm-0')).toBeDefined()
  expect(mirror.approval('p2', 'fake', 'perm-1')).toBeDefined()
})

test('replay：只回放这个页面已绑定的 agent 的 commands / config / 待批', () => {
  const { mirror } = setup()
  const adapter = new StubAdapter()
  adapter.states.set('s1', { commands: [{ name: 'x' }], configs: cfg('m1'), approvals: [perm('perm-0', 's1')] })
  adapter.states.set('s2', { commands: [{ name: 'y' }], configs: [], approvals: [] })
  mirror.bind('p1', 'fake', 's1', adapter)
  mirror.bind('p2', 'claude', 's2', adapter)

  const got: AgentEvent[] = []
  mirror.replay('p1', (ev) => got.push(ev))
  expect(got.map((e) => e.type)).toEqual(['commands', 'config', 'permission'])
  expect(got.map(agentOf)).toEqual(['fake', 'fake', 'fake'])

  const none: AgentEvent[] = []
  mirror.replay('没绑过的页', (ev) => none.push(ev))
  expect(none).toEqual([])
})

test('换会话：旧会话的待批按取消应答并广播 resolved；旧会话之后的事件丢弃', () => {
  const { mirror, sent } = setup()
  const adapter = new StubAdapter()
  mirror.listen('claude', adapter)
  adapter.states.set('old', { ...EMPTY, approvals: [perm('perm-0', 'old'), perm('perm-1', 'old')] })
  mirror.bind('p1', 'claude', 'old', adapter)
  sent.length = 0

  adapter.states.set('new', { ...EMPTY, configs: cfg('m1') })
  mirror.bind('p1', 'claude', 'new', adapter)
  // 不可达的待批一律按取消应答，否则进程永远 busy
  expect(adapter.answered).toEqual([
    { requestId: 'perm-0', optionId: null },
    { requestId: 'perm-1', optionId: null },
  ])
  expect(resolvedIds(sent)).toEqual(['perm-0', 'perm-1'])
  expect(mirror.approval('p1', 'claude', 'perm-0')).toBeUndefined()

  // 执行端随后才发的旧会话的 resolved：丢弃，不重复广播
  sent.length = 0
  adapter.emit({ type: 'permission_resolved', requestId: 'perm-0', sessionId: 'old' })
  expect(sent).toEqual([])
})

test('同一会话重新 bind：快照里已经没有的待批广播 resolved（不应答 agent）；新出现的补上', () => {
  const { mirror, sent } = setup()
  const adapter = new StubAdapter()
  adapter.states.set('s1', { ...EMPTY, approvals: [perm('perm-0', 's1'), perm('perm-1', 's1')] })
  mirror.bind('p1', 'claude', 's1', adapter)
  sent.length = 0

  adapter.states.set('s1', { ...EMPTY, approvals: [perm('perm-1', 's1'), perm('perm-2', 's1')] })
  mirror.bind('p1', 'claude', 's1', adapter)
  expect(resolvedIds(sent)).toEqual(['perm-0'])
  expect(adapter.answered).toEqual([])
  expect(mirror.approval('p1', 'claude', 'perm-0')).toBeUndefined()
  expect(mirror.approval('p1', 'claude', 'perm-2')).toBeDefined()
})

test('config：agent 侧改的值落成页面级意图（只落变了的）；本轮消息级覆盖 / 首次出现的不落，镜像与广播照常', () => {
  const { mirror, sent, persisted, overridden } = setup()
  const adapter = new StubAdapter()
  mirror.listen('claude', adapter)
  adapter.states.set('s1', { ...EMPTY, configs: cfg('m1') })
  mirror.bind('p1', 'claude', 's1', adapter)

  adapter.emit({ type: 'config', options: cfg('m2'), sessionId: 's1' })
  expect(persisted).toEqual([{ pageId: 'p1', agentId: 'claude', values: { model: 'm2' } }])
  adapter.emit({ type: 'config', options: cfg('m2'), sessionId: 's1' }) // 没变
  expect(persisted).toHaveLength(1)

  // 覆盖期内（消息级覆盖的生效与轮末还原）：不落库，但镜像和前端照常跟着变
  overridden.add('model')
  sent.length = 0
  adapter.emit({ type: 'config', options: cfg('m1'), sessionId: 's1' })
  expect(persisted).toHaveLength(1)
  expect(mirror.configs('p1', 'claude').find((o) => o.id === 'model')?.currentValue).toBe('m1')
  expect(sent.at(-1)?.ev).toMatchObject({ type: 'config', agentId: 'claude' })

  // mode 的改动（agent 自己切的，如主人批准退出计划进了跳过全部确认）同样是页面级意图
  overridden.clear()
  adapter.emit({ type: 'config', options: cfg('m1', 'bypassPermissions'), sessionId: 's1' })
  expect(persisted.at(-1)).toEqual({ pageId: 'p1', agentId: 'claude', values: { mode: 'bypassPermissions' } })

  // bind 时还没有任何配置项：之后整份出现不算用户改了
  adapter.states.set('s2', EMPTY)
  mirror.bind('p2', 'claude', 's2', adapter)
  const before = persisted.length
  adapter.emit({ type: 'config', options: cfg('m2'), sessionId: 's2' })
  expect(persisted).toHaveLength(before)
})

test('connector 终态断开：只清它名下的待批并广播 resolved，别的 agent 不动，之后不再回放它', () => {
  const { mirror, sent } = setup()
  const adapter = new StubAdapter()
  const remote = 'c:conn1:claude'
  adapter.states.set('s1', { ...EMPTY, approvals: [perm('perm-0', 's1')] })
  adapter.states.set('s2', { ...EMPTY, approvals: [perm('perm-0', 's2')] })
  mirror.bind('p1', remote, 's1', adapter)
  mirror.bind('p1', 'fake', 's2', adapter)
  sent.length = 0

  mirror.dropConnector('conn1')
  expect(sent.map((s) => s.ev)).toEqual([{ type: 'permission_resolved', requestId: 'perm-0', sessionId: 's1', agentId: remote }])
  expect(mirror.approval('p1', remote, 'perm-0')).toBeUndefined()
  expect(mirror.approval('p1', 'fake', 'perm-0')).toBeDefined()
  const got: AgentEvent[] = []
  mirror.replay('p1', (ev) => got.push(ev))
  expect(new Set(got.map(agentOf))).toEqual(new Set(['fake']))

  // 别的 connector 的 id 前缀相近也不误伤
  mirror.bind('p1', 'c:conn10:claude', 's1', adapter)
  mirror.dropConnector('conn1')
  expect(mirror.approval('p1', 'c:conn10:claude', 'perm-0')).toBeDefined()
})

// ---------- 带队的组员会话（worker 槽）----------

test('worker 槽：同一个 agent 的主会话与多个组员会话各管各的待批，互不取消；组员的命令 / 配置不广播', () => {
  const { mirror, sent, folded } = setup()
  const adapter = new StubAdapter()
  adapter.states.set('main', { commands: [], configs: cfg('m1'), approvals: [perm('perm-0', 'main')] })
  mirror.bind('p1', 'claude', 'main', adapter)
  sent.length = 0

  const releaseA = mirror.bindWorker('p1', 'claude', 'wa', adapter)
  const releaseB = mirror.bindWorker('p1', 'claude', 'wb', adapter)
  mirror.listen('claude', adapter)
  // 组员会话里来了审批：广播带 agentId + sessionId，不并入本轮过程（fold 只给主会话）
  adapter.emit(perm('perm-1', 'wa'))
  adapter.emit(perm('perm-2', 'wb'))
  adapter.emit({ type: 'commands', list: [{ name: 'x' }], sessionId: 'wa' })
  adapter.emit({ type: 'config', options: cfg('m2'), sessionId: 'wa' })
  expect(sent.map((s) => s.ev)).toEqual([
    { ...perm('perm-1', 'wa'), agentId: 'claude' },
    { ...perm('perm-2', 'wb'), agentId: 'claude' },
  ])
  expect(folded).toEqual([{ pageId: 'p1', agentId: 'claude', requestId: 'perm-0' }])
  // 三条审批都认得（按 agentId + requestId），主会话的没被顶掉；配置也没被组员改写
  expect(['perm-0', 'perm-1', 'perm-2'].map((id) => mirror.approval('p1', 'claude', id)?.sessionId)).toEqual(['main', 'wa', 'wb'])
  expect(mirror.configs('p1', 'claude')).toEqual(cfg('m1'))
  expect(adapter.answered).toEqual([])
  expect(mirror.allApprovals().map((a) => a.event.requestId).sort()).toEqual(['perm-0', 'perm-1', 'perm-2'])

  // 新订阅者回放：主会话的全量 + 组员的待批
  const replayed: AgentEvent[] = []
  mirror.replay('p1', (ev) => replayed.push(ev))
  expect(replayed.filter((e) => e.type === 'permission').map((e) => (e as PermissionEvent).requestId).sort()).toEqual(['perm-0', 'perm-1', 'perm-2'])

  // 组员 A 收尾：它还挂着的待批按取消应答并广播 resolved；主会话与 B 不受影响
  sent.length = 0
  releaseA()
  expect(adapter.answered).toEqual([{ requestId: 'perm-1', optionId: null }])
  expect(resolvedIds(sent)).toEqual(['perm-1'])
  expect(mirror.approval('p1', 'claude', 'perm-1')).toBeUndefined()
  expect(mirror.approval('p1', 'claude', 'perm-0')).toBeDefined()
  expect(mirror.approval('p1', 'claude', 'perm-2')).toBeDefined()
  releaseA() // 重复释放无害
  expect(resolvedIds(sent)).toEqual(['perm-1'])

  // 执行端自己宣布的结束（有人答了）：移除并广播
  sent.length = 0
  adapter.emit({ type: 'permission_resolved', requestId: 'perm-2', sessionId: 'wb' })
  expect(resolvedIds(sent)).toEqual(['perm-2'])
  expect(mirror.approval('p1', 'claude', 'perm-2')).toBeUndefined()
  releaseB()
  expect(adapter.answered).toEqual([{ requestId: 'perm-1', optionId: null }]) // B 已经没有待批，不再应答
})

test('worker 槽：bindWorker 用执行端快照播种已有的待批；connector 终态断开时组员的待批一并结束', () => {
  const { mirror, sent } = setup()
  const adapter = new StubAdapter()
  adapter.states.set('w', { commands: [], configs: [], approvals: [perm('perm-9', 'w')] })
  mirror.bindWorker('p1', 'c:box:claude', 'w', adapter)
  expect(sent.map((s) => s.ev)).toEqual([{ ...perm('perm-9', 'w'), agentId: 'c:box:claude' }])
  sent.length = 0
  mirror.dropConnector('other')
  expect(sent).toEqual([])
  mirror.dropConnector('box')
  expect(resolvedIds(sent)).toEqual(['perm-9'])
  expect(mirror.allApprovals()).toEqual([])
})
