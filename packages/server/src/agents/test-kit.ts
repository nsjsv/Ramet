/**
 * agent 集成测试的公共底座:起一份带 fake agent 的服务 + 造数/协同客户端/SSE 收集助手。
 * 各测试文件 import 它即各自起服(vitest 按文件隔离模块实例);钩子在 import 时注册到导入它的文件。
 */
import { afterAll, afterEach, beforeEach, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import { WebSocket } from 'ws'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { fileURLToPath } from 'node:url'
import { getPool, initDb, closePool } from '../db.js'
import { startServer } from '../index.js'
import { hashPassword } from '../auth.js'
import { serializeDoc } from './doc.js'
import { decodeStats } from '@ramet/shared/reply-stats'
import { textOf } from '../updates.js'
import type { AgentEvent, PermissionEvent } from './types.js'
import { provisionConnector, truncateAll } from '../test-helpers.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeSnapshot } from '../collab.js'
import { runConnector, type ConnectorOptions } from '../connector/index.js'
import { readConnectorConfig, writeConnectorConfig } from '../connector/access.js'
import { approveConnector, type ConnectorStatus } from './connectors.js'
import type { MachineScope } from './machine-access.js'
import { CONNECTOR_PAIR_PATH, type ConnectorAgentInfo, type PairReply } from './protocol.js'

if (!process.env.DATABASE_URL) {
  throw new Error('需要 DATABASE_URL 指向测试库,例如 postgres://postgres:postgres@localhost:5432/ramet_test')
}

// startServer 里 loadAgents 读 env,必须在起服前设好。两个 agent 跑同一份假脚本，启动参数给不同的命令名：
// `claude` 这个 id 让主人校验走真的 posture 表（生产代码不为 fake 开分支）；`fake` 保持目录第一个
export const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))
// 中心默认不跑本机 agent（index.ts），测试要用本机假 agent，显式打开
process.env.RAMET_LOCAL_AGENTS = '1'
process.env.RAMET_AGENTS = JSON.stringify([
  { id: 'fake', label: 'Fake', command: process.execPath, args: [FAKE_AGENT, 'fake-cmd'] },
  { id: 'claude', label: 'Claude', command: process.execPath, args: [FAKE_AGENT, 'claude-cmd'] },
])

export const pool = getPool()
await initDb(pool)
// 端口预览也一起起（随机端口）：预览的测试要用；不测预览的文件多开一个空闲监听，无碍
export const s = await startServer(pool, 0, { preview: { port: 0, ticketTtlMs: 2500, revalidateMs: 0 } })
export const base = `http://127.0.0.1:${s.port}`
export const previewBase = `http://127.0.0.1:${s.previewPort}`
export const previewPort = (): number => s.previewPort!

// TRUNCATE 偶发 40P01 死锁，重试逻辑收在 truncateAll（test-helpers.ts）一处。
// beforeEach 兜底:别的文件 afterAll 遗留的行 + 本文件被跳过/中断的首个用例
beforeEach(async () => {
  await truncateAll(pool)
})
afterEach(async () => {
  await truncateAll(pool)
})
afterAll(async () => {
  await s.close()
  await closePool()
})

// ---------- 造数助手 ----------

export async function insertUser(username: string, role: 'user' | 'admin' = 'user'): Promise<string> {
  const id = randomUUID()
  await pool.query('INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)', [
    id, username, hashPassword('pw-123456'), role,
  ])
  return id
}

/** 新用户加入页面所在空间，返回登录 cookie。造不是机器主人的协作者（member）或 admin 用 */
export async function joinPageSpace(
  pageId: string,
  username: string,
  opts: { role?: 'owner' | 'member' | 'viewer'; user?: 'user' | 'admin' } = {},
): Promise<string> {
  const userId = await insertUser(username, opts.user)
  await pool.query(
    'INSERT INTO space_members (space_id, user_id, role) SELECT space_id, $2, $3 FROM pages WHERE id = $1',
    [pageId, userId, opts.role ?? 'member'],
  )
  return login(username)
}

export function postJson(path: string, cookie: string, body: unknown = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
}

export async function login(username: string): Promise<string> {
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

export async function setupPage(): Promise<{ cookie: string; pageId: string }> {
  // alice 是全局 admin：测试主要跑服务器本机的假 agent，它的主人是 admin（machine-access.ts 的 assertLocalOwner）
  await insertUser('alice', 'admin')
  const cookie = await login('alice')
  const space = await (await fetch(`${base}/api/spaces`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 's' }),
  })).json() as { id: string }
  const page = await (await fetch(`${base}/api/pages`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ space_id: space.id }),
  })).json() as { id: string }
  return { cookie, pageId: page.id }
}

