// ---------- CSRF 加固：改数据的 /api 请求，来源必须是 Ramet 自己 ----------
// 端口预览的预览源与 Ramet 同主机不同端口，算同站，SameSite=Lax 的登录 cookie 会跟着预览页里的脚本发出去的请求走。
// 预览的是别人机器上的开发服务器，里面的 JS 不可信，所以 /api 的非 GET/HEAD/OPTIONS 请求必须证明自己来自 Ramet 自己的页面：
//   1. 浏览器自带的 `Origin`：带了就必须等于 Ramet 自己的源，否则 403；没带说明不是浏览器（connector、MCP 工具的 Bearer 请求、测试），放行；
//   2. `Sec-Fetch-Site`（页面脚本改不了的禁用头）：same-site / cross-site 都是 403，同站不同端口（预览源）正好是 same-site。
// Ramet 自己的源怎么算：反代会改 Host（web 容器的 nginx 用 `$host` 会丢端口），所以不比协议，只比 host[:port]，
// 来源取请求的 Host 头或 RAMET_PUBLIC_URL。同一主机上别的端口（预览源）两个都对不上，403。
// WebSocket 升级（/collab）同理：浏览器握手带 Origin，对不上就不给升级，不然预览页的脚本能带着登录 cookie 连进协同。

import type { MiddlewareHandler } from 'hono'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Host 头 → 与 URL.host 同形（小写、去默认端口 :80 / :443） */
function normalizeHost(host: string | undefined): string | null {
  if (!host) return null
  try {
    return new URL(`http://${host.trim()}`).host.toLowerCase()
  } catch {
    return null
  }
}

/** 浏览器自报的 Origin 是不是 Ramet 自己。undefined = 没带（非浏览器）= 放行；`null` / 畸形 / 别的主机或端口 = 不放行 */
export function originAllowed(origin: string | undefined, host: string | undefined, publicUrl: string | undefined = process.env.RAMET_PUBLIC_URL): boolean {
  if (origin === undefined) return true
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false // 'null'（沙箱 iframe / 隐私上下文）等
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.host === normalizeHost(host)) return true
  if (publicUrl) {
    try {
      if (new URL(publicUrl).host === parsed.host) return true
    } catch {
      // 配置写坏了：当没配
    }
  }
  return false
}

export function csrfGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next()
    const site = c.req.header('sec-fetch-site')
    const blocked =
      site === 'same-site' || site === 'cross-site' || !originAllowed(c.req.header('origin'), c.req.header('host'))
    if (blocked) return c.json({ error: 'forbidden', message: '跨来源的请求被拒绝了' }, 403)
    return next()
  }
}
