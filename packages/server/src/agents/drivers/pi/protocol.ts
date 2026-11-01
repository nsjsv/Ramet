// ---------- pi / omp 的 RPC 协议类型（手工裁剪） ----------
// 来源：
//   pi：@earendil-works/pi-coding-agent 1.4.0 的 docs/rpc.md、rpc-commands.md、rpc-extension-ui.md、json.md 与
//       dist/modes/rpc/rpc-types.d.ts（`npm pack @earendil-works/pi-coding-agent@<版本>` 取包对照）；
//   omp：can1357/oh-my-pi 的 docs/rpc.md 与 packages/coding-agent/src/modes/rpc/wire/*.ts（`bun run gen:rpc`
//       产出 rpc-wire.schema.json / rpc-wire.generated.ts，升级时对照这两份）。
// 只留驱动用得到的命令、事件与字段；多出来的字段照样能收到，类型里不声明而已。
//
// 线上格式（实测 pi 1.4.0 / omp 18.14.1）：一行一个 JSON、严格按 LF 分帧，不是 JSON-RPC。
// 命令 {id?, type, …}；应答 {id?, type:'response', command, success, data? | error, code?}，可能乱序，按 id 配对；
// 事件不带 id；扩展 UI 请求 {type:'extension_ui_request', id, method, …}，对话框类要回 {type:'extension_ui_response', id, …}。
// omp 在 pi 之上：启动先发 ready 帧、可协商 v2 分块帧（rpc_chunk）、prompt 的收尾是 prompt_result / session_settled、
// 子代理帧、宿主工具（host_tool_*）、ask 对话框。

export type PiDialect = 'pi' | 'omp'

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// ---------- 内容与消息 ----------

export type TextContent = { type: 'text'; text: string }
export type ImageContent = { type: 'image'; data: string; mimeType: string }
export type ThinkingContent = { type: 'thinking'; thinking: string }
export type ToolCall = { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }

export type Usage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** pi 1.4 起有：推理 token */
  reasoning?: number
  totalTokens: number
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
}

export type StopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'pending'

export type UserMessage = { role: 'user'; content: string | Array<TextContent | ImageContent>; timestamp?: number }
export type AssistantMessage = {
  role: 'assistant'
  content: Array<TextContent | ThinkingContent | ToolCall>
  provider?: string
  model?: string
  usage?: Usage
  stopReason?: StopReason
  errorMessage?: string
  timestamp?: number
}
export type ToolResultMessage = {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: Array<TextContent | ImageContent>
  details?: unknown
  isError: boolean
}
/** 扩展 / omp 注入的消息（omp 的后台作业结果是 customType: 'async-result'） */
export type CustomMessage = { role: 'custom'; customType: string; content: string | Array<TextContent | ImageContent>; display?: boolean }
/** pi 1.4 起每轮开头发一条 system 消息（只是展示用），驱动忽略 */
export type SystemMessage = { role: 'system'; content: string }
export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage | SystemMessage

export type Model = {
  id: string
  name: string
  provider: string
  api?: string
  reasoning: boolean
  input?: string[]
  contextWindow?: number
  maxTokens?: number
  /** omp：模型支持的思考档 */
  thinking?: { mode: string; efforts?: string[] }
}

// ---------- 命令 ----------

/** 命令 type → 参数（不含 id / type）与应答 data。只列驱动用到的 */
export type PiCommands = {
  prompt: { params: { message: string; images?: ImageContent[]; streamingBehavior?: 'steer' | 'followUp' }; data: PromptAck | undefined }
  abort: { params: Record<string, never>; data: undefined }
  get_state: { params: Record<string, never>; data: SessionStateData }
  get_messages: { params: Record<string, never>; data: { messages: AgentMessage[] } }
  set_model: { params: { provider: string; modelId: string }; data: Model }
  get_available_models: { params: Record<string, never>; data: { models: Model[] } }
  set_thinking_level: { params: { level: ThinkingLevel }; data: undefined }
  get_available_thinking_levels: { params: Record<string, never>; data: { levels: ThinkingLevel[] } }
  get_session_stats: { params: Record<string, never>; data: SessionStats }
  new_session: { params: { parentSession?: string }; data: { cancelled: boolean } }
  switch_session: { params: { sessionPath: string }; data: { cancelled: boolean } }
  set_session_name: { params: { name: string }; data: undefined }
  /** pi 的斜杠命令表（omp 不提供，用 get_available_commands） */
  get_commands: { params: Record<string, never>; data: { commands: PiSlashCommand[] } }
  // ----- omp -----
  negotiate_protocol: { params: { protocolVersion: 2 }; data: { protocolVersion: number } }
  open_session: { params: { sessionDir: string; provider?: string; modelId?: string }; data: OpenSessionData }
  get_available_commands: { params: Record<string, never>; data: { commands: OmpSlashCommand[] } }
  set_ask_dialog: { params: { enabled: boolean }; data: { enabled: boolean } }
  set_subagent_subscription: { params: { level: 'off' | 'progress' | 'events' }; data: { level: string } }
  get_subagents: { params: Record<string, never>; data: { subagents: SubagentInfo[] } }
  cancel_subagent: { params: { subagentId: string }; data: { cancelled: boolean } }
  set_host_tools: { params: { tools: HostToolDefinition[] }; data: { toolNames: string[] } }
}
export type PiCommandType = keyof PiCommands

