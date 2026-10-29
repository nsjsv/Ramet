import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { api, ApiError, isToolProfile, type AskForm, type ConfigOption, type QueueItem, type ToolProfile } from '../api'
import { mountAsk } from './ask-form'
import { COPY } from '../copy'
import { agentList, getDefaultAgent, pickAgent, useAgents, useDefaultAgent } from '../default-agent'
import { applyRunEvent, type RunEvent, type RunState, type TeamPlanView } from '@ramet/shared/run-model'
import { planStore } from '../team/team-api'
import { isRunEventType } from './run-event-types'
import { forgetFailReason, rememberFailReason } from './fail-reason'
import { encodeOpts, messageConfigOf, type MessageConfig } from './message-blocks'
import { upgradeMentions } from './mention-upgrade'
import { selfId } from '../people'

// ---------- agent 交互层 ----------
// SSE（GET /api/pages/:id/agent-events）推 status / permission / permission_resolved / commands / config 等事件；
// server 未就绪（404 / SSE 失败）时状态保持 idle、命令区为空，UI 降级不崩。

export interface PermissionOption {
  optionId: string
  name: string
}

// ---------- 会话配置项（ACP session config options） ----------
// 类型与 REST / SSE 契约同在 api.ts；事实源是 agent 的会话：新建 / 加载会话、setConfigOption
// 应答、config_option_update 三处推来。AgentState.configs 按 agentId 分存这批选项，
// 换 agent 后旧选项不能当新 agent 的用。

export interface PermissionReq {
  /** 哪台机器上的哪个 agent 在问（requestId 只在单个 agent 进程内唯一） */
  agentId: string
  requestId: string
  title: string
  options: PermissionOption[]
  /** ACP request_permission 的 toolCall（kind / title / rawInput / content / locations，服务端已限长）：
   *  审批卡的命令 / diff 预览只读它，没有就不画预览 */
  toolCall?: Record<string, unknown>
  /** 有值表示这是 agent 的提问（ACP elicitation）：画表单而不是选项按钮（ask-form.ts） */
  form?: AskForm
}

export interface AgentCommand {
  name: string
  description: string
  /** 要参数时的提示文案；null / 缺省 = 不带参数 */
  input?: string | null
}

export type AgentRunState = 'idle' | 'running' | 'done' | 'error'

// ---------- 正在跑的一轮：状态形状与 reducer 都在共享包，与服务端 RunRecord 同一份 ----------
// 服务端只发已经决定好的原语（reply / think / said / step）与快照（run），这里照做。中途
// 关页面再回来是从快照重建的，不靠本地攒，两端状态必然一致。

export type { Step, StepKind, StepStatus } from '@ramet/shared/run-model'

export interface LiveRun {
  /** 文档里正在写的那个占位回复块的 id（宿主按它找块，不猜最后一条） */
  replyId: string
  /** 本机时钟下的本轮开始时刻（按快照里的 at 反推），只用于显示用时 */
  startedAt: number
  /** 跑这一轮的 agent（catalog id，快照带来，可能缺）：右上角岛画头像 */
  agent?: string
  state: RunState
  /** 每次变化递增：非 React 消费者据此判断要不要重画 */
  version: number
  /** status 结束后才有；run 本身留着，宿主要播完收回 */
  outcome?: 'end' | 'cancelled' | 'error'
  /** 结束时刻（本机时钟）与过程页 id（status 结束事件带来）：右上角工作台停表、进过程页 */
  endedAt?: number
  runId?: string
}

