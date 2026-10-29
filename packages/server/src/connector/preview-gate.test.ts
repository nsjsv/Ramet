/* ---------- connector 第二道闸 × 端口预览（真 runConnector + 假中心）----------
 * 预览的七种帧（port-share / port-unshare / http-req / http-body / ws-open / ws-msg / ws-close）都是 machine 范围的驱动帧：
 * 没带署名 / 陌生人 / 只授权了 agent / 授权过期的一律拒绝，回报但不执行，本机端口一个字节都不会被碰到。
 * 授权一没（grant-revoked / access-reduced），他共享的预览当场撤掉；重新 welcome 时登记清空。 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { CONNECTOR_TOKEN_HEADER, type ConnMsg } from '../agents/protocol.js'
import type { MachineScope } from '../agents/machine-access.js'
import { addLocalGrant, type ConnectorConfig } from './access.js'
import { runConnector } from './index.js'

const HOUR = 3_600_000
const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString()
const grant = (userId: string, scopes: MachineScope[], offsetMs = HOUR): NonNullable<ConnectorConfig['grants']>[number] => ({ userId, scopes, expiresAt: iso(offsetMs) })

type Fixture = {
  dir: string
  file: string
  inbox: ConnMsg[]
  send: (msg: Record<string, unknown>) => void
  /** 等第 n 次 hello（每次连接一次）并等 connector 处理完 welcome */
  hello: (n: number) => Promise<void>
  dropSocket: () => void
  ask: (msg: Record<string, unknown> & { rid: string }) => Promise<ConnMsg>
  find: (pred: (m: ConnMsg) => boolean, ms?: number) => Promise<ConnMsg>
  stop: () => Promise<void>
}
const fixtures: Fixture[] = []
const uppers: Server[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.stop()
  for (const u of uppers.splice(0)) {
    u.closeAllConnections()
    await new Promise<void>((r) => u.close(() => r()))
  }
})

