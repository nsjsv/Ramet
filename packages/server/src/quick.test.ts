/* ---------- 随手 AI：设置 / 连接 / 单次调用的集成测试 ----------
 * 真实 Postgres + 真实 HTTP 服务；模型调用与 DNS 解析是注入的假实现，不打任何真实模型。
 * 重点：key 加密落库且永不出现在响应 / 日志里；地址校验（保存时与每次请求时）；错误映射；限速；客户端断开即中止。 */
import { randomBytes, randomUUID } from 'node:crypto'
import http from 'node:http'
import Anthropic from '@anthropic-ai/sdk'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashPassword } from './auth.js'
import { closePool, getPool, initDb } from './db.js'
import { decryptSecret } from './secret-box.js'
import { startServer } from './index.js'
import { QUICK_SYSTEM_PROMPT, type ModelChunk, type ModelRequest, type QuickModelCall } from './quick.js'
import { INSTRUCTION_MAX, RATE_MAX, TEXT_MAX } from './routes/quick.js'
import type { Resolver } from './endpoint-guard.js'
import { truncateAll } from './test-helpers.js'

if (!process.env.DATABASE_URL) throw new Error('需要 DATABASE_URL 指向测试库')

const pool = getPool()
const secretKey = randomBytes(32)
const KEY = 'fake-anthropic-key-abcd1234'

// ---------- 可换的假模型 / 假 DNS ----------

let impl: QuickModelCall = async function* () {
  yield { type: 'stop', reason: 'end_turn' }
}
const seen: ModelRequest[] = []
const fakeCall: QuickModelCall = (req, signal) => {
  seen.push(req)
  return impl(req, signal)
}
const dnsMap: Record<string, string[]> = {}
const fakeResolve: Resolver = async (host) => (dnsMap[host] ?? ['93.184.216.34']).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

async function* script(...chunks: ModelChunk[]): AsyncGenerator<ModelChunk> {
  for (const c of chunks) yield c
}
const say = (...texts: string[]): ModelChunk[] => [...texts.map((text) => ({ type: 'delta' as const, text })), { type: 'stop', reason: 'end_turn' }]

let site: Awaited<ReturnType<typeof startServer>>
let bare: Awaited<ReturnType<typeof startServer>> // 没配主密钥的实例
let base = ''
let bareBase = ''

beforeAll(async () => {
  await initDb(pool)
  site = await startServer(pool, 0, { quick: { call: fakeCall, secretKey, resolve: fakeResolve } })
  bare = await startServer(pool, 0, { quick: { call: fakeCall, secretKey: null, resolve: fakeResolve } })
  base = `http://127.0.0.1:${site.port}`
  bareBase = `http://127.0.0.1:${bare.port}`
})
afterAll(async () => {
  await site.close()
  await bare.close()
  await closePool()
})
beforeEach(async () => {
  await truncateAll(pool)
  seen.length = 0
  for (const k of Object.keys(dnsMap)) delete dnsMap[k]
  impl = () => script(...say('ok'))
})
afterEach(async () => {
  await truncateAll(pool)
})

async function newUser(name = `u-${randomUUID().slice(0, 8)}`, host: string = base): Promise<{ id: string; cookie: string }> {
  const id = randomUUID()
  await pool.query('INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)', [id, name, hashPassword('pw-123456'), 'user'])
  const res = await fetch(`${host}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: name, password: 'pw-123456' }),
  })
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('登录失败')
  return { id, cookie }
}

async function call(cookie: string | null, method: string, path: string, body?: unknown, host: string = base): Promise<{ status: number; text: string; json: any; headers: Headers }> {
  const res = await fetch(`${host}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    // SSE 或空体
  }
  return { status: res.status, text, json, headers: res.headers }
}

type SseEvent = { event: string; data: any }
function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((b) => b.trim())
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message'
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? ''
      return { event, data: data ? JSON.parse(data) : null }
    })
}
async function quick(cookie: string, body: unknown, host: string = base): Promise<{ status: number; events: SseEvent[]; json: any; text: string; headers: Headers }> {
  const r = await call(cookie, 'POST', '/api/quick', body, host)
  const isSse = r.headers.get('content-type')?.includes('text/event-stream') ?? false
  return { status: r.status, events: isSse ? parseSse(r.text) : [], json: r.json, text: r.text, headers: r.headers }
}

