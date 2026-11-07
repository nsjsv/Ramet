// ---------- 测试用：Genet 的假模型 ----------
// 驱动经 PiStream 发模型请求；这里给一个按剧本回放的实现：每次请求按次序取一步（取完了一直用最后一步），
// 一步可以看这一次请求再决定回什么。回复按 pi 的事件流发出（start → 增量 → done / error），与真服务同形，
// 驱动与 pi 的循环照常跑。只给测试用。

import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type JsonObject,
  type Message,
} from '@earendil-works/pi-ai'
import type { PiRequest, PiStream, PiThinking } from '../../../pi-models.js'
import type { Probe } from '../../../quick.js'

/** 一次请求那一刻的快照（历史之后还会被追加） */
export type GenetCall = {
  protocol: 'anthropic' | 'openai'
  model: string
  apiKey: string
  thinking?: PiThinking
  maxTokens?: number
  system: string
  /** 不含 system 的历史 */
  messages: Message[]
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
}

export type Step = (call: GenetCall, req: PiRequest) => AssistantMessageEventStream

/** 按次序回放的假模型；calls 是每次请求的快照 */
export function script(...steps: Step[]): { stream: PiStream; calls: GenetCall[] } {
  const calls: GenetCall[] = []
  const stream: PiStream = (conn, _model, context, req) => {
    const call: GenetCall = {
      protocol: conn.protocol,
      model: conn.model,
      apiKey: conn.apiKey,
      ...(req.thinking ? { thinking: req.thinking } : {}),
      ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
      system: getCurrentSystemPrompt(context.messages),
      messages: structuredClone(context.messages.filter((m) => m.role !== 'system')),
      tools: getCurrentTools(context.messages).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as Record<string, unknown> })),
    }
    calls.push(call)
    return steps[Math.min(calls.length - 1, steps.length - 1)]!(call, req)
  }
  return { stream, calls }
}

export type TestUsage = { input: number; output: number; cacheRead?: number; cacheWrite?: number }

function message(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop', usage?: TestUsage): AssistantMessage {
  const msg = fauxAssistantMessage(content, { stopReason })
  if (!usage) return msg
  const u = { cacheRead: 0, cacheWrite: 0, ...usage }
  return { ...msg, usage: { ...msg.usage, ...u, totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite } }
}

/** 一条完整的回复按事件流发出去 */
export function replay(final: AssistantMessage): AssistantMessageEventStream {
  const s = createAssistantMessageEventStream()
  const partial: AssistantMessage = { ...final, content: [] }
  s.push({ type: 'start', partial })
  final.content.forEach((block, i) => {
    partial.content = final.content.slice(0, i + 1)
    if (block.type === 'text') s.push({ type: 'text_delta', contentIndex: i, delta: block.text, partial })
    else if (block.type === 'thinking') s.push({ type: 'thinking_delta', contentIndex: i, delta: block.thinking, partial })
    else s.push({ type: 'toolcall_end', contentIndex: i, toolCall: block, partial })
  })
  if (final.stopReason === 'error' || final.stopReason === 'aborted') s.push({ type: 'error', reason: final.stopReason, error: final })
  else s.push({ type: 'done', reason: final.stopReason === 'length' || final.stopReason === 'toolUse' ? final.stopReason : 'stop', message: final })
  return s
}

/** 说一段话收尾；text 可以看这一次请求再定 */
export const say =
  (text: string | ((c: GenetCall) => string), usage?: TestUsage): Step =>
  (c) =>
    replay(message([fauxText(typeof text === 'string' ? text : text(c))], 'stop', usage))

/** 先想再说 */
export const think =
  (thought: string, text: string): Step =>
  () =>
    replay(message([fauxThinking(thought), fauxText(text)]))

/** 调一个工具 */
export const callTool =
  (id: string, name: string, input: JsonObject): Step =>
  () =>
    replay(message([fauxToolCall(name, input, { id })], 'toolUse'))

/** 说一句之后挂住，直到这一轮被停止才以 aborted 收尾 */
export const hang =
  (text: string): Step =>
  (_c, req) => {
    const s = createAssistantMessageEventStream()
    const partial = message([fauxText(text)], 'stop')
    s.push({ type: 'start', partial: { ...partial, content: [] } })
    s.push({ type: 'text_delta', contentIndex: 0, delta: text, partial })
    req.signal?.addEventListener('abort', () => s.push({ type: 'error', reason: 'aborted', error: { ...partial, stopReason: 'aborted' } }), { once: true })
    return s
  }

/** 说一句（可空）之后失败：HTTP 事实像真请求那样记进探针，upstream 是 pi 给的那句原文 */
export const fail =
  (text: string, probe: Probe, upstream = ''): Step =>
  (_c, req) => {
    Object.assign(req.probe, probe)
    return replay({ ...message(text ? [fauxText(text)] : [], 'error'), errorMessage: upstream })
  }

/** 这一次请求里最后一批工具结果的文字 */
export function lastResult(c: GenetCall): string {
  const out: string[] = []
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i]!
    if (m.role !== 'toolResult') break
    out.unshift(m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n'))
  }
  return out.join('\n')
}

/** 驱动在每条用户消息最前面加的时间行（prompt.ts 的 clockLine） */
export const CLOCK_LINE = /^\[现在：[^\]]*\]\n\n/

/** 历史里的一条消息只看角色与文字（断言用）。用户消息开头的时间行不算：它每一轮都有，单独测 */
export function brief(m: Message): { role: string; text: string } {
  const content = typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content
  const text = content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
  return { role: m.role, text: m.role === 'user' ? text.replace(CLOCK_LINE, '') : text }
}

/** 等 gate 放行再按 step 回（测「这一轮还在跑」时用） */
export const after =
  (gate: Promise<unknown>, step: Step): Step =>
  (c, req) => {
    const s = createAssistantMessageEventStream()
    void gate.then(async () => {
      for await (const ev of step(c, req)) s.push(ev)
    })
    return s
  }
