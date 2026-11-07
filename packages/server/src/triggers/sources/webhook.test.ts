/* ---------- 收到外部请求：密钥、请求体转文字、投递编号、限流（纯函数） ---------- */
import { describe, expect, it } from 'vitest'
import { deliveryId, describeWebhook, hookHash, HookLimiter, hookText, newHookToken, parseWebhookConfig } from './webhook.js'

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('密钥与配置', () => {
  it('密钥 43 字 base64url、哈希是 sha256 hex、末 4 位；配置只收空的', () => {
    const a = newHookToken()
    const b = newHookToken()
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.token).not.toBe(b.token)
    expect(a.hash).toBe(hookHash(a.token))
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(a.hint).toBe(a.token.slice(-4))
    expect(parseWebhookConfig(undefined)).toEqual({})
    expect(parseWebhookConfig({})).toEqual({})
    expect(parseWebhookConfig({ secret: 'x' })).toHaveProperty('error')
    expect(describeWebhook({ hint: 'ab_c' })).toBe('外部请求 · 地址 …ab_c')
    expect(describeWebhook({})).toBe('外部请求')
  })
})

describe('hookText', () => {
  it('JSON 排版、坏 JSON 当文本、表单转 JSON（同名成数组）、没写类型的文本原样、二进制 / 控制字符只写大小、空的', () => {
    expect(hookText('application/json; charset=utf-8', bytes('{"a":1}'))).toBe('{\n  "a": 1\n}')
    expect(hookText('application/vnd.api+json', bytes('[1,2]'))).toBe('[\n  1,\n  2\n]')
    expect(hookText('application/json', bytes('{oops'))).toBe('{oops')
    expect(hookText('application/x-www-form-urlencoded', bytes('a=1&b=x+y&b=%E4%B8%AD'))).toBe(JSON.stringify({ a: '1', b: ['x y', '中'] }, null, 2))
    expect(hookText(undefined, bytes('你好\n\tworld'))).toBe('你好\n\tworld')
    expect(hookText('application/octet-stream', new Uint8Array([0xff, 0xfe]))).toBe('（二进制内容，2 字节，没有转成文字）')
    expect(hookText('text/plain', bytes('a\u0000b'))).toBe('（二进制内容，3 字节，没有转成文字）')
    expect(hookText('application/json', new Uint8Array())).toBe('（空的请求体）')
  })
})

describe('deliveryId', () => {
  it('按 Idempotency-Key > X-GitHub-Delivery > X-Request-Id 取，形状不对的跳过', () => {
    const h = (m: Record<string, string>) => (name: string) => m[name]
    expect(deliveryId(h({ 'x-request-id': 'r', 'idempotency-key': 'k' }))).toBe('k')
    expect(deliveryId(h({ 'idempotency-key': 'has space', 'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958' }))).toBe(
      '72d3162e-cc78-11e3-81ab-4c9367dc0958',
    )
    expect(deliveryId(h({ 'x-request-id': 'x'.repeat(101) }))).toBeNull()
    expect(deliveryId(h({}))).toBeNull()
  })
})

describe('HookLimiter', () => {
  it('每分钟 / 每小时的上限，超了给要等的秒数；不同地址分开数；窗口滑过去就放行', () => {
    const l = new HookLimiter({ minute: 2, hour: 3 })
    const t = 1_000_000
    expect(l.take('a', t)).toBe(0)
    expect(l.take('a', t + 1000)).toBe(0)
    expect(l.take('a', t + 2000)).toBe(58)
    expect(l.take('b', t + 2000)).toBe(0)
    expect(l.take('a', t + 61_000)).toBe(0)
    // 一小时里第 4 次
    expect(l.take('a', t + 200_000)).toBe(Math.ceil((t + 3_600_000 - (t + 200_000)) / 1000))
    expect(l.take('a', t + 3_601_000)).toBe(0)
  })
})
