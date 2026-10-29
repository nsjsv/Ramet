// ---------- 端口预览的流量：预览源（独立端口）→ 中心 → 机器（脚本化 connector） ----------
// 覆盖：预览端口不挂 Ramet 路由；cookie 剥离 / 同名 Set-Cookie 丢弃；帧署名 = 共享人；体积 / 并发 / 错误页；WebSocket；
// 收回即断（授权收回 / 到期 / 收窄、读者失去访问、共享人授权判定为假、页面回收）；掉线与重连后再登记。
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { describe, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import type { CenterMsg } from './agents/protocol.js'
import { connectMachine, type Machine } from './agents/scripted-machine.js'
import { agentsList, base, pool, previewBase, previewPort, s, waitFor } from './agents/test-kit.js'
import { PREVIEW_MAX_INFLIGHT, PREVIEW_MAX_WS, PREVIEW_REQ_BODY_MAX } from './agents/preview-types.js'
import { api, enterPreview, grantVia, lastHttpReq, list, previewFrames, shareOk, viaPreview, world, type World } from './preview-fixtures.js'

type HttpReq = Extract<CenterMsg, { t: 'http-req' }>
const b64 = (data: string | Buffer): string => Buffer.from(data).toString('base64')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 机器回一个响应：头 + 若干分片 + 结束 */
function respond(m: Machine, msg: HttpReq, status: number, headers: Array<[string, string]>, ...chunks: Array<string | Buffer>): void {
  m.send({ t: 'http-res', reqId: msg.reqId, status, headers })
  for (const c of chunks) m.send({ t: 'http-res-body', reqId: msg.reqId, chunk: b64(c) })
  m.send({ t: 'http-res-body', reqId: msg.reqId, end: true })
}

/** 主人共享端口 3000，viewer 进入，返回预览会话 cookie */
async function ready(): Promise<{ w: World; p: string; pv: string }> {
  const w = await world()
  const p = await shareOk(w, w.cookie.mowner, 3000, { path: '/app' })
  const pv = await enterPreview(w, w.cookie.viewer, p)
  return { w, p, pv }
}

describe('预览端口只做预览转发', () => {
  test('没有预览会话：一切请求 404，包括 /api/*、/collab、/__ramet/*；Ramet 的登录 cookie 在这里不认；机器一侧一个帧都没有', async () => {
    const { w, pv } = await ready()
    const paths = ['/api/pages', '/api/auth/me', `/api/pages/${w.pageId}/previews`, '/collab', '/', '/index.html', '/__ramet/other', '/__ramet/enter/x']
    for (const path of paths) {
      const res = await viaPreview(null, path)
      expect(res.status, path).toBe(404)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(await res.text(), path).not.toMatch(/"id"|"username"|ramet_session/)
    }
    // 同主机会带过来的 Ramet 登录 cookie 当不了凭证
    expect((await viaPreview(w.cookie.mowner, '/api/pages')).status).toBe(404)
    expect((await viaPreview(w.cookie.mowner, '/api/auth/me')).status).toBe(404)
    // 编造的或过期的会话
    expect((await viaPreview(`ramet_pv=${'a'.repeat(64)}`, '/')).status).toBe(404)
    expect((await viaPreview('ramet_pv=', '/')).status).toBe(404)
    expect(w.m.of('http-req')).toEqual([])
    // 有会话之后 /api/* 是转发给机器的（那是它自己网站的路径），响应是机器回的，不是 Ramet 的
    w.m.httpHandler = (m, msg) => respond(m, msg, 200, [['content-type', 'application/json']], '{"app":true}')
    const res = await viaPreview(pv, '/api/auth/me')
    expect(await res.json()).toEqual({ app: true })
    expect(lastHttpReq(w.m)).toMatchObject({ path: '/api/auth/me' })
    // 保留前缀 /__ramet/ 有会话也不转发（只有 enter）
    const reserved = await viaPreview(pv, '/__ramet/whatever')
    expect(reserved.status).toBe(404)
    expect(w.m.of('http-req')).toHaveLength(1)
  })

  test('不认识的方法 405、非 / 开头的请求目标 400，都不会转发', async () => {
    const { w, pv } = await ready()
    // fetch 不让发 TRACE 和绝对地址形式的请求行，用原始 http.request
    const raw = (method: string, path: string): Promise<number> =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: previewPort(), path, method, headers: { cookie: pv } }, (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.on('error', reject)
        req.end()
      })
    expect(await raw('TRACE', '/x')).toBe(405)
    await expect(raw('CONNECT', '/x')).rejects.toThrow() // CONNECT 不由这个监听处理，直接断开
    expect(await raw('GET', 'http://evil.example/x')).toBe(400)
    expect(await raw('GET', '*')).toBe(400)
    expect(w.m.of('http-req')).toEqual([])
  })
})

