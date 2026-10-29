// ---------- 会话事件（connector 链路）----------
// 中心与 connector 之间同样守同一组不变量：命令 / 审批归会话（connector 上的 AcpAgent 是事实源，常驻监听发
// `session` 帧，中心的 RemoteAgent 是副本）；审批没有超时，只在有人答 / 停止 / 进程退出 / 终态断开时结束，
// 离线答复 409 且审批留着；connector 的闲置回收和中心是同一个 busy 定义；机器主人 = 配对人。
// 前半是真的进程内 connector（配对、常驻、跑假 agent），后半是「脚本化 connector」：直接说协议，
// 断线 / 重连 / 快照内容完全由测试决定，真进程给不出确定的离线窗口。
// 机器只归接入人：别人要用得先有授权（machine_grants）；被授权的人不是主人，进不了「跳过全部确认」。
import { afterEach, expect, test, vi } from 'vitest'
import { WebSocket } from 'ws'
import { provisionConnector } from './test-helpers.js'
import { CONNECTOR_PATH, CONNECTOR_TOKEN_HEADER, type CenterMsg, type ConnMsg } from './agents/protocol.js'
import type { ConfigOption, PermissionEvent, SessionState } from './agents/types.js'
import {
  addPage,
  agentsList,
  answerPermission,
  base,
  commandNames,
  connectDoc,
  continuePage,
  docText,
  grantMachine,
  joinPageSpace,
  pageOwnership,
  pool,
  postJson,
  prepareAndWait,
  serverReplies,
  settled,
  setupPage,
  SSECollector,
  startConnector,
  userIdOf,
  userMessage,
  waitFor,
  waitPermission,
} from './agents/test-kit.js'

// connector 没有回环回落，中心对外地址必须显式给（同生产行为）；脚本化用例不经 startConnector 也要它
process.env.RAMET_PUBLIC_URL = base

const setConfig = (pageId: string, cookie: string, configId: string, value: string, agent: string) =>
  postJson(`/api/pages/${pageId}/agent-config`, cookie, { agent, configId, value })

const remote = (connectorId: string, agent: string) => `c:${connectorId}:${agent}`

// ---------- 命令 ----------

test('命令（connector）：选 agent 不发消息就有，各 agent 一份互不覆盖，晚到的订阅者回放得到', async () => {
  const { cookie, pageId } = await setupPage()
  const { spaceId, ownerId } = await pageOwnership(pageId)
  const connectorId = await startConnector({ spaceId, ownerId, name: 'cmdbox', cookie })
  const claude = remote(connectorId, 'claude')
  const fake = remote(connectorId, 'fake')
  const sse = new SSECollector()
  await sse.start(pageId, cookie)

  await prepareAndWait(sse, pageId, cookie, claude)
  await sse.wait((e) => e.type === 'commands' && e.agentId === claude && e.list.length > 0)
  expect(commandNames(sse.events, claude)).toEqual(['claude-cmd'])
  await prepareAndWait(sse, pageId, cookie, fake)
  await sse.wait((e) => e.type === 'commands' && e.agentId === fake && e.list.length > 0)
  expect(commandNames(sse.events, fake)).toEqual(['fake-cmd'])
  expect(commandNames(sse.events, claude)).toEqual(['claude-cmd'])

  const late = new SSECollector()
  await late.start(pageId, cookie)
  await late.wait((e) => e.type === 'commands' && e.agentId === fake && e.list.length > 0)
  expect(commandNames(late.events, claude)).toEqual(['claude-cmd'])
  sse.stop()
  late.stop()
})

// ---------- 审批 ----------

