// ---------- 浏览器确认配对：agents/pairing.ts（中心）+ connector/pair.ts（connector）+ /api/connect/:code* ----------
// 链接一次性、只在发起它的连接还开着时有效；token 只经那条 ws 下发，REST 响应里没有。
// 确认门槛（viewer 403 / 非成员 404 / owner → approved、member → pending）见 member-connect.test.ts。

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { PairingDesk } from './agents/pairing.js'
import type { PairReply } from './agents/protocol.js'
import {
  agentsList,
  base,
  joinPageSpace,
  openPairRequest,
  pageOwnership,
  pool,
  postJson,
  setupPage,
  waitFor,
} from './agents/test-kit.js'
import { readConnectorConfig } from './connector/access.js'
import { runConnector } from './connector/index.js'
import { cloudOrigin, needsPair } from './connector/pair.js'

const CONNECTOR_CLI = fileURLToPath(new URL('./connector/cli.ts', import.meta.url))

const get = (path: string, cookie?: string): Promise<Response> => fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} })

async function tokenFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'ramet-pair-')), 'connector.json')
}

/** 等 connector 把链接打出来，取链接里的码 */
async function linkCode(logs: string[]): Promise<string> {
  await waitFor(() => logs.some((l) => l.includes('/connect/')))
  const url = logs.find((l) => l.includes('/connect/'))!.trim()
  expect(url).toMatch(new RegExp(`^${base}/connect/[A-Z2-9]{4}-[A-Z2-9]{4}$`))
  return url.slice(url.lastIndexOf('/') + 1)
}

test('全流程：没有配置的 connector 打印链接 → 浏览器看到机器信息 → 确认 → token 经 ws 落盘、连上中心；链接随即作废', async () => {
  const { cookie, pageId } = await setupPage()
  const { spaceId, ownerId } = await pageOwnership(pageId)
  const file = await tokenFile()
  const logs: string[] = []
  const controller = new AbortController()
  const running = runConnector({ cloud: base, name: 'pairbox', cwd: process.cwd(), tokenFile: file, signal: controller.signal, log: (l) => logs.push(l) })
    .catch((err: unknown) => logs.push(`失败: ${String(err)}`))
  const code = await linkCode(logs)

  // 确认页要登录；码的大小写、连字符都容忍
  expect((await get(`/api/connect/${code}`)).status).toBe(401)
  const info = await (await get(`/api/connect/${code.replace('-', '').toLowerCase()}`, cookie)).json()
  expect(info).toMatchObject({ code, name: 'pairbox', defaultCwd: process.cwd() })
  expect((info as { agents: Array<{ id: string }> }).agents.map((a) => a.id)).toContain('fake')

  const res = await postJson(`/api/connect/${code}/confirm`, cookie, { spaceId })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { connectorId: string }
  expect(body).toMatchObject({ spaceId, status: 'approved' })
  expect(Object.keys(body)).not.toContain('token') // token 只走 connector 发起的那条 ws

  await waitFor(() => logs.some((l) => l.includes('已连上中心')))
  // 主人 = 确认的人，钉进本地配置
  expect(readConnectorConfig(file)).toMatchObject({ cloud: cloudOrigin(base), ownerId })
  await waitFor(async () => (await agentsList(cookie)).some((a) => a.id === `c:${body.connectorId}:fake`))

  // 一次性：再看 / 再确认 / 拒绝都是 404，库里只有一台
  expect((await get(`/api/connect/${code}`, cookie)).status).toBe(404)
  expect((await postJson(`/api/connect/${code}/confirm`, cookie, { spaceId })).status).toBe(404)
  expect((await postJson(`/api/connect/${code}/reject`, cookie)).status).toBe(404)
  expect((await pool.query('SELECT 1 FROM connectors')).rowCount).toBe(1)

  controller.abort()
  await running
})

