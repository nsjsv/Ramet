// 随手 AI 的模型调用层：协议矩阵（发哪些参数）、OpenAI 兼容流解析、错误映射。不碰数据库、不打真实模型：
// 上游是本机 http 服务，经防护版 fetch 的 transport 注入口连过去。
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import Anthropic from '@anthropic-ai/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import {
  QUICK_SYSTEM_PROMPT,
  UpstreamHttpError,
  anthropicRequestParams,
  buildUserMessage,
  chatCompletionsUrl,
  createModelCaller,
  describeModelError,
  parseOpenAiLine,
  type ModelChunk,
  type ModelRequest,
} from './quick.js'
import { UnsafeEndpointError, type Resolver } from './endpoint-guard.js'

const base = { system: QUICK_SYSTEM_PROMPT, user: 'hello', apiKey: 'sk-test-1234' }

describe('协议矩阵：anthropic 发哪些参数', () => {
  const req = (model: string, baseUrl: string | null = null): ModelRequest => ({ ...base, protocol: 'anthropic', baseUrl, model })

  it('官方地址 + Opus 5.5：beta 接口，effort=low，带 fallback；不传 thinking', () => {
    const built = anthropicRequestParams(req('claude-opus-5-5'))
    expect(built.kind).toBe('beta')
    expect(Object.keys(built.params).sort()).toEqual(['betas', 'fallbacks', 'max_tokens', 'messages', 'model', 'output_config', 'system'])
    const p = built.params as Record<string, unknown>
    expect(p.output_config).toEqual({ effort: 'low' })
    expect(p.betas).toEqual(['server-side-fallback-2026-07-01'])
    expect(p.fallbacks).toBe('default')
    expect(p.max_tokens).toBe(16000)
    expect(p).not.toHaveProperty('thinking')
    expect(p.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('官方地址 + Sonnet 5.5：同样带 fallback', () => {
    const p = anthropicRequestParams(req('claude-sonnet-5-5')).params as Record<string, unknown>
    expect(p.betas).toEqual(['server-side-fallback-2026-07-01'])
    expect(p.fallbacks).toBe('default')
  })

  it('官方地址 + Haiku 5.5：有 effort，不带 betas / fallbacks', () => {
    const built = anthropicRequestParams(req('claude-haiku-5-5'))
    expect(built.kind).toBe('beta')
    expect(Object.keys(built.params).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config', 'system'])
  })

  it('自定义地址：非 beta 接口，只发 model / max_tokens / system / messages，不带任何 Anthropic 专有参数', () => {
    for (const model of ['claude-opus-5-5', 'glm-4.6', 'deepseek-chat']) {
      const built = anthropicRequestParams(req(model, 'https://gw.example.com/anthropic'))
      expect(built.kind).toBe('plain')
      expect(Object.keys(built.params).sort()).toEqual(['max_tokens', 'messages', 'model', 'system'])
      expect(built.params.max_tokens).toBe(8000)
    }
  })

  it('官方地址 + 自定义模型名：同样不带专有参数', () => {
    const built = anthropicRequestParams(req('some-future-model'))
    expect(built.kind).toBe('plain')
    expect(Object.keys(built.params).sort()).toEqual(['max_tokens', 'messages', 'model', 'system'])
  })

  it('maxTokens 可覆盖（连接测试用小值）', () => {
    expect(anthropicRequestParams({ ...req('claude-opus-5-5'), maxTokens: 32 }).params.max_tokens).toBe(32)
    expect(anthropicRequestParams({ ...req('x', 'https://gw.example.com'), maxTokens: 32 }).params.max_tokens).toBe(32)
  })
})

describe('提示词', () => {
  it('system 固定不变；user 消息按任务带标签', () => {
    const rewrite = buildUserMessage({ kind: 'rewrite', instruction: '改简洁', text: '原文', before: '前', after: '后' })
    expect(rewrite).toContain('<task>rewrite</task>')
    expect(rewrite).toContain('<selection>\n原文\n</selection>')
    expect(rewrite).toContain('<before>\n前\n</before>')
    const draft = buildUserMessage({ kind: 'draft', instruction: '续写', text: '', before: '前', after: '' })
    expect(draft).not.toContain('<selection>')
    expect(draft).not.toContain('<after>')
    const composer = buildUserMessage({ kind: 'composer', instruction: '写清楚', text: '草稿', before: 'x', after: 'y' })
    expect(composer).toContain('<draft>\n草稿\n</draft>')
    expect(composer).not.toContain('<before>')
  })
})

describe('OpenAI 兼容：地址与行解析', () => {
  it('chatCompletionsUrl：/v1、/v1/chat/completions、结尾斜杠都归到同一个地址', () => {
    for (const u of [
      'https://api.deepseek.com/v1',
      'https://api.deepseek.com/v1/',
      'https://api.deepseek.com/v1/chat/completions',
      'https://api.deepseek.com/v1/chat/completions/',
    ]) expect(chatCompletionsUrl(u)).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(chatCompletionsUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(chatCompletionsUrl('https://api.example.com')).toBe('https://api.example.com/chat/completions')
  })

  it('parseOpenAiLine', () => {
    expect(parseOpenAiLine('data: [DONE]')).toEqual({ done: true })
    expect(parseOpenAiLine('data:{"choices":[{"delta":{"content":"你"}}]}')).toEqual({ text: '你', finish: null })
    expect(parseOpenAiLine('data: {"choices":[{"delta":{},"finish_reason":"length"}]}')).toEqual({ text: undefined, finish: 'length' })
    expect(parseOpenAiLine('data: {"error":{"message":"boom"}}')).toEqual({ error: 'boom' })
    expect(parseOpenAiLine(': keep-alive')).toBeNull()
    expect(parseOpenAiLine('event: ping')).toBeNull()
    expect(parseOpenAiLine('data: {broken')).toBeNull()
    expect(parseOpenAiLine('data: {"choices":[]}')).toBeNull()
  })
})

// ---------- 本机上游 ----------

type Seen = { url: string; headers: http.IncomingHttpHeaders; body: string }
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (closers.length) await closers.pop()?.()
})

async function upstream(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (d: Buffer) => chunks.push(d))
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() })
      handler(req, res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  closers.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }))
  return { port: (server.address() as AddressInfo).port, seen }
}

