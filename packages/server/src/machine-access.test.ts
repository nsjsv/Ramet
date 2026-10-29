/* ---------- 机器所有权矩阵 ----------
 * connector 接入的机器只归接入人（connectors.owner_id）。别人（空间 owner、全局 admin、同空间的任何成员）
 * 默认完全用不了，要用得有一条已在机器上确认、未过期、未收回、scope 匹配的授权（machine_grants），没有第三条路。
 *
 * 每个入口都盯两件事：
 *   1) 响应：能用的 200/202；同空间但没授权的 403（带主人名）；页面都写不了的（viewer / 非成员）404；
 *      看不到这台机器的（不在它所在空间的全局 admin）按「未知 agent」400（审批是 409，与机器不在线同码）；
 *   2) 那台机器一侧没收到该操作人的任何驱动帧（new / load / ls / prompt / config / permission），
 *      而不是回了 403 但帧其实发出去了。
 * 机器是脚本化 connector：直接说协议，记全部下行帧；prompt 默认立刻回一句话并结束（hold 时挂住，测停止）。
 * 第二道闸（connector 自己的本地名单）见最后几个用例，那几个用真 connector。 */
import { afterEach, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { approveConnector } from './agents/connectors.js'
import { AgentManager } from './agents/manager.js'
import { ConnectorHub } from './agents/hub.js'
import { ReplyWriter } from './agents/doc.js'
import { insertOpenRun } from './agents/remote-run.js'
import {
  CONNECTOR_PATH,
  CONNECTOR_TOKEN_HEADER,
  isDrivenMsg,
  type CenterMsg,
  type ConnMsg,
  type DrivenMsg,
} from './agents/protocol.js'
import type { ConfigOption, PermissionEvent, SessionState } from './agents/types.js'
import { readConnectorConfig, writeConnectorConfig } from './connector/access.js'
import { provisionConnector } from './test-helpers.js'
import { mintPageToken } from './page-read.js'
import {
  SSECollector,
  agentsList,
  answerPermission,
  base,
  connectDoc,
  connectorLogs,
  connectorTokenFile,
  continuePage,
  grantMachine,
  insertUser,
  login,
  pool,
  postJson,
  replyBlocks,
  s,
  serverReplies,
  settled,
  startConnector,
  userMessage,
  waitFor,
} from './agents/test-kit.js'

// connector 没有回环回落，中心对外地址必须显式给（同生产）
process.env.RAMET_PUBLIC_URL = base

type Role =
  | 'mowner' // 机器主人：普通用户、空间 member，配对人
  | 'sowner' // 空间 owner，不是机器主人
  | 'gadmin' // 全局 admin，加入了同一个空间
  | 'plain' // 普通 member，没授权
  | 'granted' // member + 已确认的 agent 授权
  | 'pending' // member + 授权还没在机器上确认
  | 'expired' // member + 已过期的授权
  | 'revoked' // member + 已收回的授权
  | 'machineOnly' // member + 只有 machine 范围的授权（终端 / 文件），没有 agent
  | 'viewer' // 空间 viewer
  | 'outsider' // 不在空间里的普通用户
  | 'outadmin' // 不在空间里的全局 admin，与 outsider 一样看不到
  | 'localOnly' // member + 只写进了 connector 本地名单、中心库里没授权（真 connector 用例）

const ROLES: readonly Role[] = [
  'mowner', 'sowner', 'gadmin', 'plain', 'granted', 'pending', 'expired', 'revoked', 'machineOnly', 'viewer', 'outsider', 'outadmin',
]
/** 能用这台机器 agent 的只有这两个 */
const ALLOWED: readonly Role[] = ['mowner', 'granted']
const DENIED = ROLES.filter((r) => !ALLOWED.includes(r))
/** 页面可写、空间里看得到这台机器、但没有 agent 使用权的人：拿到 403 */
const DENIED_MEMBERS = DENIED.filter((r) => r !== 'viewer' && r !== 'outsider' && r !== 'outadmin')

/** 一个入口上每种角色该拿到的状态码。ok = 能用的；看不到页面的（viewer 之外的非成员，含全局 admin）404 */
function want(role: Role, ok: number): number {
  if (ALLOWED.includes(role)) return ok
  if (role === 'viewer' || role === 'outsider' || role === 'outadmin') return 404
  return 403
}

const MODEL: ConfigOption = { id: 'model', name: 'Model', category: 'model', currentValue: 'm1', options: [{ value: 'm1', name: 'M1' }] }
const STATE: SessionState = { commands: [], configs: [MODEL], approvals: [] }
const AGENTS = [{ id: 'claude', label: 'Claude' }, { id: 'fake', label: 'Fake' }]

type PromptFrame = Extract<DrivenMsg, { t: 'prompt' }>

type Machine = {
  id: string
  name: string
  ws: WebSocket
  frames: CenterMsg[]
  /** true = prompt 挂住不回（测停止） */
  hold: boolean
  held: PromptFrame[]
  sessions: string[]
  send: (msg: ConnMsg) => void
  driven: () => DrivenMsg[]
  /** 操作人是 actor 的驱动帧 */
  by: (actor: string) => DrivenMsg[]
}

const machines: Machine[] = []
// 登记在 test-kit 的 afterEach(truncateAll) 之后，所以先于它执行：先断开脚本化机器再清库
afterEach(() => {
  for (const m of machines.splice(0)) m.ws.terminate()
})

function respond(m: Machine, msg: CenterMsg): void {
  switch (msg.t) {
    case 'new': {
      const sessionId = `${m.name}-S${m.sessions.length + 1}`
      m.sessions.push(sessionId)
      m.send({ t: 'res', rid: msg.rid, sessionId, state: STATE })
      break
    }
    case 'load':
      m.send({ t: 'res', rid: msg.rid, state: STATE })
      break
    case 'ls':
      m.send({ t: 'res', rid: msg.rid, dirs: { path: '/tmp', parent: null, dirs: [], truncated: false } })
      break
    case 'config':
      m.send({ t: 'res', rid: msg.rid, configOptions: [MODEL] })
      break
    case 'prompt':
      if (m.hold) {
        m.held.push(msg)
        break
      }
      m.send({ t: 'ev', rid: msg.rid, runId: msg.runId, seq: 0, ev: { type: 'text', delta: '好的', sessionId: msg.sessionId } })
      m.send({ t: 'end', rid: msg.rid, runId: msg.runId, seq: 1, stopReason: 'end_turn' })
      break
    case 'cancel': {
      const held = m.held.find((p) => p.sessionId === msg.sessionId || (msg.runId && p.runId === msg.runId))
      if (held) m.send({ t: 'end', rid: held.rid, runId: held.runId, seq: 0, stopReason: 'cancelled' })
      break
    }
    default:
      break
  }
}

/** 建机器 + 连上 + hello/welcome；之后所有下行帧都记下来并按脚本应答 */
async function pairMachine(spaceId: string, ownerId: string, name: string): Promise<Machine> {
  const paired = await provisionConnector(pool, { spaceId, ownerId, name })
  // 成员配对的机器要空间 owner 批准才生效；这里的矩阵测的是已生效的机器
  await approveConnector(pool, paired.connectorId)
  const frames: CenterMsg[] = []
  const ws = new WebSocket(`${base.replace('http', 'ws')}${CONNECTOR_PATH}`, { headers: { [CONNECTOR_TOKEN_HEADER]: paired.token } })
  const m: Machine = {
    id: paired.connectorId,
    name,
    ws,
    frames,
    hold: false,
    held: [],
    sessions: [],
    send: (msg) => ws.send(JSON.stringify(msg)),
    driven: () => frames.filter(isDrivenMsg),
    by: (actor) => frames.filter(isDrivenMsg).filter((f) => f.actor === actor),
  }
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as CenterMsg
    frames.push(msg)
    respond(m, msg)
  })
  const opened = Promise.withResolvers<void>()
  ws.once('open', () => opened.resolve())
  ws.once('error', (err) => opened.reject(err))
  await opened.promise
  machines.push(m)
  m.send({ t: 'hello', name, defaultCwd: '/tmp', agents: AGENTS })
  await waitFor(() => frames.some((f) => f.t === 'welcome'))
  return m
}