const ANTHROPIC = { name: '官方', protocol: 'anthropic', model: 'claude-sonnet-5-5', apiKey: KEY }
const OPENAI = { name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-deepseek-9999' }

async function addConnection(cookie: string, body: Record<string, unknown> = ANTHROPIC): Promise<any> {
  const r = await call(cookie, 'POST', '/api/me/ai-connections', body)
  expect(r.status).toBe(201)
  return r.json
}

describe('认证', () => {
  it('所有端点没登录都是 401', async () => {
    for (const [method, path] of [
      ['GET', '/api/me/ai-settings'],
      ['PUT', '/api/me/ai-settings'],
      ['POST', '/api/me/ai-connections'],
      ['PATCH', '/api/me/ai-connections/x'],
      ['DELETE', '/api/me/ai-connections/x'],
      ['POST', '/api/me/ai-connections/test'],
      ['POST', '/api/quick'],
    ] as const) {
      expect((await call(null, method, path, {})).status).toBe(401)
    }
  })
})

describe('设置与连接', () => {
  it('默认：通道 site、没有连接、没有选中', async () => {
    const u = await newUser()
    const r = await call(u.cookie, 'GET', '/api/me/ai-settings')
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ channel: 'site', activeConnectionId: null, localAgent: null, secretConfigured: true, connections: [] })
  })

  it('新建：key 加密落库、响应只有后四位；第一套自动成为当前，第二套不抢', async () => {
    const u = await newUser()
    const first = await addConnection(u.cookie)
    expect(first).toEqual({ id: expect.any(String), name: '官方', protocol: 'anthropic', baseUrl: null, model: 'claude-sonnet-5-5', keyLast4: '1234' })
    const second = await addConnection(u.cookie, OPENAI)
    expect(second).toMatchObject({ protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyLast4: '9999' })

    const settings = (await call(u.cookie, 'GET', '/api/me/ai-settings')).json
    expect(settings.activeConnectionId).toBe(first.id)
    expect(settings.connections.map((c: any) => c.id)).toEqual([first.id, second.id])

    // 库里是密文：不含明文，用主密钥 + 用户 id 能解回来，换个用户 id 解不开
    const { rows } = await pool.query<{ key_ciphertext: string }>('SELECT key_ciphertext FROM user_ai_connections WHERE id = $1', [first.id])
    const blob = rows[0]!.key_ciphertext
    expect(blob).not.toContain(KEY)
    expect(Buffer.from(blob, 'base64').toString('latin1')).not.toContain(KEY)
    expect(decryptSecret(secretKey, blob, u.id)).toBe(KEY)
    expect(() => decryptSecret(secretKey, blob, randomUUID())).toThrow()
  })

  it('key 不出现在任何响应里（新建 / 列表 / 编辑 / 测试 / 调用 / 错误）', async () => {
    const u = await newUser()
    const c = await addConnection(u.cookie)
    const texts: string[] = []
    texts.push((await call(u.cookie, 'GET', '/api/me/ai-settings')).text)
    texts.push((await call(u.cookie, 'PATCH', `/api/me/ai-connections/${c.id}`, { name: '改名' })).text)
    texts.push((await call(u.cookie, 'POST', '/api/me/ai-connections/test', { id: c.id })).text)
    texts.push((await quick(u.cookie, { kind: 'rewrite', instruction: 'x', text: 'y' })).text)
    impl = () => { throw new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } }, 'bad', new Headers()) }
    texts.push((await quick(u.cookie, { kind: 'rewrite', instruction: 'x', text: 'y' })).text)
    texts.push((await call(u.cookie, 'POST', '/api/me/ai-connections', { ...ANTHROPIC, model: 'nope' })).text)
    for (const t of texts) expect(t).not.toContain(KEY)
    expect(texts.join('')).not.toContain('ciphertext')
  })

  it('输入校验：400 并说明原因', async () => {
    const u = await newUser()
    const post = (body: Record<string, unknown>) => call(u.cookie, 'POST', '/api/me/ai-connections', body)
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...ANTHROPIC, protocol: 'gemini' }, /协议/],
      [{ ...ANTHROPIC, name: '' }, /名称/],
      [{ ...ANTHROPIC, name: 'x'.repeat(41) }, /名称太长/],
      [{ ...OPENAI, baseUrl: '' }, /必须填写地址/],
      [{ ...OPENAI, baseUrl: undefined }, /必须填写地址/],
      [{ ...OPENAI, model: '' }, /模型名必填/],
      [{ ...OPENAI, model: 'm'.repeat(101) }, /太长/],
      [{ ...OPENAI, model: 'a\nb' }, /控制字符/],
      [{ ...ANTHROPIC, model: 'claude-3-opus' }, /官方地址只支持/],
      [{ ...ANTHROPIC, model: 'claude-opus-5-5-20260101' }, /官方地址只支持/],
      [{ ...ANTHROPIC, apiKey: '' }, /长度/],
      [{ ...ANTHROPIC, apiKey: 'short' }, /长度/],
      [{ ...ANTHROPIC, apiKey: 'sk-ant bad key 1234' }, /空格/],
      [{ ...ANTHROPIC, apiKey: 'sk-ant-\nabcdefgh' }, /空格|非 ASCII/],
      [{ ...ANTHROPIC, apiKey: undefined }, /API key 必填/],
      [{ ...OPENAI, baseUrl: 'https://x.example.com/v1?key=1' }, /参数/],
    ]
    for (const [body, re] of cases) {
      const r = await post(body)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect(r.json.message, JSON.stringify(body)).toMatch(re)
    }
    expect((await call(u.cookie, 'GET', '/api/me/ai-settings')).json.connections).toHaveLength(0)
  })

  it('地址校验（保存时）：http、内网 IP、解析到内网的域名、带账号密码都 400', async () => {
    const u = await newUser()
    dnsMap['internal.example.com'] = ['10.1.2.3']
    dnsMap['meta.example.com'] = ['93.184.216.34', '169.254.169.254']
    for (const baseUrl of [
      'http://api.example.com/v1',
      'https://127.0.0.1/v1',
      'https://localhost/v1',
      'https://169.254.169.254/latest',
      'https://[::1]/v1',
      'https://192.168.1.10:8443/v1',
      'https://2130706433/v1',
      'https://internal.example.com/v1',
      'https://meta.example.com/v1',
      'https://user:pw@api.example.com/v1',
    ]) {
      for (const body of [{ ...OPENAI, baseUrl }, { ...ANTHROPIC, baseUrl, model: 'glm-4.6' }]) {
        const r = await call(u.cookie, 'POST', '/api/me/ai-connections', body)
        expect(r.status, baseUrl).toBe(400)
      }
    }
    expect((await call(u.cookie, 'GET', '/api/me/ai-settings')).json.connections).toHaveLength(0)
  })

  it('地址规范化：去结尾斜杠；openai 去掉 /chat/completions；anthropic 去掉 /v1 或 /v1/messages；填官方地址等于没填', async () => {
    const u = await newUser()
    const mk = async (body: Record<string, unknown>) => (await addConnection(u.cookie, body)).baseUrl
    expect(await mk({ ...OPENAI, baseUrl: 'https://api.deepseek.com/v1/' })).toBe('https://api.deepseek.com/v1')
    expect(await mk({ ...OPENAI, baseUrl: 'https://api.deepseek.com/v1/chat/completions' })).toBe('https://api.deepseek.com/v1')
    expect(await mk({ ...OPENAI, baseUrl: 'HTTPS://API.Example.com:8443/openai' })).toBe('https://api.example.com:8443/openai')
    expect(await mk({ ...ANTHROPIC, baseUrl: 'https://gw.example.com/anthropic/v1/messages', model: 'glm-4.6' })).toBe('https://gw.example.com/anthropic')
    expect(await mk({ ...ANTHROPIC, baseUrl: 'https://gw.example.com/v1', model: 'glm-4.6' })).toBe('https://gw.example.com')
    expect(await mk({ ...ANTHROPIC, baseUrl: 'https://api.anthropic.com/', model: 'claude-haiku-5-5' })).toBeNull()
  })

  it('自定义地址 / 自定义协议下模型名自由填', async () => {
    const u = await newUser()
    const c = await addConnection(u.cookie, { ...ANTHROPIC, baseUrl: 'https://gw.example.com/anthropic', model: 'glm-4.6' })
    expect(c).toMatchObject({ baseUrl: 'https://gw.example.com/anthropic', model: 'glm-4.6' })
  })

  it('最多 10 套', async () => {
    const u = await newUser()
    for (let i = 0; i < 10; i++) await addConnection(u.cookie, { ...ANTHROPIC, name: `c${i}` })
    const r = await call(u.cookie, 'POST', '/api/me/ai-connections', ANTHROPIC)
    expect(r.status).toBe(400)
    expect(r.json.message).toMatch(/最多/)
  })

  it('没配主密钥：保存 key 的接口 503（带说明）；读设置与删除不受影响', async () => {
    const u = await newUser('nokey', bareBase)
    const r = await call(u.cookie, 'POST', '/api/me/ai-connections', ANTHROPIC, bareBase)
    expect(r.status).toBe(503)
    expect(r.json.message).toContain('RAMET_SECRET_KEY')
    const settings = await call(u.cookie, 'GET', '/api/me/ai-settings', undefined, bareBase)
    expect(settings.json).toMatchObject({ secretConfigured: false, connections: [] })
    // 库里原有的连接（主密钥后来被摘掉）：读设置 OK、删除 OK、编辑 key 503、发起调用 409 并说明
    const owner = await newUser('hadkey')
    const c = await addConnection(owner.cookie)
    const viewBare = await call(owner.cookie, 'GET', '/api/me/ai-settings', undefined, bareBase)
    expect(viewBare.status).toBe(200)
    expect((await call(owner.cookie, 'PATCH', `/api/me/ai-connections/${c.id}`, { apiKey: KEY }, bareBase)).status).toBe(503)
    const q = await quick(owner.cookie, { kind: 'rewrite', instruction: 'x', text: 'y' }, bareBase)
    expect(q.status).toBe(409)
    expect(q.json.error).toBe('key unreadable')
    expect((await call(owner.cookie, 'DELETE', `/api/me/ai-connections/${c.id}`, undefined, bareBase)).status).toBe(200)
  })

  it('编辑：改名 / 换模型 / 换 key（后四位跟着变）；协议不能改；别人的连接 404', async () => {
    const u = await newUser()
    const other = await newUser()
    const c = await addConnection(u.cookie)
    const patched = await call(u.cookie, 'PATCH', `/api/me/ai-connections/${c.id}`, { name: '新名字', model: 'claude-haiku-5-5', apiKey: 'sk-ant-newkey-7777' })
    expect(patched.status).toBe(200)
    expect(patched.json).toMatchObject({ name: '新名字', model: 'claude-haiku-5-5', keyLast4: '7777' })
    const { rows } = await pool.query<{ key_ciphertext: string }>('SELECT key_ciphertext FROM user_ai_connections WHERE id = $1', [c.id])
    expect(decryptSecret(secretKey, rows[0]!.key_ciphertext, u.id)).toBe('sk-ant-newkey-7777')
    // 不给 apiKey = 保持
    await call(u.cookie, 'PATCH', `/api/me/ai-connections/${c.id}`, { name: '再改' })
    const again = await pool.query<{ key_ciphertext: string }>('SELECT key_ciphertext FROM user_ai_connections WHERE id = $1', [c.id])
    expect(decryptSecret(secretKey, again.rows[0]!.key_ciphertext, u.id)).toBe('sk-ant-newkey-7777')

    expect((await call(u.cookie, 'PATCH', `/api/me/ai-connections/${c.id}`, { protocol: 'openai' })).status).toBe(400)
    expect((await call(u.cookie, 'PATCH', `/api/me/ai-connections/${c.id}`, { apiKey: '' })).status).toBe(400)
    expect((await call(u.cookie, 'PATCH', `/api/me/ai-connections/${c.id}`, { model: 'bogus' })).status).toBe(400)
    expect((await call(other.cookie, 'PATCH', `/api/me/ai-connections/${c.id}`, { name: 'hack' })).status).toBe(404)
    expect((await call(other.cookie, 'DELETE', `/api/me/ai-connections/${c.id}`)).status).toBe(404)
    expect((await call(u.cookie, 'PATCH', `/api/me/ai-connections/${randomUUID()}`, { name: 'x' })).status).toBe(404)
  })

  it('编辑时把地址改到内网 → 400，库里不变', async () => {
    const u = await newUser()
    const c = await addConnection(u.cookie, OPENAI)
    const r = await call(u.cookie, 'PATCH', `/api/me/ai-connections/${c.id}`, { baseUrl: 'https://10.0.0.1/v1' })
    expect(r.status).toBe(400)
    expect((await call(u.cookie, 'GET', '/api/me/ai-settings')).json.connections[0].baseUrl).toBe('https://api.deepseek.com/v1')
  })

  it('选当前 / 改通道：只能选自己的连接；null 清空；通道只认 site / local', async () => {
    const u = await newUser()
    const other = await newUser()
    const a = await addConnection(u.cookie)
    const b = await addConnection(u.cookie, OPENAI)
    const foreign = await addConnection(other.cookie)
    const put = (body: unknown) => call(u.cookie, 'PUT', '/api/me/ai-settings', body)

    expect((await put({ activeConnectionId: b.id })).json.activeConnectionId).toBe(b.id)
    expect((await put({ activeConnectionId: foreign.id })).status).toBe(400)
    expect((await put({ activeConnectionId: randomUUID() })).status).toBe(400)
    expect((await call(u.cookie, 'GET', '/api/me/ai-settings')).json.activeConnectionId).toBe(b.id)
    expect((await put({ channel: 'carrier-pigeon' })).status).toBe(400)
    expect((await put({ channel: 'local' })).json).toMatchObject({ channel: 'local', activeConnectionId: b.id }) // 改通道不动当前连接
    expect((await put({ channel: 'site', activeConnectionId: null })).json).toMatchObject({ channel: 'site', activeConnectionId: null })
    expect((await put({ activeConnectionId: a.id })).json.activeConnectionId).toBe(a.id)
  })

  it('删除：删的是当前 → 自动改选最早的一套；删光 → 空；用户被删 → 连接和设置一起级联清掉', async () => {
    const u = await newUser()
    const a = await addConnection(u.cookie)
    const b = await addConnection(u.cookie, OPENAI)
    expect((await call(u.cookie, 'DELETE', `/api/me/ai-connections/${a.id}`)).status).toBe(200)
    expect((await call(u.cookie, 'GET', '/api/me/ai-settings')).json.activeConnectionId).toBe(b.id)
    expect((await call(u.cookie, 'DELETE', `/api/me/ai-connections/${b.id}`)).status).toBe(200)
    expect((await call(u.cookie, 'GET', '/api/me/ai-settings')).json).toMatchObject({ activeConnectionId: null, connections: [] })

    const c = await addConnection(u.cookie)
    await pool.query('DELETE FROM spaces WHERE owner_id = $1', [u.id]) // 登录时惰性建的个人空间挡着删号
    await pool.query('DELETE FROM users WHERE id = $1', [u.id])
    const left = await pool.query('SELECT (SELECT COUNT(*) FROM user_ai_connections WHERE id = $1) AS c, (SELECT COUNT(*) FROM user_ai_settings WHERE user_id = $2) AS s', [c.id, u.id])
    expect(left.rows[0]).toEqual({ c: '0', s: '0' })
  })
})

