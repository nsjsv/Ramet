import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Document, OutgoingMessage } from '@hocuspocus/server'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { closePool, getPool, initDb } from './db.js'
import { startServer } from './index.js'
import { hashPassword, SESSION_COOKIE } from './auth.js'
import { truncateAll } from './test-helpers.js'

// 测试必须显式指向测试库(如 ramet_test),防止误写开发库
if (!process.env.DATABASE_URL) {
  throw new Error('需要 DATABASE_URL 指向测试库,例如 postgres://postgres:postgres@localhost:5432/ramet_test')
}

let pool = getPool()
await initDb(pool)

// 上传落盘指向独立临时目录:克隆用例要真 blob(硬链接/复制),整个文件共用,结束时清掉
const tmpUploads = mkdtempSync(join(tmpdir(), 'ramet-spaces-uploads-'))
process.env.UPLOAD_DIR = tmpUploads

// 整个文件共用一个 server,各用例自建账号
const s = await startServer(pool)
const base = `http://127.0.0.1:${s.port}`
const wsBase = `ws://127.0.0.1:${s.port}/collab`
const cleanup: (() => Promise<void> | void)[] = []

beforeEach(async () => {
  // 每个用例从空库出发;users 被 pages/sessions/spaces 外键引用,须同一语句一并清
  await truncateAll(pool)
})

afterEach(async () => {
  // ws provider 不跨用例残留:断干净,避免幽灵连接在 truncate 后重连
  for (const fn of cleanup.reverse()) {
    try {
      await fn()
    } catch {
      // 单个失败不影响其余
    }
  }
  cleanup.length = 0
})

afterAll(async () => {
  await s.close()
  await closePool()
  rmSync(tmpUploads, { recursive: true, force: true })
})

// ---------- 造数助手 ----------

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

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  expect(res.status).toBe(200)
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  if (!cookie || !cookie.startsWith(`${SESSION_COOKIE}=`)) throw new Error('登录未返回会话 cookie')
  return cookie
}

/** 建号并登录,返回 用户名 -> cookie(键名与变量名同名的用例直接解构) */
async function newUsers<K extends string>(...specs: [K, string, string?][]): Promise<Record<K, string>> {
  const out = {} as Record<K, string>
  for (const [name, pw, role] of specs) {
    await insertUser(name, pw, role)
    out[name] = await login(name, pw)
  }
  return out
}

/** 只登录(账号已存在,或要先 initDb 迁移再登录) */
async function loginAll<K extends string>(...specs: [K, string][]): Promise<Record<K, string>> {
  const out = {} as Record<K, string>
  for (const [name, pw] of specs) out[name] = await login(name, pw)
  return out
}

type SpaceBody = {
  id: string
  name: string
  owner_id: string
  is_personal: boolean
  created_at: string
  my_role: string
}

