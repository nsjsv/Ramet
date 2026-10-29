// ---------- 本地 connector 集成测试 ----------
// 链路：建好身份（token，配对流程本身见 connect-pair.test.ts）→ connector 出站连中心 → 上报本机 agent → catalog 出现该 agent →
// 「继续」经 WSS 下发到 connector 本机执行（fake-agent.mjs）→ 事件回传 → 文档流式追加。
// 假 agent 与断言套路同 agents.test.ts（助手在本文件内自带一份）。
//
// 覆盖：token 撤销失效、复合 id 解析、Hub 断线收尾、relay 全链路、权限往返、
// 中心重启后续上同一块、connector 真死收尸。排在「中心重启」之后的用例会关掉中心，必须留在文件末尾。

import { afterAll, afterEach, expect, test } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import { WebSocket } from 'ws'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { getPool, initDb, closePool } from './db.js'
import { startServer } from './index.js'
import { hashPassword } from './auth.js'
import { serializeDoc } from './agents/doc.js'
import { connectorByToken } from './agents/connectors.js'
import { decodeStats } from '@ramet/shared/reply-stats'
import { ConnectorHub } from './agents/hub.js'
import { assertCanUse } from './agents/machine-access.js'
import { parseRemoteId } from './agents/manager-types.js'
import { runConnector } from './connector/index.js'
import { cloudOrigin } from './connector/pair.js'
import type { AgentEvent } from './agents/types.js'
import { provisionConnector, truncateAll } from './test-helpers.js'

if (!process.env.DATABASE_URL) {
  throw new Error('需要 DATABASE_URL 指向测试库,例如 postgres://postgres:postgres@localhost:5432/ramet_test')
}

const FAKE_AGENT = fileURLToPath(new URL('./agents/fake-agent.mjs', import.meta.url))
const CONNECTOR_CLI = fileURLToPath(new URL('./connector/cli.ts', import.meta.url))
process.env.RAMET_AGENTS = JSON.stringify([{ id: 'fake', label: 'Fake', command: process.execPath, args: [FAKE_AGENT] }])

const pool = getPool()
// 凭据只能由 assertCanUse 签出：桩库对「能不能用」一律答能，授权判定本身在 machine-access.test.ts 测
const allowPool = { query: async () => ({ rowCount: 1, rows: [] }) } as unknown as import('pg').Pool
await initDb(pool)
const s = await startServer(pool)
const base = `http://127.0.0.1:${s.port}`
// 「中心重启」会关掉 s。排在它后面的用例经 center 认当前这个端口上的进程。
let center: { port: number; close: () => Promise<void> } = s
// connector 用例：中心对外地址必须显式给（connector 没有回环回落，同生产行为）
process.env.RAMET_PUBLIC_URL = base

const stops: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  await truncateAll(pool)
})
afterAll(async () => {
  await s.close()
  await closePool()
})

type AgentListItem = { id: string; label: string }

// ---------- 助手 ----------

/** 轮询等待。这里对真实服务/数据库轮询：状态不在单一 promise 上（HTTP 端点、库、进程间消息），
 * 确定性时钟控制不适用，短睡眠是必要的（同 agents.test.ts）。 */
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await pred()) return
    if (Date.now() > deadline) throw new Error('等待状态超时')
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function insertUser(username: string): Promise<string> {
  const id = randomUUID()
  await pool.query('INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)', [
    id, username, hashPassword('pw-123456'), 'user',
  ])
  return id
}

async function login(username: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'pw-123456' }),
  })
  expect(res.status).toBe(200)
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('登录未返回会话 cookie')
  return cookie
}

async function setupPage(): Promise<{ cookie: string; pageId: string; spaceId: string; userId: string }> {
  // 用户名按用例唯一：既有测试文件在 beforeEach 里清库、结束时留行，同名会撞唯一约束
  const username = `conn-${randomUUID().slice(0, 8)}`
  const userId = await insertUser(username)
  const cookie = await login(username)
  const space = (await (
    await fetch(`${base}/api/spaces`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 's' }),
    })
  ).json()) as { id: string }
  const page = (await (
    await fetch(`${base}/api/pages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ space_id: space.id }),
    })
  ).json()) as { id: string }
  return { cookie, pageId: page.id, spaceId: space.id, userId }
}

async function agentsList(cookie: string): Promise<AgentListItem[]> {
  return (await (await fetch(`${base}/api/agents`, { headers: { cookie } })).json()) as AgentListItem[]
}

async function connectDoc(pageId: string, cookie: string): Promise<HocuspocusProvider> {
  const wsProvider = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${s.port}/collab`,
    WebSocketPolyfill: class extends WebSocket {
      constructor(url: string) {
        super(url, undefined, { headers: { cookie } })
      }
    } as unknown as typeof WebSocket,
    quiet: true,
  })
  const provider = new HocuspocusProvider({
    websocketProvider: wsProvider,
    name: `page:${pageId}`,
    token: 'test',
    quiet: true,
  })
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('provider 同步超时')), 10_000)
    provider.on('synced', () => {
      clearTimeout(t)
      resolve()
    })
  })
  return provider
}

