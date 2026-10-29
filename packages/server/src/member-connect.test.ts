/* ---------- 成员接入自己的 agent ----------
 * 空间 member 也能接入机器，但要该空间的 owner 批准后才生效：
 *   - connectors.status：owner 确认 → approved，member 确认 → pending（按浏览器里确认配对的人确认时的角色定）；
 *   - pending 的机器任何人都用不了，包括接入人自己：唯一闸门是 machine-access.ts 的 USABLE，这里挑 agent 目录 /
 *     prepare / 项目面板 / 终端 / 随手 AI 本地通道各打一下，它们是同一处判定；
 *   - 批准 / 拒绝的门槛是该空间的 owner（全局 admin 不参与，除非他本人就是该空间 owner）；
 *   - 可见性：pending 只有空间 owner 和接入人本人看得到（connectors 列表 / machines 列表都不返回给别人）；
 *   - 接入人能撤销自己的机器；被移出空间 / 降为 viewer（含自己退出、重新邀请降权）→ 他在该空间接入的机器被删、在线连接断开。
 * 机器一侧是脚本化 connector（直接说协议），能看到收没收到驱动帧、连接有没有被 4403 断开。 */
import { expect, test } from 'vitest'
import { initDb } from './db.js'
import { approveConnector, createConnector } from './agents/connectors.js'
import { canUse, usableConnectors } from './agents/machine-access.js'
import { connectMachine, type Machine } from './agents/scripted-machine.js'
import { agentsList, base, insertUser, login, openPairRequest, pairViaBrowser, pool, postJson } from './agents/test-kit.js'

type Who = 'sowner' | 'mem' | 'other' | 'viewer' | 'gadmin' | 'outsider' | 'outadmin'
const WHO: readonly Who[] = ['sowner', 'mem', 'other', 'viewer', 'gadmin', 'outsider', 'outadmin']

type World = { spaceId: string; pageId: string; id: Record<Who, string>; cookie: Record<Who, string> }

/** 一个空间：sowner 是 owner；mem / other / gadmin（全局 admin，但只是成员）是 member；viewer 只读；
 *  outsider（普通用户）与 outadmin（全局 admin）不在空间里 */
async function world(): Promise<World> {
  const id = {} as Record<Who, string>
  const cookie = {} as Record<Who, string>
  for (const who of WHO) {
    id[who] = await insertUser(who, who === 'gadmin' || who === 'outadmin' ? 'admin' : 'user')
    cookie[who] = await login(who)
  }
  const space = (await (await postJson('/api/spaces', cookie.sowner, { name: 's' })).json()) as { id: string }
  for (const who of WHO) {
    if (who === 'sowner' || who === 'outsider' || who === 'outadmin') continue
    await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [
      space.id, id[who], who === 'viewer' ? 'viewer' : 'member',
    ])
  }
  const page = (await (await postJson('/api/pages', cookie.sowner, { space_id: space.id })).json()) as { id: string }
  return { spaceId: space.id, pageId: page.id, id, cookie }
}

