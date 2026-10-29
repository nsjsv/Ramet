/* ---------- 预览桥（中心侧登记 + 转发）：用桩 hub，不起服务 ----------
 * 盯：登记 / 名额 / 去重；流量帧署名是共享人；回帧必须来自这台 connector；响应头过滤；响应超限掐断；并发上限；
 * 撤销（共享人授权没了）即断；掉线 / 终态断开 / 重连后再登记。 */
import { describe, expect, test } from 'vitest'
import { assertLocalOwner } from './machine-access.js'
import type { ConnMsg, DrivenMsg } from './protocol.js'
import { PreviewBridge, PreviewBusyError, PreviewLimitError, PreviewOfflineError, safeResponseHeaders, type HttpSink, type PreviewHub, type WsSink } from './preview-bridge.js'
import { PREVIEW_MAX_INFLIGHT, PREVIEW_MAX_WS, PREVIEW_RES_BODY_MAX } from './preview-types.js'

const admin = (id: string) => ({ id, role: 'admin' })
// assertLocalOwner 签的是 machine='local' 的凭据：桩 hub 就把它当那台机器
const passOf = (id: string) => assertLocalOwner(admin(id), 'machine')

function stub() {
  const frames: DrivenMsg[] = []
  const requests: DrivenMsg[] = []
  let online = true
  let reply: (msg: DrivenMsg) => ConnMsg = (msg) => ({ t: 'res', rid: 'rid' in msg ? msg.rid : '', project: { op: msg.t === 'port-unshare' ? 'port-unshare' : 'port-share' } })
  const hub: PreviewHub = {
    online: () => online,
    frame: (pass, build) => {
      if (!online) throw new Error('connector 不在线')
      frames.push(build(pass.userId))
    },
    request: async (pass, build) => {
      if (!online) throw new Error('connector 不在线')
      const msg = build('r1', pass.userId)
      requests.push(msg)
      return reply(msg)
    },
  }
  return {
    hub,
    frames,
    requests,
    setOnline: (v: boolean) => (online = v),
    setReply: (fn: typeof reply) => (reply = fn),
  }
}

function sinkOf() {
  const log = { head: [] as Array<[number, [string, string][]]>, body: [] as Buffer[], end: 0, broken: [] as string[], fail: [] as Array<[number, string]> }
  const sink: HttpSink = {
    head: (s, h) => log.head.push([s, h]),
    body: (c) => log.body.push(c),
    end: () => void (log.end += 1),
    broken: (m) => log.broken.push(m),
    fail: (s, m) => log.fail.push([s, m]),
  }
  return { sink, log }
}

async function shared(st = stub(), opts: { user?: string; page?: string; port?: number } = {}) {
  const bridge = new PreviewBridge(st.hub)
  const preview = await bridge.share({
    pageId: opts.page ?? 'page1',
    pass: passOf(opts.user ?? 'u1'),
    sharedByName: 'alice',
    machineName: 'box',
    port: opts.port ?? 3000,
    path: '/',
  })
  return { st, bridge, preview }
}

const req = { method: 'GET', path: '/x', headers: [] as [string, string][], hasBody: false }
const b64 = (s: string): string => Buffer.from(s).toString('base64')

