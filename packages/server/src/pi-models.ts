// ---------- 用户的模型连接 → pi-ai：⌘J 与 Genet 共用 ----------
// 请求怎么发（走哪个接口、带哪些参数、各家兼容差异、流式解析、工具调用拼装）全交给 pi-ai，这里只定四件事：
//   1. 连接 → pi 的 Model：官方 Anthropic 地址上 pi 目录里有的模型用目录条目（带它调好的兼容开关），别的按连接现拼；
//      openai 兼容地址的差异（字段名、思考参数的写法）由 pi 按域名自己认，不逐家适配。
//   2. 出站：自定义地址一律经防护版 fetch（endpoint-guard.ts，SSRF），官方地址直连；重试 官方 1 次、自定义 0 次
//      （防护拒绝不该再试，也少一次 DNS）；不替 pi 发归属头。
//   3. 产品旋钮：max_tokens 与思考参数（输入框旁的思考档，「默认」= 不发；⌘J 的官方已知模型固定低档）。
//   4. 探针：每次请求的 HTTP 事实记进 Probe；pi 把上游错误压成了一句字符串，失败时包成 UpstreamFailure
//      交给 describeModelError（quick.ts）分类、抹 key。
// pi 的 anthropic 客户端写死 authToken: null、baseURL 显式传，服务器的 ANTHROPIC_* 环境变量掺不进用户的请求。

import {
  normalizeContext,
  type AnthropicOptions,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type OpenAICompletionsOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai'
import { stream as anthropicStream, type AnthropicEffort } from '@earendil-works/pi-ai/api/anthropic-messages'
import { stream as openaiStream } from '@earendil-works/pi-ai/api/openai-completions'
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models'
import { createSafeFetch, type SafeFetch, type SafeFetchDeps } from './endpoint-guard.js'
import {
  isKnownAnthropic,
  MAX_TOKENS_CUSTOM,
  MAX_TOKENS_OFFICIAL,
  OFFICIAL_ANTHROPIC_URL,
  readBodyPrefix,
  UpstreamFailure,
  type ModelChunk,
  type ModelConnection,
  type Probe,
  type QuickModelCall,
} from './quick.js'

export type PiModel = Model<'anthropic-messages'> | Model<'openai-completions'>

/** 思考参数：effort = 档位名（anthropic → output_config.effort，openai 兼容 → pi 按域名定的写法），budget = anthropic 的思考预算 */
export type PiThinking = { effort: string } | { budget: number }

/** 现拼的模型用的公开规格（models.dev 目录里有才有） */
export type PiLimits = { context?: number; output?: number }

export type PiRequest = {
  /** 覆盖默认 max_tokens */
  maxTokens?: number
  /** 不给 = 不发思考参数 */
  thinking?: PiThinking
  /** 不回传思考内容（⌘J：只要结果，首字更快） */
  hideThinking?: boolean
  /** 会话 id：供应商侧的缓存亲和 */
  sessionId?: string
  signal?: AbortSignal
  probe: Probe
}

/** 按连接发一次请求：失败编码在流的最终消息里（pi 的约定，不抛错） */
export type PiStream = (conn: ModelConnection, model: PiModel, context: TranscriptContext, req: PiRequest) => AssistantMessageEventStream

const PROVIDER = 'ramet'
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
/** 目录里没有上下文窗口时给 pi 的值（只影响 pi 自己的估算，不发给服务） */
const DEFAULT_CONTEXT = 200_000

/** 官方 Anthropic 地址上、pi 目录里有的模型 */
function catalogModel(id: string): Model<'anthropic-messages'> | undefined {
  const entry = (ANTHROPIC_MODELS as Record<string, Model<'anthropic-messages'> | undefined>)[id]
  return entry?.api === 'anthropic-messages' ? entry : undefined
}

/** 连接 → pi 的 Model。thinking 决定要不要标成会思考的模型（pi 只给会思考的模型发思考参数） */
export function piModel(conn: ModelConnection, thinking?: PiThinking, limits: PiLimits = {}): PiModel {
  const shared = {
    id: conn.model,
    name: conn.model,
    provider: PROVIDER,
    reasoning: thinking !== undefined,
    input: ['text', 'image'] as Array<'text' | 'image'>,
    cost: ZERO_COST,
    contextWindow: limits.context ?? DEFAULT_CONTEXT,
    maxTokens: limits.output ?? MAX_TOKENS_CUSTOM,
  }
  if (conn.protocol === 'openai') return { ...shared, api: 'openai-completions', baseUrl: conn.baseUrl ?? '' }
  const known = conn.baseUrl ? undefined : catalogModel(conn.model)
  if (known) return known
  return {
    ...shared,
    api: 'anthropic-messages',
    baseUrl: conn.baseUrl ?? OFFICIAL_ANTHROPIC_URL,
    // pi 只在这个开关下把 effort 发成 output_config.effort，否则按预算思考
    ...(thinking && 'effort' in thinking ? { compat: { forceAdaptiveThinking: true } } : {}),
  }
}

/** 一行的长度上限：SDK 与 pi 的 SSE 解析都按行缓冲、没有上限，对端不换行地灌数据会把内存吃光 */
const MAX_LINE_BYTES = 1_000_000
export const LINE_TOO_LONG = '响应格式不对（单行过长）'

function capLines(res: Response): Response {
  if (!res.body) return res
  let run = 0
  const body = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        const first = chunk.indexOf(10)
        // 跨块的那一行 = 上一块的尾巴 + 这一块的开头；块内的整行都比块小，不用另算
        const spanning = first === -1 ? run + chunk.length : run + first
        run = first === -1 ? spanning : chunk.length - chunk.lastIndexOf(10) - 1
        if (Math.max(spanning, run) > MAX_LINE_BYTES) ctl.error(new Error(LINE_TOO_LONG))
        else ctl.enqueue(chunk)
      },
    }),
  )
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
}

