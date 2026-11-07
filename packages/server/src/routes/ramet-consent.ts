/* ---------- Genet 动手前先问主人（外来事件之后）+ 长等待端点的保活写法 ----------
 * 触发者不是主人的事件（别人的评论、外部请求）写进 Genet 页以后，主人亲自说话之前，Genet 调有副作用的工具（派活、建 / 改 / 移 / 改名 / 删页面、
 * 设 / 改 / 删定时器与规则）都先在 Genet 页弹一张审批卡，写明起因；主人同意才执行，拒绝 = 不执行，Genet 拿到「用户没同意」。
 * 判定的唯一实现在 triggers/taint.ts（读活文档，在工具调用当下判）；读、搜、在 Genet 页回复、标记「不用处理」不经过这里。
 * 非 Genet 凭证、或凭证绑的不是本人 Genet 页：不受影响，原样执行。
 * 要等审批的端点先发头、定时吐空白保活，最后一段才是 JSON（heartbeatJson）：MCP 进程的 fetch 有头 / 体超时，nginx 60 秒无数据就断。
 * 这时 HTTP 状态恒为 200，失败写在 JSON 的 error 里（MCP 工具两种都认）。 */

import type { Context } from 'hono'
import { stream } from 'hono/streaming'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Pool } from 'pg'
import type * as Y from 'yjs'
import type { OwnApprovals } from '../agents/own-approvals.js'
import { taintedSince } from '../triggers/taint.js'

const HEARTBEAT_MS = 15_000

/** 先发头、定时吐空白、最后一段 JSON：长等待的端点共用 */
export function heartbeatJson(c: Context, work: () => Promise<unknown>): Response {
  c.header('content-type', 'application/json; charset=utf-8')
  c.header('cache-control', 'no-cache')
  c.header('x-accel-buffering', 'no')
  return stream(c, async (s) => {
    const timer = setInterval(() => void s.write(' '), HEARTBEAT_MS)
    try {
      const result = await work().catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
      await s.write(JSON.stringify(result))
    } finally {
      clearInterval(timer)
    }
  })
}

/** 凭证的身份与它绑的会话（page-read.ts 的 GrantCtx 的一部分） */
export type ConsentGrant = { user: { id: string; role: string }; ctx: { pageId: string | null; agentId: string } }

export type ConsentDeps = {
  pool: Pool
  /** 凭证是 Genet 的、绑的是本人的 Genet 页 → 那一页；否则 null */
  genetHome(g: ConsentGrant): Promise<string | null>
  /** 页面正文：活文档优先 */
  fragment(pageId: string): Promise<Y.XmlFragment>
  approvals(): Pick<OwnApprovals, 'decide'>
}

/** 端点的一次执行结果：没弹审批时按 status 回，弹过审批（已经发了头）时只回 body */
export type Outcome = { status: ContentfulStatusCode; body: Record<string, unknown> }

export const REJECTED = { rejected: true, message: '用户没同意' } as const

export function consentTitle(cause: string, what: string): string {
  return `（起因：${cause}）${what}`
}

export class Consent {
  constructor(private deps: ConsentDeps) {}

  /** 这把凭证此刻动手前要不要先问主人：要 = 起因（外来事件通知的抬头），不要 = null */
  async cause(g: ConsentGrant): Promise<string | null> {
    const home = await this.deps.genetHome(g)
    return home ? taintedSince(await this.deps.fragment(home), g.user.id) : null
  }

  /** 弹审批卡（Genet 页上，进收件箱）等主人点；调用方断开 = 不同意 */
  async ask(g: ConsentGrant, cause: string, what: string, signal: AbortSignal): Promise<boolean> {
    const pageId = g.ctx.pageId
    if (!pageId) return false
    const decision = await this.deps.approvals().decide(
      { pageId, agentId: g.ctx.agentId },
      {
        title: consentTitle(cause, what),
        toolCall: { kind: 'other', title: what, content: [{ type: 'content', content: { type: 'text', text: `起因：${cause}` } }] },
        // 问的是主人自己：Genet 页是个人页本来就只有他，这里写明，不靠页面权限兜
        only: g.user.id,
      },
      signal,
    )
    return decision.allowed
  }

  /** 有副作用的工具包一层：不用问 → 原样执行；要问 → 先发头保活、弹审批，同意才执行 */
  async guarded(c: Context, g: ConsentGrant, what: string, run: () => Promise<Outcome>): Promise<Response> {
    const cause = await this.cause(g)
    if (!cause) {
      const out = await run()
      return c.json(out.body, out.status)
    }
    return heartbeatJson(c, async () => {
      if (!(await this.ask(g, cause, what, c.req.raw.signal))) return REJECTED
      const out = await run()
      return out.status >= 400 && typeof out.body.error !== 'string' ? { ...out.body, error: `HTTP ${out.status}` } : out.body
    })
  }
}
