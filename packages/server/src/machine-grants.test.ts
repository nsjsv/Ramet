/* ---------- 机器授权的发起 / 确认 / 列表 / 申请 ----------
 * 每条安全约束一个断言：
 *   发起：只有机器主人（空间 owner、全局 admin 一律 403）；重输密码（错 → 403，失败多次限速 429）；手输用户名与机器名对得上；
 *        被授权人是空间 owner/member、不是自己；scopes / days / acknowledged 合法；同一人已有待确认的 → 409；
 *   确认：确认码属于这台机器的 token，一次性，15 分钟；待确认时 canUse 为假；确认后立即生效；新授权确认后旧授权被收回；
 *   机器列表：不泄露 agent 清单与目录；申请：只有主人看得到，不能申请自己的机器，重复 409。
 * 收回即断 / 使用记录在 machine-revoke.test.ts；命令行 + 真 connector 全链路在 machine-grants-e2e.test.ts。 */
import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { CONNECTOR_TOKEN_HEADER } from './agents/protocol.js'
import { hashCode, normalizeCode } from './agents/machine-grants.js'
import { pairMachine, type Machine } from './agents/scripted-machine.js'
import { agentsList, base, continuePage, insertUser, login, pool, postJson, waitFor } from './agents/test-kit.js'

type Who = 'mowner' | 'sowner' | 'gadmin' | 'alice' | 'bob' | 'viewer' | 'outsider' | 'outadmin'
const WHO: readonly Who[] = ['mowner', 'sowner', 'gadmin', 'alice', 'bob', 'viewer', 'outsider', 'outadmin']

type World = { spaceId: string; pageId: string; id: Record<Who, string>; cookie: Record<Who, string>; m: Machine }

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
    await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [space.id, id[who], who === 'viewer' ? 'viewer' : 'member'])
  }
  const page = (await (await postJson('/api/pages', cookie.sowner, { space_id: space.id })).json()) as { id: string }
  const m = await pairMachine(space.id, id.mowner, 'box')
  return { spaceId: space.id, pageId: page.id, id, cookie, m }
}