const call = (method: string, path: string, cookie: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/** 走真实配对：connector 申请链接，who 在浏览器里确认（门槛在确认路由里）；返回 ws 上下发的身份 + 确认结果 */
function pair(w: World, who: Who, name: string, spaceId = w.spaceId) {
  return pairViaBrowser(w.cookie[who], spaceId, name)
}

/** 配对 + 脚本化机器连上（pending 的机器也能连上来，只是谁都用不了） */
async function machine(w: World, who: Who, name: string, spaceId = w.spaceId): Promise<{ m: Machine; status: string }> {
  const paired = await pair(w, who, name, spaceId)
  const m = await connectMachine({ id: paired.connectorId, name, token: paired.token, caps: ['project', 'quick', 'terminal'] })
  return { m, status: paired.status }
}

/** 这台机器的连接被中心断开时的关闭码（要在动作之前登记） */
function closeCode(m: Machine): Promise<number> {
  return new Promise((resolve) => {
    if (m.ws.readyState === 3) resolve(-1)
    else m.ws.once('close', (code: number) => resolve(code))
  })
}

const statusOf = async (id: string): Promise<string | undefined> =>
  (await pool.query<{ status: string }>('SELECT status FROM connectors WHERE id = $1', [id])).rows[0]?.status
const exists = async (id: string): Promise<boolean> => (await pool.query('SELECT 1 FROM connectors WHERE id = $1', [id])).rowCount === 1
const agentIds = async (cookie: string, m: Machine): Promise<string[]> =>
  (await agentsList(cookie)).map((a) => a.id).filter((id) => id.startsWith(`c:${m.id}:`))

type ListedConnector = { id: string; name: string; status: string; owner: string | null; mine: boolean; online: boolean; agents: Array<{ id: string }> }
async function connectorList(w: World, who: Who, spaceId = w.spaceId): Promise<ListedConnector[]> {
  const res = await call('GET', `/api/connectors?space=${spaceId}`, w.cookie[who])
  expect(res.status, `${who} 看连接器列表`).toBe(200)
  return (await res.json()) as ListedConnector[]
}
type ListedMachine = { id: string; status: string; mine: boolean; owner: string | null }
async function machineList(w: World, who: Who): Promise<ListedMachine[]> {
  const res = await call('GET', `/api/spaces/${w.spaceId}/machines`, w.cookie[who])
  expect(res.status, `${who} 看机器列表`).toBe(200)
  return (await res.json()) as ListedMachine[]
}

test('确认配对：viewer 403；不是成员的人（含全局 admin）404；空间不存在 404；被拒的确认不建行、链接仍有效；owner / member 能确认', async () => {
  const w = await world()
  const req = await openPairRequest('gate-box')
  const confirm = (who: Who, spaceId = w.spaceId): Promise<Response> =>
    call('POST', `/api/connect/${req.code}/confirm`, w.cookie[who], { spaceId })
  expect((await confirm('viewer')).status).toBe(403)
  expect((await confirm('outsider')).status).toBe(404)
  // 全局 admin 不是这个空间的成员：接入机器不是管理员特权
  expect((await confirm('outadmin')).status).toBe(404)
  expect((await confirm('sowner', 'no-such')).status).toBe(404)
  expect((await pool.query('SELECT 1 FROM connectors')).rowCount).toBe(0)
  expect((await confirm('mem')).status).toBe(200)
  for (const who of ['sowner', 'other', 'gadmin'] as const) {
    expect((await pair(w, who, `${who}-box`)).ownerId, who).toBe(w.id[who])
  }
})

test('确认：空间 owner 确认 → approved；member 确认 → pending（库里与返回值一致）', async () => {
  const w = await world()
  const byOwner = await pair(w, 'sowner', 'owner-box')
  expect(byOwner.status).toBe('approved')
  expect(await statusOf(byOwner.connectorId)).toBe('approved')
  const byMember = await pair(w, 'mem', 'mem-box')
  expect(byMember.status).toBe('pending')
  expect(await statusOf(byMember.connectorId)).toBe('pending')
  expect(byMember.ownerId).toBe(w.id.mem)
})

test('确认时按确认人此刻的角色：被移出空间 → 404、降为只读 → 403，不建 connector 行；插库那一步也按此刻角色兜底', async () => {
  const w = await world()
  const req = await openPairRequest('late-box')
  expect((await call('DELETE', `/api/spaces/${w.spaceId}/members/${w.id.mem}`, w.cookie.sowner)).status).toBe(200)
  expect((await call('PATCH', `/api/spaces/${w.spaceId}/members/${w.id.other}`, w.cookie.sowner, { role: 'viewer' })).status).toBe(200)
  expect((await call('POST', `/api/connect/${req.code}/confirm`, w.cookie.mem, { spaceId: w.spaceId })).status).toBe(404)
  expect((await call('POST', `/api/connect/${req.code}/confirm`, w.cookie.other, { spaceId: w.spaceId })).status).toBe(403)
  // 路由判完角色、插库之前角色变了：插入语句自己按此刻角色定，不是 owner / member 就不插
  expect(await createConnector(pool, w.spaceId, w.id.mem, 'gone', [])).toBeNull()
  expect(await createConnector(pool, w.spaceId, w.id.other, 'demoted', [])).toBeNull()
  expect((await pool.query('SELECT 1 FROM connectors')).rowCount).toBe(0)
})

test('pending 的机器在线：接入人自己、空间 owner、别的成员的 agent 目录里都没有它；canUse 为假；各入口 403 且机器一侧没有任何驱动帧', async () => {
  const w = await world()
  const { m, status } = await machine(w, 'mem', 'box')
  expect(status).toBe('pending')
  const agent = `c:${m.id}:claude`

  // 目录：看不到就点不到（包括接入人自己）
  for (const who of ['mem', 'sowner', 'other', 'viewer', 'gadmin'] as const) expect(await agentIds(w.cookie[who], m), `目录 / ${who}`).toEqual([])
  // 唯一判定：两种范围都不行
  for (const scope of ['agent', 'machine'] as const) {
    expect(await canUse(pool, w.id.mem, m.id, scope), `canUse ${scope}`).toBe(false)
    expect((await usableConnectors(pool, w.id.mem, scope)).has(m.id), `usableConnectors ${scope}`).toBe(false)
  }

  // 入口：prepare / dirs（agent 范围）、项目面板与终端（machine 范围）、随手 AI 本地通道（agent 范围）
  const prepare = await postJson(`/api/pages/${w.pageId}/agent-prepare`, w.cookie.mem, { agent })
  expect(prepare.status).toBe(403)
  expect(await prepare.json()).toMatchObject({ error: 'forbidden', message: '这台机器还在等空间管理员批准' })
  expect((await call('GET', `/api/pages/${w.pageId}/agent-dirs?agent=${encodeURIComponent(agent)}&path=%2Ftmp`, w.cookie.mem)).status).toBe(403)
  expect((await call('GET', `/api/pages/${w.pageId}/project?agent=${encodeURIComponent(agent)}`, w.cookie.mem)).status).toBe(403)
  expect((await call('GET', `/api/pages/${w.pageId}/project/tree?agent=${encodeURIComponent(agent)}&path=`, w.cookie.mem)).status).toBe(403)
  expect((await call('POST', `/api/pages/${w.pageId}/project/pty?agent=${encodeURIComponent(agent)}`, w.cookie.mem, { cols: 80, rows: 24 })).status).toBe(403)
  // 随手 AI 本地通道：设置里选不了它；就算设置行里留着，调用也被拒
  const put = await call('PUT', '/api/me/ai-settings', w.cookie.mem, { channel: 'local', localAgent: agent })
  expect(put.status).toBe(400)
  await pool.query(
    `INSERT INTO user_ai_settings (user_id, channel, local_agent) VALUES ($1, 'local', $2)
     ON CONFLICT (user_id) DO UPDATE SET channel = 'local', local_agent = $2`,
    [w.id.mem, agent],
  )
  expect((await postJson('/api/quick', w.cookie.mem, { kind: 'rewrite', instruction: '改简洁', text: '一段话' })).status).toBe(403)

  // 机器一侧：谁的驱动帧都没有
  expect(m.driven()).toEqual([])

  // 批准之后：接入人立刻看得到、用得了；别的成员仍然用不了（要用得走授权）
  expect((await call('POST', `/api/connectors/${m.id}/approve`, w.cookie.sowner)).status).toBe(200)
  expect(await agentIds(w.cookie.mem, m)).toEqual([agent, `c:${m.id}:fake`])
  expect(await canUse(pool, w.id.mem, m.id, 'agent')).toBe(true)
  expect(await canUse(pool, w.id.mem, m.id, 'machine')).toBe(true)
  expect((await postJson(`/api/pages/${w.pageId}/agent-prepare`, w.cookie.mem, { agent })).status).toBe(202)
  for (const who of ['sowner', 'other', 'gadmin'] as const) expect(await agentIds(w.cookie[who], m), `批准后 / ${who}`).toEqual([])
  expect((await postJson(`/api/pages/${w.pageId}/agent-prepare`, w.cookie.other, { agent })).status).toBe(403)
  expect(m.by(w.id.other)).toEqual([])
})

test('可见性：pending 只有空间 owner 和接入人本人看得到（connectors 列表与 machines 列表）；批准后对空间成员都可见', async () => {
  const w = await world()
  const { m } = await machine(w, 'mem', 'box')
  const owned = await machine(w, 'sowner', 'owner-box')

  // 空间 owner：两台都在，pending 的带 status / 接入人
  const asOwner = await connectorList(w, 'sowner')
  expect(asOwner.find((c) => c.id === m.id)).toMatchObject({ status: 'pending', owner: 'mem', mine: false, online: true })
  expect(asOwner.find((c) => c.id === owned.m.id)).toMatchObject({ status: 'approved', owner: 'sowner', mine: true })
  // 接入人本人：看得到自己的 pending，mine 为真
  const asMem = await connectorList(w, 'mem')
  expect(asMem.find((c) => c.id === m.id)).toMatchObject({ status: 'pending', owner: 'mem', mine: true })
  // 别人：整行不返回（不是置灰）；approved 的对空间成员照常可见。不是成员的全局 admin 同样看不到 pending
  for (const who of ['other', 'viewer', 'gadmin'] as const) {
    const ids = (await connectorList(w, who)).map((c) => c.id)
    expect(ids, who).not.toContain(m.id)
    expect(ids, who).toContain(owned.m.id)
  }
  // 不在空间里的人（含全局 admin）看不到这个空间的连接器列表
  for (const who of ['outsider', 'outadmin'] as const) {
    expect((await call('GET', `/api/connectors?space=${w.spaceId}`, w.cookie[who])).status, who).toBe(404)
  }

  // 机器列表（设置 → 机器）：只列 approved，外加我自己的 pending
  const mineList = await machineList(w, 'mem')
  expect(mineList.find((x) => x.id === m.id)).toMatchObject({ status: 'pending', mine: true, owner: 'mem' })
  for (const who of ['sowner', 'other', 'viewer', 'gadmin'] as const) {
    const ids = (await machineList(w, who)).map((x) => x.id)
    expect(ids, who).not.toContain(m.id)
    expect(ids, who).toContain(owned.m.id)
  }

  // 批准后：所有成员都看得到
  expect((await call('POST', `/api/connectors/${m.id}/approve`, w.cookie.sowner)).status).toBe(200)
  for (const who of ['sowner', 'mem', 'other', 'viewer', 'gadmin'] as const) {
    expect((await connectorList(w, who)).find((c) => c.id === m.id), `connectors / ${who}`).toMatchObject({ status: 'approved' })
    expect((await machineList(w, who)).find((x) => x.id === m.id), `machines / ${who}`).toMatchObject({ status: 'approved' })
  }
})

test('pending 的机器不能被申请使用（404）、不能授权给别人（接入人 409，别人 404）', async () => {
  const w = await world()
  const { m } = await machine(w, 'mem', 'box')
  // 别的成员申请：当它不存在；接入人申请自己的也一样（先于「这是你自己的机器」）
  expect((await call('POST', `/api/machines/${m.id}/requests`, w.cookie.other, { scopes: ['agent'] })).status).toBe(404)
  expect((await call('POST', `/api/machines/${m.id}/requests`, w.cookie.mem, { scopes: ['agent'] })).status).toBe(404)
  // 接入人创建授权：409（先于密码校验）
  const body = { password: 'pw-123456', userId: w.id.other, username: 'other', machineName: 'box', scopes: ['agent'], days: 7, acknowledged: true }
  const grant = await call('POST', `/api/machines/${m.id}/grants`, w.cookie.mem, body)
  expect(grant.status).toBe(409)
  expect(await grant.json()).toMatchObject({ message: expect.stringContaining('等空间管理员批准') })
  // 空间 owner / 别的成员：这台机器对他们不存在
  for (const who of ['sowner', 'other', 'gadmin'] as const) {
    expect((await call('POST', `/api/machines/${m.id}/grants`, w.cookie[who], body)).status, who).toBe(404)
    expect((await call('GET', `/api/machines/${m.id}/grants`, w.cookie[who])).status, `列授权 / ${who}`).toBe(404)
  }
  expect((await pool.query('SELECT 1 FROM machine_grants WHERE connector_id = $1', [m.id])).rowCount).toBe(0)
  expect((await pool.query('SELECT 1 FROM machine_access_requests WHERE connector_id = $1', [m.id])).rowCount).toBe(0)

  // 批准后恢复正常：别人能申请，接入人能授权
  expect((await call('POST', `/api/connectors/${m.id}/approve`, w.cookie.sowner)).status).toBe(200)
  expect((await call('POST', `/api/machines/${m.id}/requests`, w.cookie.other, { scopes: ['agent'] })).status).toBe(201)
  expect((await call('POST', `/api/machines/${m.id}/grants`, w.cookie.mem, body)).status).toBe(201)
})

test('批准：只有该空间的 owner；接入人自己、别的成员、viewer、全局 admin（只是成员）都 403，不在空间里的 404；对已批准的再批准 409', async () => {
  const w = await world()
  const { m } = await machine(w, 'mem', 'box')
  const approve = (who: Who): Promise<Response> => call('POST', `/api/connectors/${m.id}/approve`, w.cookie[who])

  for (const who of ['mem', 'other', 'viewer', 'gadmin'] as const) {
    expect((await approve(who)).status, who).toBe(403)
    expect(await statusOf(m.id), `${who} 之后`).toBe('pending')
  }
  for (const who of ['outsider', 'outadmin'] as const) {
    expect((await approve(who)).status, who).toBe(404)
    expect(await statusOf(m.id), `${who} 之后`).toBe('pending')
  }
  expect((await call('POST', '/api/connectors/no-such/approve', w.cookie.sowner)).status).toBe(404)

  expect((await approve('sowner')).status).toBe(200)
  expect(await statusOf(m.id)).toBe('approved')
  // 已批准的：批准 / 拒绝都 409，机器还在
  expect((await approve('sowner')).status).toBe(409)
  expect((await call('POST', `/api/connectors/${m.id}/reject`, w.cookie.sowner)).status).toBe(409)
  expect(await statusOf(m.id)).toBe('approved')
  expect(m.ws.readyState).toBe(1)
})

test('批准的门槛是「该空间的 owner」而不是「全局 admin」：全局 admin 在自己当 owner 的空间里能批准', async () => {
  const w = await world()
  const space = (await (await postJson('/api/spaces', w.cookie.gadmin, { name: 'admin-space' })).json()) as { id: string }
  await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [space.id, w.id.mem, 'member'])
  const { m, status } = await machine(w, 'mem', 'box', space.id)
  expect(status).toBe('pending')
  // 同一个全局 admin 在别人的空间里没有这个权力（上一个用例），在自己的空间里有
  expect((await call('POST', `/api/connectors/${m.id}/approve`, w.cookie.sowner)).status).toBe(404) // sowner 不在这个空间
  expect((await call('POST', `/api/connectors/${m.id}/approve`, w.cookie.gadmin)).status).toBe(200)
  expect(await statusOf(m.id)).toBe('approved')
})