// ---------- 协同客户端(带 cookie 的 provider) ----------

export async function connectDoc(pageId: string, cookie: string): Promise<HocuspocusProvider> {
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
    provider.on('synced', () => { clearTimeout(t); resolve() })
  })
  return provider
}

export function userMessage(doc: Y.Doc, text: string, config: Record<string, string> = {}): void {
  const frag = doc.getXmlFragment('prosemirror')
  const msg = new Y.XmlElement('user_message')
  // 消息级调用配置：与前端 message-blocks.ts 同口径，只进节点 attrs
  for (const [k, v] of Object.entries(config)) msg.setAttribute(k, v)
  const p = new Y.XmlElement('paragraph')
  const t = new Y.XmlText()
  t.insert(0, text)
  p.insert(0, [t])
  msg.insert(0, [p])
  frag.insert(frag.length, [msg])
}

// 改第一条用户消息的文本(hash 失配 → 全文重放路径)
export function editFirstUserMessage(doc: Y.Doc, to: string): void {
  const frag = doc.getXmlFragment('prosemirror')
  const msg = frag.get(0) as Y.XmlElement
  const p = msg.get(0) as Y.XmlElement
  const t = p.get(0) as Y.XmlText
  doc.transact(() => {
    t.delete(0, t.length)
    t.insert(0, to)
  })
}

// ---------- SSE 收集 ----------

export class SSECollector {
  events: AgentEvent[] = []
  private buffer = ''
  private controller = new AbortController()
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private done = Promise.resolve()

  async start(pageId: string, cookie: string): Promise<void> {
    const res = await fetch(`${base}/api/pages/${pageId}/agent-events`, {
      headers: { cookie },
      signal: this.controller.signal,
    })
    expect(res.status).toBe(200)
    const body = res.body
    if (!body) throw new Error('SSE 无响应体')
    this.reader = body.getReader()
    this.done = (async () => {
      const decoder = new TextDecoder()
      for (;;) {
        const { value, done } = await this.reader!.read()
        if (done) break
        this.buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = this.buffer.indexOf('\n\n')) >= 0) {
          const frame = this.buffer.slice(0, idx)
          this.buffer = this.buffer.slice(idx + 2)
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (!data) continue
            try {
              this.events.push(JSON.parse(data) as AgentEvent)
            } catch {
              /* 心跳等非 JSON 帧 */
            }
          }
        }
      }
    })()
  }

  async wait(pred: (ev: AgentEvent) => boolean, timeoutMs = 15_000): Promise<AgentEvent> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = this.events.find(pred)
      if (hit) return hit
      if (Date.now() > deadline) throw new Error(`等待事件超时,已收:${JSON.stringify(this.events.slice(-6))}`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  stop(): void {
    this.controller.abort()
    // 中止流读取是预期行为,吞掉 abort 拒绝
    this.done.catch(() => undefined)
  }
}

