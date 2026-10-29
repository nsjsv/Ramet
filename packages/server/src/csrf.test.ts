/* ---------- CSRF：来源判定（纯函数）----------
 * 端到端（带外来 Origin 的 POST 403、同源与无 Origin 放行、/collab 升级）在 preview-api.test.ts。 */
import { describe, expect, test } from 'vitest'
import { originAllowed } from './csrf.js'

describe('originAllowed', () => {
  test('没带 Origin = 非浏览器（connector / MCP 的 Bearer 请求）：放行', () => {
    expect(originAllowed(undefined, 'localhost:3789', undefined)).toBe(true)
  })

  test('与请求的 Host 同主机同端口：放行（含 vite 代理的开发、反代丢了默认端口的生产）', () => {
    expect(originAllowed('http://localhost:5173', 'localhost:5173', undefined)).toBe(true)
    expect(originAllowed('http://203.0.113.10', '203.0.113.10', undefined)).toBe(true)
    expect(originAllowed('http://example.com', 'example.com:80', undefined)).toBe(true) // 默认端口写不写都一样
    expect(originAllowed('HTTP://Example.COM', 'example.com', undefined)).toBe(true)
    expect(originAllowed('http://[::1]:3789', '[::1]:3789', undefined)).toBe(true)
  })

  test('同主机不同端口（预览源）一律拒绝：这正是要防的', () => {
    expect(originAllowed('http://203.0.113.10:8790', '203.0.113.10', undefined)).toBe(false)
    expect(originAllowed('http://localhost:3790', 'localhost:5173', undefined)).toBe(false)
    expect(originAllowed('http://203.0.113.10:8790', '203.0.113.10:80', undefined)).toBe(false)
  })

  test('别的主机 / null / 畸形 / 非 http(s)：拒绝', () => {
    expect(originAllowed('http://evil.example', 'localhost:5173', undefined)).toBe(false)
    expect(originAllowed('null', 'localhost:5173', undefined)).toBe(false) // 沙箱 iframe（预览页本身就在沙箱 iframe 里）
    expect(originAllowed('garbage', 'localhost:5173', undefined)).toBe(false)
    expect(originAllowed('', 'localhost:5173', undefined)).toBe(false)
    expect(originAllowed('file:///x', 'localhost:5173', undefined)).toBe(false)
    expect(originAllowed('http://localhost:5173', undefined, undefined)).toBe(false) // 没有 Host 可比
  })

  test('反代丢了端口时 RAMET_PUBLIC_URL 兜底；它也不会放行预览源', () => {
    expect(originAllowed('http://example.com:8080', 'example.com', 'http://example.com:8080')).toBe(true)
    expect(originAllowed('http://example.com:8790', 'example.com', 'http://example.com')).toBe(false)
    expect(originAllowed('http://example.com', 'internal:3789', 'http://example.com')).toBe(true)
    expect(originAllowed('http://example.com', 'internal:3789', '没法解析')).toBe(false)
  })

  test('协议不参与比较（反代链路上 X-Forwarded-Proto 会被覆盖，上 TLS 后不能因此全站 403）', () => {
    expect(originAllowed('https://example.com', 'example.com', undefined)).toBe(true)
  })
})