type World = {
  spaceId: string
  pageId: string
  id: Record<Role, string>
  cookie: Record<Role, string>
  /** 机器的 agent 目录 id */
  claude: string
  fake: string
  m: Machine
}

/** 一个空间 + 一页 + 一台脚本化机器（由 mowner 配对）+ 各种授权。roles 只建需要的角色 */
async function world(roles: readonly Role[] = ROLES, opts: { grants?: boolean } = {}): Promise<World> {
  const id = {} as Record<Role, string>
  const cookie = {} as Record<Role, string>
  for (const role of roles) {
    id[role] = await insertUser(role, role === 'gadmin' || role === 'outadmin' ? 'admin' : 'user')
    cookie[role] = await login(role)
  }
  const space = (await (await postJson('/api/spaces', cookie.sowner, { name: 's' })).json()) as { id: string }
  for (const role of roles) {
    if (role === 'sowner' || role === 'outsider' || role === 'outadmin') continue
    await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [
      space.id, id[role], role === 'viewer' ? 'viewer' : 'member',
    ])
  }
  const page = (await (await postJson('/api/pages', cookie.sowner, { space_id: space.id })).json()) as { id: string }
  const m = await pairMachine(space.id, id.mowner, 'box')
  const w: World = { spaceId: space.id, pageId: page.id, id, cookie, claude: `c:${m.id}:claude`, fake: `c:${m.id}:fake`, m }
  await waitFor(async () => (await agentsList(cookie.mowner)).some((a) => a.id === w.claude))
  if (opts.grants !== false) await grantAll(w, roles)
  return w
}

