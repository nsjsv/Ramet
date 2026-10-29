/* ---------- connector 的端口预览执行端（PreviewForwarder）：真上游、不起中心 ----------
 * 覆盖：只连 127.0.0.1:<登记的端口>（帧里的主机名无效）；每个流量帧按记录里的共享人再判一次（署名对不上 / 本机名单不放行则不转发，
 * 并撤掉他的全部预览）；cookie / origin / 逐跳头；Location 改写；体积、并发、超时；WebSocket 往返；登记的名额与撤销权限。 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ConnMsg, PreviewMsg } from '../agents/protocol.js'
import { PreviewDenied } from '../agents/preview-types.js'
import { PreviewForwarder, responseHeaders, rewriteLocation, upstreamHeaders, type PreviewDeps } from './preview.js'

type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: string }
type Upstream = { port: number; seen: Seen[]; close: () => Promise<void>; server: Server; wss: WebSocketServer; sockets: WebSocket[] }

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

/** 本机的一个"开发服务器"：按路径回不同的东西 */
async function upstream(handler?: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<Upstream> {
  const seen: Seen[] = []
  const sockets: WebSocket[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString()
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      if (handler) return handler(req, res, body)
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`hello ${req.url}`)
    })
  })
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (p) => (p.has('vite-hmr') ? 'vite-hmr' : false) })
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/refuse')) {
      socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    seen.push({ method: 'UPGRADE', url: req.url ?? '', headers: req.headers, body: '' })
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws)
      ws.on('message', (data, binary) => ws.send(binary ? data : `echo:${data.toString()}`, { binary }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const up: Upstream = {
    port: (server.address() as AddressInfo).port,
    seen,
    server,
    wss,
    sockets,
    close: async () => {
      for (const ws of wss.clients) ws.terminate()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
  cleanups.push(up.close)
  return up
}

type Harness = { fwd: PreviewForwarder; out: ConnMsg[]; allowed: Set<string>; owner: { id: string } }

function harness(limits: PreviewDeps['limits'] = {}): Harness {
  const out: ConnMsg[] = []
  const allowed = new Set(['alice', 'bob', 'owner'])
  const owner = { id: 'owner' }
  const fwd = new PreviewForwarder({
    send: (m) => !!out.push(m),
    isOwner: (a) => a === owner.id,
    stillAllowed: (a) => allowed.has(a),
    tickMs: 0,
    limits,
  })
  cleanups.push(() => fwd.dispose())
  return { fwd, out, allowed, owner }
}

const share = (h: Harness, previewId: string, port: number, actor = 'alice'): void => {
  h.fwd.control({ t: 'port-share', rid: 'r', actor, previewId, port })
}

let seq = 0
type ReqOpts = { method?: string; path?: string; headers?: Array<[string, string]>; hasBody?: boolean; actor?: string; extra?: Record<string, unknown> }
const httpReq = (h: Harness, previewId: string, o: ReqOpts = {}): string => {
  const reqId = `q${++seq}`
  h.fwd.stream({
    t: 'http-req',
    actor: o.actor ?? 'alice',
    previewId,
    reqId,
    method: o.method ?? 'GET',
    path: o.path ?? '/',
    headers: o.headers ?? [],
    hasBody: o.hasBody ?? false,
    ...o.extra,
  } as Extract<PreviewMsg, { t: 'http-req' }>)
  return reqId
}

type Reply = { status: number; headers: Array<[string, string]>; body: Buffer; ended: boolean; error?: string; fail?: { status: number; message: string } }
async function reply(h: Harness, reqId: string, ms = 5000): Promise<Reply> {
  const deadline = Date.now() + ms
  for (;;) {
    const mine = h.out.filter((m) => 'reqId' in m && m.reqId === reqId)
    const fail = mine.find((m) => m.t === 'http-fail')
    const res = mine.find((m) => m.t === 'http-res')
    const bodies = mine.filter((m): m is Extract<ConnMsg, { t: 'http-res-body' }> => m.t === 'http-res-body')
    const done = bodies.find((b) => b.end || b.error)
    if (fail?.t === 'http-fail') return { status: 0, headers: [], body: Buffer.alloc(0), ended: false, fail: { status: fail.status, message: fail.message } }
    if (res?.t === 'http-res' && done) {
      return {
        status: res.status,
        headers: res.headers,
        body: Buffer.concat(bodies.filter((b) => b.chunk).map((b) => Buffer.from(b.chunk!, 'base64'))),
        ended: Boolean(done.end),
        ...(done.error ? { error: done.error } : {}),
      }
    }
    if (Date.now() > deadline) throw new Error(`等待 ${reqId} 的应答超时：${JSON.stringify(mine)}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('只连 127.0.0.1:<登记的端口>', () => {
  test('帧里的主机名 / 端口字段无效：请求落在登记的端口上，Host 是 localhost:<端口>；请求目标必须是 / 开头的路径', async () => {
    const up = await upstream()
    const h = harness()
    share(h, 'pv1', up.port)
    const id = httpReq(h, 'pv1', {
      path: '/page?x=1',
      headers: [['host', 'evil.example'], ['x-keep', '1']],
      extra: { host: 'evil.example', hostname: 'evil.example', port: 1, target: 'http://evil.example/' },
    })
    const r = await reply(h, id)
    expect(r).toMatchObject({ status: 200, ended: true })
    expect(r.body.toString()).toBe('hello /page?x=1')
    expect(up.seen[0]!.headers.host).toBe(`localhost:${up.port}`)
    expect(up.seen[0]!.headers['x-keep']).toBe('1')
    // 绝对地址形式不收；没有上游被打到
    const before = up.seen.length
    for (const bad of ['http://evil.example/', 'evil.example/x', '*', '/a b', '']) {
      const r2 = await reply(h, httpReq(h, 'pv1', { path: bad }))
      expect(r2.fail, bad).toMatchObject({ status: 400 })
    }
    expect(up.seen.length).toBe(before)
    // // 开头的路径照样是路径（上游收到它，不会被当成别的主机）
    const slashes = await reply(h, httpReq(h, 'pv1', { path: '//evil.example/x' }))
    expect(slashes.body.toString()).toBe('hello //evil.example/x')
  })

  test('登记的端口上没有程序：502 并说明端口；超时 504', async () => {
    const up = await upstream()
    const port = up.port
    await up.close()
    cleanups.length = 0
    const h = harness({ headerTimeoutMs: 150 })
    share(h, 'pv1', port)
    const r = await reply(h, httpReq(h, 'pv1'))
    expect(r.fail).toMatchObject({ status: 502, message: expect.stringContaining(String(port)) })

    const slow = await upstream(() => undefined) // 永远不回
    const h2 = harness({ headerTimeoutMs: 150 })
    share(h2, 'pv2', slow.port)
    expect((await reply(h2, httpReq(h2, 'pv2'))).fail).toMatchObject({ status: 504 })
  })
})

describe('请求头与响应头', () => {
  test('cookie：Ramet 自己的剥掉，其余保留；origin / referer 改成上游自己的地址；逐跳头 / expect 不转', async () => {
    const up = await upstream()
    const h = harness()
    share(h, 'pv1', up.port)
    await reply(
      h,
      httpReq(h, 'pv1', {
        headers: [
          ['cookie', 'ramet_session=SECRET; theme=dark; ramet_pv=PV'],
          ['origin', 'http://preview.example:8790'],
          ['referer', 'http://preview.example:8790/some/page?q=1'],
          ['connection', 'keep-alive, x-secret'],
          ['upgrade', 'websocket'],
          ['te', 'trailers'],
          ['expect', '100-continue'],
          ['authorization', 'Bearer app-token'],
          ['accept-encoding', 'gzip'],
        ],
      }),
    )
    const seen = up.seen[0]!.headers
    expect(seen.cookie).toBe('theme=dark')
    expect(seen.origin).toBe(`http://localhost:${up.port}`)
    expect(seen.referer).toBe(`http://localhost:${up.port}/some/page?q=1`)
    expect(seen.upgrade).toBeUndefined()
    expect(seen.te).toBeUndefined()
    expect(seen.expect).toBeUndefined()
    expect(seen.authorization).toBe('Bearer app-token')
    expect(seen['accept-encoding']).toBe('gzip')
    // 只有 Ramet 的 cookie：连 cookie 头都不发
    await reply(h, httpReq(h, 'pv1', { headers: [['cookie', 'ramet_session=SECRET']] }))
    expect(up.seen[1]!.headers.cookie).toBeUndefined()
  })

  test('upstreamHeaders / responseHeaders / rewriteLocation 的细节', () => {
    expect(upstreamHeaders([['Cookie', 'a=1'], ['cookie', 'ramet_x=2; b=3'], ['Referer', '没法解析']], 3000)).toEqual({ cookie: ['a=1', 'b=3'], host: 'localhost:3000' })
    // 上游指回自己的绝对地址 → 相对路径；别的主机原样；// 开头压成单个 /（否则成了开放重定向）
    expect(rewriteLocation('http://localhost:3000/login?x=1#h', 3000)).toBe('/login?x=1#h')
    expect(rewriteLocation('http://127.0.0.1:3000/a', 3000)).toBe('/a')
    expect(rewriteLocation('http://localhost:3000//evil.example/x', 3000)).toBe('/evil.example/x')
    expect(rewriteLocation('http://localhost:4000/a', 3000)).toBe('http://localhost:4000/a')
    expect(rewriteLocation('https://example.com/a', 3000)).toBe('https://example.com/a')
    expect(rewriteLocation('/relative', 3000)).toBe('/relative')
    expect(
      responseHeaders(
        ['Content-Type', 'text/html', 'Connection', 'close', 'Set-Cookie', 'ramet_session=evil', 'Set-Cookie', 'app=1', 'Location', 'http://localhost:3000/x', 'Transfer-Encoding', 'chunked'],
        3000,
      ),
    ).toEqual([['content-type', 'text/html'], ['set-cookie', 'app=1'], ['location', '/x']])
  })

  test('响应：状态 / 多个 Set-Cookie（Ramet 的丢掉）/ Location 改写 / HEAD 与 204 没有响应体', async () => {
    const up = await upstream((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `http://localhost:${(up.server.address() as AddressInfo).port}/next` })
        return res.end()
      }
      if (req.url === '/empty') {
        res.writeHead(204)
        return res.end()
      }
      res.writeHead(200, { 'set-cookie': ['ramet_session=evil; Path=/', 'ramet_pv=x', 'sid=1; Path=/', 'other=2'], 'content-type': 'text/plain' })
      res.end('body')
    })
    const h = harness()
    share(h, 'pv1', up.port)
    const cookies = await reply(h, httpReq(h, 'pv1'))
    expect(cookies.headers.filter(([k]) => k === 'set-cookie').map(([, v]) => v)).toEqual(['sid=1; Path=/', 'other=2'])
    const redirect = await reply(h, httpReq(h, 'pv1', { path: '/redirect' }))
    expect(redirect.status).toBe(302)
    expect(redirect.headers.find(([k]) => k === 'location')?.[1]).toBe('/next')
    const empty = await reply(h, httpReq(h, 'pv1', { path: '/empty' }))
    expect(empty).toMatchObject({ status: 204, ended: true })
    expect(empty.body.length).toBe(0)
    const head = await reply(h, httpReq(h, 'pv1', { method: 'HEAD' }))
    expect(head).toMatchObject({ status: 200, ended: true })
    expect(head.body.length).toBe(0)
  })

  test('请求体：POST 分片传完上游收到完整内容；不认识的方法 405', async () => {
    const up = await upstream((_req, res, body) => {
      res.writeHead(200)
      res.end(`got ${body.length}`)
    })
    const h = harness()
    share(h, 'pv1', up.port)
    const id = httpReq(h, 'pv1', { method: 'POST', hasBody: true, headers: [['content-length', '11']] })
    h.fwd.stream({ t: 'http-body', actor: 'alice', previewId: 'pv1', reqId: id, chunk: Buffer.from('hello ').toString('base64') })
    h.fwd.stream({ t: 'http-body', actor: 'alice', previewId: 'pv1', reqId: id, chunk: Buffer.from('world').toString('base64') })
    h.fwd.stream({ t: 'http-body', actor: 'alice', previewId: 'pv1', reqId: id, end: true })
    expect((await reply(h, id)).body.toString()).toBe('got 11')
    expect(up.seen[0]!.body).toBe('hello world')
    expect((await reply(h, httpReq(h, 'pv1', { method: 'TRACE' }))).fail).toMatchObject({ status: 405 })
    expect((await reply(h, httpReq(h, 'pv1', { method: 'CONNECT' }))).fail).toMatchObject({ status: 405 })
  })
})