const toLocal: Resolver = async () => [{ address: '127.0.0.1', family: 4 }]
// 放行本机地址（上游是本机服务），防护本身的行为在 endpoint-guard.test.ts 里测
const localCaller = () => createModelCaller({ resolve: toLocal, transport: http, forbidden: () => false })

async function collect(it: AsyncIterable<ModelChunk>): Promise<{ text: string; stop: string | null }> {
  let text = ''
  let stop: string | null = null
  for await (const c of it) {
    if (c.type === 'delta') text += c.text
    else stop = c.reason
  }
  return { text, stop }
}

describe('OpenAI 兼容：流式调用', () => {
  const req = (port: number, extra: Partial<ModelRequest> = {}): ModelRequest => ({
    ...base,
    protocol: 'openai',
    baseUrl: `https://llm.example.com:${port}/v1`,
    model: 'deepseek-chat',
    ...extra,
  })

  it('请求形状：POST /chat/completions，Bearer，messages=[system,user]，stream:true，max_tokens；SSE 增量拼出全文，[DONE] 结束', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // 故意在 JSON 中间、多字节字符中间切开，验证缓冲拼行
      const payload = Buffer.from(
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\n' +
          ': ping\n\n' +
          'data: {"choices":[{"delta":{"content":"，世界"},"finish_reason":null}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n',
      )
      for (let i = 0; i < payload.length; i += 7) res.write(payload.subarray(i, i + 7))
      res.end()
    })
    const out = await collect(localCaller()(req(up.port), new AbortController().signal))
    expect(out).toEqual({ text: '你好，世界', stop: 'end_turn' })
    const got = up.seen[0]!
    expect(got.url).toBe('/v1/chat/completions')
    expect(got.headers.authorization).toBe('Bearer sk-test-1234')
    const body = JSON.parse(got.body) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream'])
    expect(body.stream).toBe(true)
    expect(body.model).toBe('deepseek-chat')
    expect(body.max_tokens).toBe(8000)
    expect(body.messages).toEqual([
      { role: 'system', content: QUICK_SYSTEM_PROMPT },
      { role: 'user', content: 'hello' },
    ])
  })

  it('baseUrl 填到 /v1/chat/completions 也能正确请求', async () => {
    const up = await upstream((_req, res) => res.end('data: [DONE]\n\n'))
    await collect(localCaller()(req(up.port, { baseUrl: `https://llm.example.com:${up.port}/v1/chat/completions` }), new AbortController().signal))
    expect(up.seen[0]!.url).toBe('/v1/chat/completions')
  })

  it('finish_reason=length → 截断；content_filter → 拒绝；没有 [DONE] 流自然结束也行', async () => {
    const mk = (finish: string) =>
      upstream((_req, res) => res.end(`data: {"choices":[{"delta":{"content":"x"},"finish_reason":"${finish}"}]}\n\n`))
    const length = await mk('length')
    expect((await collect(localCaller()(req(length.port), new AbortController().signal))).stop).toBe('max_tokens')
    const filtered = await mk('content_filter')
    expect((await collect(localCaller()(req(filtered.port), new AbortController().signal))).stop).toBe('refusal')
    const plain = await mk('stop')
    expect(await collect(localCaller()(req(plain.port), new AbortController().signal))).toEqual({ text: 'x', stop: 'end_turn' })
  })

  it('HTTP 错误按状态码映射：401/403 = key 无效，429 = 超限，其它带状态码且响应体只留前 300 字', async () => {
    const mk = (status: number, body: string) => upstream((_req, res) => { res.writeHead(status); res.end(body) })
    const run = (port: number) => collect(localCaller()(req(port), new AbortController().signal))

    for (const status of [401, 403]) {
      const up = await mk(status, '{"error":{"message":"nope"}}')
      const err = await run(up.port).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(UpstreamHttpError)
      expect(describeModelError(err)).toMatchObject({ code: 'auth' })
    }
    const limited = await mk(429, '{"error":{"message":"quota"}}')
    expect(describeModelError(await run(limited.port).catch((e: unknown) => e))).toMatchObject({ code: 'rate_limit' })

    const long = await mk(500, 'x'.repeat(2000))
    const info = describeModelError(await run(long.port).catch((e: unknown) => e))
    expect(info.code).toBe('api')
    expect(info.message).toContain('500')
    expect(info.message.length).toBeLessThan(400)
    expect(info.message).not.toContain('x'.repeat(301))

    const jsonErr = await mk(400, '{"error":{"message":"model not found: foo"}}')
    expect(describeModelError(await run(jsonErr.port).catch((e: unknown) => e)).message).toContain('model not found: foo')
  })

  it('流里夹带的错误对象 → 抛错并映射', async () => {
    const up = await upstream((_req, res) => res.end('data: {"error":{"message":"overloaded"}}\n\n'))
    const err = await collect(localCaller()(req(up.port), new AbortController().signal)).catch((e: unknown) => e)
    expect(describeModelError(err)).toMatchObject({ code: 'api' })
    expect(describeModelError(err).message).toContain('overloaded')
  })

  it('对端不换行地灌数据：单行超过上限就中止（不把内存吃光）', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200)
      res.end('x'.repeat(1_100_000))
    })
    const err = await collect(localCaller()(req(up.port), new AbortController().signal)).catch((e: unknown) => e)
    expect(describeModelError(err)).toMatchObject({ code: 'api' })
    expect(describeModelError(err).message).toContain('单行过长')
  })

  it('客户端取消：上游连接被断开', async () => {
    let upstreamClosed = false
    const up = await upstream((_req, res) => {
      res.writeHead(200)
      res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')
      res.on('close', () => { upstreamClosed = true })
    })
    const ctrl = new AbortController()
    const it = localCaller()(req(up.port), ctrl.signal)[Symbol.asyncIterator]()
    expect(await it.next()).toMatchObject({ value: { type: 'delta', text: 'a' } })
    ctrl.abort()
    await it.next().catch(() => undefined)
    await expect.poll(() => upstreamClosed).toBe(true)
  })

  it('默认防护：解析到内网的地址被拒，且上游一个请求都没收到', async () => {
    const up = await upstream((_req, res) => res.end('data: [DONE]\n\n'))
    const caller = createModelCaller({ resolve: toLocal, transport: http }) // forbidden 用默认实现
    const err = await collect(caller(req(up.port), new AbortController().signal)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UnsafeEndpointError)
    expect(describeModelError(err).code).toBe('endpoint')
    expect(up.seen).toHaveLength(0)
  })
})

