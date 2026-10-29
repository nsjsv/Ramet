/* ---------- 审批 / 提问卡：运行条（run-strip.ts）与右上角工作台面板（hud/）共用 ----------
 * 纯 DOM。审批 = 标题 + 命令 / diff 预览 + agent 给的选项；提问（带 form）= 标题 + 表单（ask-form.ts）。
 * 答完不本地摘除：卡片的唯一摘除信号是 permission_resolved（任何一处答了，所有地方一起消失）。 */
import type { TeamState } from '@ramet/shared/run-model'
import { api, ApiError } from '../api'
import { COPY } from '../copy'
import { agentLabel } from '../team/team-agents'
import { askSource } from '../team/team-model'
import { setAgentRunError, type PermissionReq } from './agent-bar'
import { mountAsk } from './ask-form'
import { isPlanApproval, permissionPreviewHtml } from './run-detail'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  return node
}

export function askTitle(req: PermissionReq): string {
  return req.title || (req.form ? COPY.ask.form.title : COPY.ask.fallbackTitle)
}

/** 按一个选项应答审批：点过的这组按钮先禁用，失败了放开。404 = 已经结束（resolved 会摘掉），静默；403 / 409 要给用户理由 */
export function answerOption(pageId: string, req: PermissionReq, optionId: string, buttons: Iterable<HTMLButtonElement>): void {
  const list = [...buttons]
  for (const b of list) b.disabled = true
  void api.respondPermission(pageId, req.agentId, req.requestId, optionId).catch((err: unknown) => {
    for (const b of list) b.disabled = false
    if (err instanceof ApiError && err.status === 404) return
    setAgentRunError(err instanceof Error ? err.message : COPY.ask.failed)
  })
}

/** team = 这一轮的带队状态：组员的审批要说明是哪个组员（哪个任务）在问 */
export function buildAskCard(pageId: string, req: PermissionReq, team: TeamState | undefined): HTMLElement {
  const card = el('div', 'ask')
  const head = askTitle(req)
  card.setAttribute('role', 'alertdialog')
  card.setAttribute('aria-label', head)
  const title = el('div', 'ask-title')
  title.textContent = head
  card.append(title)
  const src = askSource(team, req.agentId)
  if (src.foreign || src.tasks.length > 0) {
    const who = el('div', 'ask-who')
    who.textContent = COPY.team.ask.from(agentLabel(req.agentId) ?? req.agentId, src.tasks.map((t) => t.title))
    card.append(who)
  }
  // agent 的提问（ACP elicitation）：表单替代选项按钮（提交 / 跳过；答案不合表单的原因显示在卡片里）
  if (req.form) {
    card.append(mountAsk(pageId, { agentId: req.agentId, requestId: req.requestId, form: req.form }, setAgentRunError).el)
    return card
  }
  const preview = permissionPreviewHtml(req.toolCall)
  if (preview) {
    const box = el('div', isPlanApproval(req.toolCall) ? 'ask-preview is-plan' : 'ask-preview')
    box.innerHTML = preview // 由 run-detail 的转义渲染器产出（escapeHtml），与工具详情同一来源
    card.append(box)
  }
  const acts = el('div', 'ask-acts')
  req.options.forEach((option, i) => {
    const btn = el('button', i === 0 ? 'ask-btn is-primary' : 'ask-btn')
    btn.type = 'button'
    btn.textContent = option.name
    btn.addEventListener('click', () => answerOption(pageId, req, option.optionId, acts.querySelectorAll('button')))
    acts.append(btn)
  })
  card.append(acts)
  return card
}