describe('署名与授权：共享人才是记录里的人，本机名单此刻必须放行他', () => {
  test('署名对不上记录里的共享人 / 预览不存在：不转发', async () => {
    const up = await upstream()
    const h = harness()
    share(h, 'pv1', up.port, 'alice')
    expect((await reply(h, httpReq(h, 'pv1', { actor: 'bob' }))).fail).toMatchObject({ status: 403 }) // bob 自己也有 machine 授权，但预览是 alice 共享的
    expect((await reply(h, httpReq(h, 'pv1', { actor: 'owner' }))).fail).toMatchObject({ status: 403 }) // 主人也不能冒用
    expect((await reply(h, httpReq(h, 'nope'))).fail).toMatchObject({ status: 404 })
    expect(up.seen).toEqual([])
    expect(h.fwd.size).toBe(1) // 署名不对不会撤掉别人的预览
  })

  test('共享人的授权没了（本机名单不再放行）：不转发，并把他共享的预览全部撤掉；别人的不受影响', async () => {
    const up = await upstream()
    const h = harness()
    share(h, 'a1', up.port, 'alice')
    share(h, 'a2', up.port, 'alice')
    share(h, 'b1', up.port, 'bob')
    h.allowed.delete('alice')
    expect((await reply(h, httpReq(h, 'a1', { actor: 'alice' }))).fail).toMatchObject({ status: 403 })
    expect(up.seen).toEqual([])
    expect(h.fwd.size).toBe(1)
    expect((await reply(h, httpReq(h, 'a2', { actor: 'alice' }))).fail).toMatchObject({ status: 404 }) // 已经撤掉了
    expect((await reply(h, httpReq(h, 'b1', { actor: 'bob' }))).status).toBe(200)
  })

  test('巡检 tick：本机名单不再放行的人，他的预览撤掉（中心离线 / 有 bug 也一样）；在飞的请求掐断', async () => {
    let release: (() => void) | undefined
    const up = await upstream((_req, res) => {
      res.writeHead(200)
      res.write('start')
      release = () => res.end('end')
    })
    const h = harness()
    share(h, 'a1', up.port, 'alice')
    share(h, 'b1', up.port, 'bob')
    const id = httpReq(h, 'a1')
    await new Promise((r) => setTimeout(r, 100))
    h.allowed.delete('alice')
    h.fwd.tick()
    expect(h.fwd.size).toBe(1)
    await new Promise((r) => setTimeout(r, 100))
    expect(h.out.some((m) => 'reqId' in m && m.reqId === id && m.t === 'http-res-body' && m.end)).toBe(false) // 没有"正常结束"
    release?.()
  })

  test('closeActor（grant-revoked / access-reduced）：此人共享的预览撤掉，在飞的请求与 WebSocket 掐断', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200)
      res.write('start')
    })
    const h = harness()
    share(h, 'a1', up.port, 'alice')
    share(h, 'b1', up.port, 'bob')
    const id = httpReq(h, 'a1')
    h.fwd.stream({ t: 'ws-open', actor: 'alice', previewId: 'a1', wsId: 'w1', path: '/ws', headers: [], protocols: [] })
    await new Promise((r) => setTimeout(r, 150))
    expect(h.fwd.closeActor('alice')).toBe(1)
    expect(h.fwd.size).toBe(1)
    await new Promise((r) => setTimeout(r, 100))
    expect(h.out.some((m) => 'reqId' in m && m.reqId === id && m.t === 'http-res-body' && m.end)).toBe(false)
    h.fwd.stream({ t: 'ws-msg', actor: 'alice', previewId: 'a1', wsId: 'w1', data: 'x', binary: false }) // 已经没有了：不抛
    expect(h.fwd.closeActor('alice')).toBe(0)
  })

  test('reset（welcome / 断线）清空全部登记', async () => {
    const up = await upstream()
    const h = harness()
    share(h, 'a1', up.port)
    h.fwd.reset()
    expect(h.fwd.size).toBe(0)
    expect((await reply(h, httpReq(h, 'a1'))).fail).toMatchObject({ status: 404 })
  })
})

