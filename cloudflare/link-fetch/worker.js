// Cloudflare Worker：网页元信息抓取中继（可选部署）。
// 配了它，服务端（server/src/link-preview.ts）抓网页元信息就一律请这个 Worker 代抓，自己不出站
// （服务器所在网络可能连不上某些网站，比如机房 IP 被目标地区封了）。
// 它只把网页的 <head> 取回来原样转交：解析、编码处理、缓存都在服务端，这里不做。
// 只认带密钥的请求（SECRET，与服务端 RAMET_LINK_RELAY_SECRET 相同），否则就是任何人都能用的开放抓取代理。
// 部署：本目录下 `npx wrangler deploy`，再 `npx wrangler secret put SECRET`；服务端设
// RAMET_LINK_RELAY_URL=https://<worker>.<子域>.workers.dev 与 RAMET_LINK_RELAY_SECRET。
// 走 workers.dev 而不是自定义域名：服务端请求是 HTTP/1.1，自定义域名上的账户级 WAF 可能把它当机器流量质询。

const MAX_BYTES = 512 * 1024
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 RametBot/1.0'

export default {
  async fetch(request, env) {
    if (!env.SECRET || request.headers.get('authorization') !== `Bearer ${env.SECRET}`) return new Response('forbidden', { status: 403 })
    let target
    try {
      target = new URL(new URL(request.url).searchParams.get('url') ?? '')
    } catch {
      return new Response('bad url', { status: 400 })
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return new Response('bad url', { status: 400 })

    let res
    try {
      res = await fetch(target, {
        redirect: 'follow',
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      })
    } catch {
      return new Response('fetch failed', { status: 502 })
    }
    const type = res.headers.get('content-type') ?? ''
    // 目标站的结果放在头里交回：状态、最终地址（跟完重定向）、内容类型（服务端按它的 charset 解码）
    const headers = { 'x-target-status': String(res.status), 'x-final-url': res.url, 'x-target-type': type }
    if (!res.ok || !res.body || !/text\/html|application\/xhtml\+xml/i.test(type)) {
      await res.body?.cancel()
      return new Response(null, { headers })
    }
    // 只读到 </head> 或上限；按 utf-8 宽松解码只为找标签（ASCII 在任何常见编码里都不变），回给服务端的是原始字节
    const reader = res.body.getReader()
    const chunks = []
    let size = 0
    let tail = ''
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
      const text = tail + decoder.decode(value, { stream: true })
      if (size >= MAX_BYTES || /<\/head\s*>/i.test(text)) break
      tail = text.slice(-16)
    }
    await reader.cancel().catch(() => {})
    const body = new Uint8Array(Math.min(size, MAX_BYTES))
    let at = 0
    for (const c of chunks) {
      if (at >= body.length) break
      body.set(c.subarray(0, body.length - at), at)
      at += c.byteLength
    }
    return new Response(body, { headers })
  },
}
