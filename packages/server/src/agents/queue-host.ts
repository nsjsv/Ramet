// ---------- 「以某人身份写一条用户消息 / 发起一轮」的实现（排队发送的宿主） ----------
// 派发前按发起人重判权限（页面可写、agent 可用、本页锁定的工具），写消息与开跑只有这一份实现，
// 不为别的入口另写一套：Genet 的派活（routes/ramet-tools.ts 的 /api/ramet/dispatch）用的也是它。
// manager 只交出它需要的几个操作，这里不碰 manager 的私有状态。

import type * as Y from 'yjs'
import type { Pool } from 'pg'
import { pageAccess, type DocWriter } from '../collab.js'
import { hasUnanswered, lockedTool } from './doc.js'
import { fitsLock, ToolLockedError, UnknownAgentError, type ResolvedAgent, type RunTarget } from './manager-types.js'
import { inheritedAttrs, userMessageElement } from './queue-message.js'
import type { QueueHost } from './send-queue.js'
import type { AgentEvent } from './types.js'

type User = { id: string; role: string }

/** agent 解析不出来（不存在 / 机器不在线 / 看不到那台机器）时的说法 */
export const AGENT_UNAVAILABLE = '这条消息指定的 agent 当前不可用'

export type QueueHostDeps = {
  pool: Pool
  running(pageId: string): boolean
  stop(pageId: string): void
  /** pageId = 在哪一页上用（Genet 只在自己的 Genet 页上解析得出来） */
  resolve(agentId: string, user: User, pageId: string): Promise<ResolvedAgent | null>
  pageFragment(pageId: string): Promise<Y.XmlFragment>
  resolveRun(pageId: string, body: { agent?: string }, user: User): Promise<RunTarget>
  /** 不是某个请求发起的（没有浏览器 cookie）：机器人客户端用临时会话 */
  continueRun(pageId: string, target: RunTarget, user: User): Promise<void>
  broadcast(pageId: string, ev: AgentEvent): void
  /** 测试桩可以不给；没有就写不了消息 */
  writeDoc?: DocWriter
}

export function queueHost(deps: QueueHostDeps): QueueHost {
  const { pool, running } = deps
  return {
    running,
    stop: deps.stop,
    writable: async (pageId, user) => {
      const role = await pageAccess(pool, pageId, user)
      return role !== null && role !== 'viewer'
    },
    unanswered: async (pageId) => hasUnanswered(await deps.pageFragment(pageId)),
    usable: async (pageId, user, agent) => {
      if (!agent) return null
      try {
        if (!(await deps.resolve(agent, user, pageId))) return AGENT_UNAVAILABLE
        // 一页一种工具：写进文档之前就拦，别留下一条发不出去的消息
        const lock = lockedTool(await deps.pageFragment(pageId))
        return fitsLock(lock, agent) ? null : new ToolLockedError(lock).message
      } catch (err) {
        // 机器使用权不够（assertLocalOwner / assertCanUse 抛 ForbiddenError）
        return err instanceof Error ? err.message : String(err)
      }
    },
    writeMessage: async (pageId, user, text, images, agent, ctx, extra) => {
      if (!deps.writeDoc) throw new Error('没有文档写入通道')
      const attrs = { author: user.id, ...(ctx ? { ctx } : {}), ...(extra?.timer ? { timer: extra.timer } : {}), ...(extra?.rule ? { rule: extra.rule } : {}) }
      await deps.writeDoc(
        `page:${pageId}`,
        user,
        (doc, origin) =>
          doc.transact(() => {
            const frag = doc.getXmlFragment('prosemirror')
            frag.insert(frag.length, [userMessageElement(text, images, { ...inheritedAttrs(frag, agent), ...attrs })])
          }, origin),
        'user',
      )
    },
    start: async (pageId, user, agent) => {
      if (running(pageId)) return 'busy'
      let target: RunTarget
      try {
        target = await deps.resolveRun(pageId, { agent }, user)
      } catch (err) {
        return { reason: err instanceof UnknownAgentError ? AGENT_UNAVAILABLE : err instanceof Error ? err.message : String(err) }
      }
      if (running(pageId)) return 'busy'
      // 不等这一轮跑完
      void deps.continueRun(pageId, target, user).catch(() => undefined)
      return 'ok'
    },
    broadcast: deps.broadcast,
  }
}
