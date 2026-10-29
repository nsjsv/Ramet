// ---------- read_page / read_image / edit_page：AI 读写页面 ----------
// 空间成员能按行读，空间外的人读不到且看不出页是否存在（非成员 / 不存在 / 已回收同一个 404），
// 会话建立时 MCP 列表里就有这些工具（本地 agent 与 connector 同一条路：中心签凭证 + 中心端点）。
// 凭证走 Authorization: Bearer，不是登录 cookie（cookie 绝不能进 AI 子进程环境）。

import { afterAll, afterEach, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import sharp from 'sharp'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { closePool, getPool, initDb } from './db.js'
import { startServer } from './index.js'
import { hashPassword } from './auth.js'
import { PAGE_LINES_MAX, clearPageTokens, httpBaseFor, mintPageToken, pageToolServer } from './page-read.js'
import { loadDocFromDb, writeDocState } from './collab.js'
import { textOf } from './updates.js'
import { runConnector } from './connector/index.js'
import { ConnectorHub } from './agents/hub.js'
import { RemoteAgent } from './agents/remote-agent.js'
import { assertCanUse } from './agents/machine-access.js'
import type { Pool } from 'pg'
import { provisionConnector, truncateAll } from './test-helpers.js'

if (!process.env.DATABASE_URL) {
  throw new Error('需要 DATABASE_URL 指向测试库,例如 postgres://postgres:postgres@localhost:5432/ramet_test')
}

const READ_PAGE_MCP = fileURLToPath(new URL('./mcp/ramet.mjs', import.meta.url))
const FAKE_AGENT = fileURLToPath(new URL('./agents/fake-agent.mjs', import.meta.url))
// 图片用例要落盘上传，指向独立临时目录（uploads.ts 惰性读 UPLOAD_DIR）
const uploadDir = mkdtempSync(join(tmpdir(), 'ramet-page-read-uploads-'))
process.env.UPLOAD_DIR = uploadDir
// startServer 里 loadAgents 读 env，必须在起服前设好。中心默认不跑本机 agent（index.ts），本文件的本机用例要显式打开
process.env.RAMET_LOCAL_AGENTS = '1'
process.env.RAMET_AGENTS = JSON.stringify([{ id: 'fake', label: 'Fake', command: process.execPath, args: [FAKE_AGENT] }])

const pool = getPool()
await initDb(pool)
const s = await startServer(pool)
const base = `http://127.0.0.1:${s.port}`
// connector 用例需要显式的中心对外地址（connector 没有回环回落，未设 RAMET_PUBLIC_URL 时建会话直接报错）。本机用例用 base 当对外地址。
process.env.RAMET_PUBLIC_URL = base

afterEach(async () => {
  clearPageTokens()
  await truncateAll(pool)
})
afterAll(async () => {
  await s.close()
  await closePool()
  await rm(uploadDir, { recursive: true, force: true })
})

// ---------- 造数 ----------

async function insertUser(username: string, role = 'user'): Promise<string> {
  const id = randomUUID()
  await pool.query('INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)', [
    id, username, hashPassword('pw-123456'), role,
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

const post = (path: string, cookie: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T

const contentText = async (pageId: string): Promise<string> =>
  (await pool.query<{ t: string | null }>('SELECT content_text AS t FROM pages WHERE id = $1', [pageId])).rows[0]?.t ?? ''

const readText = (pageId: string, token: string, query = ''): Promise<Response> =>
  fetch(`${base}/api/pages/${pageId}/text${query}`, { headers: { authorization: `Bearer ${token}` } })

/** AI 写回：Bearer 凭证走 /api/pages/:id/edit（ops 数组） */
const editPage = (pageId: string, token: string, ops: unknown[]): Promise<Response> =>
  fetch(`${base}/api/pages/${pageId}/edit`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ops }),
  })

/** 上传一张 png（走真实上传端点：落盘 + 建 files 行 + 生成 webp 展示版） */
async function uploadImage(cookie: string, name = 'pic.png'): Promise<{ id: string; bytes: Buffer }> {
  const bytes = await sharp({ create: { width: 20, height: 12, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toBuffer()
  const form = new FormData()
  form.append('file', new File([bytes], name, { type: 'image/png' }))
  const res = await fetch(`${base}/api/files`, { method: 'POST', headers: { cookie }, body: form })
  expect(res.status).toBe(201)
  const meta = (await res.json()) as { id: string }
  return { id: meta.id, bytes }
}

/** 上传一个非图片文件 */
async function uploadText(cookie: string): Promise<string> {
  const form = new FormData()
  form.append('file', new File(['not an image'], 'notes.txt', { type: 'text/plain' }))
  const res = await fetch(`${base}/api/files`, { method: 'POST', headers: { cookie }, body: form })
  expect(res.status).toBe(201)
  const meta = (await res.json()) as { id: string }
  return meta.id
}

/** 直接把某人塞进空间，跳过邀请流程 */
async function joinSpace(spaceId: string, userId: string, role: 'member' | 'viewer'): Promise<void> {
  await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [spaceId, userId, role])
}

/** 往 fragment 末尾放一个纯文字段落 */
function paragraph(frag: Y.XmlFragment, text: string): Y.XmlElement {
  const p = new Y.XmlElement('paragraph')
  const t = new Y.XmlText()
  t.insert(0, text)
  p.insert(0, [t])
  frag.insert(frag.length, [p])
  return p
}

/** 把页面的文档状态整体写成给定形态 */
async function seedDoc(pageId: string, build: (frag: Y.XmlFragment) => void): Promise<void> {
  const doc = new Y.Doc()
  build(doc.getXmlFragment('prosemirror'))
  await writeDocState(pool, `page:${pageId}`, doc)
  doc.destroy()
}

/** 顶层块的可观察形态：nodeName、id、文本、直属 image 的 src */
type BlockView = { name: string; id: string | null; text: string; imageSrc: string | null }

function docBlocks(doc: Y.Doc): BlockView[] {
  const out: BlockView[] = []
  doc.getXmlFragment('prosemirror').forEach((child) => {
    if (!(child instanceof Y.XmlElement)) return
    let imageSrc: string | null = null
    child.forEach((inner) => {
      if (inner instanceof Y.XmlElement && inner.nodeName === 'image') imageSrc = inner.getAttribute('src') ?? ''
    })
    out.push({ name: child.nodeName, id: child.getAttribute('id') ?? null, text: textOf(child), imageSrc })
  })
  return out
}

/** 建号 → 登录 → 建空间与页面；lines 直接写进文档本身（读行的数据源是当前文档的文字）。
 *  标题写 pages.title，因为页面创建端点不收 title。 */
async function newUser(
  username: string,
  role = 'user',
  lines: string[] = [],
): Promise<{ id: string; cookie: string; spaceId: string; pageId: string }> {
  const id = await insertUser(username, role)
  const cookie = await login(username)
  const space = await json<{ id: string }>(await post('/api/spaces', cookie, { name: 's' }))
  const page = await json<{ id: string }>(await post('/api/pages', cookie, { space_id: space.id }))
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment('prosemirror')
  for (const line of lines) paragraph(frag, line)
  await writeDocState(pool, `page:${page.id}`, doc)
  doc.destroy()
  await pool.query('UPDATE pages SET title = $2 WHERE id = $1', [page.id, '目标页'])
  return { id, cookie, spaceId: space.id, pageId: page.id }
}

/** 带 cookie 的协同客户端 */
async function openDoc(pageId: string, cookie: string): Promise<HocuspocusProvider> {
  const wsProvider = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${s.port}/collab`,
    WebSocketPolyfill: class extends WebSocket {
      constructor(url: string) {
        super(url, undefined, { headers: { cookie } })
      }
    } as unknown as typeof WebSocket,
    quiet: true,
  })
  const provider = new HocuspocusProvider({ websocketProvider: wsProvider, name: `page:${pageId}`, token: 'test', quiet: true })
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const timer = setTimeout(() => reject(new Error('provider 同步超时')), 10_000)
  provider.on('synced', () => {
    clearTimeout(timer)
    resolve()
  })
  await promise
  return provider
}

function appendUserMessage(doc: Y.Doc, text: string): void {
  const frag = doc.getXmlFragment('prosemirror')
  const msg = new Y.XmlElement('user_message')
  const p = new Y.XmlElement('paragraph')
  const t = new Y.XmlText()
  t.insert(0, text)
  p.insert(0, [t])
  msg.insert(0, [p])
  frag.insert(frag.length, [msg])
}

/** 轮询等待：状态散在 HTTP 端点、数据库、子进程日志上，没有单一 promise 可 await */
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await pred()) return
    if (Date.now() > deadline) throw new Error('等待状态超时')
    await new Promise((r) => setTimeout(r, 50))
  }
}

const LINES = Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 行`)

// ---------- 成员按行读 ----------

test('成员能按行读：offset/limit 切片正确，行号从 1 开始', async () => {
  const alice = await newUser('reader', 'user', LINES)
  const token = mintPageToken(alice.id, 'fake')

  const all = await json<{ title: string; total: number; offset: number; limit: number; lines: string[] }>(
    await readText(alice.pageId, token),
  )
  expect(all).toMatchObject({ title: '目标页', total: 10, offset: 1, limit: 200 })
  expect(all.lines).toEqual(LINES)

  const middle = await json<{ offset: number; lines: string[] }>(await readText(alice.pageId, token, '?offset=4&limit=3'))
  expect(middle.offset).toBe(4)
  expect(middle.lines).toEqual(['第 4 行', '第 5 行', '第 6 行'])

  // limit 超上限截到 400，非法值回落缺省
  expect((await json<{ limit: number }>(await readText(alice.pageId, token, '?limit=9999'))).limit).toBe(PAGE_LINES_MAX)
  expect(await json<{ offset: number; limit: number }>(await readText(alice.pageId, token, '?offset=0&limit=-3')))
    .toMatchObject({ offset: 1, limit: 200 })
  // offset 越过末尾是空窗，不是错误
  expect((await json<{ lines: string[] }>(await readText(alice.pageId, token, '?offset=99'))).lines).toEqual([])
})

test('没有正文的页面返回空行，不是错误', async () => {
  const empty = await newUser('empty')
  const res = await readText(empty.pageId, mintPageToken(empty.id, 'fake'))
  expect(res.status).toBe(200)
  expect(await json<{ lines: string[]; total: number }>(res)).toMatchObject({ lines: [], total: 0 })
})

// ---------- 越权与不存在同响应 ----------

test('空间外的人读不到，且看不出页是否存在（非成员 / 不存在 / 已回收同一个 404）', async () => {
  const owner = await newUser('owner-v', 'user', LINES)
  const outsider = mintPageToken(await insertUser('outsider'), 'fake')

  const res = await readText(owner.pageId, outsider)
  expect(res.status).toBe(404)
  const body = await json<{ error: string }>(res)
  // 与页面根本不存在逐字节同响应，不透露存在性
  const missing = await readText(randomUUID(), outsider)
  expect(missing.status).toBe(404)
  expect(await json<{ error: string }>(missing)).toEqual(body)

  // 回收站里的页面与不存在同响应
  expect((await post(`/api/pages/${owner.pageId}/trash`, owner.cookie, {})).status).toBe(200)
  const trashed = await readText(owner.pageId, mintPageToken(owner.id, 'fake'))
  expect(trashed.status).toBe(404)
  expect(await json<{ error: string }>(trashed)).toEqual(body)

  // 坏凭证 / 无凭证一律 401
  expect((await fetch(`${base}/api/pages/${owner.pageId}/text`)).status).toBe(401)
  expect((await readText(owner.pageId, 'deadbeef')).status).toBe(401)
})

test('admin 不是成员读不到别人空间的页面（与其它页面读路径同口径）；登录 cookie 不算凭证', async () => {
  const owner = await newUser('owner-a', 'user', LINES)
  const admin = await newUser('root', 'admin')
  const res = await readText(owner.pageId, mintPageToken(admin.id, 'fake'))
  expect(res.status).toBe(404)
  // AI 子进程读得到环境变量，所以这个端点只认中心签发的 Bearer
  expect((await fetch(`${base}/api/pages/${owner.pageId}/text`, { headers: { cookie: admin.cookie } })).status).toBe(401)
})

// ---------- 会话建立时交付工具 ----------

test('本地 agent：发给会话的 MCP 用**本进程**的 node 与脚本路径（不发明文命令给远端）', async () => {
  // 本机 agent 的主人是全局 admin（machine-access.ts 的 assertLocalOwner），普通用户用不了
  const alice = await newUser('mcp-local', 'admin', LINES)
  const provider = await openDoc(alice.pageId, alice.cookie)
  appendUserMessage(provider.document, '报 MCP')
  // fake agent 把会话建 / 载时收到的 mcpServers 回显进回复（回复落文档 → content_text）
  expect((await post(`/api/pages/${alice.pageId}/continue`, alice.cookie, { agent: 'fake' })).status).toBe(202)
  await waitFor(async () => (await contentText(alice.pageId)).includes('mcp:ramet'))
  const text = await contentText(alice.pageId)
  provider.destroy()
  expect(text).toContain('ramet.mjs')
  expect(text).toContain(`${base} env:RAMET_PAGE_URL,RAMET_PAGE_TOKEN`)
  // 凭证值绝不落进正文
  expect(text).not.toMatch(/[0-9a-f]{64}/)
})

test('跨机只传凭证：WSS 的 new/load 里没有命令，只有中心地址 + 凭证', async () => {
  // `tools` 里只允许出现 grant，不能把整份 stdio 配置（含中心的 node 路径）发给 connector，命令由 connector 自己拼
  const hub = new ConnectorHub(pool)
  const sent: string[] = []
  const ws = {
    readyState: 1,
    send: (d: string) => sent.push(String(d)),
    close: () => undefined,
  } as unknown as WebSocket
  hub.attach({ id: 'conn-x', spaceId: 'sp-x', ownerId: null, name: 'box', defaultCwd: '/tmp', agents: [], ws })
  const agent = new RemoteAgent(hub, 'conn-x', 'omp')
  const grant = { mcp: { url: 'http://203.0.113.20', token: 'tok-123' } }
  const allowPool = { query: async () => ({ rowCount: 1, rows: [] }) } as unknown as Pool
  const pass = await assertCanUse(allowPool, { id: 'u-x' }, 'conn-x', 'agent')

  const newP = agent.newSession(pass, '/tmp', [grant])
  await waitFor(() => sent.length === 1)
  const newMsg = JSON.parse(sent[0]!) as { t: string; tools?: unknown }
  expect(newMsg.t).toBe('new')
  expect(JSON.stringify(newMsg.tools)).toBe(JSON.stringify([grant]))
  // 消息里不许出现任何命令字段（mcp: [{ name, command, args, env }]）
  expect(newMsg).not.toHaveProperty('mcp')
  expect(JSON.stringify(newMsg)).not.toContain('command')
  expect(JSON.stringify(newMsg)).not.toContain('execPath')

  const loadP = agent.loadSession(pass, 's-1', '/tmp', [grant])
  await waitFor(() => sent.length === 2)
  const loadMsg = JSON.parse(sent[1]!) as { t: string; tools?: unknown }
  expect(loadMsg.t).toBe('load')
  expect(loadMsg).not.toHaveProperty('mcp')

  hub.detach('conn-x', '测试结束')
  await expect(newP).rejects.toThrow(/测试结束/)
  await expect(loadP).rejects.toThrow(/测试结束/)
})

test('命令由拉起 AI 的进程自己拼：pageToolServer 用本进程 node 与这份代码旁的脚本', () => {
  const server = pageToolServer({ mcp: { url: 'http://203.0.113.20', token: 'tok' } })
  expect(server.name).toBe('ramet')
  expect(server.command).toBe(process.execPath)
  expect(server.args).toEqual([fileURLToPath(new URL('./mcp/ramet.mjs', import.meta.url))])
  expect(server.env).toEqual([
    { name: 'RAMET_PAGE_URL', value: 'http://203.0.113.20' },
    { name: 'RAMET_PAGE_TOKEN', value: 'tok' },
  ])
  // 本机可回落回环；connector 没配对外地址必须报错，不能静默用 127.0.0.1
  expect(httpBaseFor(undefined, 'http://127.0.0.1:3789')).toBe('http://127.0.0.1:3789')
  expect(httpBaseFor('http://203.0.113.20/', undefined)).toBe('http://203.0.113.20')
  expect(() => httpBaseFor(undefined, undefined)).toThrow(/RAMET_PUBLIC_URL/)
})

test('connector 同一条路：中心只给凭证，connector 用自己的 node/脚本拼命令（不碰数据库）', async () => {
  const alice = await newUser('mcp-remote', 'user', LINES)

  const logs: string[] = []
  const controller = new AbortController()
  const tokenFile = join(await mkdtemp(join(tmpdir(), 'ramet-page-read-')), 'connector.json')
  const { connectorId } = await provisionConnector(pool, { spaceId: alice.spaceId, ownerId: alice.id, name: 'mcpremote', cloud: base, tokenFile })
  const running = runConnector({
    cloud: base,
    name: 'mcpremote',
    cwd: process.cwd(),
    tokenFile,
    signal: controller.signal,
    log: (line) => logs.push(line),
  }).catch((err: unknown) => logs.push(`失败: ${String(err)}`))

  const remoteId = `c:${connectorId}:fake`
  await waitFor(async () =>
    (await json<Array<{ id: string }>>(await fetch(`${base}/api/agents`, { headers: { cookie: alice.cookie } }))).some(
      (a) => a.id === remoteId,
    ),
  )

  const provider = await openDoc(alice.pageId, alice.cookie)
  appendUserMessage(provider.document, '报 MCP')
  // prepare 走 session/new，continue 走 session/load，两条都要把凭证交到 connector 那台机器
  expect((await post(`/api/pages/${alice.pageId}/agent-prepare`, alice.cookie, { agent: remoteId })).status).toBe(202)
  await waitFor(() => logs.some((l) => l.includes('指令 new')))
  expect((await post(`/api/pages/${alice.pageId}/continue`, alice.cookie, { agent: remoteId })).status).toBe(202)
  await waitFor(async () => (await contentText(alice.pageId)).includes('mcp:ramet'))
  expect(await contentText(alice.pageId)).toContain(`${base} env:RAMET_PAGE_URL,RAMET_PAGE_TOKEN`)

  // connector 侧 agent 收到的 command 必须是 connector 本机 node 加这份代码旁的脚本（测试在同一台机器上，所以就是 process.execPath + 脚本路径）
  appendUserMessage(provider.document, '报 mcp 命令')
  // 文档里追加消息不触发生成，必须显式 continue（这一轮走 session/load），验证 load 也带 tools
  expect((await post(`/api/pages/${alice.pageId}/continue`, alice.cookie, { agent: remoteId })).status).toBe(202)
  await waitFor(async () => (await contentText(alice.pageId)).includes('cmd:'))
  const text = await contentText(alice.pageId)
  expect(text).toContain(`cmd:${process.execPath} args:${READ_PAGE_MCP}`)
  provider.destroy()
  // 凭证与 cookie 不落 connector 日志
  expect(logs.some((l) => l.includes('ramet_session'))).toBe(false)

  controller.abort()
  await running
})

// ---------- MCP 进程本身就是契约 ----------

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [READ_PAGE_MCP],
      env: { RAMET_PAGE_URL: base, RAMET_PAGE_TOKEN: token },
      stderr: 'inherit',
    }),
  )
  return client
}

