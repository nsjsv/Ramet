/* ---------- Genet 在前端的身份：唯一的定义处 ----------
 * Genet 是中心里跑的 agent（服务端 agents/assistant-agent.ts），不在 GET /api/agents 的目录里，只在主人自己的 Genet 页上用得了。
 * 前端各处认 agent 都经两条路，Genet 都接在这两条路上，别处不写 `=== 'ramet:assistant'`：
 *  - 按 id 认名字 / 头像：default-agent.ts 的 findAgent 先查目录，查不到再问 builtinAgent；
 *  - 这一页能选哪些 agent：agent-bar.tsx 的 catalogForPage 经 pageCatalog 拿目录。Genet 页的目录就是 Genet 一个，
 *    于是回落（pickAgent）、消息 chip 的失效值收敛这些按目录判的逻辑都不用特判；别的 agent 照样能 @（@ 候选不走这里）。
 * 发起控件里哪些对它没意义（工作区、工具档位、带队）写在目录项的 caps 上，控件按 caps 显隐。 */
import type { AgentCaps, AgentInfo } from '../api'

export const ASSISTANT_ID = 'ramet:assistant'

/** Genet 的目录项。名字与服务端 ASSISTANT_LABEL 一致；头像是自绘的 mark（agent-marks.css 的 --mark-genet） */
export const ASSISTANT_AGENT: AgentInfo = {
  id: ASSISTANT_ID,
  label: 'Genet',
  mark: 'genet',
  // 不在任何机器上跑（没有工作区）；工具是中心固定给的（换档位会把它的 Ramet 工具拿掉）；不能同步调别的 agent（不能带队）
  caps: { workspace: false, toolProfile: false, team: false },
}

const FULL_CAPS: AgentCaps = { workspace: true, toolProfile: true, team: true }

/** 目录项的能力：服务端目录里的 agent 都是全有 */
export function capsOf(agent: AgentInfo | undefined): AgentCaps {
  return agent?.caps ?? FULL_CAPS
}

/** 服务端目录里不列、前端自带的 agent（目前只有 Genet）；认不出 undefined */
export function builtinAgent(id: string): AgentInfo | undefined {
  return id === ASSISTANT_ID ? ASSISTANT_AGENT : undefined
}

// 唤起浮窗时 POST /api/me/assistant 给的那一页：SSE 首帧（choice）到之前就认得出它，浮窗打开的那一刻不会先按全局默认的 agent 画
let known: string | null = null

export function rememberAssistantPage(pageId: string): void {
  known = pageId
}

/** 这一页是不是 Genet 页：唤起时拿到的那一页，或页面记住的来源 / 锁定的工具是 Genet（服务端只在 Genet 页上认这个来源） */
export function isAssistantPage(pageId: string, state: { choice: string | null; lock: string }): boolean {
  return pageId === known || state.choice === ASSISTANT_ID || state.lock === ASSISTANT_ID
}

const ONLY_ASSISTANT: readonly AgentInfo[] = [ASSISTANT_AGENT]

/** 这一页的目录（锁定过滤之前）：Genet 页只有 Genet，别的页面就是服务端目录 */
export function pageCatalog(agents: readonly AgentInfo[], assistantPage: boolean): readonly AgentInfo[] {
  return assistantPage ? ONLY_ASSISTANT : agents
}
