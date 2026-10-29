// 随手 AI 的客户端（对应 server routes/quick.ts）：设置 / 连接的 REST 与单次调用的 SSE 流。
// 模型连接归用户自己（key 加密存在服务端，这里只拿到后四位），站点不提供共用 key。
// 开流前的失败是普通 JSON 错误（400/409/429），模型侧的任何失败（含 key 无效）都在流里以 error 事件给出，
// 所以统一折成 QuickOutcome，调用方只看 ok / code / message。

import { notifyUnauthorized, request } from './api'
import { COPY } from './copy'

export type QuickKind = 'rewrite' | 'draft' | 'composer' | 'code' | 'command'
export type Protocol = 'anthropic' | 'openai'
export type Channel = 'site' | 'local'

/** 官方 Anthropic 地址下可选的三个模型（服务端同表） */
export const ANTHROPIC_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const

export interface AiConnection {
  id: string
  name: string
  protocol: Protocol
  /** anthropic 空 = 官方地址；openai 必有 */
  baseUrl: string | null
  model: string
  /** key 只回后四位 */
  keyLast4: string
}

export interface AiSettings {
  channel: Channel
  activeConnectionId: string | null
  /** 本地通道用哪台机器上的哪个 agent（目录里的 catalog id c:<connectorId>:<agentId>）；null = 没选 */
  localAgent: string | null
  /** 服务器配了 RAMET_SECRET_KEY 才能保存 key */
  secretConfigured: boolean
  connections: AiConnection[]
}

export interface ConnectionInput {
  name: string
  baseUrl: string
  model: string
  apiKey: string
}

export type TestResult = { ok: true; reply: string } | { ok: false; code: string; message: string }

/** 一次调用的结果：ok = 完整收到；否则 code 是短码（auth / rate_limit / refusal / max_tokens / empty / no connection …），message 是人话 */
export type QuickOutcome = { ok: true } | { ok: false; code: string; message: string }

export interface QuickBody {
  kind: QuickKind
  instruction: string
  text?: string
  before?: string
  after?: string
  /** code：选中的代码所在文件 */
  file?: { path: string; language?: string }
  /** command：终端的 shell / 当前目录 / 最近的输出（调用方先剥掉控制序列） */
  shell?: string
  cwd?: string
  output?: string
}

const jsonInit = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) })

// 设置缓存：⌘J 每次都要先知道「配没配连接」，30 秒内复用，设置页改过就作废
const SETTINGS_TTL_MS = 30_000
let cached: { at: number; value: AiSettings } | null = null

export function forgetAiSettings(): void {
  cached = null
}

export async function getAiSettings(fresh = false): Promise<AiSettings> {
  if (!fresh && cached && Date.now() - cached.at < SETTINGS_TTL_MS) return cached.value
  const value = await request<AiSettings>('/api/me/ai-settings')
  cached = { at: Date.now(), value }
  return value
}

/** 随手 AI 现在能不能直接用；不能时给出原因（弹层里显示）。取设置失败不拦（让真正的请求去报错） */
export async function quickReadiness(): Promise<{ ok: true } | { ok: false; message: string }> {
  let settings: AiSettings
  try {
    settings = await getAiSettings()
  } catch {
    return { ok: true }
  }
  if (settings.channel === 'local') {
    // 本地通道不需要模型连接，只要选了一台机器上的 agent；机器在不在线、有没有授权由服务端每次再判
    return settings.localAgent ? { ok: true } : { ok: false, message: COPY.quick.noLocalAgent }
  }
  if (!settings.activeConnectionId) return { ok: false, message: COPY.quick.noConnection }
  return { ok: true }
}

