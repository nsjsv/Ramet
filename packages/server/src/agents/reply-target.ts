// ---------- 对已有回复块再跑一轮的执行目标：重新生成（redo）与续跑（resume）----------
// 两者的 agent / cwd / opts 来源相同：agent 取回复块自己的 `agent` 属性，cwd / opts 取它往前最近一条用户消息的
// （优先级同 resolveRun：消息 attrs > 页面级）。一页一种工具同一口径：回复块的工具不是锁定的那个、又不是 @ 出来的就拒绝。
// 路由先同步 await 这里（错误变成干净的 4xx），之后 continue 是 fire-and-forget。
import type * as Y from 'yjs'
import { lastUserMessage, lockedTool, mentionedReply, redoTarget, resumeTarget, serializeDoc } from './doc.js'
import {
  fitsLock,
  NoUserMessageError,
  NotResumableError,
  ReplyNotFoundError,
  ToolLockedError,
  UnknownAgentError,
  parseRemoteId,
  type ManagerHost,
  type ResolvedAgent,
  type RunTarget,
} from './manager-types.js'
import { effectiveCwd, loadChoice, loadToolProfile } from './session-store.js'
import { toolOf } from '@ramet/shared/reply-stats'
import { planGoalOf } from './team.js'

type TargetHost = Pick<ManagerHost, 'pool' | 'resolve' | 'catalog'>

/** 跑这块回复的机器现在不在线：换同一工具的另一台（本页记住的来源优先，再按目录顺序取第一台能用的）。
 *  会话由续跑那一轮从中心下发过去（session-move.ts）；接不上就新建会话、照常续跑 */
async function sameToolElsewhere(host: TargetHost, pageId: string, agentId: string, user: { id: string; role: string }): Promise<ResolvedAgent | null> {
  if (!parseRemoteId(agentId)) return null
  const tool = toolOf(agentId)
  const choice = await loadChoice(host.pool, pageId)
  const listed = (await host.catalog(user)).filter((a) => !a.unavailable).map((a) => a.id)
  for (const id of new Set([choice, ...listed])) {
    if (!id || id === agentId || toolOf(id) !== tool || !listed.includes(id)) continue
    const agent = await host.resolve(id, user).catch(() => null)
    if (agent) return agent
  }
  return null
}

/** agent / cwd / opts（不含 redo / resume 标记）。找不到回复 404；之前没有用户消息 400；agent 已不可用 400；工具锁 409。
 *  elsewhere = 原机器不在线时可以换同一工具的另一台（续跑） */
async function replyRunTarget(
  host: TargetHost,
  fragment: Y.XmlFragment,
  pageId: string,
  replyId: string,
  user: { id: string; role: string },
  elsewhere = false,
): Promise<RunTarget> {
  const target = redoTarget(fragment, replyId)
  if (!target.ok) throw target.reason === 'no-reply' ? new ReplyNotFoundError() : new NoUserMessageError()
  const agent = (await host.resolve(target.agent, user)) ?? (elsewhere ? await sameToolElsewhere(host, pageId, target.agent, user) : null)
  if (!agent) throw new UnknownAgentError()
  // 混用过多个工具的老页面：后来换了工具的回复只能新开一页再问；@ 点名出来的回复照常（本来就是合法产生的）
  const lock = lockedTool(fragment)
  if (!fitsLock(lock, agent.id) && !mentionedReply(fragment, replyId)) throw new ToolLockedError(lock)
  const { message } = target
  // opts 里是另一个 agent 的 config id 时无意义：消息指定了别的 agent 就不下发
  const opts = message.agent === '' || message.agent === agent.id ? message.opts : {}
  // 换了机器：消息里记的目录是原机器上的路径，用这台的生效工作区
  const cwd = (agent.id === target.agent && message.cwd) || (await effectiveCwd(host.pool, pageId, agent))
  return { agent, cwd, opts }
}

/** 重新生成 / 不是最后一块的失败回复的重试（POST /replies/:replyId/regenerate） */
export async function redoRunTarget(
  host: TargetHost,
  fragment: Y.XmlFragment,
  pageId: string,
  replyId: string,
  user: { id: string; role: string },
): Promise<RunTarget> {
  return { ...(await replyRunTarget(host, fragment, pageId, replyId, user)), redo: replyId }
}

/** 续跑（POST /replies/:replyId/resume）：只收页面上最后一块、以失败或停止收尾、不是带队的回复，否则 409 not-resumable。
 *  可续性先于 agent 解析判：不能续的回复不必再去问机器 */
export async function resumeRunTarget(
  host: TargetHost,
  fragment: Y.XmlFragment,
  pageId: string,
  replyId: string,
  user: { id: string; role: string },
): Promise<RunTarget> {
  const target = resumeTarget(fragment, replyId)
  if (!target.ok) {
    if (target.reason === 'no-reply') throw new ReplyNotFoundError()
    if (target.reason === 'no-message') throw new NoUserMessageError()
    throw new NotResumableError(target.reason)
  }
  // 带队的计划轮（完整档下最后一条用户消息以 /带队 开头）在出计划之前就断了，回复块上还没有 team 属性：
  // 续跑没有带队的工具与说明，只能重新生成
  const planning = planGoalOf(lastUserMessage(serializeDoc(fragment, target.index))) !== null
  if (planning && (await loadToolProfile(host.pool, pageId)) === 'full') throw new NotResumableError('team')
  return { ...(await replyRunTarget(host, fragment, pageId, replyId, user, true)), resume: replyId }
}
