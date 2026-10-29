// ---------- 项目面板的 REST：machine 范围的授权矩阵 + 真 connector 全链路 ----------
// 别人的机器上的文件不是公开的，读也算。每个端点（面板头 / 树 / 读文件 / 文件清单 / git 状态 / diff）验两件事：
//   1) 响应：机器主人和有 machine 授权的人 200；页面可读但没有 machine 授权的（只授权了 agent、空间 owner、全局 admin、
//      普通成员、待确认 / 过期 / 收回的授权、viewer）403；不在页面所在空间里的 404；看不到这台机器的 admin 400；
//   2) 那台机器一侧没收到该操作人的任何驱动帧，不能是回了 403 但帧其实发出去了。
// 脚本化机器（直接说协议）验证中心的判定；真 connector 验证全链路：路径约束、符号链接、第二道闸（本机名单没有此人 → 403）。
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { relativeToRoot } from './agents/project.js'
import { connectMachine, pairMachine, type Machine } from './agents/scripted-machine.js'
import {
  agentsList,
  base,
  connectorLogs,
  grantMachine,
  insertUser,
  login,
  pool,
  postJson,
  startConnector,
  waitFor,
} from './agents/test-kit.js'

process.env.RAMET_PUBLIC_URL = base

type Role =
  | 'mowner' // 机器主人（member，配对人）
  | 'sowner' // 空间 owner，不是机器主人
  | 'gadmin' // 全局 admin，加入了同一个空间
  | 'plain' // 普通 member，没授权
  | 'agentOnly' // 只有 agent 授权（可以用 agent，看不了文件）
  | 'machineOnly' // 只有 machine 授权
  | 'both' // agent + machine
  | 'pending' // machine 授权还没在机器上确认
  | 'expired' // machine 授权已过期
  | 'revoked' // machine 授权已收回
  | 'viewer' // 空间 viewer
  | 'outsider' // 不在空间里的普通用户
  | 'outadmin' // 不在空间里的全局 admin（与 outsider 同样看不到页面）

const ROLES: readonly Role[] = [
  'mowner', 'sowner', 'gadmin', 'plain', 'agentOnly', 'machineOnly', 'both', 'pending', 'expired', 'revoked', 'viewer', 'outsider', 'outadmin',
]
const ALLOWED: readonly Role[] = ['mowner', 'machineOnly', 'both']
const DENIED = ROLES.filter((r) => !ALLOWED.includes(r))

/** 每种角色该拿到的状态码：能用的 200，页面都读不了的（不在空间里的人，含全局 admin）404，其余 403 */
function want(role: Role): number {
  if (ALLOWED.includes(role)) return 200
  if (role === 'outsider' || role === 'outadmin') return 404
  return 403
}

type World = {
  spaceId: string
  pageId: string
  id: Record<Role, string>
  cookie: Record<Role, string>
  agent: string
  m: Machine
}

