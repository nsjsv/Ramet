// ---------- codex app-server 的通知 → AgentEvent ----------
// 一个驱动一个翻译器：子代理是独立的线程，它的通知以子线程 id 发来，要按「子线程 → 主会话 + 唤起它的那一步」投影，
// 这张表跨线程，所以不按会话拆。主线程的回合匹配（丢掉被强制收尾的旧回合的晚到通知）、用量、回合收尾由驱动先处理，
// 这里只翻译过程：
//
//   item/agentMessage/delta                       → text（子线程的带 parentId = 唤起它的那一步，进那一步的子代理正文）
//   item/reasoning/summaryTextDelta | textDelta   → thought（同一条目只认先到的那一种，免得摘要与原文各来一遍）
//   item/started（工具类条目）                     → tool（kind / 标题 / 视图由 tools.ts 算，in_progress）
//   item/commandExecution/outputDelta             → terminal 原料事件（实时输出进那一步的 output）
//   item/fileChange/patchUpdated                  → tool 增量（diffs）
//   item/completed                                → tool 增量（状态、结果、退出码、最终 diff）；没逐字流过的正文 / 思考整块补发
//   collabAgentToolCall（spawnAgent 等）          → 一步子代理（view.handle = 子线程 id，可单独停）；状态跟着子线程的回合走
//   子线程 turn/started | turn/completed          → 那一步 in_progress / completed / failed（被中断 = 已停止）
//   turn/plan/updated（主线程）                   → plan
//   thread/compacted、model/rerouted              → info

import { normalizePlan, type RunInfo } from '@ramet/shared/run-model'
import type { AgentEvent } from '../../types.js'
import { clipDiffs, clipValue, NOTE_MAX, oneLine, rec, str, stripAnsi } from '../tool-text.js'
import type { CollabAgentStatus, FileUpdateChange, ServerNotifications, ThreadItem, Turn } from './protocol.js'
import { changeDiffs, isStepItem, itemDone, itemFace, type ItemFace } from './tools.js'

/** 一条线程在 Ramet 里的归属：主线程 = 会话本身；子线程 = 会话里的某一步子代理 */
type Ctx = {
  sessionId: string
  /** 子线程：唤起它的那一步；主线程没有 */
  parentId?: string
  /** 子线程当前回合（单独停止它用） */
  turnId?: string
  live: boolean
  /** 上一段正文还没被工具 / 思考隔开：下一条消息条目开头补一个空行，免得两条消息首尾粘在一起 */
  textOpen: boolean
}

type Seen = { kind: 'text' | 'thought'; ctx: Ctx; streamed: boolean; mode?: 'summary' | 'raw' }

/** 子代理那一步 */
type Collab = { sessionId: string; receivers: Set<string>; closed: boolean }

/** 只有让子代理干活的协作调用才开一步；wait / closeAgent 等只用来对齐子代理的终态 */
const OPENS_STEP: ReadonlySet<string> = new Set(['spawnAgent', 'sendInput', 'resumeAgent', 'followupTask', 'sendMessage'])
const TERMINAL: ReadonlySet<CollabAgentStatus> = new Set(['completed', 'interrupted', 'errored', 'shutdown', 'notFound'])
/** 父线程还没告诉我们归属时，子线程先到的通知最多攒这么多条 */
const BUFFER_MAX = 500

/** 进 info 的原样元数据（info.acp 是「agent 原样元数据」那一格，按通知名存最近一份） */
function metaInfo(key: string, params: unknown): RunInfo {
  const { value, truncated } = clipValue(params)
  return { acp: { [key]: value }, ...(truncated ? { truncated: true } : {}) }
}

const PLAN_STATUS: Record<string, string> = { inProgress: 'in_progress', pending: 'pending', completed: 'completed' }

export class CodexEvents {
  private readonly contexts = new Map<string, Ctx>()
  private readonly seen = new Map<string, Seen>()
  /** 工具条目开始时算出的样子：审批卡要用（文件改动的审批请求里只有条目 id） */
  private readonly faces = new Map<string, { face: ItemFace; sessionId: string }>()
  private readonly collabs = new Map<string, Collab>()
  /** 父线程已知、但还不知道挂在哪一步的子线程 → 攒着的通知 */
  private readonly pending = new Map<string, { sessionId: string; notes: Array<{ method: string; params: unknown }> }>()

  constructor(private readonly emit: (ev: AgentEvent) => void) {}

  /** 主线程（会话）登记：之后它的通知按这个会话投影 */
  addSession(sessionId: string): void {
    this.contexts.set(sessionId, { sessionId, live: false, textOpen: false })
  }

  dropSession(sessionId: string): void {
    this.endTurn(sessionId, false)
    this.contexts.delete(sessionId)
  }