describe('Anthropic 协议 + 自定义地址：经 SDK 但走防护版 fetch', () => {
  const sse = (events: Array<[string, unknown]>) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
  const okStream = sse([
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'glm-4.6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '！' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
    ['message_stop', { type: 'message_stop' }],
  ])
  const req = (port: number): ModelRequest => ({
    ...base,
    protocol: 'anthropic',
    baseUrl: `https://gw.example.com:${port}/anthropic`,
    model: 'glm-4.6',
  })

  it('请求落在 {baseUrl}/v1/messages（不带 ?beta=true），body 只有通用字段，没有 betas 头', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(okStream)
    })
    const out = await collect(localCaller()(req(up.port), new AbortController().signal))
    expect(out).toEqual({ text: '你好！', stop: 'end_turn' })
    const got = up.seen[0]!
    expect(got.url).toBe('/anthropic/v1/messages')
    expect(got.headers['x-api-key']).toBe('sk-test-1234')
    expect(got.headers['anthropic-beta']).toBeUndefined()
    const body = JSON.parse(got.body) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream', 'system'])
    expect(body.stream).toBe(true)
    expect(body.max_tokens).toBe(8000)
  })

  it('401 → SDK 的 AuthenticationError → 认证失败文案；429 → 超限', async () => {
    const mk = (status: number, type: string) =>
      upstream((_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type, message: 'm' } }))
      })
    const auth = await mk(401, 'authentication_error')
    const err = await collect(localCaller()(req(auth.port), new AbortController().signal)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Anthropic.AuthenticationError)
    expect(describeModelError(err)).toMatchObject({ code: 'auth' })
    const limited = await mk(429, 'rate_limit_error')
    const err2 = await collect(localCaller()(req(limited.port), new AbortController().signal)).catch((e: unknown) => e)
    expect(describeModelError(err2)).toMatchObject({ code: 'rate_limit' })
  })

  it('解析到内网：防护拒绝被 SDK 包成连接错误，仍能还原成「地址不允许」，且上游没收到请求', async () => {
    const up = await upstream((_req, res) => res.end(okStream))
    const caller = createModelCaller({ resolve: toLocal, transport: http }) // forbidden 用默认实现
    const err = await collect(caller(req(up.port), new AbortController().signal)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Anthropic.APIConnectionError)
    expect(describeModelError(err)).toMatchObject({ code: 'endpoint' })
    expect(up.seen).toHaveLength(0)
  })

  it('重定向不跟随（SDK 路径同样）', async () => {
    const target = await upstream((_req, res) => res.end('secret'))
    const up = await upstream((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${target.port}/` })
      res.end()
    })
    const err = await collect(localCaller()(req(up.port), new AbortController().signal)).catch((e: unknown) => e)
    expect(describeModelError(err)).toMatchObject({ code: 'endpoint' })
    expect(target.seen).toHaveLength(0)
  })
})

describe('错误映射（describeModelError）：按类型，不按字符串', () => {
  const gen = (status: number, type: string, message = 'm') =>
    Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, message, new Headers())

  it('SDK 类型化异常', () => {
    expect(describeModelError(gen(401, 'authentication_error'))).toMatchObject({ code: 'auth' })
    expect(describeModelError(gen(403, 'permission_error'))).toMatchObject({ code: 'auth' })
    expect(describeModelError(gen(429, 'rate_limit_error'))).toMatchObject({ code: 'rate_limit' })
    const bad = describeModelError(gen(400, 'invalid_request_error', 'Your credit balance is too low'))
    expect(bad.code).toBe('api')
    expect(bad.message).toContain('400')
    expect(bad.message).toContain('credit balance')
    expect(describeModelError(gen(529, 'overloaded_error'))).toMatchObject({ code: 'api' })
    expect(describeModelError(new Anthropic.APIConnectionError({}))).toMatchObject({ code: 'connection' })
    expect(describeModelError(new Anthropic.APIConnectionTimeoutError())).toMatchObject({ code: 'connection' })
    expect(describeModelError(new Anthropic.APIUserAbortError())).toMatchObject({ code: 'aborted' })
  })

  it('Node 系统错误 / 证书错误 → 连接问题；其它一律 unknown，且不被「401」之类的字样骗到', () => {
    expect(describeModelError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toMatchObject({ code: 'connection' })
    expect(describeModelError(Object.assign(new Error('x'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })).message).toContain('证书')
    expect(describeModelError(new UnsafeEndpointError('只允许 https 地址'))).toEqual({ code: 'endpoint', message: '只允许 https 地址' })
    expect(describeModelError(new Error('401 Unauthorized: invalid x-api-key'))).toMatchObject({ code: 'unknown' })
    expect(describeModelError('boom')).toMatchObject({ code: 'unknown' })
  })

  it('给用户的文案里不含上游返回的 key 样字符串（只有状态码与上游的错误说明）', () => {
    const info = describeModelError(gen(401, 'authentication_error', 'invalid x-api-key'))
    expect(info.message).not.toContain('x-api-key')
  })
})