async function world(machineCaps?: string[]): Promise<World> {
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
  const m = await pairMachine(space.id, id.mowner, 'box', machineCaps)
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

const get = (w: World, role: Role, endpoint: string, query = ''): Promise<Response> =>
  fetch(`${base}/api/pages/${w.pageId}/project${endpoint}?agent=${encodeURIComponent(w.agent)}${query}`, { headers: { cookie: w.cookie[role] } })

/** 机器一侧收到的项目帧 */
const projectFrames = (m: Machine) => m.driven().filter((f) => ['tree', 'read', 'files', 'git-status', 'git-diff'].includes(f.t))

const ENDPOINTS: Array<[name: string, endpoint: string, query: string]> = [
  ['面板头', '', ''],
  ['文件树', '/tree', '&path='],
  ['读文件', '/read', '&path=a.txt'],
  ['文件清单', '/files', ''],
  ['git 状态', '/git-status', ''],
  ['git diff', '/git-diff', '&path=a.txt'],
]

test('授权矩阵：每个端点 × 每种角色；没有 machine 授权的人机器一侧一个帧都没收到', async () => {
  const w = await world()
  for (const [name, endpoint, query] of ENDPOINTS) {
    for (const role of [...DENIED, ...ALLOWED]) {
      const res = await get(w, role, endpoint, query)
      expect(res.status, `${name} / ${role}`).toBe(want(role))
    }
  }
  // 被拒的人机器一侧没有任何驱动帧，放行的人的帧都带着他们自己的 actor
  for (const role of DENIED) expect(w.m.by(w.id[role]), `${role} 的驱动帧`).toEqual([])
  for (const role of ALLOWED) {
    const frames = projectFrames(w.m).filter((f) => f.actor === w.id[role])
    expect(frames.map((f) => f.t).sort(), role).toEqual(['files', 'git-diff', 'git-status', 'git-status', 'read', 'tree'])
  }
  expect(w.m.driven().every((f) => ALLOWED.some((r) => f.actor === w.id[r]))).toBe(true)
  // 403 的文案告诉人找谁要授权；只授权 agent 的人同样 403（scope 互不蕴含）
  const refused = await get(w, 'agentOnly', '/tree', '&path=')
  expect(await refused.json()).toMatchObject({ error: 'forbidden', message: expect.stringContaining('mowner') })
})

test('目录里的 machine 标记：主人与 machine 授权的人为 true，只有 agent 授权的人是 false，只有 machine 授权的人看不到这个 agent', async () => {
  const w = await world()
  const flag = async (role: Role): Promise<boolean | undefined> => (await agentsList(w.cookie[role])).find((a) => a.id === w.agent)?.machine
  expect(await flag('mowner')).toBe(true)
  expect(await flag('both')).toBe(true)
  expect(await flag('agentOnly')).toBe(false)
  expect(await flag('machineOnly')).toBeUndefined() // 目录只按 agent 授权列，没授权 agent 就没有入口
  for (const role of ['plain', 'sowner', 'gadmin', 'pending', 'expired', 'revoked'] as const) {
    expect(await flag(role), role).toBeUndefined()
  }
  // 本机 agent（RAMET_LOCAL_AGENTS=1）没有项目面板
  expect((await agentsList(w.cookie.gadmin)).filter((a) => !a.id.startsWith('c:')).every((a) => a.machine === false)).toBe(true)
})

test('参数与 agent：缺 agent 400；本机 agent / 乱写的 id 不是机器上的 agent 400；别的空间的机器看不到 400', async () => {
  const w = await world()
  const bare = await fetch(`${base}/api/pages/${w.pageId}/project/tree`, { headers: { cookie: w.cookie.mowner } })
  expect(bare.status).toBe(400)
  const local = await fetch(`${base}/api/pages/${w.pageId}/project?agent=fake`, { headers: { cookie: w.cookie.mowner } })
  expect(local.status).toBe(400)
  expect(await local.json()).toMatchObject({ error: 'not a machine agent' })
  const ghost = await fetch(`${base}/api/pages/${w.pageId}/project?agent=${encodeURIComponent('c:no-such-machine:claude')}`, { headers: { cookie: w.cookie.mowner } })
  expect(ghost.status).toBe(400)
  const noAgent = await fetch(`${base}/api/pages/${w.pageId}/project?agent=${encodeURIComponent(`c:${w.m.id}:nope`)}`, { headers: { cookie: w.cookie.mowner } })
  expect(noAgent.status).toBe(400)
  const noPage = await fetch(`${base}/api/pages/no-such/project?agent=${encodeURIComponent(w.agent)}`, { headers: { cookie: w.cookie.mowner } })
  expect(noPage.status).toBe(404)
  const anon = await fetch(`${base}/api/pages/${w.pageId}/project?agent=${encodeURIComponent(w.agent)}`)
  expect(anon.status).toBe(401)
})

test('面板头：机器 / 工作区 / 分支；工作区跟页面上这个 agent 的设置走；帧里的 root 与 path 原样带给 connector', async () => {
  const w = await world()
  const head = (await (await get(w, 'mowner', '')).json()) as Record<string, unknown>
  expect(head).toMatchObject({
    machine: { id: w.m.id, name: 'box', owner: 'mowner', online: true },
    root: '/tmp',
    repo: true,
    branch: 'main',
    caps: ['project'],
    canUse: true,
  })
  // 页面上指定了别的工作区（要有 agent 授权和页面写权限才能改），root 跟着走
  await grantMachine(w.m.id, w.id.plain, { scopes: ['agent'] })
  expect((await postJson(`/api/pages/${w.pageId}/agent-cwd`, w.cookie.mowner, { agent: w.agent, cwd: '/srv/work' })).status).toBe(200)
  expect(((await (await get(w, 'both', '')).json()) as { root: string }).root).toBe('/srv/work')
  await get(w, 'both', '/tree', '&path=src%2Futil')
  await get(w, 'both', '/read', '&path=src%2Fa%20b.ts')
  const last = projectFrames(w.m).filter((f) => f.actor === w.id.both)
  expect(last.find((f) => f.t === 'tree')).toMatchObject({ root: '/srv/work', path: 'src/util' })
  expect(last.find((f) => f.t === 'read')).toMatchObject({ root: '/srv/work', path: 'src/a b.ts' })
})

test('connector 版本太旧（hello 没有 project 能力）：包括面板头在内的所有端点 409 且一个帧都没发', async () => {
  const w = await world([])
  for (const [name, endpoint, query] of ENDPOINTS) {
    const res = await get(w, 'mowner', endpoint, query)
    expect(res.status, name).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'connector outdated', message: '这台机器上的 connector 版本太旧，升级后才能用项目面板' })
  }
  expect(projectFrames(w.m)).toEqual([])
  // 授权判定在前，没授权的人看到的是 403 而不是 409
  expect((await get(w, 'plain', '/tree', '&path=')).status).toBe(403)
  expect((await get(w, 'plain', '')).status).toBe(403)
})

