// ---------- 项目面板的终端：REST（列表 / 打开 / 关闭）+ WebSocket /term（订阅 / 输入 / 改尺寸 / 测往返） ----------
// 终端等于把这台电脑的 shell 交给对方：machine 范围，和文件 / git 同一个守卫。本文件覆盖三件事：
//   1) 授权矩阵：3 个 REST 端点 + WebSocket 订阅 × 13 种角色。机器主人和有 machine 授权的人成功；页面可读但没有 machine 授权的
//      （只授权了 agent、空间 owner、全局 admin、普通成员、待确认 / 过期 / 收回的授权、viewer）403；不在空间里 404 / 400；
//      并且机器一侧没收到该操作人的任何帧；
//   2) 订阅：快照（新 connector）/ 回放（老 connector、短暂断线）+ 实时、seq 去重、按 after 续传、多订阅扇出、最后一个走了
//      通知 connector detach、机器掉线 / 终端退出收尾；来源校验；鉴权完成前的输入保序；收回 / 到期 / 授权收窄时订阅当场结束；
//   3) 真 connector + 真 pty 全链路：别人（含有 machine 授权的第二个人、机器主人）对我的终端订阅 / 改尺寸 403、输入一个字节也写不进去，
//      主人能列出并关闭别人的终端；收回即断；node-pty 没装上时 409。
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { CONNECTOR_TOKEN_HEADER } from './agents/protocol.js'
import { pairMachine, type Machine } from './agents/scripted-machine.js'
import {
  agentsList,
  base,
  connectorLogs,
  grantMachine,
  insertUser,
  login,
  pool,
  postJson,
  s,
  startConnector,
  waitFor,
} from './agents/test-kit.js'
import { loadNodePty } from './connector/pty.js'

process.env.RAMET_PUBLIC_URL = base
const realPty = Boolean(await loadNodePty()) && process.platform !== 'win32'

type Role =
  | 'mowner' | 'sowner' | 'gadmin' | 'plain' | 'agentOnly' | 'machineOnly' | 'both' | 'pending' | 'expired' | 'revoked' | 'viewer' | 'outsider' | 'outadmin'
const ROLES: readonly Role[] = [
  'mowner', 'sowner', 'gadmin', 'plain', 'agentOnly', 'machineOnly', 'both', 'pending', 'expired', 'revoked', 'viewer', 'outsider', 'outadmin',
]
const ALLOWED: readonly Role[] = ['mowner', 'machineOnly', 'both']
const DENIED = ROLES.filter((r) => !ALLOWED.includes(r))
const CAPS = ['project', 'terminal']

/** 被拒的人拿到的状态码：页面都读不了的（不在空间里的人，含全局 admin）404，其余 403 */
const refusedStatus = (role: Role): number => (role === 'outsider' || role === 'outadmin' ? 404 : 403)

type World = { spaceId: string; pageId: string; id: Record<Role, string>; cookie: Record<Role, string>; agent: string; m: Machine }

async function world(caps: string[] = CAPS): Promise<World> {
  const id = {} as Record<Role, string>
  const cookie = {} as Record<Role, string>
  for (const role of ROLES) {
    id[role] = await insertUser(role, role === 'gadmin' || role === 'outadmin' ? 'admin' : 'user')
    cookie[role] = await login(role)
  }
  const space = (await (await postJson('/api/spaces', cookie.sowner, { name: 's' })).json()) as { id: string }
  for (const role of ROLES) {
    if (role === 'sowner' || role === 'outsider' || role === 'outadmin') continue
    await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [space.id, id[role], role === 'viewer' ? 'viewer' : 'member'])
  }
  const page = (await (await postJson('/api/pages', cookie.sowner, { space_id: space.id })).json()) as { id: string }
  const m = await pairMachine(space.id, id.mowner, 'box', caps)
  const w: World = { spaceId: space.id, pageId: page.id, id, cookie, agent: `c:${m.id}:claude`, m }
  await waitFor(async () => (await agentsList(cookie.mowner)).some((a) => a.id === w.agent))
  await grantMachine(m.id, id.agentOnly, { scopes: ['agent'] })
  await grantMachine(m.id, id.machineOnly, { scopes: ['machine'] })
  await grantMachine(m.id, id.both, { scopes: ['agent', 'machine'] })
  await grantMachine(m.id, id.pending, { scopes: ['machine'], confirmed: false })
  await grantMachine(m.id, id.expired, { scopes: ['machine'], expiresInMs: -60_000 })
  await grantMachine(m.id, id.revoked, { scopes: ['machine'], revoked: true })
  return w
}

const ptyUrl = (w: Pick<World, 'pageId' | 'agent'>, suffix = '', query = ''): string =>
  `${base}/api/pages/${w.pageId}/project/pty${suffix}?agent=${encodeURIComponent(w.agent)}${query}`

