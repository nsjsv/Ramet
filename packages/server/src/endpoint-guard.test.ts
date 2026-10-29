import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  UnsafeEndpointError,
  assertSafeUrlShape,
  createGuardedLookup,
  createSafeFetch,
  isForbiddenAddress,
  validateEndpoint,
  type Resolver,
} from './endpoint-guard.js'

const resolveTo =
  (...addresses: string[]): Resolver =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

describe('SSRF：地址判定（isForbiddenAddress）', () => {
  it.each([
    // IPv4：回环 / 私网 / 链路本地（含云元数据）/ 0/8 / CGNAT / 保留
    ['127.0.0.1'], ['127.255.255.254'], ['10.0.0.1'], ['10.255.255.255'],
    ['172.16.0.1'], ['172.31.255.255'], ['192.168.0.1'], ['192.168.255.255'],
    ['169.254.169.254'], ['169.254.0.1'], ['0.0.0.0'], ['0.1.2.3'],
    ['100.64.0.1'], ['100.127.255.255'], ['224.0.0.1'], ['255.255.255.255'], ['198.18.0.1'],
    // IPv6：回环 / 未指定 / ULA / 链路本地 / 组播
    ['::1'], ['::'], ['fc00::1'], ['fd12:3456:789a::1'], ['fe80::1'], ['febf::1'], ['ff02::1'],
    // IPv4 映射 / 兼容 / NAT64 / 6to4 写法：按内嵌的 IPv4 判
    ['::ffff:127.0.0.1'], ['::ffff:7f00:1'], ['::ffff:10.0.0.1'], ['::ffff:169.254.169.254'], ['::ffff:a9fe:a9fe'],
    ['::127.0.0.1'], ['64:ff9b::7f00:1'], ['64:ff9b::a9fe:a9fe'], ['2002:7f00:1::1'], ['2002:a9fe:a9fe::'],
    // 写法变体
    ['0:0:0:0:0:0:0:1'], ['0000:0000:0000:0000:0000:ffff:7f00:0001'], ['[::1]'], ['fe80::1%eth0'],
    // 认不出来：失败即拒绝
    ['not-an-ip'], [''], ['999.1.1.1'],
  ])('禁止 %s', (addr) => {
    expect(isForbiddenAddress(addr)).toBe(true)
  })

  it.each([
    ['1.1.1.1'], ['8.8.8.8'], ['93.184.216.34'], ['172.15.255.255'], ['172.32.0.1'], ['100.63.255.255'], ['100.128.0.1'],
    ['169.253.1.1'], ['11.0.0.1'], ['2606:4700:4700::1111'], ['2001:4860:4860::8888'], ['::ffff:8.8.8.8'], ['64:ff9b::808:808'],
  ])('公网放行 %s', (addr) => {
    expect(isForbiddenAddress(addr)).toBe(false)
  })
})

describe('SSRF：地址形状（assertSafeUrlShape）', () => {
  it('http 被拒；只允许 https', () => {
    expect(() => assertSafeUrlShape('http://api.example.com/v1')).toThrow(/https/)
    expect(() => assertSafeUrlShape('ftp://api.example.com')).toThrow(UnsafeEndpointError)
    expect(() => assertSafeUrlShape('file:///etc/passwd')).toThrow(UnsafeEndpointError)
    expect(() => assertSafeUrlShape('not a url')).toThrow(UnsafeEndpointError)
    expect(assertSafeUrlShape('https://api.example.com/v1').hostname).toBe('api.example.com')
  })

  it('地址里带用户名密码被拒', () => {
    expect(() => assertSafeUrlShape('https://user:pass@api.example.com/')).toThrow(/用户名/)
    expect(() => assertSafeUrlShape('https://user@api.example.com/')).toThrow(/用户名/)
  })

  it.each([
    ['https://127.0.0.1/v1'],
    ['https://127.0.0.1:8443/v1'],
    ['https://10.0.0.5/'],
    ['https://172.16.3.4/'],
    ['https://192.168.1.1/'],
    ['https://169.254.169.254/latest/meta-data'],
    ['https://0.0.0.0/'],
    ['https://100.64.0.1/'],
    ['https://[::1]/'],
    ['https://[fe80::1]/'],
    ['https://[fd00::1]/'],
    ['https://[::ffff:127.0.0.1]/'],
    ['https://[::ffff:7f00:1]/'],
    ['https://[::ffff:169.254.169.254]/'],
    // 十进制 / 十六进制 / 省略写法：URL 解析器会规整成点分十进制，仍然要被拦
    ['https://2130706433/'],
    ['https://0x7f000001/'],
    ['https://0x7f.1/'],
    ['https://127.1/'],
    ['https://017700000001/'],
    ['https://2852039166/'],
    // localhost 不靠 DNS 判断
    ['https://localhost/v1'],
    ['https://LOCALHOST:8443/'],
    ['https://foo.localhost/'],
    ['https://localhost./'],
  ])('IP 字面量被拒：%s', (url) => {
    expect(() => assertSafeUrlShape(url)).toThrow(UnsafeEndpointError)
  })
})