/** 记下每次请求的 HTTP 事实（有重试时只留最后一次）。非 2xx 的响应体读一份副本，原响应照常交给 SDK */
export function probedFetch(base: SafeFetch, probe: Probe): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    delete probe.thrown
    delete probe.status
    delete probe.body
    let res: Response
    try {
      res = await base(input, init)
    } catch (err) {
      probe.thrown = err
      throw err
    }
    if (!res.ok) {
      probe.status = res.status
      probe.body = await readBodyPrefix(res.clone())
    }
    return capLines(res)
  }) as typeof fetch
}

/** pi 的失败结果（stopReason = error）→ 带 HTTP 事实的错误 */
export function failureOf(msg: AssistantMessage, probe: Probe): UpstreamFailure {
  return new UpstreamFailure({ ...probe }, msg.errorMessage ?? '')
}

/** 造按连接发请求的函数。deps 只给测试注入（解析器 / 传输层）；生产无参 */
export function createPiStream(deps: SafeFetchDeps = {}): PiStream {
  const safeFetch = createSafeFetch(deps)
  const direct: SafeFetch = (input, init) => fetch(input, init)
  return (conn, model, context, req) => {
    const official = !conn.baseUrl
    const base = {
      apiKey: conn.apiKey,
      fetch: probedFetch(official ? direct : safeFetch, req.probe),
      maxRetries: official ? 1 : 0,
      maxTokens: req.maxTokens ?? (conn.protocol === 'anthropic' && isKnownAnthropic(conn) ? MAX_TOKENS_OFFICIAL : MAX_TOKENS_CUSTOM),
      identity: { attribution: null },
      ...(req.signal ? { signal: req.signal } : {}),
      ...(req.sessionId ? { sessionId: req.sessionId } : {}),
    }
    const t = req.thinking
    if (model.api === 'openai-completions') {
      const options: OpenAICompletionsOptions = {
        ...base,
        ...(t && 'effort' in t ? { reasoningEffort: t.effort as OpenAICompletionsOptions['reasoningEffort'] } : {}),
      }
      return openaiStream(model, context, options)
    }
    const options: AnthropicOptions = {
      ...base,
      ...(t ? { thinkingEnabled: true } : {}),
      ...(t && 'effort' in t ? { effort: t.effort as AnthropicEffort } : {}),
      ...(t && 'budget' in t ? { thinkingBudgetTokens: t.budget } : {}),
      ...(req.hideThinking ? { thinkingDisplay: 'omitted' as const } : {}),
    }
    return anthropicStream(model, context, options)
  }
}

// ---------- ⌘J ----------

/** ⌘J 的官方已知模型固定低档、不回传思考（快）；别的连接不发思考参数 */
function quickThinking(conn: ModelConnection): PiThinking | undefined {
  return conn.protocol === 'anthropic' && isKnownAnthropic(conn) ? { effort: 'low' } : undefined
}

function abortError(): Error {
  return Object.assign(new Error('已取消'), { name: 'AbortError' })
}

/** ⌘J 的单次调用：一条 system + 一条 user → 文本流。拒绝 / 截断归一成 stop 的 reason，别的失败抛 UpstreamFailure */
export function createModelCaller(deps: SafeFetchDeps = {}): QuickModelCall {
  const send = createPiStream(deps)
  return async function* (req, signal): AsyncGenerator<ModelChunk> {
    const thinking = quickThinking(req)
    const model = piModel(req, thinking)
    const context = normalizeContext({ systemPrompt: req.system, messages: [{ role: 'user', content: req.user, timestamp: Date.now() }] })
    const probe: Probe = {}
    const events = send(req, model, context, { ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}), ...(thinking ? { thinking } : {}), hideThinking: true, signal, probe })
    for await (const ev of events) {
      if (ev.type === 'text_delta' && ev.delta) yield { type: 'delta', text: ev.delta }
      else if (ev.type === 'done') {
        yield { type: 'stop', reason: ev.reason === 'length' ? 'max_tokens' : 'end_turn' }
        return
      } else if (ev.type === 'error') {
        if (ev.reason === 'aborted' || signal.aborted) throw abortError()
        if (isRefusal(ev.error)) {
          yield { type: 'stop', reason: 'refusal' }
          return
        }
        throw failureOf(ev.error, probe)
      }
    }
  }
}

/** 模型拒绝了（anthropic 的 refusal、openai 兼容的 content_filter）：pi 记成 error，原始停止原因还在 */
export function isRefusal(msg: AssistantMessage): boolean {
  return msg.rawStopReason === 'refusal' || msg.rawStopReason === 'content_filter'
}
