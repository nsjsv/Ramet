// ---------- Genet：中心自己跑的 agent（第五种驱动，不经 createAdapter） ----------
// 没有子进程、没有 CLI：模型是用户自己的连接（输入框旁 chip 选的那一套，默认是设置里的当前连接；每一轮现取、现解密，key 不留在会话里），
// 工具是中心本机拉起的 Ramet MCP 进程（tools.ts）。全站共用一个实例，多个用户的会话都在里面（sessionId → 会话）。
// 会话属于谁由建 / 加载会话时交来的凭证认（page-read.ts 的 grantUser），不另传身份：冒充不了别人，别人的会话按 id 也加载不上。
// 一轮由 pi 的 Agent（pi-agent-core）跑：模型流式回复 → 有工具调用就经 MCP 依次调、结果回给模型 → 直到模型不再调工具，
// 或到步数上限。每一轮现建一个 Agent，历史在会话里；模型请求经 pi-models.ts（连接 → pi-ai、防护 fetch、HTTP 事实探针）。
// 消息历史每一轮结束（含停止 / 出错）整份落库（assistant_sessions），进程重启 / 适配器被回收后由 loadSession 读回来。
// 在飞计数 / 会话级状态的规则照旧在 DriverBase；Genet 自己不发审批：要批的操作（移入回收站等）在中心端点里，走 Ramet 自己的审批。

import { randomUUID } from 'node:crypto'
import { Agent, type AgentEvent } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { Pool } from 'pg'
import { checkEndpoint, getSettings, KeyUnreadableError, listConnections, onConnectionsChanged, openConnection } from '../../../ai-connections.js'
import type { Resolver } from '../../../endpoint-guard.js'
import { defaultModelCatalog, findModel, type ModelCatalog } from '../../../model-catalog.js'
import { grantUser, type PageTool } from '../../../page-read.js'
import { createPiStream, failureOf, isRefusal, piModel, type PiStream } from '../../../pi-models.js'
import { describeModelError, logSafeError, type ModelConnection, type Probe } from '../../../quick.js'
import { loadSecretKeyFromEnv } from '../../../secret-box.js'
import { ASSISTANT_ID } from '../../assistant-agent.js'
import type { ConfigOption, PromptBlock, PromptResult, TurnUsage } from '../../types.js'
import { DriverBase } from '../base.js'
import { forStorage, isStoredHistory, userTurn } from './history.js'
import { PROVIDER_ID, resolveChoice, type AssistantChoice, type AssistantThinking, type ResolvedChoice } from './options.js'
import { userTimeZone } from '../../../triggers/store.js'
import { ASSISTANT_SYSTEM_PROMPT, clockLine } from './prompt.js'
import { agentTools, AssistantTools, resultFace, startFace } from './tools.js'

/** 一轮里最多问几次模型（每次之后可以调一批工具）：到了就停下，告诉用户可以接着说 */
export const ASSISTANT_MAX_STEPS = 24
/** 会话的 MCP 进程闲这么久就关掉（一个约几十 MB），下一轮再起 */
const MCP_IDLE_MS = 10 * 60_000
/** 每人留这么多个会话的历史，更早的删掉（删了的会话再加载不上，现有流程会新建会话、全文重放） */
const SESSIONS_PER_USER = 20

export const NO_CONNECTION = 'Genet 还没有可用的模型：先在「设置 → Genet」里添加一个供应商'
const NO_TOOLS = 'Genet 要用 Ramet 工具才能工作：把这一页的工具档位切回「完整」或「精简」'
const STEP_LIMIT = `已经连着调用了 ${ASSISTANT_MAX_STEPS} 轮工具，先停在这里；要接着做就再说一声。`

const INSERT_SESSION = 'INSERT INTO assistant_sessions (id, user_id) VALUES ($1, $2)'
const PRUNE_SESSIONS = `DELETE FROM assistant_sessions WHERE user_id = $1 AND id NOT IN
  (SELECT id FROM assistant_sessions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2)`
