// ---------- 随手 AI：设置 + 连接 + 单次调用（SSE）----------
// GET    /api/me/ai-settings                 → {channel, activeConnectionId, localAgent, secretConfigured, connections:[{id,name,protocol,baseUrl,model,keyLast4}]}
// PUT    /api/me/ai-settings {channel?, activeConnectionId?, localAgent?}   改通道 / 选当前连接（activeConnectionId:null = 不选）/ 选本地通道用的 agent
//        （localAgent = 目录里的 catalog id c:<connectorId>:<agentId>，必须是你现在能用的；null = 不选；不能用 400）
// POST   /api/me/ai-connections {name, protocol, baseUrl?, model, apiKey} → 201 连接（没主密钥 503；地址不安全 400；超 10 套 400）
// PATCH  /api/me/ai-connections/:id {name?, baseUrl?, model?, apiKey?}   协议不可改（删了重建）；apiKey 不给 = 保持
// DELETE /api/me/ai-connections/:id
// POST   /api/me/ai-connections/test {id?, protocol?, baseUrl?, model?, apiKey?}
//                                            → 200 {ok:true, reply} | {ok:false, code, message}；输入/地址不合法 400
// POST   /api/quick {kind:'rewrite'|'draft'|'composer'|'code'|'command', instruction, text?, before?, after?, file?, shell?, cwd?, output?}
//                                            → SSE: event delta {text} … done {stopReason} | error {code, message}
//        开流前的失败走普通 JSON 状态码：400 参数 / 地址不安全；409 没配连接（no connection）、key 解不开（key unreadable）、
//        本地通道没选 agent / 选的不可用 / connector 太旧 / 上一次还没结束（no local agent / local agent unavailable / connector outdated / quick busy）；
//        403 本地通道的机器你没有 agent 授权；429 限速。模型侧的任何失败（含认证失败）
//        都在流里以 error 事件给出——不用 401，那会被前端当成「登录过期」。
// 服务器只做中转：不记录正文，不落库内容。key 永不出现在任何响应 / 日志里。

import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { streamSSE } from 'hono/streaming'
import type { Pool } from 'pg'
import { ForbiddenError } from '../agents/posture.js'
import { ConnectorOutdatedError } from '../agents/project-types.js'
import { requireAuth, type AuthEnv } from '../auth.js'
import {
  CONNECTION_LIMIT,
  InputError,
  KeyUnreadableError,
  checkEndpoint,
  countConnections,
  deleteConnection,
  getConnection,
  getSettings,
  activeConnection,
  insertConnection,
  listConnections,
  openConnection,
  parseDraft,
  saveSettings,
  toView,
  updateConnection,
  validateApiKey,
  type Channel,
  type DraftInput,
} from '../ai-connections.js'
import type { Resolver } from '../endpoint-guard.js'
import {
  LocalQuickError,
  QUICK_SYSTEM_PROMPT,
  buildUserMessage,
  createModelCaller,
  describeModelError,
  logSafeError,
  type ModelChunk,
  type ModelConnection,
  type QuickInput,
  type QuickKind,
  type QuickModelCall,
} from '../quick.js'
import { isSelectableLocalAgent, prepareLocalQuick, type LocalQuickHost } from '../quick-local.js'
import { FailureLimiter } from '../rate-limit.js'
import { loadSecretKeyFromEnv } from '../secret-box.js'

export type QuickDeps = {
  /** 模型调用（测试注入假的；缺省按协议走真实服务） */
  call?: QuickModelCall
  /** 主密钥：undefined = 读 RAMET_SECRET_KEY；null = 明确没配（测试用） */
  secretKey?: Buffer | null
  /** DNS 解析（测试注入）；缺省系统解析 */
  resolve?: Resolver
}