describe('登记', () => {
  test('共享先让 connector 登记（署名 = 共享人），成功才进中心的登记表；同页同机同端口是同一条', async () => {
    const { st, bridge, preview } = await shared()
    expect(st.requests[0]).toMatchObject({ t: 'port-share', actor: 'u1', previewId: preview.id, port: 3000 })
    expect(bridge.get(preview.id)).toBe(preview)
    const again = await bridge.share({ pageId: 'page1', pass: passOf('u2'), sharedByName: 'bob', machineName: 'box', port: 3000, path: '/x' })
    expect(again.id).toBe(preview.id)
    expect(st.requests.length).toBe(1) // 没有重复登记
    const other = await bridge.share({ pageId: 'page2', pass: passOf('u1'), sharedByName: 'alice', machineName: 'box', port: 3000, path: '/' })
    expect(other.id).not.toBe(preview.id)
    expect(bridge.list('page1').map((p) => p.id)).toEqual([preview.id])
  })

  test('每台机器最多 5 个；停掉一个名额就回来', async () => {
    const { bridge } = await shared()
    for (const port of [3001, 3002, 3003, 3004]) await bridge.share({ pageId: 'page1', pass: passOf('u1'), sharedByName: 'a', machineName: 'box', port, path: '/' })
    await expect(bridge.share({ pageId: 'page1', pass: passOf('u1'), sharedByName: 'a', machineName: 'box', port: 3005, path: '/' })).rejects.toBeInstanceOf(PreviewLimitError)
    const first = bridge.list('page1')[0]!
    bridge.unshare(first.id)
    await expect(bridge.share({ pageId: 'page1', pass: passOf('u1'), sharedByName: 'a', machineName: 'box', port: 3005, path: '/' })).resolves.toBeTruthy()
  })

  test('connector 拒绝登记（共享人不在它的本机名单里）：不进登记表，错误原样抛出', async () => {
    const st = stub()
    st.setReply((msg) => ({ t: 'err', rid: 'rid' in msg ? msg.rid : '', message: '这台机器不允许你使用', code: 'forbidden' }))
    const bridge = new PreviewBridge(st.hub)
    await expect(bridge.share({ pageId: 'p', pass: passOf('u1'), sharedByName: 'a', machineName: 'box', port: 3000, path: '/' })).rejects.toMatchObject({ forbidden: true })
    expect(bridge.list('p')).toEqual([])
  })

  test('机器不在线：不能共享', async () => {
    const st = stub()
    st.setOnline(false)
    const bridge = new PreviewBridge(st.hub)
    await expect(bridge.share({ pageId: 'p', pass: passOf('u1'), sharedByName: 'a', machineName: 'box', port: 3000, path: '/' })).rejects.toBeInstanceOf(PreviewOfflineError)
  })

  test('登记 / 撤销都会通知（失效会话、广播给在线客户端）', async () => {
    const st = stub()
    const bridge = new PreviewBridge(st.hub)
    const events: string[] = []
    bridge.onEvent = (ev) => events.push(`${ev.type}:${ev.preview.port}`)
    const p = await bridge.share({ pageId: 'p', pass: passOf('u1'), sharedByName: 'a', machineName: 'box', port: 3000, path: '/' })
    bridge.unshare(p.id)
    expect(events).toEqual(['added:3000', 'removed:3000'])
    expect(st.requests.at(-1)).toMatchObject({ t: 'port-unshare', previewId: p.id })
  })
})

