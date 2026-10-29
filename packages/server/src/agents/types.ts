// ---------- agent 适配层类型（server 内部窄接口） ----------

/** ACP prompt 的内容块:文本 / 内嵌资源(引用页展开) / 图片(这一轮那条用户消息里的图,base64)。
 *  图片只发给在 initialize 里声明了 promptCapabilities.image 的 agent:执行端(AcpAgent.prompt)不支持就丢掉 */
export type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'resource'; uri: string; mimeType: string; text: string; title: string }
  | { type: 'image'; mimeType: string; data: string }

export type PermissionOption = { optionId: string; name: string; kind?: string }

/** 提问表单：ACP `elicitation/create`（form 模式）的 requestedSchema 经执行端归一（ask-form.ts）。
 *  只认 ACP 标准，各家（claude / codex / opencode / omp）的形状都落在这几类字段里；前端 web/src/api.ts 同口径一份 */
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

/** ACP session config option，只保留 select 变体（boolean 变体在适配层丢弃） */
export type ConfigOption = {
  id: string
  name: string
  /** 'model' | 'thought_level' | 'mode' | 'model_config' | 其它（UX 分类，前端按它选摆放） */
  category?: string | null
  currentValue: string
  options: ConfigOptionValue[]
}

import type { PlanEntry, RunEvent, RunInfo, RunState, StepKind, StepStatus, TeamPlanView, TurnUsage } from '@ramet/shared/run-model'
import type { PageTool } from '../page-read.js'
import type { QueueView } from './send-queue.js'
import type { ToolProfile } from './tool-profile.js'

/** 工具调用步骤与 run 过程模型的唯一形状在共享包(前端 store 用同一个 reducer) */
export type { Step, StepDelta, StepKind, StepStatus, TurnUsage } from '@ramet/shared/run-model'
export { MAX_RUN_STEPS } from '@ramet/shared/run-model'

/** agent 报的本轮用量(ACP PromptResponse.usage;UNSTABLE 字段,没报就是 undefined),形状在共享包 */
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
  /** toolCall 是原始请求载荷（ACP request_permission 的 toolCall：title/kind/rawInput/…），
   *  按需展开；fs 写闸门的文件内容属于客户端数据，不进事件。
   *  agentId 由中心会话镜像在广播时盖章（适配器自己只知道 sessionId；requestId 只在单个进程内唯一，
   *  前端按 agentId + requestId 认同一条） */
  /** form 表示这是一条提问（ACP elicitation）：options 固定是提交（accept）/ 跳过（decline），答案随应答带 content */
  | { type: 'permission'; requestId: string; title: string; options: PermissionOption[]; toolCall?: Record<string, unknown>; form?: AskForm; sessionId?: string; agentId?: string }
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
      /** 原始 tool_call/tool_call_update 字段（sessionUpdate/toolCallId 已由 id/type 表达），增量合并 */
      acp?: Record<string, unknown>
      /** acp 命中体积上限被截断（可见标记） */
      truncated?: boolean
      sessionId?: string
    }
  /** ACP 终端（terminal/create…）里 agent 跑的命令：id 是绑定的工具步骤（toolCallId），delta 是新到的输出（合并过一小段时间的），
   *  exit 表示命令退出了（terminalId 一并带上，前端据此认停止这条命令），truncated 表示实时转发的输出超过上限被截了
   *  （命令自己的完整输出仍在执行端按 outputByteLimit 保留，agent 经 terminal/output 能取到）。RunRecord 据此发成品 `child`（terminal）与 `step` */
  | { type: 'terminal'; id: string; delta?: string; exit?: TerminalExit; truncated?: boolean; sessionId?: string }
  /** 实时附加信息（用量/上下文/stopReason/ACP 元数据）：折进 RunState.info，按字段合并 */
  | { type: 'info'; info: RunInfo; sessionId?: string }
  /** agent 的计划清单（ACP plan 更新，整份替换；适配层已归一）：RunRecord 据此发成品 `plan`（RunEvent） */
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

/** agent 原生斜杠命令（ACP available_commands_update） */
/** input 是命令要参数时的提示文案（ACP available_commands_update 的 input.hint）；null / 缺省表示不带参数 */
export type AgentCommand = { name: string; description?: string | null; input?: string | null }

export type PermissionEvent = Extract<AgentEvent, { type: 'permission' }>

/** ACP 终端命令的退出状态（terminal/wait_for_exit）。exitCode / signal 至多一个有值 */
export type TerminalExit = { terminalId: string; exitCode: number | null; signal: string | null }

/** 会话级状态：执行端（持有 ACP 连接的进程）是唯一事实源，不论有没有监听者都缓存。
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

export type AgentConfig = {
  id: string
  label: string
  command: string
  args?: string[]
  env?: Record<string, string>
  /** 前端 logo 名 */
  logo?: string
}

/** 单 agent 适配器:一个实例持有一个子进程,可承载多个 session */
export interface AgentAdapter {
  /** 已 spawn 且 initialize 完成 */
  ready(): Promise<void>
  /** tools = 中心交给 AI 的能力（跨机只有凭证/地址；命令由执行端拼，见 page-read.ts） */
  newSession(cwd: string, tools?: PageTool[]): Promise<{ sessionId: string; configOptions: ConfigOption[] }>
  loadSession(sessionId: string, cwd: string, tools?: PageTool[]): Promise<{ configOptions: ConfigOption[] }>
  setConfigOption(sessionId: string, configId: string, value: string): Promise<ConfigOption[]>
  prompt(sessionId: string, blocks: PromptBlock[], runId?: string): Promise<PromptResult>
  cancel(sessionId: string): void
  /** 停止这个会话里 agent 用 ACP 终端跑的一条命令（terminal/kill）。终端不存在 / 不属于这个会话 / 已经退出时返回 false。
   *  和 cancel 一样不要机器使用凭据：只会让机器停下来；谁能停由页面写权限决定 */
  killCommand(sessionId: string, terminalId: string): boolean
  /** 应答审批;optionId 为 null 表示取消/拒绝。content 是提问的答案（只对带 form 的审批有意义，中心已校验过）。
   *  返回是否已交给执行端（远端 connector 不在线返回 false，审批留着以后可以再答）；审批的移除只由 permission_resolved 驱动 */
  respondPermission(requestId: string, optionId: string | null, content?: AskContent): boolean
  /** 该会话在执行端缓存的会话级状态。只读：不允许因此发起 ACP 请求 */
  sessionState(sessionId: string): SessionState
  on(listener: (ev: AgentEvent) => void): () => void
  /** 有在飞工作或有待批审批，是闲置回收的唯一判据：一个长轮次全程只发事件、不发请求，
   *  只按最后一次请求计时会在中途把在飞轮次 SIGTERM 掉（用户看到已停止）；
   *  待批审批期间回收会让审批永远答不到。两端（中心/connector）都读它决定回收还是续期，见 agents/idle.ts */
  busy: boolean
  /** 杀掉子进程(闲置回收/server 关停) */
  kill(): void
}
