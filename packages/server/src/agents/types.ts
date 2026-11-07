// ---------- agent 适配层类型（server 内部窄接口） ----------

/** prompt 的内容块：文本 / 内嵌资源（引用页展开）/ 图片（这一轮那条用户消息里的图，base64）。
 *  各驱动按自家协议翻译（claude 的用户消息内容块、codex 的 input 条目、pi / omp 的 images） */
export type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'resource'; uri: string; mimeType: string; text: string; title: string }
  | { type: 'image'; mimeType: string; data: string }

export type PermissionOption = { optionId: string; name: string; kind?: string }

/** 提问表单：各驱动把自家的提问（claude 的 AskUserQuestion、codex 的 requestUserInput、omp 的 ask、MCP elicitation）
 *  归一成这一个形状（MCP 的 requestedSchema 经 ask-form.ts）；前端 web/src/api.ts 同口径一份 */
export type AskOption = { value: string; label: string; description?: string }
export type AskField = { key: string; title?: string; description?: string } & (
  | { kind: 'choice'; options: AskOption[]; multi: boolean; min?: number; max?: number; default?: string | string[] }
  | {
      kind: 'text'
      format?: 'email' | 'uri' | 'date' | 'date-time'
      minLength?: number
      maxLength?: number
      pattern?: string
      default?: string
      /** 密码类输入（codex 的 `_meta.codex.isSecret`）：值绝不进步骤文字 / 审计 / 日志 */
      secret?: boolean
    }
  | { kind: 'number'; integer: boolean; min?: number; max?: number; default?: number }
  | { kind: 'boolean'; default?: boolean }
)
/** toolCallId 是提问挂在哪一步工具调用上（有就把问题和答案写进那一步的 activity） */
export type AskForm = { message: string; fields: AskField[]; required: string[]; toolCallId?: string }
export type AskValue = string | number | boolean | string[]
export type AskContent = Record<string, AskValue>

export type ConfigOptionValue = { value: string; name: string; description?: string | null }

/** 会话配置项（模型 / 思考档 / 模式…），只有单选一种形状 */
export type ConfigOption = {
  id: string
  name: string
  /** 'model' | 'thought_level' | 'mode' | 'model_config' | 其它（UX 分类，前端按它选摆放） */
  category?: string | null
  currentValue: string
  options: ConfigOptionValue[]
}

import type { PlanEntry, RunEvent, RunInfo, RunState, StepKind, StepStatus, TeamPlanView, ToolView, TurnUsage } from '@ramet/shared/run-model'
import type { PageTool } from '../page-read.js'
import type { QueueView } from './send-queue.js'
import type { ToolProfile } from './tool-profile.js'

/** 工具调用步骤与 run 过程模型的唯一形状在共享包(前端 store 用同一个 reducer) */
export type { Step, StepDelta, StepKind, StepStatus, TurnUsage } from '@ramet/shared/run-model'
export { MAX_RUN_STEPS } from '@ramet/shared/run-model'

/** 一轮的结局与 agent 报的本轮用量（没报就是 undefined），形状在共享包 */
export type PromptResult = { stopReason: string; usage?: TurnUsage }

/** 统一事件模型(适配器事件 + SSE 原样转发给前端;status 由 Manager 生成)
 * sessionId 是事件归属(同一适配器进程可能承载多个会话;connector 经 WSS 中继时按它路由
 * 到对应请求,Omit 时视为当前唯一会话)。前端不依赖该字段。
 *
 * 过程有两段形状,别混:
 *   - `text` / `thought` / `tool` / `usage` / `info` / `plan` 是适配器到 Manager 的原料(tool 的字段可缺,
 *     合并成完整 Step、判定换段、合批都是 RunRecord 的职责)
 *   - `run`(快照)/ `reply` / `think` / `said` / `step` / `plan` 是 Manager 到前端的成品(同名 `info` / `plan` 多一个时间 t),
 *     前端用共享 reducer(applyRunEvent)照做 */
