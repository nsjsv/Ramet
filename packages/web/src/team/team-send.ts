/* ---------- 带队「开工」：写一条用户消息，再 POST /continue {team} ----------
 * 计划卡是 widget / 聊天气泡里的 DOM，拿不到编辑器。编辑器会话建好后在这里登记怎么取这页的主编辑器视图
 * （同 memory/remember.ts 的 bindPageSpace），开工时按页取。
 * 顺序：先写一条「开工：<计划标题>」的用户消息（发起人身份进文档，组长的提示词里就有这一句），再 continue。
 *   - 写之前先 GET 一次最新计划并本地过一遍 startBlocker：别人刚取消了或负责人刚被收回，就不要在文档里留一条没用的消息；
 *   - continue 被服务端明确拒绝（4xx）时把刚写的那条消息撤掉（只撤文字完全一致、且之后没有回复的那一条），不留孤儿消息；
 *   - 预检之后的并发第二次开工以 SSE error 回来（回复块的失败条），不走这里。 */

import type { EditorView } from '@milkdown/kit/prose/view'
import { api, ApiError } from '../api'
import { COPY } from '../copy'
import { agentList } from '../default-agent'
import { agentStateFor, appendUserMessage } from '../editor/agent-bar'
import { findBlockIdPos } from '../editor/block-id'
import { deleteBlockRange } from '../editor/block-delete'
import { draftIdOf } from '../editor/doc-send'
import { teamApi, planStore } from './team-api'
import { startErrorText } from './team-errors'
import { startBlocker } from './team-model'

const T = COPY.team.plan

const views = new Map<string, () => EditorView | undefined>()

/** 登记这页主编辑器视图的取法，返回注销函数（重复登记时旧的注销不会误删新的） */
export function bindPageView(pageId: string, get: () => EditorView | undefined): () => void {
  views.set(pageId, get)
  return () => {
    if (views.get(pageId) === get) views.delete(pageId)
  }
}

function pageView(pageId: string): EditorView | undefined {
  const view = views.get(pageId)?.()
  return view && !view.isDestroyed ? view : undefined
}

/** continue 被拒后撤掉刚写的开工消息，只撤最后一条、还没有回复、文字完全一致的那条 */
function retract(view: EditorView, text: string): void {
  if (view.isDestroyed) return
  const id = draftIdOf(view.state.doc)
  const pos = id ? findBlockIdPos(view.state.doc, id) : null
  const node = pos === null ? null : view.state.doc.nodeAt(pos)
  if (pos === null || !node || node.textContent.trim() !== text) return
  deleteBlockRange(view, pos, pos + node.nodeSize)
}

const leaderLabel = (id: string): string => agentList().find((a) => a.id === id)?.label ?? id

/** 开工。失败抛 Error，message 是给人看的（计划卡就地显示） */
export async function startTeamPlan(pageId: string, planId: string): Promise<void> {
  const view = pageView(pageId)
  if (!view) throw new Error(T.noEditor)
  const plan = await teamApi.get(pageId, planId)
  planStore.put(plan)
  if (plan.status !== 'draft') throw new Error(T.after[plan.status])
  const blocker = startBlocker(plan, agentStateFor(pageId).status === 'running')
  if (blocker) throw new Error(T.blocker[blocker])

  const text = T.startMessage(plan.title)
  // 消息钉在组长 agent 上：服务端要求执行轮的组长就是出计划的那个 agent（不然 409 leader mismatch）
  appendUserMessage(view, text, plan.leader)
  try {
    await api.continuePage(pageId, plan.leader, planId)
  } catch (err) {
    if (err instanceof ApiError && err.status >= 400 && err.status < 500) retract(view, text)
    throw new Error(startErrorText(err, leaderLabel(plan.leader)))
  }
}