function docText(provider: HocuspocusProvider): string {
  return serializeDoc(provider.document.getXmlFragment('prosemirror'))
}

/** 连 control:global 信令文档（无内容）：收服务端 stateless 广播（'changed' / 'agents'）。
 *  前端就靠 'agents' 失效 agent 目录缓存，别退化成"刷新网页才看见" */
async function connectControl(cookie: string, onStateless: (payload: string) => void): Promise<HocuspocusProvider> {
  const wsProvider = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${s.port}/collab`,
    WebSocketPolyfill: class extends WebSocket {
      constructor(url: string) {
        super(url, undefined, { headers: { cookie } })
      }
    } as unknown as typeof WebSocket,
    quiet: true,
  })
  const provider = new HocuspocusProvider({
    websocketProvider: wsProvider,
    name: 'control:global',
    token: 'test',
    quiet: true,
    onStateless: ({ payload }) => onStateless(payload),
  })
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('control provider 同步超时')), 10_000)
    provider.on('synced', () => {
      clearTimeout(t)
      resolve()
    })
  })
  return provider
}

function userMessage(doc: Y.Doc, text: string): void {
  const frag = doc.getXmlFragment('prosemirror')
  const msg = new Y.XmlElement('user_message')
  const p = new Y.XmlElement('paragraph')
  const t = new Y.XmlText()
  t.insert(0, text)
  p.insert(0, [t])
  msg.insert(0, [p])
  frag.insert(frag.length, [msg])
}

async function agentSessionKeys(pageId: string): Promise<string[]> {
  const { rows } = await pool.query<{ agent_session: { sessions?: Record<string, unknown> } | null }>(
    'SELECT agent_session FROM pages WHERE id = $1',
    [pageId],
  )
  return Object.keys(rows[0]?.agent_session?.sessions ?? {})
}

async function post(path: string, cookie: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
}

/** 起一条 connector（进程内，直接建好身份 → 常驻），返回 connectorId。
 *  idleMs：闲置回收窗口（不给 = 生产默认 10 分钟；0 = 到期立即回收，用于验证在飞工作不被回收） */
async function startConnector(
  spaceId: string,
  userId: string,
  name: string,
  cookie: string,
  idleMs?: number,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ramet-connector-'))
  const tokenFile = join(dir, 'connector.json')
  const { connectorId } = await provisionConnector(pool, { spaceId, ownerId: userId, name, cloud: base, tokenFile })
  const controller = new AbortController()
  const logs: string[] = []
  void runConnector({
    cloud: base,
    name,
    cwd: process.cwd(),
    tokenFile,
    signal: controller.signal,
    log: (line) => logs.push(line),
    idleMs,
  }).catch((err: unknown) => logs.push(`失败: ${String(err)}`))
  stops.push(() => controller.abort())
  await waitFor(async () => (await agentsList(cookie)).some((a) => a.label.startsWith(`${name} ·`)))
  return connectorId
}

// ---------- 用例 ----------

test('删除 connector 行后 token 立即失效', async () => {
  const { spaceId, userId } = await setupPage()
  const res = await provisionConnector(pool, { spaceId, ownerId: userId, name: 'box' })
  expect(await connectorByToken(pool, res.token)).toMatchObject({ name: 'box', spaceId })
  await pool.query('DELETE FROM connectors WHERE id = $1', [res.connectorId])
  expect(await connectorByToken(pool, res.token)).toBeNull()
})

test('复合 id：connectorId 与含冒号的 agentId 都能解析', () => {
  expect(parseRemoteId('c:abc-123:claude')).toEqual({ connectorId: 'abc-123', agentId: 'claude' })
  expect(parseRemoteId('c:abc-123:foo:bar')).toEqual({ connectorId: 'abc-123', agentId: 'foo:bar' })
  expect(parseRemoteId('omp')).toBeNull()
  expect(parseRemoteId('c:nocolon')).toBeNull()
})

test('cloud 地址归一化：http/wss 都变 ws 源', () => {
  expect(cloudOrigin('http://127.0.0.1:3789')).toBe('ws://127.0.0.1:3789')
  expect(cloudOrigin('https://ramet.example.com/api')).toBe('wss://ramet.example.com')
  expect(cloudOrigin('ws://host:1234')).toBe('ws://host:1234')
})

test('Hub 断线：在飞请求被收尾为失败', async () => {
  const hub = new ConnectorHub(pool)
  const sent: string[] = []
  const ws = {
    readyState: 1,
    send: (d: string) => sent.push(String(d)),
    close: () => undefined,
  } as unknown as WebSocket
  hub.attach({ id: 'conn-1', spaceId: 'sp-1', ownerId: null, name: 'box', defaultCwd: '/tmp', agents: [], ws })
  const pass = await assertCanUse(allowPool, { id: 'u-1' }, 'conn-1', 'agent')
  const pending = hub.request(pass, (rid, actor) => ({ t: 'new', rid, actor, agent: 'fake', cwd: '/tmp' }))
  await waitFor(() => sent.length === 1)
  hub.detach('conn-1', '已断开')
  await expect(pending).rejects.toThrow(/已断开/)
})

test('全链路：配对 → catalog 出现该 agent → 经 connector 生成 → 文档出现回复', async () => {
  const { cookie, pageId, spaceId, userId } = await setupPage()
  const connectorId = await startConnector(spaceId, userId, 'testbox', cookie)

  const remoteId = `c:${connectorId}:fake`
  await waitFor(async () => (await agentsList(cookie)).some((a) => a.id === remoteId))
  const remote = (await agentsList(cookie)).find((a) => a.id === remoteId)!
  expect(remote.label).toBe('testbox · Fake')

  const provider = await connectDoc(pageId, cookie)
  userMessage(provider.document, '问题一')
  expect((await post(`/api/pages/${pageId}/continue`, cookie, { agent: remoteId })).status).toBe(202)

  await waitFor(() => docText(provider).includes('turn:'))
  expect(docText(provider)).toContain('turn:')
  // 会话状态以复合 id 为键落在中心（connector 无状态）
  await waitFor(async () => (await agentSessionKeys(pageId)).length > 0)
  expect(await agentSessionKeys(pageId)).toEqual([remoteId])
  provider.destroy()
})

test('工作区(远端)：agent-dirs 经 WSS 列 connector 机器上的目录；覆盖值对远端 agent 生效', async () => {
  const { cookie, pageId, spaceId, userId } = await setupPage()
  const connectorId = await startConnector(spaceId, userId, 'wsbox', cookie)
  const remoteId = `c:${connectorId}:fake`
  await waitFor(async () => (await agentsList(cookie)).some((a) => a.id === remoteId))

  // 列目录：中心不碰自己的盘，请求经 WSS 交给 connector 在它那台机器上读（path 省略 = 生效工作区，
  // 远端默认 = connector 上报的 defaultCwd，这里就是它启动时的 cwd）
  const res = await fetch(`${base}/api/pages/${pageId}/agent-dirs?agent=${encodeURIComponent(remoteId)}`, {
    headers: { cookie },
  })
  expect(res.status).toBe(200)
  const listing = (await res.json()) as { path: string; dirs: Array<{ name: string }> }
  expect(listing.path).toBe(await realpath(process.cwd()))
  expect(listing.dirs.length).toBeGreaterThan(0)

  // 指定工作区：中心解析后的 cwd 一路传到远端 session/new（假 agent 含「报目录」回显收到值）
  const dir = await mkdtemp(join(tmpdir(), 'ramet-ws-remote-'))
  await mkdir(join(dir, 'sub-r'))
  expect((await post(`/api/pages/${pageId}/agent-cwd`, cookie, { agent: remoteId, cwd: dir })).status).toBe(200)
  // 同一个目录再用选择器列一次：内容必须是执行端真列出来的（不是中心侧拼的）
  const listed = await fetch(
    `${base}/api/pages/${pageId}/agent-dirs?agent=${encodeURIComponent(remoteId)}&path=${encodeURIComponent(dir)}`,
    { headers: { cookie } },
  )
  const listing2 = (await listed.json()) as { path: string; dirs: Array<{ name: string; path: string }> }
  expect(listing2.path).toBe(dir)
  expect(listing2.dirs).toEqual([{ name: 'sub-r', path: join(dir, 'sub-r') }])
  const { rows } = await pool.query<{ workspaces: Record<string, string> | null }>(
    "SELECT agent_session->'workspaces' AS workspaces FROM pages WHERE id = $1",
    [pageId],
  )
  // 工作区按 agent 分存：远端 agent 的目录只对那台机器有意义，键就是它的复合 id
  expect(rows[0]?.workspaces?.[remoteId]).toBe(dir)

  const provider = await connectDoc(pageId, cookie)
  userMessage(provider.document, '报目录 远端')
  expect((await post(`/api/pages/${pageId}/continue`, cookie, { agent: remoteId })).status).toBe(202)
  await waitFor(() => docText(provider).includes(`cwd:${dir}`))
  provider.destroy()
})

test('闲置回收：在飞轮次不被回收（长任务中途不许被判空闲 —— 症状是「已停止」）', async () => {
  const { cookie, pageId, spaceId, userId } = await setupPage()
  // 700ms 窗口 + 慢轮次（10 片 × 150ms ≈1.5s）：轮次在飞期间窗口必然到期两次。
  // 若按「最后一次客户端到 agent 的请求」计时，会中途 kill 掉 agent 进程，run 被记成 cancelled。
  const connectorId = await startConnector(spaceId, userId, 'idlebox', cookie, 700)
  const remoteId = `c:${connectorId}:fake`
  await waitFor(async () => (await agentsList(cookie)).some((a) => a.id === remoteId))

  const provider = await connectDoc(pageId, cookie)
  userMessage(provider.document, '慢慢来')
  expect((await post(`/api/pages/${pageId}/continue`, cookie, { agent: remoteId })).status).toBe(202)

  // 第一片出来 = 已确认在飞，窗口从现在起必然到期
  await waitFor(() => docText(provider).includes('piece0'), 20_000)
  await waitFor(() => docText(provider).includes('piece9'), 20_000)
  expect(docText(provider)).toContain('piece9')
  // 跑完且不是被回收/取消收尾（被回收会把这一轮记成 cancelled）
  let statsRaw: string | null = null
  provider.document.getXmlFragment('prosemirror').forEach((c) => {
    if (c instanceof Y.XmlElement && c.nodeName === 'agent_reply') statsRaw = c.getAttribute('stats') ?? null
  })
  expect(decodeStats(statsRaw).o).toBe('end')
  provider.destroy()
}, 30_000)

test('撤销 connector：连接断开、agent 从 catalog 消失', async () => {
  const { cookie, spaceId, userId } = await setupPage()
  const connectorId = await startConnector(spaceId, userId, 'box2', cookie)
  const remoteId = `c:${connectorId}:fake`
  await waitFor(async () => (await agentsList(cookie)).some((a) => a.id === remoteId))

  expect((await fetch(`${base}/api/connectors/${connectorId}`, { method: 'DELETE', headers: { cookie } })).status).toBe(200)
  await waitFor(async () => !(await agentsList(cookie)).some((a) => a.id === remoteId))
  expect((await agentsList(cookie)).some((a) => a.id.startsWith(`c:${connectorId}:`))).toBe(false)
})

test('connector 上线/下线 → control:global 广播 "agents"（前端据此重拉目录，不靠刷新网页）', async () => {
  const { cookie, spaceId, userId } = await setupPage()
  const payloads: string[] = []
  const control = await connectControl(cookie, (payload) => payloads.push(payload))

  // 上线：刚连上的机器上的 agent 要能立刻出现在目录里，广播是唯一信号
  const connectorId = await startConnector(spaceId, userId, 'box-live', cookie)
  await waitFor(() => payloads.includes('agents'))

  // 下线（撤销 → 4403 断开）：同一信号，目录里的 agent 才能随之消失
  payloads.length = 0
  expect((await fetch(`${base}/api/connectors/${connectorId}`, { method: 'DELETE', headers: { cookie } })).status).toBe(200)
  await waitFor(() => payloads.includes('agents'))
  control.destroy()
})

test('权限审批经 connector 往返', async () => {
  const { cookie, pageId, spaceId, userId } = await setupPage()
  const connectorId = await startConnector(spaceId, userId, 'box3', cookie)
  const remoteId = `c:${connectorId}:fake`
  const provider = await connectDoc(pageId, cookie)
  userMessage(provider.document, '需要权限')

  const events: AgentEvent[] = []
  const controller = new AbortController()
  const sse = await fetch(`${base}/api/pages/${pageId}/agent-events`, { headers: { cookie }, signal: controller.signal })
  // SSE 读取循环：abort 时 read() 会抛 AbortError，是预期收尾，吞掉
  void (async () => {
    const reader = sse.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data) continue
          try {
            events.push(JSON.parse(data) as AgentEvent)
          } catch {
            /* 心跳等非 JSON 帧 */
          }
        }
      }
    }
  })().catch(() => undefined)

  expect((await post(`/api/pages/${pageId}/continue`, cookie, { agent: remoteId })).status).toBe(202)
  await waitFor(() => events.some((e) => e.type === 'permission'))
  const perm = events.find((e) => e.type === 'permission') as Extract<AgentEvent, { type: 'permission' }>
  // 远端审批也带 catalog agentId（c:<connectorId>:fake）：requestId 只在 connector 上那个进程内唯一
  expect(perm.agentId).toBe(remoteId)
  expect(
    (await post(`/api/pages/${pageId}/permission`, cookie, { agentId: remoteId, requestId: perm.requestId, optionId: perm.options[0]!.optionId }))
      .status,
  ).toBe(200)
  await waitFor(() => events.some((e) => e.type === 'permission_resolved' && e.requestId === perm.requestId))
  await waitFor(() => docText(provider).includes('granted:'))
  expect(docText(provider)).toContain('granted:')
  controller.abort()
  provider.destroy()
})

/** 真子进程跑 connector CLI：SIGKILL 掉它才叫「关掉中转」（进程内跑 runConnector 的 abort 不是同一个东西） */
function spawnConnector(args: string[]): { child: ChildProcess; logs: string[] } {
  const logs: string[] = []
  const child = spawn(process.execPath, ['--import', 'tsx', CONNECTOR_CLI, '--cloud', base, ...args], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (b: Buffer) => logs.push(b.toString()))
  child.stderr.on('data', (b: Buffer) => logs.push(b.toString()))
  stops.push(() => {
    child.kill('SIGKILL')
  })
  return { child, logs }
}

test('connector 重启：同一会话的下一轮照常收到回复（中心不许拿旧连接上的会话记忆直接 prompt）', async () => {
  const { cookie, pageId, spaceId, userId } = await setupPage()
  const dir = await mkdtemp(join(tmpdir(), 'ramet-connector-reboot-'))
  const tokenFile = join(dir, 'connector.json')
  await provisionConnector(pool, { spaceId, ownerId: userId, name: 'rebootbox', cloud: base, tokenFile })

  const first = spawnConnector(['--name', 'rebootbox', '--token-file', tokenFile])
  await waitFor(() => first.logs.some((l) => l.includes('已连上中心')), 30_000)
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM connectors WHERE name = 'rebootbox'")
  const remoteId = `c:${rows[0]!.id}:fake`
  await waitFor(async () => (await agentsList(cookie)).some((a) => a.id === remoteId))

  const provider = await connectDoc(pageId, cookie)
  userMessage(provider.document, '问题一')
  expect((await post(`/api/pages/${pageId}/continue`, cookie, { agent: remoteId })).status).toBe(202)
  await waitFor(() => docText(provider).includes('turn:full'))

  // 关掉中转：SIGKILL 是真死（旧 agent 进程连同它的会话一起没了），连接断了，目录里也消失
  first.child.kill('SIGKILL')
  await waitFor(async () => !(await agentsList(cookie)).some((a) => a.id === remoteId))

  // 重开中转（同 token 文件）：新进程里没有那个 sessionId
  const second = spawnConnector(['--name', 'rebootbox', '--token-file', tokenFile])
  await waitFor(() => second.logs.some((l) => l.includes('已连上中心')), 30_000)

  // 下一轮照常出回复。跳过 load 直接 prompt 的话，新 agent 进程会回「Unsupported ACP session」
  // （假 agent 照真 agent 这么做），这一轮就永远没有回复，用户看到的就是「发了命令收不到」
  userMessage(provider.document, '问题二')
  expect((await post(`/api/pages/${pageId}/continue`, cookie, { agent: remoteId })).status).toBe(202)
  await waitFor(() => docText(provider).split('turn:').length - 1 >= 2, 30_000)
  expect(docText(provider).split('turn:').length - 1).toBeGreaterThanOrEqual(2)
  provider.destroy()
}, 60_000)

test('connector 在飞掉线：SSE 必须给出失败原因（不能只把状态切成 error）', async () => {
  const { cookie, pageId, spaceId, userId } = await setupPage()
  const connectorId = await startConnector(spaceId, userId, 'dropbox', cookie)
  const remoteId = `c:${connectorId}:fake`
  const provider = await connectDoc(pageId, cookie)

  const events: AgentEvent[] = []
  const controller = new AbortController()
  const sse = await fetch(`${base}/api/pages/${pageId}/agent-events`, { headers: { cookie }, signal: controller.signal })
  void (async () => {
    const reader = sse.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data) continue
          try {
            events.push(JSON.parse(data) as AgentEvent)
          } catch {
            /* 心跳等非 JSON 帧 */
          }
        }
      }
    }
  })().catch(() => undefined)

  // 「慢慢来」分 10 片慢速输出：留出「在飞时把 connector 弄掉」的窗口
  userMessage(provider.document, '慢慢来')
  expect((await post(`/api/pages/${pageId}/continue`, cookie, { agent: remoteId })).status).toBe(202)
  await waitFor(() => events.some((e) => e.type === 'status' && e.state === 'running'))
  expect((await fetch(`${base}/api/connectors/${connectorId}`, { method: 'DELETE', headers: { cookie } })).status).toBe(200)

  // 失败原因要落到 RunErrorBar 那条通道（status:error 只带通用文案，前端没地方显示原因）
  await waitFor(() => events.some((e) => e.type === 'error'))
  const failed = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>
  expect(failed.message).toMatch(/已被撤销|已断开|连接/)
  controller.abort()
  provider.destroy()
}, 60_000)

test('connector 收到 SIGINT 必须真的退出（重连定时器不许把「关掉中转」变成空操作）', async () => {
  const { spaceId, userId } = await setupPage()
  const dir = await mkdtemp(join(tmpdir(), 'ramet-connector-sigint-'))
  const tokenFile = join(dir, 'connector.json')
  await provisionConnector(pool, { spaceId, ownerId: userId, name: 'sigbox', cloud: base, tokenFile })
  const { child, logs } = spawnConnector(['--name', 'sigbox', '--token-file', tokenFile])
  let exited: number | null = null
  child.on('exit', (c) => (exited = c ?? 0))
  await waitFor(() => logs.some((l) => l.includes('已连上中心')), 30_000)

  child.kill('SIGINT')
  await waitFor(() => exited !== null, 15_000)
  expect(exited).toBe(0)
  // 收尾之后不许再「已连上中心」：那是退避定时器把连接拉回来了，进程活着但 agent 进程已被
  // shutdown 杀掉，中心却以为一切正常。
  // 断言的是「某件事没有发生」，没有可等待的信号；退避是 1s（RECONNECT_MIN_MS），等它两轮。
  await new Promise((r) => setTimeout(r, 2_000))
  expect(logs.filter((l) => l.includes('已连上中心')).length).toBe(1)
}, 60_000)

test('中心重启：connector 进程自行重连存活（重连定时器不能被 unref —— 进程会以 code 13 退出）', async () => {
  const { cookie, spaceId, userId } = await setupPage()
  const dir = await mkdtemp(join(tmpdir(), 'ramet-connector-restart-'))
  const tokenFile = join(dir, 'connector.json')
  await provisionConnector(pool, { spaceId, ownerId: userId, name: 'restartbox', cloud: base, tokenFile })
  const logs: string[] = []
  // 子进程跑真实的 cli.ts：本用例要证明的是「进程能否活着重连」，进程内跑 runConnector 证明不了
  const child = spawn(process.execPath, ['--import', 'tsx', CONNECTOR_CLI, '--cloud', base, '--name', 'restartbox', '--token-file', tokenFile], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (b: Buffer) => logs.push(b.toString()))
  child.stderr.on('data', (b: Buffer) => logs.push(b.toString()))
  let exited: number | null = null
  child.on('exit', (c) => (exited = c ?? 0))
  stops.push(() => {
    child.kill('SIGKILL')
  })

  await waitFor(() => logs.filter((l) => l.includes('已连上中心')).length >= 1, 20_000)
  expect(exited).toBeNull()

  // 杀掉中心：connector 的 ws 断开（1006），此时进程里唯一待命句柄就是重连定时器
  await s.close()
  await new Promise((r) => setTimeout(r, 3_000))
  expect(exited, `connector 在中心重启期间退出了：\n${logs.join('')}`).toBeNull()

  // 中心回来：connector 应该自行重连（同一个 connectorId 重新注册，说明复用了 token）
  // 同一个端口重启：connector 只认 --cloud 里那个地址
  const revived = await startServer(pool, s.port)
  center = revived
  const revivedBase = `http://127.0.0.1:${revived.port}`
  stops.push(() => revived.close())
  await waitFor(() => logs.filter((l) => l.includes('已连上中心')).length >= 2, 60_000)
  expect(logs.some((l) => l.includes('连接断开'))).toBe(true) // 先真的断过，重连才算数
  // 新中心上该 connector 在线：agent 目录里能看到它
  const res = await fetch(`${revivedBase}/api/agents`, { headers: { cookie } })
  expect(res.status).toBe(200)
  expect(exited).toBeNull()
}, 120_000)

