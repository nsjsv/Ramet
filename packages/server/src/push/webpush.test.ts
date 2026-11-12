import { createECDH, createPublicKey, verify } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkEndpoint,
  createTransport,
  encryptPayload,
  generateVapidKeys,
  PUSH_HOSTS,
  pushHostsFromEnv,
  pushProxyFromEnv,
  PushNetworkError,
  vapidAuthorization,
} from './webpush.js'

const unb64 = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'base64url')

describe('RFC 8291 附录 A 的向量', () => {
  it('同样的盐与发送方私钥：加密结果逐字节一致', () => {
    const body = encryptPayload(
      Buffer.from('When I grow up, I want to be a watermelon'),
      { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      { salt: unb64('DGv6ra1nlYgDCS1FRnbzlw'), senderPrivate: unb64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') },
    )
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    )
  })

  it('随机盐与临时密钥：每次不同，头部形状对（盐 16 + rs 4096 + 65 字节公钥）', () => {
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') }
    const a = encryptPayload(Buffer.from('{}'), keys)
    const b = encryptPayload(Buffer.from('{}'), keys)
    expect(a.equals(b)).toBe(false)
    expect(a.readUInt32BE(16)).toBe(4096)
    expect(a[20]).toBe(65)
    expect(a[21]).toBe(4)
  })

  it('浏览器公钥不在曲线上 / 长度不对：拒绝', () => {
    const bad = Buffer.alloc(65, 1)
    bad[0] = 4
    expect(() => encryptPayload(Buffer.from('x'), { p256dh: bad.toString('base64url'), auth: Buffer.alloc(16).toString('base64url') })).toThrow()
    expect(() => encryptPayload(Buffer.from('x'), { p256dh: 'AAAA', auth: Buffer.alloc(16).toString('base64url') })).toThrow('invalid subscription keys')
  })

  it('明文超过 3993 字节：拒绝', () => {
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16).toString('base64url') }
    expect(() => encryptPayload(Buffer.alloc(3994), keys)).toThrow('too large')
    expect(() => encryptPayload(Buffer.alloc(3993), keys)).not.toThrow()
  })
})

describe('VAPID（RFC 8292）', () => {
  it('JWT 用公钥验得过，aud = 推送服务的 origin，exp 12 小时，k = 公钥', () => {
    const keys = generateVapidKeys()
    expect(Buffer.from(keys.publicKey, 'base64url')).toHaveLength(65)
    expect(Buffer.from(keys.privateKey, 'base64url')).toHaveLength(32)
    const now = Date.UTC(2026, 10, 11)
    const header = vapidAuthorization(new URL('https://fcm.googleapis.com/fcm/send/abc'), keys, 'https://ramet.example', now)
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)
    expect(m).not.toBeNull()
    const [, head, claims, sig, k] = m as unknown as [string, string, string, string, string]
    expect(k).toBe(keys.publicKey)
    expect(JSON.parse(Buffer.from(head, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: now / 1000 + 12 * 3600,
      sub: 'https://ramet.example',
    })
    const pub = Buffer.from(keys.publicKey, 'base64url')
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' })
    const signature = Buffer.from(sig, 'base64url')
    expect(signature).toHaveLength(64)
    expect(verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true)
  })
})

describe('订阅地址清单（防 SSRF）', () => {
  it('各家推送服务放行（含 Chromium 开源构建的 jmt17.google.com）', () => {
    for (const url of [
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://jmt17.google.com/fcm/send/abc:def',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
      'https://web.push.apple.com/QGuQ',
    ]) {
      expect(checkEndpoint(url, PUSH_HOSTS)?.href).toBe(new URL(url).href)
    }
  })

  it('http、带用户名密码、非默认端口、IP、内网名、仿冒后缀一律拒绝', () => {
    for (const url of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://u:p@fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://127.0.0.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/x',
      'https://evilfcm.googleapis.com.attacker.net/x',
      'https://push.apple.com/x',
      'https://notfcm.googleapis.com/x',
      'https://google.com.attacker.net/x',
      'https://evilgoogle.com/x',
      'not a url',
      `https://fcm.googleapis.com/${'a'.repeat(2100)}`,
    ]) {
      expect(checkEndpoint(url, PUSH_HOSTS)).toBeNull()
    }
  })

  it('RAMET_PUSH_HOSTS 追加主机', () => {
    const hosts = pushHostsFromEnv({ RAMET_PUSH_HOSTS: 'push.example.com, .push.example.org' })
    expect(checkEndpoint('https://push.example.com/a', hosts)).not.toBeNull()
    expect(checkEndpoint('https://eu.push.example.org/a', hosts)).not.toBeNull()
    expect(checkEndpoint('https://other.example.com/a', hosts)).toBeNull()
  })
})

describe('出站代理', () => {
  let proxy: http.Server | undefined
  afterEach(() => proxy?.close())

  it('RAMET_PUSH_PROXY 优先，其次 HTTPS_PROXY / https_proxy；只认 http://', () => {
    expect(pushProxyFromEnv({ RAMET_PUSH_PROXY: 'http://a:1', HTTPS_PROXY: 'http://b:2' })?.host).toBe('a:1')
    expect(pushProxyFromEnv({ https_proxy: 'http://c:3' })?.host).toBe('c:3')
    expect(pushProxyFromEnv({})).toBeNull()
    expect(pushProxyFromEnv({ HTTPS_PROXY: 'socks5://d:4' })).toBeNull()
  })

  it('经 CONNECT 隧道连推送服务；代理拒绝 → 可读的连不上原因', async () => {
    const seen: { url?: string; auth?: string }[] = []
    proxy = http.createServer()
    proxy.on('connect', (req, socket) => {
      seen.push({ url: req.url, auth: req.headers['proxy-authorization'] })
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    })
    await new Promise<void>((resolve) => proxy!.listen(0, '127.0.0.1', resolve))
    const port = (proxy.address() as AddressInfo).port
    const send = createTransport(new URL(`http://user:p%40ss@127.0.0.1:${port}`))
    const err = await send(new URL('https://fcm.googleapis.com/fcm/send/abc'), {}, Buffer.from('x')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PushNetworkError)
    expect((err as PushNetworkError).message).toBe('连不上推送服务 fcm.googleapis.com（代理返回 403）')
    expect(seen).toEqual([{ url: 'fcm.googleapis.com:443', auth: `Basic ${Buffer.from('user:p@ss').toString('base64')}` }])
  })

  it('代理连不上：PushNetworkError 带错误码', async () => {
    const send = createTransport(new URL('http://127.0.0.1:1'))
    const err = await send(new URL('https://fcm.googleapis.com/fcm/send/abc'), {}, Buffer.from('x')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PushNetworkError)
    expect((err as PushNetworkError).code).toBe('ECONNREFUSED')
  })
})
