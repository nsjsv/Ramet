// ---------- connector 命令行：grant confirm / list / revoke（假中心 + 临时目录）----------
// 契约：
//   confirm  先 GET 看，终端展示后果，必须输入完全等于 yes（别的任何输入都取消，什么都不写），先写本地名单，再 POST 确认；
//            中心没确认成（4xx / 5xx / 网络断）就把刚写的本地条目删掉；其它人的条目、token / cloud / ownerId 原样保留；
//   名单文件权限 0600；发起授权的人必须是本机钉住的主人；
//   revoke   先删本机名单，再通知中心；中心通知失败也不恢复本机条目（本机删除才是安全方向）；
//   用法错误返回 2；读不到配置返回 1。
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { CONNECTOR_TOKEN_HEADER } from '../agents/protocol.js'
import type { GrantInfo } from '../agents/machine-grants.js'
import { addLocalGrant, readConnectorConfig, removeLocalGrants, writeConnectorConfig } from './access.js'
import { httpBase, runGrantCommand, type GrantIo } from './grant-cli.js'

type Call = { method: string; path: string; token: string | undefined; body: unknown }
type Center = {
  base: string
  calls: Call[]
  /** GET 看到的授权；null = 404 */
  info: GrantInfo | null
  /** POST confirm 的结果：HTTP 状态，'drop' = 直接断开连接 */
  confirm: number | 'drop'
  /** POST revoke 的结果 */
  revoke: { status: number; revoked: number }
  server: Server
}

let dir = ''
let file = ''
let center: Center
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ramet-grant-cli-'))
  file = join(dir, 'connector.json')
  const calls: Call[] = []
  const state = {
    info: null as GrantInfo | null,
    confirm: 200 as number | 'drop',
    revoke: { status: 200, revoked: 1 },
  }
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const path = req.url ?? ''
      calls.push({ method: req.method ?? '', path, token: req.headers[CONNECTOR_TOKEN_HEADER] as string | undefined, body: raw ? JSON.parse(raw) : undefined })
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.method === 'GET') return state.info ? send(200, state.info) : send(404, { error: 'grant not found' })
      if (path.endsWith('/confirm')) {
        if (state.confirm === 'drop') return void req.socket.destroy()
        return state.confirm === 200 ? send(200, state.info) : send(state.confirm, { error: 'x' })
      }
      return send(state.revoke.status, { revoked: state.revoke.revoked })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  center = {
    base: `http://127.0.0.1:${port}`,
    calls,
    server,
    get info() {
      return state.info
    },
    set info(v) {
      state.info = v
    },
    get confirm() {
      return state.confirm
    },
    set confirm(v) {
      state.confirm = v
    },
    get revoke() {
      return state.revoke
    },
    set revoke(v) {
      state.revoke = v
    },
  }
  writeConnectorConfig(file, { token: 'tok-cli', cloud: `ws://127.0.0.1:${port}`, ownerId: 'owner' })
})
afterEach(async () => {
  await new Promise<void>((resolve) => center.server.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})

const INFO: GrantInfo = {
  grantId: 'g-1',
  userId: 'u-alice',
  username: 'alice',
  scopes: ['agent', 'machine'],
  expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  grantedById: 'owner',
  grantedBy: 'mowner',
  machineName: 'box',
}

function io(answer = 'yes'): GrantIo & { lines: string[]; asked: string[] } {
  const lines: string[] = []
  const asked: string[] = []
  return {
    lines,
    asked,
    out: (line) => lines.push(line),
    ask: async (question) => {
      asked.push(question)
      return answer
    },
    fetch,
  }
}

const run = (argv: string[], i: GrantIo): Promise<number> => runGrantCommand(argv, { defaultTokenFile: file, io: i })
const grants = (): unknown[] => readConnectorConfig(file)?.grants ?? []
const posts = (suffix: string): Call[] => center.calls.filter((c) => c.method === 'POST' && c.path.endsWith(suffix))

test('confirm：展示后果 → 输入 yes → 先写本地名单（带 grantId / 用户名）→ 再通知中心确认；其余配置字段原样保留，文件权限 0600', async () => {
  center.info = INFO
  const i = io('yes')
  expect(await run(['confirm', 'ABCD-EFGH-JKLM-NPQR'], i)).toBe(0)

  const text = i.lines.join('\n')
  expect(text).toContain('alice')
  expect(text).toContain('box')
  expect(text).toContain('终端与文件')
  expect(text).toContain('agent')
  expect(text).toContain('把这台电脑交给他')
  expect(i.asked).toHaveLength(1)
  expect(i.asked[0]).toContain('yes')

  expect(grants()).toEqual([{ userId: 'u-alice', scopes: ['agent', 'machine'], expiresAt: INFO.expiresAt, grantId: 'g-1', username: 'alice' }])
  expect(readConnectorConfig(file)).toMatchObject({ token: 'tok-cli', ownerId: 'owner' })
  expect(statSync(file).mode & 0o777).toBe(0o600)
  // 顺序：先看（GET）、后确认（POST），都带 connector token，码按原样放进路径
  expect(center.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
    'GET /api/connector/grants/ABCD-EFGH-JKLM-NPQR',
    'POST /api/connector/grants/ABCD-EFGH-JKLM-NPQR/confirm',
  ])
  expect(center.calls.every((c) => c.token === 'tok-cli')).toBe(true)
  expect(i.lines.at(-1)).toContain('已授权')
})

