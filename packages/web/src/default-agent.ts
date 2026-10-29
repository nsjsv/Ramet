import { useEffect, useSyncExternalStore } from 'react'
import { api, type AgentInfo } from './api'
import { subscribeControl } from './control'

/* ---------- 默认 agent 设置 ----------
 * 存 localStorage 的偏好（用户上次选的 agent id）。id 不能是硬编码白名单：agent 由部署方
 * 配置（本机 CLI）或 connector 上报（复合 id `c:<connectorId>:<agentId>`），前端只知道"服务端
 * 给了哪些"。所以这里只存字符串；「这个 id 现在还可不可用」由 useAgents() 的实时列表判定，
 * 不在读写处静默改写用户的选择。 */

const KEY = 'ramet:defaultAgent'

const listeners = new Set<() => void>()

/** 上次选择的 agent id；'' = 没选过（调用方回落到列表第一个） */
export function getDefaultAgent(): string {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return '' // 隐私模式/quota：按未选
  }
}

/** 默认 agent 变化订阅。编辑器（AI 块 logo 装饰）等非 React 消费方用它重算 */
export function subscribeDefaultAgent(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function setDefaultAgent(agent: string): void {
  try {
    localStorage.setItem(KEY, agent)
  } catch (err) {
    console.error('save default agent failed:', err)
  }
  listeners.forEach((l) => l())
}

/** 聊天输入框/控制条显示当前默认 agent（设置入口见设置弹窗「默认 Agent」分页） */
export function useDefaultAgent(): string {
  return useSyncExternalStore(subscribeDefaultAgent, getDefaultAgent)
}

/** 这条消息发给谁：按偏好顺序取第一个仍在目录里的 id，全都不在 → 目录第一个，目录空 → ''（没有可用 agent）。
 *  不给偏好 = 只看全局默认。页面上的解析（消息指定 → 本页记住的 → 全局默认）收在 agent-bar.tsx 的 pageAgent */
export function pickAgent(list: AgentInfo[], ...prefs: string[]): string {
  for (const id of prefs.length > 0 ? prefs : [getDefaultAgent()]) {
    if (id && list.some((a) => a.id === id)) return id
  }
  return list[0]?.id ?? ''
}

/* ---------- 真实 agent 列表（GET /api/agents）----------
 * 列表就是服务端事实：返回空数组 = 现在没有可用 agent（本机没配 CLI，也没有在线 connector），
 * 不能用硬编码占位顶上，那会让下拉框里出现一组点了必然 400 的假 agent。
 * `loaded` 只用来区分"还没拉到"与"确实没有"，UI 才能在后者给出「去连接 agent」的提示。 */

type AgentsState = { agents: AgentInfo[]; loaded: boolean }

let state: AgentsState = { agents: [], loaded: false }
const agentListListeners = new Set<() => void>()

function notifyAgents(): void {
  agentListListeners.forEach((l) => l())
}

/** 目录变化订阅（useAgents 与编辑器 AI 块 logo 装饰共用） */
export function subscribeAgentList(cb: () => void): () => void {
  agentListListeners.add(cb)
  return () => {
    agentListListeners.delete(cb)
  }
}

/** 已拉到的目录（未拉到/服务不可达 = 空数组，不编造 agent） */
export function agentList(): AgentInfo[] {
  return state.agents
}

/** 非 React 消费方（消息 chip 的 DOM 构造函数）读完整状态：`loaded` 是「拉过了吗」，
 *  不是「有没有结果」，两者必须分开，否则「没连任何 agent」会被显示成「加载中」。
 *  React 侧用 useAgents() 拿同一份。 */
export function agentsState(): AgentsState {
  return state
}

let fetching = false
let refetchQueued = false

/** 拉一次目录。并发合并：在飞期间又来请求（比如控制信道正好通知目录变了）就记一笔，
 *  落在飞的结果之后再拉，否则「connection 刚上线」的刷新会丢在旧请求的影子下 */
function loadAgents(): void {
  if (fetching) {
    refetchQueued = true
    return
  }
  fetching = true
  api
    .listAgents()
    .then((agents) => {
      state = { agents, loaded: true }
      notifyAgents()
    })
    .catch(() => undefined) // 服务不可达：保持现状（未加载的仍是"加载中"），下次调用可重试
    .finally(() => {
      fetching = false
      if (refetchQueued) {
        refetchQueued = false
        loadAgents()
      }
    })
}

let controlWired = false

/** 目录是「本机 agents + 在线 connector 上报的 agents」，connector 上下线就会变：
 *  订 control:global（与 App 同一条连接），收到 'agents' 或 (重)连上的 'sync' 就重拉 */
function wireControl(): void {
  if (controlWired) return
  controlWired = true
  subscribeControl((ev) => {
    if (ev === 'agents' || ev === 'sync') loadAgents()
  })
}

/** 首次按需拉取（已拉到则 no-op），顺带接上控制信道。
 *  文档模式没有聊天输入卡，由 AI 块 logo 插件在编辑器起来时调；公开页（匿名）不调，那会 401 跳登录 */
export function ensureAgentsLoaded(): void {
  wireControl()
  if (!state.loaded) loadAgents()
}

/** 强制重拉：设置面板打开时、控制信道通知目录变化时用（缓存不能靠"曾经拉到过"保鲜） */
export function refreshAgents(): void {
  wireControl()
  loadAgents()
}

/** agent 列表：模块级缓存（首个订阅者触发拉取） */
export function useAgents(): AgentsState {
  useEffect(ensureAgentsLoaded, [])
  return useSyncExternalStore(subscribeAgentList, () => state)
}