/** 各角色的授权（脚本化机器没有本地名单，local 无关） */
async function grantAll(w: World, roles: readonly Role[]): Promise<void> {
  const has = (r: Role): boolean => roles.includes(r)
  if (has('granted')) await grantMachine(w.m.id, w.id.granted)
  if (has('pending')) await grantMachine(w.m.id, w.id.pending, { confirmed: false })
  if (has('expired')) await grantMachine(w.m.id, w.id.expired, { expiresInMs: -60_000 })
  if (has('revoked')) await grantMachine(w.m.id, w.id.revoked, { revoked: true })
  if (has('machineOnly')) await grantMachine(w.m.id, w.id.machineOnly, { scopes: ['machine'] })
}

/** 逐个角色打同一个入口并断言状态码。能用的放最后；roles 缺省 = 全部 */
async function sweep(
  w: World,
  label: string,
  ok: number,
  call: (cookie: string, role: Role) => Promise<Response>,
  roles: readonly Role[] = [...DENIED, ...ALLOWED],
): Promise<void> {
  for (const role of roles) {
    const res = await call(w.cookie[role], role)
    expect(res.status, `${label} / ${role}`).toBe(want(role, ok))
  }
}

/** 没有授权的人，机器一侧一个驱动帧都没收到 */
function expectSilent(w: World, roles: readonly Role[] = DENIED): void {
  for (const role of roles) expect(w.m.by(w.id[role]), `${role} 的驱动帧`).toEqual([])
}

const types = (frames: DrivenMsg[]): string[] => [...new Set(frames.map((f) => f.t))]

/** 服务端已经收到这页的这么多条用户消息（新连一个客户端读） */
async function serverHasMessages(pageId: string, cookie: string, n: number): Promise<void> {
  await waitFor(async () => {
    const p = await connectDoc(pageId, cookie)
    let count = 0
    p.document.getXmlFragment('prosemirror').forEach((c) => {
      if (c instanceof Y.XmlElement && c.nodeName === 'user_message') count += 1
    })
    p.destroy()
    return count >= n
  })
}

/** 用户消息：文字与 @ agent chip 交替（形状同 mention-chain.test） */
function mentionMessage(doc: Y.Doc, parts: Array<string | { agent: string; label: string }>): void {
  const frag = doc.getXmlFragment('prosemirror')
  const msg = new Y.XmlElement('user_message')
  const p = new Y.XmlElement('paragraph')
  msg.insert(0, [p])
  frag.insert(frag.length, [msg])
  for (const part of parts) {
    if (typeof part === 'string') {
      const t = new Y.XmlText()
      p.insert(p.length, [t])
      t.insert(0, part)
    } else {
      const el = new Y.XmlElement('agent_mention')
      el.setAttribute('agentId', part.agent)
      el.setAttribute('label', part.label)
      p.insert(p.length, [el])
    }
  }
}

test('目录与配置类入口（agents / prepare / config / dirs / cwd / choice）：只有主人与被授权的人；其余 403 / 404 / 400，机器一侧没有他们的帧', async () => {
  const w = await world()
  const sse = new SSECollector()
  await sse.start(w.pageId, w.cookie.mowner)

  // 目录：看不到就点不到，空间 owner、全局 admin、各种无效授权的人，目录里一条这台机器的 agent 都没有
  for (const role of ROLES) {
    const mine = (await agentsList(w.cookie[role])).map((a) => a.id).filter((id) => id.startsWith('c:'))
    expect(mine, `目录 / ${role}`).toEqual(ALLOWED.includes(role) ? [w.claude, w.fake] : [])
  }

  // prepare：主人先建会话（等配置项到），被授权的人复用它
  const prepare = (cookie: string): Promise<Response> => postJson(`/api/pages/${w.pageId}/agent-prepare`, cookie, { agent: w.claude })
  await sweep(w, 'agent-prepare', 202, prepare, [...DENIED, 'mowner'])
  await sse.wait((e) => e.type === 'config' && e.agentId === w.claude && e.options.length > 0)
  await sweep(w, 'agent-prepare', 202, prepare, ['granted'])
  // 403 的文案告诉人找谁要授权
  const refused = await prepare(w.cookie.plain)
  expect(await refused.json()).toMatchObject({ error: 'forbidden', message: expect.stringContaining('mowner') })

  const config = (cookie: string): Promise<Response> =>
    postJson(`/api/pages/${w.pageId}/agent-config`, cookie, { agent: w.claude, configId: 'model', value: 'm1' })
  await sweep(w, 'agent-config', 200, config)

  const dirs = (cookie: string): Promise<Response> =>
    fetch(`${base}/api/pages/${w.pageId}/agent-dirs?agent=${encodeURIComponent(w.claude)}&path=%2Ftmp`, { headers: { cookie } })
  await sweep(w, 'agent-dirs', 200, dirs)

  const cwd = (cookie: string): Promise<Response> => postJson(`/api/pages/${w.pageId}/agent-cwd`, cookie, { agent: w.claude, cwd: '/tmp' })
  await sweep(w, 'agent-cwd', 200, cwd)

  const choice = (cookie: string): Promise<Response> => postJson(`/api/pages/${w.pageId}/agent-choice`, cookie, { agent: w.claude })
  await sweep(w, 'agent-choice', 200, choice)

  // 机器一侧：没授权的人一个驱动帧都没有；能用的人的帧都带着他们自己的 actor
  expectSilent(w)
  expect(types(w.m.by(w.id.mowner))).toEqual(expect.arrayContaining(['new', 'config', 'ls']))
  expect(types(w.m.by(w.id.granted))).toEqual(expect.arrayContaining(['config', 'ls']))
  expect(w.m.driven().every((f) => f.actor === w.id.mowner || f.actor === w.id.granted)).toBe(true)
  sse.stop()
})