test('拒绝：connector 报错退出、不写配置；链接作废', async () => {
  const { cookie, pageId } = await setupPage()
  const { spaceId } = await pageOwnership(pageId)
  const file = await tokenFile()
  const logs: string[] = []
  // 断言先挂上：拒绝一到 runConnector 就 reject，晚挂会被当成未处理的 rejection
  const exited = expect(runConnector({ cloud: base, name: 'nobox', tokenFile: file, log: (l) => logs.push(l) })).rejects.toThrow(
    '已在浏览器里拒绝这次配对',
  )
  const code = await linkCode(logs)
  expect((await postJson(`/api/connect/${code}/reject`, cookie)).status).toBe(200)
  await exited
  expect(readConnectorConfig(file)).toBeNull()
  expect((await postJson(`/api/connect/${code}/confirm`, cookie, { spaceId })).status).toBe(404)
  expect((await pool.query('SELECT 1 FROM connectors')).rowCount).toBe(0)
})

test('connector 断开即作废：之后看 / 确认都是 404，不建行', async () => {
  const { cookie, pageId } = await setupPage()
  const { spaceId } = await pageOwnership(pageId)
  const req = await openPairRequest('dropbox')
  expect((await get(`/api/connect/${req.code}`, cookie)).status).toBe(200)
  req.ws.close()
  await waitFor(async () => (await get(`/api/connect/${req.code}`, cookie)).status === 404)
  expect((await postJson(`/api/connect/${req.code}/confirm`, cookie, { spaceId })).status).toBe(404)
  expect((await pool.query('SELECT 1 FROM connectors')).rowCount).toBe(0)
})

test('并发两次确认只有一次生效', async () => {
  const { cookie: alice, pageId } = await setupPage()
  const bob = await joinPageSpace(pageId, 'bob', { role: 'member' })
  const { spaceId } = await pageOwnership(pageId)
  const req = await openPairRequest('racebox')
  const results = await Promise.all([alice, bob].map((c) => postJson(`/api/connect/${req.code}/confirm`, c, { spaceId })))
  expect(results.map((r) => r.status).sort()).toEqual([200, 404])
  expect((await pool.query('SELECT 1 FROM connectors')).rowCount).toBe(1)
  expect((await req.next())?.t).toBe('paired')
})

test('过期：到点 connector 收到 pair-error，链接作废；申请里的字段按上限截断', async () => {
  const desk = new PairingDesk(pool, undefined, 300)
  const wss = new WebSocketServer({ port: 0 })
  wss.on('connection', (ws) => desk.open(ws))
  await once(wss, 'listening')
  const ws = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`)
  const frames: PairReply[] = []
  ws.on('message', (d) => frames.push(JSON.parse(String(d)) as PairReply))
  await once(ws, 'open')
  ws.send(JSON.stringify({ t: 'pair-request', name: 'x'.repeat(500), defaultCwd: '/', agents: 'nope' }))
  await waitFor(() => frames.length === 1)
  const link = frames[0]!
  if (link.t !== 'pair-link') throw new Error(JSON.stringify(link))
  expect(desk.peek(link.code)).toMatchObject({ name: 'x'.repeat(80), agents: [] })

  await waitFor(() => frames.length === 2, 3_000)
  expect(frames[1]).toEqual({ t: 'pair-error', message: '配对链接已过期，请重新执行' })
  expect(desk.peek(link.code)).toBeNull()
  expect(await desk.confirm(link.code, 'any-space', 'any-user')).toEqual({ ok: false, reason: 'gone' })
  ws.close()
  wss.close()
})

test('needsPair：没配置、换了中心 → 要配；同一中心、老配置没记中心 → 不配', () => {
  const origin = cloudOrigin('https://a.example')
  expect(needsPair(null, origin)).toBe(true)
  expect(needsPair({ token: 't', cloud: origin }, origin)).toBe(false)
  expect(needsPair({ token: 't', cloud: 'wss://b.example' }, origin)).toBe(true)
  expect(needsPair({ token: 't', cloud: '' }, origin)).toBe(false)
})

test('CLI：旧参数 --pair 给出新用法提示并以 1 退出', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', CONNECTOR_CLI, 'run', '--cloud', base, '--pair', 'OLDCODE'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let err = ''
  child.stderr.on('data', (b: Buffer) => (err += b.toString()))
  const [code] = (await once(child, 'exit')) as [number | null]
  expect(code).toBe(1)
  expect(err).toContain('配对码已取消')
})
