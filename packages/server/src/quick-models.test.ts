// ⌘J 的模型调用层（pi-models.ts 的 createModelCaller，请求经 pi-ai 发出）：两种协议的流、我们定的参数（max_tokens、思考档）、
// HTTP 事实探针与错误映射、出站防护；以及模型列表。不碰数据库、不打真实模型：
// 上游是本机 http 服务，经防护版 fetch 的 transport 注入口连过去；官方地址的请求换掉全局 fetch 截下来。
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModelCaller } from './pi-models.js'
import {
  QUICK_SYSTEM_PROMPT,
  UpstreamFailure,
  UpstreamHttpError,
  buildUserMessage,
  createModelLister,
  describeModelError,
  type ModelChunk,
  type ModelRequest,
} from './quick.js'
import { UnsafeEndpointError, type Resolver } from './endpoint-guard.js'

const base = { system: QUICK_SYSTEM_PROMPT, user: 'hello', apiKey: 'sk-test-1234' }

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


const sse = (events: Array<[string, unknown]>) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
/** 一段完整的 Anthropic 流：说「你好！」后正常结束（stop 可换成 refusal / max_tokens） */
const anthropicReply = (stop = 'end_turn', model = 'glm-4.6') =>
  sse([
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '！' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 2 } }],
    ['message_stop', { type: 'message_stop' }],
  ])

describe('OpenAI 兼容：流式调用', () => {
  const req = (port: number, extra: Partial<ModelRequest> = {}): ModelRequest => ({
    ...base,
    protocol: 'openai',
    baseUrl: `https://llm.example.com:${port}/v1`,
    model: 'some-model',
    ...extra,
  })

  it('请求落在 {baseUrl}/chat/completions，Bearer，带 system 与 user、我们定的 max_tokens、不发思考参数；分片的 SSE 拼出全文', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // 故意在 JSON 中间、多字节字符中间切开，验证缓冲拼行
      const payload = Buffer.from(
        'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n' +
          'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"你好"}}]}\r\n\r\n' +
          ': ping\n\n' +
          'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"，世界"},"finish_reason":null}]}\n\n' +
          'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
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
    expect(body.model).toBe('some-model')
    expect(body.stream).toBe(true)
    expect(body.max_completion_tokens ?? body.max_tokens).toBe(8000)
    expect(body.reasoning_effort).toBeUndefined()
    expect(JSON.stringify(body.messages)).toContain('你是文档里的编辑助手')
    expect(JSON.stringify(body.messages)).toContain('hello')
  })

  it('finish_reason=length → 截断；content_filter → 拒绝', async () => {
    const mk = (finish: string) =>
      upstream((_req, res) => res.end(`data: {"id":"c1","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"${finish}"}]}\n\ndata: [DONE]\n\n`))
    const length = await mk('length')
    expect(await collect(localCaller()(req(length.port), new AbortController().signal))).toEqual({ text: 'x', stop: 'max_tokens' })
    const filtered = await mk('content_filter')
    expect((await collect(localCaller()(req(filtered.port), new AbortController().signal))).stop).toBe('refusal')
  })

  it('HTTP 错误按状态码映射：401/403 = key 无效，429 = 超限，其它带状态码且上游原文只留前 300 字', async () => {
    const mk = (status: number, body: string) => upstream((_req, res) => { res.writeHead(status); res.end(body) })
    const run = (port: number) => collect(localCaller()(req(port), new AbortController().signal))

    for (const status of [401, 403]) {
      const up = await mk(status, '{"error":{"message":"nope"}}')
      const err = await run(up.port).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(UpstreamFailure)
      expect(describeModelError(err, null)).toMatchObject({ code: 'auth' })
    }
    const limited = await mk(429, '{"error":{"message":"quota"}}')
    expect(describeModelError(await run(limited.port).catch((e: unknown) => e), null)).toMatchObject({ code: 'rate_limit' })

    const long = await mk(500, 'x'.repeat(2000))
    const info = describeModelError(await run(long.port).catch((e: unknown) => e), null)
    expect(info.code).toBe('api')
    expect(info.message).toContain('500')
    expect(info.message.length).toBeLessThan(400)
    expect(info.message).not.toContain('x'.repeat(301))

    const jsonErr = await mk(400, '{"error":{"message":"model not found: foo"}}')
    expect(describeModelError(await run(jsonErr.port).catch((e: unknown) => e), null).message).toContain('model not found: foo')
  })

  it('上游原文回显了 key：给用户的文案里抹掉', async () => {
    const up = await upstream((_req, res) => { res.writeHead(400); res.end('{"error":{"message":"bad key sk-test-1234 for this model"}}') })
    const err = await collect(localCaller()(req(up.port), new AbortController().signal)).catch((e: unknown) => e)
    const info = describeModelError(err, 'sk-test-1234')
    expect(info.message).toContain('bad key *** for this model')
    expect(info.message).not.toContain('sk-test-1234')
  })

  it('流里夹带的错误对象 → 抛错并映射成 api，带上游的说明', async () => {
    const up = await upstream((_req, res) => res.end('data: {"error":{"message":"overloaded"}}\n\n'))
    const err = await collect(localCaller()(req(up.port), new AbortController().signal)).catch((e: unknown) => e)
    expect(describeModelError(err, null)).toMatchObject({ code: 'api' })
    expect(describeModelError(err, null).message).toContain('overloaded')
  })

  it('对端不换行地灌数据：单行超过上限就中止（不把内存吃光）', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200)
      res.end('x'.repeat(1_100_000))
    })
    const err = await collect(localCaller()(req(up.port), new AbortController().signal)).catch((e: unknown) => e)
    expect(describeModelError(err, null)).toMatchObject({ code: 'api' })
    expect(describeModelError(err, null).message).toContain('单行过长')
  })

  it('客户端取消：抛 AbortError，上游连接被断开', async () => {
    let upstreamClosed = false
    const up = await upstream((_req, res) => {
      res.writeHead(200)
      res.write('data: {"id":"c1","choices":[{"index":0,"delta":{"content":"a"}}]}\n\n')
      res.on('close', () => { upstreamClosed = true })
    })
    const ctrl = new AbortController()
    const it = localCaller()(req(up.port), ctrl.signal)[Symbol.asyncIterator]()
    expect(await it.next()).toMatchObject({ value: { type: 'delta', text: 'a' } })
    ctrl.abort()
    const err = await it.next().catch((e: unknown) => e)
    expect(describeModelError(err, null)).toMatchObject({ code: 'aborted' })
    await expect.poll(() => upstreamClosed).toBe(true)
  })

  it('默认防护：解析到内网的地址被拒，且上游一个请求都没收到', async () => {
    const up = await upstream((_req, res) => res.end('data: [DONE]\n\n'))
    const caller = createModelCaller({ resolve: toLocal, transport: http }) // forbidden 用默认实现
    const err = await collect(caller(req(up.port), new AbortController().signal)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UpstreamFailure)
    expect((err as UpstreamFailure).probe.thrown).toBeInstanceOf(UnsafeEndpointError)
    expect(describeModelError(err, null).code).toBe('endpoint')
    expect(up.seen).toHaveLength(0)
  })
})