const call = (method: string, path: string, cookie: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/** connector token 认证的端点（机器上的命令行用的那组） */
const viaMachine = (token: string, method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { [CONNECTOR_TOKEN_HEADER]: token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/** 主人发起授权的请求体（合法的全套，按需覆盖） */
function grantBody(w: World, who: Who, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { password: 'pw-123456', userId: w.id[who], username: who, machineName: 'box', scopes: ['agent'], days: 7, acknowledged: true, ...over }
}

const grantsPath = (w: World): string => `/api/machines/${w.m.id}/grants`
const issue = (w: World, who: Who, over: Record<string, unknown> = {}, by: Who = 'mowner'): Promise<Response> =>
  call('POST', grantsPath(w), w.cookie[by], grantBody(w, who, over))

type Issued = { grantId: string; code: string; expiresAt: string; confirmExpiresAt: string; command: string }
async function issueOk(w: World, who: Who, over: Record<string, unknown> = {}): Promise<Issued> {
  const res = await issue(w, who, over)
  expect(res.status).toBe(201)
  return (await res.json()) as Issued
}

const confirm = (w: World, code: string): Promise<Response> => viaMachine(w.m.token, 'POST', `/api/connector/grants/${encodeURIComponent(code)}/confirm`)
const peek = (w: World, code: string): Promise<Response> => viaMachine(w.m.token, 'GET', `/api/connector/grants/${encodeURIComponent(code)}`)
const rowOf = async (grantId: string): Promise<Record<string, unknown>> =>
  (await pool.query('SELECT * FROM machine_grants WHERE id = $1', [grantId])).rows[0] as Record<string, unknown>
const prepare = (w: World, who: Who): Promise<Response> =>
  postJson(`/api/pages/${w.pageId}/agent-prepare`, w.cookie[who], { agent: `c:${w.m.id}:claude` })

test('发起授权只有机器主人：空间 owner、全局 admin、普通成员一律 403，不在空间里的（含全局 admin）404；没有任何授权行被建出来', async () => {
  const w = await world()
  for (const by of ['sowner', 'gadmin', 'alice', 'viewer'] as const) {
    expect((await issue(w, 'bob', {}, by)).status, `${by} 发起`).toBe(403)
  }
  expect((await issue(w, 'bob', {}, 'outsider')).status).toBe(404)
  expect((await issue(w, 'bob', {}, 'outadmin')).status).toBe(404) // 不在空间里的全局 admin 与 outsider 一样看不到
  // 没登录：401
  expect((await fetch(`${base}${grantsPath(w)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
  expect((await pool.query('SELECT 1 FROM machine_grants')).rowCount).toBe(0)
  // 主人自己可以
  expect((await issue(w, 'bob')).status).toBe(201)
  // 老 connector 没有主人（owner_id 为空）：谁都不是主人，连配对人也发起不了
  await pool.query('UPDATE connectors SET owner_id = NULL WHERE id = $1', [w.m.id])
  expect((await issue(w, 'alice')).status).toBe(403)
})

test('重输登录密码：错 → 403 且不建授权；连错 5 次后一律 429（连正确密码也拒），带 Retry-After', async () => {
  const w = await world()
  for (let i = 0; i < 5; i++) {
    const res = await issue(w, 'alice', { password: `wrong-${i}` })
    expect(res.status, `第 ${i + 1} 次错密码`).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'wrong password' })
  }
  const blocked = await issue(w, 'alice') // 这次密码是对的
  expect(blocked.status).toBe(429)
  expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
  expect(await blocked.json()).toMatchObject({ error: 'too many attempts', retryAfterSec: expect.any(Number) })
  expect((await pool.query('SELECT 1 FROM machine_grants')).rowCount).toBe(0)
})

test('密码对了就清零：错 4 次、对 1 次、再错 4 次仍不会被限速', async () => {
  const w = await world()
  for (let i = 0; i < 4; i++) expect((await issue(w, 'alice', { password: 'nope' })).status).toBe(403)
  expect((await issue(w, 'alice')).status).toBe(201)
  await call('DELETE', `${grantsPath(w)}/${(await pool.query('SELECT id FROM machine_grants')).rows[0].id}`, w.cookie.mowner)
  for (let i = 0; i < 4; i++) expect((await issue(w, 'alice', { password: 'nope' })).status).toBe(403)
  expect((await issue(w, 'alice')).status).toBe(201)
})

test('手输确认与对象校验：用户名 / 机器名对不上 400；被授权人是 viewer / 非成员 / 自己 400；形状不合法 400', async () => {
  const w = await world()
  const cases: Array<[string, Record<string, unknown>, Who]> = [
    ['用户名对不上', { username: 'alicia' }, 'alice'],
    ['用户名大小写不同', { username: 'Alice' }, 'alice'],
    ['用户名带空格', { username: 'alice ' }, 'alice'],
    ['userId 与用户名不是同一个人', { userId: undefined, username: 'nobody-here' }, 'alice'],
    ['机器名对不上', { machineName: 'boxx' }, 'alice'],
    ['机器名大小写不同', { machineName: 'Box' }, 'alice'],
    ['被授权人是 viewer', {}, 'viewer'],
    ['被授权人不在空间里', {}, 'outsider'],
    ['被授权人是自己', {}, 'mowner'],
    ['scopes 为空', { scopes: [] }, 'alice'],
    ['scopes 缺失', { scopes: undefined }, 'alice'],
    ['scopes 含非法值', { scopes: ['agent', 'root'] }, 'alice'],
    ['scopes 不是数组', { scopes: 'agent' }, 'alice'],
    ['days = 0', { days: 0 }, 'alice'],
    ['days > 30', { days: 31 }, 'alice'],
    ['days 不是整数', { days: 1.5 }, 'alice'],
    ['days 是字符串', { days: '7' }, 'alice'],
    ['没确认已读后果', { acknowledged: undefined }, 'alice'],
    ['acknowledged = false', { acknowledged: false }, 'alice'],
    ['acknowledged = "true"', { acknowledged: 'true' }, 'alice'],
  ]
  for (const [label, over, who] of cases) {
    const res = await issue(w, who, over)
    expect(res.status, label).toBe(400)
  }
  expect((await pool.query('SELECT 1 FROM machine_grants')).rowCount).toBe(0)
  // 边界值是合法的
  expect((await issue(w, 'alice', { days: 30, scopes: ['agent', 'machine'] })).status).toBe(201)
  await pool.query('DELETE FROM machine_grants')
  expect((await issue(w, 'alice', { days: 1, scopes: ['machine'], userId: undefined })).status).toBe(201) // 不给 userId：按用户名找
})

test('发起成功：一次性确认码只返回这一次（库里只有哈希），命令全文可抄；同一人已有待确认的 → 409，取消后可再发', async () => {
  const w = await world()
  const issued = await issueOk(w, 'alice', { scopes: ['agent', 'machine'], days: 3 })
  expect(issued.code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/)
  expect(issued.command).toBe(`ramet-connector grant confirm ${issued.code}`)
  expect(Date.parse(issued.expiresAt) - Date.now()).toBeGreaterThan(2.9 * 86_400_000)
  expect(Date.parse(issued.expiresAt) - Date.now()).toBeLessThan(3.1 * 86_400_000)
  const confirmWindow = Date.parse(issued.confirmExpiresAt) - Date.now()
  expect(confirmWindow).toBeGreaterThan(14 * 60_000)
  expect(confirmWindow).toBeLessThanOrEqual(15 * 60_000)

  const row = await rowOf(issued.grantId)
  expect(row).toMatchObject({ user_id: w.id.alice, connector_id: w.m.id, granted_by: w.id.mowner, scopes: ['agent', 'machine'], confirmed_at: null, revoked_at: null })
  expect(row.confirm_code_hash).toBe(createHash('sha256').update(normalizeCode(issued.code)).digest('hex'))
  expect(JSON.stringify(row)).not.toContain(normalizeCode(issued.code)) // 库里没有明文码
  expect(hashCode(issued.code.toLowerCase().replaceAll('-', ' '))).toBe(row.confirm_code_hash) // 大小写 / 连字符 / 空格不计

  // 同一人已有待确认的：409；换一个人不受影响
  expect((await issue(w, 'alice')).status).toBe(409)
  expect((await issue(w, 'bob')).status).toBe(201)
  // 取消待确认的之后可以再发
  expect((await call('DELETE', `${grantsPath(w)}/${issued.grantId}`, w.cookie.mowner)).status).toBe(200)
  expect((await issue(w, 'alice')).status).toBe(201)
})

test('待确认的授权不生效：目录里没有、发起一轮 403；确认码查看不改任何状态', async () => {
  const w = await world()
  const issued = await issueOk(w, 'alice')
  expect((await agentsList(w.cookie.alice)).filter((a) => a.id.startsWith('c:'))).toEqual([])
  expect((await prepare(w, 'alice')).status).toBe(403)
  expect(await continuePage(w.pageId, w.cookie.alice, { agent: `c:${w.m.id}:claude` })).toBe(403)
  expect(w.m.by(w.id.alice)).toEqual([])
  // 机器上看一眼：返回给人看的内容
  const seen = await peek(w, issued.code)
  expect(seen.status).toBe(200)
  expect(await seen.json()).toMatchObject({
    grantId: issued.grantId,
    userId: w.id.alice,
    username: 'alice',
    scopes: ['agent'],
    expiresAt: issued.expiresAt,
    grantedById: w.id.mowner,
    grantedBy: 'mowner',
    machineName: 'box',
  })
  expect((await peek(w, issued.code)).status).toBe(200) // 看多少次都不消耗
  expect((await rowOf(issued.grantId)).confirmed_at).toBeNull()
  expect((await prepare(w, 'alice')).status).toBe(403)
})

test('确认码只属于发起它的那台机器：别的机器的 token / 没 token / 坏 token 都拿不到（404 / 401），码也不会因此被消耗', async () => {
  const w = await world()
  const issued = await issueOk(w, 'alice')
  const other = await pairMachine(w.spaceId, w.id.mowner, 'box2') // 同一个主人的另一台机器
  for (const [label, token] of [['别的机器', other.token], ['坏 token', 'f'.repeat(64)]] as const) {
    const where = (suffix = ''): string => `/api/connector/grants/${encodeURIComponent(issued.code)}${suffix}`
    const res = await viaMachine(token, 'GET', where())
    expect(res.status, `${label} 查看`).toBe(label === '坏 token' ? 401 : 404)
    expect((await viaMachine(token, 'POST', where('/confirm'))).status, `${label} 确认`).toBe(label === '坏 token' ? 401 : 404)
  }
  expect((await fetch(`${base}/api/connector/grants/${issued.code}`)).status).toBe(401)
  expect((await fetch(`${base}/api/connector/grants/${issued.code}`, { headers: { cookie: w.cookie.mowner } })).status).toBe(401) // 登录 cookie 不算
  expect((await peek(w, 'AAAA-BBBB-CCCC-DDDD')).status).toBe(404)
  expect((await rowOf(issued.grantId)).confirmed_at).toBeNull()
  expect((await confirm(w, issued.code)).status).toBe(200) // 正确的机器仍然能确认
})

test('确认：一次性（第二次 404）、过期的码 404、被取消的码 404；确认后立即生效', async () => {
  const w = await world()
  const issued = await issueOk(w, 'alice', { scopes: ['agent'] })

  const done = await confirm(w, issued.code)
  expect(done.status).toBe(200)
  expect(await done.json()).toMatchObject({ grantId: issued.grantId, userId: w.id.alice })
  const row = await rowOf(issued.grantId)
  expect(row.confirmed_at).not.toBeNull()
  expect(row.confirm_code_hash).toBeNull() // 码清掉了
  expect((await confirm(w, issued.code)).status).toBe(404)
  expect((await peek(w, issued.code)).status).toBe(404)

  // 立即生效：目录里出现、可以发起
  expect((await agentsList(w.cookie.alice)).some((a) => a.id === `c:${w.m.id}:claude`)).toBe(true)
  expect((await prepare(w, 'alice')).status).toBe(202)

  // 过期的码
  const late = await issueOk(w, 'bob')
  await pool.query("UPDATE machine_grants SET confirm_expires_at = now() - interval '1 second' WHERE id = $1", [late.grantId])
  expect((await peek(w, late.code)).status).toBe(404)
  expect((await confirm(w, late.code)).status).toBe(404)
  expect((await prepare(w, 'bob')).status).toBe(403)

  // 被取消的码；授权本身已到期的码
  const cancelled = await issueOk(w, 'bob')
  expect((await call('DELETE', `${grantsPath(w)}/${cancelled.grantId}`, w.cookie.mowner)).status).toBe(200)
  expect((await confirm(w, cancelled.code)).status).toBe(404)
  const stale = await issueOk(w, 'bob')
  await pool.query("UPDATE machine_grants SET expires_at = now() - interval '1 second' WHERE id = $1", [stale.grantId])
  expect((await confirm(w, stale.code)).status).toBe(404)
  expect((await prepare(w, 'bob')).status).toBe(403)
})

test('新授权确认后，同一人更早的有效授权被收回（一人一机一条）；此人仍有权限，不会被断开', async () => {
  const w = await world()
  const first = await issueOk(w, 'alice', { scopes: ['agent'] })
  await confirm(w, first.code)
  const second = await issueOk(w, 'alice', { scopes: ['agent', 'machine'] })
  expect(await rowOf(first.grantId)).toMatchObject({ revoked_at: null }) // 新的还没确认：旧的不动
  expect((await prepare(w, 'alice')).status).toBe(202)

  await confirm(w, second.code)
  expect(await rowOf(first.grantId)).toMatchObject({ revoked_at: expect.any(Date), ended_at: expect.any(Date) })
  expect(await rowOf(second.grantId)).toMatchObject({ revoked_at: null, ended_at: null, scopes: ['agent', 'machine'] })
  expect((await prepare(w, 'alice')).status).toBe(202) // 一直有权限
  expect(w.m.of('grant-revoked')).toEqual([]) // 没有断开（换授权不是收回）

  const listed = (await (await call('GET', grantsPath(w), w.cookie.mowner)).json()) as Array<{ id: string; status: string; scopes: string[] }>
  expect(listed.find((g) => g.id === first.grantId)?.status).toBe('revoked')
  expect(listed.find((g) => g.id === second.grantId)).toMatchObject({ status: 'active', scopes: ['agent', 'machine'] })
})

test('授权列表只有主人看得到：状态（待确认 / 生效 / 已过期 / 已收回）、使用时刻，不含确认码与哈希', async () => {
  const w = await world()
  const active = await issueOk(w, 'alice')
  await confirm(w, active.code)
  const pending = await issueOk(w, 'bob')
  const dead = await issueOk(w, 'gadmin')
  await confirm(w, dead.code)
  await pool.query("UPDATE machine_grants SET expires_at = now() - interval '1 second' WHERE id = $1", [dead.grantId])

  for (const who of ['sowner', 'gadmin', 'alice'] as const) {
    expect((await call('GET', grantsPath(w), w.cookie[who])).status, who).toBe(403)
  }
  expect((await call('GET', grantsPath(w), w.cookie.outsider)).status).toBe(404)

  const res = await call('GET', grantsPath(w), w.cookie.mowner)
  const text = await res.text()
  expect(text).not.toContain(pending.code)
  expect(text).not.toContain('confirm_code_hash')
  expect(text).not.toContain('code')
  const list = JSON.parse(text) as Array<{ id: string; username: string; status: string; firstUsedAt: string | null }>
  expect(Object.fromEntries(list.map((g) => [g.username, g.status]))).toEqual({ alice: 'active', bob: 'pending', gadmin: 'expired' })
  expect(list.every((g) => g.firstUsedAt === null)).toBe(true)
})

test('空间的机器列表：成员可读，只有 id / 机器名 / 主人名 / 在线 / 是否我的 / 我的授权 / 我是否在申请 —— 没有 agent 清单、目录、token', async () => {
  const w = await world()
  const issued = await issueOk(w, 'alice', { scopes: ['agent', 'machine'] })
  await confirm(w, issued.code)

  const asAlice = (await (await call('GET', `/api/spaces/${w.spaceId}/machines`, w.cookie.alice)).json()) as Array<Record<string, unknown>>
  expect(asAlice).toHaveLength(1)
  expect(Object.keys(asAlice[0]!).sort()).toEqual(['grant', 'id', 'mine', 'name', 'online', 'owner', 'request', 'requestId', 'status'])
  expect(asAlice[0]).toMatchObject({
    id: w.m.id,
    name: 'box',
    owner: 'mowner',
    status: 'approved',
    online: true,
    mine: false,
    grant: { id: issued.grantId, scopes: ['agent', 'machine'], expiresAt: issued.expiresAt },
    request: false,
    requestId: null,
  })
  const asBob = (await (await call('GET', `/api/spaces/${w.spaceId}/machines`, w.cookie.bob)).json()) as Array<Record<string, unknown>>
  expect(asBob[0]).toMatchObject({ mine: false, grant: null, request: false })
  const asOwner = (await (await call('GET', `/api/spaces/${w.spaceId}/machines`, w.cookie.mowner)).json()) as Array<Record<string, unknown>>
  expect(asOwner[0]).toMatchObject({ mine: true, grant: null })
  expect(JSON.stringify([asAlice, asBob, asOwner])).not.toMatch(/agents|defaultCwd|token|\/tmp|claude/i)
  // viewer 也能看到有哪些机器（只读成员）；非成员（含 admin）404
  expect((await call('GET', `/api/spaces/${w.spaceId}/machines`, w.cookie.viewer)).status).toBe(200)
  expect((await call('GET', `/api/spaces/${w.spaceId}/machines`, w.cookie.outsider)).status).toBe(404)
  expect((await call('GET', `/api/spaces/${w.spaceId}/machines`, w.cookie.outadmin)).status).toBe(404)
  // 离线 → online: false
  w.m.ws.terminate()
  await waitFor(async () => {
    const list = (await (await call('GET', `/api/spaces/${w.spaceId}/machines`, w.cookie.alice)).json()) as Array<{ online: boolean }>
    return list[0]!.online === false
  })
})

test('使用申请：成员可申请，只有主人看得到并能拒绝，申请人能撤回；不能申请自己的机器，重复 409，viewer 403，不在空间 404', async () => {
  const w = await world()
  const reqPath = `/api/machines/${w.m.id}/requests`
  const apply = (who: Who, body: unknown = { scopes: ['agent'], note: '想跑个任务' }): Promise<Response> => call('POST', reqPath, w.cookie[who], body)

  expect((await apply('mowner')).status).toBe(400) // 自己的机器
  expect((await apply('viewer')).status).toBe(403)
  expect((await apply('outsider')).status).toBe(404)
  expect((await apply('outadmin')).status).toBe(404)
  expect((await apply('alice', { scopes: [] })).status).toBe(400)
  expect((await apply('alice', { scopes: ['agent'], note: 'x'.repeat(201) })).status).toBe(400)
  expect((await apply('alice', {})).status).toBe(400)

  const created = await apply('alice')
  expect(created.status).toBe(201)
  const { id: aliceRequest } = (await created.json()) as { id: string }
  expect((await apply('alice')).status).toBe(409)
  expect((await apply('bob', { scopes: ['machine'] })).status).toBe(201) // 别人不受影响，note 可省

  // 机器列表里能看到自己有未处理申请
  const mine = (await (await call('GET', `/api/spaces/${w.spaceId}/machines`, w.cookie.alice)).json()) as Array<{ request: boolean; requestId: string | null }>
  expect(mine[0]).toMatchObject({ request: true, requestId: aliceRequest }) // 只是自己那条的 id（撤回用）

  // 只有主人看得到申请
  for (const who of ['sowner', 'gadmin', 'alice', 'viewer'] as const) {
    expect((await call('GET', reqPath, w.cookie[who])).status, who).toBe(403)
  }
  expect((await call('GET', reqPath, w.cookie.outsider)).status).toBe(404)
  const listed = (await (await call('GET', reqPath, w.cookie.mowner)).json()) as Array<{ username: string; scopes: string[]; note: string }>
  expect(listed.map((r) => r.username)).toEqual(['alice', 'bob'])
  expect(listed[0]).toMatchObject({ scopes: ['agent'], note: '想跑个任务' })

  // 撤回 / 拒绝：不相干的人 403，主人与申请人本人可以
  expect((await call('DELETE', `${reqPath}/${aliceRequest}`, w.cookie.bob)).status).toBe(403)
  expect((await call('DELETE', `${reqPath}/${aliceRequest}`, w.cookie.sowner)).status).toBe(403)
  expect((await call('DELETE', `${reqPath}/${aliceRequest}`, w.cookie.outsider)).status).toBe(404)
  expect((await call('DELETE', `${reqPath}/${aliceRequest}`, w.cookie.alice)).status).toBe(200) // 撤回
  expect((await call('DELETE', `${reqPath}/${aliceRequest}`, w.cookie.alice)).status).toBe(404) // 已处理
  expect((await apply('alice')).status).toBe(201) // 撤回后可以再申请
  const bobRequest = (listed.find((r) => r.username === 'bob') as unknown as { id: string }).id
  expect((await call('DELETE', `${reqPath}/${bobRequest}`, w.cookie.mowner)).status).toBe(200) // 主人拒绝
  expect((await call('GET', reqPath, w.cookie.mowner).then((r) => r.json()) as Array<{ username: string }>).map((r) => r.username)).toEqual(['alice'])

  // 主人为申请人发起授权 = 处理掉他的申请
  await issueOk(w, 'alice')
  expect(await (await call('GET', reqPath, w.cookie.mowner)).json()).toEqual([])
})
