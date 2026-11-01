// ---------- codex app-server 协议类型（手工裁剪） ----------
// 来源：codex-cli 0.159.3 自带的生成器（实验字段一并导出）：
//   node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex app-server generate-ts --experimental --out <目录>
// 只留驱动用得到的方法、条目与字段；用不到的字段不写（多出来的字段照样能收到，类型里不声明而已）。
// 整份生成物有八百多个文件，提交进来等于背一份不会读的协议，升级 Codex 时按上面的命令重新导出、逐项核对这里。
//
// 线上格式（实测）：一行一个 JSON，不带 "jsonrpc" 字段；请求 {id, method, params}，应答 {id, result} / {id, error}，
// 通知 {method, params, emittedAtMs}。服务端请求（要我们应答）与客户端请求同形。

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type RequestId = string | number

// ---------- 握手 ----------

export type InitializeParams = {
  clientInfo: { name: string; title: string | null; version: string }
  capabilities: {
    /** 打开实验方法与字段：`thread/resume.path`、`item/tool/requestUserInput` 都要它 */
    experimentalApi: boolean
    requestAttestation: boolean
    optOutNotificationMethods?: string[] | null
  } | null
}
export type InitializeResponse = { userAgent: string; codexHome: string; platformFamily: string; platformOs: string }

// ---------- 设置 ----------

export type AskForApproval =
  | 'untrusted'
  | 'on-request'
  | 'never'
  | { granular: { sandbox_approval: boolean; rules: boolean; skill_approval: boolean; request_permissions: boolean; mcp_elicitations: boolean } }
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'externalSandbox'; networkAccess: unknown }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean }
/** 档位名由模型自己给（low / medium / high / xhigh / max / ultra …），不是固定枚举 */
export type ReasoningEffort = string

/** `thread/start` / `thread/resume` 的 config 覆盖里一个 stdio MCP 服务（按线程生效，深合并进用户配置） */
export type McpServerConfig = { command: string; args: string[]; env: Record<string, string>; enabled?: boolean } | { enabled: false }

// ---------- 线程 ----------

export type ThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: Array<'waitingOnApproval' | 'waitingOnUserInput'> }

export type Thread = {
  id: string
  /** 子代理线程指向生成它的线程 */
  parentThreadId: string | null
  status: ThreadStatus
  /** rollout 文件（会话记录）路径。没有任何轮次的线程还没落盘，文件可能不存在 */
  path: string | null
  cwd: string
  model: string | null
  reasoningEffort: ReasoningEffort | null
  cliVersion: string
  agentNickname: string | null
  agentRole: string | null
  turns: Turn[]
}

type ThreadSettingsFields = {
  model?: string | null
  cwd?: string | null
  approvalPolicy?: AskForApproval | null
  sandbox?: SandboxMode | null
  /** 键是 config.toml 的路径（如 `mcp_servers`），深合并进用户配置，只对这个线程生效 */
  config?: Record<string, JsonValue> | null
  developerInstructions?: string | null
}

export type ThreadStartParams = ThreadSettingsFields & {
  /** 空数组 = 这个线程不给环境访问（没有 turn 级覆盖的轮次都不给） */
  environments?: unknown[] | null
  ephemeral?: boolean | null
}

export type ThreadResumeParams = ThreadSettingsFields & {
  threadId: string
  /** [实验] 按 rollout 文件恢复；线程没在跑时忽略 threadId */
  path?: string | null
  /** 只要元数据，不拉全量历史 */
  excludeTurns?: boolean
}

/** start / resume 的应答（两者同形，只列用到的） */
export type ThreadOpenResponse = {
  thread: Thread
  model: string
  modelProvider: string
  cwd: string
  approvalPolicy: AskForApproval
  sandbox: SandboxPolicy
  reasoningEffort: ReasoningEffort | null
}