describe('登记的名额与撤销权限', () => {
  test('端口 1024–65535；最多 5 个；同一个预览不能换人重登记', () => {
    const h = harness()
    for (const bad of [0, 80, 1023, 65536, 3000.5, '3000', null]) {
      expect(() => h.fwd.control({ t: 'port-share', rid: 'r', actor: 'alice', previewId: 'p', port: bad as number }), String(bad)).toThrow(PreviewDenied)
    }
    for (let i = 0; i < 5; i++) share(h, `p${i}`, 3000 + i)
    expect(() => share(h, 'p5', 3005)).toThrow(/最多同时共享 5 个/)
    share(h, 'p0', 4000) // 同一个预览（同一个人）重登记 = 更新，不占新名额
    expect(h.fwd.size).toBe(5)
    expect(() => share(h, 'p1', 3001, 'bob')).toThrow(expect.objectContaining({ forbidden: true }))
  })

  test('停止共享：共享人自己、机器主人可以；别人（哪怕也有 machine 授权）不行；不存在的幂等', () => {
    const h = harness()
    share(h, 'p1', 3000, 'alice')
    const unshare = (actor: string, previewId = 'p1') => h.fwd.control({ t: 'port-unshare', rid: 'r', actor, previewId })
    expect(() => unshare('bob')).toThrow(expect.objectContaining({ forbidden: true }))
    expect(h.fwd.size).toBe(1)
    expect(unshare('alice')).toEqual({ op: 'port-unshare' })
    expect(h.fwd.size).toBe(0)
    share(h, 'p2', 3001, 'alice')
    expect(unshare('owner', 'p2')).toEqual({ op: 'port-unshare' })
    expect(h.fwd.size).toBe(0)
    expect(unshare('bob', 'ghost')).toEqual({ op: 'port-unshare' })
  })
})