async function createSpace(cookie: string, name: string): Promise<{ status: number; body: SpaceBody }> {
  const res = await fetch(`${base}/api/spaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name }),
  })
  return { status: res.status, body: (await res.json()) as SpaceBody }
}

async function listSpaces(cookie: string): Promise<{ status: number; body: SpaceBody[] }> {
  const res = await fetch(`${base}/api/spaces`, { headers: { cookie } })
  return { status: res.status, body: (await res.json()) as SpaceBody[] }
}

type PageBody = { id: string; parent_id: string | null; owner_id: string | null; space_id: string | null }

async function createPage(cookie: string, body: Record<string, unknown> = {}): Promise<{ status: number; page: PageBody }> {
  const res = await fetch(`${base}/api/pages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return { status: res.status, page: (await res.json()) as PageBody }
}

async function patchPage(cookie: string, id: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}/api/pages/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function deletePage(cookie: string, id: string): Promise<number> {
  const res = await fetch(`${base}/api/pages/${id}`, { method: 'DELETE', headers: { cookie } })
  return res.status
}

type InviteBody = { token: string; role: 'member' | 'viewer'; created_by: string; created_at: string }

async function createInvite(
  cookie: string,
  spaceId: string,
  role: 'member' | 'viewer',
): Promise<{ status: number; body: InviteBody }> {
  const res = await fetch(`${base}/api/spaces/${spaceId}/invites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ role }),
  })
  return { status: res.status, body: (await res.json()) as InviteBody }
}

async function acceptInvite(cookie: string, token: string): Promise<{ status: number; body: { space_id: string; role: string } }> {
  const res = await fetch(`${base}/api/invites/${token}/accept`, { method: 'POST', headers: { cookie } })
  return { status: res.status, body: (await res.json()) as { space_id: string; role: string } }
}

// 以指定角色加入空间:owner 生成邀请,加入者接受
async function joinSpace(ownerCookie: string, userCookie: string, spaceId: string, role: 'member' | 'viewer') {
  const inv = await createInvite(ownerCookie, spaceId, role)
  expect(inv.status).toBe(201)
  const acc = await acceptInvite(userCookie, inv.body.token)
  expect(acc.status).toBe(200)
  return inv
}

async function memberRole(spaceId: string, userId: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ role: string }>(
    'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
    [spaceId, userId],
  )
  return rows[0]?.role
}

async function personalSpaceId(userId: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM spaces WHERE owner_id = $1 AND is_personal ORDER BY created_at, id LIMIT 1',
    [userId],
  )
  return rows[0]?.id
}

// ---------- ws 助手(同 auth.test.ts / collab.test.ts) ----------

function cookieWebSocket(cookie: string) {
  return class extends WebSocket {
    constructor(url: string) {
      super(url, { headers: { cookie } })
    }
  }
}

function connect(docName: string, doc: Y.Doc, cookie: string): HocuspocusProvider {
  // preserveConnection:false → destroy() 连底层 ws 一起断,不留幽灵连接
  const provider = new HocuspocusProvider({
    websocketProvider: new HocuspocusProviderWebsocket({
      url: wsBase,
      WebSocketPolyfill: cookieWebSocket(cookie),
    }),
    name: docName,
    document: doc,
    preserveConnection: false,
  })
  cleanup.push(() => provider.destroy())
  return provider
}

function openWs(cookie?: string): Promise<WebSocket> {
  const ws = new WebSocket(wsBase, { headers: cookie ? { cookie } : {} })
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function sendSyncStep1(ws: WebSocket, docName: string): void {
  const message = new OutgoingMessage(docName)
    .createSyncMessage()
    .writeFirstSyncStepFor(new Y.Doc() as unknown as Document)
  ws.send(message.toUint8Array())
}

test('建空间 201 + owner 成员行 + 列表可见;非法名 400;admin 列表同样只含自己参与的空间', async () => {
  const aliceId = await insertUser('alice', 'pw-a')
  await insertUser('root', 'pw-root', 'admin')
  await initDb(pool) // 迁移:给已有用户补个人空间
  const { alice, root: admin } = await loginAll(['alice', 'pw-a'], ['root', 'pw-root'])

  expect((await fetch(`${base}/api/spaces`)).status).toBe(401)

  const created = await createSpace(alice, '  项目空间  ')
  expect(created.status).toBe(201)
  expect(created.body.name).toBe('项目空间') // trim 生效
  expect(created.body.is_personal).toBe(false)
  expect(created.body.my_role).toBe('owner')

  expect(await memberRole(created.body.id, aliceId)).toBe('owner')

  // 非法名一律 400
  for (const name of ['', '   ', 'x'.repeat(51), 42, null]) {
    const res = await fetch(`${base}/api/spaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: alice },
      body: JSON.stringify({ name }),
    })
    expect(res.status, JSON.stringify(name)).toBe(400)
  }

  // 列表:个人空间(迁移建) + 新空间
  const list = await listSpaces(alice)
  expect(list.status).toBe(200)
  expect(list.body).toHaveLength(2)
  const personal = list.body.find((s) => s.is_personal)!
  expect(personal.name).toBe('alice 的空间')
  expect(personal.my_role).toBe('owner')
  expect(list.body.find((s) => s.id === created.body.id)!.my_role).toBe('owner')

  // admin 不是成员:列表同样只含自己参与的空间,alice 的空间不出现
  const adminList = await listSpaces(admin)
  expect(adminList.status).toBe(200)
  expect(adminList.body.map((s) => s.id)).not.toContain(created.body.id)
  // admin 只有迁移建的个人空间,my_role 是真实成员角色
  expect(adminList.body).toHaveLength(1)
  expect(adminList.body[0]!.is_personal).toBe(true)
  expect(adminList.body[0]!.my_role).toBe('owner')
})