export type AgentEvent =
  | { type: 'status'; state: 'idle' | 'running' | 'done' | 'error'; message?: string; runPageId?: string }
  | { type: 'text'; delta: string; sessionId?: string; parentId?: string }
  | { type: 'thought'; delta: string; sessionId?: string; parentId?: string }
  | { type: 'usage'; used: number; size: number; cost?: { amount: number; currency: string }; _meta?: unknown; sessionId?: string }
  | { type: 'done'; message?: string }
  /** 失败原因。replyId 是这次失败所属的回复块（本轮已经开了占位块）：前端把原因放进那块的失败条；
   *  没有就是没有块可挂（预备会话 / 配置失败、占位块开不出来），前端才落到页面顶部的运行错误条。 */
  | { type: 'error'; message: string; replyId?: string }
  /** toolCall：原生驱动只放 {toolCallId, title, kind}（详情在 view）；老 connector 经 ACP 发来的是 agent 原样给的一大包，照收。
   *  agentId 由中心会话镜像在广播时盖章（适配器自己只知道 sessionId；requestId 只在单个进程内唯一，
   *  前端按 agentId + requestId 认同一条） */
  /** form 表示这是一条提问：options 固定是提交（accept）/ 跳过（decline），答案随应答带 content */
  /** view 是这次要批的工具调用的中性视图（审批卡的命令 / diff 预览优先读它，没有再从 toolCall 推） */
  /** defaultToNo：agent 要求这条审批不能一键批准（拒绝排在选项最前，主按钮落在拒绝上） */
  /** only：只给这个人看、只认这个人答（Ramet 自己的审批：规则替主人开跑、外来事件之后 Genet 动手，批的是主人自己的事）；没有 = 页面上能答的人都看得到 */
  | { type: 'permission'; requestId: string; title: string; options: PermissionOption[]; toolCall?: Record<string, unknown>; view?: ToolView; form?: AskForm; defaultToNo?: boolean; sessionId?: string; agentId?: string; only?: string }
  /** 一条审批结束（有人答 / 停止该会话 / 会话被换掉 / 进程退出 / connector 终态断开）。移除审批的唯一信号 */
  | { type: 'permission_resolved'; requestId: string; sessionId?: string; agentId?: string }
  | { type: 'commands'; list: AgentCommand[]; sessionId?: string; agentId?: string }
  | { type: 'config'; agentId?: string; options: ConfigOption[]; sessionId?: string }
  /** 生效工作区（用户指定值或执行端默认）：prepare 与改绑端点都会广播。
   *  cwd 按 agent 分存：同一页面可以有不同的 agent（不同机器）各用各的目录 */
  | { type: 'cwd'; agentId: string; cwd: string }
  /** 本页记住的来源（agent_session.choice，'' 表示没有）：SSE 首帧 + 改选时广播 */
  | { type: 'choice'; agentId: string }
  /** 本页的工具档位（agent_session.tools，tool-profile.ts）：SSE 首帧 + 改档时广播 */
  | { type: 'tool_profile'; profile: ToolProfile }
  /** 本页锁定的工具（第一块回复的工具名，'' = 还没有回复、不锁）：SSE 首帧 + 第一块回复的占位块建好时广播 */
  | { type: 'tool_lock'; tool: string }
  | {
      type: 'tool'
      id: string
      kind?: StepKind
      title?: string
      status?: StepStatus
      detail?: string
      note?: string
      /** 这一步是哪次子代理调用里的 */
      parentId?: string
      /** 这一步现在在做什么。有值就替换，缺省保持上一次 */
      activity?: string
      /** 原样载荷，增量合并。原生驱动不写工具载荷（详情在 view）；老 connector 经 ACP 发来的照收，
       *  run_agent 的留痕（subRun）与审批记录（permission）也放这里 */
      acp?: Record<string, unknown>
      /** 中性步骤视图的增量（按字段合并，见 shared 的 mergeView） */
      view?: ToolView
      /** acp 命中体积上限被截断（可见标记） */
      truncated?: boolean
      sessionId?: string
    }
  /** agent 跑的命令的实时输出：id 是那一步（toolCallId），delta 是新到的输出（增量）。
   *  exit / truncated 只有老 connector 经 ACP 终端跑命令时才发（原生驱动的退出码在步骤 view 里），照收。
   *  RunRecord 据此发成品 `child`（terminal）与 `step` */
  | { type: 'terminal'; id: string; delta?: string; exit?: TerminalExit; truncated?: boolean; sessionId?: string }
  /** 实时附加信息（用量/上下文/stopReason/agent 原样元数据）：折进 RunState.info，按字段合并 */
  | { type: 'info'; info: RunInfo; sessionId?: string }
  /** agent 的计划清单（整份替换；驱动已归一）：RunRecord 据此发成品 `plan`（RunEvent） */
  | { type: 'plan'; entries: PlanEntry[]; truncated?: boolean; sessionId?: string }
  /** 带队计划变了（提交 / 发起人改 / 取消 / 开工 / 收尾）：整份视图。广播给页面所有订阅者（不带因人而异的字段，`mine` 只在 GET 里）；
   *  前端的计划卡据此更新，收件箱里等待批计划的条目也跟着重拉 */
  | { type: 'team_plan'; plan: TeamPlanView }
  /** 排队发送（send-queue.ts）：整份排队区（谁排的、摘要、是否暂停）；SSE 首帧回放、变化时广播 */
  | { type: 'queue'; items: QueueView[]; paused: boolean }
  /** 一条排着的消息派发时被丢掉（排的人失权 / agent 不在了）：前端把原因给排的人看 */
  | { type: 'queue_dropped'; id: string; reason: string }
  /** 运行开始与新订阅者的快照:replyId 是文档里正在写的那个占位块,at 是快照时刻(相对本轮开始),
   *  agent 是跑这一轮的 agent（catalog id；右上角岛据此画头像，运行中的回复块还没收尾，前端不从文档里猜） */
  | { type: 'run'; replyId: string; at: number; state: RunState; agent?: string }
  | RunEvent