export async function continuePage(pageId: string, cookie: string, body: Record<string, unknown> = {}): Promise<number> {
  const res = await fetch(`${base}/api/pages/${pageId}/continue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return res.status
}

export async function agentSession(pageId: string): Promise<Record<string, { sessionId: string; cwd: string; lastSyncedHash: string | null }> | null> {
  const { rows } = await pool.query<{ agent_session: { sessions?: Record<string, { sessionId: string; cwd: string; lastSyncedHash: string | null }> } | null }>(
    'SELECT agent_session FROM pages WHERE id = $1', [pageId],
  )
  return rows[0]?.agent_session?.sessions ?? null
}

export const docText = (p: HocuspocusProvider) => serializeDoc(p.document.getXmlFragment('prosemirror'))

// 顶层 agent_reply 块的 agent 归属属性:前端按它渲染 icon/名字,
// 属性不进 markdown/DOM,只能看 Yjs 节点。没有该块时返回 null
export function replyAgent(p: HocuspocusProvider): string | null {
  return replyAttr(p, 'agent')
}

// 顶层 agent_reply 块的属性，如 run 是这一轮工具调用过程归档出的页面 id(前端过程入口的落点)
export function replyAttr(p: HocuspocusProvider, name: string): string | null {
  let found: string | null = null
  p.document.getXmlFragment('prosemirror').forEach((c) => {
    if (!(c instanceof Y.XmlElement) || c.nodeName !== 'agent_reply') return
    found = c.getAttribute(name) ?? null
  })
  return found
}

// 轮询文档状态(text 增量走 Yjs 不走 SSE,断言以文档为准);默认 15s
export async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error('等待文档状态超时')
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** 该页历史快照物化后的正文（新→旧）：断言「旧回答在历史里」。origin 缺省 = 全部 */
export async function snapshotTexts(pageId: string, origin?: 'auto' | 'manual'): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM page_snapshots WHERE page_id = $1 AND ($2::text IS NULL OR origin = $2) ORDER BY created_at DESC, id DESC',
    [pageId, origin ?? null],
  )
  const out: string[] = []
  for (const r of rows) {
    const doc = await materializeSnapshot(pool, pageId, r.id)
    out.push(doc ? serializeDoc(doc.getXmlFragment('prosemirror')) : '')
  }
  return out
}

// ---------- connector ----------

export type CatalogItem = {
  id: string
  label: string
  posture: { owner: boolean; modes: boolean; unrestricted: string[] }
  /** 对这台机器有 machine 范围的使用权（项目面板入口的依据） */
  machine: boolean
}

export async function agentsList(cookie: string): Promise<CatalogItem[]> {
  return (await (await fetch(`${base}/api/agents`, { headers: { cookie } })).json()) as CatalogItem[]
}

const stops: Array<() => void | Promise<void>> = []
/** startConnector 起的进程内 connector：本地配置文件（授权名单写在这里）与日志，按 connectorId 取 */
const liveConnectors = new Map<string, { tokenFile: string; logs: string[] }>()
// 必须登记在上面那条 afterEach(truncateAll) 之后：afterEach 后登记先执行，先停 connector 再清库
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  liveConnectors.clear()
})

/** 该 connector 进程的日志行（第二道闸的拒绝、指令执行都记在这里） */
export function connectorLogs(connectorId: string): string[] {
  return liveConnectors.get(connectorId)?.logs ?? []
}

/** 该 connector 的本地配置文件路径（token / 主人 / 本地授权名单）：测试要直接改本地名单时用 */
export function connectorTokenFile(connectorId: string): string {
  const live = liveConnectors.get(connectorId)
  if (!live) throw new Error(`不是 startConnector 起的 connector：${connectorId}`)
  return live.tokenFile
}

/** 起一条进程内 connector（直接建好身份 → 常驻），返回 connectorId。它跑的 agent 清单与中心同一份（RAMET_AGENTS）。
 *  ownerId = 这台机器的主人（相当于在浏览器里确认配对的人；配对流程本身见 connect-pair.test.ts）。 */
export async function startConnector(opts: {
  spaceId: string
  ownerId: string
  name: string
  cookie: string
  /** 透传给 runConnector 的测试钩子（比如 loadPty: 模拟 node-pty 没装上） */
  connector?: Pick<ConnectorOptions, 'loadPty' | 'ptyLimits'>
}): Promise<string> {
  // connector 没有回环回落，必须显式给中心对外地址（同生产行为）
  process.env.RAMET_PUBLIC_URL = base
  const dir = await mkdtemp(join(tmpdir(), 'ramet-connector-'))
  const controller = new AbortController()
  const logs: string[] = []
  const tokenFile = join(dir, 'connector.json')
  const { connectorId } = await provisionConnector(pool, { spaceId: opts.spaceId, ownerId: opts.ownerId, name: opts.name, cloud: base, tokenFile })
  void runConnector({
    cloud: base,
    name: opts.name,
    cwd: process.cwd(),
    tokenFile,
    signal: controller.signal,
    log: (line) => logs.push(line),
    ...opts.connector,
  }).catch((err: unknown) => logs.push(`失败: ${String(err)}`))
  stops.push(async () => {
    controller.abort()
    await rm(dir, { recursive: true, force: true })
  })
  // 成员配对的机器本来要空间 owner 批准才生效；这里的全栈用例要的是已生效的机器，当场批准
  await approveConnector(pool, connectorId)
  await waitFor(async () => (await agentsList(opts.cookie)).some((a) => a.label.startsWith(`${opts.name} ·`)), 20_000)
  liveConnectors.set(connectorId, { tokenFile, logs })
  return connectorId
}

// ---------- 浏览器确认配对（connector/pair.ts ↔ agents/pairing.ts）----------

export type PairRequest = { code: string; ws: WebSocket; next: () => Promise<PairReply | null> }

/** 像 connector 一样连 /connector/pair 发申请，拿到链接里的码。next() 按序取中心之后的回帧，连接关了且没有剩余帧 → null */
export async function openPairRequest(name: string, agents: ConnectorAgentInfo[] = []): Promise<PairRequest> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}${CONNECTOR_PAIR_PATH}`)
  const frames: PairReply[] = []
  let closed = false
  let wake: (() => void) | null = null
  ws.on('message', (data) => {
    frames.push(JSON.parse(String(data)) as PairReply)
    wake?.()
  })
  ws.on('close', () => {
    closed = true
    wake?.()
  })
  const next = async (): Promise<PairReply | null> => {
    while (frames.length === 0 && !closed) await new Promise<void>((r) => (wake = r))
    return frames.shift() ?? null
  }
  const opened = Promise.withResolvers<void>()
  ws.once('open', () => opened.resolve())
  ws.once('error', (err) => opened.reject(err))
  await opened.promise
  stops.push(() => ws.terminate())
  ws.send(JSON.stringify({ t: 'pair-request', name, defaultCwd: '/tmp', agents }))
  const link = await next()
  if (link?.t !== 'pair-link') throw new Error(`没拿到配对链接：${JSON.stringify(link)}`)
  return { code: link.code, ws, next }
}

