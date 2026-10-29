import { afterAll, beforeEach, expect, test } from 'vitest'
import { Document, OutgoingMessage } from '@hocuspocus/server'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { closePool, getPool, initDb } from './db.js'
import { startServer } from './index.js'
import { hashPassword, SESSION_COOKIE } from './auth.js'
import { truncateAll } from './test-helpers.js'

// 测试必须显式指向测试库（如 ramet_test），防止误写开发库
if (!process.env.DATABASE_URL) {
  throw new Error('需要 DATABASE_URL 指向测试库,例如 postgres://postgres:postgres@localhost:5432/ramet_test')
}

let pool = getPool()
await initDb(pool)

// 整个文件共用一个 server，各用例自建账号，互不依赖
const s = await startServer(pool)
const base = `http://127.0.0.1:${s.port}`
const wsBase = `ws://127.0.0.1:${s.port}/collab`

beforeEach(async () => {
  // 每个用例从空库出发；users 被 pages / sessions / spaces 外键引用，须同一语句一并清
  await truncateAll(pool)
})

afterAll(async () => {
  await s.close()
  await closePool()
})

async function insertUser(username: string, password: string, role = 'user'): Promise<string> {
  const id = crypto.randomUUID()
  await pool.query('INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)', [
    id,
    username,
    hashPassword(password),
    role,
  ])
  return id
}

async function login(username: string, password: string): Promise<{ status: number; cookie: string | null }> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? null }
}

async function createPage(cookie: string, body: Record<string, unknown> = {}): Promise<{ status: number; page: { id: string; owner_id?: string } }> {
  const res = await fetch(`${base}/api/pages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return { status: res.status, page: (await res.json()) as { id: string; owner_id?: string } }
}

// ---------- 认证接口 ----------

test('会话 cookie：经 https 进来（X-Forwarded-Proto: https）带 Secure，http 不带；退出时同样', async () => {
  await insertUser('alice', 'pw-a')
  const loginWith = (headers: Record<string, string>) =>
    fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ username: 'alice', password: 'pw-a' }),
    })
  const viaHttps = (await loginWith({ 'x-forwarded-proto': 'https' })).headers.get('set-cookie') ?? ''
  expect(viaHttps).toMatch(/;\s*Secure/)
  expect(viaHttps).toMatch(/HttpOnly/)
  // 多层代理时取第一跳（离浏览器最近的那个）
  expect((await loginWith({ 'x-forwarded-proto': 'https, http' })).headers.get('set-cookie')).toMatch(/;\s*Secure/)
  const viaHttp = (await loginWith({})).headers.get('set-cookie') ?? ''
  expect(viaHttp).not.toMatch(/Secure/)

  const cookie = viaHttp.split(';')[0]!
  const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie, 'x-forwarded-proto': 'https' } })
  const cleared = out.headers.get('set-cookie') ?? ''
  expect(cleared).toMatch(/Max-Age=0/)
  expect(cleared).toMatch(/;\s*Secure/)
})

test('登录成功发 cookie;错密码 401;me 未登录 401、登录后可见', async () => {
  await insertUser('alice', 'pw-a')

  const ok = await login('alice', 'pw-a')
  expect(ok.status).toBe(200)
  expect(ok.cookie).toBeTruthy()
  const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: ok.cookie! } })
  expect(me.status).toBe(200)
  const user = (await me.json()) as { username: string; role: string; must_change_password: boolean }
  expect(user.username).toBe('alice')
  expect(user.role).toBe('user')
  // 正常密码建的号不触发强制改密
  expect(user.must_change_password).toBe(false)
  // 响应体不泄露密码字段（库里也不存明文，这里只锁接口形态）
  expect(user).not.toHaveProperty('password')

  const bad = await login('alice', 'wrong')
  expect(bad.status).toBe(401)

  const anon = await fetch(`${base}/api/auth/me`)
  expect(anon.status).toBe(401)
})

test('头像:默认 null;设成已上传的图片后 me 与成员列表都带上;非图片 / 不存在 / 坏参数 400;null 清除;未登录 401', async () => {
  await insertUser('alice', 'pw-a')
  const { cookie } = await login('alice', 'pw-a')
  const headers = { 'content-type': 'application/json', cookie: cookie! }
  const put = (body: unknown) => fetch(`${base}/api/auth/avatar`, { method: 'PUT', headers, body: JSON.stringify(body) })
  const me = async () => ((await (await fetch(`${base}/api/auth/me`, { headers })).json()) as { avatar: string | null }).avatar
  await pool.query("INSERT INTO files (id, name, mime, size) VALUES ('img-1', 'a.png', 'image/png', 1), ('txt-1', 'a.txt', 'text/plain', 1)")

  expect(await me()).toBeNull()
  const ok = await put({ file_id: 'img-1' })
  expect(ok.status).toBe(200)
  expect(await ok.json()).toEqual({ avatar: 'img-1' })
  expect(await me()).toBe('img-1')
  // 成员列表带头像（对话气泡按发言人画头像的数据源）
  const [personal] = (await (await fetch(`${base}/api/spaces`, { headers })).json()) as { id: string }[]
  const members = (await (await fetch(`${base}/api/spaces/${personal!.id}/members`, { headers })).json()) as { avatar: string | null }[]
  expect(members.map((m) => m.avatar)).toEqual(['img-1'])

  for (const bad of [{ file_id: 'txt-1' }, { file_id: 'no-such' }, { file_id: 42 }, {}]) expect((await put(bad)).status).toBe(400)
  expect(await me()).toBe('img-1') // 失败不动原值
  expect((await put({ file_id: null })).status).toBe(200)
  expect(await me()).toBeNull()
  expect((await fetch(`${base}/api/auth/avatar`, { method: 'PUT', body: JSON.stringify({ file_id: null }) })).status).toBe(401)
})

test('logout 删除会话并清 cookie,旧 token 立即失效', async () => {
  await insertUser('alice', 'pw-a')
  const { cookie } = await login('alice', 'pw-a')

  const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: cookie! } })
  expect(out.status).toBe(200)
  expect(out.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=;`)

  const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: cookie! } })
  expect(me.status).toBe(401)
  const rows = await pool.query('SELECT * FROM sessions')
  expect(rows.rowCount).toBe(0)
})

