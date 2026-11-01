// ---------- 请求是不是经 https 进来的 ----------
// 生产里 TLS 在前面的反代终止（宿主机 / 用户自己的 nginx、Caddy……），由它带上 X-Forwarded-Proto，server 只收到 http，
// 只能看这个头；多层代理时取第一个值（离浏览器最近的一跳）。用于登录 cookie 的 Secure 和拼预览源协议。没有这个头按 http。

import type { Context } from 'hono'

export function isHttpsRequest(c: Context): boolean {
  return c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() === 'https'
}