test('审批（connector）：两台机器上的 agent 各自从 perm-0 数起，requestId 相同也不串', async () => {
  const { cookie, pageId: p1 } = await setupPage()
  const p2 = await addPage(p1, cookie)
  const { spaceId, ownerId } = await pageOwnership(p1)
  const boxA = await startConnector({ spaceId, ownerId, name: 'boxa', cookie })
  const boxB = await startConnector({ spaceId, ownerId, name: 'boxb', cookie })
  const d1 = await connectDoc(p1, cookie)
  const d2 = await connectDoc(p2, cookie)
  userMessage(d1.document, '需要权限')
  userMessage(d2.document, '需要权限')
  const s1 = new SSECollector()
  const s2 = new SSECollector()
  await s1.start(p1, cookie)
  await s2.start(p2, cookie)
  expect(await continuePage(p1, cookie, { agent: remote(boxA, 'fake') })).toBe(202)
  expect(await continuePage(p2, cookie, { agent: remote(boxB, 'fake') })).toBe(202)
  const a1 = await waitPermission(s1)
  const a2 = await waitPermission(s2)

  expect(a1.agentId).toBe(remote(boxA, 'fake'))
  expect(a2.agentId).toBe(remote(boxB, 'fake'))
  expect(a1.requestId).toBe(a2.requestId) // 两个 connector 各有各的进程，各自从 perm-0 数起
  // 拿另一台机器的 agentId 答：这一页没有那条审批
  expect((await postJson(`/api/pages/${p1}/permission`, cookie, { agentId: remote(boxB, 'fake'), requestId: a1.requestId, optionId: 'allow_once' })).status).toBe(404)

  expect((await answerPermission(p1, cookie, a1, 'allow_once')).status).toBe(200)
  await waitFor(() => docText(d1).includes('granted:allow_once'))
  expect(docText(d2)).not.toContain('granted:')
  expect((await answerPermission(p2, cookie, a2, 'reject_once')).status).toBe(200)
  await waitFor(() => docText(d2).includes('granted:reject_once'))
  for (const s of [s1, s2]) s.stop()
  d1.destroy()
  d2.destroy()
})

test('停止（connector）：结束该会话的待批并广播 resolved，之后再答 404', async () => {
  const { cookie, pageId } = await setupPage()
  const { spaceId, ownerId } = await pageOwnership(pageId)
  const connectorId = await startConnector({ spaceId, ownerId, name: 'stopbox', cookie })
  const d = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  userMessage(d.document, '需要权限')
  expect(await continuePage(pageId, cookie, { agent: remote(connectorId, 'fake') })).toBe(202)
  const pending = await waitPermission(sse)

  expect((await postJson(`/api/pages/${pageId}/stop`, cookie)).status).toBe(200)
  await sse.wait((e) => e.type === 'permission_resolved' && e.requestId === pending.requestId && e.agentId === pending.agentId)
  await sse.wait((e) => e.type === 'status' && e.state === 'done')
  expect((await answerPermission(pageId, cookie, pending, 'allow_once')).status).toBe(404)
  sse.stop()
  d.destroy()
})

test('审批没有超时（connector，假时钟）：推进 11 分钟审批仍在、connector 与中心两层都没把它回收，之后答得上', async () => {
  const { cookie, pageId } = await setupPage()
  const { spaceId, ownerId } = await pageOwnership(pageId)
  const connectorId = await startConnector({ spaceId, ownerId, name: 'idlebox2', cookie }) // 配对走真实时钟
  const d = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  const late = new SSECollector()
  // 进程内 connector 与中心共用全局时钟：从这里起 connector 的 IdleRecycler（第一次 new 时才 arm）和中心的
  // 都在假时钟上。随真实时间自走，轮询 / 收尾里的等待照常往前
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
  try {
    userMessage(d.document, '后台审批') // 这一轮立刻结束，只剩那条待批；busy 若只看在飞 prompt，10 分钟后进程会被回收
    expect(await continuePage(pageId, cookie, { agent: remote(connectorId, 'fake') })).toBe(202)
    const pending = await waitPermission(sse)
    await sse.wait((e) => e.type === 'status' && e.state === 'done')
    sse.stop() // 长连接不跨越时间跳跃；跳完用新订阅看回放

    await vi.advanceTimersByTimeAsync(11 * 60_000)
    await late.start(pageId, cookie)
    await waitPermission(late, (e) => e.requestId === pending.requestId)
    // 真能答才算还活着：connector 上的进程被回收的话，审批早被按取消结束并清出了副本（404 / 409）
    expect((await answerPermission(pageId, cookie, pending, 'allow_once')).status).toBe(200)
    await late.wait((e) => e.type === 'permission_resolved' && e.requestId === pending.requestId)
    userMessage(d.document, '报后台审批')
    expect(await continuePage(pageId, cookie, { agent: remote(connectorId, 'fake') })).toBe(202)
    await waitFor(() => docText(d).includes('bg:allow_once'))
  } finally {
    vi.useRealTimers()
    late.stop()
    d.destroy()
  }
})