test('机器离线：所有端点 409 machine offline；授权判定仍在「是否在线」之前', async () => {
  const w = await world()
  w.m.ws.terminate()
  await waitFor(async () => !(await agentsList(w.cookie.mowner)).some((a) => a.id === w.agent))
  for (const [name, endpoint, query] of ENDPOINTS) {
    const res = await get(w, 'mowner', endpoint, query)
    expect(res.status, name).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'machine offline' })
  }
  expect((await get(w, 'plain', '/tree', '&path=')).status).toBe(403) // 离线不是绕过判定的缝
})

test('收回授权后立刻不能用：中心判定当场为假，机器一侧不再收到他的帧', async () => {
  const w = await world()
  expect((await get(w, 'both', '/tree', '&path=')).status).toBe(200)
  const before = projectFrames(w.m).filter((f) => f.actor === w.id.both).length
  await pool.query('UPDATE machine_grants SET revoked_at = now() WHERE connector_id = $1 AND user_id = $2', [w.m.id, w.id.both])
  for (const [name, endpoint, query] of ENDPOINTS) expect((await get(w, 'both', endpoint, query)).status, name).toBe(403)
  expect(projectFrames(w.m).filter((f) => f.actor === w.id.both).length).toBe(before)
})

test('使用记录：非主人的 打开面板 / 读文件 / 看 diff 留痕（动作之前写入），主人自己不记；树和清单只是导航不记', async () => {
  const w = await world()
  await get(w, 'mowner', '')
  await get(w, 'mowner', '/read', '&path=a.txt')
  await get(w, 'both', '')
  await get(w, 'both', '/tree', '&path=')
  await get(w, 'both', '/files')
  await get(w, 'both', '/read', '&path=src%2Fsecret.ts')
  await get(w, 'both', '/git-diff', '&path=a.txt')
  await get(w, 'plain', '/read', '&path=a.txt') // 被拒的不记
  const { rows } = await pool.query<{ user_id: string; action: string; detail: Record<string, unknown>; page_id: string }>(
    'SELECT user_id, action, detail, page_id FROM machine_usage_log WHERE connector_id = $1 ORDER BY id',
    [w.m.id],
  )
  expect(rows.map((r) => [r.user_id, r.action, r.detail.op, r.detail.path ?? null])).toEqual([
    [w.id.both, 'files', 'open', null],
    [w.id.both, 'files', 'read', 'src/secret.ts'],
    [w.id.both, 'files', 'diff', 'a.txt'],
  ])
  expect(rows.every((r) => r.page_id === w.pageId && r.detail.agent === w.agent)).toBe(true)
  // 第一次使用置 first_used_at
  const grant = await pool.query('SELECT first_used_at FROM machine_grants WHERE connector_id = $1 AND user_id = $2', [w.m.id, w.id.both])
  expect(grant.rows[0]!.first_used_at).not.toBeNull()
})

test('谁改的：本页各轮 run 记录里 agent 改过的文件标上 agent，其余不带 by（前端标「你」）', async () => {
  const w = await world()
  // 一轮 run 的过程页挂在对话页下，record.entries 里有改动类工具步骤（路径是 agent 报的绝对路径）
  const runPage = (await (await postJson('/api/pages', w.cookie.sowner, { space_id: w.spaceId, parent_id: w.pageId })).json()) as { id: string }
  await pool.query("UPDATE pages SET kind = 'run' WHERE id = $1", [runPage.id])
  const edit = (id: string, kind: string, path: string) => ({ k: 'tool', id, kind, title: 't', status: 'completed', detail: path, acp: { locations: [{ path }] } })
  await pool.query('INSERT INTO runs (page_id, record) VALUES ($1, $2)', [
    runPage.id,
    JSON.stringify({
      v: 1,
      agent: w.agent,
      parentId: w.pageId,
      replyId: 'r',
      startedAt: 0,
      outcome: 'end',
      entries: [
        edit('1', 'edit', '/tmp/a.txt'), // 工作区之内
        edit('2', 'read', '/tmp/b.txt'), // 只是读，不算改
        edit('3', 'edit', '/elsewhere/c.txt'), // 工作区之外，不相干
      ],
    }),
  ])
  const status = (await (await get(w, 'mowner', '/git-status')).json()) as { files: Array<{ path: string; mark: string; by?: string }> }
  expect(status.files).toEqual([
    { path: 'a.txt', mark: 'M', staged: false, by: w.agent },
    { path: 'b.txt', mark: '?', staged: false },
  ])
})

test('relativeToRoot：工作区之内的绝对路径换成相对路径；之外 / 前缀相近 / Windows 反斜杠', () => {
  expect(relativeToRoot('/work/app', '/work/app/src/a.ts')).toBe('src/a.ts')
  expect(relativeToRoot('/work/app/', '/work/app/a.ts')).toBe('a.ts')
  expect(relativeToRoot('/work/app', '/work/app')).toBeNull()
  expect(relativeToRoot('/work/app', '/work/apple/a.ts')).toBeNull()
  expect(relativeToRoot('/work/app', '/other/a.ts')).toBeNull()
  expect(relativeToRoot('C:\\work\\app', 'C:\\work\\app\\src\\a.ts')).toBe('src/a.ts')
  expect(relativeToRoot('', '/a.ts')).toBeNull()
})