test('只有完全等于 yes 才继续：y / YES / Yes / 带空格 / 空 / no / 回车，都取消 —— 不写名单、不通知中心', async () => {
  center.info = INFO
  for (const answer of ['y', 'YES', 'Yes', 'yes ', ' yes', 'yes\r', '', 'no', 'yes!', 'true']) {
    const i = io(answer)
    expect(await run(['confirm', 'CODE'], i), JSON.stringify(answer)).toBe(1)
    expect(i.lines.at(-1)).toContain('没有授权')
  }
  expect(grants()).toEqual([])
  expect(posts('/confirm')).toHaveLength(0)
})

test('stdin 关掉 / 没有输入时（ask 返回空串）同样取消，不会卡住也不会默认同意', async () => {
  center.info = INFO
  expect(await run(['confirm', 'CODE'], io(''))).toBe(1)
  expect(grants()).toEqual([])
})

test('码无效 / 过期 / 不属于这台机器（中心 404）：不提问、不写名单', async () => {
  center.info = null
  const i = io('yes')
  expect(await run(['confirm', 'CODE'], i)).toBe(1)
  expect(i.asked).toEqual([])
  expect(i.lines.join('\n')).toContain('确认码无效')
  expect(grants()).toEqual([])
})

test('中心没确认成就回滚本机条目：中心 500 / 404 / 断开连接；回滚只删这一条，别人的条目和配置不动', async () => {
  const old = { userId: 'u-old', scopes: ['agent' as const], expiresAt: new Date(Date.now() + 86_400_000).toISOString(), grantId: 'g-old', username: 'old' }
  addLocalGrant(file, old)
  center.info = INFO
  for (const confirm of [500, 404, 'drop'] as const) {
    center.confirm = confirm
    const i = io('yes')
    expect(await run(['confirm', 'CODE'], i), String(confirm)).toBe(1)
    expect(i.lines.join('\n')).toContain('授权没有生效')
    expect(grants(), String(confirm)).toEqual([old])
  }
  expect(readConnectorConfig(file)).toMatchObject({ token: 'tok-cli', cloud: expect.any(String), ownerId: 'owner' })
})

test('同一个人再确认一次：替换他的旧条目（一人一机一条），不留两条', async () => {
  addLocalGrant(file, { userId: 'u-alice', scopes: ['agent'], expiresAt: new Date(Date.now() + 1000).toISOString(), grantId: 'g-0', username: 'alice' })
  center.info = INFO
  expect(await run(['confirm', 'CODE'], io('yes'))).toBe(0)
  expect(grants()).toEqual([{ userId: 'u-alice', scopes: ['agent', 'machine'], expiresAt: INFO.expiresAt, grantId: 'g-1', username: 'alice' }])
})