describe('HTTP 转发', () => {
  test('http-req 以共享人署名，带 previewId；响应头 / 体 / 结束交给 sink', async () => {
    const { st, bridge, preview } = await shared()
    const { sink, log } = sinkOf()
    bridge.openHttp(preview, { ...req, headers: [['accept', '*/*']] }, sink)
    const sent = st.frames[0]!
    expect(sent).toMatchObject({ t: 'http-req', actor: 'u1', previewId: preview.id, method: 'GET', path: '/x', hasBody: false })
    const reqId = (sent as Extract<DrivenMsg, { t: 'http-req' }>).reqId
    bridge.ingest('local', { t: 'http-res', reqId, status: 200, headers: [['content-type', 'text/plain']] })
    bridge.ingest('local', { t: 'http-res-body', reqId, chunk: b64('he') })
    bridge.ingest('local', { t: 'http-res-body', reqId, chunk: b64('llo') })
    bridge.ingest('local', { t: 'http-res-body', reqId, end: true })
    expect(log.head).toEqual([[200, [['content-type', 'text/plain']]]])
    expect(Buffer.concat(log.body).toString()).toBe('hello')
    expect(log.end).toBe(1)
    // 结束后再来的帧无处可去
    bridge.ingest('local', { t: 'http-res-body', reqId, chunk: b64('late') })
    expect(log.body.length).toBe(2)
  })

  test('回帧必须来自这台 connector：别的机器不能回我的请求', async () => {
    const { st, bridge, preview } = await shared()
    const { sink, log } = sinkOf()
    bridge.openHttp(preview, req, sink)
    const reqId = (st.frames[0] as Extract<DrivenMsg, { t: 'http-req' }>).reqId
    bridge.ingest('other-machine', { t: 'http-res', reqId, status: 200, headers: [] })
    bridge.ingest('other-machine', { t: 'http-fail', reqId, status: 502, message: 'x' })
    expect(log.head).toEqual([])
    expect(log.fail).toEqual([])
    bridge.ingest('local', { t: 'http-res', reqId, status: 200, headers: [] })
    expect(log.head.length).toBe(1)
  })

  test('请求体分片：每片署名 = 共享人；end / abort', async () => {
    const { st, bridge, preview } = await shared()
    const { sink } = sinkOf()
    const flight = bridge.openHttp(preview, { ...req, method: 'POST', hasBody: true }, sink)
    flight.write(Buffer.alloc(150 * 1024, 1)) // 切成 64KB 的片
    flight.end()
    const bodies = st.frames.filter((f) => f.t === 'http-body')
    expect(bodies.length).toBe(4)
    expect(bodies.every((f) => f.actor === 'u1' && f.previewId === preview.id)).toBe(true)
    expect(bodies.at(-1)).toMatchObject({ end: true })
    flight.abort()
    expect(st.frames.at(-1)).toMatchObject({ t: 'http-body', abort: true })
  })

  test('响应头过滤：逐跳头去掉；想设 Ramet cookie 的 Set-Cookie 丢掉，其余 cookie 保留', () => {
    expect(
      safeResponseHeaders([
        ['content-type', 'text/html'],
        ['connection', 'close'],
        ['transfer-encoding', 'chunked'],
        ['set-cookie', 'ramet_session=evil; Path=/'],
        ['set-cookie', 'ramet_pv=x'],
        ['set-cookie', 'app=1; Path=/; HttpOnly'],
        ['Set-Cookie', 'RAMET_other=1'],
      ]),
    ).toEqual([
      ['content-type', 'text/html'],
      ['set-cookie', 'app=1; Path=/; HttpOnly'],
    ])
  })

  test('不认识的响应头状态 / 重复的 http-res：当成上游坏了（502）', async () => {
    const { st, bridge, preview } = await shared()
    for (const status of [100, 101, 199, 600, 'x' as unknown as number]) {
      const { sink, log } = sinkOf()
      bridge.openHttp(preview, req, sink)
      const reqId = (st.frames.at(-1) as Extract<DrivenMsg, { t: 'http-req' }>).reqId
      bridge.ingest('local', { t: 'http-res', reqId, status, headers: [] })
      expect(log.fail.map((f) => f[0]), String(status)).toEqual([502])
    }
    const { sink, log } = sinkOf()
    bridge.openHttp(preview, req, sink)
    const reqId = (st.frames.at(-1) as Extract<DrivenMsg, { t: 'http-req' }>).reqId
    bridge.ingest('local', { t: 'http-res', reqId, status: 200, headers: [] })
    bridge.ingest('local', { t: 'http-res', reqId, status: 200, headers: [] })
    expect(log.head.length).toBe(1)
    expect(log.broken.length).toBe(1) // 头已经发出去了：只能掐断
  })

  test('http-fail：头没发 → 错误页；中途失败 / 响应体 error → 掐断连接', async () => {
    const { st, bridge, preview } = await shared()
    const a = sinkOf()
    bridge.openHttp(preview, req, a.sink)
    bridge.ingest('local', { t: 'http-fail', reqId: (st.frames.at(-1) as Extract<DrivenMsg, { t: 'http-req' }>).reqId, status: 502, message: '连不上' })
    expect(a.log.fail).toEqual([[502, '连不上']])
    const b = sinkOf()
    bridge.openHttp(preview, req, b.sink)
    const reqId = (st.frames.at(-1) as Extract<DrivenMsg, { t: 'http-req' }>).reqId
    bridge.ingest('local', { t: 'http-res', reqId, status: 200, headers: [] })
    bridge.ingest('local', { t: 'http-res-body', reqId, chunk: b64('half') })
    bridge.ingest('local', { t: 'http-res-body', reqId, error: '上游断了' })
    expect(b.log.broken).toEqual(['上游断了'])
    expect(b.log.end).toBe(0)
  })

  test('响应体超过 50MB 上限（流式、没声明长度）：掐断，并让 connector 放弃', async () => {
    const { st, bridge, preview } = await shared()
    const { sink, log } = sinkOf()
    bridge.openHttp(preview, req, sink)
    const reqId = (st.frames.at(-1) as Extract<DrivenMsg, { t: 'http-req' }>).reqId
    bridge.ingest('local', { t: 'http-res', reqId, status: 200, headers: [] })
    const mb = b64('x'.repeat(1024 * 1024))
    for (let i = 0; i < PREVIEW_RES_BODY_MAX / 1024 / 1024; i++) bridge.ingest('local', { t: 'http-res-body', reqId, chunk: mb })
    expect(log.broken).toEqual([])
    bridge.ingest('local', { t: 'http-res-body', reqId, chunk: mb })
    expect(log.broken.length).toBe(1)
    expect(log.broken[0]).toContain('50')
    expect(st.frames.at(-1)).toMatchObject({ t: 'http-body', reqId, abort: true })
    expect(log.body.length).toBe(PREVIEW_RES_BODY_MAX / 1024 / 1024) // 超限的那一片没有交出去
  })

  test('并发上限：这台机器上在飞的请求满了，新的得到 PreviewBusyError；结束一个就腾出位置', async () => {
    const { st, bridge, preview } = await shared()
    for (let i = 0; i < PREVIEW_MAX_INFLIGHT; i++) bridge.openHttp(preview, req, sinkOf().sink)
    expect(() => bridge.openHttp(preview, req, sinkOf().sink)).toThrow(PreviewBusyError)
    const first = st.frames[0] as Extract<DrivenMsg, { t: 'http-req' }>
    bridge.ingest('local', { t: 'http-fail', reqId: first.reqId, status: 502, message: 'x' })
    expect(() => bridge.openHttp(preview, req, sinkOf().sink)).not.toThrow()
  })

  test('机器不在线：openHttp 抛 PreviewOfflineError，不留悬空请求', async () => {
    const { st, bridge, preview } = await shared()
    st.setOnline(false)
    expect(() => bridge.openHttp(preview, req, sinkOf().sink)).toThrow(PreviewOfflineError)
    st.setOnline(true)
    for (let i = 0; i < PREVIEW_MAX_INFLIGHT; i++) bridge.openHttp(preview, req, sinkOf().sink) // 名额没被吃掉
  })
})