const SELECT_SESSION = 'SELECT user_id, messages FROM assistant_sessions WHERE id = $1'
const SAVE_SESSION = 'UPDATE assistant_sessions SET messages = $2::jsonb, updated_at = now() WHERE id = $1'

export type AssistantDeps = {
  pool: Pool
  /** 按连接发模型请求（测试注入假的）；缺省经 pi-ai 走真实服务（自定义地址经防护版 fetch） */
  stream?: PiStream
  /** 主密钥：undefined = 读 RAMET_SECRET_KEY；null = 明确没配 */
  secretKey?: Buffer | null
  /** 自定义地址每一轮开始前的 DNS 校验（测试注入）；缺省系统解析 */
  resolve?: Resolver
  /** 公开模型目录（思考档位 / 上下文 / 输出上限）：undefined = 进程共用的那一份；null = 不用目录，按内置规则 */
  catalog?: ModelCatalog | null
}

type Session = {
  id: string
  userId: string
  /** 最近一次建 / 加载会话交来的凭证；MCP 进程用的是 mcpToken 那一把，不一样就重起 */
  tool: PageTool
  /** pi 的消息历史，不含 system（history.ts） */
  messages: Message[]
  /** 输入框旁 chip 上的选择（options.ts） */
  choice: AssistantChoice
  mcp: Promise<AssistantTools> | null
  mcpToken: string
  /** 在跑的这一轮（停止 = abort） */
  turn: AbortController | null
  idle: NodeJS.Timeout | null
}

/** 模型侧的失败 → 给用户看的一句话（这句话进失败条、广播给页面上的人、留在过程记录里）。
 *  apiKey = 这一轮用的 key：describeModelError 把上游原文里回显的 key 抹掉 */