test('登录滚动会话:带着旧 token 再登录,旧 token 作废', async () => {
  await insertUser('alice', 'pw-a')
  const first = await login('alice', 'pw-a')
  // 提交旧 cookie 再登录
  const second = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: first.cookie! },
    body: JSON.stringify({ username: 'alice', password: 'pw-a' }),
  })
  expect(second.status).toBe(200)
  const rows = await pool.query('SELECT token FROM sessions')
  expect(rows.rowCount).toBe(1)
  const oldToken = first.cookie!.split('=')[1]!
  expect((rows.rows as { token: string }[]).some((r) => r.token === oldToken)).toBe(false)
})

test('畸形 cookie(非法百分号编码)按原值处理,会话 miss 返回 401 而非 500', async () => {
  // %E0%A4%A 是不完整 UTF-8 序列，decodeURIComponent 会抛 URIError，解析必须兜底
  const res = await fetch(`${base}/api/auth/me`, { headers: { cookie: 'ramet_session=%E0%A4%A; other=%zz' } })
  expect(res.status).toBe(401)
  expect((await res.json())).toEqual({ error: 'unauthorized' })
})

// ---------- admin 接口 ----------

test('普通用户访问 admin 接口 403,未登录 401', async () => {
  await insertUser('bob', 'pw-b')
  const { cookie } = await login('bob', 'pw-b')

  for (const [method, path] of [
    ['GET', '/api/admin/users'],
    ['POST', '/api/admin/users'],
    ['POST', '/api/admin/users/x/password'],
    ['DELETE', '/api/admin/users/x'],
  ] as const) {
    const res = await fetch(`${base}${path}`, { method, headers: { cookie: cookie! } })
    expect(res.status).toBe(403)
    const anon = await fetch(`${base}${path}`, { method })
    expect(anon.status).toBe(401)
  }
})

