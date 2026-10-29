/* ---------- 端口预览的校验与 cookie 过滤（纯函数）---------- */
import { describe, expect, test } from 'vitest'
import {
  cleanPairs,
  isHopHeader,
  isRametCookieName,
  setsRametCookie,
  stripRametCookies,
  validPort,
  validPreviewPath,
  validRequestTarget,
  wsCloseCode,
} from './preview-types.js'

describe('端口与路径', () => {
  test('端口：1024–65535 的整数', () => {
    for (const ok of [1024, 3000, 5173, 65535]) expect(validPort(ok), String(ok)).toBe(true)
    for (const bad of [0, 80, 1023, 65536, -1, 3000.5, NaN, Infinity, '3000', null, undefined, {}]) expect(validPort(bad), String(bad)).toBe(false)
  })

  test('入口路径：单个 / 开头；// 和 /\\ 会被浏览器当成别的主机（开放重定向），空白 / 控制字符 / 反斜杠不要', () => {
    for (const ok of ['/', '/index.html', '/a/b?x=1&y=2#h', '/中文']) expect(validPreviewPath(ok), ok).toBe(true)
    for (const bad of ['', 'index.html', '//evil.example', '//evil.example/x', '/\\evil.example', 'http://evil.example/', '/a b', '/a\nb', '/a\\b', '/a\u0000', 5, null]) {
      expect(validPreviewPath(bad), JSON.stringify(bad)).toBe(false)
    }
    expect(validPreviewPath('/' + 'a'.repeat(2000))).toBe(false)
  })

  test('转给上游的请求目标：/ 开头、无空白 / 控制字符（不收 http://…，不能借它换目标）', () => {
    for (const ok of ['/', '/src/main.ts?t=1', '//double', '/%20x']) expect(validRequestTarget(ok), ok).toBe(true)
    for (const bad of ['', 'http://evil.example/', '*', 'a', '/a b', '/a\r\nHost: x', '/\u007f']) expect(validRequestTarget(bad), JSON.stringify(bad)).toBe(false)
  })
})

describe('Ramet 自己的 cookie 不能进预览', () => {
  test('请求的 Cookie 头：ramet_ 前缀的（登录会话、预览会话、以后新增的）剥掉，其余原样；剩下空 = null', () => {
    expect(stripRametCookies('ramet_session=abc; theme=dark; ramet_pv=def; x=y')).toBe('theme=dark; x=y')
    expect(stripRametCookies('a=1')).toBe('a=1')
    expect(stripRametCookies('ramet_session=abc; ramet_pv=def')).toBeNull()
    expect(stripRametCookies('RAMET_Session=abc; keep=1')).toBe('keep=1')
    expect(stripRametCookies('ramet_future=1;other=2')).toBe('other=2')
    expect(stripRametCookies('')).toBeNull()
    // 名字里带 ramet 但不是前缀的不动
    expect(stripRametCookies('my_ramet_x=1')).toBe('my_ramet_x=1')
  })

  test('响应的 Set-Cookie：设 Ramet 同名 cookie 的认出来', () => {
    expect(setsRametCookie('ramet_session=evil; Path=/')).toBe(true)
    expect(setsRametCookie('ramet_pv=x; HttpOnly')).toBe(true)
    expect(setsRametCookie('sid=1; Path=/')).toBe(false)
    expect(isRametCookieName(' ramet_x ')).toBe(true)
  })
})

describe('头与关闭码', () => {
  test('逐跳头', () => {
    for (const h of ['Connection', 'keep-alive', 'Transfer-Encoding', 'Upgrade', 'TE', 'proxy-authorization']) expect(isHopHeader(h), h).toBe(true)
    for (const h of ['content-type', 'cookie', 'set-cookie', 'location']) expect(isHopHeader(h), h).toBe(false)
  })

  test('cleanPairs：形状 / 数量 / 大小', () => {
    expect(cleanPairs([['a', 'b']])).toEqual([['a', 'b']])
    expect(cleanPairs('x')).toBeNull()
    expect(cleanPairs([['a']])).toBeNull()
    expect(cleanPairs([['a', 1]])).toBeNull()
    expect(cleanPairs(Array.from({ length: 101 }, () => ['a', 'b']))).toBeNull()
    expect(cleanPairs([['a', 'x'.repeat(70_000)]])).toBeNull()
  })

  test('wsCloseCode：ws 库对不合法的关闭码直接抛错，这里一律归一', () => {
    expect([1000, 1001, 1011, 3000, 4999].map(wsCloseCode)).toEqual([1000, 1001, 1011, 3000, 4999])
    for (const bad of [1004, 1005, 1006, 1015, 999, 2999, 5000, 'x', undefined, 1.5]) expect(wsCloseCode(bad), String(bad)).toBe(1000)
  })
})