test('发起类入口（continue 含消息 attrs.agent / regenerate）：没授权的人发不起来，机器一侧没有任何驱动帧；被授权的人带着自己的 actor 跑', async () => {
  const w = await world()
  const sse = new SSECollector()
  await sse.start(w.pageId, w.cookie.mowner)
  const d = await connectDoc(w.pageId, w.cookie.mowner)
  userMessage(d.document, '你好', { agent: w.claude }) // 消息 attrs 指定了这台机器的 agent
  await serverHasMessages(w.pageId, w.cookie.mowner, 1)

  // 请求体指定 agent
  const cont = (cookie: string): Promise<Response> => postJson(`/api/pages/${w.pageId}/continue`, cookie, { agent: w.claude })
  await sweep(w, 'continue(body)', 202, cont, DENIED)
  // 只有消息 attrs 指定（请求体空）：同样要判
  for (const role of DENIED_MEMBERS) {
    expect(await continuePage(w.pageId, w.cookie[role], {}), `continue(attrs) / ${role}`).toBe(403)
  }
  expectSilent(w)
  expect(w.m.driven()).toEqual([]) // 到这里机器上一个驱动帧都没有
  expect(replyBlocks(d)).toEqual([]) // 也没有任何占位回复块

  // 主人发起，然后被授权的人重新生成 / 继续
  expect(await continuePage(w.pageId, w.cookie.mowner, { agent: w.claude })).toBe(202)
  await settled(sse, 1)
  expect(types(w.m.by(w.id.mowner))).toEqual(expect.arrayContaining(['new', 'prompt']))
  const [reply] = await serverReplies(w.pageId, w.cookie.mowner)
  expect(reply?.outcome).toBe('end')

  const regen = (cookie: string): Promise<Response> => postJson(`/api/pages/${w.pageId}/replies/${reply!.id}/regenerate`, cookie)
  await sweep(w, 'regenerate', 202, regen, DENIED)
  expectSilent(w)
  expect((await regen(w.cookie.granted)).status).toBe(202)
  await settled(sse, 2)
  expect(w.m.by(w.id.granted).filter((f) => f.t === 'prompt')).toHaveLength(1)

  userMessage(d.document, '再来一次', { agent: w.claude })
  await serverHasMessages(w.pageId, w.cookie.mowner, 2)
  expect(await continuePage(w.pageId, w.cookie.granted, { agent: w.claude })).toBe(202)
  await settled(sse, 3)
  expect(w.m.by(w.id.granted).filter((f) => f.t === 'prompt')).toHaveLength(2)
  expectSilent(w)
  sse.stop()
  d.destroy()
})

test('@ 链：第二家是不能用的机器 → 链停住并报错，那台机器一个帧都没收到；一上来就点名不能用的 → 403', async () => {
  const w = await world(['sowner', 'mowner', 'granted', 'plain'])
  const second = await insertUser('mowner2')
  await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [w.spaceId, second, 'member'])
  const box2 = await pairMachine(w.spaceId, second, 'box2')
  const claude2 = `c:${box2.id}:claude`
  const sse = new SSECollector()
  await sse.start(w.pageId, w.cookie.granted)
  const d = await connectDoc(w.pageId, w.cookie.granted)

  // granted 只被授权用 box；先点 box 的 claude 再点 box2 的 claude
  mentionMessage(d.document, ['先 ', { agent: w.claude, label: 'Claude' }, ' 再 ', { agent: claude2, label: 'Claude' }])
  await serverHasMessages(w.pageId, w.cookie.granted, 1)
  expect(await continuePage(w.pageId, w.cookie.granted, {})).toBe(202)
  await settled(sse, 1) // 第一家（被授权的）跑完
  const stopped = await sse.wait((e) => e.type === 'error')
  if (stopped.type !== 'error') throw new Error('不是错误事件')
  expect(stopped.message).toContain('mowner2') // 告诉他找谁要授权
  expect(box2.driven()).toEqual([]) // 第二台机器一个驱动帧都没有
  expect(w.m.by(w.id.granted).filter((f) => f.t === 'prompt')).toHaveLength(1)
  await waitFor(() => replyBlocks(d).length === 1)
  await new Promise((r) => setTimeout(r, 300)) // 链若（错误地）接着往下走，这点时间足够起跑
  expect(replyBlocks(d)).toHaveLength(1)
  expect(box2.driven()).toEqual([])

  // 一上来第一个就是不能用的：continue 当场 403，什么都不发
  mentionMessage(d.document, ['直接找 ', { agent: claude2, label: 'Claude' }])
  await serverHasMessages(w.pageId, w.cookie.granted, 2)
  expect(await continuePage(w.pageId, w.cookie.granted, {})).toBe(403)
  expect(box2.driven()).toEqual([])
  sse.stop()
  d.destroy()
})