export type ThreadReadParams = { threadId: string; includeTurns?: boolean }
export type ThreadReadResponse = { thread: Thread }

export type ThreadUnsubscribeParams = { threadId: string }
export type ThreadUnsubscribeResponse = { status: 'notLoaded' | 'notSubscribed' | 'unsubscribed' }

// ---------- 回合 ----------

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress'
export type TurnError = { message: string; codexErrorInfo: unknown; additionalDetails: string | null }
export type Turn = {
  id: string
  items: ThreadItem[]
  status: TurnStatus
  error: TurnError | null
  startedAt: number | null
  completedAt: number | null
  durationMs: number | null
}

export type UserInput =
  | { type: 'text'; text: string; text_elements: unknown[] }
  | { type: 'image'; url: string; detail?: 'auto' | 'low' | 'high' | 'original' }
  | { type: 'localImage'; path: string }

/** turn 级覆盖对之后的回合持续生效（app-server 的语义） */
export type TurnStartParams = {
  threadId: string
  input: UserInput[]
  cwd?: string | null
  approvalPolicy?: AskForApproval | null
  sandboxPolicy?: SandboxPolicy | null
  model?: string | null
  effort?: ReasoningEffort | null
}
export type TurnStartResponse = { turn: Turn }

export type TurnInterruptParams = { threadId: string; turnId: string }
export type TurnInterruptResponse = Record<string, never>

// ---------- 模型与配置 ----------

export type Model = {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  supportedReasoningEfforts: Array<{ reasoningEffort: ReasoningEffort; description: string }>
  defaultReasoningEffort: ReasoningEffort
  inputModalities: string[]
  isDefault: boolean
}
export type ModelListParams = { cursor?: string | null; limit?: number | null; includeHidden?: boolean | null }
export type ModelListResponse = { data: Model[]; nextCursor: string | null }

export type ConfigReadParams = { includeLayers?: boolean; cwd?: string | null }
/** 用户生效配置（config.toml 合并后）。键名是 toml 里的蛇形写法；其余上百个键不列 */
export type ConfigReadResponse = {
  config: {
    model: string | null
    approval_policy: AskForApproval | null
    sandbox_mode: SandboxMode | null
    model_reasoning_effort: ReasoningEffort | null
    mcp_servers?: Record<string, JsonValue> | null
    [key: string]: unknown
  }
}

// ---------- 条目（ThreadItem） ----------

export type CommandAction =
  | { type: 'read'; command: string; name: string; path: string }
  | { type: 'listFiles'; command: string; path: string | null }
  | { type: 'search'; command: string; query: string | null; path: string | null }
  | { type: 'unknown'; command: string }

export type FileUpdateChange = {
  path: string
  kind: { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null }
  /** update 是 unified diff（改名时末尾附「Moved to: …」）；add 是新文件全文，delete 是旧文件全文 */
  diff: string
}

export type CollabAgentTool =
  | 'spawnAgent' | 'sendInput' | 'resumeAgent' | 'wait' | 'closeAgent' | 'sendMessage' | 'followupTask' | 'interruptAgent' | 'listAgents'
export type CollabAgentStatus = 'pendingInit' | 'running' | 'interrupted' | 'completed' | 'errored' | 'shutdown' | 'notFound'