/** MCP 结果 → 首段文本（callTool 的返回含 task 变体，运行时收窄到内容数组） */
function toolText(result: unknown): string {
  if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) {
    throw new Error('MCP 返回不是内容数组')
  }
  const first: unknown = result.content[0]
  if (!first || typeof first !== 'object' || !('text' in first) || typeof first.text !== 'string') {
    throw new Error('MCP 返回不是文本内容')
  }
  return first.text
}

test('MCP 进程：listTools 暴露页面内容 / 图片 / 知识中枢工具，callTool 按凭证读回中心的行；越权只回「没有找到」', async () => {
  const alice = await newUser('mcp-proc', 'user', LINES)

  const client = await mcpClient(mintPageToken(alice.id, 'fake'))
  const tools = await client.listTools()
  // 没绑页面、不能叫人的凭证：页面内容 + 图片 + 知识中枢工具，没有 run_agent（它要 canDispatch 且有别的 agent 可叫）
  expect(tools.tools.map((t) => t.name).sort()).toEqual(
    ['create_page', 'edit_page', 'move_page', 'read_image', 'read_page', 'rename_page', 'search_pages', 'trash_page'],
  )
  expect(tools.tools.find((t) => t.name === 'read_page')!.inputSchema).toMatchObject({ type: 'object', required: ['pageId'] })
  expect(tools.tools.find((t) => t.name === 'read_image')!.inputSchema).toMatchObject({ type: 'object', required: ['fileId'] })
  expect(tools.tools.find((t) => t.name === 'edit_page')!.inputSchema).toMatchObject({
    type: 'object',
    required: ['pageId', 'ops'],
  })

  const head = toolText(await client.callTool({ name: 'read_page', arguments: { pageId: alice.pageId, offset: 2, limit: 2 } }))
  expect(head).toContain('行 2–3/10')
  expect(head).toContain('2\t第 2 行')
  expect(head).toContain('3\t第 3 行')

  const stranger = await mcpClient(mintPageToken(await insertUser('mcp-outsider'), 'fake'))
  const denied = toolText(await stranger.callTool({ name: 'read_page', arguments: { pageId: alice.pageId } }))
  expect(denied).toContain('没有找到页面')

  await client.close()
  await stranger.close()
})