const perm = (requestId: string, sessionId: string): PermissionEvent => ({
  type: 'permission',
  requestId,
  title: '写文件',
  options: [{ optionId: 'allow', name: '允许' }],
  sessionId,
})

test('回答审批：选「允许」就是让那台机器去做那件事 —— 没授权的人答不了（403 / 404），审批留着，机器一侧没有 permission 帧', async () => {
  const w = await world()
  const sse = new SSECollector()
  await sse.start(w.pageId, w.cookie.mowner)
  expect((await postJson(`/api/pages/${w.pageId}/agent-prepare`, w.cookie.mowner, { agent: w.claude })).status).toBe(202)
  await sse.wait((e) => e.type === 'config' && e.agentId === w.claude && e.options.length > 0)
  const sessionId = w.m.sessions[0]!
  w.m.send({ t: 'session', agent: 'claude', sessionId, ev: perm('perm-0', sessionId) })
  const pending = await sse.wait((e) => e.type === 'permission' && e.requestId === 'perm-0')
  if (pending.type !== 'permission') throw new Error('不是审批事件')

  await sweep(w, 'permission', 200, (cookie) => answerPermission(w.pageId, cookie, pending, 'allow'), DENIED)
  expect(w.m.driven().filter((f) => f.t === 'permission')).toEqual([])
  expectSilent(w)
  // 审批还在：晚到的订阅者仍能回放到它
  const late = new SSECollector()
  await late.start(w.pageId, w.cookie.mowner)
  await late.wait((e) => e.type === 'permission' && e.requestId === 'perm-0')

  // 被授权的人答：帧带着他的 actor
  expect((await answerPermission(w.pageId, w.cookie.granted, pending, 'allow')).status).toBe(200)
  await waitFor(() => w.m.by(w.id.granted).some((f) => f.t === 'permission'))
  const frame = w.m.by(w.id.granted).find((f) => f.t === 'permission')
  expect(frame).toMatchObject({ t: 'permission', actor: w.id.granted, agent: 'claude', requestId: 'perm-0', optionId: 'allow' })
  expectSilent(w)
  sse.stop()
  late.stop()
})

test('run_agent（AI 经 ramet 工具叫别的 agent）：以发起人为主体 —— 他不能用的机器不在可叫清单里、叫不动；能用的人叫得动且帧带他的 actor', async () => {
  const w = await world()
  const bearer = (role: Role): Record<string, string> => ({
    authorization: `Bearer ${mintPageToken(w.id[role], w.claude, { pageId: w.pageId, agentId: w.claude, canDispatch: true })}`,
    'content-type': 'application/json',
  })
  const tools = async (role: Role): Promise<{ tools: string[]; agents: Array<{ id: string }> }> =>
    (await (await fetch(`${base}/api/ramet/tools`, { headers: bearer(role) })).json()) as { tools: string[]; agents: Array<{ id: string }> }
  const run = (role: Role): Promise<Response> =>
    fetch(`${base}/api/ramet/run-agent`, { method: 'POST', headers: bearer(role), body: JSON.stringify({ agent: w.fake, task: '做点事' }) })

  for (const role of DENIED) {
    const listed = await tools(role)
    // 清单里没有这台机器的 agent。（全局 admin 另有中心本机 agent 可叫，那是 admin 自己的权利，不在本用例范围）
    expect(listed.agents.filter((a) => a.id.startsWith('c:')), `清单 / ${role}`).toEqual([])
    if (role !== 'gadmin' && role !== 'outadmin') expect(listed.tools, `工具 / ${role}`).not.toContain('run_agent')
    const res = await run(role)
    expect(res.status, `run-agent / ${role}`).toBe(400)
    expect(await res.json(), `run-agent / ${role}`).toMatchObject({ error: expect.stringContaining('不能用') })
  }
  expectSilent(w)
  expect(w.m.driven()).toEqual([])

  for (const role of ALLOWED) {
    expect((await tools(role)).agents.map((a) => a.id), `清单 / ${role}`).toEqual([w.fake])
    const res = await run(role)
    expect(res.status, `run-agent / ${role}`).toBe(200)
    expect(JSON.parse((await res.text()).trim()), `run-agent / ${role}`).toMatchObject({ outcome: 'end', output: '好的' })
    expect(types(w.m.by(w.id[role])), `帧 / ${role}`).toEqual(expect.arrayContaining(['new', 'prompt']))
  }
  expectSilent(w)
})