/** pi：prompt 被怎么处理了（handled = 扩展命令就地处理完，不会有后续事件）；omp：只在 agentInvoked:false 时带 */
export type PromptAck = { disposition?: 'started' | 'queued' | 'handled'; agentInvoked?: boolean }

export type SessionStateData = {
  /** 没有可用模型时 pi 给的是占位对象（id / provider 都是 'unknown'） */
  model?: Model
  thinkingLevel?: ThinkingLevel
  isStreaming: boolean
  sessionFile?: string
  sessionId: string
  sessionName?: string
  messageCount: number
  /** omp */
  isSettled?: boolean
  contextUsage?: ContextUsage
}

export type ContextUsage = { tokens: number | null; contextWindow: number; percent: number | null }

export type SessionStats = {
  sessionFile?: string
  sessionId: string
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  cost: number
  contextUsage?: ContextUsage
}

export type OpenSessionData = { cancelled: boolean; resumed: boolean; sessionId: string; sessionFile: string }

export type PiSlashCommand = { name: string; description?: string; source: 'extension' | 'prompt' | 'skill' }
export type OmpSlashCommand = { name: string; description?: string; source: string; aliases?: string[]; input?: { hint?: string } }

export type SubagentInfo = { id: string; agent: string; status: string; task?: string; parentToolCallId?: string; sessionFile?: string }

export type HostToolDefinition = {
  name: string
  label?: string
  description: string
  parameters: Record<string, unknown>
  hidden?: boolean
  /** 缺省 discoverable：会被挂成 xd:// 设备而不是顶层工具，Ramet 的工具要给 essential */
  loadMode?: 'essential' | 'discoverable'
}

// ---------- 帧 ----------

export type ResponseFrame =
  | { id?: string; type: 'response'; command: string; success: true; data?: unknown }
  | { id?: string; type: 'response'; command: string; success: false; error: string; code?: string }

export type ReadyFrame = {
  type: 'ready'
  protocolVersion?: number
  supportedProtocolVersions?: number[]
  maxFrameBytes?: number
  maxReassembledFrameBytes?: number
}

/** v2 分块：一个超大逻辑帧拆成连续的若干块，data 是该段 UTF-8 JSON 的 base64 */
export type ChunkFrame = { type: 'rpc_chunk'; chunkId: string; index: number; count: number; byteLength: number; data: string }

// ---------- 扩展 UI ----------

export type AskQuestion = {
  id: string
  question: string
  header?: string
  options: Array<{ label: string; description?: string; preview?: string }>
  multi?: boolean
  recommended?: number
}

export type UiDialogRequest =
  | { type: 'extension_ui_request'; id: string; method: 'select'; title: string; options: string[]; optionDetails?: Array<{ description?: string }>; timeout?: number }
  | { type: 'extension_ui_request'; id: string; method: 'confirm'; title: string; message: string; timeout?: number }
  | { type: 'extension_ui_request'; id: string; method: 'input'; title: string; placeholder?: string; timeout?: number; secret?: boolean }
  | { type: 'extension_ui_request'; id: string; method: 'editor'; title: string; prefill?: string; promptStyle?: boolean }
  | { type: 'extension_ui_request'; id: string; method: 'ask'; questions: AskQuestion[]; timeout?: number }

/** 单向的展示类请求（不应答） */
export type UiNoticeRequest =
  | { type: 'extension_ui_request'; id: string; method: 'notify'; message: string; notifyType?: 'info' | 'warning' | 'error' }
  | { type: 'extension_ui_request'; id: string; method: 'setStatus'; statusKey: string; statusText?: string }
  | { type: 'extension_ui_request'; id: string; method: 'setWidget'; widgetKey: string; widgetLines?: string[] }
  | { type: 'extension_ui_request'; id: string; method: 'setTitle'; title: string }
  | { type: 'extension_ui_request'; id: string; method: 'set_editor_text'; text: string }
  | { type: 'extension_ui_request'; id: string; method: 'open_url'; url: string; instructions?: string }