/** MCP 结果 → 首段图片内容块（read_image 回 base64 + mime） */
function toolImage(result: unknown): { data: string; mimeType: string } {
  if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) {
    throw new Error('MCP 返回不是内容数组')
  }
  const first: unknown = result.content[0]
  if (
    !first || typeof first !== 'object' ||
    !('type' in first) || first.type !== 'image' ||
    !('data' in first) || typeof first.data !== 'string' ||
    !('mimeType' in first) || typeof first.mimeType !== 'string'
  ) {
    throw new Error('MCP 返回不是图片内容块')
  }
  return { data: first.data, mimeType: first.mimeType }
}

// ---------- read_image：AI 取图 ----------

test('read_image：成员凭证拿到图片内容块；坏凭证 401；不是图片或不存在回「没有这张图」', async () => {
  const alice = await newUser('img-owner')
  const token = mintPageToken(alice.id, 'fake')
  const { id, bytes } = await uploadImage(alice.cookie, '一张图.png')

  // 有 webp 展示版就发 webp
  const client = await mcpClient(token)
  const img = toolImage(await client.callTool({ name: 'read_image', arguments: { fileId: id } }))
  expect(img.mimeType).toBe('image/webp')
  // 展示版尺寸与参数见 files.ts DISPLAY_*，这里只断言能解出 webp 且不是原 png 字节
  const meta = await sharp(Buffer.from(img.data, 'base64')).metadata()
  expect(meta.format).toBe('webp')
  expect(Buffer.from(img.data, 'base64').equals(bytes)).toBe(false)

  // 不是图片与不存在刻意同响应
  const textId = await uploadText(alice.cookie)
  const notImage = toolText(await client.callTool({ name: 'read_image', arguments: { fileId: textId } }))
  expect(notImage).toContain('没有这张图')
  const missing = toolText(await client.callTool({ name: 'read_image', arguments: { fileId: randomUUID() } }))
  expect(missing).toContain('没有这张图')
  await client.close()

  // 端点层：坏凭证 401
  expect((await fetch(`${base}/api/files/${id}/ai`)).status).toBe(401)
  expect((await fetch(`${base}/api/files/${id}/ai`, { headers: { authorization: 'Bearer deadbeef' } })).status).toBe(401)
  const ok = (await (await fetch(`${base}/api/files/${id}/ai`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
    mime: string
    data: string
  }
  expect(ok.mime).toBe('image/webp')
  expect(Buffer.from(ok.data, 'base64').length).toBeGreaterThan(0)
})

test('read_image：没有 webp 展示版时发原文件', async () => {
  const alice = await newUser('img-gif')
  const token = mintPageToken(alice.id, 'fake')
  // gif 不生成 webp 展示版（files.ts 为动图保留原文件）
  const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary')
  const form = new FormData()
  form.append('file', new File([gif], 'a.gif', { type: 'image/gif' }))
  const res = await fetch(`${base}/api/files`, { method: 'POST', headers: { cookie: alice.cookie }, body: form })
  expect(res.status).toBe(201)
  const gifMeta = (await res.json()) as { id: string }

  const body = (await (
    await fetch(`${base}/api/files/${gifMeta.id}/ai`, { headers: { authorization: `Bearer ${token}` } })
  ).json()) as { mime: string; data: string }
  expect(body.mime).toBe('image/gif')
  expect(Buffer.from(body.data, 'base64').equals(gif)).toBe(true)
})

test('read_image：超过 1.5MB 拒绝并说明太大（不把大图塞进上下文）', async () => {
  const alice = await newUser('img-big')
  const token = mintPageToken(alice.id, 'fake')
  // 直接落盘 + 建行，绕开上传（上传的 png 带 webp 展示版，压不到这么大）；没有 .webp 端点就发原文件，命中体积闸
  const bigId = randomUUID()
  await writeFile(join(uploadDir, bigId), Buffer.alloc(2 * 1024 * 1024, 3))
  await pool.query('INSERT INTO files (id, name, mime, size, content_hash) VALUES ($1, $2, $3, $4, $5)', [
    bigId, 'big.png', 'image/png', 2 * 1024 * 1024, randomUUID(),
  ])
  const res = await fetch(`${base}/api/files/${bigId}/ai`, { headers: { authorization: `Bearer ${token}` } })
  expect(res.status).toBe(413)
  expect(await json<{ error: string }>(res)).toMatchObject({ error: expect.stringContaining('太大') })
  // MCP 侧回一句给 AI 看的话，不抛异常
  const client = await mcpClient(token)
  expect(toolText(await client.callTool({ name: 'read_image', arguments: { fileId: bigId } }))).toContain('太大')
  await client.close()
})

// ---------- edit_page：AI 按原文写回文档 ----------

/** 一页的三段文字 */
const DOC_LINES = ['第一段', '第二段', '第三段']

test('edit_page：唯一的 old 换成 new，文档其它部分还在', async () => {
  const alice = await newUser('edit-replace', 'user', DOC_LINES)
  const token = mintPageToken(alice.id, 'fake')

  const res = await editPage(alice.pageId, token, [{ op: 'replace', old: '第二段', new: '改过的第二段' }])
  expect(res.status).toBe(200)

  // 从 DB 重建，确认写回进了持久层
  const blocks = docBlocks(await loadDocFromDb(pool, `page:${alice.pageId}`))
  expect(blocks.map((b) => b.text)).toEqual(['第一段', '改过的第二段', '第三段'])
  expect(blocks).toHaveLength(3)
})

test('edit_page：old 不存在或出现两次 → 文档不变；出现两次时提示带上更多上下文', async () => {
  const alice = await newUser('edit-atomic', 'user', ['重复的一句', '中间', '重复的一句'])
  const token = mintPageToken(alice.id, 'fake')
  const snapshot = docBlocks(await loadDocFromDb(pool, `page:${alice.pageId}`))

  const missing = await editPage(alice.pageId, token, [{ op: 'replace', old: '不存在的一句', new: 'X' }])
  expect(missing.status).toBe(404)
  expect(await json<{ error: string }>(missing)).toMatchObject({ error: expect.stringContaining('没找到') })

  const twice = await editPage(alice.pageId, token, [{ op: 'replace', old: '重复的一句', new: 'X' }])
  expect(twice.status).toBe(400)
  expect(await json<{ error: string }>(twice)).toMatchObject({ error: expect.stringContaining('出现了 2 次') })

  // 两次失败后文档都没动
  expect(docBlocks(await loadDocFromDb(pool, `page:${alice.pageId}`))).toEqual(snapshot)

  // 带上更多上下文就唯一了
  const wider = await editPage(alice.pageId, token, [{ op: 'replace', old: '重复的一句\n中间', new: '换掉了' }])
  expect(wider.status).toBe(200)
  expect(docBlocks(await loadDocFromDb(pool, `page:${alice.pageId}`)).map((b) => b.text)).toEqual(['换掉了', '重复的一句'])
})

test('edit_page：old 为空则追加到文末', async () => {
  const alice = await newUser('edit-append', 'user', DOC_LINES)
  const token = mintPageToken(alice.id, 'fake')

  const res = await editPage(alice.pageId, token, [{ op: 'replace', old: '', new: '追加的行' }])
  expect(res.status).toBe(200)

  const blocks = docBlocks(await loadDocFromDb(pool, `page:${alice.pageId}`))
  expect(blocks.map((b) => b.text)).toEqual([...DOC_LINES, '追加的行'])
})

test('edit_page：new 里一行 image:<uuid> 变成图片节点，src 是 /api/files/<id> 不带 /display', async () => {
  const alice = await newUser('edit-image', 'user', DOC_LINES)
  const token = mintPageToken(alice.id, 'fake')
  const { id } = await uploadImage(alice.cookie)

  const res = await editPage(alice.pageId, token, [{ op: 'replace', old: '第二段', new: `配图：\nimage:${id}` }])
  expect(res.status).toBe(200)

  const blocks = docBlocks(await loadDocFromDb(pool, `page:${alice.pageId}`))
  const image = blocks.find((b) => b.imageSrc !== null)!
  expect(image.imageSrc).toBe(`/api/files/${id}`)
  expect(image.imageSrc).not.toContain('/display')

  // 不存在的图片 id 整次失败，文档不动
  const before = docBlocks(await loadDocFromDb(pool, `page:${alice.pageId}`))
  const bad = await editPage(alice.pageId, token, [{ op: 'replace', old: '第三段', new: `image:${randomUUID()}` }])
  expect(bad.status).toBe(404)
  expect(docBlocks(await loadDocFromDb(pool, `page:${alice.pageId}`))).toEqual(before)
})

test('edit_page：new 里一行 page:<uuid> 落成页面提及 chip，替换时不弄丢旁边的芯片', async () => {
  const alice = await newUser('edit-mention', 'user', DOC_LINES)
  const token = mintPageToken(alice.id, 'fake')
  const target = await newUser('edit-mention-target')
  // 第二段里放一颗页面提及芯片，前后各有一段文字
  await seedDoc(alice.pageId, (frag) => {
    const p = new Y.XmlElement('paragraph')
    frag.insert(0, [p])
    const head = new Y.XmlText()
    p.insert(0, [head])
    head.insert(0, '前面 ')
    const chip = new Y.XmlElement('page_mention')
    chip.setAttribute('pageId', target.pageId)
    chip.setAttribute('title', '目标页')
    p.insert(p.length, [chip])
    const tail = new Y.XmlText()
    p.insert(p.length, [tail])
    tail.insert(0, ' 后面')
  })
  // AI 读到的芯片文字是 page:<id>
  expect((await json<{ lines: string[] }>(await readText(alice.pageId, token))).lines).toEqual([`前面 page:${target.pageId} 后面`])

  // 只换芯片后面那半句，芯片和前半句必须留下
  const res = await editPage(alice.pageId, token, [{ op: 'replace', old: '后面', new: '换过的尾' }])
  expect(res.status).toBe(200)
  const lines = (await json<{ lines: string[] }>(await readText(alice.pageId, token))).lines
  expect(lines[0]).toBe(`前面 page:${target.pageId} 换过的尾`)
  const frag = (await loadDocFromDb(pool, `page:${alice.pageId}`)).getXmlFragment('prosemirror')
  let mentions = 0
  frag.forEach((n) => n instanceof Y.XmlElement && n.forEach((c) => c instanceof Y.XmlElement && c.nodeName === 'page_mention' && mentions++))
  expect(mentions).toBe(1)

  const add = await editPage(alice.pageId, token, [{ op: 'replace', old: '换过的尾', new: `看 page:${target.pageId}` }])
  expect(add.status).toBe(200)
  expect((await json<{ lines: string[] }>(await readText(alice.pageId, token))).lines[0]).toContain(`看 page:${target.pageId}`)
})

test('edit_page：read_page 读到的整篇文字就是 old 的匹配文本（与自带 edit 一样先读后改）', async () => {
  const alice = await newUser('edit-roundtrip', 'user', DOC_LINES)
  const token = mintPageToken(alice.id, 'fake')

  const read = await json<{ lines: string[] }>(await readText(alice.pageId, token))
  const old = read.lines[1]! // 行号只给人看，old 用行文字
  const res = await editPage(alice.pageId, token, [{ op: 'replace', old, new: '从读到的原文改的' }])
  expect(res.status).toBe(200)
  expect((await json<{ lines: string[] }>(await readText(alice.pageId, token))).lines[1]).toBe('从读到的原文改的')
})

test('edit_page：文档里有不占文字的空块（hr/空段落）时，old 命中的是它真正所在的那块', async () => {
  const alice = await newUser('edit-empty-blocks', 'user')
  const token = mintPageToken(alice.id, 'fake')
  // hr / 空段落这类不占文字的块不进 span，spans 下标与 fragment 下标就此错开。定位若把 spans 下标当 fragment 下标用，会改到前面的块、丢掉 hr。
  await seedDoc(alice.pageId, (frag) => {
    const mk = (name: string, text: string): void => {
      const el = new Y.XmlElement(name)
      const t = new Y.XmlText()
      t.insert(0, text)
      el.insert(0, [t])
      frag.insert(frag.length, [el])
    }
    mk('paragraph', '第一行')
    frag.insert(frag.length, [new Y.XmlElement('hr')]) // 无文字块
    frag.insert(frag.length, [new Y.XmlElement('paragraph')]) // 空段落
    mk('heading', '目标标题')
    mk('paragraph', '结尾行')
  })

  // new 是多块结构，走 replaceBlocks（按父 fragment 下标整块换）
  const res = await editPage(alice.pageId, token, [{ op: 'replace', old: '目标标题', new: '改过的标题\n\n新增段' }])
  expect(res.status).toBe(200)

  const blocks = docBlocks(await loadDocFromDb(pool, `page:${alice.pageId}`))
  expect(blocks.map((b) => b.text)).toEqual(['第一行', '', '', '改过的标题', '新增段', '结尾行'])
  // 只有被覆盖的那块（heading）被 new 解析结果替换，其余原样留下。new 是纯文本（没写 `#`），落成 paragraph
  expect(blocks.map((b) => b.name)).toEqual(['paragraph', 'hr', 'paragraph', 'paragraph', 'paragraph', 'paragraph'])
})

test('edit_page：空 ops 400、未知 op 400、坏凭证 401', async () => {
  const alice = await newUser('edit-guards', 'user', DOC_LINES)
  const token = mintPageToken(alice.id, 'fake')

  expect((await editPage(alice.pageId, token, [])).status).toBe(400)
  // 未知 op 或形状不对
  expect((await editPage(alice.pageId, token, [{ op: 'replace_block', blockId: 'x', text: 'y' }])).status).toBe(400)
  expect((await editPage(alice.pageId, token, [{ op: 'replace', old: 5, new: 'y' }])).status).toBe(400)
  // 坏凭证 / 缺凭证
  expect((await editPage(alice.pageId, 'deadbeef', [{ op: 'replace', old: '第一段', new: 'x' }])).status).toBe(401)
  const noAuth = await fetch(`${base}/api/pages/${alice.pageId}/edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ops: [{ op: 'replace', old: '第一段', new: 'x' }] }),
  })
  expect(noAuth.status).toBe(401)
  expect((await json<{ lines: string[] }>(await readText(alice.pageId, token))).lines).toEqual(DOC_LINES)
})

test('edit_page：viewer 403、非成员 404（与不存在同响应）', async () => {
  const owner = await newUser('edit-owner', 'user', DOC_LINES)
  const viewer = await newUser('edit-viewer')
  const stranger = await newUser('edit-stranger')
  await joinSpace(owner.spaceId, viewer.id, 'viewer')

  const op = [{ op: 'replace', old: '第一段', new: 'AI 写的字' }]
  // viewer 能看见但不能改
  expect((await editPage(owner.pageId, mintPageToken(viewer.id, 'fake'), op)).status).toBe(403)
  // 非成员与页面不存在逐字节同响应
  const denied = await editPage(owner.pageId, mintPageToken(stranger.id, 'fake'), op)
  expect(denied.status).toBe(404)
  const missing = await editPage(randomUUID(), mintPageToken(stranger.id, 'fake'), op)
  expect(missing.status).toBe(404)
  expect(await json<{ error: string }>(missing)).toEqual(await json<{ error: string }>(denied))
  // 两种失败都没写入
  expect((await json<{ lines: string[] }>(await readText(owner.pageId, mintPageToken(owner.id, 'fake')))).lines).toEqual(DOC_LINES)
})

test('edit_page：MCP 进程端到端写回（凭证 → 工具 → 文档），越权只回写回失败', async () => {
  const alice = await newUser('edit-mcp', 'user', DOC_LINES)
  const client = await mcpClient(mintPageToken(alice.id, 'fake'))

  const okText = toolText(await client.callTool({ name: 'edit_page', arguments: { pageId: alice.pageId, ops: [{ op: 'replace', old: '第二段', new: '来自 MCP' }] } }))
  expect(okText).toContain('已写回')
  const blocks = docBlocks(await loadDocFromDb(pool, `page:${alice.pageId}`))
  expect(blocks[1]!.text).toBe('来自 MCP')

  // 越权时工具要回写回失败，不能让 AI 以为写成了
  const owner = await newUser('edit-mcp-owner')
  const outsider = await mcpClient(mintPageToken(await insertUser('edit-mcp-outsider'), 'fake'))
  const denied = await outsider.callTool({ name: 'edit_page', arguments: { pageId: owner.pageId, ops: [{ op: 'replace', old: '', new: 'x' }] } })
  expect(toolText(denied)).toContain('写回失败')
  expect(denied).toMatchObject({ isError: true })
  expect(docBlocks(await loadDocFromDb(pool, `page:${owner.pageId}`))).toEqual([])

  await client.close()
  await outsider.close()
})
