/* ---------- 机器使用权：判定函数 + 凭据（MachinePass）+ hub 发帧闸 + manager 入口 ----------
 * 中心侧的三层：
 *   1) canUse / usableConnectors / assertCanUse / assertLocalOwner：接入人 ∨ 有效授权，没有第三条路；
 *   2) MachinePass：agents/ 里所有会让机器动起来的函数都要它，只有 1) 能签发；
 *   3) hub 发帧闸：凭据必须是真的（instanceof，`as` 伪造的普通对象不行）、签给这台机器的、scope 够、帧里的 actor 与凭据一致。
 * 端到端矩阵在 ../machine-access.test.ts；这里盯各层自己的边界。 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, expect, test } from 'vitest'
import type { WebSocket } from 'ws'
import { closePool, getPool, initDb } from '../db.js'
import { truncateAll } from '../test-helpers.js'
import { AgentManager } from './manager.js'
import { ConnectorHub } from './hub.js'
import { RemoteAgent } from './remote-agent.js'
import { SubRunError } from './sub-run.js'
import { ForbiddenError } from './posture.js'
import {
  assertCanUse,
  assertLocalOwner,
  canUse,
  LOCAL_MACHINE,
  MachinePass,
  usableConnectors,
  type MachineScope,
} from './machine-access.js'
import type { CenterMsg } from './protocol.js'

if (!process.env.DATABASE_URL) {
  throw new Error('需要 DATABASE_URL 指向测试库,例如 postgres://postgres:postgres@localhost:5432/ramet_test')
}
const pool = getPool()
await initDb(pool)
afterEach(async () => {
  await truncateAll(pool)
})
afterAll(async () => {
  await closePool()
})

async function user(name: string, role: 'user' | 'admin' = 'user'): Promise<string> {
  const id = randomUUID()
  await pool.query('INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)', [id, name, 'x', role])
  return id
}

async function space(owner: string, members: string[] = []): Promise<string> {
  const id = randomUUID()
  await pool.query('INSERT INTO spaces (id, name, owner_id) VALUES ($1, $2, $3)', [id, 's', owner])
  await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [id, owner, 'owner'])
  for (const m of members) await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [id, m, 'member'])
  return id
}

async function connector(spaceId: string, ownerId: string | null, name = 'box'): Promise<string> {
  const id = randomUUID()
  await pool.query('INSERT INTO connectors (id, space_id, name, token_hash, owner_id) VALUES ($1, $2, $3, $4, $5)', [
    id, spaceId, name, randomUUID(), ownerId,
  ])
  return id
}

type GrantOpts = { scopes?: MachineScope[]; confirmed?: boolean; revoked?: boolean; expiresInMs?: number }

async function grant(connectorId: string, userId: string, opts: GrantOpts = {}): Promise<void> {
  await pool.query(
    `INSERT INTO machine_grants (id, connector_id, user_id, scopes, granted_by, expires_at, confirmed_at, revoked_at)
     VALUES ($1, $2, $3, $4::text[], 'test', now() + $5::double precision * interval '1 millisecond',
             CASE WHEN $6::boolean THEN now() END, CASE WHEN $7::boolean THEN now() END)`,
    [randomUUID(), connectorId, userId, opts.scopes ?? ['agent'], opts.expiresInMs ?? 3_600_000, opts.confirmed ?? true, opts.revoked ?? false],
  )
}

test('canUse：接入人 ∨ 有效授权；空间 owner / 全局 admin / 同空间成员都没有第三条路', async () => {
  const mowner = await user('mowner')
  const sowner = await user('sowner')
  const admin = await user('root', 'admin')
  const member = await user('member')
  const sp = await space(sowner, [mowner, admin, member])
  const box = await connector(sp, mowner)

  for (const scope of ['agent', 'machine'] as const) {
    expect(await canUse(pool, mowner, box, scope), `主人 / ${scope}`).toBe(true)
    expect(await canUse(pool, sowner, box, scope), `空间 owner / ${scope}`).toBe(false)
    expect(await canUse(pool, admin, box, scope), `全局 admin / ${scope}`).toBe(false)
    expect(await canUse(pool, member, box, scope), `成员 / ${scope}`).toBe(false)
  }
  expect(await canUse(pool, '', box, 'agent')).toBe(false)
  expect(await canUse(pool, mowner, randomUUID(), 'agent')).toBe(false) // 不存在的机器
})

test('canUse：授权要同时满足 已确认 ∧ 未收回 ∧ 未过期 ∧ scope 匹配 ∧ 就是这台机器 ∧ 就是这个人', async () => {
  const mowner = await user('mowner')
  const sp = await space(mowner)
  const box = await connector(sp, mowner)
  const other = await connector(sp, mowner, 'other')
  const cases: Record<string, { opts: GrantOpts; agent: boolean; machine: boolean }> = {
    agentOnly: { opts: { scopes: ['agent'] }, agent: true, machine: false },
    machineOnly: { opts: { scopes: ['machine'] }, agent: false, machine: true },
    both: { opts: { scopes: ['agent', 'machine'] }, agent: true, machine: true },
    unconfirmed: { opts: { confirmed: false, scopes: ['agent', 'machine'] }, agent: false, machine: false },
    revoked: { opts: { revoked: true, scopes: ['agent', 'machine'] }, agent: false, machine: false },
    expired: { opts: { expiresInMs: -1000, scopes: ['agent', 'machine'] }, agent: false, machine: false },
    noScopes: { opts: { scopes: [] }, agent: false, machine: false },
  }
  for (const [name, c] of Object.entries(cases)) {
    const who = await user(name)
    await grant(box, who, c.opts)
    expect(await canUse(pool, who, box, 'agent'), `${name} / agent`).toBe(c.agent)
    expect(await canUse(pool, who, box, 'machine'), `${name} / machine`).toBe(c.machine)
    expect(await canUse(pool, who, other, 'agent'), `${name} 的授权不跨机器`).toBe(false)
  }
  // 授权属于具体的人：给 A 的不算 B
  const a = await user('a')
  const b = await user('b')
  await grant(box, a)
  expect(await canUse(pool, a, box, 'agent')).toBe(true)
  expect(await canUse(pool, b, box, 'agent')).toBe(false)
  // 收回一条不影响另一条仍有效的授权
  await grant(box, b, { revoked: true })
  await grant(box, b)
  expect(await canUse(pool, b, box, 'agent')).toBe(true)
})

test('老 connector 没有主人（owner_id 为空）：谁都不是主人 —— 配对人也不是；空串 / 任意 id 都不行', async () => {
  const mowner = await user('mowner')
  const sp = await space(mowner)
  const orphan = await connector(sp, null)
  expect(await canUse(pool, mowner, orphan, 'agent')).toBe(false)
  expect(await canUse(pool, '', orphan, 'agent')).toBe(false)
  expect(await canUse(pool, 'null', orphan, 'agent')).toBe(false)
  await expect(assertCanUse(pool, { id: mowner }, orphan, 'agent')).rejects.toThrow(/没有主人/)
  // 删号：主人账号没了 → owner_id 置空（ON DELETE SET NULL）→ 机器变成无主，其他人的授权也不会让他们变成主人
  const owner2 = await user('owner2')
  const sp2 = await space(owner2)
  const box2 = await connector(sp2, owner2)
  await pool.query('UPDATE connectors SET owner_id = NULL WHERE id = $1', [box2])
  expect(await canUse(pool, owner2, box2, 'agent')).toBe(false)
})

test('usableConnectors：目录过滤的依据，与 canUse 同口径，按 scope 分', async () => {
  const mowner = await user('mowner')
  const me = await user('me')
  const sp = await space(mowner, [me])
  const mine = await connector(sp, me, 'mine')
  const lent = await connector(sp, mowner, 'lent')
  const strange = await connector(sp, mowner, 'strange')
  const lapsed = await connector(sp, mowner, 'lapsed')
  await grant(lent, me)
  await grant(lapsed, me, { expiresInMs: -1000 })

  expect([...(await usableConnectors(pool, me, 'agent'))].sort()).toEqual([mine, lent].sort())
  expect([...(await usableConnectors(pool, me, 'machine'))]).toEqual([mine])
  expect(strange).not.toBe(mine)
  expect([...(await usableConnectors(pool, mowner, 'agent'))].sort()).toEqual([lent, strange, lapsed].sort())
  expect((await usableConnectors(pool, await user('nobody'), 'agent')).size).toBe(0)
})

test('assertCanUse：能就签出凭据（带人、机器、scope），不能抛 ForbiddenError 并说出主人名；不存在的机器单独一句', async () => {
  const mowner = await user('mowner')
  const stranger = await user('stranger')
  const sp = await space(mowner, [stranger])
  const box = await connector(sp, mowner)

  const pass = await assertCanUse(pool, { id: mowner }, box, 'agent')
  expect(pass).toBeInstanceOf(MachinePass)
  expect(pass).toMatchObject({ userId: mowner, machine: box, scope: 'agent' })
  expect(await assertCanUse(pool, { id: mowner }, box, 'machine')).toMatchObject({ scope: 'machine' })

  const refused = assertCanUse(pool, { id: stranger }, box, 'agent')
  await expect(refused).rejects.toBeInstanceOf(ForbiddenError)
  await expect(refused).rejects.toThrow('这台机器属于 mowner，需要他授权')
  await expect(assertCanUse(pool, { id: stranger }, randomUUID(), 'agent')).rejects.toThrow('找不到这台机器')

  // 授权给了 agent，要 machine 范围的凭据还是不行
  await grant(box, stranger)
  expect(await assertCanUse(pool, { id: stranger }, box, 'agent')).toMatchObject({ userId: stranger, scope: 'agent' })
  await expect(assertCanUse(pool, { id: stranger }, box, 'machine')).rejects.toBeInstanceOf(ForbiddenError)
})

test('assertLocalOwner：中心本机 agent 的主人是全局 admin，不支持授权；凭据标本机', () => {
  const pass = assertLocalOwner({ id: 'root', role: 'admin' }, 'agent')
  expect(pass).toBeInstanceOf(MachinePass)
  expect(pass).toMatchObject({ userId: 'root', machine: LOCAL_MACHINE, scope: 'agent' })
  expect(() => assertLocalOwner({ id: 'bob', role: 'user' }, 'agent')).toThrow(ForbiddenError)
  expect(() => assertLocalOwner({ id: 'bob', role: 'user' }, 'machine')).toThrow(ForbiddenError)
})

// ---------- hub 发帧闸 ----------

function attach(hub: ConnectorHub, id: string, spaceId = 'sp'): CenterMsg[] {
  const sent: CenterMsg[] = []
  hub.attach({
    id,
    spaceId,
    ownerId: null,
    name: id,
    defaultCwd: '/tmp',
    agents: [],
    ws: { readyState: 1, send: (d: string) => sent.push(JSON.parse(d) as CenterMsg), close: () => undefined } as unknown as WebSocket,
  })
  return sent
}

// 桩库对"能不能用"一律答能：这里测的是 hub 对凭据的校验，不是判定本身
const allow = { query: async () => ({ rowCount: 1, rows: [] }) } as unknown as import('pg').Pool
const passFor = (machine: string, scope: MachineScope = 'agent', userId = 'u1'): Promise<MachinePass> =>
  assertCanUse(allow, { id: userId }, machine, scope)

const newFrame = (rid: string, actor: string): CenterMsg => ({ t: 'new', rid, actor, agent: 'fake', cwd: '/tmp' })

test('hub：用 `as` 伪造的凭据（结构相同的普通对象）一律不发帧 —— request / stream / answer 都是', async () => {
  const hub = new ConnectorHub(pool)
  const sent = attach(hub, 'c1')
  const forged = { userId: 'u1', machine: 'c1', scope: 'agent' } as MachinePass

  await expect(hub.request(forged, (rid, actor) => ({ t: 'new', rid, actor, agent: 'fake', cwd: '/tmp' }))).rejects.toThrow('缺少机器使用凭据')
  await expect(
    hub.stream(forged, (rid, actor) => ({ t: 'prompt', rid, actor, runId: 'r1', agent: 'fake', sessionId: 's', blocks: [] }), () => undefined),
  ).rejects.toThrow('缺少机器使用凭据')
  expect(hub.answer(forged, (actor) => ({ t: 'permission', actor, agent: 'fake', requestId: 'p', optionId: 'allow' }))).toBe(false)
  expect(sent).toEqual([])

  // 对照：真凭据发得出去
  void hub.request(await passFor('c1'), (rid, actor) => ({ t: 'new', rid, actor, agent: 'fake', cwd: '/tmp' })).catch(() => undefined)
  expect(sent).toHaveLength(1)
  hub.closeAll('测试结束')
})

test('hub：凭据签给哪台机器，帧就只发给哪台；RemoteAgent.as 拒收别的机器的凭据；机器不在线直接失败', async () => {
  const hub = new ConnectorHub(pool)
  const sent1 = attach(hub, 'c1')
  const sent2 = attach(hub, 'c2')
  const passC1 = await passFor('c1')
  const passC2 = await passFor('c2')

  void hub.request(passC2, (rid, actor) => newFrame(rid, actor) as never).catch(() => undefined)
  expect(sent1).toEqual([]) // 签给 c2 的凭据碰不到 c1
  expect(sent2).toHaveLength(1)

  // 视图层：c1 的 RemoteAgent 不接受签给 c2 的凭据
  expect(() => new RemoteAgent(hub, 'c1', 'fake').as(passC2)).toThrow('凭据不是签给这台机器的')
  expect(() => new RemoteAgent(hub, 'c1', 'fake').as({ userId: 'u1', machine: 'c1', scope: 'agent' } as MachinePass)).toThrow('凭据不是签给这台机器的')
  expect(() => new RemoteAgent(hub, 'c1', 'fake').as(passC1)).not.toThrow()

  // 机器不在线
  await expect(hub.request(await passFor('gone'), (rid, actor) => newFrame(rid, actor) as never)).rejects.toThrow('connector 不在线')
  hub.closeAll('测试结束')
})

test('hub：凭据的 scope 不够不发帧 —— machine 范围的凭据发不出 agent 范围的帧（new / load / ls / prompt / config / permission）', async () => {
  const hub = new ConnectorHub(pool)
  const sent = attach(hub, 'c1')
  const machinePass = await passFor('c1', 'machine')

  await expect(hub.request(machinePass, (rid, actor) => ({ t: 'new', rid, actor, agent: 'fake', cwd: '/tmp' }))).rejects.toThrow('凭据的范围（machine）不够发 new 帧')
  await expect(hub.request(machinePass, (rid, actor) => ({ t: 'load', rid, actor, agent: 'fake', sessionId: 's', cwd: '/tmp' }))).rejects.toThrow('不够发 load 帧')
  await expect(hub.request(machinePass, (rid, actor) => ({ t: 'ls', rid, actor, path: '/' }))).rejects.toThrow('不够发 ls 帧')
  await expect(
    hub.request(machinePass, (rid, actor) => ({ t: 'config', rid, actor, agent: 'fake', sessionId: 's', configId: 'm', value: 'v' })),
  ).rejects.toThrow('不够发 config 帧')
  await expect(
    hub.stream(machinePass, (rid, actor) => ({ t: 'prompt', rid, actor, runId: 'r1', agent: 'fake', sessionId: 's', blocks: [] }), () => undefined),
  ).rejects.toThrow('不够发 prompt 帧')
  expect(hub.answer(machinePass, (actor) => ({ t: 'permission', actor, agent: 'fake', requestId: 'p', optionId: 'allow' }))).toBe(false)
  expect(sent).toEqual([])
  hub.closeAll('测试结束')
})

test('hub：帧里的 actor 与凭据的人不一致不发帧 —— 造帧的人拿不到别人的身份', async () => {
  const hub = new ConnectorHub(pool)
  const sent = attach(hub, 'c1')
  const pass = await passFor('c1', 'agent', 'alice')

  await expect(hub.request(pass, (rid) => ({ t: 'new', rid, actor: 'bob', agent: 'fake', cwd: '/tmp' }))).rejects.toThrow('帧的操作人与凭据不一致')
  await expect(hub.request(pass, (rid) => ({ t: 'ls', rid, actor: '', path: '/' }))).rejects.toThrow('帧的操作人与凭据不一致')
  await expect(
    hub.stream(pass, (rid) => ({ t: 'prompt', rid, actor: 'bob', runId: 'r1', agent: 'fake', sessionId: 's', blocks: [] }), () => undefined),
  ).rejects.toThrow('帧的操作人与凭据不一致')
  expect(hub.answer(pass, () => ({ t: 'permission', actor: 'bob', agent: 'fake', requestId: 'p', optionId: 'allow' }))).toBe(false)
  expect(sent).toEqual([])

  // 对照：actor 对上了就发，帧里带的就是凭据的人
  void hub.request(pass, (rid, actor) => ({ t: 'ls', rid, actor, path: '/' })).catch(() => undefined)
  expect(sent).toEqual([expect.objectContaining({ t: 'ls', actor: 'alice' })])
  hub.closeAll('测试结束')
})

test('hub：cancel 不要凭据、帧里没有 actor（只会让机器停下来）；机器不在线返回 false', async () => {
  const hub = new ConnectorHub(pool)
  const sent = attach(hub, 'c1')
  expect(hub.cancel('c1', { t: 'cancel', agent: 'fake', sessionId: 's1' })).toBe(true)
  expect(sent).toEqual([{ t: 'cancel', agent: 'fake', sessionId: 's1' }])
  expect(hub.cancel('gone', { t: 'cancel', agent: 'fake', sessionId: 's1' })).toBe(false)
  hub.closeAll('测试结束')
})

// ---------- manager 入口 ----------

function managerWith(hub: ConnectorHub): AgentManager {
  return new AgentManager(pool, {
    agents: [],
    hub,
    getLiveDoc: () => undefined,
    wsPort: () => 0,
    httpBase: () => 'http://127.0.0.1:1',
    botSecret: 'test',
  })
}

test('manager.resolve：唯一判定点 —— 主人拿到带凭据的目标；同空间没授权 → ForbiddenError；不在空间 / 离线 → null；判定在"是否在线"之前', async () => {
  const mowner = await user('mowner')
  const stranger = await user('stranger')
  const outsider = await user('outsider')
  const sp = await space(mowner, [stranger])
  const box = await connector(sp, mowner)
  const hub = new ConnectorHub(pool)
  attach(hub, box, sp)
  hub.get(box)!.agents.push({ id: 'fake', label: 'Fake' })
  const manager = managerWith(hub)
  const id = `c:${box}:fake`

  const mine = await manager.resolve(id, { id: mowner, role: 'user' })
  expect(mine?.pass).toBeInstanceOf(MachinePass)
  expect(mine?.pass).toMatchObject({ userId: mowner, machine: box, scope: 'agent' })
  await expect(manager.resolve(id, { id: stranger, role: 'user' })).rejects.toBeInstanceOf(ForbiddenError)
  await expect(manager.resolve(id, { id: stranger, role: 'admin' })).rejects.toBeInstanceOf(ForbiddenError) // 角色字段是 admin 也一样
  expect(await manager.resolve(id, { id: outsider, role: 'user' })).toBeNull()
  expect(await manager.resolve(`c:${box}:ghost`, { id: mowner, role: 'user' })).toBeNull() // 机器没报过这个 agent
  expect(await manager.resolve('c:nope:fake', { id: mowner, role: 'user' })).toBeNull()

  // 授权后，被授权的人拿到的凭据是他自己的
  await grant(box, stranger)
  expect((await manager.resolve(id, { id: stranger, role: 'user' }))?.pass).toMatchObject({ userId: stranger, machine: box })

  // 机器离线：没授权的人仍是 403（不能拿"离线"当绕过判定的缝），有权的人拿 null
  hub.detach(box, '测试掉线')
  const lost = await user('lost')
  await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [sp, lost, 'member'])
  await expect(manager.resolve(id, { id: lost, role: 'user' })).rejects.toBeInstanceOf(ForbiddenError)
  expect(await manager.resolve(id, { id: mowner, role: 'user' })).toBeNull()
})

test('manager.catalog：只含你能用的 —— 本机 agent 为空时非 admin 目录为空；同空间没授权的人看不到这台机器的 agent', async () => {
  const mowner = await user('mowner')
  const stranger = await user('stranger')
  const sp = await space(mowner, [stranger])
  const box = await connector(sp, mowner)
  const hub = new ConnectorHub(pool)
  attach(hub, box, sp)
  hub.get(box)!.agents.push({ id: 'fake', label: 'Fake' })
  const manager = managerWith(hub)

  expect((await manager.catalog({ id: mowner, role: 'user' })).map((a) => a.id)).toEqual([`c:${box}:fake`])
  expect(await manager.catalog({ id: stranger, role: 'user' })).toEqual([])
  expect(await manager.catalog({ id: stranger, role: 'admin' })).toEqual([]) // 全局 admin 也是
  await grant(box, stranger)
  expect((await manager.catalog({ id: stranger, role: 'user' })).map((a) => a.id)).toEqual([`c:${box}:fake`])
})

test('run_agent 的第二层：agentsFor 之后授权被收回 / 本来就不能用，runAgent 自己还会再判（SubRunError，不发帧）', async () => {
  const mowner = await user('mowner')
  const stranger = await user('stranger')
  const outsider = await user('outsider')
  const sp = await space(mowner, [stranger])
  const box = await connector(sp, mowner)
  const hub = new ConnectorHub(pool)
  const sent = attach(hub, box, sp)
  hub.get(box)!.agents.push({ id: 'fake', label: 'Fake' })
  const host = managerWith(hub).toolHost()
  const callee = { id: `c:${box}:fake`, label: 'Fake' }
  const ctx = (userId: string) => ({ pageId: 'p1', callerAgentId: 'someone-else', user: { id: userId, role: 'user' } })
  const signal = new AbortController().signal

  const refused = host.runAgent(ctx(stranger), callee, '做点事', signal)
  await expect(refused).rejects.toBeInstanceOf(SubRunError)
  await expect(refused).rejects.toThrow('这台机器属于 mowner，需要他授权')
  await expect(host.runAgent(ctx(outsider), callee, '做点事', signal)).rejects.toThrow('找不到这个 agent，或你没有权限使用它')
  expect(sent).toEqual([])

  // 授权过又收回：和从没授权一样
  await grant(box, stranger, { revoked: true })
  await expect(host.runAgent(ctx(stranger), callee, '做点事', signal)).rejects.toBeInstanceOf(SubRunError)
  expect(sent).toEqual([])
  expect((await host.agentsFor({ id: stranger, role: 'user' }, 'x')).map((a) => a.id)).toEqual([])
  expect((await host.agentsFor({ id: mowner, role: 'user' }, 'x')).map((a) => a.id)).toEqual([callee.id])
})