// ---------- 真 connector：全链路 ----------

test('真 connector 全链路：树 / 读 / 清单 / git 状态与 diff；路径越界与符号链接被拒；第二道闸（本机名单）挡住中心放过的人', async () => {
  const mowner = await insertUser('mowner')
  await insertUser('sowner')
  const alice = await insertUser('alice') // 中心有 machine 授权，但本机名单里没有
  const bob = await insertUser('bob') // 中心与本机都有 machine 授权
  const cookie = { mowner: await login('mowner'), sowner: await login('sowner'), alice: await login('alice'), bob: await login('bob') }
  const space = (await (await postJson('/api/spaces', cookie.sowner, { name: 's' })).json()) as { id: string }
  for (const id of [mowner, alice, bob]) {
    await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [space.id, id, 'member'])
  }
  const page = (await (await postJson('/api/pages', cookie.sowner, { space_id: space.id })).json()) as { id: string }
  const real = await startConnector({ spaceId: space.id, ownerId: mowner, name: 'realbox', cookie: cookie.mowner })
  const agent = `c:${real}:claude`
  await grantMachine(real, alice, { scopes: ['machine'], local: false })
  await grantMachine(real, bob, { scopes: ['machine'] })

  // 工作区：一个 git 仓库，里面有改动，旁边有不该被读到的东西
  const box = mkdtempSync(join(tmpdir(), 'ramet-proj-e2e-'))
  const ws = join(box, 'ws')
  mkdirSync(join(ws, 'src'), { recursive: true })
  mkdirSync(join(box, 'outside'))
  writeFileSync(join(box, 'outside', 'secret.txt'), 'TOP SECRET')
  writeFileSync(join(ws, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(ws, 'README.md'), '# hi\n')
  symlinkSync(join(box, 'outside'), join(ws, 'escape'))
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  const git = (...args: string[]): void => void execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: ws, env })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  writeFileSync(join(ws, 'src', 'a.ts'), 'export const a = 2\n')
  writeFileSync(join(ws, 'src', 'new.ts'), 'export const n = 1\n')
  chmodSync(ws, 0o755)
  expect((await postJson(`/api/pages/${page.id}/agent-cwd`, cookie.mowner, { agent, cwd: ws })).status).toBe(200)

  const url = (endpoint: string, query: string): string => `${base}/api/pages/${page.id}/project${endpoint}?agent=${encodeURIComponent(agent)}${query}`
  const call = (who: keyof typeof cookie, endpoint: string, query = ''): Promise<Response> => fetch(url(endpoint, query), { headers: { cookie: cookie[who] } })
  const json = async (res: Response): Promise<Record<string, any>> => (await res.json()) as Record<string, any>

  for (const who of ['mowner', 'bob'] as const) {
    const head = await json(await call(who, ''))
    expect(head, who).toMatchObject({ machine: { name: 'realbox', online: true }, root: ws, repo: true, branch: 'main', caps: expect.arrayContaining(['project']) })

    const tree = await json(await call(who, '/tree', '&path='))
    expect(tree.entries.map((e: { name: string }) => e.name)).toEqual(['src', 'escape', 'README.md'])
    expect(tree.entries.find((e: { name: string }) => e.name === 'escape')).toEqual({ name: 'escape', type: 'link' })
    expect(tree.entries.find((e: { name: string }) => e.name === 'src')).toMatchObject({ type: 'dir', git: 'M' })
    const sub = await json(await call(who, '/tree', '&path=src'))
    expect(sub.entries).toMatchObject([{ name: 'a.ts', type: 'file', git: 'M' }, { name: 'new.ts', type: 'file', git: '?' }])

    expect(await json(await call(who, '/read', '&path=src%2Fa.ts'))).toMatchObject({ path: 'src/a.ts', text: 'export const a = 2\n', binary: false, truncated: false })
    const files = await json(await call(who, '/files'))
    expect([...files.files].sort()).toEqual(['README.md', 'escape', 'src/a.ts', 'src/new.ts'])

    const status = await json(await call(who, '/git-status'))
    expect(status).toMatchObject({ repo: true, branch: 'main' })
    expect(status.files.map((f: { path: string; mark: string }) => `${f.mark} ${f.path}`).sort()).toEqual(['? src/new.ts', 'M src/a.ts'])
    expect((await json(await call(who, '/git-diff', '&path=src%2Fa.ts'))).diff).toContain('+export const a = 2')
    expect((await json(await call(who, '/git-diff', '&path=src%2Fnew.ts'))).diff).toContain('+export const n = 1')
  }

  // 路径越界：被授权的人也一样，connector 不信中心的路径
  for (const who of ['mowner', 'bob'] as const) {
    for (const path of ['..%2Foutside%2Fsecret.txt', '%2Fetc%2Fpasswd', 'escape%2Fsecret.txt', 'escape', 'src%2F..%2F..%2Foutside', 'missing.txt', 'src%00a']) {
      for (const endpoint of ['/read', '/tree', '/git-diff']) {
        const res = await call(who, endpoint, `&path=${path}`)
        expect(res.status, `${who} ${endpoint} ${path}`).toBe(400)
        expect(JSON.stringify(await res.json())).not.toContain('TOP SECRET')
      }
    }
  }

  // 第二道闸：alice 在中心有 machine 授权但本机名单里没有，connector 拒绝，中心回 403
  for (const [endpoint, query] of [['/tree', '&path='], ['/read', '&path=README.md'], ['/files', ''], ['/git-status', ''], ['/git-diff', '&path=README.md']] as const) {
    const res = await call('alice', endpoint, query)
    expect(res.status, endpoint).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'forbidden', message: expect.stringContaining('不允许你使用') })
  }
  expect(connectorLogs(real).filter((l) => /^拒绝 (tree|read|files|git-status|git-diff)/.test(l)).length).toBeGreaterThanOrEqual(5)

  // 工作区目录本身有问题（被删了）：面板头 200 带 error（面板照样画），数据端点 400
  expect((await postJson(`/api/pages/${page.id}/agent-cwd`, cookie.mowner, { agent, cwd: join(box, 'deleted-ws') })).status).toBe(200)
  const broken = await call('mowner', '')
  expect(broken.status).toBe(200)
  expect(await json(broken)).toMatchObject({ root: join(box, 'deleted-ws'), repo: false, branch: null, error: '工作区目录不存在或不可访问' })
  const brokenTree = await call('mowner', '/tree', '&path=')
  expect(brokenTree.status).toBe(400)
  expect(await json(brokenTree)).toMatchObject({ error: 'project failed', message: '工作区目录不存在或不可访问' })

  // 只有 agent 授权的人在中心就过不了
  const carol = await insertUser('carol')
  await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [space.id, carol, 'member'])
  await grantMachine(real, carol, { scopes: ['agent'] })
  const carolRes = await fetch(url('/read', '&path=README.md'), { headers: { cookie: await login('carol') } })
  expect(carolRes.status).toBe(403)
})