// ---------- 机器主人 ----------

test('主人（connector）：配对人是主人 —— 没授权的人（成员 / 全局 admin）看不到也改不了；被授权的成员不是主人，进不了「跳过全部确认」', async () => {
  const { cookie, pageId } = await setupPage() // alice：空间 owner、页面创建人，也是配对人（全局 admin 与否无关：connector 的主人只认配对人）
  const bob = await joinPageSpace(pageId, 'bob', { role: 'member' })
  const root = await joinPageSpace(pageId, 'root', { user: 'admin' })
  const { spaceId, ownerId } = await pageOwnership(pageId)
  const connectorId = await startConnector({ spaceId, ownerId, name: 'ownbox', cookie })
  const claude = remote(connectorId, 'claude')

  const { rows } = await pool.query<{ owner_id: string | null }>('SELECT owner_id FROM connectors WHERE id = $1', [connectorId])
  expect(rows[0]?.owner_id).toBe(ownerId)
  const ownerOf = async (who: string) => (await agentsList(who)).find((a) => a.id === claude)?.posture
  expect(await ownerOf(cookie)).toEqual({ owner: true, modes: true, unrestricted: ['bypassPermissions'] })

  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  await prepareAndWait(sse, pageId, cookie, claude)

  // 没授权：目录里没有这台机器的 agent，改任何配置（连 mode=default 这种无害值）都是 403
  expect(await ownerOf(bob)).toBeUndefined()
  expect(await ownerOf(root)).toBeUndefined() // 全局 admin 也一样：没有第三条路
  for (const who of [bob, root]) {
    expect((await setConfig(pageId, who, 'mode', 'bypassPermissions', claude)).status).toBe(403)
    expect((await setConfig(pageId, who, 'mode', 'default', claude)).status).toBe(403)
  }

  // 给 bob 授权（agent 范围）：他能看到、能用，但不是主人 —— 进不了「跳过全部确认」；root 依旧不行
  await grantMachine(connectorId, await userIdOf('bob'))
  expect((await ownerOf(bob))?.owner).toBe(false)
  expect(await ownerOf(root)).toBeUndefined()
  expect((await setConfig(pageId, bob, 'mode', 'bypassPermissions', claude)).status).toBe(403)
  expect((await setConfig(pageId, root, 'mode', 'bypassPermissions', claude)).status).toBe(403)
  expect((await setConfig(pageId, bob, 'mode', 'default', claude)).status).toBe(200)
  expect((await setConfig(pageId, cookie, 'mode', 'bypassPermissions', claude)).status).toBe(200)

  // 会话在「跳过全部确认」：被授权的非主人发起 → 本轮失败；主人发起 → agent 真的在该档下跑
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '第一问')
  expect(await continuePage(pageId, bob, { agent: claude })).toBe(202)
  const failure = await sse.wait((e) => e.type === 'error')
  if (failure.type !== 'error') throw new Error('不是错误事件')
  expect(failure.message).toContain('只有机器主人能发起')
  expect(await continuePage(pageId, cookie, { agent: claude })).toBe(202)
  await waitFor(() => docText(a).includes('mode=bypassPermissions'))

  // 被授权的人把会话切回去之后，自己也能发起（他本来就有这台机器的 agent 使用权）
  expect((await setConfig(pageId, bob, 'mode', 'default', claude)).status).toBe(200)
  userMessage(a.document, '第二问')
  expect(await continuePage(pageId, bob, { agent: claude })).toBe(202)
  await waitFor(() => docText(a).includes('mode=default'))
  sse.stop()
  a.destroy()
})