test('改名:owner 200,成员 403,非成员 404,空间不存在 404', async () => {
  const aliceId = await insertUser('alice', 'pw-a')
  const bobId = await insertUser('bob', 'pw-b')
  await insertUser('dave', 'pw-d')
  const { alice, bob, dave } = await loginAll(['alice', 'pw-a'], ['bob', 'pw-b'], ['dave', 'pw-d'])

  const { body: space } = await createSpace(alice, '原名')
  await joinSpace(alice, bob, space.id, 'member') // bob 是成员但非 owner

  const ok = await fetch(`${base}/api/spaces/${space.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: alice },
    body: JSON.stringify({ name: '新名' }),
  })
  expect(ok.status).toBe(200)
  expect(((await ok.json()) as SpaceBody).name).toBe('新名')

  // 非 owner 的成员 403;完全的非成员与空间不存在同响应 404(不泄露存在性)
  for (const [cookie, status] of [[bob, 403], [dave, 404]] as const) {
    const res = await fetch(`${base}/api/spaces/${space.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'hijack' }),
    })
    expect(res.status).toBe(status)
  }
  expect((await listSpaces(alice)).body.find((s) => s.id === space.id)!.name).toBe('新名')

  const missing = await fetch(`${base}/api/spaces/${crypto.randomUUID()}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: alice },
    body: JSON.stringify({ name: 'x' }),
  })
  expect(missing.status).toBe(404)
  expect(aliceId && bobId).toBeTruthy()
})

test('删空间:个人空间 400;普通空间连带 pages + yjs 两表清空(同一事务)', async () => {
  const aliceId = await insertUser('alice', 'pw-a')
  const { alice } = await loginAll(['alice', 'pw-a'])
  await createPage(alice) // 惰性建个人空间

  const personal = await personalSpaceId(aliceId)
  const delPersonal = await fetch(`${base}/api/spaces/${personal}`, { method: 'DELETE', headers: { cookie: alice } })
  expect(delPersonal.status).toBe(400)

  // 普通空间:塞一页 + yjs 快照/增量行,删空间后三处全清
  const { body: space } = await createSpace(alice, '短命空间')
  const { page } = await createPage(alice, { space_id: space.id })
  await pool.query('INSERT INTO yjs_documents (doc_name, state) VALUES ($1, $2)', [`page:${page.id}`, '\\x00'] )
  await pool.query('INSERT INTO yjs_updates (doc_name, data) VALUES ($1, $2)', [`page:${page.id}`, '\\x00'])

  const del = await fetch(`${base}/api/spaces/${space.id}`, { method: 'DELETE', headers: { cookie: alice } })
  expect(del.status).toBe(200)
  expect(await del.json()).toEqual({})

  const pages = await pool.query('SELECT COUNT(*)::int AS n FROM pages WHERE space_id = $1', [space.id])
  expect(pages.rows[0]!.n).toBe(0)
  const docs = await pool.query('SELECT COUNT(*)::int AS n FROM yjs_documents WHERE doc_name = $1', [`page:${page.id}`])
  expect(docs.rows[0]!.n).toBe(0)
  const updates = await pool.query('SELECT COUNT(*)::int AS n FROM yjs_updates WHERE doc_name = $1', [`page:${page.id}`])
  expect(updates.rows[0]!.n).toBe(0)
  expect((await listSpaces(alice)).body.map((s) => s.id)).not.toContain(space.id)

  const again = await fetch(`${base}/api/spaces/${space.id}`, { method: 'DELETE', headers: { cookie: alice } })
  expect(again.status).toBe(404)
})

test('邀请全流程:生成→预览→接受→幂等/升降权→撤销后 404;owner 不被降权', async () => {
  const { alice, bob } = await newUsers(['alice', 'pw-a'], ['bob', 'pw-b'])

  const { body: space } = await createSpace(alice, '邀请空间')
  const memberInv = await createInvite(alice, space.id, 'member')
  const viewerInv = await createInvite(alice, space.id, 'viewer')
  expect(memberInv.status).toBe(201)
  expect(memberInv.body.role).toBe('member')
  // token 与 session 同源,randomBytes(32).hex
  expect(memberInv.body.token).toMatch(/^[0-9a-f]{64}$/)
  expect(viewerInv.body.role).toBe('viewer')

  // 邀请不合并,列表两条
  const list = await fetch(`${base}/api/spaces/${space.id}/invites`, { headers: { cookie: alice } })
  expect(list.status).toBe(200)
  expect(((await list.json()) as InviteBody[]).length).toBe(2)

  // 未登录预览 401;另一用户预览可见空间名 / 邀请人 / 角色
  expect((await fetch(`${base}/api/invites/${memberInv.body.token}`)).status).toBe(401)
  const preview = await fetch(`${base}/api/invites/${memberInv.body.token}`, { headers: { cookie: bob } })
  expect(preview.status).toBe(200)
  const pv = (await preview.json()) as {
    space_name: string
    space_id: string
    role: string
    created_by_username: string
    created_at: string
  }
  expect(pv.space_name).toBe('邀请空间')
  expect(pv.space_id).toBe(space.id)
  expect(pv.role).toBe('member')
  expect(pv.created_by_username).toBe('alice')

  const acc = await acceptInvite(bob, memberInv.body.token)
  expect(acc.status).toBe(200)
  expect(acc.body).toEqual({ space_id: space.id, role: 'member' })
  expect(await memberRole(space.id, (await pool.query('SELECT id FROM users WHERE username=$1', ['bob'])).rows[0]!.id)).toBe('member')

  // 重复接受幂等;换 viewer 邀请再接受是降权,再接受 member 是提权
  expect((await acceptInvite(bob, memberInv.body.token)).status).toBe(200)
  const down = await acceptInvite(bob, viewerInv.body.token)
  expect(down.body.role).toBe('viewer')
  const up = await acceptInvite(bob, memberInv.body.token)
  expect(up.body.role).toBe('member')

  // owner 接受自家空间的邀请也不被降权
  expect((await acceptInvite(alice, viewerInv.body.token)).body.role).toBe('owner')
  const aliceId = (await pool.query('SELECT id FROM users WHERE username=$1', ['alice'])).rows[0]!.id
  expect(await memberRole(space.id, aliceId)).toBe('owner')

  // 成员不能发/列邀请;非成员 404 不泄露
  expect((await createInvite(bob, space.id, 'viewer')).status).toBe(403)
  expect((await fetch(`${base}/api/spaces/${space.id}/invites`, { headers: { cookie: bob } })).status).toBe(403)

  // owner 可撤销;撤后预览 / 接受一律 404,再撤也 404
  const revoke = await fetch(`${base}/api/invites/${viewerInv.body.token}`, { method: 'DELETE', headers: { cookie: alice } })
  expect(revoke.status).toBe(200)
  expect((await fetch(`${base}/api/invites/${viewerInv.body.token}`, { headers: { cookie: bob } })).status).toBe(404)
  expect((await acceptInvite(bob, viewerInv.body.token)).status).toBe(404)
  expect((await fetch(`${base}/api/invites/${viewerInv.body.token}`, { method: 'DELETE', headers: { cookie: alice } })).status).toBe(404)

  const ghost = randomBytes(32).toString('hex')
  expect((await fetch(`${base}/api/invites/${ghost}`, { headers: { cookie: bob } })).status).toBe(404)
  expect((await acceptInvite(bob, ghost)).status).toBe(404)
})

test('成员管理:列表(成员可看/非成员 404)、移除他人、退群、owner 不可被动', async () => {
  const { alice, bob, carol, dave } = await newUsers(['alice', 'pw-a'], ['bob', 'pw-b'], ['carol', 'pw-c'], ['dave', 'pw-d'])

  const { body: space } = await createSpace(alice, '成员空间')
  await joinSpace(alice, bob, space.id, 'member')
  await joinSpace(alice, carol, space.id, 'viewer')
  const ids = await pool.query<{ id: string; username: string }>('SELECT id, username FROM users')

  // 成员可看列表,非成员 404 不泄露
  const list = await fetch(`${base}/api/spaces/${space.id}/members`, { headers: { cookie: bob } })
  expect(list.status).toBe(200)
  const members = (await list.json()) as { user_id: string; username: string; role: string; created_at: string }[]
  expect(members).toHaveLength(3)
  expect(members.map((m) => [m.username, m.role].join(':')).sort()).toEqual([
    'alice:owner',
    'bob:member',
    'carol:viewer',
  ])
  expect((await fetch(`${base}/api/spaces/${space.id}/members`, { headers: { cookie: dave } })).status).toBe(404)

  const uid = (u: string) => ids.rows.find((r) => r.username === u)!.id

  // 成员移除他人 403;owner 移除 viewer 200
  expect((await fetch(`${base}/api/spaces/${space.id}/members/${uid('carol')}`, { method: 'DELETE', headers: { cookie: bob } })) .status).toBe(403)
  const remove = await fetch(`${base}/api/spaces/${space.id}/members/${uid('carol')}`, {
    method: 'DELETE',
    headers: { cookie: alice },
  })
  expect(remove.status).toBe(200)
  expect(await memberRole(space.id, uid('carol'))).toBeUndefined()

  // owner 不可被移除,也不可自退(400)
  expect((await fetch(`${base}/api/spaces/${space.id}/members/${uid('alice')}`, { method: 'DELETE', headers: { cookie: alice } })) .status).toBe(400)

  // 退群:viewer 重新加入后自己移除自己 200
  await joinSpace(alice, carol, space.id, 'viewer')
  const selfExit = await fetch(`${base}/api/spaces/${space.id}/members/${uid('carol')}`, {
    method: 'DELETE',
    headers: { cookie: carol },
  })
  expect(selfExit.status).toBe(200)
  expect(await memberRole(space.id, uid('carol'))).toBeUndefined()

  // 不在空间里的人:移除 400 not a member;非成员动他人 404 不泄露
  expect((await fetch(`${base}/api/spaces/${space.id}/members/${uid('carol')}`, { method: 'DELETE', headers: { cookie: alice } })) .status).toBe(400)
  expect((await fetch(`${base}/api/spaces/${space.id}/members/${uid('bob')}`, { method: 'DELETE', headers: { cookie: dave } })) .status).toBe(404)
})

test('权限矩阵:member 可建/改/删;viewer 只读 403;非成员列表不见 + 写 404/400 不泄露', async () => {
  const { alice, bob, carol, dave } = await newUsers(['alice', 'pw-a'], ['bob', 'pw-b'], ['carol', 'pw-c'], ['dave', 'pw-d'])

  const { body: space } = await createSpace(alice, '矩阵空间')
  await joinSpace(alice, bob, space.id, 'member')
  await joinSpace(alice, carol, space.id, 'viewer')
  const { page: p1 } = await createPage(alice, { space_id: space.id })
  expect(p1.space_id).toBe(space.id)

  async function listIds(cookie: string): Promise<string[]> {
    const res = await fetch(`${base}/api/pages`, { headers: { cookie } })
    expect(res.status).toBe(200)
    return ((await res.json()) as PageBody[]).map((p) => p.id)
  }

  // member:GET 可见(行带 space_id)、可建、可改、可删自己的
  expect(await listIds(bob)).toContain(p1.id)
  const bobPage = await createPage(bob, { space_id: space.id })
  expect(bobPage.status).toBe(201)
  expect((await patchPage(bob, p1.id, { title: 'by bob' })).status).toBe(200)
  expect(await deletePage(bob, bobPage.page.id)).toBe(200)

  // viewer:GET 可见;REST 写一律 403 forbidden
  expect(await listIds(carol)).toContain(p1.id)
  expect((await createPage(carol, { space_id: space.id })).status).toBe(403)
  const carolPatch = await patchPage(carol, p1.id, { title: 'by carol' })
  expect(carolPatch.status).toBe(403)
  expect(carolPatch.body).toEqual({ error: 'forbidden' })
  expect(await deletePage(carol, p1.id)).toBe(403)
  const still = await pool.query<{ title: string }>('SELECT title FROM pages WHERE id = $1', [p1.id])
  expect(still.rows[0]!.title).toBe('by bob')

  // 非成员:列表不含;POST 到该空间与"不存在"同响应 400;PATCH/DELETE 404 不泄露存在性
  expect(await listIds(dave)).not.toContain(p1.id)
  expect((await createPage(dave, { space_id: space.id })).status).toBe(400)
  expect((await patchPage(dave, p1.id, { title: 'hacked' })).status).toBe(404)
  expect(await deletePage(dave, p1.id)).toBe(404)
})

test('非成员 ws 连空间页面:首条消息后 4403 断开', async () => {
  const { alice, dave } = await newUsers(['alice', 'pw-a'], ['dave', 'pw-d'])
  const { body: space } = await createSpace(alice, 'ws 空间')
  const { page } = await createPage(alice, { space_id: space.id })

  const ws = await openWs(dave)
  const closed = new Promise<number>((resolve) => ws.on('close', resolve))
  sendSyncStep1(ws, `page:${page.id}`)
  expect(await closed).toBe(4403)
})

test('viewer ws 只读:viewer 本地 applyUpdate 被服务端丢弃,member 端看不到', async () => {
  const { alice, bob } = await newUsers(['alice', 'pw-a'], ['bob', 'pw-b'])
  const { body: space } = await createSpace(alice, '只读空间')
  const { page } = await createPage(alice, { space_id: space.id })
  await joinSpace(alice, bob, space.id, 'viewer')

  const docName = `page:${page.id}`
  const docA = new Y.Doc()
  const docB = new Y.Doc()
  const a = connect(docName, docA, alice)
  const b = connect(docName, docB, bob)
  await vi.waitFor(() => {
    expect(a.synced).toBe(true)
    expect(b.synced).toBe(true)
  }, { timeout: 15_000, interval: 50 })

  // viewer 本地写入并发给服务端;member 同时正常写入
  docB.getText('content').insert(0, 'sneaky')
  docA.getText('content').insert(0, 'from-alice')
  // 下行链路是通的:viewer 能收到 member 的内容
  await vi.waitFor(() => {
    expect(docB.getText('content').toString()).toContain('from-alice')
  }, { timeout: 15_000, interval: 50 })
  // 上行被丢:member 端只有自己的字,viewer 的 sneaky 没出现
  expect(docA.getText('content').toString()).toBe('from-alice')

  // 重载路径:member 新连接拉到的服务端状态同样没有 sneaky
  const docC = new Y.Doc()
  const c = connect(docName, docC, alice)
  await vi.waitFor(() => {
    expect(c.synced).toBe(true)
    expect(docC.getText('content').toString()).toBe('from-alice')
  }, { timeout: 15_000, interval: 50 })
})

test('迁移:补建个人空间;有主无空间的页迁入;孤儿页不动;重复执行幂等', async () => {
  const uid = await insertUser('legacy', 'pw')
  const pageId = crypto.randomUUID()
  await pool.query('INSERT INTO pages (id, owner_id) VALUES ($1, $2)', [pageId, uid])
  const orphanId = crypto.randomUUID()
  await pool.query('INSERT INTO pages (id) VALUES ($1)', [orphanId])

  await initDb(pool)

  const personal = await personalSpaceId(uid)
  expect(personal).toBeTruthy()
  const moved = await pool.query<{ space_id: string | null }>('SELECT space_id FROM pages WHERE id = $1', [pageId])
  expect(moved.rows[0]!.space_id).toBe(personal)
  expect(await memberRole(personal!, uid)).toBe('owner')
  // 孤儿页保持 space_id / owner_id 双 NULL
  const orphan = await pool.query<{ space_id: string | null; owner_id: string | null }>(
    'SELECT space_id, owner_id FROM pages WHERE id = $1',
    [orphanId],
  )
  expect(orphan.rows[0]!.space_id).toBeNull()
  expect(orphan.rows[0]!.owner_id).toBeNull()

  // 幂等,再跑一遍不重复建
  await initDb(pool)
  const count = await pool.query('SELECT COUNT(*)::int AS n FROM spaces WHERE owner_id = $1 AND is_personal', [uid])
  expect(count.rows[0]!.n).toBe(1)
})

test('迁移 LIMIT 1:一人挂两个 is_personal 空间(存量库里可能有的状态)时 initDb 不炸,页面落到其中一个', async () => {
  const adminId = await insertUser('root2', 'pw', 'admin')
  const victimId = await insertUser('victim2', 'pw')
  await initDb(pool) // 两人各得一个个人空间
  // 模拟删号转移:受害者的个人空间连 is_personal 一起过户给 admin
  await pool.query('UPDATE spaces SET owner_id = $1 WHERE owner_id = $2', [adminId, victimId])
  const pageId = crypto.randomUUID()
  await pool.query('INSERT INTO pages (id, owner_id) VALUES ($1, $2)', [pageId, adminId])

  // 没有 ORDER BY + LIMIT 1 时,迁移第 3 步的子查询遇到双 is_personal 空间会多行报错,直接炸 initDb
  await expect(initDb(pool)).resolves.toBeUndefined()

  const moved = await pool.query<{ space_id: string | null }>('SELECT space_id FROM pages WHERE id = $1', [pageId])
  const personals = await pool.query<{ id: string }>(
    'SELECT id FROM spaces WHERE owner_id = $1 AND is_personal ORDER BY created_at, id',
    [adminId],
  )
  expect(personals.rows).toHaveLength(2)
  expect(personals.rows.map((r) => r.id)).toContain(moved.rows[0]!.space_id)
})

test('新建页面缺省落个人空间(惰性补建),行带 space_id', async () => {
  const aliceId = await insertUser('alice', 'pw-a')
  const { alice } = await loginAll(['alice', 'pw-a'])
  // insertUser 直插的用户没有个人空间,建页时惰性补建
  const { status, page } = await createPage(alice)
  expect(status).toBe(201)
  expect(page.owner_id).toBe(aliceId)
  expect(page.space_id).toBe(await personalSpaceId(aliceId))
})

test('跨空间 parent 一律 400;同空间正常挂载', async () => {
  const { alice } = await newUsers(['alice', 'pw-a'])
  const { page: personalPage } = await createPage(alice)
  const { body: space } = await createSpace(alice, '另一空间')
  const { page: spacePage } = await createPage(alice, { space_id: space.id })
  const { page: spacePage2 } = await createPage(alice, { space_id: space.id })

  expect((await createPage(alice, { space_id: space.id, parent_id: personalPage.id })).status).toBe(400)
  // PATCH 移动跨空间同样 400,库里的 parent 没动
  expect((await patchPage(alice, spacePage.id, { parent_id: personalPage.id })).status).toBe(400)
  const after = await pool.query<{ parent_id: string | null }>('SELECT parent_id FROM pages WHERE id = $1', [
    spacePage.id,
  ])
  expect(after.rows[0]!.parent_id).toBeNull()
  // 同空间挂载 200;置顶层(parent_id null)同样合法
  expect((await patchPage(alice, spacePage.id, { parent_id: spacePage2.id })).status).toBe(200)
  expect((await patchPage(alice, spacePage.id, { parent_id: null })).status).toBe(200)
  expect((await createPage(alice, { parent_id: personalPage.id })).status).toBe(201)
})

test('删号:执行删除的 admin 恰好是空间里唯一的其他成员时,按继任者规则接手(成员行提为 owner),页面保留', async () => {
  await insertUser('root', 'pw-root', 'admin')
  const victimId = await insertUser('victim', 'pw-v')
  const admin = await login('root', 'pw-root')
  const victim = await login('victim', 'pw-v')

  const { body: space } = await createSpace(victim, '受害者空间')
  await joinSpace(victim, admin, space.id, 'member') // admin 原是 member
  const { page } = await createPage(victim, { space_id: space.id })

  const del = await fetch(`${base}/api/admin/users/${victimId}`, { method: 'DELETE', headers: { cookie: admin } })
  expect(del.status).toBe(200)

  // 继任者是剩余成员里角色最高、加入最早的;这里只有 admin,他的成员行从 member 提为 owner
  const sp = await pool.query<{ owner_id: string }>('SELECT owner_id FROM spaces WHERE id = $1', [space.id])
  expect(sp.rows[0]!.owner_id).toBe((await pool.query('SELECT id FROM users WHERE username=$1', ['root'])).rows[0]!.id)
  expect(await memberRole(space.id, sp.rows[0]!.owner_id)).toBe('owner')
  // 有继任者的空间不删数据,页面归属改记到新 owner
  const pg = await pool.query<{ owner_id: string; space_id: string | null }>(
    'SELECT owner_id, space_id FROM pages WHERE id = $1',
    [page.id],
  )
  expect(pg.rows[0]!.owner_id).toBe(sp.rows[0]!.owner_id)
  expect(pg.rows[0]!.space_id).toBe(space.id)
  // 受害者会话随级联清除
  expect((await fetch(`${base}/api/auth/me`, { headers: { cookie: victim } })).status).toBe(401)
})

test('admin 不再有查看 / 克隆他人空间的接口:一律 404', async () => {
  await insertUser('alice', 'pw-a')
  await insertUser('root', 'pw-root', 'admin')
  const { alice, root } = await loginAll(['alice', 'pw-a'], ['root', 'pw-root'])
  const { body: space } = await createSpace(alice, 'alice 的空间')
  const { page } = await createPage(alice, { space_id: space.id })
  const aliceId = (await pool.query<{ id: string }>('SELECT id FROM users WHERE username = $1', ['alice'])).rows[0]!.id
  for (const [method, path] of [
    ['GET', `/api/admin/spaces/${space.id}`],
    ['GET', `/api/admin/spaces/${space.id}/pages`],
    ['POST', `/api/admin/spaces/${space.id}/clone`],
    ['POST', `/api/admin/pages/${page.id}/clone`],
    ['GET', `/api/admin/users/${aliceId}/spaces`],
  ] as const) {
    expect((await fetch(`${base}${path}`, { method, headers: { cookie: root } })).status, `${method} ${path}`).toBe(404)
  }
  expect((await pool.query('SELECT 1 FROM spaces WHERE owner_id = (SELECT id FROM users WHERE username = $1) AND NOT is_personal', ['root'])).rowCount).toBe(0)
})