export interface AgentState {
  status: AgentRunState
  /** 本页记住的来源（服务端 agent_session.choice，SSE 首帧给）：'' 表示没记过（回落全局默认），
   *  null 表示还不知道（首帧没到），这时不预备会话，免得先冷启动一个全局默认的 agent */
  choice: string | null
  /** 本页给 agent 的 Ramet 工具档位（服务端 agent_session.tools，SSE 首帧给；没设过是 full）。
   *  none 只当 UI、minimal 读写当前页、full 全部；非 full 时斜杠菜单不给带队与 skill 点名（slash.ts） */
  tools: ToolProfile
  message?: string
  /** 各 agent 的生效工作区（用户指定值或执行端默认；cwd 按 agent 分存，不同 agent 可能在不
   *  同机器上）。来源是 prepare 与改绑端点的 cwd 事件，未问过就没有该键 */
  cwds: Record<string, string>
  /** 各 agent 待批的审批（按到达顺序排；只由 permission / permission_resolved 事件增删，
   *  本地答完不摘除，移除的唯一信号是 permission_resolved） */
  permissions: PermissionReq[]
  /** 各 agent 的原生命令列表（按 agent 分存，同 configs）。事件整份替换该 agent 的这一份；
   *  空数组表示这个 agent 没有命令 */
  commands: Record<string, AgentCommand[]>
  /** 已知的会话配置项，按 agent 分存（catalog id 到 options）。
   *  有 key（哪怕是空数组）说明这个 agent 的选项问过了；空数组表示该 agent 不暴露配置项。 */
  configs: Record<string, ConfigOption[]>
  /** 正在跑（或刚结束、还没收回）的那一轮。idle 清掉；running 不清已有的（快照是下一条
   *  SSE，清掉而块还是 o:run 会闪「已中断」）。同 replyId 的 run 快照只替换 state。 */
  run: LiveRun | null
  /** 运行中排队发送（服务端 send-queue.ts）：整份排队区，SSE 首帧回放，变化时整份替换 */
  queue: { items: QueueItem[]; paused: boolean }
}

const IDLE: AgentState = { status: 'idle', choice: null, tools: 'full', permissions: [], commands: {}, configs: {}, cwds: {}, run: null, queue: { items: [], paused: false } }

// ---------- SSE 状态（模块级共享 store） ----------
// 同一页面不止一个消费者：React 侧（Editor 的 useAgentEvents）和非 React 的过程列表
// （run-steps.ts，挂在编辑器 widget / 气泡 DOM 里，没有 React root）。EventSource 因此按
// pageId 提到模块级共享 + 引用计数：第一个订阅者开流，最后一个退订时断开。

interface AgentEventStore {
  state: AgentState
  /** 事件到达时按到达顺序通知；store 是状态的唯一持有者（消费者只读快照，不各攒一份） */
  listeners: Set<(state: AgentState) => void>
  /** 本地先行的写入（改选来源时立刻回显，SSE 广播回来再收敛成同一个值） */
  update: (fn: (s: AgentState) => AgentState) => void
  close: () => void
}

const sseStores = new Map<string, AgentEventStore>()

/** 当前已知状态（该页还没 store = 空闲态）：非 React 消费者先读一帧再订阅 */
export function agentStateFor(pageId: string): AgentState {
  return sseStores.get(pageId)?.state ?? IDLE
}

/** 某页上某 agent 的原生命令（非 React 消费者如 slash.ts 读；还没收到是空数组）。
 *  命令归属这个 agent，换 agent 后菜单自然跟着换。 */
export function agentCommandsFor(pageId: string, agentId: string): AgentCommand[] {
  return agentStateFor(pageId).commands[agentId] ?? []
}