export const UI_DIALOG_METHODS: ReadonlySet<string> = new Set(['select', 'confirm', 'input', 'editor', 'ask'])

export type AskAnswer = { id: string; selectedOptions: string[]; customInput?: string }

/** 对话框的答案（不含 type / id）；cancelled = 关掉 / 拒绝 */
export type UiAnswer = { value: string } | { confirmed: boolean } | { cancelled: true; timedOut?: boolean } | { answers: AskAnswer[] }

// ---------- 宿主工具（omp） ----------

export type HostToolCall = { type: 'host_tool_call'; id: string; toolCallId: string; toolName: string; arguments: Record<string, unknown> }
export type HostToolResult = { content: Array<TextContent | ImageContent>; details?: unknown }

// ---------- 事件 ----------

export type AssistantMessageEvent =
  | { type: 'text_start' | 'thinking_start'; contentIndex: number }
  | { type: 'text_delta' | 'thinking_delta' | 'toolcall_delta'; contentIndex: number; delta: string }
  | { type: 'text_end' | 'thinking_end'; contentIndex: number; content: string }
  | { type: 'toolcall_start'; contentIndex: number; id?: string; toolName?: string }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCall }

export type ToolExecutionResult = { content: Array<TextContent | ImageContent>; details?: unknown; structuredContent?: unknown }

export type PiEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: AgentMessage[]; willRetry?: boolean; isTerminal?: boolean; yielded?: boolean; awaitingAsyncWork?: boolean }
  /** pi：会话不会再自己往下跑了（一轮的收尾） */
  | { type: 'agent_settled'; aborted: boolean }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: AgentMessage; toolResults: ToolResultMessage[] }
  /** omp 的 message_* 另带 messageId */
  | { type: 'message_start'; message: AgentMessage; messageId?: string }
  | { type: 'message_update'; usage?: Usage; assistantMessageEvent: AssistantMessageEvent; messageId?: string }
  | { type: 'message_end'; message: AgentMessage; messageId?: string }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: Record<string, unknown>; intent?: string }
  /** partialResult 是累计值（不是增量） */
  | { type: 'tool_execution_update'; toolCallId: string; toolName: string; args: Record<string, unknown>; partialResult: ToolExecutionResult }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: ToolExecutionResult; isError: boolean; durationMs?: number }
  | { type: 'queue_update'; steering: string[]; followUp: string[] }
  | { type: 'thinking_level_changed'; level: ThinkingLevel }
  | { type: 'compaction_start' | 'auto_compaction_start' | 'manual_compaction_start'; reason?: string }
  | { type: 'compaction_end' | 'auto_compaction_end' | 'manual_compaction_end'; aborted?: boolean; errorMessage?: string }
  | { type: 'auto_retry_start'; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: 'auto_retry_end'; success: boolean; attempt: number; finalError?: string }
  | { type: 'extension_error'; extensionPath: string; event: string; error: string }
  // ----- omp -----
  | { type: 'prompt_result'; id?: string; agentInvoked: boolean; status: 'completed' | 'aborted' | 'error'; error?: PromptError; sessionSettled: boolean }
  | { type: 'session_settled' }
  | { type: 'available_commands_update'; commands: OmpSlashCommand[] }
  | { type: 'model_changed'; model?: Model }
  | { type: 'subagent_lifecycle'; payload: SubagentLifecycle }
  | { type: 'subagent_progress'; payload: SubagentProgress }
  | { type: 'subagent_event'; payload: { id: string; event: PiEvent } }
  | { type: 'todo_reminder'; todos: TodoTask[] }
  | { type: 'rpc_frame_error'; originalType?: string; error: string }

export type PromptError = { message: string; provider?: string; model?: string; httpStatus?: number; retryable: boolean; code?: string }

export type SubagentLifecycle = {
  id: string
  agent: string
  status: 'started' | 'completed' | 'failed' | 'aborted'
  description?: string
  sessionFile?: string
  parentToolCallId?: string
  index: number
  detached?: boolean
}
export type SubagentProgress = {
  index: number
  agent: string
  task: string
  parentToolCallId?: string
  assignment?: string
  /** 原样的 AgentProgress：{id, status, recentTools, recentOutput, toolCount, tokens, durationMs, …} */
  progress: Record<string, unknown>
}

export type TodoTask = { content: string; status: 'pending' | 'in_progress' | 'completed' | 'abandoned' | 'blocked'; blocker?: string }
export type TodoPhase = { name: string; tasks: TodoTask[] }