test('connector 重连后能力仍在（hello 每次都带 caps），sanity：重复连接不丢 project 能力', async () => {
  const mowner = await insertUser('mowner')
  const cookie = await login('mowner')
  const space = (await (await postJson('/api/spaces', cookie, { name: 's' })).json()) as { id: string }
  const page = (await (await postJson('/api/pages', cookie, { space_id: space.id })).json()) as { id: string }
  const m = await pairMachine(space.id, mowner, 'again')
  const agent = `c:${m.id}:claude`
  await waitFor(async () => (await agentsList(cookie)).some((a) => a.id === agent))
  m.ws.terminate()
  await waitFor(async () => !(await agentsList(cookie)).some((a) => a.id === agent))
  const again = await connectMachine({ id: m.id, name: 'again', token: m.token })
  await waitFor(async () => (await agentsList(cookie)).some((a) => a.id === agent))
  const res = await fetch(`${base}/api/pages/${page.id}/project/tree?agent=${encodeURIComponent(agent)}&path=`, { headers: { cookie } })
  expect(res.status).toBe(200)
  expect(again.of('welcome')).toHaveLength(1)
})

// ---------- 写文件（POST /project/write）：machine 范围 + 页面可写 + 留痕 ----------
// 只读端点的矩阵之外再加两条：viewer（哪怕有 machine 授权）403，老 connector（没有 write 能力）409 且不发帧。
// 重点仍是被拒的人机器一侧一个 write 帧都没收到。

const WRITE_CAPS = ['project', 'write']
const BASE_HASH = 'c'.repeat(64)

const writeUrl = (w: World): string => `/api/pages/${w.pageId}/project/write?agent=${encodeURIComponent(w.agent)}`
const putFile = (w: World, cookie: string, body: Record<string, unknown> = { path: 'a.txt', baseHash: BASE_HASH, content: 'new content' }): Promise<Response> =>
  postJson(writeUrl(w), cookie, body)
const writeFrames = (m: Machine) => m.of('write')

