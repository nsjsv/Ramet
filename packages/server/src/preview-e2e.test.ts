// ---------- 端口预览全链路：浏览器 → 预览源 → 中心 → 真 connector（WSS）→ 本机 127.0.0.1 上的真开发服务器 ----------
// 其余测试各盯一段（脚本化机器 / 假中心），这里证明整条链接得上，以及第二道闸在真 connector 上起作用：
// 共享人的授权在 connector 本机名单里没了，中心没发任何通知，预览也不再转发。
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { connectorTokenFile, grantMachine, insertUser, login, pool, postJson, previewBase, previewPort, startConnector, waitFor } from './agents/test-kit.js'
import { removeLocalGrants } from './connector/access.js'
import { PREVIEW_REQ_BODY_MAX } from './agents/preview-types.js'
import { api, enterPreview, list, share, shareOk, viaPreview } from './preview-fixtures.js'

type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of closers.splice(0)) await c()
})

/** 本机的开发服务器：HTTP + WebSocket（vite-hmr 子协议），记下收到的每个请求 */
async function devServer(): Promise<{ port: number; seen: Seen[]; aborted: () => number; server: Server }> {
  const seen: Seen[] = []
  let aborted = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      const url = req.url ?? ''
      if (url === '/hang') {
        res.writeHead(200)
        res.write('start')
        res.on('close', () => void (aborted += 1))
        return
      }
      if (url === '/big') {
        const big = Buffer.alloc(5 * 1024 * 1024)
        for (let i = 0; i < big.length; i++) big[i] = (i * 17) % 253
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(big)
        return
      }
      if (url === '/redirect') {
        res.writeHead(302, { location: `http://localhost:${(server.address() as AddressInfo).port}/landed` })
        return res.end()
      }
      if (url === '/cookies') {
        res.writeHead(200, { 'set-cookie': ['ramet_session=evil; Path=/', 'ramet_pv=fix; Path=/', 'app=1; Path=/'], 'content-type': 'text/plain' })
        return res.end('cookies')
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ method: req.method, url, bytes: body.length, sha: createHash('sha256').update(body).digest('hex'), host: req.headers.host, cookie: req.headers.cookie ?? null, origin: req.headers.origin ?? null }))
    })
  })
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (p) => (p.has('vite-hmr') ? 'vite-hmr' : false) })
  server.on('upgrade', (req, socket, head) => {
    seen.push({ method: 'UPGRADE', url: req.url ?? '', headers: req.headers, body: Buffer.alloc(0) })
    wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (data, binary) => ws.send(binary ? data : `echo:${data.toString()}`, { binary })))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(async () => {
    for (const ws of wss.clients) ws.terminate()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return { port: (server.address() as AddressInfo).port, seen, aborted: () => aborted, server }
}

async function world() {
  const owner = await insertUser('owner')
  const guest = await insertUser('guest')
  const viewer = await insertUser('viewer')
  const cookie = { owner: await login('owner'), guest: await login('guest'), viewer: await login('viewer') }
  const space = (await (await postJson('/api/spaces', cookie.owner, { name: 's' })).json()) as { id: string }
  for (const [id, role] of [[guest, 'member'], [viewer, 'viewer']] as const) {
    await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [space.id, id, role])
  }
  const page = (await (await postJson('/api/pages', cookie.owner, { space_id: space.id })).json()) as { id: string }
  const connectorId = await startConnector({ spaceId: space.id, ownerId: owner, name: 'realbox', cookie: cookie.owner, connector: { loadPty: async () => null } })
  return { id: { owner, guest, viewer }, cookie, pageId: page.id, agent: `c:${connectorId}:claude`, connectorId }
}

const wsUrl = (path: string): string => `${previewBase.replace('http', 'ws')}${path}`