// ---------- 在飞回合跨中心重启（必须排在「中心重启」之后：下面会关掉 center） ----------

function agentReplies(doc: Y.Doc): Y.XmlElement[] {
  const out: Y.XmlElement[] = []
  doc.getXmlFragment('prosemirror').forEach((c) => {
    if (c instanceof Y.XmlElement && c.nodeName === 'agent_reply') out.push(c)
  })
  return out
}

/** SSE 正文或快照里已经有断线前那一段 */
function sawBefore(events: AgentEvent[]): boolean {
  return events.some((e) =>
    (e.type === 'reply' && e.d.includes('before')) || (e.type === 'run' && JSON.stringify(e.state).includes('before')),
  )
}

/** 等响应头（订阅已挂上）再后台读帧。服务器关掉时 reader 结束，不抛。
 *  用 node:http 且 agent:false：SSE 必须开一条新连接。同端口重启后，全局 fetch 的连接池
 *  还留着「旧中心」那条 keep-alive socket，复用它会拿到 UND_ERR_SOCKET（other side closed），
 *  于是重启后的第一份快照永远等不到。每次订阅独占连接，与中心生命周期无关。 */
async function collectSse(cookie: string, pageId: string, events: AgentEvent[], signal: AbortSignal): Promise<void> {
  const port = Number(new URL(base).port)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: `/api/pages/${pageId}/agent-events`,
        headers: { cookie, accept: 'text/event-stream' },
        agent: false,
      },
      (res) => {
        if (res.statusCode !== 200) {
          settled = true
          reject(new Error(`SSE 订阅失败：${res.statusCode}`))
          return
        }
        settled = true
        resolve() // 响应头已回来 = 订阅挂上；此后在后台读帧
        res.setEncoding('utf8')
        let buffer = ''
        res.on('data', (chunk: string) => {
          buffer += chunk
          let idx: number
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue
              const data = line.slice(5).trim()
              if (!data) continue
              try {
                events.push(JSON.parse(data) as AgentEvent)
              } catch {
                /* 心跳等非 JSON 帧 */
              }
            }
          }
        })
        res.on('error', () => undefined)
      },
    )
    req.on('error', (err) => {
      if (!settled) {
        settled = true
        reject(err)
      }
    })
    signal.addEventListener('abort', () => req.destroy(), { once: true })
    req.end()
  })
}