test('写文件授权矩阵：每种角色（含有 machine 授权的 viewer）；被拒的人机器一侧没收到任何 write 帧，放行的人帧里 root / path / baseHash / content 原样', async () => {
  const w = await world(WRITE_CAPS)
  // viewer 即使有 machine 授权也不能写，页面不可写
  const viewerM = await insertUser('viewerM')
  await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [w.spaceId, viewerM, 'viewer'])
  await grantMachine(w.m.id, viewerM, { scopes: ['machine', 'agent'] })
  const cookieM = await login('viewerM')

  for (const role of ROLES) {
    const res = await putFile(w, w.cookie[role])
    const expected = role === 'viewer' ? 403 : want(role)
    expect(res.status, role).toBe(expected)
    if (expected === 200) expect(await res.json(), role).toMatchObject({ path: 'a.txt', hash: 'b'.repeat(64) })
  }
  const asViewerM = await putFile(w, cookieM)
  expect(asViewerM.status).toBe(403)
  expect(await asViewerM.json()).toMatchObject({ error: 'forbidden', message: expect.stringContaining('只读') })
  expect((await fetch(`${base}${writeUrl(w)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)

  for (const role of DENIED) expect(writeFrames(w.m).filter((f) => f.actor === w.id[role]), `${role} 的 write 帧`).toEqual([])
  expect(writeFrames(w.m).filter((f) => f.actor === viewerM)).toEqual([])
  // 放行的人每人一帧，带着自己的 actor
  expect(writeFrames(w.m).map((f) => f.actor).sort()).toEqual(ALLOWED.map((r) => w.id[r]).sort())
  expect(writeFrames(w.m)[0]).toMatchObject({ t: 'write', root: '/tmp', path: 'a.txt', baseHash: BASE_HASH, content: 'new content' })
  // 只授权 agent 的人 403（scope 互不蕴含），文案带主人名
  const refused = await putFile(w, w.cookie.agentOnly)
  expect(await refused.json()).toMatchObject({ error: 'forbidden', message: expect.stringContaining('mowner') })
})

test('写文件：收回授权后立刻不能写；机器离线 409', async () => {
  const w = await world(WRITE_CAPS)
  expect((await putFile(w, w.cookie.both)).status).toBe(200)
  await pool.query('UPDATE machine_grants SET revoked_at = now() WHERE connector_id = $1 AND user_id = $2', [w.m.id, w.id.both])
  expect((await putFile(w, w.cookie.both)).status).toBe(403)
  expect(writeFrames(w.m).filter((f) => f.actor === w.id.both)).toHaveLength(1)

  w.m.ws.terminate()
  await waitFor(async () => !(await agentsList(w.cookie.mowner)).some((a) => a.id === w.agent))
  const offline = await putFile(w, w.cookie.mowner)
  expect(offline.status).toBe(409)
  expect(await offline.json()).toMatchObject({ error: 'machine offline' })
  expect((await putFile(w, w.cookie.plain)).status).toBe(403) // 离线不是绕过判定的缝
})

test('写文件：有项目面板、没有 write 能力的老 connector 409 connector outdated 且不发帧，授权判定仍在前', async () => {
  const old = await world(['project'])
  const res = await putFile(old, old.cookie.mowner)
  expect(res.status).toBe(409)
  expect(await res.json()).toMatchObject({ error: 'connector outdated', message: expect.stringContaining('升级') })
  expect(writeFrames(old.m)).toEqual([])
  expect((await putFile(old, old.cookie.plain)).status).toBe(403)
  expect((await putFile(old, old.cookie.viewer)).status).toBe(403)
})

test('写文件：参数不对 400、超过 1MB 413（都不发帧）；文件已被改动（connector 回 conflict）409 conflict', async () => {
  const w = await world(WRITE_CAPS)
  for (const body of [{}, { path: 'a.txt' }, { path: '', baseHash: BASE_HASH, content: 'x' }, { path: 5, baseHash: BASE_HASH, content: 'x' }, { path: 'a.txt', baseHash: 5, content: 'x' }, { path: 'a.txt', baseHash: BASE_HASH, content: 5 }]) {
    expect((await putFile(w, w.cookie.mowner, body)).status, JSON.stringify(body)).toBe(400)
  }
  expect((await fetch(`${base}${writeUrl(w)}`, { method: 'POST', headers: { cookie: w.cookie.mowner, 'content-type': 'application/json' }, body: 'not json' })).status).toBe(400)
  expect((await putFile(w, w.cookie.mowner, { path: 'a.txt', baseHash: BASE_HASH, content: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413)
  expect((await putFile(w, w.cookie.mowner, { path: 'a.txt', baseHash: BASE_HASH, content: 'x'.repeat(3 * 1024 * 1024) })).status).toBe(413)
  expect(writeFrames(w.m)).toEqual([])
  expect((await putFile(w, w.cookie.mowner, { path: 'a.txt', baseHash: BASE_HASH, content: 'x'.repeat(1024 * 1024) })).status).toBe(200) // 恰好 1MB 放行

  w.m.writeConflict = true
  const conflict = await putFile(w, w.cookie.mowner)
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({ error: 'conflict', message: '文件已被改动，请重新打开' })
})

test('写文件使用记录：非主人先留痕（action write，只记路径不记内容）再发帧，主人自己不记，被拒的不记', async () => {
  const w = await world(WRITE_CAPS)
  await putFile(w, w.cookie.mowner)
  await putFile(w, w.cookie.both, { path: 'src/secret.ts', baseHash: BASE_HASH, content: 'TOP-SECRET-CONTENT' })
  await putFile(w, w.cookie.plain)
  await putFile(w, w.cookie.viewer)
  const { rows } = await pool.query<{ user_id: string; action: string; detail: Record<string, unknown>; page_id: string }>(
    'SELECT user_id, action, detail, page_id FROM machine_usage_log WHERE connector_id = $1 ORDER BY id',
    [w.m.id],
  )
  expect(rows.map((r) => [r.user_id, r.action, r.detail.op, r.detail.path])).toEqual([[w.id.both, 'write', 'write', 'src/secret.ts']])
  expect(rows[0]!.page_id).toBe(w.pageId)
  expect(JSON.stringify(rows)).not.toContain('TOP-SECRET-CONTENT')
})

test('quick_writes：写成功记一行；git-status 的 by：随手 AI 比 agent 那一轮更近标 quick、更早则仍是 agent；别的工作区 / 没写过的文件不受影响', async () => {
  const w = await world(WRITE_CAPS)
  const status = async (): Promise<Record<string, string | undefined>> => {
    const body = (await (await get(w, 'mowner', '/git-status')).json()) as { files: Array<{ path: string; by?: string }> }
    return Object.fromEntries(body.files.map((f) => [f.path, f.by]))
  }
  expect(await status()).toEqual({ 'a.txt': undefined, 'b.txt': undefined })

  expect((await putFile(w, w.cookie.both)).status).toBe(200)
  const rows = await pool.query<{ connector_id: string; root: string; path: string; user_id: string; page_id: string }>('SELECT * FROM quick_writes')
  expect(rows.rows).toHaveLength(1)
  expect(rows.rows[0]).toMatchObject({ connector_id: w.m.id, root: '/tmp', path: 'a.txt', user_id: w.id.both, page_id: w.pageId })
  expect(await status()).toEqual({ 'a.txt': 'quick', 'b.txt': undefined })

  // agent 在这之后又改了 a.txt（一轮 run 的过程页，创建时间比写入晚），归 agent
  const runPage = (await (await postJson('/api/pages', w.cookie.sowner, { space_id: w.spaceId, parent_id: w.pageId })).json()) as { id: string }
  await pool.query("UPDATE pages SET kind = 'run' WHERE id = $1", [runPage.id])
  await pool.query('INSERT INTO runs (page_id, record) VALUES ($1, $2)', [
    runPage.id,
    JSON.stringify({
      v: 1, agent: w.agent, parentId: w.pageId, replyId: 'r', startedAt: 0, outcome: 'end',
      entries: [{ k: 'tool', id: '1', kind: 'edit', title: 't', status: 'completed', detail: '/tmp/a.txt', acp: { locations: [{ path: '/tmp/a.txt' }] } }],
    }),
  ])
  await pool.query("UPDATE quick_writes SET at = now() - interval '1 hour'")
  expect(await status()).toEqual({ 'a.txt': w.agent, 'b.txt': undefined })
  // 随手 AI 又写了一次（比 agent 更近），回到 quick
  await pool.query("UPDATE quick_writes SET at = now() + interval '1 hour'")
  expect(await status()).toEqual({ 'a.txt': 'quick', 'b.txt': undefined })
  // 页面上换了工作区，同一个相对路径是另一个文件，不算随手 AI 写的
  await grantMachine(w.m.id, w.id.plain, { scopes: ['agent'] })
  expect((await postJson(`/api/pages/${w.pageId}/agent-cwd`, w.cookie.mowner, { agent: w.agent, cwd: '/srv/other' })).status).toBe(200)
  expect((await status())['a.txt']).toBeUndefined()
  // 页面物理删除时记录跟着级联清掉
  await pool.query('DELETE FROM pages WHERE id = $1 OR parent_id = $1', [w.pageId])
  expect((await pool.query('SELECT 1 FROM quick_writes')).rowCount).toBe(0)
})

test('真 connector 写文件全链路：落盘与新 hash；读到之后文件被改过 409；本机名单里没有的人 403 且文件不动；越界 400；viewer 403', async () => {
  const mowner = await insertUser('mowner')
  const sowner = await insertUser('sowner')
  const alice = await insertUser('alice') // 中心有 machine 授权，本机名单里没有
  const bob = await insertUser('bob') // 中心与本机都有 machine 授权
  const vic = await insertUser('vic') // viewer，中心与本机都有 machine 授权
  const cookie = { mowner: await login('mowner'), sowner: await login('sowner'), alice: await login('alice'), bob: await login('bob'), vic: await login('vic') }
  const space = (await (await postJson('/api/spaces', cookie.sowner, { name: 's' })).json()) as { id: string }
  for (const [id, role] of [[mowner, 'member'], [alice, 'member'], [bob, 'member'], [vic, 'viewer']] as const) {
    await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [space.id, id, role])
  }
  void sowner
  const page = (await (await postJson('/api/pages', cookie.sowner, { space_id: space.id })).json()) as { id: string }
  const real = await startConnector({ spaceId: space.id, ownerId: mowner, name: 'realbox', cookie: cookie.mowner })
  const agent = `c:${real}:claude`
  await grantMachine(real, alice, { scopes: ['machine'], local: false })
  await grantMachine(real, bob, { scopes: ['machine'] })
  await grantMachine(real, vic, { scopes: ['machine'] })

  const box = mkdtempSync(join(tmpdir(), 'ramet-proj-write-'))
  const ws = join(box, 'ws')
  mkdirSync(join(ws, 'src'), { recursive: true })
  mkdirSync(join(box, 'outside'))
  writeFileSync(join(box, 'outside', 'secret.txt'), 'TOP SECRET')
  writeFileSync(join(ws, 'src', 'a.ts'), 'export const a = 1\n')
  symlinkSync(join(box, 'outside', 'secret.txt'), join(ws, 'escape.txt'))
  expect((await postJson(`/api/pages/${page.id}/agent-cwd`, cookie.mowner, { agent, cwd: ws })).status).toBe(200)

  const q = `?agent=${encodeURIComponent(agent)}`
  const read = async (who: keyof typeof cookie, path: string): Promise<{ hash: string; text: string }> =>
    (await (await fetch(`${base}/api/pages/${page.id}/project/read${q}&path=${encodeURIComponent(path)}`, { headers: { cookie: cookie[who] } })).json()) as { hash: string; text: string }
  const put = (who: keyof typeof cookie, body: Record<string, unknown>): Promise<Response> => postJson(`/api/pages/${page.id}/project/write${q}`, cookie[who], body)
  const disk = (rel: string): string => readFileSync(join(ws, rel), 'utf8')

  // 主人与 bob：读到 hash 后写，落盘，返回的 hash 就是再读到的 hash
  for (const who of ['mowner', 'bob'] as const) {
    const before = await read(who, 'src/a.ts')
    expect(before.hash).toMatch(/^[0-9a-f]{64}$/)
    const res = await put(who, { path: 'src/a.ts', baseHash: before.hash, content: `export const a = '${who}'\n` })
    expect(res.status, who).toBe(200)
    const done = (await res.json()) as { path: string; hash: string }
    expect(done.path).toBe('src/a.ts')
    expect(disk('src/a.ts')).toBe(`export const a = '${who}'\n`)
    expect((await read(who, 'src/a.ts')).hash).toBe(done.hash)
  }

  // 读到之后文件被改过，409 conflict，文件保持别人改的那一版
  const stale = await read('bob', 'src/a.ts')
  writeFileSync(join(ws, 'src', 'a.ts'), 'changed by someone else\n')
  const conflict = await put('bob', { path: 'src/a.ts', baseHash: stale.hash, content: 'mine\n' })
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({ error: 'conflict', message: '文件已被改动，请重新打开' })
  expect(disk('src/a.ts')).toBe('changed by someone else\n')

  // 第二道闸：alice 在中心有 machine 授权但本机名单里没有，connector 拒绝
  const fresh = await read('bob', 'src/a.ts')
  const second = await put('alice', { path: 'src/a.ts', baseHash: fresh.hash, content: 'PWNED\n' })
  expect(second.status).toBe(403)
  expect(await second.json()).toMatchObject({ error: 'forbidden', message: expect.stringContaining('不允许你使用') })
  expect(connectorLogs(real).filter((l) => l.startsWith('拒绝 write')).length).toBe(1)
  // viewer 在中心就被拦了（页面不可写），connector 日志不会多一行
  expect((await put('vic', { path: 'src/a.ts', baseHash: fresh.hash, content: 'PWNED\n' })).status).toBe(403)
  expect(connectorLogs(real).filter((l) => l.startsWith('拒绝 write')).length).toBe(1)
  expect(disk('src/a.ts')).toBe('changed by someone else\n')

  // 路径越界：被授权的人也一样，connector 不信中心的路径，root 外的文件不动
  for (const path of ['../outside/secret.txt', '/etc/passwd', 'escape.txt', 'src/../../outside/secret.txt', 'missing.txt', 'src/new.ts', 'src/a.ts\0']) {
    for (const who of ['mowner', 'bob'] as const) {
      const res = await put(who, { path, baseHash: BASE_HASH, content: 'PWNED' })
      expect(res.status, `${who} ${JSON.stringify(path)}`).toBe(400)
    }
  }
  expect(readFileSync(join(box, 'outside', 'secret.txt'), 'utf8')).toBe('TOP SECRET')
  expect(existsSync(join(ws, 'src', 'new.ts'))).toBe(false)
  expect(existsSync(join(ws, 'missing.txt'))).toBe(false)

  // 非主人写过的留痕，写成功的记进 quick_writes，失败的没有
  const log = await pool.query<{ user_id: string; detail: { path?: string } }>("SELECT user_id, detail FROM machine_usage_log WHERE connector_id = $1 AND action = 'write' ORDER BY id", [real])
  expect(log.rows.map((r) => [r.user_id, r.detail.path])).toContainEqual([bob, 'src/a.ts'])
  const qw = await pool.query<{ user_id: string; path: string }>('SELECT user_id, path FROM quick_writes WHERE page_id = $1 ORDER BY id', [page.id])
  expect(qw.rows).toEqual([{ user_id: mowner, path: 'src/a.ts' }, { user_id: bob, path: 'src/a.ts' }])
})