export type ThreadItem =
  | { type: 'userMessage'; id: string; content: UserInput[] }
  | { type: 'agentMessage'; id: string; text: string; phase: 'commentary' | 'final_answer' | null }
  | { type: 'plan'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | {
      type: 'commandExecution'
      id: string
      command: string
      cwd: string
      processId: string | null
      source: 'agent' | 'userShell' | 'unifiedExecStartup' | 'unifiedExecInteraction'
      status: 'inProgress' | 'completed' | 'failed' | 'declined'
      commandActions: CommandAction[]
      aggregatedOutput: string | null
      exitCode: number | null
      durationMs: number | null
    }
  | { type: 'fileChange'; id: string; changes: FileUpdateChange[]; status: 'inProgress' | 'completed' | 'failed' | 'declined' }
  | {
      type: 'mcpToolCall'
      id: string
      server: string
      tool: string
      status: 'inProgress' | 'completed' | 'failed'
      arguments: JsonValue
      result: { content: JsonValue[]; structuredContent: JsonValue | null } | null
      error: { message: string } | null
      durationMs: number | null
    }
  | {
      type: 'dynamicToolCall'
      id: string
      tool: string
      arguments: JsonValue
      status: 'inProgress' | 'completed' | 'failed'
      contentItems: JsonValue[] | null
      success: boolean | null
      durationMs: number | null
    }
  | {
      /** 子代理：子代理是独立的线程（receiverThreadIds），它的条目以子线程 id 发通知 */
      type: 'collabAgentToolCall'
      id: string
      tool: CollabAgentTool
      status: 'inProgress' | 'completed' | 'failed' | 'interrupted'
      senderThreadId: string
      receiverThreadIds: string[]
      prompt: string | null
      model: string | null
      reasoningEffort: ReasoningEffort | null
      agentsStates: Record<string, { status: CollabAgentStatus; message: string | null } | undefined>
    }
  | { type: 'subAgentActivity'; id: string; kind: 'started' | 'interacted' | 'interrupted' | 'completed'; agentThreadId: string; agentPath: string }
  | { type: 'webSearch'; id: string; query: string; action: { type: string; query?: string; queries?: string[]; url?: string; pattern?: string } | null }
  | { type: 'imageView'; id: string; path: string }
  | { type: 'contextCompaction'; id: string }

// ---------- 通知 ----------

type TurnScoped = { threadId: string; turnId: string }
type ItemDelta = TurnScoped & { itemId: string; delta: string }

export type TokenUsageBreakdown = {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export type ServerNotifications = {
  'thread/started': { thread: Thread }
  'thread/status/changed': { threadId: string; status: ThreadStatus }
  'thread/settings/updated': {
    threadId: string
    threadSettings: { approvalPolicy: AskForApproval; sandboxPolicy: SandboxPolicy; model: string; effort: ReasoningEffort | null }
  }
  'thread/tokenUsage/updated': TurnScoped & {
    tokenUsage: { total: TokenUsageBreakdown; last: TokenUsageBreakdown; modelContextWindow: number | null }
  }
  'thread/compacted': TurnScoped
  'turn/started': { threadId: string; turn: Turn }
  'turn/completed': { threadId: string; turn: Turn }
  'turn/plan/updated': TurnScoped & { explanation: string | null; plan: Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }> }
  'item/started': TurnScoped & { item: ThreadItem; startedAtMs: number }
  'item/completed': TurnScoped & { item: ThreadItem; completedAtMs: number }
  'item/agentMessage/delta': ItemDelta
  'item/reasoning/summaryTextDelta': ItemDelta & { summaryIndex: number }
  'item/reasoning/summaryPartAdded': TurnScoped & { itemId: string; summaryIndex: number }
  'item/reasoning/textDelta': ItemDelta & { contentIndex: number }
  'item/commandExecution/outputDelta': ItemDelta
  'item/fileChange/patchUpdated': TurnScoped & { itemId: string; changes: FileUpdateChange[] }
  'item/mcpToolCall/progress': TurnScoped & { itemId: string; message: string }
  /** 服务端请求已经了结（我们答了，或 codex 自己撤回 —— 比如回合被中断）：之后对它的应答没有意义 */
  'serverRequest/resolved': { threadId: string; requestId: RequestId }
  'mcpServer/startupStatus/updated': { threadId: string | null; name: string; status: string; error: string | null }
  error: TurnScoped & { error: TurnError; willRetry: boolean }
  warning: { threadId: string | null; message: string }
  'model/rerouted': TurnScoped & { fromModel: string; toModel: string; reason: unknown }
}
export type NotificationMethod = keyof ServerNotifications

// ---------- 服务端请求（要应答） ----------

export type CommandApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: { host: string; action: string } } }
  | 'decline'
  | 'cancel'