test('主人（connector）：被授权的非主人选会把会话切进「跳过全部确认」的审批选项 403 且审批留着；普通选项照常；主人选了会话真的切过去', async () => {
  const { cookie, pageId } = await setupPage()
  const bob = await joinPageSpace(pageId, 'bob', { role: 'member' })
  const { spaceId, ownerId } = await pageOwnership(pageId)
  const connectorId = await startConnector({ spaceId, ownerId, name: 'planbox', cookie })
  const claude = remote(connectorId, 'claude')
  await grantMachine(connectorId, await userIdOf('bob'))
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)

  userMessage(a.document, '退出计划')
  expect(await continuePage(pageId, bob, { agent: claude })).toBe(202) // bob 发起，审批在 bob 的这一轮里
  const plan = await waitPermission(sse, (e) => e.agentId === claude)
  expect(plan.options.map((o) => o.optionId)).toContain('exit-plan-bypass')

  expect((await answerPermission(pageId, bob, plan, 'exit-plan-bypass')).status).toBe(403)
  // 403 不吞审批：新订阅者还看得到它
  const late = new SSECollector()
  await late.start(pageId, cookie)
  await waitPermission(late, (e) => e.requestId === plan.requestId)

  // 主人选了：会话切进 bypassPermissions（agent 只推了 current_mode_update），镜像据此广播并落成页面级意图
  expect((await answerPermission(pageId, cookie, plan, 'exit-plan-bypass')).status).toBe(200)
  await sse.wait((e) => e.type === 'config' && e.agentId === claude && e.options.some((o) => o.category === 'mode' && o.currentValue === 'bypassPermissions'))
  await waitFor(() => docText(a).includes('plan-exit:exit-plan-bypass'))

  // 之后被授权的非主人的下一轮不能在该档执行
  userMessage(a.document, '第二问')
  expect(await continuePage(pageId, bob, { agent: claude })).toBe(202)
  const blocked = await sse.wait((e) => e.type === 'error')
  if (blocked.type !== 'error') throw new Error('不是错误事件')
  expect(blocked.message).toContain('只有机器主人能发起')
  sse.stop()
  late.stop()
  a.destroy()
})

test('主人（connector）：被授权的非主人选普通审批选项不受限', async () => {
  const { cookie, pageId } = await setupPage()
  const bob = await joinPageSpace(pageId, 'bob', { role: 'member' })
  const { spaceId, ownerId } = await pageOwnership(pageId)
  const connectorId = await startConnector({ spaceId, ownerId, name: 'planbox2', cookie })
  const claude = remote(connectorId, 'claude')
  await grantMachine(connectorId, await userIdOf('bob'))
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  userMessage(a.document, '退出计划')
  expect(await continuePage(pageId, bob, { agent: claude })).toBe(202)
  const plan = await waitPermission(sse, (e) => e.agentId === claude)
  expect((await answerPermission(pageId, bob, plan, 'exit-plan-default')).status).toBe(200)
  await waitFor(() => docText(a).includes('plan-exit:exit-plan-default'))
  sse.stop()
  a.destroy()
})

// ---------- 重新生成 ----------

