// ---------- Ramet 自己的审批（知识中枢的删除等）----------
// agent 的审批归执行端（驱动持有，会话镜像投影它）。Ramet 自己的工具（trash_page 等）在中心里执行，
// 没有 agent 会话替它挂审批，所以由这里持有：发起时往页面的 SSE 广播一条同形状的 `permission` 事件
// （前端的审批卡不区分来源），答案走同一个 POST /permission（manager.answerPermission 先问这里）。
// 无超时，只在有人答 / 页面上的运行被停止 / 调用方断开（signal）时结束，结束时广播 permission_resolved。
// SSE 新订阅者由 replay 补发待批，刷新页面不丢。
// only：批的是某个人自己的事（规则替主人开跑、外来事件之后 Genet 动手）时只认他答：别人答当作没有这条（answer 返回 false，
// 路由按「不是 Ramet 自己的审批」往下找，答不到），收件箱也只给他（inbox.ts）；事件里带着 only，前端别人的页面上不画这张卡。

import { randomUUID } from 'node:crypto'
import type { AgentEvent, PermissionEvent } from './types.js'

/** 一条审批的结局：allowed = 点了「允许」类选项；by = 点的人（被停止 / 调用方断开 = null） */
export type OwnDecision = { allowed: boolean; by: string | null }

/** detached = 不是页面上哪一轮发起的（规则替主人开跑之前问他）：停掉这一页上的运行不收它，只等主人答 / 调用方撤 */
type Pending = { pageId: string; agentId: string; event: PermissionEvent; detached: boolean; settle: (allowed: boolean, by: string | null) => void }

export class OwnApprovals {
  private pending = new Map<string, Pending>()

  constructor(private broadcast: (pageId: string, ev: AgentEvent) => void) {}

  /** 发起一条审批并等结果（true = 允许）。agentId = 发起工具的那个 agent（前端按 agentId + requestId 认同一条） */
  async request(
    ctx: { pageId: string; agentId: string },
    info: { title: string; toolCall?: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<boolean> {
    return (await this.decide(ctx, info, signal)).allowed
  }

  /** 同 request，但带上「谁点的」，并可改两个选项的名字（optionId 恒为 allow / reject：答案走同一个 POST /permission）。
   *  记忆提议用它：选项叫「记住」/「不用」，写入记在点「记住」的人名下 */
  decide(
    ctx: { pageId: string; agentId: string },
    info: { title: string; toolCall?: Record<string, unknown>; labels?: { allow: string; reject: string }; only?: string; detached?: boolean },
    signal?: AbortSignal,
  ): Promise<OwnDecision> {
    const requestId = `ramet-${randomUUID()}`
    const event: PermissionEvent = {
      type: 'permission',
      requestId,
      title: info.title,
      ...(info.toolCall ? { toolCall: info.toolCall } : {}),
      agentId: ctx.agentId,
      ...(info.only ? { only: info.only } : {}),
      options: [
        { optionId: 'allow', name: info.labels?.allow ?? '允许', kind: 'allow_once' },
        { optionId: 'reject', name: info.labels?.reject ?? '拒绝', kind: 'reject_once' },
      ],
    }
    return new Promise<OwnDecision>((resolve) => {
      const settle = (allowed: boolean, by: string | null): void => {
        if (!this.pending.delete(requestId)) return
        signal?.removeEventListener('abort', onAbort)
        this.broadcast(ctx.pageId, { type: 'permission_resolved', requestId, agentId: ctx.agentId })
        resolve({ allowed, by })
      }
      const onAbort = (): void => settle(false, null)
      this.pending.set(requestId, { ...ctx, event, detached: info.detached === true, settle })
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort)
      this.broadcast(ctx.pageId, event)
    })
  }

  /** 答一条审批。不是这里的审批返回 false（调用方再去找 agent 会话的那条）；optionId 为 null = 取消 = 拒绝 */
  answer(pageId: string, agentId: string, requestId: string, optionId: string | null, by: string | null = null): boolean {
    const p = this.pending.get(requestId)
    if (!p || p.pageId !== pageId || p.agentId !== agentId) return false
    if (p.event.only && p.event.only !== by) return false
    p.settle(optionId === 'allow', by)
    return true
  }

  /** 页面上的运行被停止：它挂着的 Ramet 审批按拒绝结束 */
  cancelPage(pageId: string): void {
    for (const p of [...this.pending.values()]) if (p.pageId === pageId && !p.detached) p.settle(false, null)
  }

  /** 此刻待批的全部（收件箱聚合用的只读快照） */
  list(): Array<{ pageId: string; agentId: string; event: PermissionEvent }> {
    return [...this.pending.values()].map((p) => ({ pageId: p.pageId, agentId: p.agentId, event: p.event }))
  }

  /** 新订阅者的全量回放 */
  replay(pageId: string, send: (ev: AgentEvent) => void): void {
    for (const p of this.pending.values()) if (p.pageId === pageId) send(p.event)
  }
}