describe('Anthropic 协议：自定义地址经防护版 fetch，官方地址直连', () => {
  const req = (port: number): ModelRequest => ({
    ...base,
    protocol: 'anthropic',
    baseUrl: `https://gw.example.com:${port}/anthropic`,
    model: 'glm-4.6',
  })

  it('请求落在 {baseUrl}/v1/messages，x-api-key，不发思考参数，max_tokens 用我们的值；文字拼出全文', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(anthropicReply())
    })
    const out = await collect(localCaller()(req(up.port), new AbortController().signal))
    expect(out).toEqual({ text: '你好！', stop: 'end_turn' })
    const got = up.seen[0]!
    expect(got.url.split('?')[0]).toBe('/anthropic/v1/messages')
    expect(got.headers['x-api-key']).toBe('sk-test-1234')
    expect(got.headers.authorization).toBeUndefined()
    const body = JSON.parse(got.body) as Record<string, unknown>
    expect(body.model).toBe('glm-4.6')
    expect(body.max_tokens).toBe(8000)
    expect(body.thinking).toBeUndefined()
    expect(body.output_config).toBeUndefined()
    expect(JSON.stringify(body.system)).toContain('你是文档里的编辑助手')
  })

  it('stop_reason=refusal → 拒绝；max_tokens → 截断', async () => {
    const refused = await upstream((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(anthropicReply('refusal')) })
    expect((await collect(localCaller()(req(refused.port), new AbortController().signal))).stop).toBe('refusal')
    const cut = await upstream((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(anthropicReply('max_tokens')) })
    expect((await collect(localCaller()(req(cut.port), new AbortController().signal))).stop).toBe('max_tokens')
  })

  it('401 → 认证失败文案；429 → 超限（自定义地址不重试：上游只收到一次）', async () => {
    const mk = (status: number, type: string) =>
      upstream((_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type, message: 'm' } }))
      })
    const auth = await mk(401, 'authentication_error')
    const err = await collect(localCaller()(req(auth.port), new AbortController().signal)).catch((e: unknown) => e)
    expect(describeModelError(err, null)).toMatchObject({ code: 'auth' })
    const limited = await mk(429, 'rate_limit_error')
    const err2 = await collect(localCaller()(req(limited.port), new AbortController().signal)).catch((e: unknown) => e)
    expect(describeModelError(err2, null)).toMatchObject({ code: 'rate_limit' })
    expect(limited.seen).toHaveLength(1)
  })

  it('解析到内网：还原成「地址不允许」，且上游没收到请求', async () => {
    const up = await upstream((_req, res) => res.end(anthropicReply()))
    const caller = createModelCaller({ resolve: toLocal, transport: http }) // forbidden 用默认实现
    const err = await collect(caller(req(up.port), new AbortController().signal)).catch((e: unknown) => e)
    expect(describeModelError(err, null)).toMatchObject({ code: 'endpoint' })
    expect(up.seen).toHaveLength(0)
  })

  it('重定向不跟随', async () => {
    const target = await upstream((_req, res) => res.end('secret'))
    const up = await upstream((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${target.port}/` })
      res.end()
    })
    const err = await collect(localCaller()(req(up.port), new AbortController().signal)).catch((e: unknown) => e)
    expect(describeModelError(err, null)).toMatchObject({ code: 'endpoint' })
    expect(target.seen).toHaveLength(0)
  })

  it('官方地址 + 已知模型：直连官方，低思考档、不回传思考，max_tokens 16000', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input instanceof Request ? input.url : input), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return new Response(anthropicReply('end_turn', 'claude-opus-5-5'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    try {
      const official: ModelRequest = { ...base, protocol: 'anthropic', baseUrl: null, model: 'claude-opus-5-5' }
      expect(await collect(createModelCaller()(official, new AbortController().signal))).toEqual({ text: '你好！', stop: 'end_turn' })
    } finally {
      vi.unstubAllGlobals()
    }
    const got = seen[0]!
    expect(got.url.startsWith('https://api.anthropic.com/v1/messages')).toBe(true)
    expect(got.body.max_tokens).toBe(16000)
    expect(got.body.output_config).toEqual({ effort: 'low' })
    expect(got.body.thinking).toMatchObject({ type: 'adaptive', display: 'omitted' })
  })
})

describe('模型列表：从服务商拉，经防护版 fetch', () => {
  const lister = () => createModelLister({ resolve: toLocal, transport: http, forbidden: () => false })
  const json = (body: unknown) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const signal = () => new AbortController().signal

  it('openai 兼容：GET {baseUrl}/models，Bearer；按 id 排序、去重，没有 name 用 id', async () => {
    const up = await upstream(
      json({ object: 'list', data: [{ id: 'deepseek-reasoner' }, { id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-chat' }, { id: 7 }, {}] }),
    )
    const out = await lister()({ protocol: 'openai', baseUrl: `https://llm.example.com:${up.port}/v1`, apiKey: 'sk-test-1234' }, signal())
    expect(out).toEqual([
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', name: 'deepseek-reasoner' },
    ])
    expect(up.seen[0]!.url).toBe('/v1/models')
    expect(up.seen[0]!.headers.authorization).toBe('Bearer sk-test-1234')
  })

  it('anthropic 自定义地址：GET {baseUrl}/v1/models，x-api-key + anthropic-version；按 has_more / last_id 翻页，保留服务端顺序', async () => {
    const up = await upstream((req, res) => {
      const after = new URL(req.url ?? '', 'http://x').searchParams.get('after_id')
      json(
        after
          ? { data: [{ id: 'glm-4.5', display_name: 'GLM 4.5' }], has_more: false, last_id: 'glm-4.5' }
          : { data: [{ id: 'glm-4.6', display_name: 'GLM 4.6' }], has_more: true, last_id: 'glm-4.6' },
      )(req, res)
    })
    const out = await lister()({ protocol: 'anthropic', baseUrl: `https://gw.example.com:${up.port}/anthropic`, apiKey: 'sk-test-1234' }, signal())
    expect(out).toEqual([
      { id: 'glm-4.6', name: 'GLM 4.6' },
      { id: 'glm-4.5', name: 'GLM 4.5' },
    ])
    expect(up.seen.map((s) => s.url)).toEqual(['/anthropic/v1/models?limit=1000', '/anthropic/v1/models?limit=1000&after_id=glm-4.6'])
    expect(up.seen[0]!.headers['x-api-key']).toBe('sk-test-1234')
    expect(up.seen[0]!.headers['anthropic-version']).toBe('2023-06-01')
    expect(up.seen[0]!.headers.authorization).toBeUndefined()
  })

  it('翻页有上限：一直说 has_more 也会停下', async () => {
    let n = 0
    const up = await upstream((req, res) => {
      n++
      json({ data: [], has_more: true, last_id: `p${n}` })(req, res)
    })
    expect(await lister()({ protocol: 'anthropic', baseUrl: `https://gw.example.com:${up.port}`, apiKey: 'sk-test-1234' }, signal())).toEqual([])
    expect(up.seen.length).toBe(10)
  })

  it('401 → 认证失败；不是 JSON / 没有 data 数组 → 列表格式不对', async () => {
    const auth = await upstream((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'bad key' } }))
    })
    const target = (port: number) => ({ protocol: 'openai' as const, baseUrl: `https://llm.example.com:${port}/v1`, apiKey: 'sk-test-1234' })
    let err = await lister()(target(auth.port), signal()).catch((e: unknown) => e)
    expect(describeModelError(err, null)).toMatchObject({ code: 'auth' })
    const html = await upstream((_req, res) => res.end('<html>not found</html>'))
    err = await lister()(target(html.port), signal()).catch((e: unknown) => e)
    expect(describeModelError(err, null)).toMatchObject({ code: 'api', message: expect.stringContaining('不是 JSON') })
    const shape = await upstream(json({ models: [] }))
    err = await lister()(target(shape.port), signal()).catch((e: unknown) => e)
    expect(describeModelError(err, null)).toMatchObject({ code: 'api', message: expect.stringContaining('data') })
  })

  it('解析到内网：防护拒绝，上游没收到请求', async () => {
    const up = await upstream(json({ data: [{ id: 'm' }] }))
    const guarded = createModelLister({ resolve: toLocal, transport: http }) // forbidden 用默认实现
    const err = await guarded({ protocol: 'openai', baseUrl: `https://llm.example.com:${up.port}/v1`, apiKey: 'sk-test-1234' }, signal()).catch((e: unknown) => e)
    expect(describeModelError(err, null)).toMatchObject({ code: 'endpoint' })
    expect(up.seen).toHaveLength(0)
  })
})