test('重新生成（connector）：绑定行指向被重做的那块，而不是新插一块', async () => {
  const { cookie, pageId } = await setupPage()
  const { spaceId, ownerId } = await pageOwnership(pageId)
  const connectorId = await startConnector({ spaceId, ownerId, name: 'regenbox', cookie })
  const agent = remote(connectorId, 'fake')
  const d = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  userMessage(d.document, '慢慢来 第一问') // 一轮约 1.5s，重做时有窗口看绑定行
  expect(await continuePage(pageId, cookie, { agent })).toBe(202)
  await settled(sse, 1)
  const [first] = await serverReplies(pageId, cookie)

  expect((await postJson(`/api/pages/${pageId}/replies/${first!.id}/regenerate`, cookie)).status).toBe(202)
  await waitFor(async () => (await pool.query('SELECT 1 FROM open_runs WHERE page_id = $1', [pageId])).rows.length > 0)
  const { rows } = await pool.query<{ reply_id: string; agent_id: string }>('SELECT reply_id, agent_id FROM open_runs WHERE page_id = $1', [pageId])
  expect(rows[0]).toEqual({ reply_id: first!.id, agent_id: agent })
  await settled(sse, 2)
  const after = await serverReplies(pageId, cookie)
  expect(after).toHaveLength(1)
  expect(after[0]).toMatchObject({ id: first!.id, outcome: 'end' })
  sse.stop()
  d.destroy()
})

// ---------- 脚本化 connector（直接说协议）----------

type Wire = { ws: WebSocket; frames: CenterMsg[]; send: (msg: ConnMsg) => void }
const wires: Wire[] = []
afterEach(() => {
  for (const wire of wires.splice(0)) wire.ws.terminate()
})

const MODEL: ConfigOption = { id: 'model', name: 'Model', category: 'model', currentValue: 'm1', options: [{ value: 'm1', name: 'M1' }] }
const perm = (requestId: string, sessionId: string): PermissionEvent => ({
  type: 'permission',
  requestId,
  title: '写文件',
  options: [{ optionId: 'allow', name: '允许' }],
  sessionId,
})

/** 连上中心并完成 hello / welcome，之后一切由测试说了算 */
async function dial(token: string): Promise<Wire> {
  const frames: CenterMsg[] = []
  const ws = new WebSocket(`${base.replace('http', 'ws')}${CONNECTOR_PATH}`, { headers: { [CONNECTOR_TOKEN_HEADER]: token } })
  ws.on('message', (data) => {
    const frame: CenterMsg = JSON.parse(String(data))
    frames.push(frame)
  })
  const opened = Promise.withResolvers<void>()
  ws.once('open', () => opened.resolve())
  ws.once('error', (err) => opened.reject(err))
  await opened.promise
  const wire: Wire = { ws, frames, send: (msg) => ws.send(JSON.stringify(msg)) }
  wires.push(wire)
  wire.send({ t: 'hello', name: 'scripted', defaultCwd: '/tmp', agents: [{ id: 'claude', label: 'Claude' }] })
  await waitFor(() => frames.some((f) => f.t === 'welcome'))
  return wire
}

async function frameOf<T extends CenterMsg['t']>(wire: Wire, t: T): Promise<Extract<CenterMsg, { t: T }>> {
  await waitFor(() => wire.frames.some((f) => f.t === t))
  const hit = wire.frames.find((f): f is Extract<CenterMsg, { t: T }> => f.t === t)
  if (!hit) throw new Error(`没收到 ${t} 帧`)
  return hit
}