function call(w: Pick<World, 'pageId' | 'agent'>, cookie: string, method: string, suffix = '', body?: unknown, query = ''): Promise<Response> {
  return fetch(ptyUrl(w, suffix, query), {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

type Wire = Record<string, any>

/** 一条终端 WebSocket（/term）：收集服务端消息（t 改名 type，其余字段原样）。
 *  ready 到了 status = 200；被拒（鉴权 / 订阅失败）时 status = 关闭码 - 4000；连握手都没成（来源不对）status = 关闭码。
 *  服务端关闭时 closed 兑现，code 是关闭码 */
class PtyWs {
  events: Wire[] = []
  status = 0
  code = 0
  closed: Promise<void> = Promise.resolve()
  private ws: WebSocket | null = null
  static async open(
    w: Pick<World, 'pageId' | 'agent'>,
    cookie: string,
    ptyId: string,
    opts: { after?: number; origin?: string; beforeReady?: (ws: WebSocket) => void } = {},
  ): Promise<PtyWs> {
    const t = new PtyWs()
    const q = new URLSearchParams({ page: w.pageId, agent: w.agent, pty: ptyId, after: String(opts.after ?? -1) })
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/term?${q}`, {
      headers: { ...(cookie ? { cookie } : {}), ...(opts.origin ? { origin: opts.origin } : {}) },
    })
    t.ws = ws
    const settled = Promise.withResolvers<void>()
    t.closed = new Promise((resolve) => {
      ws.on('close', (code) => {
        t.code = code
        if (!t.status) t.status = code >= 4000 && code < 5000 ? code - 4000 : code
        settled.resolve()
        resolve()
      })
    })
    ws.on('open', () => opts.beforeReady?.(ws))
    ws.on('message', (raw) => {
      const { t: type, ...rest } = JSON.parse(String(raw)) as Wire
      t.events.push({ type, ...rest })
      if (type === 'ready') {
        t.status = 200
        settled.resolve()
      }
    })
    ws.on('error', () => undefined) // 握手被拒时先 error 再 close，状态以 close 为准
    await settled.promise
    return t
  }
  async wait(pred: (e: Wire) => boolean, ms = 8000): Promise<Wire> {
    const deadline = Date.now() + ms
    for (;;) {
      const hit = this.events.find(pred)
      if (hit) return hit
      if (Date.now() > deadline) throw new Error(`等待终端事件超时，已收：${JSON.stringify(this.events.slice(-5))}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  data(): string {
    return this.events.filter((e) => e.type === 'data').map((e) => e.data).join('')
  }
  private send(msg: Wire): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }
  input(data: string): void {
    this.send({ t: 'in', data })
  }
  resize(cols: number, rows: number): void {
    this.send({ t: 'size', cols, rows })
  }
  ping(id: number): void {
    this.send({ t: 'ping', id })
  }
  close(): void {
    this.ws?.close()
  }
}

/** 机器一侧收到的终端帧 */
const ptyFrames = (m: Machine, actor?: string) =>
  m.driven().filter((f) => f.t.startsWith('pty-') && (actor === undefined || f.actor === actor))

// ---------- 授权矩阵 ----------

test('授权矩阵：REST（列表 / 打开 / 关闭）与 WebSocket 订阅（含输入、改尺寸）× 13 种角色；没有 machine 授权的人机器一侧一个帧都没收到', async () => {
  const w = await world()
  const calls: Array<[string, (role: Role) => Promise<number>, number]> = [
    ['列表', async (r) => (await call(w, w.cookie[r], 'GET')).status, 200],
    ['打开', async (r) => (await call(w, w.cookie[r], 'POST', '', { cols: 100, rows: 30 })).status, 201],
    ['订阅 + 输入 + 改尺寸', async (r) => {
      const t = await PtyWs.open(w, w.cookie[r], 'PTY-1')
      if (t.status === 200) {
        t.input('ls\n')
        t.resize(90, 20)
        await waitFor(() => ptyFrames(w.m, w.id[r]).some((f) => f.t === 'pty-resize'))
        t.close()
        await t.closed
      }
      return t.status
    }, 200],
    ['关闭', async (r) => (await call(w, w.cookie[r], 'DELETE', '/PTY-1')).status, 200],
  ]
  for (const [name, run, ok] of calls) {
    for (const role of [...DENIED, ...ALLOWED]) {
      expect(await run(role), `${name} / ${role}`).toBe(ALLOWED.includes(role) ? ok : refusedStatus(role))
    }
  }
  for (const role of DENIED) expect(w.m.by(w.id[role]), `${role} 的驱动帧`).toEqual([])
  for (const role of ALLOWED) {
    await waitFor(() => ptyFrames(w.m, w.id[role]).some((f) => f.t === 'pty-detach'))
    const types = new Set(ptyFrames(w.m, w.id[role]).map((f) => f.t))
    for (const t of ['pty-list', 'pty-open', 'pty-input', 'pty-resize', 'pty-attach', 'pty-detach', 'pty-close']) expect(types.has(t as 'pty-list'), `${role} ${t}`).toBe(true)
  }
  expect(w.m.driven().every((f) => ALLOWED.some((r) => f.actor === w.id[r]))).toBe(true)
  // 403 的文案告诉人找谁要授权；只授权 agent 的人同样 403（scope 互不蕴含）
  const refused = await call(w, w.cookie.agentOnly, 'POST', '', {})
  expect(await refused.json()).toMatchObject({ error: 'forbidden', message: expect.stringContaining('mowner') })
  const refusedWs = await PtyWs.open(w, w.cookie.agentOnly, 'PTY-1')
  expect(refusedWs.events.at(-1)).toMatchObject({ type: 'end', error: 'forbidden', message: expect.stringContaining('mowner') })
})

test('WebSocket 握手的来源必须是 Ramet 自己：别的站点（含预览页）带着登录 cookie 也连不进来，机器一侧没有任何帧', async () => {
  const w = await world()
  const evil = await PtyWs.open(w, w.cookie.mowner, 'PTY-1', { origin: 'https://evil.example' })
  expect(evil.status).not.toBe(200)
  expect(evil.events).toEqual([])
  const same = await PtyWs.open(w, w.cookie.mowner, 'PTY-1', { origin: base })
  expect(same.status).toBe(200)
  same.close()
  expect(ptyFrames(w.m).filter((f) => f.t === 'pty-attach').length).toBe(1)
})

test('参数：缺 agent 400；本机 agent / 乱写的 id 400；没有页面 404；没登录 401（REST 与 WebSocket 一致）', async () => {
  const w = await world()
  const bare = await fetch(`${base}/api/pages/${w.pageId}/project/pty`, { headers: { cookie: w.cookie.mowner } })
  expect(bare.status).toBe(400)
  const local = await fetch(`${base}/api/pages/${w.pageId}/project/pty?agent=fake`, { headers: { cookie: w.cookie.mowner } })
  expect(local.status).toBe(400)
  expect((await fetch(`${base}/api/pages/no-such/project/pty?agent=${encodeURIComponent(w.agent)}`, { headers: { cookie: w.cookie.mowner } })).status).toBe(404)
  expect((await fetch(ptyUrl(w))).status).toBe(401)
  expect((await PtyWs.open(w, '', 'PTY-1')).status).toBe(401)
  expect((await PtyWs.open(w, w.cookie.mowner, '')).status).toBe(400)
  expect((await PtyWs.open({ pageId: 'no-such', agent: w.agent }, w.cookie.mowner, 'PTY-1')).status).toBe(404)
  expect((await PtyWs.open({ pageId: w.pageId, agent: 'fake' }, w.cookie.mowner, 'PTY-1')).status).toBe(400)
  expect(w.m.by(w.id.mowner)).toEqual([]) // 以上都没发到机器
})

// ---------- 版本 / 能力 ----------

test('connector 没有 terminal 能力（node-pty 没装上）：所有终端接口 409 terminal unsupported 且一个帧都没发；老 connector 是 connector outdated；授权判定仍在前', async () => {
  const w = await world(['project'])
  const all = async (cookie: string): Promise<Response[]> => [
    await call(w, cookie, 'GET'),
    await call(w, cookie, 'POST', '', {}),
    await call(w, cookie, 'DELETE', '/PTY-1'),
  ]
  const unsupported = { error: 'terminal unsupported', message: '这台机器上的 connector 不支持终端（node-pty 没装上）' }
  for (const res of await all(w.cookie.mowner)) {
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject(unsupported)
  }
  const sock = await PtyWs.open(w, w.cookie.mowner, 'PTY-1')
  expect(sock.status).toBe(409)
  expect(sock.events.at(-1)).toMatchObject({ type: 'end', ...unsupported })
  expect(ptyFrames(w.m)).toEqual([])
  for (const res of await all(w.cookie.plain)) expect(res.status).toBe(403) // 没授权的人看到的是 403 而不是 409
  expect((await PtyWs.open(w, w.cookie.plain, 'PTY-1')).status).toBe(403)
  // 文件类功能不受影响
  expect((await fetch(`${base}/api/pages/${w.pageId}/project/tree?agent=${encodeURIComponent(w.agent)}&path=`, { headers: { cookie: w.cookie.mowner } })).status).toBe(200)

})

test('老 connector（hello 没有任何能力）：终端接口 409 connector outdated 且一个帧都没发', async () => {
  const w = await world([])
  expect((await call(w, w.cookie.mowner, 'POST', '', {})).status).toBe(409)
  expect(await (await call(w, w.cookie.mowner, 'GET')).json()).toMatchObject({ error: 'connector outdated' })
  const sock = await PtyWs.open(w, w.cookie.mowner, 'PTY-1')
  expect(sock.status).toBe(409)
  expect(sock.events.at(-1)).toMatchObject({ type: 'end', error: 'connector outdated' })
  expect(ptyFrames(w.m)).toEqual([])
})

test('机器离线：409 machine offline；授权判定仍在「是否在线」之前', async () => {
  const w = await world()
  w.m.ws.terminate()
  await waitFor(async () => !(await agentsList(w.cookie.mowner)).some((a) => a.id === w.agent))
  expect((await call(w, w.cookie.mowner, 'POST', '', {})).status).toBe(409)
  const sock = await PtyWs.open(w, w.cookie.mowner, 'PTY-1')
  expect(sock.code).toBe(4409) // 浏览器据此稍后重试
  expect(sock.events.at(-1)).toMatchObject({ type: 'end', error: 'machine offline' })
  expect((await call(w, w.cookie.plain, 'POST', '', {})).status).toBe(403)
})

test('connector 的拒绝原样映射：forbidden → 403，not_found → 404（订阅走关闭码 4403 / 4404，关闭走 REST）', async () => {
  const w = await world()
  for (const [refuse, status] of [['forbidden', 403], ['not_found', 404]] as const) {
    w.m.refusePty = refuse
    expect((await call(w, w.cookie.both, 'DELETE', '/PTY-1')).status, refuse).toBe(status)
    const sock = await PtyWs.open(w, w.cookie.both, 'PTY-1')
    expect(sock.code, refuse).toBe(4000 + status)
  }
})

// ---------- 打开 / 列表 / 使用记录 ----------

test('打开带上页面工作区；列表：机器主人 isOwner，别人的终端 mine=false 并带主人用户名，响应里没有 user id', async () => {
  const w = await world()
  await grantMachine(w.m.id, w.id.plain, { scopes: ['agent'] })
  expect((await postJson(`/api/pages/${w.pageId}/agent-cwd`, w.cookie.mowner, { agent: w.agent, cwd: '/srv/work' })).status).toBe(200)
  const opened = await call(w, w.cookie.both, 'POST', '', { cols: 120, rows: 40 })
  expect(opened.status).toBe(201)
  expect(await opened.json()).toMatchObject({ pty: { ptyId: 'PTY-1', root: '/srv/work', cols: 120, rows: 40, alive: true, mine: true } })
  expect(ptyFrames(w.m, w.id.both).find((f) => f.t === 'pty-open')).toMatchObject({ root: '/srv/work', cols: 120, rows: 40 })
  // 脚本化机器的 list 不做过滤（过滤是 connector 的事，真 connector 用例里测），这里只测中心的整形
  await call(w, w.cookie.mowner, 'POST', '', {})
  const asOwner = (await (await call(w, w.cookie.mowner, 'GET')).json()) as Wire
  expect(asOwner.isOwner).toBe(true)
  expect(asOwner.ptys.map((p: Wire) => [p.ptyId, p.mine, p.owner])).toEqual([['PTY-1', false, 'both'], ['PTY-2', true, 'mowner']])
  const asBoth = (await (await call(w, w.cookie.both, 'GET')).json()) as Wire
  expect(asBoth.isOwner).toBe(false)
  for (const body of [asOwner, asBoth]) {
    expect(JSON.stringify(body)).not.toContain(w.id.both)
    expect(JSON.stringify(body)).not.toContain(w.id.mowner)
  }
})

test('使用记录：非主人打开 / 关闭终端留痕（detail 带 root / ptyId，动作之前写入），主人自己不记，每一行输入不记，被拒的不记', async () => {
  const w = await world()
  await call(w, w.cookie.mowner, 'POST', '', {})
  await call(w, w.cookie.both, 'POST', '', {})
  const typing = await PtyWs.open(w, w.cookie.both, 'PTY-2')
  for (let i = 0; i < 3; i++) typing.input(`echo ${i}\n`)
  await waitFor(() => ptyFrames(w.m, w.id.both).filter((f) => f.t === 'pty-input').length === 3)
  typing.close()
  await call(w, w.cookie.both, 'DELETE', '/PTY-2')
  await call(w, w.cookie.plain, 'POST', '', {})
  await call(w, w.cookie.mowner, 'DELETE', '/PTY-1')
  const { rows } = await pool.query<{ user_id: string; action: string; detail: Wire }>(
    'SELECT user_id, action, detail FROM machine_usage_log WHERE connector_id = $1 ORDER BY id',
    [w.m.id],
  )
  expect(rows.map((r) => [r.user_id, r.action, r.detail.op, r.detail.root ?? r.detail.ptyId ?? null])).toEqual([
    [w.id.both, 'terminal', 'open', '/tmp'],
    [w.id.both, 'terminal', 'close', 'PTY-2'],
  ])
  expect(rows.every((r) => r.detail.agent === undefined || r.detail.agent === w.agent)).toBe(true)
  const grant = await pool.query('SELECT first_used_at FROM machine_grants WHERE connector_id = $1 AND user_id = $2', [w.m.id, w.id.both])
  expect(grant.rows[0]!.first_used_at).not.toBeNull()
})

// ---------- 订阅 ----------

test('订阅（老 connector：回放）：ready → 回放 → 实时；同 seq 去重、别的终端不串、按 after 续传；终端退出后以 1000 关闭', async () => {
  const w = await world()
  w.m.ptyReplay = [{ seq: 0, data: '$ ' }, { seq: 1, data: 'ls\r\n' }]
  const sock = await PtyWs.open(w, w.cookie.both, 'PTY-1')
  expect(sock.status).toBe(200)
  const ready = await sock.wait((e) => e.type === 'ready')
  expect(ready).toMatchObject({ pty: { ptyId: 'PTY-1', mine: true }, lost: false })
  expect(ready.snapshot).toBeUndefined()
  expect(JSON.stringify(ready)).not.toContain(w.id.both)
  await sock.wait((e) => e.type === 'data' && e.seq === 1)
  const push = (msg: Record<string, unknown>): void => w.m.send(msg as never)
  push({ t: 'pty-data', ptyId: 'PTY-1', seq: 2, data: 'live-A' })
  push({ t: 'pty-data', ptyId: 'PTY-1', seq: 2, data: 'dup' })
  push({ t: 'pty-data', ptyId: 'OTHER', seq: 3, data: 'not-mine' })
  push({ t: 'pty-data', ptyId: 'PTY-1', seq: 3, data: 'live-B' })
  await sock.wait((e) => e.type === 'data' && e.seq === 3)
  expect(sock.data()).toBe('$ ls\r\nlive-Alive-B')
  expect(sock.events.filter((e) => e.type === 'data').map((e) => e.seq)).toEqual([0, 1, 2, 3])
  // 另一个订阅按 after 续传，只回放之后的
  const resumed = await PtyWs.open(w, w.cookie.both, 'PTY-1', { after: 0 })
  await resumed.wait((e) => e.type === 'data' && e.seq === 1)
  expect(resumed.events.filter((e) => e.type === 'data').map((e) => e.seq)).toEqual([1])
  // 扇出：两个订阅都收到实时输出
  push({ t: 'pty-data', ptyId: 'PTY-1', seq: 4, data: 'fan' })
  await resumed.wait((e) => e.type === 'data' && e.seq === 4)
  await sock.wait((e) => e.type === 'data' && e.seq === 4)
  // 退出时每个订阅各收一条 exit，服务端以 1000 关闭（浏览器不再重连）
  push({ t: 'pty-exit', ptyId: 'PTY-1', code: 0, reason: 'exited' })
  await Promise.all([sock.closed, resumed.closed])
  expect(sock.events.at(-1)).toEqual({ type: 'exit', code: 0, reason: 'exited' })
  expect(sock.code).toBe(1000)
})

test('订阅（新 connector：快照）：全新打开 ready 里带屏幕快照；之后只交付 seq 更大的输出；续传（after ≥ 0）不给快照', async () => {
  const w = await world()
  const snapshot = { data: '$ \x1b[31mhalf-typed\x1b[0m', seq: 5, cols: 120, rows: 40 }
  w.m.ptySnapshot = snapshot
  const sock = await PtyWs.open(w, w.cookie.both, 'PTY-1')
  expect(await sock.wait((e) => e.type === 'ready')).toMatchObject({ lost: false, snapshot })
  const push = (msg: Record<string, unknown>): void => w.m.send(msg as never)
  push({ t: 'pty-data', ptyId: 'PTY-1', seq: 5, data: 'already-in-snapshot' })
  push({ t: 'pty-data', ptyId: 'PTY-1', seq: 6, data: 'after-snapshot' })
  await sock.wait((e) => e.type === 'data' && e.seq === 6)
  expect(sock.events.filter((e) => e.type === 'data').map((e) => e.seq)).toEqual([6])
  const resumed = await PtyWs.open(w, w.cookie.both, 'PTY-1', { after: 0 })
  expect((await resumed.wait((e) => e.type === 'ready')).snapshot).toBeUndefined()
  sock.close()
  resumed.close()
})

test('鉴权完成之前发出的输入不丢、不乱序：浏览器一连上就发的尺寸和按键，订阅成功后按原顺序转给机器', async () => {
  const w = await world()
  const sock = await PtyWs.open(w, w.cookie.both, 'PTY-1', {
    beforeReady: (ws) => {
      ws.send(JSON.stringify({ t: 'size', cols: 101, rows: 33 }))
      for (const ch of 'abc') ws.send(JSON.stringify({ t: 'in', data: ch }))
    },
  })
  expect(sock.status).toBe(200)
  await waitFor(() => ptyFrames(w.m, w.id.both).filter((f) => f.t === 'pty-input').length === 3)
  const frames = ptyFrames(w.m, w.id.both)
  expect(frames.map((f) => f.t)).toEqual(['pty-attach', 'pty-resize', 'pty-input', 'pty-input', 'pty-input'])
  expect(frames.flatMap((f) => (f.t === 'pty-input' ? [f.data] : [])).join('')).toBe('abc')
  sock.close()
})

test('ping → pong：带回中心 ↔ connector 的心跳往返（还没测到时为 null）', async () => {
  const w = await world()
  const sock = await PtyWs.open(w, w.cookie.both, 'PTY-1')
  sock.ping(7)
  const pong = await sock.wait((e) => e.type === 'pong' && e.id === 7)
  expect(pong.relayMs === null || typeof pong.relayMs === 'number').toBe(true)
  sock.close()
})

test('最后一个订阅走了才通知 connector detach（中间还有人订阅时不发）', async () => {
  const w = await world()
  const a = await PtyWs.open(w, w.cookie.both, 'PTY-1')
  const b = await PtyWs.open(w, w.cookie.both, 'PTY-1')
  await a.wait((e) => e.type === 'ready')
  await b.wait((e) => e.type === 'ready')
  const detaches = (): number => ptyFrames(w.m, w.id.both).filter((f) => f.t === 'pty-detach').length
  a.close()
  await new Promise((r) => setTimeout(r, 300))
  expect(detaches()).toBe(0)
  b.close()
  await waitFor(() => detaches() === 1)
  await new Promise((r) => setTimeout(r, 200))
  expect(detaches()).toBe(1)
})

test('机器掉线：订阅收到 end(offline) 并被关流', async () => {
  const w = await world()
  const sse = await PtyWs.open(w, w.cookie.both, 'PTY-1')
  await sse.wait((e) => e.type === 'ready')
  w.m.ws.terminate()
  await sse.closed
  expect(sse.events.at(-1)).toMatchObject({ type: 'end', error: 'machine offline' })
  expect(sse.code).toBe(4409)
})

// ---------- 收回即断 ----------

const call2 = (method: string, path: string, cookie: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/** 走完整个授权流程：主人网页发起，再在机器上用确认码确认。返回 grantId */
async function grantVia(w: World, who: Role, scopes: Array<'agent' | 'machine'>): Promise<string> {
  const res = await call2('POST', `/api/machines/${w.m.id}/grants`, w.cookie.mowner, {
    password: 'pw-123456', userId: w.id[who], username: who, machineName: 'box', scopes, days: 7, acknowledged: true,
  })
  expect(res.status).toBe(201)
  const { grantId, code } = (await res.json()) as { grantId: string; code: string }
  const done = await fetch(`${base}/api/connector/grants/${code}/confirm`, { method: 'POST', headers: { [CONNECTOR_TOKEN_HEADER]: w.m.token } })
  expect(done.status).toBe(200)
  return grantId
}

describe('授权没了，终端订阅当场结束', () => {
  test('主人收回：订阅收到 end(revoked) 并关流，机器收到 grant-revoked，之后他打不开也订阅不了；别人（bob）的订阅不动', async () => {
    const w = await world()
    const alice = await grantVia(w, 'plain', ['machine'])
    const sseAlice = await PtyWs.open(w, w.cookie.plain, 'PTY-1')
    const sseBob = await PtyWs.open(w, w.cookie.both, 'PTY-1')
    await sseAlice.wait((e) => e.type === 'ready')
    await sseBob.wait((e) => e.type === 'ready')
    expect((await call2('DELETE', `/api/machines/${w.m.id}/grants/${alice}`, w.cookie.mowner)).status).toBe(200)
    await sseAlice.closed
    expect(sseAlice.events.at(-1)).toMatchObject({ type: 'end', error: 'revoked', message: expect.stringContaining('授权已收回') })
    expect(sseAlice.code).toBe(4403)
    await waitFor(() => w.m.of('grant-revoked').length === 1)
    expect(w.m.of('grant-revoked')).toEqual([{ t: 'grant-revoked', userId: w.id.plain }])
    expect((await call(w, w.cookie.plain, 'POST', '', {})).status).toBe(403)
    expect((await PtyWs.open(w, w.cookie.plain, 'PTY-1')).status).toBe(403)
    w.m.send({ t: 'pty-data', ptyId: 'PTY-1', seq: 5, data: 'still-flowing' } as never)
    await sseBob.wait((e) => e.type === 'data' && e.data === 'still-flowing') // bob 不受影响
    sseBob.close()
  })

  test('到期清扫：到期的授权效果同收回（订阅结束 + grant-revoked）', async () => {
    const w = await world()
    const grant = await grantVia(w, 'plain', ['machine'])
    const sse = await PtyWs.open(w, w.cookie.plain, 'PTY-1')
    await sse.wait((e) => e.type === 'ready')
    await pool.query("UPDATE machine_grants SET expires_at = now() - interval '1 second' WHERE id = $1", [grant])
    expect(await s.sweepGrants()).toBeGreaterThanOrEqual(1) // world 里本来就有别的过期 / 收回的授权，一并清扫
    await sse.closed
    expect(sse.events.at(-1)).toMatchObject({ type: 'end', error: 'revoked' })
    expect(w.m.of('grant-revoked').map((f) => f.userId)).toContain(w.id.plain)
  })

  test('授权收窄（machine + agent 换成只有 agent 的新授权）：终端订阅结束、机器收到 access-reduced(machine)，agent 照常能用；不发 grant-revoked（不能删新授权的本机条目）', async () => {
    const w = await world()
    await grantVia(w, 'plain', ['agent', 'machine'])
    const sse = await PtyWs.open(w, w.cookie.plain, 'PTY-1')
    await sse.wait((e) => e.type === 'ready')
    await grantVia(w, 'plain', ['agent'])
    await sse.closed
    expect(sse.events.at(-1)).toMatchObject({ type: 'end', error: 'revoked' })
    await waitFor(() => w.m.of('access-reduced').length === 1)
    expect(w.m.of('access-reduced')).toEqual([{ t: 'access-reduced', userId: w.id.plain, scope: 'machine' }])
    expect(w.m.of('grant-revoked')).toEqual([])
    expect((await call(w, w.cookie.plain, 'POST', '', {})).status).toBe(403) // 终端没了
    expect((await agentsList(w.cookie.plain)).some((a) => a.id === w.agent)).toBe(true) // agent 还在
  })

  test('授权放宽或不变（agent → agent + machine）不会收掉任何东西', async () => {
    const w = await world()
    await grantVia(w, 'plain', ['agent'])
    await grantVia(w, 'plain', ['agent', 'machine'])
    await new Promise((r) => setTimeout(r, 200))
    expect(w.m.of('access-reduced')).toEqual([])
    expect(w.m.of('grant-revoked')).toEqual([])
    expect((await call(w, w.cookie.plain, 'POST', '', {})).status).toBe(201)
  })
})

// ---------- 真 connector + 真 pty ----------

describe.skipIf(!realPty)('真 connector + 真 pty：全链路与归属', () => {
  async function realWorld() {
    const names = ['mowner', 'sowner', 'bob', 'dave', 'carol'] as const
    const id = {} as Record<(typeof names)[number], string>
    const cookie = {} as Record<(typeof names)[number], string>
    for (const n of names) {
      id[n] = await insertUser(n)
      cookie[n] = await login(n)
    }
    const space = (await (await postJson('/api/spaces', cookie.sowner, { name: 's' })).json()) as { id: string }
    for (const n of ['mowner', 'bob', 'dave', 'carol'] as const) {
      await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [space.id, id[n], 'member'])
    }
    const page = (await (await postJson('/api/pages', cookie.sowner, { space_id: space.id })).json()) as { id: string }
    const box = realpathSync(mkdtempSync(join(tmpdir(), 'ramet-pty-e2e-')))
    const connectorId = await startConnector({ spaceId: space.id, ownerId: id.mowner, name: 'realbox', cookie: cookie.mowner })
    const w = { pageId: page.id, agent: `c:${connectorId}:claude` }
    expect((await postJson(`/api/pages/${page.id}/agent-cwd`, cookie.mowner, { agent: w.agent, cwd: box })).status).toBe(200)
    await grantMachine(connectorId, id.bob, { scopes: ['agent', 'machine'] })
    await grantMachine(connectorId, id.dave, { scopes: ['machine'] })
    await grantMachine(connectorId, id.carol, { scopes: ['agent'] })
    return { id, cookie, space, page, box, connectorId, w }
  }

  async function open(w: { pageId: string; agent: string }, cookie: string): Promise<string> {
    const res = await call(w, cookie, 'POST', '', { cols: 80, rows: 24 })
    expect(res.status).toBe(201)
    return ((await res.json()) as { pty: { ptyId: string } }).pty.ptyId
  }

  test('打开 → 订阅 → 输入 → 输出；起始目录是页面的工作区；shell 的环境里没有 RAMET_*', async () => {
    const r = await realWorld()
    const ptyId = await open(r.w, r.cookie.bob)
    const sse = await PtyWs.open(r.w, r.cookie.bob, ptyId)
    await sse.wait((e) => e.type === 'ready')
    sse.input('echo RES-$((6*7)); pwd; env | grep -c RAMET_\n')
    await waitFor(() => sse.data().includes('RES-42') && sse.data().includes(r.box))
    await waitFor(() => /\n0\r?\n/.test(sse.data()), 8000) // grep -c RAMET_ → 0（中心的 RAMET_PUBLIC_URL 在 connector 进程环境里，但进不了 shell）
    sse.close()
  })

  test('别人的终端：有 machine 授权的第二个人、机器主人订阅我的 ptyId 被拒（4403），连不上就发不了输入，一个字节也写不进去；只授权 agent 的人在中心就被拦', async () => {
    const r = await realWorld()
    const ptyId = await open(r.w, r.cookie.bob)
    const mine = await PtyWs.open(r.w, r.cookie.bob, ptyId)
    await mine.wait((e) => e.type === 'ready')
    for (const who of ['dave', 'mowner'] as const) {
      // 订阅由 connector 按 actor 判归属（PtyManager.own），被拒就没有连接，鉴权前攒着的输入也一并丢掉
      const theirs = await PtyWs.open(r.w, r.cookie[who], ptyId, {
        beforeReady: (ws) => ws.send(JSON.stringify({ t: 'in', data: `echo PWNED-BY-${who}\n` })),
      })
      expect(theirs.status, `${who} 订阅`).toBe(403)
    }
    expect((await call(r.w, r.cookie.dave, 'DELETE', `/${ptyId}`)).status).toBe(403)
    expect((await PtyWs.open(r.w, r.cookie.carol, ptyId)).status).toBe(403)
    expect((await call(r.w, r.cookie.carol, 'GET')).status).toBe(403)
    // bob 自己照常
    mine.input('echo BOB-OK\n')
    await mine.wait((e) => e.type === 'data' && String(e.data).includes('BOB-OK'))
    await new Promise((res) => setTimeout(res, 300))
    expect(mine.data()).not.toContain('PWNED')
    expect(connectorLogs(r.connectorId).some((l) => l.includes('PWNED'))).toBe(false)
    mine.close()
  })

  test('列表与关闭：普通人只看到自己的；机器主人看到所有人的、能关别人的（订阅者收到 exit(closed)）但不能往里输入；关了再关 404', async () => {
    const r = await realWorld()
    const bobPty = await open(r.w, r.cookie.bob)
    const davePty = await open(r.w, r.cookie.dave)
    const names = async (who: 'bob' | 'dave' | 'mowner') => {
      const body = (await (await call(r.w, r.cookie[who], 'GET')).json()) as Wire
      return { isOwner: body.isOwner as boolean, ptys: (body.ptys as Wire[]).map((p) => [p.ptyId, p.mine, p.owner]) }
    }
    expect(await names('bob')).toEqual({ isOwner: false, ptys: [[bobPty, true, 'bob']] })
    expect(await names('dave')).toEqual({ isOwner: false, ptys: [[davePty, true, 'dave']] })
    const owner = await names('mowner')
    expect(owner.isOwner).toBe(true)
    expect(owner.ptys.sort()).toEqual([[bobPty, false, 'bob'], [davePty, false, 'dave']].sort())

    const sse = await PtyWs.open(r.w, r.cookie.bob, bobPty)
    await sse.wait((e) => e.type === 'ready')
    expect((await call(r.w, r.cookie.mowner, 'DELETE', `/${bobPty}`)).status).toBe(200) // 主人关别人的
    await sse.closed
    expect(sse.events.at(-1)).toMatchObject({ type: 'exit', reason: 'closed' })
    expect((await call(r.w, r.cookie.bob, 'DELETE', `/${bobPty}`)).status).toBe(404)
    expect((await PtyWs.open(r.w, r.cookie.bob, bobPty)).status).toBe(404) // 关掉了就订阅不到
    expect((await names('mowner')).ptys).toEqual([[davePty, false, 'dave']])
    // 主人关别人的终端不留使用记录（只记非主人）；bob 的第二次关闭（已经没了，404）也留了痕，因为记录在动作之前写
    const { rows } = await pool.query<{ user_id: string; detail: Wire }>("SELECT user_id, detail FROM machine_usage_log WHERE action = 'terminal' ORDER BY id")
    expect(rows.map((x) => [x.user_id, x.detail.op])).toEqual([[r.id.bob, 'open'], [r.id.dave, 'open'], [r.id.bob, 'close']])
  })

  test('收回即断：bob 的授权被收回 → 订阅结束（revoked），connector 上他的终端被关，之后他看不到、打不开', async () => {
    const r = await realWorld()
    const ptyId = await open(r.w, r.cookie.bob)
    const other = await open(r.w, r.cookie.bob)
    const sse = await PtyWs.open(r.w, r.cookie.bob, ptyId)
    await sse.wait((e) => e.type === 'ready')
    const daveSse = await open(r.w, r.cookie.dave)
    const grants = await pool.query<{ id: string }>('SELECT id FROM machine_grants WHERE connector_id = $1 AND user_id = $2', [r.connectorId, r.id.bob])
    expect((await call2('DELETE', `/api/machines/${r.connectorId}/grants/${grants.rows[0]!.id}`, r.cookie.mowner)).status).toBe(200)
    await sse.closed
    expect(sse.events.at(-1)).toMatchObject({ type: 'end', error: 'revoked' })
    // connector 上 bob 的终端都没了（主人的列表里只剩 dave 的）
    await waitFor(async () => {
      const body = (await (await call(r.w, r.cookie.mowner, 'GET')).json()) as { ptys: Array<{ ptyId: string }> }
      return body.ptys.length === 1 && body.ptys[0]!.ptyId === daveSse
    })
    expect(other).not.toBe(daveSse)
    expect((await call(r.w, r.cookie.bob, 'POST', '', {})).status).toBe(403)
    const dave = await PtyWs.open(r.w, r.cookie.dave, daveSse) // dave 的终端不受影响
    expect(dave.status).toBe(200)
    dave.close()
  })

  test('node-pty 加载不到：connector 不声明 terminal，终端接口 409，文件功能照常', async () => {
    const mowner = await insertUser('mowner')
    const cookie = await login('mowner')
    const space = (await (await postJson('/api/spaces', cookie, { name: 's' })).json()) as { id: string }
    const page = (await (await postJson('/api/pages', cookie, { space_id: space.id })).json()) as { id: string }
    const connectorId = await startConnector({
      spaceId: space.id, ownerId: mowner, name: 'nopty', cookie,
      connector: { loadPty: async () => null },
    })
    const w = { pageId: page.id, agent: `c:${connectorId}:claude` }
    const res = await call(w, cookie, 'POST', '', {})
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'terminal unsupported' })
    const head = (await (await fetch(`${base}/api/pages/${page.id}/project?agent=${encodeURIComponent(w.agent)}`, { headers: { cookie } })).json()) as Wire
    expect(head.caps).toEqual(['project', 'preview', 'quick', 'write', 'prompt-image'])
    expect(connectorLogs(connectorId).some((l) => l.includes('node-pty 没装上'))).toBe(true)
  })
})