describe('错误映射（describeModelError）：按 HTTP 事实与类型，不按字符串', () => {
  const failed = (probe: ConstructorParameters<typeof UpstreamFailure>[0], upstream = '') => new UpstreamFailure(probe, upstream)

  it('pi-ai 的失败：按状态码 / fetch 抛的错误 / 流里的原文', () => {
    expect(describeModelError(failed({ status: 401 }), null)).toMatchObject({ code: 'auth' })
    expect(describeModelError(failed({ status: 403 }), null)).toMatchObject({ code: 'auth' })
    expect(describeModelError(failed({ status: 429 }), null)).toMatchObject({ code: 'rate_limit' })
    const bad = describeModelError(failed({ status: 400, body: '{"type":"error","error":{"message":"Your credit balance is too low"}}' }), null)
    expect(bad.code).toBe('api')
    expect(bad.message).toContain('400')
    expect(bad.message).toContain('credit balance')
    expect(describeModelError(failed({ status: 529 }), null)).toMatchObject({ code: 'api' })
    expect(describeModelError(failed({ thrown: new UnsafeEndpointError('只允许 https 地址') }), null)).toEqual({ code: 'endpoint', message: '只允许 https 地址' })
    expect(describeModelError(failed({ thrown: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) }), null)).toMatchObject({ code: 'connection' })
    expect(describeModelError(failed({ thrown: new TypeError('odd') }), null)).toMatchObject({ code: 'connection' })
    expect(describeModelError(failed({ thrown: Object.assign(new Error('x'), { name: 'AbortError' }) }), null)).toMatchObject({ code: 'aborted' })
    const inStream = describeModelError(failed({}, 'Overloaded'), null)
    expect(inStream.code).toBe('api')
    expect(inStream.message).toContain('Overloaded')
  })

  it('Node 系统错误 / 证书错误 → 连接问题；其它一律 unknown，且不被「401」之类的字样骗到', () => {
    expect(describeModelError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), null)).toMatchObject({ code: 'connection' })
    expect(describeModelError(Object.assign(new Error('x'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), null).message).toContain('证书')
    expect(describeModelError(new UnsafeEndpointError('只允许 https 地址'), null)).toEqual({ code: 'endpoint', message: '只允许 https 地址' })
    expect(describeModelError(new UpstreamHttpError(401, 'unauthorized'), null)).toMatchObject({ code: 'auth' })
    expect(describeModelError(new Error('401 Unauthorized: invalid x-api-key'), null)).toMatchObject({ code: 'unknown' })
    expect(describeModelError('boom', null)).toMatchObject({ code: 'unknown' })
  })

  it('给用户的文案里不含上游返回的 key（整个回显、截断在 key 中间都抹掉）', () => {
    const key = 'fake-ant-api03-abcdefghijklmnop'
    const whole = describeModelError(failed({ status: 400, body: `{"error":{"message":"invalid x-api-key: ${key}"}}` }), key)
    expect(whole.message).not.toContain(key)
    const cut = describeModelError(failed({ status: 400, body: `${'x'.repeat(290)}${key}`.slice(0, 300) }), key)
    expect(cut.message).not.toContain(key.slice(0, 10))
  })
})