test('发起授权的人不是本机钉住的主人 → 拒绝（不提问、不写名单、不确认）', async () => {
  center.info = { ...INFO, grantedById: 'someone-else' }
  const i = io('yes')
  expect(await run(['confirm', 'CODE'], i)).toBe(1)
  expect(i.asked).toEqual([])
  expect(i.lines.join('\n')).toContain('不是本机主人')
  expect(grants()).toEqual([])
  expect(posts('/confirm')).toHaveLength(0)
})

test('本机还没记录主人（老配置，没连上过中心）→ 没法核对发起人，同样拒绝', async () => {
  const config = readConnectorConfig(file)!
  writeConnectorConfig(file, { token: config.token, cloud: config.cloud })
  const i = io('yes')
  expect(await run(['confirm', 'CODE'], i)).toBe(1)
  expect(i.asked).toEqual([])
  expect(i.lines.join('\n')).toContain('还没有记录这台机器的主人')
  expect(grants()).toEqual([])
  expect(posts('/confirm')).toHaveLength(0)
})

test('中心返回的内容不像一条授权（缺字段 / 没有合法 scope）→ 取消', async () => {
  for (const bad of [{ ...INFO, scopes: ['root'] }, { ...INFO, scopes: [] }, { ...INFO, userId: undefined }, { ...INFO, expiresAt: 5 }]) {
    center.info = bad as unknown as GrantInfo
    const i = io('yes')
    expect(await run(['confirm', 'CODE'], i)).toBe(1)
    expect(i.asked).toEqual([])
  }
  expect(grants()).toEqual([])
})

test('list：打印本机授权名单（用户名、范围、到期；已过期的标出来）', async () => {
  addLocalGrant(file, { userId: 'u-alice', scopes: ['agent', 'machine'], expiresAt: new Date(Date.now() + 86_400_000).toISOString(), grantId: 'g-1', username: 'alice' })
  addLocalGrant(file, { userId: 'u-late', scopes: ['agent'], expiresAt: new Date(Date.now() - 86_400_000).toISOString() })
  const i = io()
  expect(await run(['list'], i)).toBe(0)
  const text = i.lines.join('\n')
  expect(text).toContain('alice')
  expect(text).toContain('agent, machine')
  expect(text).toContain('u-late')
  expect(text).toContain('已过期')
  expect(center.calls).toEqual([]) // list 只看本机，不问中心

  removeLocalGrants(file, { userId: 'u-alice' })
  removeLocalGrants(file, { userId: 'u-late' })
  const empty = io()
  await run(['list'], empty)
  expect(empty.lines.join('\n')).toContain('没有授权给任何人')
})

test('revoke：按用户名或 id 先删本机名单再通知中心；名单里没有的人也照样通知中心（可能只在中心有）', async () => {
  addLocalGrant(file, { userId: 'u-alice', scopes: ['agent'], expiresAt: new Date(Date.now() + 86_400_000).toISOString(), grantId: 'g-1', username: 'alice' })
  addLocalGrant(file, { userId: 'u-bob', scopes: ['agent'], expiresAt: new Date(Date.now() + 86_400_000).toISOString(), grantId: 'g-2', username: 'bob' })

  const byName = io()
  expect(await run(['revoke', 'alice'], byName)).toBe(0)
  expect(grants()).toEqual([expect.objectContaining({ userId: 'u-bob' })])
  expect(posts('/revoke')).toEqual([expect.objectContaining({ body: { userId: 'u-alice' }, token: 'tok-cli' })])

  expect(await run(['revoke', 'u-bob'], io())).toBe(0) // 按 id
  expect(grants()).toEqual([])
  expect(posts('/revoke').map((c) => c.body)).toEqual([{ userId: 'u-alice' }, { userId: 'u-bob' }])

  // 本机名单里没有：把参数当 userId 问中心
  center.revoke = { status: 200, revoked: 1 }
  expect(await run(['revoke', 'u-center-only'], io())).toBe(0)
  expect(posts('/revoke').at(-1)?.body).toEqual({ userId: 'u-center-only' })
  // 哪儿都没有：报没找到
  center.revoke = { status: 200, revoked: 0 }
  const none = io()
  expect(await run(['revoke', 'nobody'], none)).toBe(1)
  expect(none.lines.join('\n')).toContain('没有找到')
})