test('admin 建号 201 返回一次性临时密码;重名 409;列表不含 password', async () => {
  const adminId = await insertUser('root', 'pw-root', 'admin')
  const { cookie } = await login('root', 'pw-root')

  const created = await fetch(`${base}/api/admin/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie! },
    body: JSON.stringify({ username: 'carol', password: '客户端传的密码会被忽略' }),
  })
  expect(created.status).toBe(201)
  const body = (await created.json()) as { id: string; username: string; role: string; password: string }
  expect(body.username).toBe('carol')
  expect(body.role).toBe('user')
  // 临时密码 10 位、字母数字且剔除易混淆字符 0O1lI，password 仅此一次出现
  expect(body.password).toMatch(/^[A-Za-z2-9]{10}$/)
  expect(body.password).not.toMatch(/[0O1lI]/)

  // 用户名校验：trim 后非空且 ≤50；中文名与带首尾空格输入都合法（存 trim 后的）
  const tooLong = await fetch(`${base}/api/admin/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie! },
    body: JSON.stringify({ username: 'a'.repeat(51) }),
  })
  expect(tooLong.status).toBe(400)
  const blank = await fetch(`${base}/api/admin/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie! },
    body: JSON.stringify({ username: '   ' }),
  })
  expect(blank.status).toBe(400)
  const padded = await fetch(`${base}/api/admin/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie! },
    body: JSON.stringify({ username: '  小明  ' }),
  })
  expect(padded.status).toBe(201)
  expect(((await padded.json()) as { username: string }).username).toBe('小明')

  const dup = await fetch(`${base}/api/admin/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie! },
    body: JSON.stringify({ username: 'carol' }),
  })
  expect(dup.status).toBe(409)

  const list = await fetch(`${base}/api/admin/users`, { headers: { cookie: cookie! } })
  expect(list.status).toBe(200)
  const users = (await list.json()) as { username: string; created_at: string }[]
  expect(users.map((u) => u.username).sort()).toEqual(['carol', 'root', '小明'])
  for (const u of users) expect(u).not.toHaveProperty('password')

  // 临时密码可登录，me 返回 must_change_password: true
  const tempLogin = await login('carol', body.password)
  expect(tempLogin.status).toBe(200)
  // 客户端硬传的 password 被后端忽略，用它登录必须 401
  expect((await login('carol', '客户端传的密码会被忽略')).status).toBe(401)
  const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: tempLogin.cookie! } })
  const meUser = (await me.json()) as { username: string; must_change_password: boolean }
  expect(meUser.username).toBe('carol')
  expect(meUser.must_change_password).toBe(true)
  expect(meUser).not.toHaveProperty('password')
  expect(adminId).toBeTruthy()
})

test('change-password:弱密码 400,成功后 flag 翻 false、旧临时密码失效、新密码可登录', async () => {
  await insertUser('root', 'pw-root', 'admin')
  const { cookie } = await login('root', 'pw-root')
  const created = await fetch(`${base}/api/admin/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie! },
    body: JSON.stringify({ username: 'carol' }),
  })
  const temp = ((await created.json()) as { password: string }).password
  const { cookie: userCookie } = await login('carol', temp)
  // 平行会话（模拟临时密码被他人抢先使用），改密后必须被吊销
  const { cookie: otherCookie } = await login('carol', temp)

  // 未登录 401
  const anon = await fetch(`${base}/api/auth/change-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ new_password: 'long-enough-pw' }),
  })
  expect(anon.status).toBe(401)

  // 少于 8 位 400（与 setup 同一套校验）
  const weak = await fetch(`${base}/api/auth/change-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: userCookie! },
    body: JSON.stringify({ new_password: 'short' }),
  })
  expect(weak.status).toBe(400)

  // 改密成功
  const ok = await fetch(`${base}/api/auth/change-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: userCookie! },
    body: JSON.stringify({ new_password: 'pw-new-8' }),
  })
  expect(ok.status).toBe(200)
  expect((await ok.json())).toEqual({})

  // flag 翻 false
  const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: userCookie! } })
  expect(((await me.json()) as { must_change_password: boolean }).must_change_password).toBe(false)

  // 发起改密的当前会话保留，同用户其余会话已吊销
  expect((await fetch(`${base}/api/auth/me`, { headers: { cookie: userCookie! } })).status).toBe(200)
  expect((await fetch(`${base}/api/auth/me`, { headers: { cookie: otherCookie! } })).status).toBe(401)

  // 旧临时密码失效，新密码可登录
  expect((await login('carol', temp)).status).toBe(401)
  expect((await login('carol', 'pw-new-8')).status).toBe(200)

  // 改密后 me 依旧不带 password
  const me2 = await fetch(`${base}/api/auth/me`, { headers: { cookie: (await login('carol', 'pw-new-8')).cookie! } })
  expect((await me2.json())).not.toHaveProperty('password')
})

test('重置密码:生成一次性临时密码,flag 翻 true,旧密码失效,目标会话吊销,admin 会话保留', async () => {
  await insertUser('root', 'pw-root', 'admin')
  const adminCookie = (await login('root', 'pw-root')).cookie!
  const daveId = await insertUser('dave', 'pw-dave')
  const { cookie: daveCookie } = await login('dave', 'pw-dave')

  // 请求体为空（{} 即可，不收 password）
  const reset = await fetch(`${base}/api/admin/users/${daveId}/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({}),
  })
  expect(reset.status).toBe(200)
  const body = (await reset.json()) as { password: string }
  // 临时密码与建号同款：10 位、字母数字且剔除易混淆字符 0O1lI，password 仅此一次出现
  expect(body.password).toMatch(/^[A-Za-z2-9]{10}$/)
  expect(body.password).not.toMatch(/[0O1lI]/)

  // 目标用户 flag 翻 true，用临时密码重新登录可见强制改密标记
  const reLogin = await login('dave', body.password)
  expect(reLogin.status).toBe(200)
  const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: reLogin.cookie! } })
  const meUser = (await me.json()) as { must_change_password: boolean }
  expect(meUser.must_change_password).toBe(true)
  expect(meUser).not.toHaveProperty('password')

  // 旧密码失效
  expect((await login('dave', 'pw-dave')).status).toBe(401)

  // 重置前建立的旧会话已被吊销
  expect((await fetch(`${base}/api/auth/me`, { headers: { cookie: daveCookie! } })).status).toBe(401)

  // admin 自己的会话不受影响
  expect((await fetch(`${base}/api/auth/me`, { headers: { cookie: adminCookie } })).status).toBe(200)

  // 用户不存在 404，且不泄露 password
  const missing = await fetch(`${base}/api/admin/users/${crypto.randomUUID()}/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({}),
  })
  expect(missing.status).toBe(404)
  expect((await missing.json())).not.toHaveProperty('password')
})

test('admin 重置自己:当前会话保留但 flag 翻 true,其余会话吊销,旧密码失效', async () => {
  const rootId = await insertUser('root', 'pw-root', 'admin')
  const adminCookie = (await login('root', 'pw-root')).cookie!
  // 平行会话，重置自己后必须被吊销
  const { cookie: otherCookie } = await login('root', 'pw-root')

  const reset = await fetch(`${base}/api/admin/users/${rootId}/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({}),
  })
  expect(reset.status).toBe(200)
  const { password: temp } = (await reset.json()) as { password: string }

  // 发起重置的当前会话保留（前端会凭 flag 把 admin 自己也送进强制改密页，无需后端特判）
  expect((await fetch(`${base}/api/auth/me`, { headers: { cookie: adminCookie } })).status).toBe(200)
  // 同一 admin 的其余会话被吊销
  expect((await fetch(`${base}/api/auth/me`, { headers: { cookie: otherCookie! } })).status).toBe(401)
  // 旧密码失效，临时密码可登录且 flag=true
  expect((await login('root', 'pw-root')).status).toBe(401)
  const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: (await login('root', temp)).cookie! } })
  expect(((await me.json()) as { must_change_password: boolean }).must_change_password).toBe(true)
})