/** 走完整配对：connector 申请 → cookie 的主人在「浏览器」里选 spaceId 确认 → 发起申请的 ws 收到 paired（token 只走这条 ws） */
export async function pairViaBrowser(
  cookie: string,
  spaceId: string,
  name: string,
  agents: ConnectorAgentInfo[] = [],
): Promise<{ connectorId: string; token: string; ownerId: string; status: ConnectorStatus }> {
  const req = await openPairRequest(name, agents)
  const res = await postJson(`/api/connect/${req.code}/confirm`, cookie, { spaceId })
  if (res.status !== 200) throw new Error(`确认配对 ${res.status}: ${await res.text()}`)
  const { status } = (await res.json()) as { status: ConnectorStatus }
  const paired = await req.next()
  if (paired?.t !== 'paired') throw new Error(`没收到 paired：${JSON.stringify(paired)}`)
  return { connectorId: paired.connectorId, token: paired.token, ownerId: paired.ownerId, status }
}

// ---------- 机器授权 ----------

export async function userIdOf(username: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [username])
  return rows[0]!.id
}

/** 给某人一条机器授权（测试里直接写行，不走授权仪式）。默认 agent 范围、已在机器上确认、一小时后到期、未收回。
 *  真 connector 有第二道闸（本地授权名单，只有机器本地确认才会写）：local（缺省 true）同时把这条写进那台 connector
 *  的本地配置；传 false 模拟中心库里有授权、本机名单里没有 */
export async function grantMachine(
  connectorId: string,
  userId: string,
  opts: {
    scopes?: MachineScope[]
    confirmed?: boolean
    /** 距现在多久到期（毫秒；负数 = 已过期） */
    expiresInMs?: number
    revoked?: boolean
    local?: boolean
  } = {},
): Promise<string> {
  const id = randomUUID()
  const scopes = opts.scopes ?? ['agent']
  const expiresInMs = opts.expiresInMs ?? 3_600_000
  const { rows } = await pool.query<{ expires_at: Date }>(
    `INSERT INTO machine_grants (id, connector_id, user_id, scopes, granted_by, expires_at, confirmed_at, revoked_at)
     SELECT $1::text, c.id, $3::text, $4::text[], COALESCE(c.owner_id, 'unknown'), now() + $5::double precision * interval '1 millisecond',
            CASE WHEN $6::boolean THEN now() END, CASE WHEN $7::boolean THEN now() END
     FROM connectors c WHERE c.id = $2
     RETURNING expires_at`,
    [id, connectorId, userId, scopes, expiresInMs, opts.confirmed ?? true, opts.revoked ?? false],
  )
  const live = liveConnectors.get(connectorId)
  if (live && opts.local !== false && rows[0]) {
    const config = readConnectorConfig(live.tokenFile)
    if (!config) throw new Error('connector 本地配置读不到')
    writeConnectorConfig(live.tokenFile, {
      ...config,
      grants: [...(config.grants ?? []), { userId, scopes, expiresAt: rows[0].expires_at.toISOString() }],
    })
  }
  return id
}

// ---------- 全栈用例的通用助手 ----------