test('停止只让机器停下来、不让它动起来：由页面写权限决定，协作者（没授权的）能停；cancel 帧不带 actor；viewer / 非成员 404', async () => {
  const w = await world()
  w.m.hold = true // prompt 挂住：这一轮一直在跑
  const sse = new SSECollector()
  await sse.start(w.pageId, w.cookie.mowner)
  const d = await connectDoc(w.pageId, w.cookie.mowner)
  userMessage(d.document, '慢慢来', { agent: w.claude })
  await serverHasMessages(w.pageId, w.cookie.mowner, 1)
  expect(await continuePage(w.pageId, w.cookie.mowner, { agent: w.claude })).toBe(202)
  await waitFor(() => w.m.held.length === 1)

  const stop = (role: Role): Promise<Response> => postJson(`/api/pages/${w.pageId}/stop`, w.cookie[role])
  expect((await stop('viewer')).status).toBe(404)
  expect((await stop('outsider')).status).toBe(404)
  expect(w.m.frames.some((f) => f.t === 'cancel')).toBe(false)

  expect((await stop('plain')).status).toBe(200) // 没有任何授权的协作者
  await waitFor(() => w.m.frames.some((f) => f.t === 'cancel'))
  const cancel = w.m.frames.find((f) => f.t === 'cancel')
  expect(cancel).toMatchObject({ t: 'cancel', agent: 'claude', sessionId: w.m.sessions[0] })
  expect(cancel).not.toHaveProperty('actor')
  expect(isDrivenMsg(cancel!)).toBe(false)
  await settled(sse, 1)
  expectSilent(w) // 停止没有让 plain 变成"驱动过机器的人"
  sse.stop()
  d.destroy()
})

test('授权即时生效：每次都现判 —— 收回 / 过期 / 未确认 / 机器没主人都立刻 403，目录里立刻消失；恢复后立刻可用', async () => {
  const w = await world(['sowner', 'mowner', 'granted'], { grants: false })
  const prepare = (role: Role): Promise<Response> => postJson(`/api/pages/${w.pageId}/agent-prepare`, w.cookie[role], { agent: w.claude })
  const visible = async (role: Role): Promise<boolean> => (await agentsList(w.cookie[role])).some((a) => a.id === w.claude)

  // 还没授权
  expect((await prepare('granted')).status).toBe(403)
  expect(await visible('granted')).toBe(false)

  // 授权但未在机器上确认仍然不行，确认后生效
  const grantId = await grantMachine(w.m.id, w.id.granted, { confirmed: false })
  expect((await prepare('granted')).status).toBe(403)
  await pool.query('UPDATE machine_grants SET confirmed_at = now() WHERE id = $1', [grantId])
  expect((await prepare('granted')).status).toBe(202)
  expect(await visible('granted')).toBe(true)

  // 收回：立即不能用
  await pool.query('UPDATE machine_grants SET revoked_at = now() WHERE id = $1', [grantId])
  expect((await prepare('granted')).status).toBe(403)
  expect(await visible('granted')).toBe(false)
  await pool.query('UPDATE machine_grants SET revoked_at = NULL WHERE id = $1', [grantId])
  expect((await prepare('granted')).status).toBe(202)

  // 到期：立即不能用
  await pool.query("UPDATE machine_grants SET expires_at = now() - interval '1 second' WHERE id = $1", [grantId])
  expect((await prepare('granted')).status).toBe(403)
  expect(await visible('granted')).toBe(false)

  // 老 connector 没有主人（owner_id 为空）：谁都不是主人，连配对人自己也不行；文案说清楚是旧配对
  await pool.query('UPDATE connectors SET owner_id = NULL WHERE id = $1', [w.m.id])
  const orphan = await prepare('mowner')
  expect(orphan.status).toBe(403)
  expect(await orphan.json()).toMatchObject({ message: expect.stringContaining('重新配对') })
  expect(await visible('mowner')).toBe(false)
  expect(w.m.by(w.id.sowner)).toEqual([])
})