test('删号:名下空间转给剩余成员(角色优先、加入最早),单人空间物理删除,admin 不接手任何内容', async () => {
  const adminId = await insertUser('root', 'pw-root', 'admin')
  const adminCookie = (await login('root', 'pw-root')).cookie!
  const victimId = await insertUser('victim', 'pw-v')
  const victimCookie = (await login('victim', 'pw-v')).cookie!
  const viewerId = await insertUser('vic-viewer', 'pw')
  const earlyId = await insertUser('early', 'pw')
  const lateId = await insertUser('late', 'pw')
  const hostId = await insertUser('host', 'pw')
  const hostCookie = (await login('host', 'pw')).cookie!
  const adminPage = await createPage(adminCookie)

  // 个人空间（POST /api/pages 惰性补建）：有一位只读成员，转给他，不再是个人空间
  const personalPage = await createPage(victimCookie)
  const personalId = (await pool.query<{ space_id: string }>('SELECT space_id FROM pages WHERE id = $1', [personalPage.page.id]))
    .rows[0]!.space_id
  // 共享空间：viewer 最早加入，其后 member early、member late，继任者是 early（角色优先，同角色看加入先后）
  const shared = (await (await fetch(`${base}/api/spaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: victimCookie },
    body: JSON.stringify({ name: 'shared' }),
  })).json()) as { id: string }
  const sharedPage = await createPage(victimCookie, { space_id: shared.id })
  // 单人空间：只有他自己，连同页面、正文、历史物理删除
  const solo = (await (await fetch(`${base}/api/spaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: victimCookie },
    body: JSON.stringify({ name: 'solo' }),
  })).json()) as { id: string }
  const soloPage = await createPage(victimCookie, { space_id: solo.id })
  const member = `INSERT INTO space_members (space_id, user_id, role, created_at) VALUES ($1, $2, $3, $4)`
  await pool.query(member, [personalId, viewerId, 'viewer', '2026-01-01 00:00:00+00'])
  await pool.query(member, [shared.id, viewerId, 'viewer', '2026-01-01 00:00:00+00'])
  await pool.query(member, [shared.id, earlyId, 'member', '2026-01-02 00:00:00+00'])
  await pool.query(member, [shared.id, lateId, 'member', '2026-01-03 00:00:00+00'])
  // 他作为成员在 host 的空间里建过页，页面改记到 host 名下
  const hostPage = await createPage(hostCookie)
  const hostSpace = (await pool.query<{ space_id: string }>('SELECT space_id FROM pages WHERE id = $1', [hostPage.page.id]))
    .rows[0]!.space_id
  await pool.query(member, [hostSpace, victimId, 'member', '2026-01-01 00:00:00+00'])
  const guestPage = await createPage(victimCookie, { space_id: hostSpace })

  // 单人空间里的正文增量与历史（删号要一起清掉）；共享空间里他署名的快照保留、署名置 NULL
  await pool.query('INSERT INTO yjs_updates (doc_name, data) VALUES ($1, $2)', [`page:${soloPage.page.id}`, Buffer.from([0, 0])])
  const snap = 'INSERT INTO page_snapshots (id, page_id, title, origin, data, author_id) VALUES ($1, $2, $3, $4, $5, $6)'
  await pool.query(snap, [crypto.randomUUID(), soloPage.page.id, 't', 'manual', Buffer.from([0, 0]), victimId])
  await pool.query(snap, [crypto.randomUUID(), sharedPage.page.id, 't', 'manual', Buffer.from([0, 0]), victimId])

  const adminSpacesBefore = (await pool.query('SELECT space_id FROM space_members WHERE user_id = $1', [adminId])).rowCount

  // 预览只给数量，与真删一致
  const impact = await fetch(`${base}/api/admin/users/${victimId}/delete-impact`, { headers: { cookie: adminCookie } })
  expect(impact.status).toBe(200)
  expect(await impact.json()).toEqual({ transferSpaces: 2, purgeSpaces: 1, purgePages: 1 })
  const userCookie = (await login('host', 'pw')).cookie!
  expect((await fetch(`${base}/api/admin/users/${victimId}/delete-impact`, { headers: { cookie: userCookie } })).status).toBe(403)
  expect((await fetch(`${base}/api/admin/users/${crypto.randomUUID()}/delete-impact`, { headers: { cookie: adminCookie } })).status).toBe(404)
  // 不存在“看某用户的空间列表”的接口
  expect((await fetch(`${base}/api/admin/users/${victimId}/spaces`, { headers: { cookie: adminCookie } })).status).toBe(404)

  const del = await fetch(`${base}/api/admin/users/${victimId}`, { method: 'DELETE', headers: { cookie: adminCookie } })
  expect(del.status).toBe(200)

  const space = async (id: string) =>
    (await pool.query<{ owner_id: string; is_personal: boolean }>('SELECT owner_id, is_personal FROM spaces WHERE id = $1', [id])).rows[0]
  const role = async (spaceId: string, userId: string) =>
    (await pool.query<{ role: string }>('SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2', [spaceId, userId])).rows[0]?.role
  const ownerOf = async (pageId: string) =>
    (await pool.query<{ owner_id: string | null }>('SELECT owner_id FROM pages WHERE id = $1', [pageId])).rows[0]?.owner_id
  expect(await space(personalId)).toEqual({ owner_id: viewerId, is_personal: false })
  expect(await role(personalId, viewerId)).toBe('owner')
  expect(await space(shared.id)).toEqual({ owner_id: earlyId, is_personal: false })
  expect(await role(shared.id, earlyId)).toBe('owner')
  expect(await role(shared.id, viewerId)).toBe('viewer')
  expect(await role(shared.id, lateId)).toBe('member')
  expect(await ownerOf(personalPage.page.id)).toBe(viewerId)
  expect(await ownerOf(sharedPage.page.id)).toBe(earlyId)
  expect(await ownerOf(guestPage.page.id)).toBe(hostId)
  expect(await ownerOf(adminPage.page.id)).toBe(adminId)

  // 单人空间：空间、页面、增量、快照都没了
  expect(await space(solo.id)).toBeUndefined()
  expect((await pool.query('SELECT 1 FROM pages WHERE id = $1', [soloPage.page.id])).rowCount).toBe(0)
  expect((await pool.query('SELECT 1 FROM yjs_updates WHERE doc_name = $1', [`page:${soloPage.page.id}`])).rowCount).toBe(0)
  expect((await pool.query('SELECT 1 FROM page_snapshots WHERE page_id = $1', [soloPage.page.id])).rowCount).toBe(0)
  const authorship = await pool.query<{ author_id: string | null }>('SELECT author_id FROM page_snapshots WHERE page_id = $1', [
    sharedPage.page.id,
  ])
  expect(authorship.rows).toEqual([{ author_id: null }])

  // admin 没有多出任何空间
  expect((await pool.query('SELECT space_id FROM space_members WHERE user_id = $1', [adminId])).rowCount).toBe(adminSpacesBefore)
  expect((await pool.query('SELECT 1 FROM spaces WHERE owner_id = $1', [adminId])).rowCount).toBe(adminSpacesBefore)

  expect((await pool.query('SELECT * FROM users WHERE id = $1', [victimId])).rowCount).toBe(0)
  expect((await pool.query('SELECT 1 FROM sessions WHERE user_id = $1', [victimId])).rowCount).toBe(0)
  expect((await login('victim', 'pw-v')).status).toBe(401)

  const self = await fetch(`${base}/api/admin/users/${adminId}`, { method: 'DELETE', headers: { cookie: adminCookie } })
  expect(self.status).toBe(400)
})

