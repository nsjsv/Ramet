/* ---------- 随手 AI 的本地通道：中心侧的授权矩阵 + 全链路 ----------
 * 没有 agent 授权的人，无论怎么调用（含设置里留着旧的 localAgent），都用不了别人的机器，被拒的人机器一侧一个帧都收不到。
 *   1) 响应：机器主人 / 有 agent 授权的人 200 流；看得到机器但没授权的（只授权 machine、空间 owner、全局 admin、成员、
 *      待确认 / 过期 / 收回、viewer）403；不在这台机器所在空间的人 409（机器对他不存在）；
 *   2) 机器一侧：quick 帧只来自放行的人，帧的 actor 就是他自己。
 * 脚本化机器（直接说协议）验证中心，真 connector 验证全链路（含第二道闸）。 */
import { expect, test } from 'vitest'
import { CONNECTOR_TOKEN_HEADER } from './agents/protocol.js'
import { connectMachine, pairMachine, type Machine } from './agents/scripted-machine.js'
import { agentsList, base, connectorLogs, grantMachine, insertUser, login, pool, postJson, startConnector, waitFor } from './agents/test-kit.js'
import { QUICK_SYSTEM_PROMPT } from './quick.js'

process.env.RAMET_PUBLIC_URL = base

type Role =
  | 'mowner' // 机器主人（member，配对人）
  | 'sowner' // 空间 owner，不是机器主人
  | 'gadmin' // 全局 admin，加入了同一个空间
  | 'plain' // 普通 member，没授权
  | 'agentOnly' // 只有 agent 授权
  | 'machineOnly' // 只有 machine 授权（终端 / 文件，不含 agent）
  | 'both' // agent + machine
  | 'pending' // agent 授权还没在机器上确认
  | 'expired' // agent 授权已过期
  | 'revoked' // agent 授权已收回
  | 'viewer' // 空间 viewer，没授权
  | 'outsider' // 不在空间里的普通用户
  | 'outadmin' // 不在空间里的全局 admin

const ROLES: readonly Role[] = [
  'mowner', 'sowner', 'gadmin', 'plain', 'agentOnly', 'machineOnly', 'both', 'pending', 'expired', 'revoked', 'viewer', 'outsider', 'outadmin',
]
const ALLOWED: readonly Role[] = ['mowner', 'agentOnly', 'both']
const DENIED = ROLES.filter((r) => !ALLOWED.includes(r))
/** 机器对他不存在的人：拿到的是选的 agent 现在用不了，而不是 403 */
const INVISIBLE: readonly Role[] = ['outsider', 'outadmin']

type World = { spaceId: string; id: Record<Role, string>; cookie: Record<Role, string>; m: Machine; agent: string }

async function world(caps: string[] = ['project', 'quick']): Promise<World> {
  const id = {} as Record<Role, string>
  const cookie = {} as Record<Role, string>
  for (const role of ROLES) {
    id[role] = await insertUser(role, role === 'gadmin' || role === 'outadmin' ? 'admin' : 'user')
    cookie[role] = await login(role)
  }
  const space = (await (await postJson('/api/spaces', cookie.sowner, { name: 's' })).json()) as { id: string }
  for (const role of ROLES) {
    if (role === 'sowner' || INVISIBLE.includes(role)) continue
    await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [space.id, id[role], role === 'viewer' ? 'viewer' : 'member'])
  }
  const m = await pairMachine(space.id, id.mowner, 'box', caps)
  const w: World = { spaceId: space.id, id, cookie, m, agent: `c:${m.id}:claude` }
  await waitFor(async () => (await agentsList(cookie.mowner)).some((a) => a.id === w.agent))
  await grantMachine(m.id, id.agentOnly, { scopes: ['agent'] })
  await grantMachine(m.id, id.machineOnly, { scopes: ['machine'] })
  await grantMachine(m.id, id.both, { scopes: ['agent', 'machine'] })
  await grantMachine(m.id, id.pending, { scopes: ['agent'], confirmed: false })
  await grantMachine(m.id, id.expired, { scopes: ['agent'], expiresInMs: -60_000 })
  await grantMachine(m.id, id.revoked, { scopes: ['agent'], revoked: true })
  return w
}

type Sse = { event: string; data: any }

function parseSse(text: string): Sse[] {
  const out: Sse[] = []
  for (const block of text.split('\n\n')) {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length) out.push({ event, data: JSON.parse(data.join('\n')) })
  }
  return out
}