describe('转发的请求', () => {
  test('帧以共享人署名（不是看预览的人）；Ramet 的 cookie（登录会话 / 预览会话 / ramet_ 前缀）剥掉，其余保留；代理痕迹与逐跳头不转', async () => {
    const { w, p, pv } = await ready()
    const viewerToken = w.cookie.viewer.split('=')[1]!
    const sid = pv.split('=')[1]!
    const res = await viaPreview(null, '/src/main.ts?t=123&x=%20y', {
      headers: {
        cookie: `${pv}; ${w.cookie.viewer}; theme=dark; ramet_future=1; token=abc`,
        'x-forwarded-for': '1.2.3.4',
        'x-real-ip': '1.2.3.4',
        'x-custom': 'keep-me',
        authorization: 'Bearer app',
        accept: 'text/javascript',
      },
    })
    expect(res.status).toBe(200)
    const frame = lastHttpReq(w.m)!
    expect(frame).toMatchObject({ actor: w.id.mowner, previewId: p, method: 'GET', path: '/src/main.ts?t=123&x=%20y', hasBody: false })
    expect(frame.actor).not.toBe(w.id.viewer)
    const headers = Object.fromEntries(frame.headers)
    expect(headers.cookie).toBe('theme=dark; token=abc')
    expect(headers['x-custom']).toBe('keep-me')
    expect(headers.authorization).toBe('Bearer app')
    for (const gone of ['host', 'x-forwarded-for', 'x-real-ip', 'connection', 'expect']) expect(headers[gone], gone).toBeUndefined()
    // 看预览的人的登录令牌 / 预览会话 id 不在任何一帧里
    const wire = JSON.stringify(w.m.frames)
    expect(wire).not.toContain(viewerToken)
    expect(wire).not.toContain(sid)
    // 只有 Ramet 的 cookie：连 Cookie 头都不带
    await viaPreview(null, '/', { headers: { cookie: `${pv}; ${w.cookie.viewer}` } })
    expect(Object.fromEntries(lastHttpReq(w.m)!.headers).cookie).toBeUndefined()
  })

  test('会话绑定一个预览：每条会话的请求落在它自己的预览上', async () => {
    const w = await world()
    const a = await shareOk(w, w.cookie.mowner, 3000)
    const b = await shareOk(w, w.cookie.mowner, 3001)
    const pvA = await enterPreview(w, w.cookie.viewer, a)
    const pvB = await enterPreview(w, w.cookie.viewer, b)
    expect(pvA).not.toBe(pvB)
    await viaPreview(pvA, '/')
    expect(lastHttpReq(w.m)).toMatchObject({ previewId: a })
    await viaPreview(pvB, '/')
    expect(lastHttpReq(w.m)).toMatchObject({ previewId: b })
  })

  test('请求体：POST 分片发给机器，拼起来与原文一致；声明超过 10MB 直接 413（一个帧都不发）；流式超过 10MB 在中途 413 并掐断', async () => {
    const { w, pv } = await ready()
    const text = 'x'.repeat(200_000) + '结尾'
    w.m.httpHandler = (m, msg) => respond(m, msg, 200, [], 'ok')
    const res = await viaPreview(pv, '/upload', { method: 'POST', body: text, headers: { 'content-type': 'text/plain' } })
    expect(await res.text()).toBe('ok')
    const req = lastHttpReq(w.m)!
    expect(req).toMatchObject({ method: 'POST', hasBody: true })
    const bodies = w.m.of('http-body').filter((f) => f.reqId === req.reqId)
    expect(bodies.at(-1)).toMatchObject({ end: true })
    expect(Buffer.concat(bodies.filter((f) => f.chunk).map((f) => Buffer.from(f.chunk!, 'base64'))).toString()).toBe(text)
    expect(bodies.every((f) => f.actor === w.id.mowner)).toBe(true)

    // 声明 11MB，还没读体就 413
    const before = w.m.of('http-req').length
    const declared = await rawPost(pv, { 'content-length': String(PREVIEW_REQ_BODY_MAX + 1) }, [Buffer.alloc(10)])
    expect(declared.status).toBe(413)
    expect(w.m.of('http-req')).toHaveLength(before)

    // 不声明长度（chunked）一路发到超过 10MB，中途 413，机器收到 abort
    w.m.httpHandler = () => undefined // 机器不回
    const chunks = Array.from({ length: 11 }, () => Buffer.alloc(1024 * 1024, 7))
    const streamed = await rawPost(pv, {}, chunks)
    expect(streamed.status).toBe(413)
    await waitFor(() => w.m.of('http-body').some((f) => f.abort))
    const sent = w.m.of('http-body').filter((f) => f.chunk && f.reqId === lastHttpReq(w.m)!.reqId).reduce((n, f) => n + Buffer.from(f.chunk!, 'base64').length, 0)
    expect(sent).toBeLessThanOrEqual(PREVIEW_REQ_BODY_MAX)
  })
})