// ---------- 页面权限 ----------

test('页面列表按人隔离,admin 也只含自己是成员的空间;未登录 401', async () => {
  await insertUser('alice', 'pw-a')
  await insertUser('bob', 'pw-b')
  await insertUser('root', 'pw-root', 'admin')
  const aliceCookie = (await login('alice', 'pw-a')).cookie!
  const bobCookie = (await login('bob', 'pw-b')).cookie!
  const adminCookie = (await login('root', 'pw-root')).cookie!

  const a = await createPage(aliceCookie)
  await createPage(aliceCookie, { parent_id: a.page.id })
  await createPage(bobCookie)
  const own = await createPage(adminCookie)

  async function listIds(cookie: string): Promise<string[]> {
    const res = await fetch(`${base}/api/pages`, { headers: { cookie } })
    expect(res.status).toBe(200)
    return ((await res.json()) as { id: string }[]).map((p) => p.id)
  }
  expect((await listIds(aliceCookie)).length).toBe(2)
  expect((await listIds(bobCookie)).length).toBe(1)
  // admin 不是 alice / bob 个人空间的成员，列表里只有自己的页（@ 候选、侧栏都吃这份列表）
  expect(await listIds(adminCookie)).toEqual([own.page.id])

  const anon = await fetch(`${base}/api/pages`)
  expect(anon.status).toBe(401)
})