test('server 重启后认领在飞回合：发起人的授权已收回 / 过期 / 从未确认 → 不接回去（占位块收成出错、drop 让 connector 取消）；授权有效的照常接回', async () => {
  const w = await world(['sowner', 'mowner', 'granted', 'pending', 'expired', 'revoked'])
  // 重启 = 全新的 AgentManager：没有任何内存里的回合，只有库里的 open_runs
  const hub = new ConnectorHub(pool)
  const manager = new AgentManager(pool, {
    agents: [],
    hub,
    getLiveDoc: () => undefined,
    wsPort: () => s.port,
    httpBase: () => base,
    botSecret: 'claim-test',
  })
  const sent: string[] = []
  hub.attach({
    id: w.m.id,
    spaceId: w.spaceId,
    ownerId: w.id.mowner,
    name: 'box',
    defaultCwd: '/tmp',
    agents: AGENTS,
    ws: { readyState: 1, send: (d: string) => sent.push(String(d)), close: () => undefined } as unknown as WebSocket,
  })
  const errors: string[] = []
  manager.subscribe(w.pageId, (ev) => {
    if (ev.type === 'error') errors.push(ev.message)
  })

  // 每个发起人一轮在飞：文档里一块占位回复 + 一条 open_runs
  const casts: Array<{ role: Role; adopt: boolean }> = [
    { role: 'mowner', adopt: true },
    { role: 'granted', adopt: true },
    { role: 'revoked', adopt: false },
    { role: 'expired', adopt: false },
    { role: 'pending', adopt: false },
  ]
  const placeholder = await connectDoc(w.pageId, w.cookie.mowner)
  const runs = casts.map((c, i) => ({
    ...c,
    runId: `run-${c.role}`,
    sessionId: `S-${i}`,
    replyId: new ReplyWriter(placeholder.document, w.claude).id,
  }))
  await waitFor(async () => (await serverReplies(w.pageId, w.cookie.mowner)).length === runs.length)
  for (const r of runs) {
    await insertOpenRun(pool, {
      runId: r.runId, pageId: w.pageId, replyId: r.replyId, sessionId: r.sessionId, agentId: w.claude,
      connectorId: w.m.id, userId: w.id[r.role], cwd: '/tmp', startedAt: Date.now(), msgOpts: {}, msgBefore: {},
    })
  }

  const plan = await manager.resumeRemote(w.m.id, runs.map((r) => ({ runId: r.runId, agent: 'claude', sessionId: r.sessionId })))
  expect(plan.resume.map((r) => r.runId).sort()).toEqual(runs.filter((r) => r.adopt).map((r) => r.runId).sort())
  expect(plan.drop.sort()).toEqual(runs.filter((r) => !r.adopt).map((r) => r.runId).sort())
  expect(errors.filter((m) => m.includes('授权已失效'))).toHaveLength(3)
  // 认领期间没有向 connector 发过任何驱动帧
  expect(sent).toEqual([])

  const outcomes = async (): Promise<Record<string, string | undefined>> =>
    Object.fromEntries((await serverReplies(w.pageId, w.cookie.mowner)).map((b) => [b.id, b.outcome]))
  // 没授权的：占位块收成出错，open_runs 行删掉
  await waitFor(async () => {
    const now = await outcomes()
    return runs.filter((r) => !r.adopt).every((r) => now[r.replyId] === 'error')
  })
  const left = await pool.query<{ run_id: string }>('SELECT run_id FROM open_runs WHERE page_id = $1 ORDER BY run_id', [w.pageId])
  expect(left.rows.map((r) => r.run_id)).toEqual(runs.filter((r) => r.adopt).map((r) => r.runId).sort())
  // 授权有效的：占位块还开着（o:run），connector 报 end 后正常收尾
  const open = await outcomes()
  for (const r of runs.filter((x) => x.adopt)) {
    expect(open[r.replyId], `${r.role} 的回复`).toBe('run')
    hub.handle(w.m.id, { t: 'end', rid: 'r0', runId: r.runId, stopReason: 'end_turn' })
  }
  await waitFor(async () => {
    const now = await outcomes()
    return runs.filter((r) => r.adopt).every((r) => now[r.replyId] === 'end')
  })
  await waitFor(async () => (await pool.query('SELECT 1 FROM open_runs WHERE page_id = $1', [w.pageId])).rows.length === 0)
  placeholder.destroy()
})

// ---------- 第二道闸（真 connector）----------