/** 前一个用例可能已经把 s 关掉。同端口上没有中心时再拉起，base / collab 都认 s.port。 */
async function ensureCenter(): Promise<void> {
  try {
    await fetch(`${base}/api/agents`, { signal: AbortSignal.timeout(1500) })
  } catch {
    const opened = await startServer(pool, s.port)
    center = opened
    stops.push(() => opened.close())
  }
}

async function waitRunPlaceholder(doc: Y.Doc, events: AgentEvent[]): Promise<string> {
  await waitFor(() => {
    const node = agentReplies(doc).find((n) => decodeStats(n.getAttribute('stats')).o === 'run')
    return sawBefore(events) && node != null
  })
  const id = agentReplies(doc).find((n) => decodeStats(n.getAttribute('stats')).o === 'run')?.getAttribute('id')
  if (!id) throw new Error('o:run 占位块没有 id')
  return id
}

async function spawnPaired(name: string): Promise<{
  cookie: string
  pageId: string
  remoteId: string
  tokenFile: string
  child: ChildProcess
  logs: string[]
  exited: () => number | null
}> {
  await ensureCenter()
  const { cookie, pageId, spaceId, userId } = await setupPage()
  const dir = await mkdtemp(join(tmpdir(), 'ramet-connector-resume-'))
  const tokenFile = join(dir, 'connector.json')
  await provisionConnector(pool, { spaceId, ownerId: userId, name, cloud: base, tokenFile })
  const spawned = spawnConnector(['--name', name, '--token-file', tokenFile])
  let codeExit: number | null = null
  spawned.child.on('exit', (c) => (codeExit = c ?? 0))
  await waitFor(() => spawned.logs.some((l) => l.includes('已连上中心')), 30_000)
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM connectors WHERE name = $1', [name])
  const remoteId = `c:${rows[0]!.id}:fake`
  await waitFor(async () => (await agentsList(cookie)).some((a) => a.id === remoteId))
  return { cookie, pageId, remoteId, tokenFile, child: spawned.child, logs: spawned.logs, exited: () => codeExit }
}