describe('SSRF：域名解析（validateEndpoint，DNS 可注入）', () => {
  it('解析到内网 / 回环 / 元数据地址的域名被拒', async () => {
    for (const addr of ['10.0.0.5', '127.0.0.1', '192.168.1.9', '169.254.169.254', '::1', 'fd00::5', '::ffff:10.0.0.1']) {
      await expect(validateEndpoint('https://rebind.example.com/v1', { resolve: resolveTo(addr) })).rejects.toThrow(/内网|本机|保留/)
    }
  })

  it('多个解析结果里只要有一个在内网就拒绝（不能只看第一个）', async () => {
    await expect(validateEndpoint('https://mixed.example.com', { resolve: resolveTo('93.184.216.34', '10.0.0.5') })).rejects.toThrow(UnsafeEndpointError)
    await expect(validateEndpoint('https://mixed.example.com', { resolve: resolveTo('10.0.0.5', '93.184.216.34') })).rejects.toThrow(UnsafeEndpointError)
  })

  it('全是公网地址通过；解析失败 / 解析不到地址被拒', async () => {
    const url = await validateEndpoint('https://api.example.com/v1', { resolve: resolveTo('93.184.216.34', '2606:4700::1111') })
    expect(url.hostname).toBe('api.example.com')
    const unusable = /这个地址不可用/
    await expect(validateEndpoint('https://nx.example.com', { resolve: async () => { throw new Error('ENOTFOUND') } })).rejects.toThrow(unusable)
    await expect(validateEndpoint('https://empty.example.com', { resolve: resolveTo() })).rejects.toThrow(unusable)
    // 解析不到 与 解析到内网 对用户是同一句话（不做探测内网域名的预言机）
    const gone = await validateEndpoint('https://nx.example.com', { resolve: async () => { throw new Error('x') } }).catch((e: Error) => e.message)
    const priv = await validateEndpoint('https://p.example.com', { resolve: resolveTo('10.0.0.1') }).catch((e: Error) => e.message)
    expect(gone).toBe(priv)
  })

  it('IP 字面量不走 DNS 也被拦；形状不对根本不会去解析', async () => {
    let called = 0
    const resolve: Resolver = async () => { called++; return [] }
    await expect(validateEndpoint('https://10.1.1.1', { resolve })).rejects.toThrow(UnsafeEndpointError)
    await expect(validateEndpoint('http://api.example.com', { resolve })).rejects.toThrow(UnsafeEndpointError)
    expect(called).toBe(0)
  })
})

describe('SSRF：连接阶段校验（createGuardedLookup）', () => {
  const call = (lookup: ReturnType<typeof createGuardedLookup>, host: string, all: boolean) =>
    new Promise<{ err: Error | null; result?: unknown; family?: number }>((resolve) => {
      lookup(host, { all }, (err, result, family) => resolve({ err, result, family }))
    })

  it('只把验过的地址交给 socket：单个 / 全部两种回调形态', async () => {
    const lookup = createGuardedLookup(resolveTo('93.184.216.34', '2606:4700::1111'))
    const one = await call(lookup, 'api.example.com', false)
    expect(one).toMatchObject({ err: null, result: '93.184.216.34', family: 4 })
    const all = await call(lookup, 'api.example.com', true)
    expect(all.err).toBeNull()
    expect(all.result).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ])
  })

  it('任何一个地址在内网就整体拒绝，错误可被识别', async () => {
    const lookup = createGuardedLookup(resolveTo('93.184.216.34', '169.254.169.254'))
    const res = await call(lookup, 'api.example.com', true)
    expect(res.err).toBeInstanceOf(UnsafeEndpointError)
    expect(res.result).toBeUndefined()
  })

  it('DNS 重绑定：保存时解析到公网，连接时解析到内网 → 连接阶段这次被拒（每次连接都重新解析并检查）', async () => {
    const answers = [['93.184.216.34'], ['127.0.0.1']]
    let n = 0
    const lookup = createGuardedLookup(async () => (answers[n++] ?? []).map((address) => ({ address, family: 4 })))
    const first = await call(lookup, 'rebind.example.com', false)
    expect(first.err).toBeNull()
    const second = await call(lookup, 'rebind.example.com', false)
    expect(second.err).toBeInstanceOf(UnsafeEndpointError)
  })
})

// ---------- 防护版 fetch：用本机 http 服务当「上游」，看它到底有没有被连到 ----------

type Upstream = { port: number; hits: number; close: () => Promise<void>; requests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: string }> }

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (closers.length) await closers.pop()?.()
})