test('新建页面写入 owner_id', async () => {
  const aliceId = await insertUser('alice', 'pw-a')
  const aliceCookie = (await login('alice', 'pw-a')).cookie!
  const { page } = await createPage(aliceCookie)
  expect(page.owner_id).toBe(aliceId)
})

test('越权读写他人页面 404,不泄露存在性', async () => {
  await insertUser('alice', 'pw-a')
  await insertUser('bob', 'pw-b')
  await insertUser('root', 'pw-root', 'admin')
  const aliceCookie = (await login('alice', 'pw-a')).cookie!
  const bobCookie = (await login('bob', 'pw-b')).cookie!
  const { page } = await createPage(aliceCookie)

  // bob 打 alice 的页面：PATCH / DELETE 都 404（与“不存在”同响应）
  const patch = await fetch(`${base}/api/pages/${page.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: bobCookie },
    body: JSON.stringify({ title: 'hacked' }),
  })
  expect(patch.status).toBe(404)
  const del = await fetch(`${base}/api/pages/${page.id}`, { method: 'DELETE', headers: { cookie: bobCookie } })
  expect(del.status).toBe(404)
  // 页面确实没被动过
  const still = await pool.query('SELECT title FROM pages WHERE id = $1', [page.id])
  expect((still.rows[0] as { title: string }).title).toBe('')

  // admin 不是 alice 空间的成员：与 bob 同样 404，页面没被动过
  const adminCookie = (await login('root', 'pw-root')).cookie!
  for (const res of [
    await fetch(`${base}/api/pages/${page.id}`, { headers: { cookie: adminCookie } }),
    await fetch(`${base}/api/pages/${page.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ title: 'by admin' }),
    }),
    await fetch(`${base}/api/pages/${page.id}`, { method: 'DELETE', headers: { cookie: adminCookie } }),
  ]) expect(res.status).toBe(404)
  expect((await pool.query<{ title: string }>('SELECT title FROM pages WHERE id = $1', [page.id])).rows[0]!.title).toBe('')
})