/** 用原始 http.request 发 POST（可控 content-length / chunked），读到状态码即返回 */
function rawPost(pv: string, headers: Record<string, string>, chunks: Buffer[]): Promise<{ status: number }> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: previewPort(), path: '/up', method: 'POST', headers: { cookie: pv, ...headers } }, (res) => {
      res.resume()
      resolve({ status: res.statusCode ?? 0 })
    })
    req.on('error', () => resolve({ status: 0 }))
    for (const c of chunks) req.write(c)
    req.end()
  })
}

describe('转发的响应', () => {
  test('状态 / 头 / 体原样；同名 Set-Cookie（Ramet 的）丢掉、别的保留；逐跳头去掉；多个 Set-Cookie 不合并', async () => {
    const { w, pv } = await ready()
    w.m.httpHandler = (m, msg) =>
      respond(
        m,
        msg,
        201,
        [
          ['content-type', 'text/html'],
          ['x-app', 'yes'],
          ['connection', 'close'],
          ['keep-alive', 'timeout=5'],
          ['set-cookie', 'ramet_session=evil; Path=/'],
          ['set-cookie', 'ramet_pv=fixation; Path=/'],
          ['set-cookie', 'RAMET_future=1'],
          ['set-cookie', 'sid=1; Path=/; HttpOnly'],
          ['set-cookie', 'theme=light; Path=/'],
        ],
        '<h1>',
        '你好',
      )
    const res = await viaPreview(pv, '/')
    expect(res.status).toBe(201)
    expect(res.headers.get('x-app')).toBe('yes')
    expect(res.headers.get('content-type')).toBe('text/html')
    expect(res.headers.getSetCookie()).toEqual(['sid=1; Path=/; HttpOnly', 'theme=light; Path=/'])
    expect(await res.text()).toBe('<h1>你好')
  })

  test('大响应分片完整到达（3MB，哈希一致）；重定向与 304 原样；HEAD 没有体', async () => {
    const { w, pv } = await ready()
    const big = Buffer.alloc(3 * 1024 * 1024)
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251
    w.m.httpHandler = (m, msg) => {
      if (msg.path === '/big') return respond(m, msg, 200, [['content-length', String(big.length)]], big.subarray(0, 1_000_000), big.subarray(1_000_000, 2_000_000), big.subarray(2_000_000))
      if (msg.path === '/redirect') return respond(m, msg, 302, [['location', '/next']])
      if (msg.path === '/cached') return respond(m, msg, 304, [['etag', '"x"']])
      respond(m, msg, 200, [['content-length', '5']], msg.method === 'HEAD' ? '' : 'hello')
    }
    const got = Buffer.from(await (await viaPreview(pv, '/big')).arrayBuffer())
    expect(createHash('sha256').update(got).digest('hex')).toBe(createHash('sha256').update(big).digest('hex'))
    const red = await viaPreview(pv, '/redirect')
    expect([red.status, red.headers.get('location')]).toEqual([302, '/next'])
    expect((await viaPreview(pv, '/cached')).status).toBe(304)
    const head = await viaPreview(pv, '/x', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })

  test('机器上的网站出错：http-fail 变成错误页（带原因）；响应到一半出错掐断连接；不认识的响应头状态 502', async () => {
    const { w, pv } = await ready()
    w.m.httpHandler = (m, msg) => {
      if (msg.path === '/refused') return m.send({ t: 'http-fail', reqId: msg.reqId, status: 502, message: '这台机器的 3000 端口上没有程序在监听' })
      if (msg.path === '/denied') return m.send({ t: 'http-fail', reqId: msg.reqId, status: 403, message: '<script>alert(1)</script>' })
      if (msg.path === '/half') {
        m.send({ t: 'http-res', reqId: msg.reqId, status: 200, headers: [['content-length', '100']] })
        m.send({ t: 'http-res-body', reqId: msg.reqId, chunk: b64('only a little') })
        return m.send({ t: 'http-res-body', reqId: msg.reqId, error: '上游断了' })
      }
      m.send({ t: 'http-res', reqId: msg.reqId, status: 101, headers: [] })
    }
    const refused = await viaPreview(pv, '/refused')
    expect(refused.status).toBe(502)
    expect(await refused.text()).toContain('3000 端口上没有程序在监听')
    const denied = await viaPreview(pv, '/denied')
    expect(denied.status).toBe(403)
    const html = await denied.text()
    expect(html).not.toContain('<script>alert') // 错误页里的原因是转义过的
    expect(html).toContain('&lt;script&gt;')
    await expect((async () => (await viaPreview(pv, '/half')).text())()).rejects.toThrow()
    expect((await viaPreview(pv, '/weird')).status).toBe(502)
  })

  test('并发上限：这台机器上在飞的请求满了回 503（带 Retry-After）；浏览器走了机器收到 abort，名额回来', async () => {
    const { w, pv } = await ready()
    const held: string[] = []
    w.m.httpHandler = (_m, msg) => void held.push(msg.reqId)
    const controllers = Array.from({ length: PREVIEW_MAX_INFLIGHT }, () => new AbortController())
    const inflight = controllers.map((c, i) => viaPreview(pv, `/slow/${i}`, { signal: c.signal }).catch(() => null))
    await waitFor(() => held.length === PREVIEW_MAX_INFLIGHT)
    const busy = await viaPreview(pv, '/one-too-many')
    expect(busy.status).toBe(503)
    expect(busy.headers.get('retry-after')).toBe('2')
    for (const c of controllers) c.abort()
    await Promise.all(inflight)
    await waitFor(() => w.m.of('http-body').filter((f) => f.abort).length === PREVIEW_MAX_INFLIGHT)
    w.m.httpHandler = (m, msg) => respond(m, msg, 200, [], 'ok')
    expect((await viaPreview(pv, '/again')).status).toBe(200)
  })
})

describe('WebSocket（Vite HMR 等）', () => {
  const open = (pv: string | null, opts: { origin?: string | null; protocols?: string[]; path?: string } = {}): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const origin = opts.origin === undefined ? previewBase : opts.origin
      const ws = new WebSocket(`${previewBase.replace('http', 'ws')}${opts.path ?? '/hmr?token=1'}`, opts.protocols ?? [], {
        headers: { ...(pv ? { cookie: pv } : {}), ...(origin ? { origin } : {}) },
      })
      ws.on('open', () => resolve(ws))
      ws.on('error', reject)
      ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
    })
  const message = (ws: WebSocket): Promise<{ data: string; binary: boolean }> =>
    new Promise((resolve) => ws.once('message', (data, binary) => resolve({ data: binary ? (data as Buffer).toString('hex') : data.toString(), binary })))

  test('往返：子协议由机器那头选定；text / binary 原样回；关闭码透传；帧署名 = 共享人、cookie 已剥', async () => {
    const { w, p, pv } = await ready()
    const ws = await open(`${pv}; ${w.cookie.viewer}; k=v`, { protocols: ['vite-hmr'] })
    expect(ws.protocol).toBe('vite-hmr')
    const opened = w.m.of('ws-open').at(-1)!
    expect(opened).toMatchObject({ actor: w.id.mowner, previewId: p, path: '/hmr?token=1', protocols: ['vite-hmr'] })
    expect(Object.fromEntries(opened.headers).cookie).toBe('k=v')
    const echo = message(ws)
    ws.send('ping')
    expect(await echo).toEqual({ data: 'ping', binary: false })
    const bin = message(ws)
    ws.send(Buffer.from([1, 2, 3]))
    expect(await bin).toEqual({ data: '010203', binary: true })
    ws.close(4001, 'done')
    await waitFor(() => w.m.of('ws-close').length === 1)
    expect(w.m.of('ws-close')[0]).toMatchObject({ wsId: opened.wsId, code: 4001, actor: w.id.mowner })
  })

  test('机器那头关了：浏览器收到同样的关闭码；握手阶段上游就拒绝：握手失败（502）', async () => {
    const { w, pv } = await ready()
    const ws = await open(pv)
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
    w.m.send({ t: 'ws-end', wsId: w.m.of('ws-open').at(-1)!.wsId, code: 4000, reason: 'bye', opened: true })
    expect(await closed).toBe(4000)
    w.m.wsHandler = (m, msg) => msg.t === 'ws-open' && m.send({ t: 'ws-end', wsId: msg.wsId, code: 1011, reason: '上游拒绝', opened: false })
    await expect(open(pv)).rejects.toThrow('HTTP 502')
  })

  test('握手前的检查：没有会话 404、外来 Origin 403（跨站页面借不了浏览器里的预览会话）、保留前缀 404；都不会连到机器', async () => {
    const { w, pv } = await ready()
    await expect(open(null)).rejects.toThrow('HTTP 404')
    await expect(open(w.cookie.mowner)).rejects.toThrow('HTTP 404') // Ramet 登录 cookie 不认
    await expect(open(pv, { origin: 'http://evil.example' })).rejects.toThrow('HTTP 403')
    await expect(open(pv, { origin: base })).rejects.toThrow('HTTP 403') // Ramet 页面的 Origin 也不是预览源
    await expect(open(pv, { path: '/__ramet/x' })).rejects.toThrow('HTTP 404')
    expect(w.m.of('ws-open')).toEqual([])
    const ws = await open(pv, { origin: null }) // 非浏览器（没有 Origin）带着有效会话：照常
    ws.close()
  })

  test('并发上限：同一台机器上的 WebSocket 满了回 503', async () => {
    const { pv } = await ready()
    const sockets: WebSocket[] = []
    for (let i = 0; i < PREVIEW_MAX_WS; i++) sockets.push(await open(pv))
    await expect(open(pv)).rejects.toThrow('HTTP 503')
    for (const ws of sockets) ws.close()
  })
})