test('拒绝：只有该空间的 owner；删除 connector 行并断开在线连接（4403）', async () => {
  const w = await world()
  const { m } = await machine(w, 'mem', 'box')
  const reject = (who: Who): Promise<Response> => call('POST', `/api/connectors/${m.id}/reject`, w.cookie[who])
  for (const who of ['mem', 'other', 'viewer', 'gadmin'] as const) expect((await reject(who)).status, who).toBe(403)
  for (const who of ['outsider', 'outadmin'] as const) expect((await reject(who)).status, who).toBe(404)
  expect(await exists(m.id)).toBe(true)
  expect(m.ws.readyState).toBe(1)

  const closed = closeCode(m)
  expect((await reject('sowner')).status).toBe(200)
  expect(await exists(m.id)).toBe(false)
  expect(await closed).toBe(4403)
  expect((await reject('sowner')).status).toBe(404)
})

test('撤销：接入人能撤销自己的机器（pending 也行）；别的成员撤销别人的 403；空间 owner 与全局 admin 仍可；断开在线连接', async () => {
  const w = await world()
  const own = await machine(w, 'mem', 'mem-box')
  const theirs = await machine(w, 'other', 'other-box')
  await approveConnector(pool, theirs.m.id)
  const del = (id: string, who: Who): Promise<Response> => call('DELETE', `/api/connectors/${id}`, w.cookie[who])

  // 别人的机器：普通成员 / viewer 不行（对 pending 与 approved 都一样）
  for (const who of ['other', 'viewer'] as const) {
    expect((await del(own.m.id, who)).status, `${who} 撤销 mem 的 pending`).toBe(403)
  }
  expect((await del(theirs.m.id, 'mem')).status).toBe(403)
  expect((await del(theirs.m.id, 'viewer')).status).toBe(403)
  expect(await exists(own.m.id)).toBe(true)
  expect(await exists(theirs.m.id)).toBe(true)
  expect(own.m.ws.readyState).toBe(1)

  // 接入人撤销自己的（还没被批准）
  const closedOwn = closeCode(own.m)
  expect((await del(own.m.id, 'mem')).status).toBe(200)
  expect(await exists(own.m.id)).toBe(false)
  expect(await closedOwn).toBe(4403)
  // 接入人撤销自己已批准的
  const closedTheirs = closeCode(theirs.m)
  expect((await del(theirs.m.id, 'other')).status).toBe(200)
  expect(await closedTheirs).toBe(4403)

  // 空间 owner 可以；不在空间里的人（含全局 admin）与机器不存在同响应 404
  const a = await machine(w, 'mem', 'a')
  const b = await machine(w, 'mem', 'b')
  expect((await del(a.m.id, 'sowner')).status).toBe(200)
  expect(await exists(a.m.id)).toBe(false)
  for (const who of ['outsider', 'outadmin'] as const) expect((await del(b.m.id, who)).status, who).toBe(404)
  expect(await exists(b.m.id)).toBe(true)
})