  faceOf(itemId: string): ItemFace | undefined {
    return this.faces.get(itemId)?.face
  }

  /** 线程属于哪个会话（审批请求按它路由）；不认识返回 undefined */
  sessionOf(threadId: string): string | undefined {
    return this.contexts.get(threadId)?.sessionId
  }

  /** 子代理那一步当前可停：返回子线程正在跑的回合 */
  childTurn(sessionId: string, threadId: string): string | undefined {
    const ctx = this.contexts.get(threadId)
    if (!ctx?.parentId || ctx.sessionId !== sessionId || !ctx.live) return undefined
    return ctx.turnId
  }

  /** 主线程一轮开始：正文分段状态复位 */
  beginTurn(sessionId: string): void {
    const ctx = this.contexts.get(sessionId)
    if (ctx) ctx.textOpen = false
  }

  /** 主线程一轮结束（含强制收尾）：还开着的子代理步骤收掉，子线程的归属作废（之后的晚到通知不再落到下一轮上） */
  endTurn(sessionId: string, cancelled: boolean): void {
    for (const [id, c] of this.collabs) {
      if (c.sessionId !== sessionId) continue
      if (!c.closed) {
        this.emit({ type: 'tool', id, status: cancelled ? 'failed' : 'completed', activity: '', ...(cancelled ? { note: '已停止' } : {}), sessionId })
      }
      this.collabs.delete(id)
    }
    for (const [threadId, ctx] of this.contexts) {
      if (ctx.parentId && ctx.sessionId === sessionId) this.contexts.delete(threadId)
    }
    for (const [itemId, s] of this.seen) if (s.ctx.sessionId === sessionId) this.seen.delete(itemId)
    for (const [itemId, f] of this.faces) if (f.sessionId === sessionId) this.faces.delete(itemId)
    for (const [threadId, b] of this.pending) if (b.sessionId === sessionId) this.pending.delete(threadId)
  }

  handle(method: string, params: unknown): void {
    const p = rec(params)
    if (method === 'thread/started') return this.onThreadStarted(rec(p.thread))
    const threadId = str(p.threadId)
    const ctx = this.contexts.get(threadId)
    if (!ctx) {
      const buf = this.pending.get(threadId)
      if (buf && buf.notes.length < BUFFER_MAX) buf.notes.push({ method, params })
      return
    }
    switch (method) {
      case 'item/started':
        return this.itemStarted(ctx, p.item as ThreadItem)
      case 'item/completed':
        return this.itemCompleted(ctx, p.item as ThreadItem)
      case 'item/agentMessage/delta':
        return this.text(ctx, str(p.itemId), str(p.delta))
      case 'item/reasoning/summaryTextDelta':
        return this.thought(ctx, str(p.itemId), str(p.delta), 'summary')
      case 'item/reasoning/textDelta':
        return this.thought(ctx, str(p.itemId), str(p.delta), 'raw')
      case 'item/reasoning/summaryPartAdded':
        return this.summaryPart(ctx, str(p.itemId), Number(p.summaryIndex) || 0)
      case 'item/commandExecution/outputDelta': {
        const delta = stripAnsi(str(p.delta))
        if (delta) this.emit({ type: 'terminal', id: str(p.itemId), delta, sessionId: ctx.sessionId })
        return
      }
      case 'item/fileChange/patchUpdated': {
        const changes = Array.isArray(p.changes) ? (p.changes as FileUpdateChange[]) : []
        const { diffs, truncated } = clipDiffs(changes.flatMap(changeDiffs))
        return this.emit({ type: 'tool', id: str(p.itemId), view: { diffs }, ...(truncated ? { truncated: true } : {}), sessionId: ctx.sessionId })
      }
      case 'item/mcpToolCall/progress': {
        const activity = oneLine(str(p.message))
        if (activity) this.emit({ type: 'tool', id: str(p.itemId), activity, sessionId: ctx.sessionId })
        return
      }
      case 'turn/started':
        if (ctx.parentId) this.childStarted(ctx, threadId, rec(p.turn) as unknown as Turn)
        return
      case 'turn/completed':
        if (ctx.parentId) this.childEnded(ctx, rec(p.turn) as unknown as Turn)
        return
      case 'turn/plan/updated': {
        // 子代理的计划不顶掉主回合的计划清单
        if (ctx.parentId) return
        const plan = (params as ServerNotifications['turn/plan/updated']).plan ?? []
        const { entries, truncated } = normalizePlan(plan.map((e) => ({ content: e.step, status: PLAN_STATUS[e.status] ?? e.status })))
        return this.emit({ type: 'plan', entries, ...(truncated ? { truncated: true } : {}), sessionId: ctx.sessionId })
      }
      case 'thread/compacted':
      case 'model/rerouted':
        if (!ctx.parentId) this.emit({ type: 'info', info: metaInfo(method, params), sessionId: ctx.sessionId })
        return
      default:
    }
  }

