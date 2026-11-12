/* ---------- 空间 AI 没启用时，开跑失败的说法 ----------
 * 服务端把没启用的空间 AI 当成认不出的 agent：点名了它是 400 unknown agent（「这条消息指定的 agent 当前不可用」），
 * 锁定成它的页回落不到是 409 tool-locked（「这个对话用的是 ramet:space-ai …」，带着 id）。用户看不懂，也不知道该找谁。
 * 前端从空间列表知道这一页所在空间的 AI 没开；这次请求又确实落在空间 AI 上，就直接说「这个空间还没有启用 AI」。
 * 「落在空间 AI 上」按服务端的选法判：@ 点名的下一家 > 请求体的 agent；重跑的那块回复是它写的；tool-locked 时锁定的工具是它
 * （unknown agent 不看锁定：锁成空间 AI 的页上 @ 了别家、别家不在线，那是别家的事）。 */

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { ApiError } from '../api'
import { isSpaceAiId } from '../assistant/identity'
import { spaceAiOfPage, type SpaceAiInfo } from '../assistant/space-ai'
import { COPY } from '../copy'
import { nextMention } from './chain-state'
import { pageView } from './page-views'

/** 服务端说「这个 agent 不可用 / 锁定的工具没有可用的」，而这一页的空间 AI 没开、这次又是叫它：返回说明，否则 null。
 *  info = 这一页所在团队空间的空间 AI（个人空间没有，那里的失败与它无关） */
export function spaceAiOffReason(info: SpaceAiInfo | null, code: string, named: boolean): string | null {
  if (!info || info.enabled || !named) return null
  return code === 'unknown agent' || code === 'tool-locked' ? COPY.spaceAi.notEnabled : null
}

function codeOf(err: unknown): string {
  return err instanceof ApiError ? err.code : ''
}

/** agent = 这次服务端会挑中的；lock = 这一页锁定的工具 */
function offText(pageId: string, code: string, agent: string, lock: string): string | null {
  const named = isSpaceAiId(agent) || (code === 'tool-locked' && isSpaceAiId(lock))
  return spaceAiOffReason(spaceAiOfPage(pageId), code, named)
}

/** 发消息 / 继续（POST /continue）失败：agent = 请求体里的，lock = 这一页锁定的工具 */
export function continueOffText(pageId: string, err: unknown, agent: string, lock: string): string | null {
  const doc = pageView(pageId)?.state.doc
  return offText(pageId, codeOf(err), (doc && nextMention(doc)) || agent, lock)
}

/** 这块回复是哪个 agent 写的（找不到是空串） */
export function replyAgentOf(doc: PMNode, replyId: string): string {
  let agent = ''
  doc.forEach((node) => {
    if (node.type.name === 'agent_reply' && node.attrs.id === replyId && typeof node.attrs.agent === 'string') agent = node.attrs.agent
  })
  return agent
}

/** 重新生成 / 续跑一块回复失败：那块回复是空间 AI 写的（或这一页锁定成它） */
export function replyOffText(pageId: string, err: unknown, replyId: string, lock: string): string | null {
  const doc = pageView(pageId)?.state.doc
  return offText(pageId, codeOf(err), doc ? replyAgentOf(doc, replyId) : '', lock)
}