describe('POST /api/quick：开流前的拒绝', () => {
  it('参数上限与类型：400，且不会去调模型', async () => {
    const u = await newUser()
    await addConnection(u.cookie)
    const base0 = { kind: 'rewrite', instruction: '润色', text: '一段话' }
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...base0, kind: 'translate' }, /kind/],
      [{ ...base0, kind: undefined }, /kind/],
      [{ ...base0, instruction: '' }, /instruction/],
      [{ ...base0, instruction: '   ' }, /instruction/],
      [{ ...base0, instruction: 5 }, /instruction/],
      [{ ...base0, instruction: 'x'.repeat(INSTRUCTION_MAX + 1) }, /太长/],
      [{ ...base0, text: 'x'.repeat(TEXT_MAX + 1) }, /太长/],
      [{ ...base0, text: 42 }, /字符串/],
      [{ ...base0, text: '' }, /没有要改写/],
      [{ ...base0, text: undefined }, /没有要改写/],
      [{ kind: 'composer', instruction: '写清楚', text: ' ' }, /草稿是空的/],
      [{ ...base0, before: ['a'] }, /字符串/],
      [{ kind: 'code', instruction: '加类型', text: '  ' }, /没有选中代码/],
      [{ kind: 'code', instruction: '加类型', text: 'a', file: { language: 'ts' } }, /file\.path/],
      [{ kind: 'code', instruction: '加类型', text: 'a', file: 'x.ts' }, /file/],
      [{ kind: 'command', instruction: '看看磁盘', shell: 5 }, /字符串/],
      [{ kind: 'command', instruction: '看看磁盘', cwd: 'x'.repeat(501) }, /太长/],
    ]
    for (const [body, re] of cases) {
      const r = await quick(u.cookie, body)
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400)
      expect(r.json.message).toMatch(re)
    }
    expect((await call(u.cookie, 'POST', '/api/quick', 'not json at all')).status).toBe(400)
    expect(seen).toHaveLength(0)
    // 恰好在上限：放行
    expect((await quick(u.cookie, { ...base0, instruction: 'x'.repeat(INSTRUCTION_MAX), text: 'y'.repeat(TEXT_MAX) })).status).toBe(200)
  })

  it('请求体过大 → 413', async () => {
    const u = await newUser()
    await addConnection(u.cookie)
    const payload = JSON.stringify({ kind: 'draft', instruction: 'x', before: 'a'.repeat(300 * 1024) })
    // 用一次性连接：服务端不读完超大请求体就应答，别让 fetch 连接池复用到这条被关掉的连接
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        `${base}/api/quick`,
        { method: 'POST', agent: false, headers: { 'content-type': 'application/json', cookie: u.cookie, 'content-length': Buffer.byteLength(payload) } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0) },
      )
      req.on('error', (err) => (err as { code?: string }).code === 'EPIPE' || (err as { code?: string }).code === 'ECONNRESET' ? undefined : reject(err))
      req.end(payload)
    })
    expect(status).toBe(413)
    expect(seen).toHaveLength(0)
  })

  it('本地通道没选 agent：409 no local agent，不会去调模型（本地通道的授权矩阵在 quick-local.test.ts）', async () => {
    const u = await newUser()
    await addConnection(u.cookie)
    await call(u.cookie, 'PUT', '/api/me/ai-settings', { channel: 'local' })
    const r = await quick(u.cookie, { kind: 'rewrite', instruction: '润色', text: '一段话' })
    expect(r.status).toBe(409)
    expect(r.json).toMatchObject({ error: 'no local agent' })
    expect(seen).toHaveLength(0)
  })

  it('没配连接（没填 key）：409 no connection，不会去调模型', async () => {
    const u = await newUser()
    const r = await quick(u.cookie, { kind: 'rewrite', instruction: '润色', text: '一段话' })
    expect(r.status).toBe(409)
    expect(r.json.error).toBe('no connection')
    expect(r.json.message).toMatch(/设置/)
    expect(seen).toHaveLength(0)
  })

  it('已保存的密文被篡改：409 key unreadable（不抛 500，不调模型）', async () => {
    const u = await newUser()
    const c = await addConnection(u.cookie)
    const { rows } = await pool.query<{ key_ciphertext: string }>('SELECT key_ciphertext FROM user_ai_connections WHERE id = $1', [c.id])
    const blob = Buffer.from(rows[0]!.key_ciphertext, 'base64')
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 1
    await pool.query('UPDATE user_ai_connections SET key_ciphertext = $1 WHERE id = $2', [blob.toString('base64'), c.id])
    const r = await quick(u.cookie, { kind: 'rewrite', instruction: '润色', text: '一段话' })
    expect(r.status).toBe(409)
    expect(r.json.error).toBe('key unreadable')
    expect(seen).toHaveLength(0)
  })

  it('保存时通过、之后域名改解析到内网：每次请求再校验，400 且不会去调模型', async () => {
    const u = await newUser()
    await addConnection(u.cookie, { ...OPENAI, baseUrl: 'https://llm.example.com/v1' })
    expect((await quick(u.cookie, { kind: 'draft', instruction: '续写' })).status).toBe(200)
    seen.length = 0
    dnsMap['llm.example.com'] = ['10.0.0.8'] // DNS 重绑定
    const r = await quick(u.cookie, { kind: 'draft', instruction: '续写' })
    expect(r.status).toBe(400)
    expect(r.json.error).toBe('unsafe endpoint')
    expect(seen).toHaveLength(0)
  })

  it('限速：每分钟 RATE_MAX 次，超了 429 带 retry-after；别的用户不受影响', async () => {
    const u = await newUser()
    const other = await newUser()
    await addConnection(u.cookie)
    await addConnection(other.cookie)
    const body = { kind: 'draft', instruction: '续写' }
    for (let i = 0; i < RATE_MAX; i++) expect((await quick(u.cookie, body)).status).toBe(200)
    const limited = await call(u.cookie, 'POST', '/api/quick', body)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(seen).toHaveLength(RATE_MAX)
    expect((await quick(other.cookie, body)).status).toBe(200)
  })
})