  // ---------- 正文 / 思考 ----------

  private track(ctx: Ctx, itemId: string, kind: Seen['kind']): Seen {
    let s = this.seen.get(itemId)
    if (!s) {
      s = { kind, ctx, streamed: false }
      this.seen.set(itemId, s)
    }
    return s
  }

  private say(ctx: Ctx, delta: string): void {
    if (!delta) return
    ctx.textOpen = true
    this.emit({ type: 'text', delta, sessionId: ctx.sessionId, ...(ctx.parentId ? { parentId: ctx.parentId } : {}) })
  }

  private text(ctx: Ctx, itemId: string, delta: string): void {
    if (!delta) return
    const s = this.track(ctx, itemId, 'text')
    // 新的一条消息：上一段还没被工具 / 思考隔开时补一个空行
    if (!s.streamed && ctx.textOpen) this.say(ctx, '\n\n')
    s.streamed = true
    this.say(ctx, delta)
  }

  private thought(ctx: Ctx, itemId: string, delta: string, mode: 'summary' | 'raw'): void {
    if (!delta) return
    const s = this.track(ctx, itemId, 'thought')
    if (s.mode && s.mode !== mode) return
    s.mode = mode
    s.streamed = true
    ctx.textOpen = false
    this.emit({ type: 'thought', delta, sessionId: ctx.sessionId, ...(ctx.parentId ? { parentId: ctx.parentId } : {}) })
  }

  /** 摘要的新一段：段与段之间空一行 */
  private summaryPart(ctx: Ctx, itemId: string, index: number): void {
    const s = this.track(ctx, itemId, 'thought')
    if (s.mode !== 'raw' && index > 0 && s.streamed) this.thought(ctx, itemId, '\n\n', 'summary')
  }

  // ---------- 条目 ----------

  private itemStarted(ctx: Ctx, item: ThreadItem): void {
    if (!item || typeof item !== 'object') return
    if (item.type === 'agentMessage') return void this.track(ctx, item.id, 'text')
    if (item.type === 'reasoning') {
      ctx.textOpen = false
      return void this.track(ctx, item.id, 'thought')
    }
    if (item.type === 'collabAgentToolCall') return this.collab(ctx, item)
    if (!isStepItem(item)) return
    ctx.textOpen = false
    const face = itemFace(item)
    this.faces.set(item.id, { face, sessionId: ctx.sessionId })
    this.emit({
      type: 'tool',
      id: item.id,
      kind: face.kind,
      title: face.title,
      status: 'in_progress',
      ...(face.detail ? { detail: face.detail } : {}),
      view: face.view,
      ...(face.truncated ? { truncated: true } : {}),
      ...(ctx.parentId ? { parentId: ctx.parentId } : {}),
      sessionId: ctx.sessionId,
    })
    // 子代理那一步的一行字跟着它正在做的事走
    if (ctx.parentId) this.emit({ type: 'tool', id: ctx.parentId, activity: face.title, sessionId: ctx.sessionId })
  }

  private itemCompleted(ctx: Ctx, item: ThreadItem): void {
    if (!item || typeof item !== 'object') return
    if (item.type === 'agentMessage' || item.type === 'reasoning') {
      const s = this.seen.get(item.id)
      this.seen.delete(item.id)
      if (s?.streamed) return
      // 没逐字流过（子线程、或 codex 只发了整块）：整块补发
      if (item.type === 'agentMessage') {
        if (item.text && ctx.textOpen) this.say(ctx, '\n\n')
        this.say(ctx, item.text)
      } else {
        const parts = (item.summary?.length ? item.summary : item.content ?? []).filter(Boolean)
        if (parts.length > 0) {
          ctx.textOpen = false
          this.emit({ type: 'thought', delta: parts.join('\n\n'), sessionId: ctx.sessionId, ...(ctx.parentId ? { parentId: ctx.parentId } : {}) })
        }
      }
      return
    }
    if (item.type === 'collabAgentToolCall') return this.collab(ctx, item)
    if (!isStepItem(item)) return
    if (!this.faces.has(item.id)) this.itemStarted(ctx, item)
    const done = itemDone(item)
    this.emit({
      type: 'tool',
      id: item.id,
      status: done.status,
      view: done.view,
      ...(done.note ? { note: done.note } : {}),
      ...(done.truncated ? { truncated: true } : {}),
      sessionId: ctx.sessionId,
    })
  }

  // ---------- 子代理 ----------