function openAgentEvents(pageId: string): AgentEventStore {
  let closed = false
  let es: EventSource | undefined
  let timer: number | undefined
  const listeners = new Set<(state: AgentState) => void>()
  // 所有写入都走这里：换掉 state 再把新快照推给每个消费者
  const update = (fn: (s: AgentState) => AgentState): void => {
    store.state = fn(store.state)
    listeners.forEach((l) => l(store.state))
  }
  const store: AgentEventStore = {
    state: IDLE,
    listeners,
    update,
    close() {
      closed = true
      if (timer !== undefined) window.clearTimeout(timer)
      es?.close()
      listeners.clear()
      dropAgentOptions(pageId)
      planStore.invalidate(pageId) // 离开期间的 team_plan 不会重放：带队计划卡下次出现时重拉
    },
  }
  const connect = () => {
    if (closed) return
    es = new EventSource(`/api/pages/${pageId}/agent-events`)
    es.onmessage = (e) => {
      // SSE 是 JSON 边界：字段语义由 type 决定，options 两种形态（审批选项 / 会话配置项）各在
      // 自己的 case 里收敛
      let ev: {
        type?: string
        state?: AgentRunState
        message?: string
        cwd?: string
        requestId?: string
        title?: string
        options?: unknown
        toolCall?: unknown
        form?: unknown
        list?: AgentCommand[]
        agentId?: string
        profile?: string
        replyId?: string
        runPageId?: string
        at?: number
        runState?: RunState
      }
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(e.data) as Record<string, unknown>
        // run 快照的 state 字段与 status 事件的 state 同名不同义：拆开取，别让一个吞掉另一个
        ev =
          raw.type === 'run'
            ? { type: 'run', replyId: raw.replyId as string, at: raw.at as number, runState: raw.state as RunState, ...(typeof raw.agent === 'string' ? { agentId: raw.agent } : {}) }
            : raw
      } catch {
        return
      }
      if (isRunEventType(raw.type)) {
        const runEvent = raw as RunEvent
        update((s) => {
          if (!s.run) return s
          applyRunEvent(s.run.state, runEvent)
          return { ...s, run: { ...s.run, version: s.run.version + 1 } }
        })
        return
      }
      // 带队计划（提交 / 改 / 取消 / 开工 / 收尾时服务端广播整份视图）：进全页共用的计划视图 store，计划卡读它。
      // 不是一轮的事件（计划卡在开工之后仍要跟着变），也不属于哪个 live run
      if (raw.type === 'team_plan') {
        if (raw.plan && typeof raw.plan === 'object') planStore.put(raw.plan as TeamPlanView)
        return
      }
      switch (ev.type) {
        case 'choice':
          update((s) => (s.choice === (ev.agentId ?? '') ? s : { ...s, choice: ev.agentId ?? '' }))
          break
        case 'tool_profile': {
          const profile = isToolProfile(ev.profile) ? ev.profile : 'full'
          update((s) => (s.tools === profile ? s : { ...s, tools: profile }))
          break
        }
        case 'run':
          if (ev.replyId && ev.runState) {
            const replyId = ev.replyId
            const runState = ev.runState
            const at = ev.at ?? 0
            const agent = ev.agentId
            update((s) => {
              // 同一块、同一轮（还没结束）：只换 state（计时起点留着）。另一块、或同一块的下一轮
              // （重试 / 重新生成复用块 id，上一轮的 outcome 还留在 store 里）才整份换掉，
              // 否则新一轮会继承旧的起点与结果，一开始就被当成已结束。
              if (s.run && s.run.replyId === replyId && s.run.outcome == null) {
                return { ...s, run: { ...s.run, state: runState, version: s.run.version + 1, ...(agent ? { agent } : {}) } }
              }
              forgetFailReason(replyId) // 新一轮：上一轮（同块重试）的失败原因作废
              return { ...s, run: { replyId, startedAt: Date.now() - at, state: runState, version: 0, ...(agent ? { agent } : {}) } }
            })
          }
          break
        case 'queue':
          update((s) => ({ ...s, queue: { items: (raw.items as QueueItem[] | undefined) ?? [], paused: raw.paused === true } }))
          break
        case 'queue_dropped': {
          // 排着的消息派发时被丢掉（排的人失权 / agent 不在了）：只告诉排的人自己
          const mine = agentStateFor(pageId).queue.items.find((q) => q.id === raw.id)
          if (mine?.userId === selfId() && typeof raw.reason === 'string') setAgentRunError(`排着的消息没发出去：${raw.reason}`)
          break
        }
        case 'cwd':
          // 生效工作区（按 agent 分存）：prepare 与改绑端点都会推
          if (ev.agentId && ev.cwd) {
            update((s) => ({ ...s, cwds: { ...s.cwds, [ev.agentId!]: ev.cwd! } }))
          }
          break
        case 'status': {
          const state = ev.state ?? 'idle'
          const outcome: LiveRun['outcome'] =
            state === 'error' ? 'error' : state === 'done' ? (ev.message ? 'cancelled' : 'end') : undefined
          update((s) => ({
            ...s,
            status: state,
            message: ev.message,
            // running 不清已有 live run：订阅先到 status、下一条才是快照，中间清掉会闪「已中断」。
            // 新一轮开始时 run 本来就是 null，快照再装上。idle 仍清。结束只记结果，留给宿主播完收回。
            run:
              state === 'idle'
                ? null
                : state === 'running'
                  ? s.run
                  : s.run && outcome
                    ? { ...s.run, outcome, endedAt: s.run.endedAt ?? Date.now(), ...(ev.runPageId ? { runId: ev.runPageId } : {}) }
                    : s.run,
          }))
          break
        }
        case 'config': {
          const options = (ev.options as ConfigOption[] | undefined) ?? []
          setAgentOptions(pageId, ev.agentId ?? '', options) // 非 React 消费方（消息 chip）的镜像
          update((s) => ({
            ...s,
            configs: { ...s.configs, [ev.agentId ?? '']: options },
          }))
          break
        }
        case 'error':
          // 服务端 fire-and-forget 路径的失败经这里到前端：那些调用已经 202 回了，错误没法走响应体，
          // 否则就是点了没反应。失败只有一个落点：带 replyId 说明这一轮的回复块已经开了，原因进它的失败条；
          // 不带（预备会话 / 配置失败，没有块可挂）才进页面顶部的运行错误条。
          if (!ev.message) break
          if (ev.replyId) rememberFailReason(ev.replyId, ev.message)
          else setAgentRunError(ev.message)
          break
        case 'permission': {
          // 身份是 agentId + requestId（requestId 只在单个 agent 进程内唯一）；回放会重发已有的，
          // 按这对键去重
          const { agentId, requestId } = ev
          if (!agentId || !requestId) break
          update((s) =>
            s.permissions.some((p) => p.agentId === agentId && p.requestId === requestId)
              ? s
              : {
                  ...s,
                  permissions: [
                    ...s.permissions,
                    {
                      agentId,
                      requestId,
                      title: ev.title ?? '',
                      options: (ev.options as PermissionOption[] | undefined) ?? [],
                      ...(ev.toolCall && typeof ev.toolCall === 'object' ? { toolCall: ev.toolCall as Record<string, unknown> } : {}),
                      ...(ev.form && typeof ev.form === 'object' ? { form: ev.form as AskForm } : {}),
                    },
                  ],
                },
          )
          break
        }
        case 'permission_resolved': {
          // 移除审批的唯一信号（有人答、停止、会话被换、进程退出、connector 断了）
          const { agentId, requestId } = ev
          if (!agentId || !requestId) break
          update((s) =>
            s.permissions.some((p) => p.agentId === agentId && p.requestId === requestId)
              ? { ...s, permissions: s.permissions.filter((p) => !(p.agentId === agentId && p.requestId === requestId)) }
              : s,
          )
          break
        }
        case 'commands': {
          // 该 agent 的命令列表：整份替换（空数组表示没命令）。无 agentId 的事件忽略
          const { agentId } = ev
          if (!agentId) break
          update((s) => ({ ...s, commands: { ...s.commands, [agentId]: ev.list ?? [] } }))
          break
        }
      }
    }
    // 每次（重）连上都会重放全量：审批以回放为准，断流期间被答掉的审批不能卡住队列。
    // commands / configs 不清（重放会补齐，多清一次只会闪空）。
    es.onopen = () => {
      update((s) => (s.permissions.length ? { ...s, permissions: [] } : s))
      planStore.refreshPage(pageId) // 断流期间错过的 team_plan：这一页上没收尾的带队计划重拉一遍
    }
    // 404（路由未就绪）会连环报错：断开、退避 8s 重连，页面不崩、网络面板不刷屏。
    // 已经有一个还没出结果的 live run 时约 1s 就重连。两种都不清 run。
    es.onerror = () => {
      es?.close()
      if (timer !== undefined) window.clearTimeout(timer)
      if (closed) return
      const live = store.state.run != null && store.state.run.outcome == null
      timer = window.setTimeout(connect, live ? 1000 : 8000)
    }
  }
  connect()
  return store
}