test('parent_id 目标须本人可见且同空间:他人页面 400;admin 对别人的空间一样不可见', async () => {
  await insertUser('alice', 'pw-a')
  await insertUser('bob', 'pw-b')
  await insertUser('root', 'pw-root', 'admin')
  const aliceCookie = (await login('alice', 'pw-a')).cookie!
  const bobCookie = (await login('bob', 'pw-b')).cookie!
  const adminCookie = (await login('root', 'pw-root')).cookie!

  const alicePage = await createPage(aliceCookie)
  const bobPage = await createPage(bobCookie)

  // alice 把自己的页面挂到 bob 的页面下：拒绝（不可见，且跨空间）
  const res = await fetch(`${base}/api/pages/${alicePage.page.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: aliceCookie },
    body: JSON.stringify({ parent_id: bobPage.page.id }),
  })
  expect(res.status).toBe(400)
  const after = await pool.query<{ parent_id: string | null }>('SELECT parent_id FROM pages WHERE id = $1', [
    alicePage.page.id,
  ])
  expect(after.rows[0]!.parent_id).toBeNull()

  // admin 不是 alice 空间的成员：往 alice 的空间里建页 400（与空间不存在同响应），挂 alice 的页面 404（看不到）
  const alicePersonal = (
    await pool.query<{ space_id: string }>('SELECT space_id FROM pages WHERE id = $1', [alicePage.page.id])
  ).rows[0]!.space_id
  const adminInAlice = await fetch(`${base}/api/pages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ space_id: alicePersonal }),
  })
  expect(adminInAlice.status).toBe(400)
  const adminMove = await fetch(`${base}/api/pages/${alicePage.page.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ parent_id: bobPage.page.id }),
  })
  expect(adminMove.status).toBe(404)
  expect((await pool.query<{ parent_id: string | null }>('SELECT parent_id FROM pages WHERE id = $1', [alicePage.page.id])).rows[0]!.parent_id).toBeNull()
})

// ---------- ws 认证 ----------

// 裸 ws 客户端：握手头带 / 不带 cookie，再发 SyncStep1 触发 onLoadDocument
function openWs(cookie?: string): Promise<WebSocket> {
  const ws = new WebSocket(wsBase, { headers: cookie ? { cookie } : {} })
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

// provider 首条消息就是 SyncStep1；用 server 自己的 OutgoingMessage 构造，格式天然对齐
function sendSyncStep1(ws: WebSocket, docName: string): void {
  const message = new OutgoingMessage(docName)
    .createSyncMessage()
    .writeFirstSyncStepFor(new Y.Doc() as unknown as Document)
  ws.send(message.toUint8Array())
}

test('ws 无 cookie:升级被拒,握手都拿不到', async () => {
  await insertUser('alice', 'pw-a')
  const aliceCookie = (await login('alice', 'pw-a')).cookie!

  const outcome = await new Promise<string>((resolve) => {
    const ws = new WebSocket(wsBase)
    ws.on('open', () => resolve('open'))
    ws.on('error', () => resolve('error'))
    ws.on('close', () => resolve('close'))
  })
  expect(outcome).not.toBe('open')

  // 对照组：同一页面带 cookie 能打开握手
  const ok = await openWs(aliceCookie!)
  expect(ok.readyState).toBe(WebSocket.OPEN)
  ok.close()
})

test('ws 有 cookie 但页面非本人:发首条消息后被 4403 断开', async () => {
  await insertUser('alice', 'pw-a')
  await insertUser('bob', 'pw-b')
  const aliceCookie = (await login('alice', 'pw-a')).cookie!
  const bobCookie = (await login('bob', 'pw-b')).cookie!
  const { page } = await createPage(aliceCookie)

  const ws = await openWs(bobCookie!)
  // ws 包的 close 事件回调是 (code, reason),不是 CloseEvent 对象
  const closed = new Promise<number>((resolve) => ws.on('close', resolve))
  sendSyncStep1(ws, `page:${page.id}`)
  const code = await closed
  // onLoadDocument 抛错，Hocuspocus 以 Forbidden（4403）关连接，文档内容未下发
  expect(code).toBe(4403)

  // doc 名不合规（非 page:<uuid>）一律拒绝
  const ws2 = await openWs(aliceCookie!)
  const closed2 = new Promise<number>((resolve) => ws2.on('close', resolve))
  sendSyncStep1(ws2, `page:not-a-uuid`)
  expect(await closed2).toBe(4403)

  // 格式合规但页面不存在同样拒绝
  const ws3 = await openWs(aliceCookie!)
  const closed3 = new Promise<number>((resolve) => ws3.on('close', resolve))
  sendSyncStep1(ws3, `page:${crypto.randomUUID()}`)
  expect(await closed3).toBe(4403)
})

test('ws admin 不是成员一样被拒(4403),不再有救援视角', async () => {
  await insertUser('alice', 'pw-a')
  await insertUser('root', 'pw-root', 'admin')
  const aliceCookie = (await login('alice', 'pw-a')).cookie!
  const adminCookie = (await login('root', 'pw-root')).cookie!
  const { page } = await createPage(aliceCookie)

  const ws = await openWs(adminCookie!)
  const closed = new Promise<number>((resolve) => ws.on('close', resolve))
  sendSyncStep1(ws, `page:${page.id}`)
  expect(await closed).toBe(4403)
})

// ---------- setup（首启引导） ----------

async function setupStatus(): Promise<{ status: number; needed: boolean }> {
  const res = await fetch(`${base}/api/setup/status`)
  expect(res.status).toBe(200)
  return { status: res.status, needed: ((await res.json()) as { needed: boolean }).needed }
}

async function setupAdmin(body: Record<string, unknown>): Promise<{ status: number; cookie: string | null }> {
  const res = await fetch(`${base}/api/setup/admin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? null }
}