type QuickResult = { status: number; json: any; events: Sse[] }

/** 发一次随手 AI 调用并读完整个响应 */
async function quick(cookie: string, body: Record<string, unknown> = { kind: 'rewrite', instruction: '改简洁', text: '一段话' }): Promise<QuickResult> {
  const res = await postJson('/api/quick', cookie, body)
  const sse = res.headers.get('content-type')?.includes('text/event-stream') ?? false
  const text = await res.text()
  return { status: res.status, json: sse ? null : JSON.parse(text || 'null'), events: sse ? parseSse(text) : [] }
}

/** 开着流不读完（测在飞时的收回 / 断开）：返回读取到目前为止的事件与取消函数 */
function openQuick(cookie: string, body: Record<string, unknown> = { kind: 'rewrite', instruction: '改简洁', text: '一段话' }) {
  const ctrl = new AbortController()
  const events: Sse[] = []
  const done = (async () => {
    const res = await fetch(`${base}/api/quick`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const status = res.status
    if (!res.headers.get('content-type')?.includes('text/event-stream')) return { status, json: await res.json() }
    const reader = res.body!.getReader()
    let buf = ''
    for (;;) {
      const { value, done: eof } = await reader.read()
      if (eof) break
      buf += new TextDecoder().decode(value)
      const cut = buf.lastIndexOf('\n\n')
      if (cut >= 0) {
        events.push(...parseSse(buf.slice(0, cut + 2)))
        buf = buf.slice(cut + 2)
      }
    }
    return { status, json: null }
  })().catch((err: unknown) => (ctrl.signal.aborted ? { status: 0, json: null } : Promise.reject(err)))
  return { events, done, abort: () => ctrl.abort() }
}

/** 直接写设置行（模拟设置里留着旧的 localAgent：保存时能用，后来授权没了） */
async function setLocal(userId: string, agent: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO user_ai_settings (user_id, channel, local_agent) VALUES ($1, 'local', $2)
     ON CONFLICT (user_id) DO UPDATE SET channel = 'local', local_agent = $2`,
    [userId, agent],
  )
}

const put = (cookie: string, body: unknown): Promise<Response> =>
  fetch(`${base}/api/me/ai-settings`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** 机器一侧收到的 quick 帧 */
const quickFrames = (m: Machine) => m.of('quick')

test('授权矩阵：每种角色发起一次本地通道调用；放行的拿到流，被拒的 403 / 409，机器一侧一个 quick 帧都没收到', async () => {
  const w = await world()
  for (const role of ROLES) await setLocal(w.id[role], w.agent)
  const results = {} as Record<Role, QuickResult>
  for (const role of ROLES) results[role] = await quick(w.cookie[role])

  for (const role of ALLOWED) {
    expect(results[role].status, role).toBe(200)
    expect(results[role].events.map((e) => e.event), role).toEqual(['delta', 'delta', 'done'])
  }
  for (const role of DENIED.filter((r) => !INVISIBLE.includes(r))) {
    expect(results[role].status, role).toBe(403)
    expect(results[role].json, role).toMatchObject({ error: 'forbidden', message: expect.stringContaining('mowner') }) // 告诉他找谁要授权
  }
  for (const role of INVISIBLE) {
    expect(results[role].status, role).toBe(409)
    expect(results[role].json, role).toMatchObject({ error: 'local agent unavailable' })
  }

  // 机器一侧只有放行的人发来 quick 帧，actor 是他自己，每人恰好一个
  expect(quickFrames(w.m).map((f) => f.actor).sort()).toEqual(ALLOWED.map((r) => w.id[r]).sort())
  for (const role of DENIED) expect(w.m.by(w.id[role]), `${role} 的驱动帧`).toEqual([])
  for (const role of ALLOWED) expect(quickFrames(w.m).filter((f) => f.actor === w.id[role])).toHaveLength(1)
})

test('同一份矩阵在「只授权 machine / 授权没了」之后依旧：授权收回后同一个用户立刻 403，机器不再收到他的帧', async () => {
  const w = await world()
  await setLocal(w.id.agentOnly, w.agent)
  expect((await quick(w.cookie.agentOnly)).status).toBe(200)
  await pool.query(`UPDATE machine_grants SET revoked_at = now() WHERE connector_id = $1 AND user_id = $2`, [w.m.id, w.id.agentOnly])
  expect((await quick(w.cookie.agentOnly)).status).toBe(403)
  expect(quickFrames(w.m).filter((f) => f.actor === w.id.agentOnly)).toHaveLength(1)
})

test('设置 localAgent：只能选你现在能用的 connector 上的 agent；null 清空；别的一律 400', async () => {
  const w = await world()
  for (const role of ALLOWED) {
    const res = await put(w.cookie[role], { channel: 'local', localAgent: w.agent })
    expect(res.status, role).toBe(200)
    expect(await res.json(), role).toMatchObject({ channel: 'local', localAgent: w.agent })
    const view = await (await fetch(`${base}/api/me/ai-settings`, { headers: { cookie: w.cookie[role] } })).json()
    expect(view, role).toMatchObject({ localAgent: w.agent })
  }
  for (const role of DENIED) {
    const res = await put(w.cookie[role], { localAgent: w.agent })
    expect(res.status, role).toBe(400)
    const view = await (await fetch(`${base}/api/me/ai-settings`, { headers: { cookie: w.cookie[role] } })).json()
    expect(view, role).toMatchObject({ localAgent: null }) // 没有保存进去
  }
  // 不是 connector 上的 agent、乱写、非字符串
  for (const bad of ['claude', 'fake', 'c:nope:claude', `c:${w.m.id}:ghost`, '', 5, { id: 'x' }]) {
    expect((await put(w.cookie.mowner, { localAgent: bad })).status, JSON.stringify(bad)).toBe(400)
  }
  expect(await (await put(w.cookie.mowner, { localAgent: null })).json()).toMatchObject({ localAgent: null })
})

test('没选 agent：409 no local agent，机器上没有任何帧；channel 回到 site 不影响 localAgent 的记录', async () => {
  const w = await world()
  await setLocal(w.id.mowner, null)
  const res = await quick(w.cookie.mowner)
  expect(res.status).toBe(409)
  expect(res.json).toMatchObject({ error: 'no local agent' })
  expect(w.m.driven()).toEqual([])
})

// ---------- 流的形状 / 提示词 ----------

test('SSE 与「本站」通道同形（delta {text} … done {stopReason}）；发给机器的 prompt = 固定 system + 只输出正文的说明 + 任务消息', async () => {
  const w = await world()
  await setLocal(w.id.mowner, w.agent)
  const res = await quick(w.cookie.mowner, { kind: 'rewrite', instruction: '改简洁', text: '一段话' })
  expect(res.events).toEqual([
    { event: 'delta', data: { text: '改' } },
    { event: 'delta', data: { text: '好了' } },
    { event: 'done', data: { stopReason: 'end_turn' } },
  ])
  const frame = quickFrames(w.m)[0]!
  expect(frame).toMatchObject({ t: 'quick', actor: w.id.mowner, agent: 'claude' }) // 帧里是 connector 上的原生 agent id
  expect(frame.prompt.startsWith(QUICK_SYSTEM_PROMPT)).toBe(true)
  expect(frame.prompt).toContain('不要调用任何工具')
  expect(frame.prompt).toContain('<task>rewrite</task>')
  expect(frame.prompt).toContain('<selection>\n一段话\n</selection>')
  expect(frame.prompt).toContain('<instruction>\n改简洁\n</instruction>')

  // code / command 走同一条通道
  await quick(w.cookie.mowner, { kind: 'code', instruction: '加类型', text: 'const a = 1', file: { path: 'a.ts', language: 'typescript' } })
  await quick(w.cookie.mowner, { kind: 'command', instruction: '看磁盘', shell: 'zsh', cwd: '/x', output: 'ok' })
  expect(quickFrames(w.m)[1]!.prompt).toContain('<file>\npath: a.ts\nlanguage: typescript\n</file>')
  expect(quickFrames(w.m)[2]!.prompt).toContain('<shell>zsh</shell>')
})

test('机器那边报错：流里给 error 事件（HTTP 仍 200），带人话；不是机器主人的 forbidden 码单独给', async () => {
  const w = await world()
  await setLocal(w.id.mowner, w.agent)
  w.m.quickDeltas = []
  // 脚本化机器回一个 err，模拟 connector 的受限会话拒绝运行
  const original = w.m.send
  w.m.send = (msg) => {
    if (msg.t === 'res' && msg.quick) original({ t: 'err', rid: msg.rid, message: '这个 agent 当前处于「跳过全部确认」，没能切到安全模式，随手 AI 拒绝运行' })
    else original(msg)
  }
  const res = await quick(w.cookie.mowner)
  expect(res.status).toBe(200)
  expect(res.events).toEqual([{ event: 'error', data: { code: 'agent', message: expect.stringContaining('拒绝运行') } }])
})

for (const caps of [[], ['project'], ['project', 'preview']]) {
  test(`connector 太旧（hello 的 caps = ${JSON.stringify(caps)}，没有 quick 能力）：409 connector outdated，一个帧都没发`, async () => {
    const w = await world(caps)
    await setLocal(w.id.mowner, w.agent)
    const res = await quick(w.cookie.mowner)
    expect(res.status).toBe(409)
    expect(res.json).toMatchObject({ error: 'connector outdated' })
    expect(w.m.driven()).toEqual([])
  })
}

test('机器离线：主人 409 local agent unavailable；授权判定仍在「是否在线」之前（没授权的人离线时也是 403）', async () => {
  const w = await world()
  await setLocal(w.id.mowner, w.agent)
  await setLocal(w.id.plain, w.agent)
  w.m.ws.terminate()
  await waitFor(async () => !(await agentsList(w.cookie.mowner)).some((a) => a.id === w.agent))
  const owner = await quick(w.cookie.mowner)
  expect(owner.status).toBe(409)
  expect(owner.json).toMatchObject({ error: 'local agent unavailable' })
  expect((await quick(w.cookie.plain)).status).toBe(403)
})

test('使用记录：非主人用别人的机器留痕（action=quick，不记正文，写在动作之前）；主人自己用不记', async () => {
  const w = await world()
  await setLocal(w.id.mowner, w.agent)
  await setLocal(w.id.agentOnly, w.agent)
  expect((await quick(w.cookie.mowner)).status).toBe(200)
  expect((await quick(w.cookie.agentOnly, { kind: 'rewrite', instruction: '改简洁', text: 'SECRET-BODY' })).status).toBe(200)
  const { rows } = await pool.query<{ user_id: string; action: string; detail: Record<string, unknown>; page_id: string | null }>(
    `SELECT user_id, action, detail, page_id FROM machine_usage_log WHERE connector_id = $1 ORDER BY id`,
    [w.m.id],
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ user_id: w.id.agentOnly, action: 'quick', page_id: null, detail: { agent: w.agent, kind: 'rewrite' } })
  expect(JSON.stringify(rows)).not.toContain('SECRET-BODY')
  // 被拒的人没有留下使用记录
  await setLocal(w.id.plain, w.agent)
  expect((await quick(w.cookie.plain)).status).toBe(403)
  expect((await pool.query(`SELECT 1 FROM machine_usage_log WHERE user_id = $1`, [w.id.plain])).rowCount).toBe(0)
})

// ---------- 在飞：每人一个 / 断开 / 收回 ----------

test('每人同时一个：上一次没结束再发 409 quick busy；客户端断开 → 机器收到 quick-cancel；之后可以再来', async () => {
  const w = await world()
  await setLocal(w.id.mowner, w.agent)
  w.m.quickHold = true
  const first = openQuick(w.cookie.mowner)
  await waitFor(() => w.m.heldQuick.length === 1)
  const second = await quick(w.cookie.mowner)
  expect(second.status).toBe(409)
  expect(second.json).toMatchObject({ error: 'quick busy' })
  expect(quickFrames(w.m)).toHaveLength(1) // 第二次没发出帧

  first.abort()
  await waitFor(() => w.m.of('quick-cancel').length === 1)
  expect(w.m.of('quick-cancel')[0]).toEqual({ t: 'quick-cancel', rid: w.m.heldQuick[0]!.rid })
  await first.done
  w.m.quickHold = false
  await waitFor(async () => (await quick(w.cookie.mowner)).status === 200)
})

test('收回即断：授权收回的当场，他在飞的本地随手 AI 被取消（机器收到 quick-cancel，流里给 revoked），之后 403', async () => {
  const w = await world()
  // 主人在网页发起，再在机器上用确认码确认
  const res = await fetch(`${base}/api/machines/${w.m.id}/grants`, {
    method: 'POST',
    headers: { cookie: w.cookie.mowner, 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pw-123456', userId: w.id.plain, username: 'plain', machineName: 'box', scopes: ['agent'], days: 7, acknowledged: true }),
  })
  expect(res.status).toBe(201)
  const { grantId, code } = (await res.json()) as { grantId: string; code: string }
  expect((await fetch(`${base}/api/connector/grants/${code}/confirm`, { method: 'POST', headers: { [CONNECTOR_TOKEN_HEADER]: w.m.token } })).status).toBe(200)
  await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [w.spaceId, w.id.plain, 'member'])
  await setLocal(w.id.plain, w.agent)

  w.m.quickHold = true
  const running = openQuick(w.cookie.plain)
  await waitFor(() => w.m.heldQuick.length === 1)
  expect((await fetch(`${base}/api/machines/${w.m.id}/grants/${grantId}`, { method: 'DELETE', headers: { cookie: w.cookie.mowner } })).status).toBe(200)

  await running.done
  expect(running.events.at(-1)).toMatchObject({ event: 'error', data: { code: 'revoked', message: expect.stringContaining('授权已收回') } })
  await waitFor(() => w.m.of('quick-cancel').length >= 1)
  expect(w.m.of('grant-revoked')).toEqual([{ t: 'grant-revoked', userId: w.id.plain }])
  expect((await quick(w.cookie.plain)).status).toBe(403)
  expect(quickFrames(w.m)).toHaveLength(1)
})

test('重连后能力仍在（hello 每次都带 caps）：同一台机器断线重连，本地通道照常', async () => {
  const w = await world()
  await setLocal(w.id.mowner, w.agent)
  w.m.ws.terminate()
  await waitFor(async () => !(await agentsList(w.cookie.mowner)).some((a) => a.id === w.agent))
  const again = await connectMachine({ id: w.m.id, name: 'box', token: w.m.token, caps: ['project', 'preview', 'quick'] })
  await waitFor(async () => (await agentsList(w.cookie.mowner)).some((a) => a.id === w.agent))
  expect((await quick(w.cookie.mowner)).status).toBe(200)
  expect(quickFrames(again)).toHaveLength(1)
})

// ---------- 真 connector：全链路（含第二道闸） ----------

test('真 connector 全链路：主人与 agent 授权的人在受限会话里跑通；只授权 machine 的 403；中心有授权但本机名单没有的人被 connector 拒绝', async () => {
  const mowner = await insertUser('mowner')
  await insertUser('sowner')
  const alice = await insertUser('alice') // 中心有 agent 授权，本机名单里没有
  const bob = await insertUser('bob') // 中心与本机都有 agent 授权
  const carol = await insertUser('carol') // 只有 machine 授权
  const cookie = { mowner: await login('mowner'), sowner: await login('sowner'), alice: await login('alice'), bob: await login('bob'), carol: await login('carol') }
  const space = (await (await postJson('/api/spaces', cookie.sowner, { name: 's' })).json()) as { id: string }
  for (const id of [mowner, alice, bob, carol]) {
    await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [space.id, id, 'member'])
  }
  const real = await startConnector({ spaceId: space.id, ownerId: mowner, name: 'realbox', cookie: cookie.mowner })
  const agent = `c:${real}:claude`
  await grantMachine(real, alice, { scopes: ['agent'], local: false })
  await grantMachine(real, bob, { scopes: ['agent'] })
  await grantMachine(real, carol, { scopes: ['machine'] })
  for (const id of [mowner, alice, bob, carol]) await setLocal(id, agent)

  for (const who of ['mowner', 'bob'] as const) {
    const res = await quick(cookie[who])
    expect(res.status, who).toBe(200)
    const text = res.events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('')
    expect(text, who).toContain('turn:full') // 假 agent 的默认回复，说明真跑了一遍
    expect(text, who).toContain('mode=default')
    expect(res.events.at(-1), who).toMatchObject({ event: 'done', data: { stopReason: 'end_turn' } })
  }
  // 只授权 machine：中心就拒绝
  expect((await quick(cookie.carol)).status).toBe(403)
  // 中心放过、本机名单没有：connector 的第二道闸拒绝，流里给 forbidden
  const second = await quick(cookie.alice)
  expect(second.status).toBe(200)
  expect(second.events).toEqual([{ event: 'error', data: { code: 'forbidden', message: expect.stringContaining('不允许你使用') } }])
  expect(connectorLogs(real).some((l) => l.startsWith('拒绝 quick'))).toBe(true)
  // 随手 AI 的会话不出现在中心看得到的地方，用后不留痕
  expect(connectorLogs(real).filter((l) => l.startsWith('quick agent=')).length).toBe(2)
})