/** 订阅某页的事件流（引用计数）：第一个消费者开流、最后一个退订时断开 */
export function subscribeAgentEvents(pageId: string, cb: (state: AgentState) => void): () => void {
  let store = sseStores.get(pageId)
  if (!store) {
    store = openAgentEvents(pageId)
    sseStores.set(pageId, store)
  }
  store.listeners.add(cb)
  return () => {
    store!.listeners.delete(cb)
    if (store!.listeners.size === 0) {
      store!.close()
      sseStores.delete(pageId)
    }
  }
}

export function useAgentEvents(pageId: string | undefined): AgentState {
  const [state, setState] = useState<AgentState>(IDLE)
  useEffect(() => {
    if (!pageId) {
      setState(IDLE)
      return
    }
    setState(agentStateFor(pageId)) // 另一个消费者已经建好 store 时，挂载即取当前快照
    return subscribeAgentEvents(pageId, setState)
  }, [pageId])
  return state
}

/** 运行错误条：聊天模式输入卡上方与文档模式标题下方共用同一份 runError，
 *  否则文档模式里 continue / prepare 失败就是点了没反应。 */
export function RunErrorBar() {
  const runError = useAgentRunError()
  if (!runError) return null
  return <div className="chat-run-error">{runError}</div>
}

// 运行错误单源（continue 被服务端拒：404 无此页 / 400 未配置该 agent / 409 忙）。
// 静默 catch 会让点了没反应变成玄学：聊天输入、控制条、斜杠命令三条路径都往这里报。