describe('体积 / 并发 / 超时', () => {
  test('声明的响应体超限：直接拒绝，不发响应头；流式响应超限：报错（中心据此掐断浏览器连接）', async () => {
    const up = await upstream((req, res) => {
      if (req.url === '/declared') {
        res.writeHead(200, { 'content-length': '5000' })
        return res.end(Buffer.alloc(5000))
      }
      res.writeHead(200) // 不声明长度（chunked）
      res.write(Buffer.alloc(600))
      res.write(Buffer.alloc(600))
      res.end()
    })
    const h = harness({ resBodyMax: 1000 })
    share(h, 'pv1', up.port)
    const declaredId = httpReq(h, 'pv1', { path: '/declared' })
    const declared = await reply(h, declaredId)
    expect(declared.fail).toMatchObject({ status: 502, message: expect.stringContaining('上限') })
    expect(h.out.some((m) => m.t === 'http-res' && m.reqId === declaredId)).toBe(false) // 响应头都没发
    const streamed = await reply(h, httpReq(h, 'pv1', { path: '/streamed' }))
    expect(streamed.error).toContain('上限')
    expect(streamed.ended).toBe(false)
  })

  test('请求体超限：413，上游那条请求被掐断', async () => {
    const up = await upstream()
    const h = harness({ reqBodyMax: 100 })
    share(h, 'pv1', up.port)
    const id = httpReq(h, 'pv1', { method: 'POST', hasBody: true })
    for (let i = 0; i < 3; i++) h.fwd.stream({ t: 'http-body', actor: 'alice', previewId: 'pv1', reqId: id, chunk: Buffer.alloc(60).toString('base64') })
    expect((await reply(h, id)).fail).toMatchObject({ status: 413 })
    await new Promise((r) => setTimeout(r, 100))
    expect(up.seen.filter((s) => s.method === 'POST')).toEqual([]) // 上游没有收到一个完整请求
  })

  test('并发上限：满了回 503；浏览器走了（http-body abort）腾出位置', async () => {
    const up = await upstream(() => undefined)
    const h = harness({ maxInflight: 2 })
    share(h, 'pv1', up.port)
    const a = httpReq(h, 'pv1')
    httpReq(h, 'pv1')
    expect((await reply(h, httpReq(h, 'pv1'))).fail).toMatchObject({ status: 503 })
    h.fwd.stream({ t: 'http-body', actor: 'alice', previewId: 'pv1', reqId: a, abort: true })
    const c = httpReq(h, 'pv1')
    await new Promise((r) => setTimeout(r, 50))
    expect(h.out.filter((m) => 'reqId' in m && m.reqId === c && m.t === 'http-fail')).toEqual([])
  })

  test('响应体太久没有数据：报错并掐断', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200)
      res.write('start') // 然后沉默
    })
    const h = harness({ idleMs: 150 })
    share(h, 'pv1', up.port)
    const r = await reply(h, httpReq(h, 'pv1'))
    expect(r.error).toContain('没有数据')
    expect(r.body.toString()).toBe('start')
  })
})