  /** 父线程报了子线程（thread/started 带 parentThreadId），但还不知道它挂在哪一步：先攒着它的通知 */
  private onThreadStarted(thread: Record<string, unknown>): void {
    const id = str(thread.id)
    const parent = str(thread.parentThreadId)
    const owner = this.contexts.get(parent)
    if (id && owner && !this.contexts.has(id) && !this.pending.has(id)) this.pending.set(id, { sessionId: owner.sessionId, notes: [] })
  }

  private collab(ctx: Ctx, item: Extract<ThreadItem, { type: 'collabAgentToolCall' }>): void {
    const receivers = (Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []).filter((r) => r && !this.contexts.has(r))
    let step = this.collabs.get(item.id)
    // spawnAgent 开始时子线程可能还没建（receiverThreadIds 为空），照样开一步；别的协作调用只在带来新的子线程时开
    if (!step && OPENS_STEP.has(item.tool) && (item.tool === 'spawnAgent' || receivers.length > 0)) {
      step = { sessionId: ctx.sessionId, receivers: new Set(), closed: false }
      this.collabs.set(item.id, step)
      const raw = clipValue({ tool: item.tool, prompt: item.prompt, model: item.model, reasoningEffort: item.reasoningEffort })
      this.emit({
        type: 'tool',
        id: item.id,
        kind: 'think',
        title: oneLine(item.prompt ?? '') || '子代理',
        status: 'in_progress',
        view: { tool: 'collabAgent', raw: { input: raw.value } },
        ...(raw.truncated ? { truncated: true } : {}),
        ...(ctx.parentId ? { parentId: ctx.parentId } : {}),
        sessionId: ctx.sessionId,
      })
    }
    if (step) {
      for (const r of receivers) this.adopt(step, item.id, r)
      // 子代理没起来：这一步直接失败；起来了的由子线程自己的回合决定这一步的状态
      if (item.status === 'failed' && !step.closed) this.closeStep(item.id, step, 'failed', '子代理没有启动')
    }
    // 任何协作调用（含 wait）报的终态都对齐一遍：子线程的 turn/completed 万一没到，这一步也能收尾
    for (const [threadId, state] of Object.entries(item.agentsStates ?? {})) {
      if (!state || !TERMINAL.has(state.status)) continue
      const child = this.contexts.get(threadId)
      if (!child?.parentId) continue
      child.live = false
      const owner = this.collabs.get(child.parentId)
      if (owner && !owner.closed && [...owner.receivers].every((r) => !this.contexts.get(r)?.live)) {
        const ok = state.status === 'completed'
        this.closeStep(child.parentId, owner, ok ? 'completed' : 'failed', ok ? undefined : state.status === 'interrupted' ? '已停止' : state.message ?? state.status)
      }
    }
  }

  /** 子线程挂到这一步下：之后它的通知都按这一步投影；先到的攒着的通知补放 */
  private adopt(step: Collab, stepId: string, threadId: string): void {
    step.receivers.add(threadId)
    this.contexts.set(threadId, { sessionId: step.sessionId, parentId: stepId, live: false, textOpen: false })
    if (step.receivers.size === 1) this.emit({ type: 'tool', id: stepId, view: { handle: threadId }, sessionId: step.sessionId })
    const buffered = this.pending.get(threadId)?.notes ?? []
    this.pending.delete(threadId)
    for (const n of buffered) this.handle(n.method, n.params)
  }

  private closeStep(stepId: string, step: Collab, status: 'completed' | 'failed', note?: string): void {
    step.closed = true
    this.emit({ type: 'tool', id: stepId, status, activity: '', ...(note ? { note: oneLine(note, NOTE_MAX) } : {}), sessionId: step.sessionId })
  }

  private childStarted(ctx: Ctx, threadId: string, turn: Turn): void {
    ctx.turnId = str(turn.id) || ctx.turnId
    ctx.live = true
    ctx.textOpen = false
    const step = this.collabs.get(ctx.parentId!)
    if (!step) return
    step.closed = false
    this.emit({ type: 'tool', id: ctx.parentId!, status: 'in_progress', view: { handle: threadId }, sessionId: ctx.sessionId })
  }

  private childEnded(ctx: Ctx, turn: Turn): void {
    ctx.live = false
    const step = this.collabs.get(ctx.parentId!)
    if (!step || step.closed) return
    // 一步唤起了几个子代理：都结束了这一步才收尾
    if ([...step.receivers].some((r) => this.contexts.get(r)?.live)) return
    if (turn.status === 'completed') this.closeStep(ctx.parentId!, step, 'completed')
    else if (turn.status === 'interrupted') this.closeStep(ctx.parentId!, step, 'failed', '已停止')
    else this.closeStep(ctx.parentId!, step, 'failed', turn.error?.message ?? '子代理出错')
  }
}