let runError: string | null = null
const runErrorListeners = new Set<() => void>()

export function setAgentRunError(message: string | null): void {
  runError = message
  runErrorListeners.forEach((l) => l())
}

export function useAgentRunError(): string | null {
  const [value, setValue] = useState(runError)
  useEffect(() => {
    const listener = () => setValue(runError)
    runErrorListeners.add(listener)
    return () => {
      runErrorListeners.delete(listener)
    }
  }, [])
  return value
}

/** 触发一次生成；失败原因写到运行错误单源（不吞） */
export function runAgent(pageId: string, agent: string): void {
  if (!agent) {
    setAgentRunError('没有可用的 agent：还没连 connector（设置 → 连接器），或别人接入的机器还没授权给你（设置 → 机器）')
    return
  }
  setAgentRunError(null)
  void api.continuePage(pageId, agent).catch((err: unknown) => {
    setAgentRunError(err instanceof Error ? `启动失败：${err.message}` : '启动失败')
  })
}

/** 「继续剩下的」：@ 点名链在某一家失败后停住，跳过它接着跑后面被点名的。就是一次普通 continue，
 *  下一家由服务端按文档里的链进度选（agents/manager.ts 的 resolveRun），请求里的 agent 在有链时不起作用 */
export function continueRest(pageId: string): void {
  runAgent(pageId, pageAgent(pageId))
}

// ---------- 这一页发给谁（来源按页记住） ----------
// 唯一解析规则：指定值（消息 attrs）、本页记住的（choice）、全局默认（localStorage）、目录第一个，依次回落，
// 只取仍在目录里的（被撤销的 connector 等失效 id 跳过）。输入卡、文档发送、斜杠命令、消息 chip 都走这里。