async function startDisconnectTurn(cookie: string, pageId: string, remoteId: string): Promise<{
  provider: HocuspocusProvider
  sse: AbortController
  events: AgentEvent[]
  replyId: string
}> {
  const provider = await connectDoc(pageId, cookie)
  const events: AgentEvent[] = []
  const sse = new AbortController()
  await collectSse(cookie, pageId, events, sse.signal)
  userMessage(provider.document, '断线续')
  expect((await post(`/api/pages/${pageId}/continue`, cookie, { agent: remoteId })).status).toBe(202)
  const replyId = await waitRunPlaceholder(provider.document, events)
  return { provider, sse, events, replyId }
}

/** s.close() 再在同端口 startServer。新 SSE 从新进程听请求头回来那一刻开始收。 */
async function reviveAfterBefore(opts: {
  cookie: string
  pageId: string
  logs: string[]
  exited: () => number | null
  provider: HocuspocusProvider
  sse: AbortController
}): Promise<AgentEvent[]> {
  const connected = opts.logs.filter((l) => l.includes('已连上中心')).length
  opts.sse.abort()
  opts.provider.destroy()
  await center.close()
  if (opts.exited() !== null) throw new Error(`connector 在中心重启期间退出了：\n${opts.logs.join('')}`)
  const revived = await startServer(pool, s.port)
  center = revived
  stops.push(() => revived.close())
  const events: AgentEvent[] = []
  const ac = new AbortController()
  stops.push(() => ac.abort())
  await collectSse(opts.cookie, opts.pageId, events, ac.signal)
  await waitFor(() => opts.logs.filter((l) => l.includes('已连上中心')).length >= connected + 1, 60_000)
  return events
}