describe('撤销即断', () => {
  test('共享人的授权没了（dropUser）：他的预览全删，在飞的请求当场失败，connector 被告知放弃；别人的不受影响', async () => {
    const st = stub()
    const bridge = new PreviewBridge(st.hub)
    const mine = await bridge.share({ pageId: 'p', pass: passOf('u1'), sharedByName: 'a', machineName: 'box', port: 3000, path: '/' })
    const theirs = await bridge.share({ pageId: 'p', pass: passOf('u2'), sharedByName: 'b', machineName: 'box', port: 3001, path: '/' })
    const removed: string[] = []
    bridge.onEvent = (ev) => ev.type === 'removed' && removed.push(ev.preview.id)
    const a = sinkOf()
    const b = sinkOf()
    bridge.openHttp(mine, req, a.sink)
    bridge.openHttp(theirs, req, b.sink)
    expect(bridge.dropUser('local', 'u1')).toBe(1)
    expect(removed).toEqual([mine.id])
    expect(bridge.get(mine.id)).toBeUndefined()
    expect(bridge.get(theirs.id)).toBe(theirs)
    expect(a.log.fail.map((f) => f[0])).toEqual([410])
    expect(b.log.fail).toEqual([])
    expect(st.frames.some((f) => f.t === 'http-body' && f.abort && f.actor === 'u1')).toBe(true)
  })

  test('机器掉线：在飞的请求失败（502），登记保留（请求得到 502 页）；终态断开（撤销）连登记一起清', async () => {
    const { bridge, preview } = await shared()
    const a = sinkOf()
    bridge.openHttp(preview, req, a.sink)
    bridge.connectorGone('local', false)
    expect(a.log.fail.map((f) => f[0])).toEqual([502])
    expect(bridge.get(preview.id)).toBe(preview)
    bridge.connectorGone('local', true)
    expect(bridge.get(preview.id)).toBeUndefined()
  })

  test('重新连上：把还在共享的再登记一遍；connector 拒绝（共享人已不在它的名单里）的撤掉', async () => {
    const { st, bridge, preview } = await shared()
    st.requests.length = 0
    bridge.resync('local')
    await new Promise((r) => setTimeout(r, 10))
    expect(st.requests).toEqual([{ t: 'port-share', rid: 'r1', actor: 'u1', previewId: preview.id, port: 3000 }])
    expect(bridge.get(preview.id)).toBe(preview)
    st.setReply((msg) => ({ t: 'err', rid: 'rid' in msg ? msg.rid : '', message: 'no', code: 'forbidden' }))
    bridge.resync('local')
    await new Promise((r) => setTimeout(r, 10))
    expect(bridge.get(preview.id)).toBeUndefined()
  })
})