/** 非 React 消费方用（发送 / 斜杠命令 / 重新回复） */
export function pageAgent(pageId: string, preferred = ''): string {
  return pickAgent(agentList(), preferred, agentStateFor(pageId).choice ?? '', getDefaultAgent())
}

/** React 侧：目录、全局默认、本页记住的任一变化都重算；只订 choice，流式事件不触发重画。
 *  ready 表示本页记住的已经知道了（首帧到了），这之前别预备会话 */
export function usePageAgent(pageId: string | undefined, preferred = ''): { agent: string; ready: boolean } {
  const { agents } = useAgents()
  const stored = useDefaultAgent()
  const subscribe = useCallback(
    (cb: () => void) => (pageId ? subscribeAgentEvents(pageId, () => cb()) : () => undefined),
    [pageId],
  )
  const choice = useSyncExternalStore(subscribe, () => (pageId ? agentStateFor(pageId).choice : null))
  return { agent: pickAgent(agents, preferred, choice ?? '', stored), ready: choice !== null }
}

/** 记住本页的来源：本地先回显，服务端落库后广播给本页所有订阅者（协作者的输入卡跟着换） */
export function setPageChoice(pageId: string, agentId: string): void {
  if (!agentId || agentStateFor(pageId).choice === agentId) return
  sseStores.get(pageId)?.update((s) => ({ ...s, choice: agentId }))
  void api.setAgentChoice(pageId, agentId).catch((err: unknown) => {
    setAgentRunError(err instanceof Error ? `记住来源失败：${err.message}` : '记住来源失败')
  })
}

/** 改本页的工具档位：本地立刻回显，SSE 广播回来收敛；失败回滚到原值并走运行错误条 */
export function setPageTools(pageId: string, profile: ToolProfile): void {
  const before = agentStateFor(pageId).tools
  if (before === profile) return
  const store = sseStores.get(pageId)
  store?.update((s) => ({ ...s, tools: profile }))
  void api.setAgentTools(pageId, profile).catch((err: unknown) => {
    store?.update((s) => (s.tools === profile ? { ...s, tools: before } : s))
    setAgentRunError(err instanceof Error ? `${COPY.tools.failed}：${err.message}` : COPY.tools.failed)
  })
}

/** 重新生成 / 重试（同一个动作）：对一块已有的回复再跑一轮，块 id 不变。
 *  409（页面忙）/ 400（agent 不可用）等失败原因写到运行错误单源，不吞 */
export function regenerateReply(pageId: string, replyId: string): void {
  setAgentRunError(null)
  void api.regenerate(pageId, replyId).catch((err: unknown) => {
    setAgentRunError(err instanceof Error ? `${COPY.run.regenerateFailed}：${err.message}` : COPY.run.regenerateFailed)
  })
}

// ---------- 会话配置项的模块级镜像 ----------
// 消息 chip（message-chips.ts）是非 React 的 DOM 构造函数（widget 里没有 React root，同
// buildBubble / buildRunChip），要读当前 agent 的会话配置项只能走模块级单源。
// 事实源是 SSE 的 config 事件，这里与 React state 同一处写入，镜像一份给非 React 消费方。
// 按 (页面, agent) 分存：会话配置项是页面级的，只按 agent 记会把 A 页的模型显示到 B 页上，
// 还让 B 页以为问过了而不再预备会话（B 页的目录因此也一直是默认）。

const agentOptions = new Map<string, ConfigOption[]>()
const optionsKey = (pageId: string, agentId: string) => `${pageId}\n${agentId}`
const agentOptionsListeners = new Set<() => void>()

/** 共享空数组：useSyncExternalStore 要求同一份状态返回同一个引用 */
const NO_OPTIONS: ConfigOption[] = []

export function agentOptionsFor(pageId: string, agentId: string): ConfigOption[] {
  return agentOptions.get(optionsKey(pageId, agentId)) ?? NO_OPTIONS
}