export const INSTRUCTION_MAX = 500
export const TEXT_MAX = 20_000
export const CONTEXT_MAX = 2_000
/** 每个用户每分钟最多发起这么多次模型调用（含连接测试） */
export const RATE_MAX = 20
const RATE_WINDOW_MS = 60_000
/** 单次调用的墙钟上限 / 输出字数上限：防止「兼容服务」不停地灌 */
const STREAM_MAX_MS = 180_000
const OUTPUT_MAX_CHARS = 100_000
const TEST_TIMEOUT_MS = 30_000
const TEST_MAX_TOKENS = 32
const TEST_SYSTEM = '这是一次连通性测试。只回复 ok，不要输出别的。'
const KINDS: readonly QuickKind[] = ['rewrite', 'draft', 'composer', 'code', 'command']
/** 这些任务要有 text（rewrite 的原文、composer 的草稿、code 的选中代码）；draft / command 不用 */
const NEEDS_TEXT: readonly QuickKind[] = ['rewrite', 'composer', 'code']
/** code：选区前后的上下文各留这么多行；command：终端输出留尾这么多行（再封顶字数） */
const CODE_CONTEXT_LINES = 40
const TERMINAL_LINES = 30
const TERMINAL_CHARS = 6_000
/** 本地通道把整段内容交给一个 agent：额外说明它在做单次文本改写，别去用工具 */
const LOCAL_NOTE = '这是一次单次文本任务：只输出结果正文，不要调用任何工具，不要读写文件或运行命令。'

// ---------- 参数解析 ----------

type Body = Record<string, unknown>

function asBody(raw: unknown): Body {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Body) : {}
}

/** 末尾截断时别把代理对劈成半个（半个代理字符在 JSON 里是非法的） */
function clipHead(s: string, n: number): string {
  if (s.length <= n) return s
  const cut = s.slice(0, n)
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut
}
function clipTail(s: string, n: number): string {
  if (s.length <= n) return s
  const cut = s.slice(-n)
  return /^[\udc00-\udfff]/.test(cut) ? cut.slice(1) : cut
}

function optionalString(body: Body, key: string, max: number): string {
  const v = body[key]
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') throw new InputError(`${key} 必须是字符串`)
  if (v.length > max) throw new InputError(`${key} 太长（最多 ${max} 字）`)
  return v
}

/** 行数截断：留头 / 留尾 n 行 */
const headLines = (s: string, n: number): string => s.split('\n').slice(0, n).join('\n')
const tailLines = (s: string, n: number): string => s.split('\n').slice(-n).join('\n')
/** 单行字段（路径 / shell / 目录）：压成一行，免得带进标签外的换行 */
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim()

function parseFile(raw: unknown): QuickInput['file'] {
  if (raw === undefined || raw === null) return undefined
  const file = asBody(raw)
  const path = optionalString(file, 'path', 500)
  if (!path.trim()) throw new InputError('file.path 不能为空')
  return { path: oneLine(path), language: oneLine(optionalString(file, 'language', 50)) }
}

export function parseQuickBody(raw: unknown): QuickInput {
  const body = asBody(raw)
  const kind = body.kind as QuickKind
  if (!KINDS.includes(kind)) throw new InputError('kind 只能是 rewrite / draft / composer / code / command')
  if (typeof body.instruction !== 'string' || !body.instruction.trim()) throw new InputError('instruction 必填')
  if (body.instruction.length > INSTRUCTION_MAX) throw new InputError(`instruction 太长（最多 ${INSTRUCTION_MAX} 字）`)
  const instruction = body.instruction.trim()
  const text = optionalString(body, 'text', TEXT_MAX)
  if (NEEDS_TEXT.includes(kind) && !text.trim()) {
    throw new InputError(kind === 'rewrite' ? '没有要改写的文字' : kind === 'code' ? '没有选中代码' : '草稿是空的')
  }
  if (kind === 'command') {
    // 终端里「说人话」：要 shell / 当前目录 / 最近的输出（只留尾部，调用方应已剥掉控制序列）当参考
    const output = clipTail(tailLines(optionalString(body, 'output', 100_000), TERMINAL_LINES), TERMINAL_CHARS)
    return {
      kind,
      instruction,
      text: '',
      before: '',
      after: '',
      shell: oneLine(optionalString(body, 'shell', 100)),
      cwd: oneLine(optionalString(body, 'cwd', 500)),
      output,
    }
  }
  // 上下文只是参考：超长的截到上限（before 留靠近光标的尾巴，after 留靠近光标的头）；代码另按行截
  let before = clipTail(optionalString(body, 'before', Number.MAX_SAFE_INTEGER), CONTEXT_MAX)
  let after = clipHead(optionalString(body, 'after', Number.MAX_SAFE_INTEGER), CONTEXT_MAX)
  if (kind === 'code') {
    before = tailLines(before, CODE_CONTEXT_LINES)
    after = headLines(after, CODE_CONTEXT_LINES)
  }
  const file = kind === 'code' ? parseFile(body.file) : undefined
  return { kind, instruction, text: NEEDS_TEXT.includes(kind) ? text : '', before, after, ...(file ? { file } : {}) }
}