test('第二道闸：中心库里有授权、connector 本机名单里没有 → connector 自己拒绝并回报，agent 没被调用；补进本机名单后放行；只在本机名单里、中心没授权 → 中心先拒', async () => {
  const w = await world(['sowner', 'mowner', 'granted', 'localOnly'], { grants: false })
  // 这个用例用真 connector（有本地名单），不用脚本化的那台
  const real = await startConnector({ spaceId: w.spaceId, ownerId: w.id.mowner, name: 'realbox', cookie: w.cookie.mowner })
  const claude = `c:${real}:claude`
  const logs = (): string[] => connectorLogs(real)
  const accepted = (prefix: string): number => logs().filter((l) => l.startsWith(prefix)).length
  const sse = new SSECollector()
  await sse.start(w.pageId, w.cookie.mowner)

  // 主人（本机钉住的 ownerId）：两道闸都过
  expect((await postJson(`/api/pages/${w.pageId}/agent-prepare`, w.cookie.mowner, { agent: claude })).status).toBe(202)
  await sse.wait((e) => e.type === 'config' && e.agentId === claude && e.options.length > 0)
  const newsByOwner = accepted('指令 new')
  expect(newsByOwner).toBeGreaterThan(0)

  // 中心给了授权（local:false = 本机名单里没有）：中心放行，connector 拒绝
  await grantMachine(real, w.id.granted, { local: false })
  const grantedSse = new SSECollector()
  await grantedSse.start(w.pageId, w.cookie.granted)
  expect((await agentsList(w.cookie.granted)).some((a) => a.id === claude)).toBe(true) // 中心这一道过了
  expect((await postJson(`/api/pages/${w.pageId}/agent-config`, w.cookie.granted, { agent: claude, configId: 'model', value: 'm1' })).status).toBe(400)
  const dirs = await fetch(`${base}/api/pages/${w.pageId}/agent-dirs?agent=${encodeURIComponent(claude)}&path=%2Ftmp`, { headers: { cookie: w.cookie.granted } })
  expect(dirs.status).toBe(400)
  expect(await dirs.json()).toMatchObject({ error: 'list failed', message: expect.stringContaining('不在本机的授权名单里') })
  const doc = await connectDoc(w.pageId, w.cookie.mowner)
  userMessage(doc.document, '你好', { agent: claude })
  await serverHasMessages(w.pageId, w.cookie.mowner, 1)
  expect(await continuePage(w.pageId, w.cookie.granted, { agent: claude })).toBe(202)
  const refusedRun = await grantedSse.wait((e) => e.type === 'error')
  if (refusedRun.type !== 'error') throw new Error('不是错误事件')
  expect(refusedRun.message).toContain('不在本机的授权名单里')
  // connector 记了拒绝，且 agent 一次都没被调用（没有"指令 new/load/config/prompt"新增）
  const refusedLines = logs().filter((l) => l.includes(`actor=${w.id.granted}`))
  expect(refusedLines.length).toBeGreaterThan(0)
  expect(refusedLines.every((l) => l.startsWith('拒绝 '))).toBe(true)
  expect(accepted('指令 new')).toBe(newsByOwner)
  expect(accepted('指令 prompt')).toBe(0)
  expect(accepted('指令 config')).toBe(0)

  // 机器上本地确认后（名单里有了）：两道闸都过
  await grantMachine(real, w.id.granted)
  expect((await postJson(`/api/pages/${w.pageId}/agent-config`, w.cookie.granted, { agent: claude, configId: 'model', value: 'm1' })).status).toBe(200)
  expect(accepted('指令 config')).toBe(1)

  // 反过来：本机名单里有、中心库里没授权，中心先拒，帧根本没发出去（connector 日志里没有这个人）
  const file = connectorTokenFile(real)
  const config = readConnectorConfig(file)!
  writeConnectorConfig(file, {
    ...config,
    grants: [...(config.grants ?? []), { userId: w.id.localOnly, scopes: ['agent'], expiresAt: new Date(Date.now() + 3_600_000).toISOString() }],
  })
  expect((await postJson(`/api/pages/${w.pageId}/agent-prepare`, w.cookie.localOnly, { agent: claude })).status).toBe(403)
  expect((await agentsList(w.cookie.localOnly)).some((a) => a.id === claude)).toBe(false)
  expect(logs().some((l) => l.includes(`actor=${w.id.localOnly}`))).toBe(false)
  sse.stop()
  grantedSse.stop()
  doc.destroy()
})

test('会话不跨人复用：被授权的人接着别人的会话跑，会新建会话、交付他自己的凭证；原来的人回来也不接着用别人的会话', async () => {
  const w = await world(['sowner', 'mowner', 'granted'])
  const sse = new SSECollector()
  await sse.start(w.pageId, w.cookie.mowner)
  const d = await connectDoc(w.pageId, w.cookie.mowner)
  const news = (role: Role): Extract<DrivenMsg, { t: 'new' }>[] =>
    w.m.by(w.id[role]).filter((f): f is Extract<DrivenMsg, { t: 'new' }> => f.t === 'new')
  const lastPrompt = (role: Role): string | undefined =>
    w.m.by(w.id[role]).filter((f): f is PromptFrame => f.t === 'prompt').at(-1)?.sessionId
  const send = async (role: Role, text: string, n: number): Promise<void> => {
    userMessage(d.document, text, { agent: w.claude })
    await serverHasMessages(w.pageId, w.cookie.mowner, n)
    expect(await continuePage(w.pageId, w.cookie[role], { agent: w.claude }), `${role} 第 ${n} 轮`).toBe(202)
    await settled(sse, n)
  }

  await send('mowner', '第一问', 1)
  await send('mowner', '第二问', 2) // 同一个人：增量续聊，不新建
  expect(news('mowner')).toHaveLength(1)
  const ownerSession = lastPrompt('mowner')

  await send('granted', '第三问', 3)
  expect(news('granted')).toHaveLength(1)
  expect(lastPrompt('granted')).not.toBe(ownerSession)
  const tokenOf = (f: Extract<DrivenMsg, { t: 'new' }> | undefined): string | undefined => f?.tools?.[0]?.mcp?.token
  expect(tokenOf(news('granted')[0])).toBeTruthy()
  expect(tokenOf(news('granted')[0])).not.toBe(tokenOf(news('mowner')[0]))

  await send('mowner', '第四问', 4) // 回来也不接着用被授权人的会话
  expect(news('mowner')).toHaveLength(2)
  expect(lastPrompt('mowner')).not.toBe(lastPrompt('granted'))
  sse.stop()
  d.destroy()
})