test('被移出空间 / 自己退出 / 降为只读 / 重新邀请降权：他在该空间接入的机器被删、在线连接断开；改回 member、别人的机器、别的空间的机器不受影响', async () => {
  const w = await world()
  const space2 = (await (await postJson('/api/spaces', w.cookie.sowner, { name: 's2' })).json()) as { id: string }
  await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3), ($1, $4, $3)', [space2.id, w.id.mem, 'member', w.id.other])

  /** 每种场景新配一批：mem 在 s1 的两台（一台已批准）+ 在 s2 的一台；other 在 s1 的一台 */
  async function fleet() {
    const a = await machine(w, 'mem', `a-${Math.random().toString(36).slice(2, 6)}`)
    const b = await machine(w, 'mem', `b-${Math.random().toString(36).slice(2, 6)}`)
    await approveConnector(pool, b.m.id)
    const inOther = await machine(w, 'mem', `s2-${Math.random().toString(36).slice(2, 6)}`, space2.id)
    const others = await machine(w, 'other', `o-${Math.random().toString(36).slice(2, 6)}`)
    return { a: a.m, b: b.m, inOther: inOther.m, others: others.m }
  }
  async function expectDropped(f: Awaited<ReturnType<typeof fleet>>, closes: Array<Promise<number>>, label: string): Promise<void> {
    for (const closed of closes) expect(await closed, `${label} 断开`).toBe(4403)
    expect(await exists(f.a.id), `${label} a`).toBe(false)
    expect(await exists(f.b.id), `${label} b`).toBe(false)
    // 别的空间里他接入的、别人在这个空间里接入的，都还在，连接没断
    expect(await exists(f.inOther.id), `${label} 别的空间`).toBe(true)
    expect(await exists(f.others.id), `${label} 别人的`).toBe(true)
    expect(f.inOther.ws.readyState, `${label} 别的空间的连接`).toBe(1)
    expect(f.others.ws.readyState, `${label} 别人的连接`).toBe(1)
  }
  const watch = (f: Awaited<ReturnType<typeof fleet>>): Array<Promise<number>> => [closeCode(f.a), closeCode(f.b)]

  // 1) 被空间 owner 移出
  let f = await fleet()
  let closes = watch(f)
  expect((await call('DELETE', `/api/spaces/${w.spaceId}/members/${w.id.mem}`, w.cookie.sowner)).status).toBe(200)
  await expectDropped(f, closes, '被移出')
  await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [w.spaceId, w.id.mem, 'member'])

  // 2) 自己退出
  f = await fleet()
  closes = watch(f)
  expect((await call('DELETE', `/api/spaces/${w.spaceId}/members/${w.id.mem}`, w.cookie.mem)).status).toBe(200)
  await expectDropped(f, closes, '自己退出')
  await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [w.spaceId, w.id.mem, 'member'])

  // 3) 降为只读
  f = await fleet()
  closes = watch(f)
  expect((await call('PATCH', `/api/spaces/${w.spaceId}/members/${w.id.mem}`, w.cookie.sowner, { role: 'viewer' })).status).toBe(200)
  await expectDropped(f, closes, '降为只读')
  // 改回 member 不会再删任何东西（也不会把已经没了的机器变回来）
  expect((await call('PATCH', `/api/spaces/${w.spaceId}/members/${w.id.mem}`, w.cookie.sowner, { role: 'member' })).status).toBe(200)

  // 4) 重新邀请降权：member 接受一个 viewer 邀请
  f = await fleet()
  closes = watch(f)
  const invite = (await (await call('POST', `/api/spaces/${w.spaceId}/invites`, w.cookie.sowner, { role: 'viewer' })).json()) as { token: string }
  expect((await call('POST', `/api/invites/${invite.token}/accept`, w.cookie.mem)).status).toBe(200)
  await expectDropped(f, closes, '邀请降权')
  await pool.query("UPDATE space_members SET role = 'member' WHERE space_id = $1 AND user_id = $2", [w.spaceId, w.id.mem])

  // 5) 对照：改成 member / 接受 member 邀请不删任何机器
  f = await fleet()
  expect((await call('PATCH', `/api/spaces/${w.spaceId}/members/${w.id.mem}`, w.cookie.sowner, { role: 'member' })).status).toBe(200)
  const memberInvite = (await (await call('POST', `/api/spaces/${w.spaceId}/invites`, w.cookie.sowner, { role: 'member' })).json()) as { token: string }
  expect((await call('POST', `/api/invites/${memberInvite.token}/accept`, w.cookie.mem)).status).toBe(200)
  for (const m of [f.a, f.b, f.inOther, f.others]) {
    expect(await exists(m.id)).toBe(true)
    expect(m.ws.readyState).toBe(1)
  }
})

