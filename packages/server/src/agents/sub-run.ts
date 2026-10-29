// ---------- AI 互调：run_agent 的执行 ----------
// 调用方（页面上正在跑的 agent）经 MCP 工具 run_agent 把子任务交给另一个 agent：中心在被叫 agent 的适配器上
// 新建会话、发 task、等它做完，把回答带回去。
//   - 被叫只拿到 task（与 task 里的 page: 引用，用 read_page 自己读），看不到调用方的对话；
//   - 被叫的会话凭证 canDispatch=false，工具清单里没有 run_agent（只嵌一层）；
//   - 叫人本身不用批，被叫里的危险操作照常弹审批：会话绑进会话镜像（页面 + 被叫 agent），审批事件走页面的 SSE；
//   - 留痕：调用方的运行里多一个工具步骤（进行中 → 完成），完整的被叫步骤与回答放在这一步的 acp.subRun 里
//     （前端见 web run-detail.ts）；
//   - 页面被停止 / 调用方断开时取消被叫的会话。
// 被叫会话留在适配器进程里（AgentAdapter 没有关会话的接口），随适配器闲置回收一起消失。
// 带队（team.ts）的组员也走这里，带 worker 选项：可以和主会话同一个 agent、占会话镜像的 worker 槽（并行组员的审批互不取消）、
// 不往调用方的运行里写工具步骤（进度归 team 原语）、工作目录可覆盖、审计里记 via。授权判定（resolve / recordUse / authorize）一视同仁。

import { randomUUID } from 'node:crypto'
import { stepLabel, toolCount, type RunEntry } from '@ramet/shared/run-model'
import type { PageTool } from '../page-read.js'
import { authorize, ForbiddenError } from './posture.js'
import type { AdapterEntry, ResolvedAgent } from './manager-types.js'
import { withMemory } from './prompt-env.js'
import { projectAgentEvent } from './remote-run.js'
import { RunRecord } from './run-record.js'
import { createRunState } from './run-state.js'
import type { SessionMirror } from './session-mirror.js'
import type { AgentAdapter, AgentEvent, ConfigOption } from './types.js'

export class SubRunError extends Error {}

export type SubRunHost = {
  resolve(agentId: string, user: { id: string; role: string }): Promise<ResolvedAgent | null>
  ensureAdapter(agent: ResolvedAgent): AdapterEntry
  /** 被叫会话的 MCP 凭证：绑调用方的页面、canDispatch=false */
  calleeTools(entry: AdapterEntry, user: { id: string; role: string }, agent: ResolvedAgent, pageId: string): PageTool[]
  cwd(pageId: string, agent: ResolvedAgent): Promise<string>
  /** 调用方页面所在空间的公共记忆（已渲染的一段，没有就是 ''）：被叫是全新会话，同样要带上 */
  memory(pageId: string): Promise<string>
  mirror: SessionMirror
  /** 往调用方当前运行的记录里写一个工具步骤（没有在跑的运行就丢） */
  attachStep(pageId: string, ev: Extract<AgentEvent, { type: 'tool' }>): void
  /** 页面上的运行被停止时调用 fn；返回取消登记 */
  onPageStop(pageId: string, fn: () => void): () => void
  /** 登记此人在这台机器上有一个在飞的子运行：他的使用授权被收回时要当场取消它；返回取消登记 */
  track(connectorId: string, userId: string, cancel: () => void): () => void
  /** 记一次非主人对机器的使用（machine-grants.ts 的 recordMachineUse；主人自己用不记） */
  recordUse(agent: ResolvedAgent, userId: string, pageId: string, detail: Record<string, unknown>): Promise<void>
}

export type SubRunResult = {
  agent: string
  label: string
  outcome: 'end' | 'cancelled' | 'error'
  steps: number
  ms: number
  output: string
  error?: string
}

/** 带队的组员（team.ts）用的选项；run_agent 不传 */
export type SubRunOpts = {
  /** 组员：不受不能叫自己的限制、占会话镜像的 worker 槽、不写调用方的工具步骤 */
  worker?: boolean
  /** 覆盖工作目录（执行端机器上的路径）；缺省是页面上该 agent 当前的工作区 */
  cwd?: string
  /** 审计里记的发起方式（缺省 run_agent） */
  via?: string
  /** 会话建好、prompt 发出之前：给调用方挂监听的机会（组员等审批的时段）；返回的函数在子运行收尾时调用 */
  onReady?: (h: { sessionId: string; adapter: AgentAdapter }) => (() => void) | void
}