describe('真 connector 全链路', () => {
  test('GET / POST / HEAD：请求与响应原样；Ramet 的 cookie 到不了开发服务器，它想设的同名 cookie 到不了浏览器；Host / Origin 是它自己的', async () => {
    const dev = await devServer()
    const w = await world()
    const p = await shareOk(w, w.cookie.owner, dev.port, { path: '/hello' })
    const pv = await enterPreview(w, w.cookie.viewer, p)

    const res = await viaPreview(null, '/api/data?x=1', {
      headers: {
        cookie: `${pv}; ${w.cookie.viewer}; theme=dark; ramet_future=1`,
        origin: previewBase,
        referer: `${previewBase}/some/page`,
      },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      method: 'GET',
      url: '/api/data?x=1',
      bytes: 0,
      sha: createHash('sha256').update('').digest('hex'),
      host: `localhost:${dev.port}`,
      cookie: 'theme=dark', // Ramet 的登录 cookie / 预览会话 / ramet_ 前缀的都没到
      origin: `http://localhost:${dev.port}`, // 开发服务器按它自己的地址看
    })
    expect(dev.seen[0]!.headers.referer).toBe(`http://localhost:${dev.port}/some/page`)

    const body = Buffer.alloc(300_000, 9)
    const post = await viaPreview(pv, '/submit', { method: 'POST', body, headers: { 'content-type': 'application/octet-stream' } })
    expect(await post.json()).toMatchObject({ method: 'POST', bytes: body.length, sha: createHash('sha256').update(body).digest('hex') })

    const cookies = await viaPreview(pv, '/cookies')
    expect(cookies.headers.getSetCookie()).toEqual(['app=1; Path=/'])
    const redirect = await viaPreview(pv, '/redirect')
    expect([redirect.status, redirect.headers.get('location')]).toEqual([302, '/landed']) // 指回 localhost:<端口> 的绝对地址改成相对的
    const head = await viaPreview(pv, '/x', { method: 'HEAD' })
    expect(head.status).toBe(200)
  })

  test('大响应（5MB）经真 WSS 完整到达；请求体超过 10MB 在中途 413，开发服务器收不到完整请求', async () => {
    const dev = await devServer()
    const w = await world()
    const p = await shareOk(w, w.cookie.owner, dev.port)
    const pv = await enterPreview(w, w.cookie.viewer, p)
    const big = Buffer.alloc(5 * 1024 * 1024)
    for (let i = 0; i < big.length; i++) big[i] = (i * 17) % 253
    const got = Buffer.from(await (await viaPreview(pv, '/big')).arrayBuffer())
    expect(createHash('sha256').update(got).digest('hex')).toBe(createHash('sha256').update(big).digest('hex'))

    const status = await new Promise<number>((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port: previewPort(), path: '/up', method: 'POST', headers: { cookie: pv } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', () => resolve(0))
      for (let i = 0; i < 11; i++) req.write(Buffer.alloc(1024 * 1024, 1))
      req.end()
    })
    expect(status).toBe(413)
    await new Promise((r) => setTimeout(r, 300))
    expect(dev.seen.filter((s) => s.url === '/up' && s.body.length > PREVIEW_REQ_BODY_MAX)).toEqual([])
  })

  test('WebSocket：子协议由开发服务器选定，text / binary 往返', async () => {
    const dev = await devServer()
    const w = await world()
    const p = await shareOk(w, w.cookie.owner, dev.port)
    const pv = await enterPreview(w, w.cookie.viewer, p)
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const sock = new WebSocket(wsUrl('/?token=abc'), ['vite-hmr'], { headers: { cookie: `${pv}; ${w.cookie.viewer}; k=v`, origin: previewBase } })
      sock.on('open', () => resolve(sock))
      sock.on('error', reject)
      sock.on('unexpected-response', (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)))
    })
    expect(ws.protocol).toBe('vite-hmr')
    const next = (): Promise<[string, boolean]> => new Promise((resolve) => ws.once('message', (d, bin) => resolve([bin ? (d as Buffer).toString('hex') : d.toString(), bin])))
    const a = next()
    ws.send('hi')
    expect(await a).toEqual(['echo:hi', false])
    const b = next()
    ws.send(Buffer.from([0xde, 0xad]))
    expect(await b).toEqual(['dead', true])
    expect(dev.seen.find((s) => s.method === 'UPGRADE')!.headers.cookie).toBe('k=v')
    ws.close()
  })

  test('登记的端口上没有程序：502 页说明端口；不在登记端口上的请求到不了别的端口', async () => {
    const dev = await devServer()
    const other = await devServer()
    const w = await world()
    const p = await shareOk(w, w.cookie.owner, dev.port)
    const pv = await enterPreview(w, w.cookie.viewer, p)
    // 请求里无论怎么写（绝对地址形式、Host 头、@ 技巧），打到的都是登记的端口
    for (const path of [`/@127.0.0.1:${other.port}/x`, `//127.0.0.1:${other.port}/x`]) {
      const res = await viaPreview(pv, path, { headers: { 'x-forwarded-host': `127.0.0.1:${other.port}` } })
      expect(res.status, path).toBe(200)
    }
    expect(other.seen).toEqual([])
    expect(dev.seen.map((s) => s.url)).toEqual([`/@127.0.0.1:${other.port}/x`, `//127.0.0.1:${other.port}/x`])
    await other.server.close()
    const dead = await devServer()
    const deadPort = dead.port
    await new Promise<void>((resolve) => dead.server.close(() => resolve()))
    const p2 = await shareOk(w, w.cookie.owner, deadPort)
    const pv2 = await enterPreview(w, w.cookie.viewer, p2)
    const res = await viaPreview(pv2, '/')
    expect(res.status).toBe(502)
    expect(await res.text()).toContain(String(deadPort))
  })
})