function modelError(err: unknown, apiKey: string): string {
  const { code, message } = describeModelError(err, apiKey)
  return code === 'unknown' ? 'Genet 调用模型时出错了，请稍后再试' : message
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 这一轮问模型用的连接：解密后的连接 + chip 上选的思考参数 + 按目录定的 max_tokens */
type TurnModel = ModelConnection & { thinking?: AssistantThinking; maxTokens?: number }

type Usage = AssistantMessage['usage']

/** 一轮里的工具步骤：用过的步骤 id（过程里一步一个），与还没结束的调用 → 它的步骤 */
type StepBook = { used: Set<string>; open: Map<string, { stepId: string; input: Record<string, unknown> }> }

/** 一轮里各次模型请求的用量合计；一次都没报就是没有（不补 0） */
class UsageSum {
  private sum: { input: number; output: number; cacheRead: number; cacheWrite: number } | null = null

  add(u: Usage): void {
    const s = (this.sum ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    s.input += u.input
    s.output += u.output
    s.cacheRead += u.cacheRead
    s.cacheWrite += u.cacheWrite
  }

  total(): TurnUsage | undefined {
    const s = this.sum
    if (!s) return undefined
    return {
      total: s.input + s.output + s.cacheRead + s.cacheWrite,
      input: s.input,
      output: s.output,
      ...(s.cacheRead ? { cacheRead: s.cacheRead } : {}),
      ...(s.cacheWrite ? { cacheWrite: s.cacheWrite } : {}),
    }
  }
}

export class AssistantDriver extends DriverBase {
  private readonly sessions = new Map<string, Session>()
  private readonly stream: PiStream
  private readonly secretKey: Buffer | null
  private readonly catalog: ModelCatalog | null
  private readonly unsubscribe: Array<() => void>

  constructor(private readonly deps: AssistantDeps) {
    super()
    this.stream = deps.stream ?? createPiStream()
    this.secretKey = deps.secretKey === undefined ? loadSecretKeyFromEnv() : deps.secretKey
    this.catalog = deps.catalog === undefined ? defaultModelCatalog() : deps.catalog
    // 设置里加 / 改 / 删了供应商、模型目录重拉到了：开着的 Genet 输入框立刻看到新列表 / 新档位，不用等下一轮
    this.unsubscribe = [
      onConnectionsChanged((userId) => this.refreshAll((s) => s.userId === userId)),
      ...(this.catalog ? [this.catalog.onUpdate(() => this.refreshAll(() => true))] : []),
    ]
  }

  private refreshAll(which: (s: Session) => boolean): void {
    for (const s of this.sessions.values()) {
      if (!which(s)) continue
      this.refresh(s).catch((err: unknown) => console.error(`[assistant] 会话 ${s.id} 刷新配置项失败：${errText(err)}`))
    }
  }

  /** 没有要握手的进程：没被 kill 就能用 */
  protected get connected(): boolean {
    return !this.dead
  }

  protected get spawned(): boolean {
    return true
  }

  ready(): Promise<void> {
    return this.dead ? Promise.reject(new Error('Genet 已停止')) : Promise.resolve()
  }

  /** 这个会话属于谁：只认签给 Genet 的凭证。没有凭证 = 这一页的工具档位是「无」，Genet 没法工作 */
  private owner(tools: PageTool[]): { tool: PageTool; userId: string } {
    const tool = tools[0]
    if (!tool) throw new Error(NO_TOOLS)
    const userId = grantUser(tool.mcp.token, ASSISTANT_ID)
    if (!userId) throw new Error('Genet 的凭证已经失效，请再发一次')
    return { tool, userId }
  }

  private open(id: string, userId: string, tool: PageTool, messages: Message[]): Session {
    const s: Session = { id, userId, tool, messages, choice: { provider: null, effort: null }, mcp: null, mcpToken: '', turn: null, idle: null }
    this.sessions.set(id, s)
    this.sessionConfigs.set(id, [])
    return s
  }

  /** 现读连接表，算出这个会话的两项配置项；变了就更新缓存、发 config 事件（会话镜像据此广播给页面上的人）。
   *  还没定供应商的会话就定成此刻算出来的那一个（设置里的当前连接）：之后设置里改当前连接只影响 ⌘J，Genet 听 chip 的 */
  private async refresh(s: Session): Promise<ResolvedChoice> {
    const [rows, settings, index] = await Promise.all([
      listConnections(this.deps.pool, s.userId),
      getSettings(this.deps.pool, s.userId),
      this.catalog ? this.catalog.get() : null,
    ])
    const resolved = resolveChoice(rows, settings.activeConnectionId, s.choice, (r) =>
      index ? findModel(index, { protocol: r.protocol, baseUrl: r.base_url, model: r.model }) : null,
    )
    // 回落到了别的连接（或第一次定下来）：选择跟着改，在原来那个上选的思考档作废（resolveChoice 已按默认档算）
    if (resolved.row && resolved.row.id !== s.choice.provider) s.choice = { provider: resolved.row.id, effort: null }
    if (JSON.stringify(this.sessionConfigs.get(s.id)) !== JSON.stringify(resolved.options)) {
      this.sessionConfigs.set(s.id, resolved.options)
      this.emit({ type: 'config', options: resolved.options, sessionId: s.id })
    }
    return resolved
  }

  // Genet 没有工作区：cwd 不用
  async newSession(_cwd: string, tools: PageTool[] = []): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    await this.ready()
    const { tool, userId } = this.owner(tools)
    const id = randomUUID()
    await this.deps.pool.query(INSERT_SESSION, [id, userId])
    await this.deps.pool.query(PRUNE_SESSIONS, [userId, SESSIONS_PER_USER])
    const s = this.open(id, userId, tool, [])
    return { sessionId: id, configOptions: (await this.refresh(s)).options }
  }

  async newRestrictedSession(): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    throw new Error('Genet 不做 ⌘J 的受限会话')
  }

  /** 本进程里有就只换凭证；没有就从库里读回历史。不是这个人的、库里没有、或是认不出的历史形状，都抛错（调用方据此新建会话、全文重放） */
  async loadSession(sessionId: string, _cwd: string, tools: PageTool[] = []): Promise<{ configOptions: ConfigOption[] }> {
    await this.ready()
    const { tool, userId } = this.owner(tools)
    const existing = this.sessions.get(sessionId)
    if (existing) {
      if (existing.userId !== userId) throw new Error(`没有这个 Genet 会话 ${sessionId}`)
      existing.tool = tool
      return { configOptions: (await this.refresh(existing)).options }
    }
    const row = (await this.deps.pool.query<{ user_id: string; messages: unknown }>(SELECT_SESSION, [sessionId])).rows[0]
    if (!row || row.user_id !== userId || !isStoredHistory(row.messages)) throw new Error(`没有这个 Genet 会话 ${sessionId}`)
    const s = this.open(sessionId, userId, tool, row.messages)
    return { configOptions: (await this.refresh(s)).options }
  }

  /** 换供应商 / 思考程度。值必须在此刻的选项里（连接可能刚被删、换了协议思考档就不同），不在就抛错：
   *  改配置的端点把原因给用户，applyConfigs 丢掉这一条 */
  async setConfigOption(sessionId: string, configId: string, value: string): Promise<ConfigOption[]> {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error(`Unsupported session ${sessionId}：先 newSession / loadSession`)
    const option = (await this.refresh(s)).options.find((o) => o.id === configId)
    if (!option) throw new Error(`Genet 现在没有「${configId}」这一项`)
    if (!option.options.some((v) => v.value === value)) throw new Error(`「${option.name}」里没有这个选项`)
    if (configId === PROVIDER_ID) {
      if (value !== s.choice.provider) s.choice = { provider: value, effort: null }
    } else s.choice.effort = value
    return (await this.refresh(s)).options
  }

  async prompt(sessionId: string, blocks: PromptBlock[]): Promise<PromptResult> {
    await this.ready()
    const s = this.sessions.get(sessionId)
    // 这个进程里没有这个会话，调用方据此先 load 再试
    if (!s) throw new Error(`Unsupported session ${sessionId}：先 newSession / loadSession`)
    if (s.turn) throw new Error('这个会话的上一轮还没结束')
    const abort = new AbortController()
    s.turn = abort
    this.beginTurn(sessionId)
    try {
      return await this.turn(s, blocks, abort.signal)
    } finally {
      s.turn = null
      this.endTurn(sessionId)
      s.messages = forStorage(s.messages)
      await this.deps.pool
        .query(SAVE_SESSION, [s.id, JSON.stringify(s.messages)])
        .catch((err: unknown) => console.error(`[assistant] 会话 ${s.id} 落库失败：${errText(err)}`))
      this.armIdle(s)
    }
  }

  private async turn(s: Session, blocks: PromptBlock[], signal: AbortSignal): Promise<PromptResult> {
    // 先进历史再取连接：会话记录在发出提示词前就记下了「看到这一块」，这一轮要是因为没配连接失败了，
    // 用户配好以后点重试（续跑只补一句说明），这条消息也还在会话里。最前面是当前时间（用户时区现查）
    const clock = clockLine(new Date(), await userTimeZone(this.deps.pool, s.userId))
    s.messages.push(userTurn([{ type: 'text', text: clock }, ...blocks]))
    const resolved = await this.refresh(s)
    const conn = await this.connection(resolved)
    const tools = await this.tools(s)
    const specs = await tools.list()
    const usage = new UsageSum()
    const result = (stopReason: string): PromptResult => {
      const total = usage.total()
      return { stopReason, ...(total ? { usage: total } : {}) }
    }
    const model = piModel(conn, conn.thinking, resolved.context ? { context: resolved.context } : {})
    // 这一轮的 HTTP 事实（每次请求重置，失败时就是最后那次的）
    const probe: Probe = {}
    let asked = 0
    let limited = false
    const agent = new Agent({
      initialState: { systemPrompt: ASSISTANT_SYSTEM_PROMPT, model, tools: agentTools(tools, specs), messages: s.messages },
      streamFn: (m, context, options) =>
        this.stream(conn, m as typeof model, context, {
          ...(conn.thinking ? { thinking: conn.thinking } : {}),
          ...(conn.maxTokens ? { maxTokens: conn.maxTokens } : {}),
          ...(options?.signal ? { signal: options.signal } : {}),
          sessionId: s.id,
          probe,
        }),
      // 要等人批准的工具（移入回收站、记住一条记忆）不能并发
      toolExecution: 'sequential',
      sessionId: s.id,
      // 每问一次模型算一步；到上限且还有工具结果没交回去就停下，告诉用户可以接着说
      finishTurn: (turn) => {
        if (++asked < ASSISTANT_MAX_STEPS || turn.toolResults.length === 0) return undefined
        limited = true
        return { action: 'end' }
      },
    })
    const steps: StepBook = { used: new Set(), open: new Map() }
    agent.subscribe((ev) => this.project(s, ev, usage, resolved.context, steps))
    const stop = (): void => agent.abort()
    signal.addEventListener('abort', stop, { once: true })
    try {
      await agent.continue()
    } finally {
      signal.removeEventListener('abort', stop)
      s.messages = agent.state.messages.filter((m): m is Message => m.role !== 'system')
    }
    const last = s.messages.findLast((m): m is AssistantMessage => m.role === 'assistant')
    if (signal.aborted || last?.stopReason === 'aborted') return result('cancelled')
    if (!last) throw new Error('Genet 调用模型时出错了，请稍后再试')
    if (last.stopReason === 'error') {
      if (isRefusal(last)) {
        if (!last.content.some((c) => c.type === 'text' && c.text)) throw new Error('模型拒绝了这个请求')
        return result('refusal')
      }
      const failure = failureOf(last, probe)
      console.error(`[assistant] 会话 ${s.id} 模型调用失败：${logSafeError(failure)}`)
      throw new Error(modelError(failure, conn.apiKey))
    }
    if (last.stopReason === 'length') return result('max_tokens')
    if (limited) {
      this.emit({ type: 'text', delta: STEP_LIMIT, sessionId: s.id })
      s.messages.push({ ...last, content: [{ type: 'text', text: STEP_LIMIT }], stopReason: 'stop', timestamp: Date.now() })
      return result('max_turn_requests')
    }
    return result('end_turn')
  }

  /** pi 的事件 → 驱动事件：正文与思考边到边发，工具一步一个步骤，每次请求后报用量与上下文占用 */
  private project(
    s: Session,
    ev: AgentEvent,
    usage: UsageSum,
    /** 模型的上下文窗口（目录里有才有）：上下文圆环用 */
    context: number | undefined,
    steps: StepBook,
  ): void {
    if (ev.type === 'message_update') {
      const e = ev.assistantMessageEvent
      if (e.type === 'text_delta' && e.delta) this.emit({ type: 'text', delta: e.delta, sessionId: s.id })
      else if (e.type === 'thinking_delta' && e.delta) this.emit({ type: 'thought', delta: e.delta, sessionId: s.id })
    } else if (ev.type === 'message_end' && ev.message.role === 'assistant') {
      const u = ev.message.usage
      if (!u.input && !u.output && !u.cacheRead && !u.cacheWrite) return
      usage.add(u)
      const total = usage.total()
      if (total) this.emit({ type: 'info', info: { usage: total }, sessionId: s.id })
      // 上下文占用 = 这一次请求的全部 token（整段历史 + 这一步的输出）
      if (context) this.emit({ type: 'usage', used: u.input + u.cacheRead + u.cacheWrite + u.output, size: context, sessionId: s.id })
    } else if (ev.type === 'tool_execution_start') {
      // 过程里一步一个 id：有的服务每一步都从 call_0 编起
      let stepId = ev.toolCallId || 'tool'
      for (let n = 2; steps.used.has(stepId); n++) stepId = `${ev.toolCallId}#${n}`
      steps.used.add(stepId)
      const input = (ev.args ?? {}) as Record<string, unknown>
      steps.open.set(ev.toolCallId, { stepId, input })
      const face = startFace(ev.toolName, input)
      this.emit({ type: 'tool', id: stepId, kind: face.kind, title: face.title, status: 'in_progress', view: face.view, ...(face.truncated ? { truncated: true } : {}), sessionId: s.id })
    } else if (ev.type === 'tool_execution_end') {
      const step = steps.open.get(ev.toolCallId)
      if (!step) return
      steps.open.delete(ev.toolCallId)
      const content = ((ev.result as { content?: unknown } | undefined)?.content ?? []) as Array<{ type: string; text?: string }>
      const text = content.flatMap((c) => (c.type === 'text' && c.text ? [c.text] : [])).join('\n')
      const done = resultFace(step.input, { text, images: content.filter((c) => c.type === 'image').length, isError: ev.isError })
      this.emit({
        type: 'tool',
        id: step.stepId,
        status: ev.isError ? 'failed' : 'completed',
        view: done.view,
        ...(done.note ? { note: done.note } : {}),
        ...(done.truncated ? { truncated: true } : {}),
        sessionId: s.id,
      })
    }
  }

  /** 这一轮用的模型连接：现解密，只活在这一轮里。没配连接、主密钥读不出、地址此刻不安全，都给能照着做的说明 */
  private async connection({ row, thinking, maxTokens }: Pick<ResolvedChoice, 'row' | 'thinking' | 'maxTokens'>): Promise<TurnModel> {
    if (!row) throw new Error(NO_CONNECTION)
    let conn: ModelConnection
    try {
      conn = openConnection(row, this.secretKey)
    } catch (err) {
      throw new Error(err instanceof KeyUnreadableError ? err.message : '已保存的供应商 key 读不出来，请到设置里重新填写')
    }
    try {
      await checkEndpoint(conn.baseUrl, this.deps.resolve)
    } catch (err) {
      throw new Error(`供应商的地址现在不能用：${errText(err)}`)
    }
    return { ...conn, ...(thinking ? { thinking } : {}), ...(maxTokens ? { maxTokens } : {}) }
  }

  /** 这个会话的 MCP 进程：按需拉起；进程自己退了、或凭证换了，就重起 */
  private async tools(s: Session): Promise<AssistantTools> {
    if (s.idle) clearTimeout(s.idle)
    s.idle = null
    if (s.mcp && s.mcpToken === s.tool.mcp.token) {
      const live = await s.mcp.catch(() => null)
      if (live && !live.closed) return live
    }
    this.closeTools(s)
    s.mcpToken = s.tool.mcp.token
    const starting = AssistantTools.start(s.tool)
    s.mcp = starting
    try {
      return await starting
    } catch (err) {
      if (s.mcp === starting) s.mcp = null
      throw new Error(`Genet 的工具没能起来：${errText(err)}`)
    }
  }

  private closeTools(s: Session): void {
    const mcp = s.mcp
    s.mcp = null
    void mcp?.then((t) => t.close(), () => undefined)
  }

  private armIdle(s: Session): void {
    if (s.idle) clearTimeout(s.idle)
    s.idle = setTimeout(() => {
      s.idle = null
      if (!s.turn) this.closeTools(s)
    }, MCP_IDLE_MS)
    s.idle.unref()
  }

  cancel(sessionId: string): void {
    this.cancelPending(sessionId)
    this.sessions.get(sessionId)?.turn?.abort()
  }

  /** Genet 没有可单独停的子代理 / 命令 */
  killCommand(): boolean {
    return false
  }

  override discardSession(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (s) this.release(s)
    this.sessions.delete(sessionId)
    super.discardSession(sessionId)
  }

  private release(s: Session): void {
    s.turn?.abort()
    if (s.idle) clearTimeout(s.idle)
    s.idle = null
    this.closeTools(s)
  }

  kill(): void {
    this.dead = true
    for (const off of this.unsubscribe) off()
    for (const s of this.sessions.values()) this.release(s)
    this.sessions.clear()
    this.cancelAllPending()
  }
}
