// ---------- Genet 会话的消息历史：本轮用的与留下来的 ----------
// 历史就是 pi 的 Message[]，不含 system 消息：提示词与工具表每一轮现给（改了提示词，已有的会话下一轮就用上）。
// 一轮之内原样用；一轮结束后只留「之后还用得上、存得下」的形状再落库：图片字节不存（下一轮要看就再 read_image），
// 总量超了从最早的一轮删起。删到的那几轮 agent 就不记得了，但文档还在：要的时候可以 read_page 读回来。
// 思考块（含签名）照留：pi 跨轮、换了模型时自己决定怎么回传。

import type { ImageContent, Message, TextContent, UserMessage } from '@earendil-works/pi-ai'
import type { PromptBlock } from '../../types.js'

/** 留下来的历史的总字数上限（按 JSON 长度算）：每一步都要整段重发，太长又慢又贵，还会撑破模型的上下文 */
export const HISTORY_MAX_CHARS = 400_000
/** 单个工具结果交给模型的字数上限 */
export const RESULT_MAX_CHARS = 60_000

const IMAGE_NOTE = '（这里原来有图片，没有留在历史里；需要时用 read_image 再读）'
const ROLES = new Set(['user', 'assistant', 'toolResult'])

/** 这一轮发来的提示词 → 一条用户消息：文字合成一段，图片单列 */
export function userTurn(blocks: PromptBlock[]): UserMessage {
  const texts: string[] = []
  const images: ImageContent[] = []
  for (const b of blocks) {
    if (b.type === 'text') texts.push(b.text)
    else if (b.type === 'resource') texts.push(`${b.title}\n${b.text}`)
    else images.push({ type: 'image', mimeType: b.mimeType, data: b.data })
  }
  return { role: 'user', content: [{ type: 'text', text: texts.filter(Boolean).join('\n\n') }, ...images], timestamp: Date.now() }
}

/** 工具结果交给模型前截到上限，截了就明说 */
export function clipResult(text: string): string {
  if (text.length <= RESULT_MAX_CHARS) return text
  return `${text.slice(0, RESULT_MAX_CHARS)}\n…（后面还有 ${text.length - RESULT_MAX_CHARS} 字没有放进来）`
}

/** 图片换成一句说明（有几张都只说一次） */
function withoutImages(content: Array<TextContent | ImageContent>): TextContent[] {
  const texts = content.filter((c): c is TextContent => c.type === 'text')
  return texts.length === content.length ? texts : [...texts, { type: 'text', text: IMAGE_NOTE }]
}

/** 一轮结束后留下的形状（见文件头） */
export function forStorage(messages: Message[]): Message[] {
  const kept = messages.flatMap((m): Message[] => {
    if (m.role === 'system') return []
    if (m.role === 'user' && typeof m.content !== 'string') return [{ ...m, content: withoutImages(m.content) }]
    if (m.role === 'toolResult') return [{ ...m, content: withoutImages(m.content) }]
    return [m]
  })
  return fit(kept)
}

/** 库里读出来的是不是这种形状（每条要有认得的角色和时间戳）。认不出（比如中性格式 {role, text}）就当没有这个会话 */
export function isStoredHistory(raw: unknown): raw is Message[] {
  return (
    Array.isArray(raw) &&
    raw.every((m: unknown) => {
      const r = m as { role?: unknown; timestamp?: unknown } | null
      return typeof r === 'object' && r !== null && typeof r.role === 'string' && ROLES.has(r.role) && typeof r.timestamp === 'number'
    })
  )
}

/** 从最早的删起，删到总量以内；开头必须是一条用户消息（工具结果离了它的调用就不合法）。
 *  最后一条用户消息起的这一轮总是留着，哪怕它自己就超了（这一轮已经整段发过了，下一轮只补新增的） */
function fit(messages: Message[]): Message[] {
  const sizes = messages.map((m) => JSON.stringify(m).length)
  let total = sizes.reduce((a, b) => a + b, 0)
  const last = messages.findLastIndex((m) => m.role === 'user')
  let start = 0
  while (start < last && (total > HISTORY_MAX_CHARS || messages[start]!.role !== 'user')) {
    total -= sizes[start]!
    start++
  }
  return last === -1 ? [] : messages.slice(start)
}