test('脚本化 connector：session 帧驱动命令与审批；离线答 409 且审批留着；重连 sessions 快照对账；撤销清理并广播', async () => {
  const { cookie, pageId } = await setupPage()
  const { spaceId, ownerId } = await pageOwnership(pageId)
  const paired = await provisionConnector(pool, { spaceId, ownerId, name: 'scripted' })
  const agent = remote(paired.connectorId, 'claude')
  let wire = await dial(paired.token)
  await waitFor(async () => (await agentsList(cookie)).some((a) => a.id === agent))

  // 建会话：new 应答里的 state 播种副本、镜像 bind 后广播全量
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  expect((await postJson(`/api/pages/${pageId}/agent-prepare`, cookie, { agent })).status).toBe(202)
  const created = await frameOf(wire, 'new')
  const state: SessionState = { commands: [{ name: 'x' }], configs: [MODEL], approvals: [] }
  wire.send({ t: 'res', rid: created.rid, sessionId: 'S1', state })
  await sse.wait((e) => e.type === 'config' && e.agentId === agent && e.options.length > 0)
  expect(commandNames(sse.events, agent)).toEqual(['x'])

  // 之后全靠 session 帧（没有 prompt 在飞）：命令增量 + 一条待批
  wire.send({ t: 'session', agent: 'claude', sessionId: 'S1', ev: { type: 'commands', list: [{ name: 'x' }, { name: 'y' }] } })
  wire.send({ t: 'session', agent: 'claude', sessionId: 'S1', ev: perm('perm-0', 'S1') })
  const first = await waitPermission(sse)
  expect(first).toMatchObject({ agentId: agent, requestId: 'perm-0' })
  expect(commandNames(sse.events, agent)).toEqual(['x', 'y'])

  // 答复按 agent + requestId 回 connector；答了不等于结束，结束只认执行端的 resolved
  expect((await answerPermission(pageId, cookie, first, 'allow')).status).toBe(200)
  // 驱动帧带操作人（connector 第二道闸据此判）：这里是 alice 答的
  expect(await frameOf(wire, 'permission')).toEqual({ t: 'permission', actor: ownerId, agent: 'claude', requestId: 'perm-0', optionId: 'allow' })
  const late = new SSECollector()
  await late.start(pageId, cookie)
  await waitPermission(late, (e) => e.requestId === 'perm-0')
  wire.send({ t: 'session', agent: 'claude', sessionId: 'S1', ev: { type: 'permission_resolved', requestId: 'perm-0', sessionId: 'S1' } })
  await sse.wait((e) => e.type === 'permission_resolved' && e.requestId === 'perm-0' && e.agentId === agent)

  // connector 掉线（非终态）：答复 409，审批留着，新订阅者还看得到它
  wire.send({ t: 'session', agent: 'claude', sessionId: 'S1', ev: perm('perm-1', 'S1') })
  const second = await waitPermission(sse, (e) => e.requestId === 'perm-1')
  wire.ws.close()
  await waitFor(async () => !(await agentsList(cookie)).some((a) => a.id === agent))
  expect((await answerPermission(pageId, cookie, second, 'allow')).status).toBe(409)
  const after = new SSECollector()
  await after.start(pageId, cookie)
  await waitPermission(after, (e) => e.requestId === 'perm-1')

  // 重连：断线期间 perm-1 已经在 connector 上结束了，hello 后的 sessions 快照对账，补发 resolved
  wire = await dial(paired.token)
  wire.send({ t: 'sessions', list: [{ agent: 'claude', sessionId: 'S1', state }] })
  await sse.wait((e) => e.type === 'permission_resolved' && e.requestId === 'perm-1' && e.agentId === agent)
  expect((await answerPermission(pageId, cookie, second, 'allow')).status).toBe(404)

  // 终态断开（撤销 connector）：名下待批不会再有人答，按结束处理并广播
  wire.send({ t: 'session', agent: 'claude', sessionId: 'S1', ev: perm('perm-2', 'S1') })
  const third = await waitPermission(sse, (e) => e.requestId === 'perm-2')
  expect((await fetch(`${base}/api/connectors/${paired.connectorId}`, { method: 'DELETE', headers: { cookie } })).status).toBe(200)
  await sse.wait((e) => e.type === 'permission_resolved' && e.requestId === 'perm-2' && e.agentId === agent)
  expect((await answerPermission(pageId, cookie, third, 'allow')).status).toBe(404)
  for (const s of [sse, late, after]) s.stop()
})
