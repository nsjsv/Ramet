import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createSafeFetch, type Resolver } from './endpoint-guard.js'
import { bookmarkUrl, createLinkPreview, decodeHtml, parseLinkMeta } from './link-preview.js'

describe('parseLinkMeta', () => {
  it('OG 优先于 twitter / <title> / description；相对地址按页面地址解析；实体解码', () => {
    const html = `<!doctype html><html><head>
      <title>标题 &amp; 备用</title>
      <meta name="description" content="普通描述">
      <meta property="og:title" content="OG 标题 &quot;引号&quot;">
      <meta property="og:description" content='OG &#x63cf;&#36848;'>
      <meta property="og:image" content="/img/cover.png">
      <meta property="og:image" content="/img/second.png">
      <meta property="og:site_name" content="示例站">
      <link rel="apple-touch-icon" href="/apple.png">
      <link rel="icon" sizes="16x16" href="/f16.png">
      <link rel="icon" sizes="32x32" href="f32.png">
    </head><body><meta property="og:title" content="正文里的不算"></body></html>`
    expect(parseLinkMeta(html, 'https://example.com/a/b')).toEqual({
      url: 'https://example.com/a/b',
      title: 'OG 标题 "引号"',
      description: 'OG 描述',
      image: 'https://example.com/img/cover.png',
      icon: 'https://example.com/a/f32.png',
      site: '示例站',
    })
  })

  it('没有 OG 退到 <title> / description；没有图标退到 /favicon.ico；非 http(s) 的图片地址丢掉', () => {
    const html = '<head><TITLE>\n  只有   标题\n</TITLE><meta name=description content=简短><meta property="og:image" content="javascript:alert(1)"></head>'
    expect(parseLinkMeta(html, 'http://example.com/x')).toEqual({
      url: 'http://example.com/x',
      title: '只有 标题',
      description: '简短',
      icon: 'http://example.com/favicon.ico',
    })
  })

  it('超长标题截断', () => {
    const meta = parseLinkMeta(`<title>${'长'.repeat(400)}</title>`, 'https://e.com/')
    expect(meta.title!.length).toBe(300)
    expect(meta.title!.endsWith('…')).toBe(true)
  })
})

describe('decodeHtml', () => {
  // 「中文」的 GBK 字节
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
  it('Content-Type 的 charset 优先', () => {
    expect(decodeHtml(Buffer.concat([Buffer.from('<title>'), gbk]), 'text/html; charset=GBK')).toBe('<title>中文')
  })
  it('没有就看 <meta charset> / http-equiv；认不出的编码名退 utf-8', () => {
    expect(decodeHtml(Buffer.concat([Buffer.from('<meta charset="gb2312"><title>'), gbk]), 'text/html')).toContain('中文')
    expect(decodeHtml(Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=gbk">'), gbk]), 'text/html')).toContain('中文')
    expect(decodeHtml(Buffer.from('<title>好</title>'), 'text/html; charset=nonsense')).toBe('<title>好</title>')
  })
})

describe('bookmarkUrl', () => {
  it('只认 http(s) 绝对地址', () => {
    expect(bookmarkUrl('https://example.com/a')).toBe('https://example.com/a')
    for (const bad of [undefined, '', 'javascript:alert(1)', '/page/x', 'ftp://e.com', `https://e.com/${'a'.repeat(2100)}`]) {
      expect(bookmarkUrl(bad)).toBeNull()
    }
  })
})

/* ---------- 抓取：本机 http 服务充当站点，DNS 注入 ---------- */

type Site = { port: number; hits: number; close: () => Promise<void> }
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()))
})