describe('POST /api/quick：流式输出与错误映射', () => {
  it('delta* + done；模型收到解密后的 key、选中的连接、固定 system、按任务拼好的 user 消息', async () => {
    const u = await newUser()
    await addConnection(u.cookie, { ...OPENAI })
    impl = () => script(...say('你', '好，', '世界'))
    const r = await quick(u.cookie, { kind: 'rewrite', instruction: '改简洁', text: '原文一段', before: '前文', after: '后文' })
    expect(r.status).toBe(200)
    expect(r.events).toEqual([
      { event: 'delta', data: { text: '你' } },
      { event: 'delta', data: { text: '好，' } },
      { event: 'delta', data: { text: '世界' } },
      { event: 'done', data: { stopReason: 'end_turn' } },
    ])
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-deepseek-9999', system: QUICK_SYSTEM_PROMPT })
    expect(seen[0]!.user).toContain('<task>rewrite</task>')
    expect(seen[0]!.user).toContain('改简洁')
    expect(seen[0]!.user).toContain('原文一段')
    expect(seen[0]!.user).toContain('前文')
    expect(seen[0]!.user).toContain('后文')
    expect(r.text).not.toContain('sk-deepseek-9999')
    // 经 nginx 反代时不能被缓冲，否则流式到浏览器是一坨一坨的
    expect(r.headers.get('x-accel-buffering')).toBe('no')
    expect(r.headers.get('content-type')).toContain('text/event-stream')
  })

  it('选哪套用哪套：切换当前连接后，调用拿到的是另一套', async () => {
    const u = await newUser()
    const a = await addConnection(u.cookie)
    await addConnection(u.cookie, OPENAI)
    await quick(u.cookie, { kind: 'draft', instruction: 'x' })
    expect(seen[0]).toMatchObject({ protocol: 'anthropic', apiKey: KEY, model: 'claude-sonnet-5-5' })
    const list = (await call(u.cookie, 'GET', '/api/me/ai-settings')).json.connections as Array<{ id: string }>
    await call(u.cookie, 'PUT', '/api/me/ai-settings', { activeConnectionId: list.find((c) => c.id !== a.id)!.id })
    await quick(u.cookie, { kind: 'draft', instruction: 'x' })
    expect(seen[1]).toMatchObject({ protocol: 'openai', apiKey: 'sk-deepseek-9999' })
  })

  it('上下文截断：before 留靠近光标的尾 2000 字，after 留头 2000 字；正文不截', async () => {
    const u = await newUser()
    await addConnection(u.cookie)
    const before = `${'头'.repeat(500)}${'尾'.repeat(2000)}`
    const after = `${'近'.repeat(2000)}${'远'.repeat(500)}`
    await quick(u.cookie, { kind: 'draft', instruction: '续写', before, after })
    const user = seen[0]!.user
    expect(user).toContain(`<before>\n${'尾'.repeat(2000)}\n</before>`)
    expect(user).not.toContain('头')
    expect(user).toContain(`<after>\n${'近'.repeat(2000)}\n</after>`)
    expect(user).not.toContain('远')
  })

  it('composer / draft：用户消息按任务带不同标签', async () => {
    const u = await newUser()
    await addConnection(u.cookie)
    await quick(u.cookie, { kind: 'composer', instruction: '把话写清楚', text: '帮我改下登录页' })
    expect(seen[0]!.user).toContain('<task>composer</task>')
    expect(seen[0]!.user).toContain('<draft>\n帮我改下登录页\n</draft>')
    await quick(u.cookie, { kind: 'draft', instruction: '续写', text: '不该出现', before: '前' })
    expect(seen[1]!.user).toContain('<task>draft</task>')
    expect(seen[1]!.user).not.toContain('不该出现')
  })

  it('code：带文件信息，选区前后的上下文各按行留 40 行；command：带 shell / 目录，终端输出只留最后 30 行，text 与上下文不进消息', async () => {
    const u = await newUser()
    await addConnection(u.cookie)
    const lines = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `${tag}${i + 1}`).join('\n')
    await quick(u.cookie, {
      kind: 'code',
      instruction: '加类型',
      text: 'const a = 1',
      file: { path: 'src/a.ts', language: 'typescript' },
      before: lines(100, 'b'),
      after: lines(100, 'a'),
    })
    const code = seen[0]!.user
    expect(code).toContain('<task>code</task>')
    expect(code).toContain('<file>\npath: src/a.ts\nlanguage: typescript\n</file>')
    expect(code).toContain('<selection>\nconst a = 1\n</selection>')
    expect(code).toContain('b100')
    expect(code).toContain('b61')
    expect(code).not.toContain('b60\n')
    expect(code).toContain('a1\n')
    expect(code).toContain('a40')
    expect(code).not.toContain('a41')

    await quick(u.cookie, {
      kind: 'command',
      instruction: '看看哪个目录最占空间',
      shell: 'zsh',
      cwd: '/home/me/proj',
      output: lines(100, 'out'),
      text: '不该出现',
      before: '不该出现',
    })
    const cmd = seen[1]!.user
    expect(cmd).toContain('<task>command</task>')
    expect(cmd).toContain('<shell>zsh</shell>')
    expect(cmd).toContain('<cwd>/home/me/proj</cwd>')
    expect(cmd).toContain('out100')
    expect(cmd).toContain('out71')
    expect(cmd).not.toContain('out70\n')
    expect(cmd).not.toContain('不该出现')
    expect(cmd).not.toContain('<selection>')
    expect(seen[1]!.system).toBe(QUICK_SYSTEM_PROMPT)
    // command 不要求 text；shell / cwd / output 都可以不给
    const bare = await quick(u.cookie, { kind: 'command', instruction: '列出文件' })
    expect(bare.status).toBe(200)
    expect(seen[2]!.user).not.toContain('<shell>')
  })

  it('refusal → error(refusal)；max_tokens → error(max_tokens)；没有内容 → error(empty)', async () => {
    const u = await newUser()
    await addConnection(u.cookie)
    const body = { kind: 'rewrite', instruction: '润色', text: '一段话' }

    impl = () => script({ type: 'delta', text: '部分' }, { type: 'stop', reason: 'refusal' })
    let r = await quick(u.cookie, body)
    expect(r.events.at(-1)).toEqual({ event: 'error', data: { code: 'refusal', message: '模型拒绝了这个请求' } })
    expect(r.events.some((e) => e.event === 'done')).toBe(false)

    impl = () => script({ type: 'delta', text: '被截' }, { type: 'stop', reason: 'max_tokens' })
    r = await quick(u.cookie, body)
    expect(r.events.at(-1)).toMatchObject({ event: 'error', data: { code: 'max_tokens' } })
    expect(r.events.at(-1)!.data.message).toMatch(/截断/)

    impl = () => script({ type: 'stop', reason: 'end_turn' })
    r = await quick(u.cookie, body)
    expect(r.events).toEqual([{ event: 'error', data: { code: 'empty', message: '模型没有返回内容' } }])
  })

  it('模型侧失败都在流里给 error 事件（HTTP 仍是 200，不会是 401 被前端当成登录过期）', async () => {
    const u = await newUser()
    await addConnection(u.cookie)
    const body = { kind: 'rewrite', instruction: '润色', text: '一段话' }
    const anth = (status: number, type: string) => Anthropic.APIError.generate(status, { type: 'error', error: { type, message: 'm' } }, 'm', new Headers())

    const cases: Array<[() => unknown, string]> = [
      [() => anth(401, 'authentication_error'), 'auth'],
      [() => anth(429, 'rate_limit_error'), 'rate_limit'],
      [() => anth(500, 'api_error'), 'api'],
      [() => new Anthropic.APIConnectionError({}), 'connection'],
    ]
    for (const [make, code] of cases) {
      impl = () => { throw make() }
      const r = await quick(u.cookie, body)
      expect(r.status).toBe(200)
      expect(r.events).toHaveLength(1)
      expect(r.events[0]).toMatchObject({ event: 'error', data: { code } })
      expect(r.events[0]!.data.message).toBeTruthy()
    }
    impl = () => { throw anth(401, 'authentication_error') }
    expect((await quick(u.cookie, body)).events[0]!.data.message).toMatch(/API key 无效/)
  })

  it('流到一半出错：已发的 delta 保留，随后是 error', async () => {
    const u = await newUser()
    await addConnection(u.cookie)
    impl = async function* () {
      yield { type: 'delta', text: '前半' }
      throw new Anthropic.APIConnectionError({})
    }
    const r = await quick(u.cookie, { kind: 'rewrite', instruction: '润色', text: '一段话' })
    expect(r.events.map((e) => e.event)).toEqual(['delta', 'error'])
  })

  it('未知错误：用户只看到通用文案，日志里只有错误类名，没有 key / 正文 / 错误详情', async () => {
    const u = await newUser()
    await addConnection(u.cookie)
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      impl = () => { throw new Error(`boom ${KEY} 机密正文`) }
      const r = await quick(u.cookie, { kind: 'rewrite', instruction: '润色', text: '机密正文' })
      expect(r.events[0]).toMatchObject({ event: 'error', data: { code: 'unknown' } })
      expect(r.text).not.toContain('boom')
      expect(r.text).not.toContain(KEY)
      const logged = log.mock.calls.flat().map(String).join('\n')
      expect(logged).toContain('Error')
      expect(logged).not.toContain(KEY)
      expect(logged).not.toContain('机密正文')
      expect(logged).not.toContain('boom')
    } finally {
      log.mockRestore()
    }
  })

  it('输出失控（超过字数上限）→ 中止并报错', async () => {
    const u = await newUser()
    await addConnection(u.cookie)
    let aborted = false
    impl = async function* (_req, signal) {
      signal.addEventListener('abort', () => { aborted = true })
      for (let i = 0; i < 200; i++) yield { type: 'delta', text: 'x'.repeat(1000) }
    }
    const r = await quick(u.cookie, { kind: 'draft', instruction: '续写' })
    expect(r.events.at(-1)).toMatchObject({ event: 'error', data: { code: 'api' } })
    expect(r.events.at(-1)!.data.message).toMatch(/太长/)
    await vi.waitFor(() => expect(aborted).toBe(true))
  })

  it('客户端断开 → 上游调用的 signal 被中止', async () => {
    const u = await newUser()
    await addConnection(u.cookie)
    let aborted = false
    let started = false
    impl = async function* (_req, signal) {
      yield { type: 'delta', text: '第一段' }
      started = true
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve()
        signal.addEventListener('abort', () => resolve())
      })
      aborted = signal.aborted
    }
    const ctrl = new AbortController()
    const res = await fetch(`${base}/api/quick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: u.cookie },
      body: JSON.stringify({ kind: 'draft', instruction: '续写' }),
      signal: ctrl.signal,
    })
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('第一段')
    await vi.waitFor(() => expect(started).toBe(true))
    ctrl.abort()
    await reader.read().catch(() => undefined)
    await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 5000 })
  })
})

describe('POST /api/me/ai-connections/test', () => {
  it('已保存的连接：用库里的 key，小 max_tokens；成功回 ok + 回复', async () => {
    const u = await newUser()
    const c = await addConnection(u.cookie, OPENAI)
    impl = () => script(...say('ok'))
    const r = await call(u.cookie, 'POST', '/api/me/ai-connections/test', { id: c.id })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: true, reply: 'ok' })
    expect(seen[0]).toMatchObject({ protocol: 'openai', apiKey: 'sk-deepseek-9999', model: 'deepseek-chat', maxTokens: 32 })
    expect(r.text).not.toContain('sk-deepseek-9999')
  })

  it('还没保存的表单：带 apiKey 直接测', async () => {
    const u = await newUser()
    const r = await call(u.cookie, 'POST', '/api/me/ai-connections/test', { protocol: 'anthropic', model: 'claude-haiku-5-5', apiKey: KEY })
    expect(r.json).toMatchObject({ ok: true })
    expect(seen[0]).toMatchObject({ protocol: 'anthropic', model: 'claude-haiku-5-5', apiKey: KEY, baseUrl: null })
    expect((await call(u.cookie, 'GET', '/api/me/ai-settings')).json.connections).toHaveLength(0) // 测试不落库
  })

  it('已保存 + 表单里改了字段 / 换了 key：以表单为准（不落库）', async () => {
    const u = await newUser()
    const c = await addConnection(u.cookie, OPENAI)
    await call(u.cookie, 'POST', '/api/me/ai-connections/test', { id: c.id, model: 'deepseek-reasoner', apiKey: 'sk-new-key-0000' })
    expect(seen[0]).toMatchObject({ model: 'deepseek-reasoner', apiKey: 'sk-new-key-0000' })
    expect((await call(u.cookie, 'GET', '/api/me/ai-settings')).json.connections[0].model).toBe('deepseek-chat')
  })

  it('失败回 200 {ok:false, code, message}：认证失败 / 拒绝 / 连不上', async () => {
    const u = await newUser()
    const c = await addConnection(u.cookie)
    impl = () => { throw Anthropic.APIError.generate(401, { type: 'error', error: { type: 'authentication_error', message: 'm' } }, 'm', new Headers()) }
    let r = await call(u.cookie, 'POST', '/api/me/ai-connections/test', { id: c.id })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: false, code: 'auth' })
    impl = () => script({ type: 'stop', reason: 'refusal' })
    r = await call(u.cookie, 'POST', '/api/me/ai-connections/test', { id: c.id })
    expect(r.json).toMatchObject({ ok: false, code: 'refusal' })
    impl = () => { throw new Anthropic.APIConnectionError({}) }
    r = await call(u.cookie, 'POST', '/api/me/ai-connections/test', { id: c.id })
    expect(r.json).toMatchObject({ ok: false, code: 'connection' })
  })

  it('输入 / 地址不合法 → 400，不会去调模型；别人的连接 404', async () => {
    const u = await newUser()
    const other = await newUser()
    const c = await addConnection(u.cookie)
    const t = (cookie: string, body: unknown) => call(cookie, 'POST', '/api/me/ai-connections/test', body)
    expect((await t(u.cookie, { protocol: 'openai', baseUrl: 'http://api.example.com/v1', model: 'm', apiKey: 'sk-12345678' })).status).toBe(400)
    expect((await t(u.cookie, { protocol: 'openai', baseUrl: 'https://169.254.169.254/v1', model: 'm', apiKey: 'sk-12345678' })).status).toBe(400)
    expect((await t(u.cookie, { protocol: 'openai', model: 'm', apiKey: 'sk-12345678' })).status).toBe(400)
    expect((await t(u.cookie, { protocol: 'anthropic', model: 'claude-haiku-5-5' })).status).toBe(400) // 没 key
    expect((await t(u.cookie, { id: c.id, baseUrl: 'https://10.0.0.1' })).status).toBe(400)
    expect((await t(other.cookie, { id: c.id })).status).toBe(404)
    expect(seen).toHaveLength(0)
  })

  it('和随手调用共用限速', async () => {
    const u = await newUser()
    await addConnection(u.cookie)
    for (let i = 0; i < RATE_MAX; i++) expect((await call(u.cookie, 'POST', '/api/me/ai-connections/test', { protocol: 'anthropic', model: 'claude-haiku-5-5', apiKey: KEY })).status).toBe(200)
    expect((await call(u.cookie, 'POST', '/api/me/ai-connections/test', { protocol: 'anthropic', model: 'claude-haiku-5-5', apiKey: KEY })).status).toBe(429)
    expect((await quick(u.cookie, { kind: 'draft', instruction: 'x' })).status).toBe(429)
  })
})