test('中心重启后续上同一块', async () => {
  const box = await spawnPaired('resumebox')
  const turn = await startDisconnectTurn(box.cookie, box.pageId, box.remoteId)
  const resumed = await reviveAfterBefore({
    cookie: box.cookie, pageId: box.pageId, logs: box.logs, exited: box.exited, provider: turn.provider, sse: turn.sse,
  })
  expect(box.exited(), `connector 在中心重启期间退出了：\n${box.logs.join('')}`).toBeNull()
  const again = await connectDoc(box.pageId, box.cookie)
  try {
    await waitFor(() => {
      const node = agentReplies(again.document).find((n) => n.getAttribute('id') === turn.replyId)
      const outcome = decodeStats(node?.getAttribute('stats')).o
      return agentReplies(again.document).length === 1 && outcome != null && outcome !== 'run'
    }, 45_000)
    const nodes = agentReplies(again.document)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.getAttribute('id')).toBe(turn.replyId)
    expect(decodeStats(nodes[0]!.getAttribute('stats')).o, docText(again)).toBe('end')
    expect(docText(again)).toContain('before')
    expect(docText(again)).toContain('after')
    expect(resumed.some((e) => e.type === 'error' || (e.type === 'status' && e.state === 'error'))).toBe(false)
  } finally {
    again.destroy()
  }
}, 120_000)

