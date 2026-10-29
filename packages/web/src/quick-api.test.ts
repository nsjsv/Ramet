import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { forgetAiSettings, getAiSettings, quickReadiness, streamQuick } from './quick-api'

// 覆盖：SSE 流按事件边界解析（分片可切在任何位置，含多字节字符中间）；开流前的失败（400/409/429）折成 code + 人话；
// 取消不算失败；设置 30 秒内复用，改过（forget）就重取；没配连接 / 选了本地通道时 ⌘J 直接给原因、不发请求。

const enc = new TextEncoder()

/** 把整段 SSE 文本按指定字节数切成多个分片的响应 */
function sse(text: string, chunk = 7): Response {
  const bytes = enc.encode(text)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.subarray(i, i + chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const body = { kind: 'rewrite' as const, instruction: '润色', text: '原文' }

beforeEach(() => {
  forgetAiSettings()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

test('delta 按顺序交给回调，done = ok（分片切在多字节字符中间也不乱）', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => sse(ev('delta', { text: '你好' }) + ev('delta', { text: '，世界' }) + ev('done', { stopReason: 'end_turn' }))))
  const got: string[] = []
  const out = await streamQuick(body, (d) => got.push(d), new AbortController().signal)
  expect(out).toEqual({ ok: true })
  expect(got).toEqual(['你好', '，世界'])
})

test('error 事件 → code + message；done 之后的内容不再处理', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => sse(ev('delta', { text: '半' }) + ev('error', { code: 'auth', message: 'API key 无效' }) + ev('delta', { text: '不该收到' }))))
  const got: string[] = []
  const out = await streamQuick(body, (d) => got.push(d), new AbortController().signal)
  expect(out).toEqual({ ok: false, code: 'auth', message: 'API key 无效' })
  expect(got).toEqual(['半'])
})

test('流没有 done 就断了：报「连接中断」，不是成功', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => sse(ev('delta', { text: 'x' }))))
  const out = await streamQuick(body, () => undefined, new AbortController().signal)
  expect(out).toMatchObject({ ok: false, code: 'interrupted' })
})

test('开流前的失败：409 / 429 / 400 带服务端人话和短码', async () => {
  const json = (status: number, payload: unknown) => vi.fn(async () => new Response(JSON.stringify(payload), { status }))
  vi.stubGlobal('fetch', json(409, { error: 'no connection', message: '还没有配置模型连接' }))
  expect(await streamQuick(body, () => undefined, new AbortController().signal)).toEqual({ ok: false, code: 'no connection', message: '还没有配置模型连接' })
  vi.stubGlobal('fetch', json(429, { error: 'rate limited', message: '请求太频繁' }))
  expect(await streamQuick(body, () => undefined, new AbortController().signal)).toMatchObject({ ok: false, code: 'rate limited' })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })))
  expect(await streamQuick(body, () => undefined, new AbortController().signal)).toMatchObject({ ok: false, code: 'http 502' })
})

test('取消：返回 aborted（调用方据此静默），不当成失败展示', async () => {
  const ctrl = new AbortController()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      ctrl.abort()
      throw new DOMException('aborted', 'AbortError')
    }),
  )
  const out = await streamQuick(body, () => undefined, ctrl.signal)
  expect(out).toEqual({ ok: false, code: 'aborted', message: '' })
})

test('请求体原样发给 /api/quick，带 JSON 头', async () => {
  const fetchMock = vi.fn(async () => sse(ev('done', {})))
  vi.stubGlobal('fetch', fetchMock)
  await streamQuick({ kind: 'draft', instruction: '续写', before: '前', after: '后' }, () => undefined, new AbortController().signal)
  const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  expect(call[0]).toBe('/api/quick')
  expect(call[1].method).toBe('POST')
  expect(JSON.parse(call[1].body as string)).toEqual({ kind: 'draft', instruction: '续写', before: '前', after: '后' })
})

const settingsOf = (patch: object) => ({ channel: 'site', activeConnectionId: null, localAgent: null, secretConfigured: true, connections: [], ...patch })

test('设置 30 秒内复用；forget 之后重取', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(settingsOf({})), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  await getAiSettings()
  await getAiSettings()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  forgetAiSettings()
  await getAiSettings()
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('quickReadiness：没连接 / 本地通道 = 不能用并说明原因；配好了 = 可用；取设置失败不拦', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(settingsOf({})), { status: 200 })))
  expect(await quickReadiness()).toMatchObject({ ok: false, message: expect.stringContaining('还没有配置模型连接') })
  forgetAiSettings()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(settingsOf({ channel: 'local', activeConnectionId: 'c1' })), { status: 200 })))
  expect(await quickReadiness()).toMatchObject({ ok: false, message: expect.stringContaining('本地') })
  forgetAiSettings()
  // 本地通道选了机器上的 agent 就可用（不需要模型连接）
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(settingsOf({ channel: 'local', localAgent: 'c:m1:claude' })), { status: 200 })))
  expect(await quickReadiness()).toEqual({ ok: true })
  forgetAiSettings()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(settingsOf({ activeConnectionId: 'c1' })), { status: 200 })))
  expect(await quickReadiness()).toEqual({ ok: true })
  forgetAiSettings()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
  expect(await quickReadiness()).toEqual({ ok: true })
})