describe('收回即断', () => {
  /** 共享人 machineOnly 的预览上有一个挂住的请求、一条 WebSocket 和一个活着的会话；owner 另有一个不受影响的预览 */
  async function busy() {
    const w = await world()
    const mine = await shareOk(w, w.cookie.machineOnly, 3000)
    const theirs = await shareOk(w, w.cookie.mowner, 3001)
    const pv = await enterPreview(w, w.cookie.viewer, mine)
    const pvOwner = await enterPreview(w, w.cookie.viewer, theirs)
    const held: string[] = []
    w.m.httpHandler = (m, msg) => {
      if (msg.previewId === theirs) return respond(m, msg, 200, [], 'owner ok')
      held.push(msg.reqId)
    }
    const request = viaPreview(pv, '/slow').then(async (res) => ({ status: res.status, body: await res.text() })).catch(() => ({ status: 0, body: '' }))
    await waitFor(() => held.length === 1)
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const sock = new WebSocket(`${previewBase.replace('http', 'ws')}/hmr`, { headers: { cookie: pv, origin: previewBase } })
      sock.on('open', () => resolve(sock))
      sock.on('error', reject)
    })
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
    return { w, mine, theirs, pv, pvOwner, request, closed }
  }

  async function expectCutOff(x: Awaited<ReturnType<typeof busy>>): Promise<void> {
    const { w } = x
    expect(await x.closed).toBe(1001) // WebSocket 当场断开
    const res = await x.request
    expect(res.status).toBe(410) // 在飞的请求当场失败
    expect(res.body).toContain('预览已停止')
    expect((await list(w, w.cookie.viewer)).previews.map((p) => p.id)).toEqual([x.theirs])
    expect((await viaPreview(x.pv, '/')).status).toBe(404) // 会话失效
    expect(await (await viaPreview(x.pvOwner, '/')).text()).toBe('owner ok') // 别人共享的不受影响
    expect(w.m.of('http-body').some((f) => f.abort && f.actor === w.id.machineOnly)).toBe(true) // 机器被告知放弃
  }

  test('授权被收回：他共享的预览全部停止（请求 / WebSocket 掐断、会话失效），机器收到 grant-revoked；别人的不受影响', async () => {
    const x = await busy()
    expect((await api('DELETE', `/api/machines/${x.w.m.id}/grants/${x.w.grant.machineOnly}`, x.w.cookie.mowner)).status).toBe(200)
    await expectCutOff(x)
    await waitFor(() => x.w.m.of('grant-revoked').some((f) => f.userId === x.w.id.machineOnly))
    expect((await api('POST', `/api/pages/${x.w.pageId}/project/previews`, x.w.cookie.machineOnly, { agent: x.w.agent, port: 3005 })).status).toBe(403) // 收回之后不能再共享
  })

  test('到期清扫：效果同收回', async () => {
    const x = await busy()
    await pool.query("UPDATE machine_grants SET expires_at = now() - interval '1 second' WHERE id = $1", [x.w.grant.machineOnly])
    expect(await s.sweepGrants()).toBeGreaterThanOrEqual(1)
    await expectCutOff(x)
  })

  test('授权收窄（machine 换成只有 agent）：预览停止、机器收到 access-reduced；不发 grant-revoked', async () => {
    const w = await world()
    await grantVia(w, 'plain', ['agent', 'machine'])
    const p = await shareOk(w, w.cookie.plain, 3000)
    const pv = await enterPreview(w, w.cookie.viewer, p)
    expect((await viaPreview(pv, '/')).status).toBe(200)
    await grantVia(w, 'plain', ['agent'])
    await waitFor(() => w.m.of('access-reduced').length === 1)
    expect(w.m.of('access-reduced')).toEqual([{ t: 'access-reduced', userId: w.id.plain, scope: 'machine' }])
    expect(w.m.of('grant-revoked')).toEqual([])
    expect((await viaPreview(pv, '/')).status).toBe(404)
    expect((await list(w, w.cookie.viewer)).previews).toEqual([])
  })

  test('就算没有任何收回事件，共享人的授权判定为假了，下一个请求也不转发（并把预览停掉）', async () => {
    const { w, p, pv } = await ready()
    const mine = await shareOk(w, w.cookie.machineOnly, 3002)
    const pv2 = await enterPreview(w, w.cookie.viewer, mine)
    expect((await viaPreview(pv2, '/')).status).toBe(200)
    await pool.query('UPDATE machine_grants SET revoked_at = now() WHERE id = $1', [w.grant.machineOnly])
    const before = w.m.of('http-req').length
    expect((await viaPreview(pv2, '/')).status).toBe(404)
    expect(w.m.of('http-req')).toHaveLength(before)
    expect((await list(w, w.cookie.viewer)).previews.map((x) => x.id)).toEqual([p])
    expect((await viaPreview(pv, '/')).status).toBe(200) // 主人共享的照旧
  })

  test('共享人被移出空间：他留下的共享不再对读者开放（预览停止，请求 404）', async () => {
    const w = await world()
    const p = await shareOk(w, w.cookie.machineOnly, 3000)
    const pv = await enterPreview(w, w.cookie.viewer, p)
    expect((await viaPreview(pv, '/')).status).toBe(200)
    await pool.query('DELETE FROM space_members WHERE user_id = $1', [w.id.machineOnly])
    const before = w.m.of('http-req').length
    expect((await viaPreview(pv, '/')).status).toBe(404)
    expect(w.m.of('http-req')).toHaveLength(before)
    expect((await list(w, w.cookie.viewer)).previews).toEqual([])
  })

  test('读者失去访问：被移出空间 / 页面进回收站，下一个请求 403 且会话作废', async () => {
    const { w, p, pv } = await ready()
    expect((await viaPreview(pv, '/')).status).toBe(200)
    await pool.query('DELETE FROM space_members WHERE user_id = $1', [w.id.viewer])
    const res = await viaPreview(pv, '/')
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('看不到这个页面')
    expect((await viaPreview(pv, '/')).status).toBe(404) // 会话已经没了
    // 页面回收：别的读者也进不去
    const pv2 = await enterPreview(w, w.cookie.plain, p)
    expect((await api('POST', `/api/pages/${w.pageId}/trash`, w.cookie.sowner, {})).status).toBe(200)
    expect((await viaPreview(pv2, '/')).status).toBe(403)
  })
})

