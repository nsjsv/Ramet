/* ---------- 中心里跑的 agent（Genet、空间 AI）在前端的身份：唯一的定义处 ----------
 * Genet 是中心里跑的 agent（服务端 agents/assistant-agent.ts），不在 GET /api/agents 的目录里，只在主人自己的 Genet 页上用得了。
 * 空间 AI（服务端 agents/space-ai.ts）同样不在目录里：每个空间一个，id 只有一个，名字与开没开都跟着页面所在的空间（space-ai.ts）。
 * 前端各处认 agent 都经两条路，这两个都接在这两条路上，别处不写 `=== 'ramet:assistant'` / `=== 'ramet:space-ai'`：
 *  - 按 id 认名字 / 头像：default-agent.ts 的 findAgent 先查目录，查不到再问 builtinAgent（空间 AI 的名字要带上页面）；
 *  - 这一页能选哪些 agent：agent-bar.tsx 的 catalogForPage 经 pageCatalog 拿目录。Genet 页的目录就是 Genet 一个，
 *    于是回落（pickAgent）、消息 chip 的失效值收敛这些按目录判的逻辑都不用特判；空间 AI 开着时追加在目录末尾，
 *    但它只能点名 / 选中（optIn），不当回落。@ 候选列全部工具，不走这里（mention-sources.ts 的 mentionAgents 另把空间 AI 加进去）。
 * 发起控件里哪些对它们没意义（工作区、工具档位、带队）写在目录项的 caps 上，控件按 caps 显隐。 */
import type { AgentCaps, AgentInfo } from '../api'
import { SPACE_AI_DEFAULT_NAME, spaceAiOfPage, type SpaceAiInfo } from './space-ai'

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

export const SPACE_AI_ID = 'ramet:space-ai'

export function isSpaceAiId(id: string): boolean {
  return id === SPACE_AI_ID
}

// 同一个名字给同一个对象：目录、chip 的 useMemo / useSyncExternalStore 靠引用判断要不要重算
const spaceAiAgents = new Map<string, AgentInfo>()

/** 空间 AI 的目录项。头像是机器人（agent-marks.css 的 --mark-bot），不随名字变；
 *  能力同 Genet：中心里跑、没有工作区，工具是中心按空间收窄后给的（不摆档位），不能带队。
 *  fallback = 这一页已经锁定成它（第一块回复就是它，对话本来就是跟它的），这时它就是这一页的回落 */
function spaceAiAgent(name: string, fallback = false): AgentInfo {
  const key = `${fallback ? 1 : 0}${name}`
  let hit = spaceAiAgents.get(key)
  if (!hit) {
    hit = { id: SPACE_AI_ID, label: name, mark: 'bot', caps: { workspace: false, toolProfile: false, team: false }, optIn: !fallback }
    spaceAiAgents.set(key, hit)
  }
  return hit
}

/** 空间 AI 在这一页上叫什么：页面所在空间配的名字，取不到（不知道这一页在哪、公开页）写「AI」。
 *  名字每次现取，改名后新旧回复的抬头都是新名字 */
export function spaceAiName(pageId?: string): string {
  return spaceAiOfPage(pageId)?.name ?? SPACE_AI_DEFAULT_NAME
}

/** 服务端目录里不列、前端自带的 agent（Genet、空间 AI）；认不出 undefined。pageId 给空间 AI 定名字 */
export function builtinAgent(id: string, pageId?: string): AgentInfo | undefined {
  if (id === ASSISTANT_ID) return ASSISTANT_AGENT
  return id === SPACE_AI_ID ? spaceAiAgent(spaceAiName(pageId)) : undefined
}

/** 在 agent 列表末尾加上这一页的空间 AI（开着时）；没有就原样返回同一个数组 */
export function withSpaceAi(agents: readonly AgentInfo[], spaceAi: SpaceAiInfo | null, fallback = false): readonly AgentInfo[] {
  return spaceAi?.enabled ? [...agents, spaceAiAgent(spaceAi.name, fallback)] : agents
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

/** 这一页的目录（锁定过滤之前）：Genet 页只有 Genet；别的页面是服务端目录，空间 AI 开着时追加在末尾。
 *  lock = 这一页锁定的工具：锁成空间 AI 时它是回落，否则只能点名 / 选中 */
export function pageCatalog(agents: readonly AgentInfo[], assistantPage: boolean, spaceAi: SpaceAiInfo | null = null, lock = ''): readonly AgentInfo[] {
  if (assistantPage) return ONLY_ASSISTANT
  return withSpaceAi(agents, spaceAi, isSpaceAiId(lock))
}