/** 目录 / 配置变化订阅（chip 装饰据此重算） */
export function subscribeAgentOptions(cb: () => void): () => void {
  agentOptionsListeners.add(cb)
  return () => {
    agentOptionsListeners.delete(cb)
  }
}

/** config 事件到达时由 useAgentEvents 调用（唯一写入处） */
function setAgentOptions(pageId: string, agentId: string, options: ConfigOption[]): void {
  agentOptions.set(optionsKey(pageId, agentId), options)
  agentOptionsListeners.forEach((l) => l())
}

/** 页面的事件流断开（离开该页）时清掉它的镜像：再进来以 SSE 回放为准，不显示过期值 */
function dropAgentOptions(pageId: string): void {
  const prefix = optionsKey(pageId, '')
  for (const key of [...agentOptions.keys()]) if (key.startsWith(prefix)) agentOptions.delete(key)
  agentOptionsListeners.forEach((l) => l())
}

// ---------- 发送路径（聊天输入与斜杠命令共用） ----------

/** 上一条用户消息的调用配置（chip 值）：新消息默认继承，连问两条时不用每条重设。
 *  没有上一条就是空配置，走页面级默认。 */
function lastMessageConfig(doc: EditorView['state']['doc']): MessageConfig {
  let hit: MessageConfig = { agent: '', cwd: '', opts: {} }
  doc.forEach((node) => {
    if (node.type.name === 'user_message') hit = messageConfigOf(node)
  })
  return hit
}

/** 往主编辑器 Y.Doc 末尾追加用户消息块（user_message 节点，协作同步自然生效）。
 *  调用配置从上一条用户消息继承（见 lastMessageConfig）。
 *  聊天框对外给的是记号文字 `@[标题](page:<id>)` / `@[名字](agent:<id>)`（框里画的是 chip），这里在同一次
 *  事务里把记号升成 page_mention chip（与打开页 migrate pass / 源码模式同一逆路径），
 *  所以气泡和文档里画的都是 chip，不是那串语法。 */
/** images 是附件图片的地址（`/api/files/<id>`）：消息末尾一段图片，与文档模式在消息里粘贴的图同一形状（发送时作为图片块给模型，见 server turn.ts） */
export function appendUserMessage(view: EditorView, text: string, agent?: string, images: readonly string[] = []): void {
  const { schema } = view.state
  const para = (t: string) => schema.nodes.paragraph!.create(null, t ? schema.text(t) : null)
  const image = schema.nodes.image
  const pics = image && images.length > 0 ? [schema.nodes.paragraph!.create(null, images.map((src) => image.create({ src, alt: '', title: '' })))] : []
  const inherited = lastMessageConfig(view.state.doc)
  // 指定了另一个来源：旧来源的模型 / 思考 / 权限模式 id 对新来源没有意义，不继承；目录在同一台机器上才可能沿用，也一并不继承
  // （上一条没指定来源说明用的是页面默认，没有旧来源可言，其余配置照常继承）
  let cfg: MessageConfig = inherited
  if (agent !== undefined && agent !== inherited.agent) {
    cfg = inherited.agent ? { agent, cwd: '', opts: {} } : { ...inherited, agent }
  }
  const msg = schema.nodes.user_message!.create(
    { agent: cfg.agent, cwd: cfg.cwd, opts: encodeOpts(cfg.opts), author: selfId() },
    [...(text || !pics.length ? text.split('\n').map(para) : []), ...pics],
  )
  const tr = view.state.tr.insert(view.state.doc.content.size, msg)
  upgradeMentions(tr)
  view.dispatch(tr)
}

/** 追加消息 + 触发 agent 继续；POST 失败（404 等）静默，文档消息已落，agent 层可缺 */
export function sendAgentMessage(view: EditorView, pageId: string, text: string, agent: string): void {
  appendUserMessage(view, text)
  runAgent(pageId, agent)
}