// ---------- 路由 ----------

/** 本地通道的开流前失败 → HTTP。认得的给人话；不认得的原样抛 */
function localFailure(c: Context<AuthEnv>, err: unknown): Response {
  if (err instanceof ForbiddenError) return c.json({ error: 'forbidden', message: err.message }, 403)
  if (err instanceof ConnectorOutdatedError) return c.json({ error: 'connector outdated', message: err.message }, 409)
  if (err instanceof LocalQuickError) return c.json({ error: err.code, message: err.message }, 409)
  throw err
}

export function quickRoutes(pool: Pool, deps: QuickDeps = {}, local?: LocalQuickHost) {
  const secretKey = deps.secretKey === undefined ? loadSecretKeyFromEnv() : deps.secretKey
  const call = deps.call ?? createModelCaller({ resolve: deps.resolve })
  const limiter = new FailureLimiter(RATE_MAX, RATE_WINDOW_MS)
  const app = new Hono<AuthEnv>()
  // 路径限定的认证：这个子应用挂在注册序靠后的位置，不用 '*'（会顺带拦住别的子应用）
  const auth = requireAuth(pool)
  for (const path of ['/api/quick', '/api/me/ai-settings', '/api/me/ai-connections', '/api/me/ai-connections/*']) app.use(path, auth)

  /** 占一个调用名额；返回要等的毫秒数（0 = 放行）。滑动窗口：复用失败限速器的计数 */
  function takeSlot(userId: string): number {
    const wait = limiter.blockedFor(userId)
    if (wait > 0) return wait
    limiter.fail(userId)
    return 0
  }

  const bad = (message: string) => ({ error: 'bad request', message })

  async function settingsView(userId: string) {
    const [settings, rows] = await Promise.all([getSettings(pool, userId), listConnections(pool, userId)])
    return {
      channel: settings.channel,
      activeConnectionId: settings.activeConnectionId,
      localAgent: settings.localAgent,
      secretConfigured: secretKey !== null,
      connections: rows.map(toView),
    }
  }

  app.get('/api/me/ai-settings', async (c) => c.json(await settingsView(c.get('user').id)))

  app.put('/api/me/ai-settings', async (c) => {
    const user = c.get('user')
    const body = asBody(await c.req.json().catch(() => null))
    const patch: { channel?: Channel; activeConnectionId?: string | null; localAgent?: string | null } = {}
    if (body.channel !== undefined) {
      if (body.channel !== 'site' && body.channel !== 'local') return c.json(bad('channel 只能是 site 或 local'), 400)
      patch.channel = body.channel
    }
    if (body.activeConnectionId !== undefined) {
      if (body.activeConnectionId === null) patch.activeConnectionId = null
      else if (typeof body.activeConnectionId === 'string' && (await getConnection(pool, user.id, body.activeConnectionId))) {
        patch.activeConnectionId = body.activeConnectionId
      } else return c.json(bad('没有这套连接'), 400)
    }
    if (body.localAgent !== undefined) {
      if (body.localAgent === null) patch.localAgent = null
      // 只能选你现在能用的 connector 上的 agent（接入人 ∨ 有效 agent 授权，且在线）；调用时还会再判一次
      else if (typeof body.localAgent === 'string' && local && (await isSelectableLocalAgent(local, user, body.localAgent))) {
        patch.localAgent = body.localAgent
      } else return c.json(bad('这个 agent 你现在用不了，只能选你自己接入的、或别人授权给你的机器上的 agent'), 400)
    }
    await saveSettings(pool, user.id, patch)
    return c.json(await settingsView(user.id))
  })

  app.post('/api/me/ai-connections', async (c) => {
    const user = c.get('user')
    const body = asBody(await c.req.json().catch(() => null)) as DraftInput & { apiKey?: unknown }
    try {
      const draft = parseDraft(body)
      const apiKey = validateApiKey(body.apiKey)
      await checkEndpoint(draft.baseUrl, deps.resolve)
      if (!secretKey) return c.json({ error: 'secret not configured', message: '服务器没有配置 RAMET_SECRET_KEY，暂时不能保存 API key' }, 503)
      if ((await countConnections(pool, user.id)) >= CONNECTION_LIMIT) throw new InputError(`最多保存 ${CONNECTION_LIMIT} 套连接，先删掉不用的`)
      const row = await insertConnection(pool, user.id, draft, apiKey, secretKey)
      return c.json(toView(row), 201)
    } catch (err) {
      if (err instanceof InputError) return c.json(bad(err.message), 400)
      throw err
    }
  })

  app.patch('/api/me/ai-connections/:id', async (c) => {
    const user = c.get('user')
    const row = await getConnection(pool, user.id, c.req.param('id'))
    if (!row) return c.json({ error: 'connection not found' }, 404)
    const body = asBody(await c.req.json().catch(() => null)) as DraftInput & { apiKey?: unknown }
    try {
      if (body.protocol !== undefined && body.protocol !== row.protocol) throw new InputError('协议不能改，删掉重建')
      const draft = parseDraft(body, { name: row.name, protocol: row.protocol, baseUrl: row.base_url, model: row.model })
      let newKey: { apiKey: string; secretKey: Buffer } | null = null
      if (body.apiKey !== undefined) {
        const apiKey = validateApiKey(body.apiKey)
        if (!secretKey) return c.json({ error: 'secret not configured', message: '服务器没有配置 RAMET_SECRET_KEY，暂时不能保存 API key' }, 503)
        newKey = { apiKey, secretKey }
      }
      await checkEndpoint(draft.baseUrl, deps.resolve)
      const updated = await updateConnection(pool, user.id, row.id, draft, newKey)
      if (!updated) return c.json({ error: 'connection not found' }, 404)
      return c.json(toView(updated))
    } catch (err) {
      if (err instanceof InputError) return c.json(bad(err.message), 400)
      throw err
    }
  })

  app.delete('/api/me/ai-connections/:id', async (c) => {
    const ok = await deleteConnection(pool, c.get('user').id, c.req.param('id'))
    return ok ? c.json({}) : c.json({ error: 'connection not found' }, 404)
  })

  // 测试连接：发一句很短的请求，验证地址 / key / 模型能不能用。可以测还没保存的表单（带 apiKey），
  // 也可以测已保存的（带 id，key 用库里的；表单里改过的字段覆盖）
  app.post('/api/me/ai-connections/test', async (c) => {
    const user = c.get('user')
    const body = asBody(await c.req.json().catch(() => null)) as DraftInput & { id?: unknown; apiKey?: unknown }
    let conn: ModelConnection
    try {
      if (typeof body.id === 'string') {
        const row = await getConnection(pool, user.id, body.id)
        if (!row) return c.json({ error: 'connection not found' }, 404)
        const draft = parseDraft({ ...body, name: undefined }, { name: row.name, protocol: row.protocol, baseUrl: row.base_url, model: row.model })
        // 表单里重填了 key 就用新的（不碰库里的）；没填才解密已保存的
        const apiKey = body.apiKey !== undefined ? validateApiKey(body.apiKey) : openConnection(row, secretKey).apiKey
        conn = { protocol: draft.protocol, baseUrl: draft.baseUrl, model: draft.model, apiKey }
      } else {
        const draft = parseDraft({ ...body, name: body.name ?? 'test' })
        conn = { protocol: draft.protocol, baseUrl: draft.baseUrl, model: draft.model, apiKey: validateApiKey(body.apiKey) }
      }
      await checkEndpoint(conn.baseUrl, deps.resolve)
    } catch (err) {
      if (err instanceof InputError) return c.json(bad(err.message), 400)
      if (err instanceof KeyUnreadableError) return c.json({ error: 'key unreadable', message: err.message }, 409)
      throw err
    }
    const wait = takeSlot(user.id)
    if (wait > 0) return c.json({ error: 'rate limited', message: '请求太频繁，稍后再试' }, 429, { 'retry-after': String(Math.ceil(wait / 1000)) })

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(TEST_TIMEOUT_MS)])
    let reply = ''
    try {
      for await (const chunk of call({ ...conn, system: TEST_SYSTEM, user: 'ping', maxTokens: TEST_MAX_TOKENS }, signal)) {
        if (chunk.type === 'delta') reply = (reply + chunk.text).slice(0, 80)
        else if (chunk.reason === 'refusal') return c.json({ ok: false, code: 'refusal', message: '模型拒绝了这个请求' })
      }
      return c.json({ ok: true, reply: reply.trim() })
    } catch (err) {
      const info = signal.aborted && !c.req.raw.signal.aborted ? { code: 'connection', message: '连接测试超时' } : describeModelError(err)
      if (info.code === 'unknown') console.error('[quick] 连接测试失败:', logSafeError(err))
      return c.json({ ok: false, code: info.code, message: info.message })
    }
  })

  // 单次调用。请求体上限 200KB（最坏：2 万字正文 + 上下文，全是三字节汉字也不到）
  app.post('/api/quick', bodyLimit({ maxSize: 200 * 1024, onError: (c) => c.json(bad('请求体太大'), 413) }), async (c) => {
    const user = c.get('user')
    let input: QuickInput
    try {
      input = parseQuickBody(await c.req.json().catch(() => null))
    } catch (err) {
      if (err instanceof InputError) return c.json(bad(err.message), 400)
      throw err
    }

    const settings = await getSettings(pool, user.id)
    let open: (signal: AbortSignal) => AsyncIterable<ModelChunk>
    if (settings.channel === 'local') {
      // 本地通道：经 connector 在用户自己的机器上用 agent 跑一次（受限会话）。能不能用只看机器授权（assertCanUse），与 key 无关
      if (!local) return c.json({ error: 'local agent unavailable', message: '服务器没有启用本地通道' }, 409)
      const wait = takeSlot(user.id)
      if (wait > 0) return c.json({ error: 'rate limited', message: '请求太频繁，稍后再试' }, 429, { 'retry-after': String(Math.ceil(wait / 1000)) })
      try {
        open = await prepareLocalQuick(local, pool, user, settings.localAgent, `${QUICK_SYSTEM_PROMPT}\n\n${LOCAL_NOTE}\n\n${buildUserMessage(input)}`, input.kind)
      } catch (err) {
        return localFailure(c, err)
      }
    } else {
      const row = await activeConnection(pool, user.id)
      if (!row) return c.json({ error: 'no connection', message: '还没有配置模型连接，请先到设置 → 随手 AI 里添加' }, 409)
      let conn: ModelConnection
      try {
        conn = openConnection(row, secretKey)
      } catch (err) {
        if (err instanceof KeyUnreadableError) return c.json({ error: 'key unreadable', message: err.message }, 409)
        throw err
      }
      const wait = takeSlot(user.id)
      if (wait > 0) return c.json({ error: 'rate limited', message: '请求太频繁，稍后再试' }, 429, { 'retry-after': String(Math.ceil(wait / 1000)) })
      // 每次请求再校验一遍地址（保存时通过不等于现在还安全：域名可能已经改解析）。连接阶段还有第二道（endpoint-guard 的 lookup）
      try {
        await checkEndpoint(conn.baseUrl, deps.resolve)
      } catch (err) {
        if (err instanceof InputError) return c.json({ error: 'unsafe endpoint', message: err.message }, 400)
        throw err
      }
      const req = { ...conn, system: QUICK_SYSTEM_PROMPT, user: buildUserMessage(input) }
      open = (signal) => call(req, signal)
    }

    c.header('x-accel-buffering', 'no')
    return streamSSE(c, async (stream) => {
      const ctrl = new AbortController()
      let clientGone = false
      stream.onAbort(() => {
        clientGone = true
        ctrl.abort()
      })
      const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(STREAM_MAX_MS)])
      const send = (event: string, data: unknown): Promise<void> =>
        stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => undefined)
      let total = 0
      let stopReason = 'end_turn'
      try {
        for await (const chunk of open(signal)) {
          if (clientGone) return
          if (chunk.type === 'stop') {
            stopReason = chunk.reason
            continue
          }
          total += chunk.text.length
          if (total > OUTPUT_MAX_CHARS) {
            await send('error', { code: 'api', message: '模型输出太长，已中止' })
            return
          }
          await send('delta', { text: chunk.text })
        }
        if (clientGone) return
        if (stopReason === 'refusal') await send('error', { code: 'refusal', message: '模型拒绝了这个请求' })
        else if (stopReason === 'max_tokens') await send('error', { code: 'max_tokens', message: '输出被截断了（超出模型的长度上限），请缩小范围再试' })
        else if (total === 0) await send('error', { code: 'empty', message: '模型没有返回内容' })
        else await send('done', { stopReason })
      } catch (err) {
        if (clientGone) return
        // 墙钟超时：signal 被 AbortSignal.timeout 中止，而不是客户端走了
        const info = signal.aborted ? { code: 'timeout', message: '模型响应超时' } : describeModelError(err)
        if (info.code === 'unknown') console.error('[quick] 调用失败:', logSafeError(err))
        await send('error', info)
      } finally {
        // 不管怎么结束都中止上游：别让模型继续生成、别让连接挂着
        ctrl.abort()
      }
    })
  })

  return app
}