describe('WebSocket 转发', () => {
  function wsSink() {
    const log = { ready: [] as string[], data: [] as Array<[string, boolean]>, end: [] as Array<[number, string, boolean]> }
    const sink: WsSink = {
      ready: (p) => log.ready.push(p),
      data: (d, bin) => log.data.push([typeof d === 'string' ? d : d.toString('hex'), bin]),
      end: (c, r, o) => log.end.push([c, r, o]),
    }
    return { sink, log }
  }

  test('ws-open → ws-ready 才算连上；连上之前的 ws-data 不交出去；双向转发（text 原样，binary 经 base64）', async () => {
    const { st, bridge, preview } = await shared()
    const { sink, log } = wsSink()
    const link = bridge.openWs(preview, { path: '/ws', headers: [], protocols: ['vite-hmr'] }, sink)
    const open = st.frames.find((f) => f.t === 'ws-open') as Extract<DrivenMsg, { t: 'ws-open' }>
    expect(open).toMatchObject({ actor: 'u1', previewId: preview.id, path: '/ws', protocols: ['vite-hmr'] })
    bridge.ingest('local', { t: 'ws-data', wsId: open.wsId, data: 'early', binary: false })
    expect(log.data).toEqual([])
    bridge.ingest('local', { t: 'ws-ready', wsId: open.wsId, protocol: 'vite-hmr' })
    bridge.ingest('local', { t: 'ws-data', wsId: open.wsId, data: 'hi', binary: false })
    bridge.ingest('local', { t: 'ws-data', wsId: open.wsId, data: Buffer.from([1, 2]).toString('base64'), binary: true })
    expect(log.ready).toEqual(['vite-hmr'])
    expect(log.data).toEqual([['hi', false], ['0102', true]])
    link.send('up', false)
    link.send(Buffer.from([9]), true)
    expect(st.frames.filter((f) => f.t === 'ws-msg')).toMatchObject([{ data: 'up', binary: false, actor: 'u1' }, { data: Buffer.from([9]).toString('base64'), binary: true }])
    link.close(1000)
    expect(st.frames.at(-1)).toMatchObject({ t: 'ws-close', wsId: open.wsId, code: 1000 })
    bridge.ingest('local', { t: 'ws-end', wsId: open.wsId, code: 1000, reason: '', opened: true }) // 已经关了：不再回调
    expect(log.end).toEqual([])
  })

  test('握手阶段失败（ws-end opened=false）/ 别的机器的回帧忽略 / 并发上限 / 预览被撤销时 WebSocket 一起结束', async () => {
    const { st, bridge, preview } = await shared()
    const { sink, log } = wsSink()
    bridge.openWs(preview, { path: '/ws', headers: [], protocols: [] }, sink)
    const open = st.frames.find((f) => f.t === 'ws-open') as Extract<DrivenMsg, { t: 'ws-open' }>
    bridge.ingest('other', { t: 'ws-end', wsId: open.wsId, code: 1011, reason: 'x', opened: false })
    expect(log.end).toEqual([])
    bridge.ingest('local', { t: 'ws-end', wsId: open.wsId, code: 1011, reason: '上游拒绝', opened: false })
    expect(log.end).toEqual([[1011, '上游拒绝', false]])

    for (let i = 0; i < PREVIEW_MAX_WS; i++) bridge.openWs(preview, { path: '/ws', headers: [], protocols: [] }, wsSink().sink)
    expect(() => bridge.openWs(preview, { path: '/ws', headers: [], protocols: [] }, wsSink().sink)).toThrow(PreviewBusyError)

    const last = wsSink()
    const st2 = stub()
    const { bridge: b2, preview: p2 } = await shared(st2)
    b2.openWs(p2, { path: '/ws', headers: [], protocols: [] }, last.sink)
    const open2 = st2.frames.find((f) => f.t === 'ws-open') as Extract<DrivenMsg, { t: 'ws-open' }>
    b2.ingest('local', { t: 'ws-ready', wsId: open2.wsId, protocol: '' })
    b2.unshare(p2.id)
    expect(last.log.end[0]?.[0]).toBe(1001)
    expect(st2.frames.some((f) => f.t === 'ws-close' && f.wsId === open2.wsId)).toBe(true)
  })
})
