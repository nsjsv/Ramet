// ---------- 请求是不是经 https 进来的 ----------
// 生产里 TLS 在宿主机 nginx 终止，经 web 容器 nginx 透传 X-Forwarded-Proto（web/nginx.conf 的 $ramet_proto），server 只收到 http，
// 只能看这个头；多层代理时取第一个值（离浏览器最近的一跳）。用于登录 cookie 的 Secure 和拼预览源协议。没有这个头按 http。

import type { Context } from 'hono'

export function isHttpsRequest(c: Context): boolean {
  return c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() === 'https'
}