test('存量库迁移：老库的 connectors 没有 status 列 → 重启补列，老行默认 approved（不影响老数据）；乱值被 CHECK 拒绝', async () => {
  const w = await world()
  const old = await pair(w, 'sowner', 'old-box')
  await pool.query('ALTER TABLE connectors DROP COLUMN status')
  await initDb(pool) // 幂等：再跑一遍不报错
  await initDb(pool)
  expect(await statusOf(old.connectorId)).toBe('approved')
  await expect(pool.query("UPDATE connectors SET status = 'bogus' WHERE id = $1", [old.connectorId])).rejects.toThrow()
  expect(await statusOf(old.connectorId)).toBe('approved')
})

test('主人删号：他接入的机器（各空间）同一事务删掉、在线连接断开；无主机器上残留的授权一律作废', async () => {
  const w = await world()
  // mem 在两个空间各接一台（第二个空间是他自己的个人空间之外新建的）
  const a = await machine(w, 'mem', 'mem-box')
  await approveConnector(pool, a.m.id)
  const other = (await (await postJson('/api/spaces', w.cookie.mem, { name: 'mine' })).json()) as { id: string }
  const b = await machine(w, 'mem', 'mem-own', other.id)
  const keep = await machine(w, 'sowner', 'sowner-box')
  const closes = [closeCode(a.m), closeCode(b.m)]
  expect((await call('DELETE', `/api/admin/users/${w.id.mem}`, w.cookie.outadmin)).status).toBe(200)
  expect(await exists(a.m.id)).toBe(false)
  expect(await exists(b.m.id)).toBe(false)
  expect(await Promise.all(closes)).toEqual([4403, 4403])
  expect(await exists(keep.m.id)).toBe(true)
  expect(keep.m.ws.readyState).toBe(1)

  // 兜底：机器没被删掉而主人没了（老 connector / 外键置空），上面挂着的已确认授权也不能再让人用
  const orphan = await machine(w, 'sowner', 'orphan-box')
  await pool.query(
    `INSERT INTO machine_grants (id, connector_id, user_id, scopes, granted_by, expires_at, confirmed_at)
     VALUES ('g-orphan', $1, $2, ARRAY['agent','machine'], $3, now() + interval '1 day', now())`,
    [orphan.m.id, w.id.other, w.id.sowner],
  )
  expect(await canUse(pool, w.id.other, orphan.m.id, 'agent')).toBe(true)
  await pool.query('UPDATE connectors SET owner_id = NULL WHERE id = $1', [orphan.m.id])
  expect(await canUse(pool, w.id.other, orphan.m.id, 'agent')).toBe(false)
  expect(await canUse(pool, w.id.other, orphan.m.id, 'machine')).toBe(false)
  expect((await usableConnectors(pool, w.id.other, 'agent')).has(orphan.m.id)).toBe(false)
  expect(await agentIds(w.cookie.other, orphan.m)).toEqual([])
})