async function start(config: ConnectorConfig): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'ramet-pgate-'))
  const file = join(dir, 'connector.json')
  writeFileSync(file, JSON.stringify(config))
  const logs: string[] = []
  const inbox: ConnMsg[] = []
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((r) => wss.once('listening', r))
  let current: WebSocket | null = null
  let hellos = 0
  wss.on('connection', (ws, req) => {
    expect(req.headers[CONNECTOR_TOKEN_HEADER]).toBe(config.token)
    current = ws
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ConnMsg
      inbox.push(msg)
      if (msg.t === 'hello') {
        hellos += 1
        ws.send(JSON.stringify({ t: 'welcome', connectorId: 'c-pgate', ownerId: config.ownerId, resume: [], drop: [] }))
      }
    })
  })
  const controller = new AbortController()
  const done = runConnector({
    cloud: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    name: 'pgate',
    cwd: dir,
    tokenFile: file,
    signal: controller.signal,
    log: (line) => logs.push(line),
    loadPty: async () => null,
  })
  const until = async <T>(fn: () => T | undefined | false, ms = 10_000): Promise<T> => {
    const deadline = Date.now() + ms
    for (;;) {
      const v = fn()
      if (v) return v
      if (Date.now() > deadline) throw new Error(`等待超时：${JSON.stringify(inbox.slice(-6))}`)
      await new Promise((r) => setTimeout(r, 15))
    }
  }
  const f: Fixture = {
    dir,
    file,
    inbox,
    send: (msg) => current!.send(JSON.stringify(msg)),
    hello: async (n) => {
      await until(() => hellos >= n)
      await until(() => logs.filter((l) => l.startsWith('已连上中心')).length >= n)
    },
    dropSocket: () => current!.terminate(),
    ask: async (msg) => {
      const before = inbox.length
      current!.send(JSON.stringify(msg))
      return until(() => inbox.slice(before).find((m) => (m.t === 'res' || m.t === 'err') && m.rid === msg.rid))
    },
    find: (pred, ms) => {
      const before = inbox.length
      return until(() => inbox.slice(before).find(pred), ms)
    },
    stop: async () => {
      controller.abort()
      await done.catch(() => undefined)
      for (const c of wss.clients) c.terminate()
      await new Promise<void>((r) => wss.close(() => r()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
  fixtures.push(f)
  await f.hello(1)
  return f
}

/** 本机的"开发服务器"：数被打到几次 */
async function upstream(): Promise<{ port: number; hits: () => number }> {
  let hits = 0
  const server = createServer((_req, res) => {
    hits += 1
    res.end('dev server')
  })
  server.on('upgrade', (_req, socket) => {
    hits += 1
    socket.destroy()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  uppers.push(server)
  return { port: (server.address() as AddressInfo).port, hits: () => hits }
}

const frames = (pv: string, actor: unknown, port: number): Array<Record<string, unknown>> => {
  const who = actor === undefined ? {} : { actor }
  return [
    { t: 'port-share', rid: 'r-share', previewId: pv, port, ...who },
    { t: 'port-unshare', rid: 'r-unshare', previewId: pv, ...who },
    { t: 'http-req', previewId: pv, reqId: 'q', method: 'GET', path: '/', headers: [], hasBody: false, ...who },
    { t: 'http-body', previewId: pv, reqId: 'q', chunk: 'eA==', ...who },
    { t: 'ws-open', previewId: pv, wsId: 'w', path: '/ws', headers: [], protocols: [], ...who },
    { t: 'ws-msg', previewId: pv, wsId: 'w', data: 'x', binary: false, ...who },
    { t: 'ws-close', previewId: pv, wsId: 'w', ...who },
  ]
}

test('七种预览帧 × {没带署名 / 空 / 数字 / 陌生人 / 只授权 agent / 授权过期}：全部被拒，本机端口一次都没被碰，没有任何登记', async () => {
  const up = await upstream()
  const f = await start({
    token: 'tok-pgate',
    cloud: '',
    ownerId: 'owner',
    grants: [grant('agent-only', ['agent']), grant('late', ['agent', 'machine'], -HOUR)],
  })
  // 主人先共享一个预览，让"陌生人冒用别人的预览"也有东西可冒用
  expect(await f.ask({ t: 'port-share', rid: 'own', actor: 'owner', previewId: 'pv-owner', port: up.port })).toMatchObject({ t: 'res', project: { op: 'port-share' } })

  const bad: unknown[] = [undefined, '', 42, 'stranger', 'agent-only', 'late']
  for (const actor of bad) {
    for (const [i, frame] of frames('pv-owner', actor, up.port).entries()) {
      const before = f.inbox.length
      f.send(frame)
      await new Promise((r) => setTimeout(r, 30))
      const replies = f.inbox.slice(before)
      const label = `${String(actor)} / ${String(frame.t)}`
      if (i < 2) expect(replies, label).toMatchObject([{ t: 'err', rid: frame.rid, code: 'forbidden' }])
      else if (frame.t === 'http-req') expect(replies, label).toMatchObject([{ t: 'http-fail', reqId: 'q', status: 403 }])
      else if (frame.t === 'ws-open') expect(replies, label).toMatchObject([{ t: 'ws-end', wsId: 'w', opened: false }])
      else expect(replies, label).toEqual([]) // 体 / 消息 / 关闭：静默丢弃
    }
  }
  expect(up.hits()).toBe(0)
  // 陌生人没能撤掉主人的预览，也没能登记自己的
  expect(f.inbox.some((m) => m.t === 'res' && m.rid === 'r-share')).toBe(false)
  f.send({ t: 'http-req', actor: 'owner', previewId: 'pv-owner', reqId: 'real', method: 'GET', path: '/', headers: [], hasBody: false })
  expect(await f.find((m) => m.t === 'http-res' && m.reqId === 'real')).toMatchObject({ status: 200 })
  expect(up.hits()).toBe(1)
})

test('machine 范围的授权人可以共享并转发；只授权 agent 不行；两个 scope 互不蕴含', async () => {
  const up = await upstream()
  const f = await start({ token: 'tok-pgate', cloud: '', ownerId: 'owner', grants: [grant('ally', ['machine']), grant('agent-only', ['agent'])] })
  expect(await f.ask({ t: 'port-share', rid: 's1', actor: 'ally', previewId: 'pv-ally', port: up.port })).toMatchObject({ t: 'res' })
  expect(await f.ask({ t: 'port-share', rid: 's2', actor: 'agent-only', previewId: 'pv-x', port: up.port })).toMatchObject({ t: 'err', code: 'forbidden' })
  f.send({ t: 'http-req', actor: 'ally', previewId: 'pv-ally', reqId: 'a1', method: 'GET', path: '/', headers: [], hasBody: false })
  expect(await f.find((m) => m.t === 'http-res' && m.reqId === 'a1')).toMatchObject({ status: 200 })
  // 主人（哪怕有权）也不能冒用 ally 的预览：署名必须是记录里的共享人
  f.send({ t: 'http-req', actor: 'owner', previewId: 'pv-ally', reqId: 'a2', method: 'GET', path: '/', headers: [], hasBody: false })
  expect(await f.find((m) => m.t === 'http-fail' && m.reqId === 'a2')).toMatchObject({ status: 403 })
  // 但主人能停止别人共享的预览；ally 的别人（agent-only）不能
  expect(await f.ask({ t: 'port-unshare', rid: 'u1', actor: 'owner', previewId: 'pv-ally' })).toMatchObject({ t: 'res' })
})

test('grant-revoked：共享人的预览当场撤掉（本机名单也删了他）；对机器主人无效；只删不加', async () => {
  const up = await upstream()
  const f = await start({ token: 'tok-pgate', cloud: '', ownerId: 'owner', grants: [grant('ally', ['machine'])] })
  await f.ask({ t: 'port-share', rid: 's1', actor: 'ally', previewId: 'pv-ally', port: up.port })
  await f.ask({ t: 'port-share', rid: 's2', actor: 'owner', previewId: 'pv-owner', port: up.port })
  f.send({ t: 'grant-revoked', userId: 'ally' })
  f.send({ t: 'grant-revoked', userId: 'owner' })
  await new Promise((r) => setTimeout(r, 100))
  f.send({ t: 'http-req', actor: 'ally', previewId: 'pv-ally', reqId: 'a1', method: 'GET', path: '/', headers: [], hasBody: false })
  expect(await f.find((m) => m.t === 'http-fail' && m.reqId === 'a1')).toMatchObject({ status: 403 }) // 本机名单里没有他了
  // 即便他又被写进名单（本机确认命令），旧的预览也已经不在了
  addLocalGrant(f.file, grant('ally', ['machine']))
  f.send({ t: 'http-req', actor: 'ally', previewId: 'pv-ally', reqId: 'a2', method: 'GET', path: '/', headers: [], hasBody: false })
  expect(await f.find((m) => m.t === 'http-fail' && m.reqId === 'a2')).toMatchObject({ status: 404 })
  f.send({ t: 'http-req', actor: 'owner', previewId: 'pv-owner', reqId: 'o1', method: 'GET', path: '/', headers: [], hasBody: false })
  expect(await f.find((m) => m.t === 'http-res' && m.reqId === 'o1')).toMatchObject({ status: 200 })
})

test('access-reduced(machine)：授权收窄后共享人的预览撤掉，但本机名单不动（他的 agent 授权还在）', async () => {
  const up = await upstream()
  const f = await start({ token: 'tok-pgate', cloud: '', ownerId: 'owner', grants: [grant('ally', ['agent', 'machine'])] })
  await f.ask({ t: 'port-share', rid: 's1', actor: 'ally', previewId: 'pv-ally', port: up.port })
  f.send({ t: 'access-reduced', userId: 'ally', scope: 'machine' })
  await new Promise((r) => setTimeout(r, 100))
  f.send({ t: 'http-req', actor: 'ally', previewId: 'pv-ally', reqId: 'a1', method: 'GET', path: '/', headers: [], hasBody: false })
  expect(await f.find((m) => m.t === 'http-fail' && m.reqId === 'a1')).toMatchObject({ status: 404 }) // 登记没了（名单本来还放行 ally）
  expect(up.hits()).toBe(0)
})

test('重新连上（welcome）时登记清空：中心随后会再登记还在共享的；hello 声明 preview 能力', async () => {
  const up = await upstream()
  const f = await start({ token: 'tok-pgate', cloud: '', ownerId: 'owner' })
  expect(f.inbox.find((m) => m.t === 'hello')).toMatchObject({ caps: expect.arrayContaining(['project', 'preview']) })
  await f.ask({ t: 'port-share', rid: 's1', actor: 'owner', previewId: 'pv1', port: up.port })
  f.dropSocket()
  await f.hello(2) // connector 退避 1 秒后重连
  f.send({ t: 'http-req', actor: 'owner', previewId: 'pv1', reqId: 'a1', method: 'GET', path: '/', headers: [], hasBody: false })
  expect(await f.find((m) => m.t === 'http-fail' && m.reqId === 'a1')).toMatchObject({ status: 404 })
  await f.ask({ t: 'port-share', rid: 's2', actor: 'owner', previewId: 'pv1', port: up.port }) // 中心再登记
  f.send({ t: 'http-req', actor: 'owner', previewId: 'pv1', reqId: 'a2', method: 'GET', path: '/', headers: [], hasBody: false })
  expect(await f.find((m) => m.t === 'http-res' && m.reqId === 'a2')).toMatchObject({ status: 200 })
})