/** 这些失败原因，去设置里就能解决（浮层里据此给「去设置」） */
const SETTINGS_CODES = new Set([
  'auth',
  'no connection',
  'key unreadable',
  'local channel unavailable',
  'endpoint',
  'unsafe endpoint',
  // 本地通道：没选 agent / 选的用不了 / 机器上没授权给你 → 去设置里换一个
  'no local agent',
  'local agent unavailable',
  'forbidden',
])
export const needsSettings = (code: string): boolean => SETTINGS_CODES.has(code)

const done = <T>(p: Promise<T>): Promise<T> => p.finally(forgetAiSettings)

export const quickApi = {
  settings: () => getAiSettings(true),
  setSettings: (patch: { channel?: Channel; activeConnectionId?: string | null; localAgent?: string | null }) =>
    done(request<AiSettings>('/api/me/ai-settings', jsonInit('PUT', patch))),
  createConnection: (input: ConnectionInput & { protocol: Protocol }) =>
    done(request<AiConnection>('/api/me/ai-connections', jsonInit('POST', input))),
  /** 编辑：apiKey 不给 = 保持原 key；协议不可改 */
  updateConnection: (id: string, patch: Partial<ConnectionInput>) =>
    done(request<AiConnection>(`/api/me/ai-connections/${encodeURIComponent(id)}`, jsonInit('PATCH', patch))),
  deleteConnection: (id: string) =>
    done(request<unknown>(`/api/me/ai-connections/${encodeURIComponent(id)}`, { method: 'DELETE' })),
  /** 测试连接：已保存的带 id（key 用库里的，表单里改过的字段覆盖）；没保存的带 protocol + apiKey。地址不合法抛 ApiError(400) */
  testConnection: (body: Partial<ConnectionInput> & { id?: string; protocol?: Protocol }) =>
    request<TestResult>('/api/me/ai-connections/test', jsonInit('POST', body)),
}

function parseBlock(block: string): { event: string; data: unknown } | null {
  let event = 'message'
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  if (data.length === 0) return null
  try {
    return { event, data: JSON.parse(data.join('\n')) }
  } catch {
    return null
  }
}

/** 发起一次随手 AI 调用并把增量交给 onDelta。signal 取消 = 断开连接（服务端随之中止上游）；取消不算失败（code 'aborted'） */
export async function streamQuick(body: QuickBody, onDelta: (text: string) => void, signal: AbortSignal): Promise<QuickOutcome> {
  const aborted: QuickOutcome = { ok: false, code: 'aborted', message: '' }
  let res: Response
  try {
    res = await fetch('/api/quick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal,
    })
  } catch {
    return signal.aborted ? aborted : { ok: false, code: 'network', message: COPY.quick.errNetwork }
  }
  if (res.status === 401) {
    notifyUnauthorized()
    return { ok: false, code: 'unauthorized', message: COPY.quick.errLogin }
  }
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => null)) as { error?: string; message?: string } | null
    return { ok: false, code: err?.error ?? `http ${res.status}`, message: err?.message ?? err?.error ?? `请求失败（${res.status}）` }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done: eof } = await reader.read()
      if (eof) break
      buffer += decoder.decode(value, { stream: true })
      let cut = buffer.indexOf('\n\n')
      while (cut !== -1) {
        const ev = parseBlock(buffer.slice(0, cut))
        buffer = buffer.slice(cut + 2)
        cut = buffer.indexOf('\n\n')
        if (!ev) continue
        const data = ev.data as { text?: string; code?: string; message?: string }
        if (ev.event === 'delta' && typeof data.text === 'string') onDelta(data.text)
        else if (ev.event === 'done') return { ok: true }
        else if (ev.event === 'error') return { ok: false, code: data.code ?? 'error', message: data.message ?? '随手 AI 出错了' }
      }
    }
  } catch {
    return signal.aborted ? aborted : { ok: false, code: 'interrupted', message: COPY.quick.errInterrupted }
  } finally {
    reader.cancel().catch(() => undefined)
  }
  return signal.aborted ? aborted : { ok: false, code: 'interrupted', message: COPY.quick.errInterrupted }
}