const MAX_TRACE = 80
const clip = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n)}…` : text)

/** 被叫的步骤瘦身成留痕形态：只留一行字 / 类型 / 状态 / 时间，不带 ACP 原始载荷与子代理正文（体积有界） */
function trace(entries: RunEntry[]): Array<Record<string, unknown>> {
  return entries.slice(0, MAX_TRACE).map((e) => ({
    k: e.k,
    ...(e.k === 'tool' ? { kind: e.kind, status: e.status } : {}),
    text: clip(stepLabel(e), 300),
    ...(e.t !== undefined ? { t: e.t } : {}),
    ...(e.end !== undefined ? { end: e.end } : {}),
  }))
}

export async function runSubAgent(
  host: SubRunHost,
  ctx: { pageId: string; callerAgentId: string; user: { id: string; role: string } },
  callee: { id: string; label: string },
  task: string,
  signal: AbortSignal,
  opts: SubRunOpts = {},
): Promise<SubRunResult> {
  if (!opts.worker && callee.id === ctx.callerAgentId) throw new SubRunError('不能叫自己；同一个 agent 的子任务请直接做')
  // 授权主体是发起这一轮的用户（MCP 凭证绑定的人）：被叫的机器他不能用就不能叫，不论调用方 agent 在谁的机器上
  let agent: Awaited<ReturnType<SubRunHost['resolve']>>
  try {
    agent = await host.resolve(callee.id, ctx.user)
  } catch (err) {
    if (err instanceof ForbiddenError) throw new SubRunError(err.message)
    throw err
  }
  if (!agent) throw new SubRunError('找不到这个 agent，或你没有权限使用它')
  await host.recordUse(agent, ctx.user.id, ctx.pageId, { agent: agent.id, via: opts.via ?? 'run_agent', task: clip(task.replace(/\s+/g, ' ').trim(), 200) })
  let entry: AdapterEntry
  let sessionId: string
  let modes: ConfigOption[]
  try {
    entry = host.ensureAdapter(agent)
    const created = await entry.adapter.newSession(opts.cwd || (await host.cwd(ctx.pageId, agent)), host.calleeTools(entry, ctx.user, agent, ctx.pageId))
    sessionId = created.sessionId
    modes = created.configOptions
  } catch (err) {
    throw new SubRunError(`启动 ${callee.label} 失败：${err instanceof Error ? err.message : String(err)}`)
  }
  // 审批要能弹出来：绑进会话镜像（否则被叫会话里的 request_permission 没人收，会一直挂着）。
  // 组员占自己的 worker 槽（同一个 agent 的主会话 / 别的组员的审批不能被它顶掉）
  const releaseWorker = opts.worker ? host.mirror.bindWorker(ctx.pageId, agent.id, sessionId, entry.adapter) : undefined
  if (!opts.worker) host.mirror.bind(ctx.pageId, agent.id, sessionId, entry.adapter)
  try {
    // 跳过全部确认只有机器主人能发起：被叫会话就在该档而发起人不是主人，就不跑
    authorize(ctx.user, agent, {
      kind: 'run',
      mode: (opts.worker ? modes : host.mirror.configs(ctx.pageId, agent.id)).find((o) => o.category === 'mode')?.currentValue,
    })
  } catch (err) {
    releaseWorker?.()
    throw err
  }
  // 会话准备期间就被取消了（页面停止 / 调用方断开）：不发 prompt
  if (signal.aborted) {
    releaseWorker?.()
    return { agent: agent.id, label: callee.label, outcome: 'cancelled', steps: 0, ms: 0, output: '' }
  }

  const stepId = `sub-${randomUUID()}`
  const title = `叫 ${callee.label}：${clip(task.replace(/\s+/g, ' ').trim(), 60)}`
  if (!opts.worker) {
    host.attachStep(ctx.pageId, { type: 'tool', id: stepId, kind: 'other', title, status: 'in_progress', activity: `${callee.label} 运行中…` })
  }

  const subRun = createRunState({
    pageId: ctx.pageId,
    userId: ctx.user.id,
    adapterKey: agent.id,
    remote: agent.remote ? { connectorId: agent.remote.connectorId, agentId: agent.remote.agentId } : null,
  })
  const record = new RunRecord('', subRun.startedAt, () => undefined)
  const off = entry.adapter.on((ev) => projectAgentEvent(subRun, record, ev, undefined, sessionId))
  const cancel = (): void => entry.adapter.cancel(sessionId)
  signal.addEventListener('abort', cancel)
  const unregister = host.onPageStop(ctx.pageId, cancel)
  const untrack = agent.remote ? host.track(agent.remote.connectorId, ctx.user.id, cancel) : () => undefined
  const offReady = opts.onReady?.({ sessionId, adapter: entry.adapter })
  let stopReason: string | undefined
  let error: string | undefined
  try {
    // 被叫的会话是新建的、看不到调用方的对话；空间的公共记忆（成员确认过的约定）对所有 agent 一视同仁，照常带上
    const memory = await host.memory(ctx.pageId)
    // 取记忆的这一小段里就被取消了：那条 cancel 发在 prompt 之前，agent 会当没发生过，所以这里不能再发 prompt
    if (signal.aborted) stopReason = 'cancelled'
    else stopReason = (await entry.adapter.prompt(sessionId, [{ type: 'text', text: withMemory(memory, task) }], randomUUID())).stopReason
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    off()
    signal.removeEventListener('abort', cancel)
    unregister()
    untrack()
    offReady?.()
    releaseWorker?.()
  }
  const ms = record.close()
  const outcome: SubRunResult['outcome'] = error ? 'error' : stopReason === 'cancelled' || signal.aborted ? 'cancelled' : 'end'
  const output = record.state.text.trim()
  const result: SubRunResult = {
    agent: agent.id,
    label: callee.label,
    outcome,
    steps: toolCount(record.state),
    ms,
    output,
    ...(error ? { error } : {}),
  }
  if (!opts.worker) {
    host.attachStep(ctx.pageId, {
      type: 'tool',
      id: stepId,
      status: outcome === 'end' ? 'completed' : 'failed',
      activity: '',
      ...(error ? { note: clip(error, 200) } : {}),
      acp: { subRun: { agent: agent.id, label: callee.label, task, outcome, ms, output, entries: trace(record.state.entries) } },
    })
  }
  return result
}