describe('机器掉线 / 重连 / 撤销', () => {
  test('掉线：请求回 502 页，登记保留（列表里 online=false）；用同一个 token 重连后中心把预览再登记一遍，流量恢复', async () => {
    const { w, p, pv } = await ready()
    w.m.ws.terminate()
    await waitFor(async () => !(await agentsList(w.cookie.mowner)).some((a) => a.id === w.agent))
    const down = await viaPreview(pv, '/')
    expect(down.status).toBe(502)
    expect(await down.text()).toContain('不在线')
    expect((await list(w, w.cookie.viewer)).previews[0]).toMatchObject({ id: p, online: false })
    const m2 = await connectMachine({ id: w.m.id, name: w.m.name, token: w.m.token, caps: ['project', 'preview'] })
    await waitFor(() => m2.of('port-share').length === 1)
    expect(m2.of('port-share')[0]).toMatchObject({ previewId: p, port: 3000, actor: w.id.mowner })
    expect((await viaPreview(pv, '/')).status).toBe(200)
    expect(lastHttpReq(m2)).toMatchObject({ previewId: p, actor: w.id.mowner })
    expect((await list(w, w.cookie.viewer)).previews[0]).toMatchObject({ online: true })
  })

  test('掉线时在飞的请求失败；重连后 connector 拒绝再登记（共享人已不在它的本机名单里）：预览撤掉', async () => {
    const { w, p, pv } = await ready()
    w.m.httpHandler = () => undefined
    const slow = viaPreview(pv, '/slow').then((r) => r.status).catch(() => 0)
    await waitFor(() => w.m.of('http-req').length === 1)
    w.m.ws.terminate()
    expect(await slow).toBe(502)
    const m2 = await connectMachine({ id: w.m.id, name: w.m.name, token: w.m.token, caps: ['project', 'preview'] })
    m2.refusePty = null
    await waitFor(() => m2.of('port-share').length === 1)
    expect((await list(w, w.cookie.viewer)).previews.map((x) => x.id)).toEqual([p])
  })

  test('connector 被撤销（4403 终态）：这台机器上的预览全部清掉', async () => {
    const { w, pv } = await ready()
    expect((await api('DELETE', `/api/connectors/${w.m.id}`, w.cookie.sowner)).status).toBe(200)
    await waitFor(async () => (await list(w, w.cookie.viewer)).previews.length === 0)
    expect((await viaPreview(pv, '/')).status).toBe(404)
  })

  test('预览帧只来自共享时的凭据：看预览的人没有任何办法让帧署名变成自己', async () => {
    const { w, pv } = await ready()
    await viaPreview(pv, '/a')
    await viaPreview(pv, '/b', { method: 'POST', body: 'x' })
    expect(previewFrames(w.m).filter((f) => f.t !== 'port-share').every((f) => f.actor === w.id.mowner)).toBe(true)
    expect(w.m.by(w.id.viewer)).toEqual([])
    await sleep(0)
  })
})