test('revoke 通知中心失败：本机名单已经删了（安全方向），提示去网页上收回，退出码 1', async () => {
  addLocalGrant(file, { userId: 'u-alice', scopes: ['agent'], expiresAt: new Date(Date.now() + 86_400_000).toISOString(), grantId: 'g-1', username: 'alice' })
  center.revoke = { status: 500, revoked: 0 }
  const i = io()
  expect(await run(['revoke', 'alice'], i)).toBe(1)
  expect(grants()).toEqual([])
  expect(i.lines.join('\n')).toContain('通知中心失败')
})

test('用法错误 → 2；读不到配置 → 1；--token-file 与 --cloud 选项生效', async () => {
  for (const argv of [[], ['confirm'], ['bogus'], ['list', 'extra'], ['revoke'], ['confirm', 'A', 'B'], ['list', '--bad'], ['list', '--token-file']]) {
    expect(await run(argv, io()), JSON.stringify(argv)).toBe(2)
  }
  const missing = io()
  expect(await runGrantCommand(['list', '--token-file', join(dir, 'nope.json')], { defaultTokenFile: file, io: missing })).toBe(1)
  expect(missing.lines.join('\n')).toContain('没有配对过')

  // --token-file 指到另一份配置；--cloud 覆盖配置里的中心地址
  const other = join(dir, 'other.json')
  writeConnectorConfig(other, { token: 'tok-other', cloud: 'ws://127.0.0.1:1', ownerId: 'owner' })
  center.info = INFO
  const i = io('yes')
  expect(await runGrantCommand(['confirm', 'CODE', '--token-file', other, '--cloud', center.base], { defaultTokenFile: file, io: i })).toBe(0)
  expect(center.calls.every((c) => c.token === 'tok-other')).toBe(true)
  expect(readConnectorConfig(other)?.grants).toHaveLength(1)
  expect(grants()).toEqual([]) // 默认那份没动

  // 配置里的中心地址坏了且没给 --cloud
  writeConnectorConfig(other, { token: 'tok-other', cloud: '', ownerId: 'owner' })
  const badCloud = io()
  expect(await runGrantCommand(['list', '--token-file', other], { defaultTokenFile: file, io: badCloud })).toBe(1)
})

test('httpBase：配置里存的是 ws(s) 源，REST 用 http(s)', () => {
  expect(httpBase('ws://127.0.0.1:3789')).toBe('http://127.0.0.1:3789')
  expect(httpBase('wss://ramet.example.com')).toBe('https://ramet.example.com')
  expect(httpBase('https://ramet.example.com/x')).toBe('https://ramet.example.com')
  expect(httpBase('http://host:80')).toBe('http://host')
})

test('addLocalGrant / removeLocalGrants：不凭空建配置文件；删光后不留空的 grants 字段；原子写不留临时文件', () => {
  const none = join(dir, 'none.json')
  expect(addLocalGrant(none, { userId: 'u', scopes: ['agent'], expiresAt: INFO.expiresAt })).toBe('no-config')
  expect(() => readFileSync(none)).toThrow()

  addLocalGrant(file, { userId: 'u1', scopes: ['agent'], expiresAt: INFO.expiresAt })
  expect(removeLocalGrants(file, { grantId: 'nope' })).toBe(0)
  expect(removeLocalGrants(file, { userId: 'u1' })).toBe(1)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ token: 'tok-cli', cloud: expect.any(String), ownerId: 'owner' })
  expect(removeLocalGrants(file, {})).toBe(0)
  expect(removeLocalGrants(join(dir, 'nope.json'), { userId: 'u1' })).toBe(0)
})