async function startUpstream(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Upstream> {
  const up: Upstream = { port: 0, hits: 0, requests: [], close: async () => undefined }
  const server = http.createServer((req, res) => {
    up.hits++
    const chunks: Buffer[] = []
    req.on('data', (d: Buffer) => chunks.push(d))
    req.on('end', () => {
      up.requests.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() })
      handler(req, res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  up.port = (server.address() as AddressInfo).port
  up.close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) })
  closers.push(up.close)
  return up
}

describe('SSRF：防护版 fetch（createSafeFetch）', () => {
  it('解析到本机的域名：根本不会去连（上游收到 0 个请求）', async () => {
    const up = await startUpstream((_req, res) => res.end('ok'))
    // transport 换成 http 只是为了「万一防护失效就真的连上、被 hits 抓到」；forbidden 用默认实现
    const safeFetch = createSafeFetch({ resolve: resolveTo('127.0.0.1'), transport: http })
    await expect(safeFetch(`https://rebind.example.com:${up.port}/v1/chat/completions`, { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(UnsafeEndpointError)
    expect(up.hits).toBe(0)
  })

  it('http 地址 / 内网 IP 字面量：同样不会去连', async () => {
    const up = await startUpstream((_req, res) => res.end('ok'))
    const safeFetch = createSafeFetch({ resolve: resolveTo('93.184.216.34'), transport: http })
    await expect(safeFetch(`http://example.com:${up.port}/`)).rejects.toBeInstanceOf(UnsafeEndpointError)
    await expect(safeFetch(`https://127.0.0.1:${up.port}/`)).rejects.toBeInstanceOf(UnsafeEndpointError)
    expect(up.hits).toBe(0)
  })

  it('3xx 不跟随：直接报错，Location 指向的地址一次都没被请求', async () => {
    const target = await startUpstream((_req, res) => res.end('secret'))
    const redirector = await startUpstream((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${target.port}/secret` })
      res.end()
    })
    // 放行本机地址，纯粹测「遇到 3xx 的行为」
    const safeFetch = createSafeFetch({ resolve: resolveTo('127.0.0.1'), transport: http, forbidden: () => false })
    for (const status of [301, 302, 303, 307, 308]) {
      const r = await startUpstream((_req, res) => {
        res.writeHead(status, { location: `http://127.0.0.1:${target.port}/secret` })
        res.end()
      })
      await expect(safeFetch(`https://up.example.com:${r.port}/`, { method: 'POST', body: '{}' })).rejects.toThrow(/重定向/)
    }
    await expect(safeFetch(`https://up.example.com:${redirector.port}/`)).rejects.toBeInstanceOf(UnsafeEndpointError)
    expect(target.hits).toBe(0)
  })

  it('正常转发：请求体 / 头原样到达，主机头是域名，不要压缩；响应按流读', async () => {
    const up = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: 1\n\n')
      setTimeout(() => res.end('data: 2\n\n'), 20)
    })
    const safeFetch = createSafeFetch({ resolve: resolveTo('127.0.0.1'), transport: http, forbidden: () => false })
    const res = await safeFetch(`https://up.example.com:${up.port}/v1/chat/completions?x=1`, {
      method: 'POST',
      headers: { authorization: 'Bearer k', 'content-type': 'application/json', 'accept-encoding': 'gzip' },
      body: JSON.stringify({ a: '你好' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(await res.text()).toBe('data: 1\n\ndata: 2\n\n')
    const got = up.requests[0]!
    expect(got.url).toBe('/v1/chat/completions?x=1')
    expect(got.body).toBe('{"a":"你好"}')
    expect(got.headers.authorization).toBe('Bearer k')
    expect(got.headers.host).toBe(`up.example.com:${up.port}`)
    expect(got.headers['accept-encoding']).toBe('identity')
    expect(Number(got.headers['content-length'])).toBe(Buffer.byteLength('{"a":"你好"}'))
  })

  it('非 2xx 照常返回（由调用方按状态码映射）', async () => {
    const up = await startUpstream((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"slow down"}}')
    })
    const safeFetch = createSafeFetch({ resolve: resolveTo('127.0.0.1'), transport: http, forbidden: () => false })
    const res = await safeFetch(`https://up.example.com:${up.port}/`)
    expect(res.status).toBe(429)
    expect(await res.text()).toContain('slow down')
  })

  it('abort：读到一半取消，请求断开', async () => {
    let closed = false
    const up = await startUpstream((_req, res) => {
      res.writeHead(200)
      res.write('data: 1\n\n')
      res.on('close', () => { closed = true })
    })
    const safeFetch = createSafeFetch({ resolve: resolveTo('127.0.0.1'), transport: http, forbidden: () => false })
    const ctrl = new AbortController()
    const res = await safeFetch(`https://up.example.com:${up.port}/`, { signal: ctrl.signal })
    const reader = res.body!.getReader()
    await reader.read()
    ctrl.abort()
    await expect(reader.read()).rejects.toBeTruthy()
    await expect.poll(() => closed).toBe(true)
    // 已经取消过的 signal：连请求都不发
    const before = up.hits
    await expect(safeFetch(`https://up.example.com:${up.port}/`, { signal: ctrl.signal })).rejects.toBeTruthy()
    expect(up.hits).toBe(before)
  })
})