// ---------- 审批卡的宿主登记 ----------
// 运行中的审批卡画在运行条里（run-strip.ts），属于那条运行。只要有运行条在承接审批，底部弹条就不再画；
// 没有（源码模式、后台审批比一轮活得久、运行条宿主没建成）时底部弹条兜底，保证一直等不会变成没人看得见。
// 运行条在运行未结束期间登记、结束或销毁时注销；弹条据此显隐（模块级计数 + 订阅）。

let approvalHosts = 0
const approvalHostListeners = new Set<() => void>()

/** 登记一个承接审批的运行条；返回注销函数（幂等） */
export function registerApprovalHost(): () => void {
  approvalHosts++
  approvalHostListeners.forEach((l) => l())
  let done = false
  return () => {
    if (done) return
    done = true
    approvalHosts--
    approvalHostListeners.forEach((l) => l())
  }
}

function useApprovalHosted(): boolean {
  const [hosted, setHosted] = useState(approvalHosts > 0)
  useEffect(() => {
    const listener = () => setHosted(approvalHosts > 0)
    approvalHostListeners.add(listener)
    listener()
    return () => {
      approvalHostListeners.delete(listener)
    }
  }, [])
  return hosted
}

// ---------- 审批弹条（兜底；多条排队，只展示队首） ----------

/** 提问（带 form 的审批）：表单是运行条那一份 DOM（ask-form.ts），挂在这里。换了一条提问（req 身份变了）才重建 */
function AskBar({ pageId, req }: { pageId: string; req: PermissionReq & { form: AskForm } }) {
  const host = useRef<HTMLDivElement>(null)
  const { agentId, requestId, form } = req
  useEffect(() => {
    const node = host.current
    if (!node) return
    node.replaceChildren(mountAsk(pageId, { agentId, requestId, form }, setAgentRunError).el)
    return () => node.replaceChildren()
  }, [pageId, agentId, requestId, form])
  return (
    <div className="agent-permission is-form">
      <span className="agent-permission-title" title={req.title}>
        {req.title || COPY.ask.form.title}
      </span>
      <div className="agent-permission-form" ref={host} />
    </div>
  )
}

function PermissionBar({ req, onAnswer }: { req: PermissionReq; onAnswer: (optionId: string) => void }) {
  return (
    <div className="agent-permission">
      <span className="agent-permission-title" title={req.title}>
        {req.title || 'Agent 请求权限'}
      </span>
      <span className="agent-permission-actions">
        {req.options.map((opt) => (
          <button key={opt.optionId} className="btn-agent-option" onClick={() => onAnswer(opt.optionId)}>
            {opt.name}
          </button>
        ))}
      </span>
    </div>
  )
}

// ---------- agent 面板：审批弹条（双模式共用） ----------
// 控制条（agent / 模型 / 思考程度 / 发送停止）在聊天模式的输入卡里（chat-view.tsx 的 composer），
// 文档模式是纯编辑视图。审批弹条不受模式限制：请求可能由别的协作者 / 别的模式发起，权限不能没人能批。

export function AgentPanel({ pageId, state }: { pageId: string; state: AgentState }) {
  const hosted = useApprovalHosted()
  // 队列就是待批审批本身：答完不本地摘除，等 permission_resolved（唯一移除信号）
  const current = state.permissions[0]
  if (!current || hosted) return null
  if (current.form) {
    return (
      <div className="agent-panel">
        <AskBar pageId={pageId} req={{ ...current, form: current.form }} />
      </div>
    )
  }

  return (
    <div className="agent-panel">
      <PermissionBar
        req={current}
        onAnswer={(optionId) => {
          void api.respondPermission(pageId, current.agentId, current.requestId, optionId).catch((err: unknown) => {
            // 404 是审批已经结束（resolved 事件会摘掉它），静默；403 / 409 要给用户理由
            if (err instanceof ApiError && err.status === 404) return
            setAgentRunError(err instanceof Error ? err.message : '审批失败')
          })
        }}
      />
    </div>
  )
}