/** 同一个空间里再建一页（验证页面之间互不影响）。空间取自已有页面 */
export async function addPage(pageId: string, cookie: string): Promise<string> {
  const { rows } = await pool.query<{ space_id: string }>('SELECT space_id FROM pages WHERE id = $1', [pageId])
  // 测试里打的是自家 POST /api/pages：响应形状已知（同 setupPage）
  const page = (await (await postJson('/api/pages', cookie, { space_id: rows[0]!.space_id })).json()) as { id: string }
  return page.id
}

/** 页面级保存的会话配置（用户意图）：agent_session.configs[agentId][configId] */
export async function savedConfigs(pageId: string): Promise<Record<string, Record<string, string>>> {
  const { rows } = await pool.query<{ configs: Record<string, Record<string, string>> | null }>(
    "SELECT agent_session->'configs' AS configs FROM pages WHERE id = $1",
    [pageId],
  )
  return rows[0]?.configs ?? {}
}

/** 页面所在空间与创建人（connector 配对 / 主人校验用） */
export async function pageOwnership(pageId: string): Promise<{ spaceId: string; ownerId: string }> {
  const { rows } = await pool.query<{ space_id: string; owner_id: string }>(
    'SELECT space_id, owner_id FROM pages WHERE id = $1',
    [pageId],
  )
  return { spaceId: rows[0]!.space_id, ownerId: rows[0]!.owner_id }
}

/** 等一条审批事件（可按条件过滤），类型已收窄 */
export async function waitPermission(
  sse: SSECollector,
  match: (ev: PermissionEvent) => boolean = () => true,
): Promise<PermissionEvent> {
  const ev = await sse.wait((e) => e.type === 'permission' && match(e))
  if (ev.type !== 'permission') throw new Error('不是审批事件')
  return ev
}

/** 应答一条审批：带 agentId + requestId（requestId 只在单个进程内唯一） */
export function answerPermission(pageId: string, cookie: string, ev: PermissionEvent, optionId: string | null): Promise<Response> {
  return postJson(`/api/pages/${pageId}/permission`, cookie, { agentId: ev.agentId, requestId: ev.requestId, optionId })
}

/** SSE 里某 agent 最近一次 commands 事件的命令名（没收到过就是 undefined） */
export function commandNames(events: AgentEvent[], agentId: string): string[] | undefined {
  const last = events.findLast((e) => e.type === 'commands' && e.agentId === agentId)
  return last?.type === 'commands' ? last.list.map((c) => c.name) : undefined
}

export type ReplyBlock = { id: string; text: string; outcome: string | undefined }

/** 文档里全部顶层 agent_reply 块：id / 正文 / 收尾结果（run = 进行中） */
export function replyBlocks(p: HocuspocusProvider): ReplyBlock[] {
  const out: ReplyBlock[] = []
  p.document.getXmlFragment('prosemirror').forEach((c) => {
    if (!(c instanceof Y.XmlElement) || c.nodeName !== 'agent_reply') return
    out.push({ id: String(c.getAttribute('id') ?? ''), text: textOf(c), outcome: decodeStats(c.getAttribute('stats')).o })
  })
  return out
}

/** 错误响应体里的短码（`{ error: 'unknown agent', … }` 的 error）；不是这个形状就是 undefined */
export async function errorCode(res: Response): Promise<string | undefined> {
  const body: unknown = await res.json().catch(() => null)
  return body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : undefined
}

/** 选 agent 并等它的会话建好（config 事件带选项） */
export async function prepareAndWait(sse: SSECollector, pageId: string, cookie: string, agent: string): Promise<void> {
  expect((await postJson(`/api/pages/${pageId}/agent-prepare`, cookie, { agent })).status).toBe(202)
  await sse.wait((e) => e.type === 'config' && e.agentId === agent && e.options.length > 0)
}

/** 等到第 n 轮收尾（status 的终态广播：done / error）。release 先腾出页面槽再广播，所以此后可以立刻再发起 */
export async function settled(sse: SSECollector, n: number): Promise<void> {
  await waitFor(() => sse.events.filter((e) => e.type === 'status' && (e.state === 'done' || e.state === 'error')).length >= n, 20_000)
}

/** 服务端此刻的全部回复块：新连一个客户端读，不看旧连接可能还没同步到的状态 */
export async function serverReplies(pageId: string, cookie: string): Promise<ReplyBlock[]> {
  const p = await connectDoc(pageId, cookie)
  const blocks = replyBlocks(p)
  p.destroy()
  return blocks
}

