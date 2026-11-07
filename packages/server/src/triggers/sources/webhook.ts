// ---------- 来源：收到外部请求（source = 'webhook'）：密钥、请求体转文字、投递编号、限流（纯函数 + 进程内限流器） ----------
// 地址 = /api/hooks/<密钥>：密钥 32 字节随机（base64url），库里只存 sha256（agent_triggers.hook_hash），只在建好 / 换地址时给主人看一次；
// 列表里只显示末 4 位（config.hint）。接收端在 routes/hooks.ts。
// 请求体整段当「外来内容」：JSON 排版、表单转 JSON、文本原样、二进制只记大小，进事件的 text（引用里，只当资料）。
// 对方的字段名 / 值不放到引用外面（extra 只放我们自己算出来的：内容类型、大小、投递编号），不然就是一条绕开「外来」标记的提示注入通道。

import { createHash, randomBytes } from 'node:crypto'

export const HOOK_PREFIX = '/api/hooks/'
/** 请求体上限 */
export const HOOK_BODY_MAX = 64 * 1024
/** 同一个地址：每分钟 / 每小时最多这么多次 */
export const HOOK_RATE = { minute: 20, hour: 200 } as const

/** 新密钥与它的哈希、末 4 位 */
export function newHookToken(): { token: string; hash: string; hint: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hookHash(token), hint: token.slice(-4) }
}

export function hookHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 只接受空配置：地址由服务端生成，末 4 位由服务端记 */
export function parseWebhookConfig(raw: unknown): Record<string, never> | { error: string } {
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0) return {}
  return { error: '这种触发没有可填的配置：地址在保存后生成' }
}

/** 「外部请求 · 地址 …a1b2」 */
export function describeWebhook(config: unknown): string {
  const hint = (config as { hint?: unknown } | null)?.hint
  return typeof hint === 'string' && hint ? `外部请求 · 地址 …${hint}` : '外部请求'
}

const FORM = 'application/x-www-form-urlencoded'

/** 严格按 UTF-8 解码；不是合法 UTF-8、或带了换行 / 制表以外的控制字符 = null（当二进制） */
function asText(bytes: Uint8Array): string | null {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text) ? null : text
}

/** 请求体 → 事件正文：JSON 排版（解析不了当文本）、表单转 JSON（同名多值成数组）、文本原样、二进制只写大小 */
export function hookText(contentType: string | undefined, bytes: Uint8Array): string {
  if (bytes.length === 0) return '（空的请求体）'
  const mime = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  const text = asText(bytes)
  if (text === null) return `（二进制内容，${bytes.length} 字节，没有转成文字）`
  if (mime === FORM) {
    const out: Record<string, string | string[]> = {}
    for (const [k, v] of new URLSearchParams(text)) {
      const prev = out[k]
      out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v]
    }
    return JSON.stringify(out, null, 2)
  }
  if (mime.includes('json')) {
    try {
      return JSON.stringify(JSON.parse(text) as unknown, null, 2)
    } catch {
      return text
    }
  }
  return text
}

const DELIVERY = /^[A-Za-z0-9._:-]{1,100}$/

/** 发送方给的投递编号（重投只触发一次）：Idempotency-Key > X-GitHub-Delivery > X-Request-Id；形状不对的不认 */
export function deliveryId(header: (name: string) => string | undefined): string | null {
  for (const name of ['idempotency-key', 'x-github-delivery', 'x-request-id']) {
    const v = header(name)?.trim()
    if (v && DELIVERY.test(v)) return v
  }
  return null
}

/** 同一个地址的滑动窗口限流（进程内；重启清零无妨）。take 返回 0 = 放行，否则要等的秒数 */
export class HookLimiter {
  private hits = new Map<string, number[]>()

  constructor(private rate: { minute: number; hour: number } = HOOK_RATE) {}

  take(id: string, now: number): number {
    const list = (this.hits.get(id) ?? []).filter((t) => t > now - 3_600_000)
    const lastMinute = list.filter((t) => t > now - 60_000)
    let wait = 0
    if (lastMinute.length >= this.rate.minute) wait = Math.ceil((lastMinute[0]! + 60_000 - now) / 1000)
    else if (list.length >= this.rate.hour) wait = Math.ceil((list[0]! + 3_600_000 - now) / 1000)
    if (wait === 0) list.push(now)
    if (list.length > 0) this.hits.set(id, list)
    else this.hits.delete(id)
    return Math.max(wait, wait > 0 ? 1 : 0)
  }
}