export type FileChangeApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

export type PermissionProfile = {
  network?: { enabled: boolean | null } | null
  fileSystem?: { read: string[] | null; write: string[] | null } | null
}

export type UserInputQuestion = {
  id: string
  header: string
  question: string
  /** 允许在选项之外自由输入 */
  isOther: boolean
  /** 答案是密码类：不进步骤文字与日志 */
  isSecret: boolean
  options: Array<{ label: string; description: string }> | null
}

export type ServerRequests = {
  'item/commandExecution/requestApproval': {
    params: TurnScoped & {
      itemId: string
      kind: 'command' | 'writeStdin'
      startedAtMs: number
      approvalId?: string | null
      reason?: string | null
      command?: string | null
      cwd?: string | null
      commandActions?: CommandAction[] | null
      proposedExecpolicyAmendment?: string[] | null
      /** 这次可选的决定；缺省 = accept / acceptForSession / decline / cancel */
      availableDecisions?: CommandApprovalDecision[] | null
    }
    result: { decision: CommandApprovalDecision }
  }
  'item/fileChange/requestApproval': {
    params: TurnScoped & { itemId: string; startedAtMs: number; reason?: string | null; grantRoot?: string | null }
    result: { decision: FileChangeApprovalDecision }
  }
  'item/permissions/requestApproval': {
    params: TurnScoped & { itemId: string; startedAtMs: number; cwd: string; reason: string | null; permissions: PermissionProfile }
    /** 拒绝 = 空的 permissions */
    result: { permissions: PermissionProfile; scope: 'turn' | 'session' }
  }
  /** [实验] 提问 */
  'item/tool/requestUserInput': {
    params: TurnScoped & { itemId: string; questions: UserInputQuestion[]; isBlocking: boolean; autoResolutionMs: number | null }
    result: { answers: Record<string, { answers: string[] }> }
  }
  'mcpServer/elicitation/request': {
    params: { threadId: string; turnId: string | null; serverName: string } & (
      | { mode: 'form'; _meta: JsonValue | null; message: string; requestedSchema: Record<string, unknown> }
      | { mode: 'url'; _meta: JsonValue | null; message: string; url: string; elicitationId: string }
      | { mode: 'openai/form' | 'openaiForm' | 'openai/userVerification'; [key: string]: unknown }
    )
    result: { action: 'accept' | 'decline' | 'cancel'; content: JsonValue | null; _meta: JsonValue | null }
  }
}
export type ServerRequestMethod = keyof ServerRequests

// ---------- 客户端请求 ----------

export type ClientRequests = {
  initialize: { params: InitializeParams; result: InitializeResponse }
  'thread/start': { params: ThreadStartParams; result: ThreadOpenResponse }
  'thread/resume': { params: ThreadResumeParams; result: ThreadOpenResponse }
  'thread/read': { params: ThreadReadParams; result: ThreadReadResponse }
  'thread/unsubscribe': { params: ThreadUnsubscribeParams; result: ThreadUnsubscribeResponse }
  'turn/start': { params: TurnStartParams; result: TurnStartResponse }
  'turn/interrupt': { params: TurnInterruptParams; result: TurnInterruptResponse }
  'model/list': { params: ModelListParams; result: ModelListResponse }
  'config/read': { params: ConfigReadParams; result: ConfigReadResponse }
}
export type ClientRequestMethod = keyof ClientRequests

/** 收到的通知按方法名收窄（未知方法照样收得到，只是没有类型） */
export function isNotification<M extends NotificationMethod>(
  msg: { method: string; params: unknown },
  method: M,
): msg is { method: M; params: ServerNotifications[M] } {
  return msg.method === method
}
