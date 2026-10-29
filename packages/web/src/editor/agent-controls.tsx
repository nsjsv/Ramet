// ---------- agent 控制项的状态与写入（来源 / 工作目录 / 模型 / 思考 / 权限模式） ----------
// 聊天输入卡与文档模式共用 ChipBar（chip-bar.tsx，受控组件）；本模块是对话宿主的状态来源，
// 谁在跑、跑哪个模型、跑在哪个目录的事实源与写入路径只有一处：
//   - 会话配置项（模型 / 思考 / 权限模式）来自 agent SSE 的 config 事件，写入 POST /agent-config
//   - 工作目录来自 cwd 事件，写入 POST /agent-cwd，目录浏览由执行端回答（workspace-panel）
//   - 来源按页记住（choice 事件 / POST /agent-choice）：在这页选来源、设模型 / 目录、发消息都会把当时的来源
//     记成本页的，没记过的页回落全局默认。否则别的页一换来源，这页刷新后来源跟着变，
//     按来源分存的模型和目录看起来全变了
// 文档模式的值在消息节点 attrs 里（message-chips.tsx），不经这里。

import { useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import { setDefaultAgent, agentList } from '../default-agent'
import { agentOptionsFor, setAgentRunError, setPageChoice, usePageAgent, type AgentState } from './agent-bar'
import { modeOptionOf, nextModeValue } from './agent-mode'

export interface AgentControls {
  /** 实际会用的来源（已过 pickAgent 回落；目录为空 = ''） */
  agent: string
  setAgent: (id: string) => void
  /** 已提交未确认的会话配置覆盖值（本地立刻回显，SSE 收敛） */
  opts: Record<string, string>
  changeOpt: (configId: string, value: string) => void
  /** 生效工作目录（按 agent 分存；空串 = 还没问过 = 执行端默认） */
  cwd: string
  applyCwd: (cwd: string) => Promise<void>
  /** 把当前来源记成本页的（发送时调：用过的来源就是这页的来源） */
  pin: () => void
  running: boolean
}

// ---------- 预备会话（prepare） ----------
// 模型 / 思考程度来自 agent 的会话，不是页面数据，不 prepare 就没有 config 事件，
// 文档模式的消息 chip 就只剩来源和路径。所以准备动作挂在「消费者看到 agent 就执行」这一个入口上，
// 输入卡控制行和消息 chip 共用，不能各写一份（文档模式下没有输入卡，两份必然漂移）。
// 已问过的 agent 记在模块级表：SSE 重连、换视图都不重复打扰 agent；失败也不再重试（避免刷屏），改工作区时删键以重问。
/** 已请求过预备会话的 (页码, agent)。key 必须含 pageId：会话配置项按页面存活，页 A 的答案不能当页 B 的用。 */
const asked = new Set<string>()

/** 预备 (页面, agent) 的会话，是唯一入口：消费方看到某个 agent 就调它（消息 chip 切换来源时也调），
 *  保证显示谁就问过谁。 */
export function askAgent(pageId: string | undefined, agent: string): void {
  if (!pageId || !agent) return
  // 不在目录里的 agent（connector 被撤销、消息 attrs 里的失效来源）不要 prepare：必然 400，
  // 只会往运行错误条里灌一条用户无法处理的 unknown agent。收敛失效值是 chip 的 repairStaleAgent 的职责。
  if (!agentList().some((a) => a.id === agent)) return
  const key = `${pageId}:${agent}`
  if (asked.has(key) || agentOptionsFor(pageId, agent).length > 0) return
  asked.add(key)
  // 预备会话是分钟级冷启动（claude 的 npx 适配器 >120s），服务端立即返回 202，失败经 SSE 的 error 事件告知。
  // 所以这里的 catch 只会是网络层 / HTTP 层的即时错误，只记录并允许重试，不当成这个 agent 不可用；
  // 真正的准备失败由 SSE 的 error 事件进运行错误条（agent-bar 的 case 'error'）。
  void api.prepareAgent(pageId, agent).catch((err: unknown) => {
    // 403 = 这台机器不属于你也没授权给你（服务端 message 是人话）：给用户看，且不重试，
    // 重试只会再被拒；授权下来后目录变化或刷新页面会重新问
    if (err instanceof ApiError && err.status === 403) {
      setAgentRunError(err.message)
      return
    }
    asked.delete(key) // 允许重试（例如刚才是网络抖动）
    console.warn(`准备 agent「${agent}」失败：`, err instanceof Error ? err.message : err)
  })
}

/** 文档模式用它：那里没有控制行，但同样要保证显示的 agent 问过会话，否则消息 chip 的模型 / 思考不出来 */
export function usePrepareAgent(pageId: string | undefined, agentState: AgentState, readOnly: boolean): void {
  const { agent, ready } = usePageAgent(pageId)
  // 本页已收到过这个 agent 的 config 事件 = 会话就绪，不用再问；否则问一次（askAgent 内部去重）
  if (readOnly || !ready || !agent || agent in agentState.configs) return
  askAgent(pageId, agent)
}

/** 改 agent 会话配置项（模型 / 思考 / 权限模式）的唯一写入：POST /agent-config，权限由服务端校验
 *  （非机器主人进「跳过全部确认」档会 403）。失败把服务端给的原因放进运行错误条，返回是否成功。
 *  对话宿主（useAgentControls.changeOpt）与文档 `>>` 草稿里的 ⇧Tab（mode-keys.ts）共用。 */
export function writeSessionOption(pageId: string, agent: string, configId: string, value: string): Promise<boolean> {
  const name = agentOptionsFor(pageId, agent).find((o) => o.id === configId)?.name ?? configId
  return api.setAgentConfig(pageId, { agent, configId, value }).then(
    () => {
      setAgentRunError(null)
      return true
    },
    (err: unknown) => {
      setAgentRunError(err instanceof Error ? `切换「${name}」失败：${err.message}` : `切换「${name}」失败`)
      return false
    },
  )
}

/** ⇧Tab 的下一步：权限模式切到下一档（agent 上报的顺序，跳过「跳过全部确认」档）。
 *  pending 是已提交未确认的值（configId 到 value）：连按几次时从上一次的目标接着转，不用等服务端推回来。
 *  返回 null 表示这个键不该生效（agent 不在目录里、表外 agent 的 mode 不可改、没有 mode 项、可转的档位不足两个） */
export function nextModeStep(
  pageId: string,
  agent: string,
  pending: Readonly<Record<string, string>> = {},
): { configId: string; value: string } | null {
  const posture = agentList().find((a) => a.id === agent)?.posture
  if (!posture?.modes) return null
  const option = modeOptionOf(agentOptionsFor(pageId, agent))
  if (!option) return null
  const value = nextModeValue(option, pending[option.id] ?? option.currentValue, posture.unrestricted)
  return value === null ? null : { configId: option.id, value }
}

/** 对话宿主的控件状态：列表回落、默认值持久化、预备会话、配置写入、工作目录改绑。
 *  pageId 可为 undefined（Editor 换页的窗口期）：此时不预备会话、写入路径是 no-op（Hooks 必须无条件调用）。 */
export function useAgentControls(pageId: string, agentState: AgentState, readOnly: boolean): AgentControls {
  // 本页记住的、全局默认、目录第一个，依次回落（失效 id 跳过，见 pageAgent）
  const { agent, ready } = usePageAgent(pageId)
  // cwd 按 agent 分存；还没 prepare 过是空串，chip 显示占位
  const cwd = agentState.cwds[agent] ?? ''
  const running = agentState.status === 'running'
  // 已提交但还没收到服务端新状态的选项值：立即回显用户的选择，失败或确认后由 SSE 收敛
  const [pending, setPending] = useState<Record<string, string>>({})
  useEffect(() => {
    setPending({})
  }, [agentState.configs])

  // 选中 agent 就预备会话，模型 / 思考程度不用先发一条消息才出现。
  // 要等本页记住的来源到了再问，否则刷新时会先按全局默认冷启动一个用不上的 agent
  if (!readOnly && ready) askAgent(pageId, agent)

  const pin = (id = agent) => {
    if (pageId) setPageChoice(pageId, id)
  }

  /** 换来源：记成本页的，也作为新页面的默认（全局默认是最近一次选的） */
  function setAgent(id: string) {
    pin(id)
    setDefaultAgent(id)
  }

  /** 改绑工作目录：落库成功后立刻按新目录预备会话。旧会话在别的目录已作废，模型 / 思考程度等配置项
   *  要按新会话重问；目录不可用会在 session/new 被顶回来，进运行错误条，不会变成点了没反应 */
  function applyCwd(next: string): Promise<void> {
    if (!pageId) return Promise.resolve()
    pin()
    return api.setAgentCwd(pageId, { agent, cwd: next }).then(async () => {
      // 清掉标记，让随后的 prepare 真的重问（askAgent 里有短路）
      asked.delete(`${pageId}:${agent}`)
      try {
        await api.prepareAgent(pageId, agent)
      } catch (err) {
        setAgentRunError(err instanceof Error ? `工作区不可用：${err.message}` : '工作区不可用')
      }
    })
  }

  /** 切会话配置项（模型 / 思考 / 权限模式）：改的是 agent 侧的会话，界面等 SSE 推回新状态才对账 */
  function changeOpt(configId: string, value: string) {
    if (!pageId) return
    pin()
    setPending((prev) => ({ ...prev, [configId]: value }))
    void writeSessionOption(pageId, agent, configId, value).then((ok) => {
      if (ok) return
      // 服务端没改成功（例如非主人选了危险档）：撤掉本地回显，选择器落回会话里的真实值
      setPending((prev) => {
        const next = { ...prev }
        delete next[configId]
        return next
      })
    })
  }

  return { agent, setAgent, opts: pending, changeOpt, cwd, applyCwd, pin: () => pin(), running }
}