async function site(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Site> {
  const s: Site = { port: 0, hits: 0, close: async () => undefined }
  const server = http.createServer((req, res) => {
    s.hits++
    handler(req, res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  s.port = (server.address() as AddressInfo).port
  s.close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) })
  closers.push(s.close)
  return s
}

// pub.test 解析到本机（测试里当公网放行），inner.test 解析到 10.x（按内网拦下）
const resolve: Resolver = async (host) => [{ address: host.startsWith('inner.') ? '10.0.0.5' : '127.0.0.1', family: 4 }]
const testFetch = () => createSafeFetch({ resolve, allowHttp: true, forbidden: (a) => a.startsWith('10.') })

describe('createLinkPreview', () => {
  it('跟随重定向（相对 Location 也行），给出最终地址与元信息；同一地址第二次走缓存', async () => {
    const s = await site((req, res) => {
      if (req.url === '/go') {
        res.writeHead(301, { location: '/final' })
        return res.end()
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<head><meta property="og:title" content="终点"></head><body>…</body>')
    })
    const preview = createLinkPreview({ fetch: testFetch() })
    const url = `http://pub.test:${s.port}/go`
    expect(await preview.get(url)).toMatchObject({ url: `http://pub.test:${s.port}/final`, title: '终点' })
    await preview.get(url)
    expect(s.hits).toBe(2)
  })

  it('重定向进内网：不去连，只回 { url }', async () => {
    const inner = await site((_req, res) => res.end('<title>机密</title>'))
    const s = await site((_req, res) => {
      res.writeHead(302, { location: `http://inner.test:${inner.port}/` })
      res.end()
    })
    const url = `http://pub.test:${s.port}/`
    expect(await createLinkPreview({ fetch: testFetch() }).get(url)).toEqual({ url })
    expect(inner.hits).toBe(0)
  })

  it('直接给内网地址 / 站点 5xx / 非网页：都只回 { url }（非网页带文件名当标题）', async () => {
    const s = await site((req, res) => {
      if (req.url === '/doc.pdf') {
        res.writeHead(200, { 'content-type': 'application/pdf' })
        return res.end('%PDF')
      }
      res.writeHead(503)
      res.end()
    })
    const preview = createLinkPreview({ fetch: testFetch() })
    expect(await preview.get(`http://inner.test:${s.port}/`)).toEqual({ url: `http://inner.test:${s.port}/` })
    expect(await preview.get(`http://pub.test:${s.port}/down`)).toEqual({ url: `http://pub.test:${s.port}/down` })
    expect(await preview.get(`http://pub.test:${s.port}/doc.pdf`)).toEqual({ url: `http://pub.test:${s.port}/doc.pdf`, title: 'doc.pdf' })
  })

  it('只读到 </head> 就断开，不下载整页', async () => {
    let sent = 0
    const s = await site((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.write('<head><title>大页面</title></head>')
      const timer = setInterval(() => {
        sent++
        if (!res.write('x'.repeat(64 * 1024)) || sent > 200) {
          clearInterval(timer)
          res.end()
        }
      }, 5)
      res.on('close', () => clearInterval(timer))
    })
    expect(await createLinkPreview({ fetch: testFetch() }).get(`http://pub.test:${s.port}/`)).toMatchObject({ title: '大页面' })
    expect(sent).toBeLessThan(200)
  })
})

/* ---------- 中继：配了就全走中继，服务器不直连；地址形状照样先查 ---------- */

describe('createLinkPreview 中继', () => {
  const relay = { url: 'https://relay.test', secret: 's3cret' }
  const relayHtml = (html: string, extra: Record<string, string> = {}) =>
    new Response(html, { headers: { 'x-target-status': '200', 'x-target-type': 'text/html; charset=utf-8', ...extra } })
  const noDirect = async (): Promise<Response> => {
    throw new Error('配了中继不该直连')
  }

  it('带密钥请中继，按中继给的最终地址解析；服务器一次都不直连', async () => {
    const seen: string[] = []
    const preview = createLinkPreview({
      fetch: noDirect,
      relay,
      relayFetch: async (input, init) => {
        seen.push(`${String(input)} ${new Headers(init?.headers).get('authorization')}`)
        return relayHtml('<head><meta property="og:title" content="国内站"></head>', { 'x-final-url': 'https://cn.test/home' })
      },
    })
    expect(await preview.get('https://cn.test/')).toEqual({ url: 'https://cn.test/home', title: '国内站', icon: 'https://cn.test/favicon.ico' })
    expect(seen).toEqual([`https://relay.test/?url=${encodeURIComponent('https://cn.test/')} Bearer s3cret`])
  })

  it('localhost / 内网 IP 字面量不发给中继；中继说目标站 404 / 中继自己出错都只回 { url }；非网页给文件名', async () => {
    let relayed = 0
    const preview = (res: () => Response) =>
      createLinkPreview({
        fetch: noDirect,
        relay,
        relayFetch: async () => {
          relayed++
          return res()
        },
      })
    const p404 = preview(() => new Response(null, { headers: { 'x-target-status': '404' } }))
    expect(await p404.get('http://localhost:8080/')).toEqual({ url: 'http://localhost:8080/' })
    expect(await p404.get('http://10.0.0.5/')).toEqual({ url: 'http://10.0.0.5/' })
    expect(relayed).toBe(0)
    expect(await p404.get('https://z.test/')).toEqual({ url: 'https://z.test/' })
    expect(await preview(() => new Response('forbidden', { status: 403 })).get('https://w.test/')).toEqual({ url: 'https://w.test/' })
    const pdf = preview(() => new Response(null, { headers: { 'x-target-status': '200', 'x-target-type': 'application/pdf', 'x-final-url': 'https://f.test/a.pdf' } }))
    expect(await pdf.get('https://f.test/a.pdf')).toEqual({ url: 'https://f.test/a.pdf', title: 'a.pdf' })
    expect(relayed).toBe(3)
  })

  it('没配中继：照旧由服务器直连', async () => {
    const s = await site((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<title>直连</title>')
    })
    expect(await createLinkPreview({ fetch: testFetch(), relay: null }).get(`http://pub.test:${s.port}/`)).toMatchObject({ title: '直连' })
  })
})