test('setup status:users 空表 true,有用户 false', async () => {
  expect((await setupStatus()).needed).toBe(true)
  await insertUser('alice', 'pw-a')
  expect((await setupStatus()).needed).toBe(false)
})

test('setup 建号 201(role=admin) + 收编孤儿页 + 直接建立会话(me 200)', async () => {
  // 孤儿页面（owner NULL，模拟存量数据）
  const orphan = crypto.randomUUID()
  await pool.query('INSERT INTO pages (id) VALUES ($1)', [orphan])

  const res = await setupAdmin({ username: 'founder', password: 'setup-pw-123' })
  expect(res.status).toBe(201)
  expect(res.cookie).toBeTruthy()

  // 直接建立会话：拿 Set-Cookie 里的会话请求 me，200 且 role=admin
  const meRes = await fetch(`${base}/api/auth/me`, { headers: { cookie: res.cookie! } })
  expect(meRes.status).toBe(200)
  const me = (await meRes.json()) as { id: string; username: string; role: string; must_change_password: boolean }
  expect(me.username).toBe('founder')
  expect(me.role).toBe('admin')
  // setup 自设密码，不触发强制改密
  expect(me.must_change_password).toBe(false)
  expect(me).not.toHaveProperty('password')

  // 孤儿页面全部收编到新建 admin 名下
  const adopted = await pool.query<{ owner_id: string }>('SELECT owner_id FROM pages WHERE id = $1', [orphan])
  expect(adopted.rows[0]!.owner_id).toBe(me.id)

  // setup 后 status 关闭
  expect((await setupStatus()).needed).toBe(false)

  // 建出的号能正常登录
  expect((await login('founder', 'setup-pw-123')).status).toBe(200)
})

test('setup:users 非空 403,不建号不动数据', async () => {
  await insertUser('alice', 'pw-a')
  await pool.query('INSERT INTO pages (id) VALUES ($1)', [crypto.randomUUID()])

  const res = await setupAdmin({ username: 'hijacker', password: 'setup-pw-123' })
  expect(res.status).toBe(403)
  expect(res.cookie).toBeNull()
  expect((await pool.query('SELECT COUNT(*)::int AS n FROM users')).rows[0]!.n).toBe(1)
  expect((await pool.query<{ owner_id: string | null }>('SELECT owner_id FROM pages')).rows[0]!.owner_id).toBeNull()
  expect((await setupStatus()).needed).toBe(false)
})

test('setup:空用户名/弱密码(<8 位)400', async () => {
  for (const body of [
    { username: 'x', password: 'short' },
    { username: 'x', password: '' },
    { username: '', password: 'long-enough' },
    { username: 'x' },
    { password: 'long-enough' },
    {},
  ]) {
    expect((await setupAdmin(body)).status, JSON.stringify(body)).toBe(400)
  }
  expect((await pool.query('SELECT COUNT(*)::int AS n FROM users')).rows[0]!.n).toBe(0)
})

test('setup 并发:同时打多个请求,只建一个 admin,其余 403', async () => {
  // 服务端事务内先取咨询锁再复查空表，并发请求被串行化：结果确定为一个 201 加其余 403
  const results = await Promise.all([
    setupAdmin({ username: 'racer1', password: 'setup-pw-123' }),
    setupAdmin({ username: 'racer2', password: 'setup-pw-123' }),
    setupAdmin({ username: 'racer3', password: 'setup-pw-123' }),
  ])
  expect(results.filter((r) => r.status === 201)).toHaveLength(1)
  for (const r of results) {
    if (r.status !== 201) expect(r.status).toBe(403)
  }
  expect((await pool.query('SELECT COUNT(*)::int AS n FROM users')).rows[0]!.n).toBe(1)
  expect((await pool.query<{ role: string }>('SELECT role FROM users')).rows[0]!.role).toBe('admin')
})

test('initDb 幂等:重复执行不炸、不重复建结构', async () => {
  await expect(initDb(pool)).resolves.toBeUndefined()
  await expect(initDb(pool)).resolves.toBeUndefined()
  const cols = await pool.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'pages' AND column_name = 'owner_id'",
  )
  expect(cols.rowCount).toBe(1)
})