describe('真 connector 的第二道闸', () => {
  test('被授权人（machine 范围）能共享并转发；共享人在 connector 本机名单里没了——中心没发任何通知——下一个请求也不转发', async () => {
    const dev = await devServer()
    const w = await world()
    await grantMachine(w.connectorId, w.id.guest, { scopes: ['machine'] })
    const p = await shareOk(w, w.cookie.guest, dev.port)
    const pv = await enterPreview(w, w.cookie.viewer, p)
    expect((await viaPreview(pv, '/')).status).toBe(200)
    expect(removeLocalGrants(connectorTokenFile(w.connectorId), { userId: w.id.guest })).toBe(1)
    const res = await viaPreview(pv, '/second')
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('不允许你使用')
    expect(dev.seen.map((s) => s.url)).toEqual(['/']) // 第二个请求没有打到开发服务器
    // 本机名单是权威：connector 也把他共享的预览撤掉了
    const retry = await viaPreview(pv, '/third')
    expect([403, 404]).toContain(retry.status)
    expect(dev.seen).toHaveLength(1)
  })

  test('中心库里有授权、本机名单里没有（没做本地确认）：共享被 connector 拒绝，不进登记表', async () => {
    const dev = await devServer()
    const w = await world()
    await grantMachine(w.connectorId, w.id.guest, { scopes: ['machine'], local: false })
    const res = await share(w, w.cookie.guest, dev.port)
    expect(res.status).toBe(403)
    expect((await list(w, w.cookie.owner)).previews).toEqual([])
  })

  test('授权被收回：connector 掐断他共享的预览的在飞请求，开发服务器那条连接被关掉', async () => {
    const dev = await devServer()
    const w = await world()
    const grantId = await grantMachine(w.connectorId, w.id.guest, { scopes: ['machine'] })
    const p = await shareOk(w, w.cookie.guest, dev.port)
    const pv = await enterPreview(w, w.cookie.viewer, p)
    const hanging = viaPreview(pv, '/hang').then(async (res) => ({ status: res.status, body: await res.text().catch(() => 'cut') })).catch(() => ({ status: 0, body: 'cut' }))
    await waitFor(() => dev.seen.some((s) => s.url === '/hang'))
    expect((await api('DELETE', `/api/machines/${w.connectorId}/grants/${grantId}`, w.cookie.owner)).status).toBe(200)
    await hanging
    await waitFor(() => dev.aborted() === 1) // 开发服务器看到那条请求被掐断了
    expect((await viaPreview(pv, '/')).status).toBe(404)
    expect((await list(w, w.cookie.owner)).previews).toEqual([])
  })
})