/** agent 原生斜杠命令。input 是命令要参数时的提示文案；null / 缺省表示不带参数 */
export type AgentCommand = { name: string; description?: string | null; input?: string | null }

export type PermissionEvent = Extract<AgentEvent, { type: 'permission' }>

/** 老 connector 的 ACP 终端命令的退出状态。exitCode / signal 至多一个有值 */
export type TerminalExit = { terminalId: string; exitCode: number | null; signal: string | null }

/** 会话级状态：执行端（持有 agent 进程的驱动）是唯一事实源，不论有没有监听者都缓存。
 *  中心的会话镜像只是它的投影（每个绑定点用快照播种，之后吃下面这些事件的增量）。 */
export type SessionState = {
  commands: AgentCommand[]
  /** 没加载过/未知 = 空数组 */
  configs: ConfigOption[]
  /** 该会话待批的完整 permission 事件 */
  approvals: PermissionEvent[]
}

/** 会话级事件：归会话、不归某一轮。只有这四种，轮次监听（turn.ts）只投影 RunRecord，
 *  connector 的 prompt 帧也只转发轮次事件。 */
export type SessionEvent = Extract<AgentEvent, { type: 'commands' | 'config' | 'permission' | 'permission_resolved' }>

export function isSessionEvent(ev: AgentEvent): ev is SessionEvent {
  return ev.type === 'commands' || ev.type === 'config' || ev.type === 'permission' || ev.type === 'permission_resolved'
}

/** 用哪个驱动跟这个 agent 说话（drivers/create.ts 分派）。配置里必须写（registry.ts 校验） */
export type AgentDriver = 'claude' | 'codex' | 'pi' | 'omp'
export const AGENT_DRIVERS: readonly AgentDriver[] = ['claude', 'codex', 'pi', 'omp']

export type AgentConfig = {
  id: string
  label: string
  command: string
  args?: string[]
  env?: Record<string, string>
  /** 前端 logo 名 */
  logo?: string
  driver: AgentDriver
  /** 探版本用的 CLI 可执行文件，缺省就是 command（command 是包装脚本时才要写） */
  cli?: string
}

/** 单 agent 适配器：一个实例承载这个 agent 的多个会话（进程是共享还是每会话一个由驱动定） */
export interface AgentAdapter {
  /** 已 spawn 且 initialize 完成 */
  ready(): Promise<void>
  /** tools = 中心交给 AI 的能力（跨机只有凭证/地址；命令由执行端拼，见 page-read.ts） */
  newSession(cwd: string, tools?: PageTool[]): Promise<{ sessionId: string; configOptions: ConfigOption[] }>
  loadSession(sessionId: string, cwd: string, tools?: PageTool[]): Promise<{ configOptions: ConfigOption[] }>
  setConfigOption(sessionId: string, configId: string, value: string): Promise<ConfigOption[]>
  prompt(sessionId: string, blocks: PromptBlock[], runId?: string): Promise<PromptResult>
  cancel(sessionId: string): void
  /** 停止这个会话里一个可停的东西（步骤 view.handle：子代理；老 connector 上是 ACP 终端的 terminalId）。
   *  句柄不存在 / 不属于这个会话 / 已经结束时返回 false。
   *  和 cancel 一样不要机器使用凭据：只会让机器停下来；谁能停由页面写权限决定 */
  killCommand(sessionId: string, handle: string): boolean
  /** 应答审批;optionId 为 null 表示取消/拒绝。content 是提问的答案（只对带 form 的审批有意义，中心已校验过）。
   *  返回是否已交给执行端（远端 connector 不在线返回 false，审批留着以后可以再答）；审批的移除只由 permission_resolved 驱动 */
  respondPermission(requestId: string, optionId: string | null, content?: AskContent): boolean
  /** 该会话在执行端缓存的会话级状态。只读：不允许因此向 agent 发请求 */
  sessionState(sessionId: string): SessionState
  on(listener: (ev: AgentEvent) => void): () => void
  /** 有在飞工作或有待批审批，是闲置回收的唯一判据：一个长轮次全程只发事件、不发请求，
   *  只按最后一次请求计时会在中途把在飞轮次 SIGTERM 掉（用户看到已停止）；
   *  待批审批期间回收会让审批永远答不到。两端（中心/connector）都读它决定回收还是续期，见 agents/idle.ts */
  busy: boolean
  /** 彻底放掉这个会话在执行端的状态，之后 loadSession 一定重新从磁盘读（换机器把会话记录写进来之前先调）。
   *  远端是 session-close 帧：machine 范围，要用 machine 范围的凭据签出的视图 */
  closeSession(sessionId: string): Promise<void>
  /** 杀掉子进程(闲置回收/server 关停) */
  kill(): void
}