describe('WebSocket', () => {
  async function wsFrames(h: Harness, wsId: string, pred: (m: ConnMsg) => boolean, ms = 3000): Promise<ConnMsg> {
    const deadline = Date.now() + ms
    for (;;) {
      const hit = h.out.find((m) => 'wsId' in m && m.wsId === wsId && pred(m))
      if (hit) return hit
      if (Date.now() > deadline) throw new Error(`等待 ws ${wsId} 超时：${JSON.stringify(h.out.filter((m) => 'wsId' in m))}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  test('往返：子协议由上游选定；text 原样、binary 经 base64；请求头里的 cookie 同样剥 Ramet 的；关闭码透传', async () => {
    const up = await upstream()
    const h = harness()
    share(h, 'pv1', up.port)
    h.fwd.stream({
      t: 'ws-open', actor: 'alice', previewId: 'pv1', wsId: 'w1', path: '/ws?token=t',
      headers: [['cookie', 'ramet_session=S; app=1'], ['origin', 'http://preview.example:8790']],
      protocols: ['vite-hmr', 'other'],
    })
    expect(await wsFrames(h, 'w1', (m) => m.t === 'ws-ready')).toMatchObject({ protocol: 'vite-hmr' })
    expect(up.seen[0]).toMatchObject({ method: 'UPGRADE', url: '/ws?token=t' })
    expect(up.seen[0]!.headers.cookie).toBe('app=1')
    expect(up.seen[0]!.headers.origin).toBe(`http://localhost:${up.port}`)
    h.fwd.stream({ t: 'ws-msg', actor: 'alice', previewId: 'pv1', wsId: 'w1', data: 'ping', binary: false })
    expect(await wsFrames(h, 'w1', (m) => m.t === 'ws-data' && !m.binary)).toMatchObject({ data: 'echo:ping' })
    h.fwd.stream({ t: 'ws-msg', actor: 'alice', previewId: 'pv1', wsId: 'w1', data: Buffer.from([1, 2, 3]).toString('base64'), binary: true })
    expect(await wsFrames(h, 'w1', (m) => m.t === 'ws-data' && m.binary)).toMatchObject({ data: Buffer.from([1, 2, 3]).toString('base64') })
    h.fwd.stream({ t: 'ws-close', actor: 'alice', previewId: 'pv1', wsId: 'w1', code: 4001 })
    expect(await wsFrames(h, 'w1', (m) => m.t === 'ws-end')).toMatchObject({ code: 4001, opened: true })
  })

  test('上游拒绝升级 / 连不上 / 署名不对 / 并发满了：ws-end opened=false，且没有连上去', async () => {
    const up = await upstream()
    const h = harness({ maxWs: 1 })
    share(h, 'pv1', up.port)
    h.fwd.stream({ t: 'ws-open', actor: 'alice', previewId: 'pv1', wsId: 'refused', path: '/refuse', headers: [], protocols: [] })
    expect(await wsFrames(h, 'refused', (m) => m.t === 'ws-end')).toMatchObject({ opened: false, reason: expect.stringContaining('404') })
    h.fwd.stream({ t: 'ws-open', actor: 'bob', previewId: 'pv1', wsId: 'wrong-actor', path: '/ws', headers: [], protocols: [] })
    expect(await wsFrames(h, 'wrong-actor', (m) => m.t === 'ws-end')).toMatchObject({ opened: false })
    h.fwd.stream({ t: 'ws-open', actor: 'alice', previewId: 'pv1', wsId: 'bad-path', path: 'http://evil.example/', headers: [], protocols: [] })
    expect(await wsFrames(h, 'bad-path', (m) => m.t === 'ws-end')).toMatchObject({ opened: false })
    expect(up.seen.filter((s) => s.method === 'UPGRADE')).toEqual([])
    h.fwd.stream({ t: 'ws-open', actor: 'alice', previewId: 'pv1', wsId: 'ok', path: '/ws', headers: [], protocols: [] })
    await wsFrames(h, 'ok', (m) => m.t === 'ws-ready')
    h.fwd.stream({ t: 'ws-open', actor: 'alice', previewId: 'pv1', wsId: 'second', path: '/ws', headers: [], protocols: [] })
    expect(await wsFrames(h, 'second', (m) => m.t === 'ws-end')).toMatchObject({ opened: false, reason: expect.stringContaining('正忙') })
  })
})