test('中心重启后第一份 run 快照已含 before', async () => {
  const box = await spawnPaired('snapbox')
  const turn = await startDisconnectTurn(box.cookie, box.pageId, box.remoteId)
  const resumed = await reviveAfterBefore({
    cookie: box.cookie, pageId: box.pageId, logs: box.logs, exited: box.exited, provider: turn.provider, sse: turn.sse,
  })
  await waitFor(() => resumed.some((e) => e.type === 'run'), 30_000)
  const first = resumed.find((e): e is Extract<AgentEvent, { type: 'run' }> => e.type === 'run')
  // 第一份快照本身就要有 before，不能是空 state、等 after 才填上
  expect(JSON.stringify(first?.state ?? {})).toContain('before')
  turn.sse.abort()
}, 120_000)

test('connector 进程 SIGKILL 后在飞占位收成 error', async () => {
  const box = await spawnPaired('reapbox')
  const turn = await startDisconnectTurn(box.cookie, box.pageId, box.remoteId)
  box.child.kill('SIGKILL')
  await waitFor(() => box.exited() !== null, 15_000)
  await waitFor(async () => !(await agentsList(box.cookie)).some((a) => a.id === box.remoteId))
  // 同一 token 文件、空 inflight：原占位必须收成 error，不能停在 o:run
  const second = spawnConnector(['--name', 'reapbox', '--token-file', box.tokenFile])
  await waitFor(() => second.logs.some((l) => l.includes('已连上中心')), 30_000)
  await waitFor(() => {
    const node = agentReplies(turn.provider.document).find((n) => n.getAttribute('id') === turn.replyId)
    return node != null && decodeStats(node.getAttribute('stats')).o === 'error'
  }, 30_000)
  expect(decodeStats(
    agentReplies(turn.provider.document).find((n) => n.getAttribute('id') === turn.replyId)?.getAttribute('stats'),
  ).o).toBe('error')
  await waitFor(async () => (await agentsList(box.cookie)).some((a) => a.id === box.remoteId))
  // 出错不更新 lastSyncedHash，下一轮全文重放仍含「断线续」，假 agent 会再睡 8 秒。
  // 要证明的是新进程还能把一轮跑完，而不是增量路径上的 turn: 字样。
  userMessage(turn.provider.document, '下一轮')
  expect((await post(`/api/pages/${box.pageId}/continue`, box.cookie, { agent: box.remoteId })).status).toBe(202)
  await waitFor(() => {
    const replies = agentReplies(turn.provider.document)
    return replies.length >= 2 && decodeStats(replies.at(-1)?.getAttribute('stats')).o === 'end'
  }, 30_000)
  turn.sse.abort()
  turn.provider.destroy()
}, 90_000)
