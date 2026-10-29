// ---------- 带队的执行：提示词、组员调度、打回重做 ----------
// 带队的两种轮（计划轮 / 执行轮，见 team-plan.ts）都是普通的一轮，但会话口径与普通对话不同：
//   - 都新建会话、不复用任何旧会话；会话记录（agent_session.sessions）和收尾 hash 都不写：带队说明（计划轮的组员清单、执行轮的
//     组员结果）只拼在发给组长的这一条提示词末尾，不在文档里，hash 按文档算就对不上。后果：带队之后的下一轮普通对话，文档已经变长，
//     基线 hash 与旧记录不等，会新建会话全文重放一次，之后恢复原生续聊。旧会话记录原样保留（没被带队改写）；
//   - 没有带队时 turn.ts 的路径与 hash 逐字节不变（只在 run.team 非空时才走这里）。
// 执行轮的顺序（turn.ts 调 startExecRound）：先由中心把计划里的组员按依赖跑完（并行 ≤ 4，每个组员是 sub-run.ts 的一个子运行：
// 新会话、只拿任务文本 + 总目标 + 前置任务结果 + 公共记忆、审批进会话镜像的 worker 槽 / 收件箱、页面停止即取消、授权收回即取消），
// 再建组长会话，把各组员的结果作为附录拼在提示词后面，组长交叉审查，可调 send_back 打回重做。
// 每个组员的起止 / 等审批的时段写进本轮 RunRecord 的 team 原语（甘特的数据源）。
//
// 安全：每个组员真正派发前都经 runSubAgent 里的 manager.resolve 再判一次发起人对那台机器的使用权
// （中途被收回，该任务 failed 并写原因，其它照常）；非机器主人的使用照常留痕（via: 'team'）；组员的会话凭证 canDispatch=false，
// 没有 run_agent、也没有 submit_plan / send_back（这两个只有组长那一轮的凭证带 team 上下文）。
import { TEAM_LIMITS, type TeamTaskPatch, type TeamTaskStatus } from '@ramet/shared/run-model'
import type { RunRecord } from './run-record.js'
import type { RunState } from './run-state.js'
import { runSubAgent, type SubRunHost, type SubRunResult } from './sub-run.js'
import { draftState, teamStatusOf, type PlanRow, type PlanTask, type TeamPlans, type UserRef } from './team-plan.js'
import type { AgentAdapter } from './types.js'

/** 组长工具（submit_plan / send_back）的业务错误：端点原样回给组长，让它改了重来 */
export class TeamToolError extends Error {}

const clip = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n)}…` : text)

/** 用户消息是 `/带队 <目标>` 就返回目标文字（可为空串），否则 null。`/带队` 后面必须是空白或结尾 */
export function planGoalOf(message: string | null): string | null {
  const m = /^\s*\/带队(?=\s|$)([\s\S]*)$/.exec(message ?? '')
  return m ? m[1]!.trim().slice(0, TEAM_LIMITS.goal) : null
}

// ---------- 提示词 ----------

/** 计划轮：拼在发给组长的提示词末尾的说明（不进文档，见文件头） */
export function planNote(candidates: ReadonlyArray<{ id: string; label: string }>): string {
  return [
    '[Ramet 带队·出计划]',
    '你是这次任务的组长。上面最后一条用户消息里 /带队 后面的文字就是总目标。',
    '这一轮只做一件事：把总目标拆成几个任务，调用工具 submit_plan 提交计划，让用户先审阅。不要自己动手做任何任务（不要改文件、不要跑命令），也不要等用户回复——提交后用一两句话说明你的拆法就结束。',
    '可用的组员（assignee 填括号前的 id；同一个组员可以分到多个任务，也可以分给你自己）：',
    ...candidates.map((a) => `- ${a.id}（${a.label}）`),
    '计划要求：',
    `- 任务 1–${TEAM_LIMITS.tasks} 个；每个任务有唯一的 id（字母、数字、- 或 _，最长 32 个字符）、标题 title、说明 detail、负责人 assignee、依赖 dependsOn（填它必须等的任务 id；没有依赖的任务会并行开工）。`,
    '- detail 要让组员不看这段对话也能开工：目标、范围、要读的页面（用 page:<页面id> 引用，组员自己用 read_page 读）、验收标准。',
    '- 并行的任务尽量别改同一批文件（Ramet 不处理冲突）。',
    '- 用户会在计划卡上改标题、换负责人、指定工作目录，确认后才开工。',
  ].join('\n')
}

const WORKER_INTRO = [
  '[Ramet 带队·组员]',
  '你是一次多 agent 协作里的组员，负责下面这一个任务。组长和其它组员看不到你的会话，你只需要把自己的任务做好，最后用文字交付结果：做了什么、改了哪些文件、结论和遗留问题（写摘要，不要贴大段代码）。',
].join('\n')

function outputOf(rt: TaskRt, max: number): string {
  return rt.output ? clip(rt.output, max) : '（它没有给出文字回答）'
}

// ---------- 组员调度 ----------

type TaskRt = {
  task: PlanTask
  status: TeamTaskStatus
  /** 最近一次交付的完整结果（原文，提示词里按需截；team 原语里只带摘要） */
  output: string
  error?: string
  backs: number
  steps: number
  ac?: AbortController
}

const RESULT_IN_APPENDIX = 8000
const RESULT_AS_PREREQUISITE = 3000
const RESULT_KEPT = 20_000

const BLOCKED: ReadonlySet<TeamTaskStatus> = new Set(['failed', 'skipped', 'cancelled'])

export class TeamExec {
  private rt = new Map<string, TaskRt>()
  private stopped = false
  private unstop: (() => void) | null = null

  constructor(
    private sub: SubRunHost,
    private run: RunState,
    private record: RunRecord,
    private user: UserRef,
    private plan: { goal: string; title: string; tasks: PlanTask[] },
  ) {
    for (const task of plan.tasks) this.rt.set(task.id, { task, status: 'pending', output: '', backs: 0, steps: 0 })
  }

  /** 页面上的运行被停止时取消全部组员（含打回重做中的）；执行轮结束前一直有效，所以 send_back 也在内 */
  open(): void {
    this.unstop = this.sub.onPageStop(this.run.pageId, () => this.cancelAll())
  }

  close(): void {
    this.cancelAll()
    this.unstop?.()
    this.unstop = null
  }

  /** 取消全部组员（页面停止 / 发起人对组长机器的授权被收回 / 服务关停）：在跑的取消，没开始的不再开始 */
  cancelAll(): void {
    this.stopped = true
    for (const rt of this.rt.values()) rt.ac?.abort()
  }

  private halted(): boolean {
    return this.stopped || this.run.cancelled || this.run.hold || this.run.shutdown
  }

  private emit(rt: TaskRt, patch?: TeamTaskPatch, span?: 'open' | 'close'): void {
    this.record.team({ op: 'task', id: rt.task.id, ...(patch ? { patch } : {}), ...(span ? { span } : {}) })
  }

  /** 按依赖把组员跑完：并行 ≤ 4；前置任务没做成（出错 / 跳过 / 取消）则下游跳过；被停止则没开始的取消 */
  async runAll(): Promise<void> {
    const running = new Map<string, Promise<void>>()
    for (;;) {
      if (this.halted()) this.cancelAll()
      this.settleBlocked()
      if (!this.stopped) {
        for (const rt of this.rt.values()) {
          if (running.size >= TEAM_LIMITS.parallel) break
          if (rt.status !== 'pending' || !rt.task.dependsOn.every((id) => this.rt.get(id)?.status === 'done')) continue
          running.set(rt.task.id, this.runTask(rt).finally(() => running.delete(rt.task.id)))
        }
      }
      if (running.size === 0) break
      await Promise.race(running.values())
    }
    // 理论上不会有还没开始的（环在提交时就拒了）；兜底，别留下永远 pending 的任务
    for (const rt of this.rt.values()) {
      if (rt.status !== 'pending') continue
      rt.status = 'skipped'
      this.emit(rt, { status: 'skipped' })
    }
  }

  /** 没开始的任务里：被停止的置 cancelled，前置任务没做成的置 skipped（连锁传播到不再变化） */
  private settleBlocked(): void {
    for (let changed = true; changed; ) {
      changed = false
      for (const rt of this.rt.values()) {
        if (rt.status !== 'pending') continue
        const blocker = rt.task.dependsOn.map((id) => this.rt.get(id)).find((dep) => dep && BLOCKED.has(dep.status))
        if (!this.stopped && !blocker) continue
        rt.status = this.stopped ? 'cancelled' : 'skipped'
        if (!this.stopped && blocker) rt.error = `前置任务「${blocker.task.title}」没有完成`
        this.emit(rt, { status: rt.status, ...(rt.error ? { error: rt.error } : {}) })
        changed = true
      }
    }
  }

  private async runTask(rt: TaskRt): Promise<void> {
    const ac = (rt.ac = new AbortController())
    await this.execute(rt, this.taskText(rt.task), ac.signal)
  }

  /** 派一个组员干一次活（首次 / 打回重做共用）：状态 running + 开一段时间 → 子运行 → 收口。
   *  派发前的授权判定在 runSubAgent 里（resolve + 留痕），这里只管把结果翻成任务状态 */
  private async execute(rt: TaskRt, text: string, signal: AbortSignal): Promise<void> {
    const { task } = rt
    rt.status = 'running'
    this.emit(rt, { status: 'running', backs: rt.backs }, 'open')
    let status: TeamTaskStatus = 'failed'
    let error: string | undefined
    try {
      const res = await runSubAgent(
        this.sub,
        { pageId: this.run.pageId, callerAgentId: this.run.adapterKey, user: this.user },
        { id: task.assignee, label: task.label || task.assignee },
        text,
        signal,
        { worker: true, via: 'team', ...(task.cwd ? { cwd: task.cwd } : {}), onReady: (h) => this.watchWaits(task.id, h) },
      )
      rt.output = clip(res.output, RESULT_KEPT)
      rt.steps = res.steps
      if (res.outcome === 'end') status = 'done'
      else if (res.outcome === 'error') error = res.error ?? '组员出错了'
      // 取消有两种来历：页面停止 / 整轮被取消记 cancelled；其余（该机器上的使用授权被收回等）是这个任务自己被中止，记出错并写明原因
      else if (this.halted() || signal.aborted) status = 'cancelled'
      else error = '任务被中止了（可能是你对这台机器的使用授权已被收回）'
    } catch (err) {
      // 派发前的授权判定没过（授权被收回 / 机器离线 / 没权限）也走这里：原因原样写进任务
      error = err instanceof Error ? err.message : String(err)
    }
    rt.status = status
    if (error) rt.error = error
    else delete rt.error
    this.emit(rt, { status, steps: rt.steps, output: rt.output, ...(error ? { error } : {}) }, 'close')
  }

  /** 组员等审批的时段：它的会话里有待批审批就开一段等待，全部答完或被停止就收口（甘特上打斜线） */
  private watchWaits(taskId: string, h: { sessionId: string; adapter: AgentAdapter }): () => void {
    const waiting = new Set<string>()
    return h.adapter.on((ev) => {
      if ((ev.type !== 'permission' && ev.type !== 'permission_resolved') || ev.sessionId !== h.sessionId) return
      const before = waiting.size
      if (ev.type === 'permission') waiting.add(ev.requestId)
      else waiting.delete(ev.requestId)
      if (before === 0 && waiting.size > 0) this.record.team({ op: 'task', id: taskId, wait: 'open' })
      else if (before > 0 && waiting.size === 0) this.record.team({ op: 'task', id: taskId, wait: 'close' })
    })
  }

  private taskText(task: PlanTask): string {
    const prerequisites = task.dependsOn
      .map((id) => this.rt.get(id))
      .filter((dep): dep is TaskRt => dep?.status === 'done')
      .map((dep) => `### 任务 ${dep.task.id}「${dep.task.title}」的结果\n${outputOf(dep, RESULT_AS_PREREQUISITE)}`)
    return [
      WORKER_INTRO,
      this.plan.goal ? `总目标：${this.plan.goal}` : '',
      `任务编号：${task.id}`,
      `任务：${task.title}`,
      task.detail ? `任务说明：\n${task.detail}` : '',
      prerequisites.length > 0 ? `前置任务已经做完，它们的结果供你参考：\n\n${prerequisites.join('\n\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  // ---------- 组长的 send_back ----------

  /** 组长审查后把某个任务打回重做（同步：等组员重新交付，返回新结果）。
   *  只能打回已经交付 / 出错的任务（重做中的、没做过的都拒）；每个任务最多 TEAM_LIMITS.sendBack 次。
   *  次数与重做中的占位是同步完成的（中间没有 await），并发的两次打回只有一次进得去 */
  async sendBack(taskId: string, feedback: string, signal: AbortSignal): Promise<SubRunResult> {
    const rt = this.rt.get(taskId)
    if (!rt) throw new TeamToolError(`计划里没有任务 ${taskId}`)
    const note = feedback.trim()
    if (!note) throw new TeamToolError('feedback 不能为空：写清楚要组员改什么')
    if (note.length > TEAM_LIMITS.detail) throw new TeamToolError(`feedback 不能超过 ${TEAM_LIMITS.detail} 字`)
    if (this.halted()) throw new TeamToolError('这一轮已经被停止了')
    if (rt.status === 'running') throw new TeamToolError(`任务 ${taskId} 正在重做，等它交付之后再审查`)
    if (rt.status !== 'done' && rt.status !== 'failed') throw new TeamToolError(`任务 ${taskId} 没有交付过结果，不能打回`)
    if (rt.backs >= TEAM_LIMITS.sendBack) {
      throw new TeamToolError(`任务 ${taskId} 已经被打回 ${rt.backs} 次，不能再打回了；还没解决的问题请写进你的总结`)
    }
    rt.backs += 1
    rt.status = 'running'
    const ac = (rt.ac = new AbortController())
    const onAbort = (): void => ac.abort()
    signal.addEventListener('abort', onAbort)
    const startedAt = Date.now()
    try {
      await this.execute(rt, this.redoText(rt, note), ac.signal)
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
    const final: TeamTaskStatus = this.rt.get(taskId)!.status // execute 里改的，TS 看不到跨 await 的变化
    return {
      agent: rt.task.assignee,
      label: rt.task.label || rt.task.assignee,
      outcome: final === 'done' ? 'end' : final === 'cancelled' ? 'cancelled' : 'error',
      steps: rt.steps,
      ms: Date.now() - startedAt,
      output: rt.output,
      ...(rt.error ? { error: rt.error } : {}),
    }
  }

  private redoText(rt: TaskRt, feedback: string): string {
    return [
      this.taskText(rt.task),
      `你上一次交付的结果：\n${outputOf(rt, 6000)}`,
      `组长审查之后要求你修改（第 ${rt.backs} 次返工）：\n${feedback}`,
      '请按反馈修正后重新交付，回答里写出完整的最终结果摘要。',
    ].join('\n\n')
  }

  // ---------- 给组长的附录 ----------

  /** 各任务的状态（打回接口的 caps 与附录共用） */
  tasks(): Array<{ id: string; title: string; status: TeamTaskStatus; backs: number }> {
    return [...this.rt.values()].map((rt) => ({ id: rt.task.id, title: rt.task.title, status: rt.status, backs: rt.backs }))
  }

  /** 拼在组长提示词末尾的执行结果与审查说明（不进文档，见文件头） */
  appendix(): string {
    const sections = [...this.rt.values()].map((rt) => {
      const who = `负责人 ${rt.task.label || rt.task.assignee}`
      const head = `### 任务 ${rt.task.id}「${rt.task.title}」· ${who}`
      if (rt.status === 'done') return `${head} · 已交付\n${outputOf(rt, RESULT_IN_APPENDIX)}`
      if (rt.status === 'failed') {
        return `${head} · 出错：${rt.error ?? '未知原因'}${rt.output ? `\n它出错之前交付的部分：\n${outputOf(rt, RESULT_IN_APPENDIX)}` : ''}`
      }
      if (rt.status === 'skipped') return `${head} · 没有执行：${rt.error ?? '前置任务没有完成'}`
      return `${head} · ${rt.status === 'cancelled' ? '已取消' : '没有做完'}`
    })
    return [
      '[Ramet 带队·交叉审查]',
      `用户已确认计划「${this.plan.title}」并开工，各组员已经按计划做完。${this.plan.goal ? `总目标：${this.plan.goal}` : ''}`,
      '组员各自在独立的会话里工作，看不到彼此，也看不到这段对话；他们的结果如下：',
      sections.join('\n\n'),
      `现在由你交叉审查：这些结果是否满足总目标、彼此是否一致。发现问题时调用工具 send_back(taskId, feedback) 打回给对应的组员重做（同步等待，返回新结果；每个任务最多打回 ${TEAM_LIMITS.sendBack} 次，只能打回已经交付或出错的任务）。审查完用简短的总结回复用户：做成了什么、哪些没做成、还需要用户做什么。不要重复贴组员的全文。`,
    ].join('\n\n')
  }
}

// ---------- 执行轮的入口（turn.ts 调）----------

export type TeamRoundHost = {
  plans: TeamPlans
  sub: SubRunHost
  /** 登记这一轮的 TeamExec（send_back 端点按 runId 找它）；返回取消登记 */
  track(runId: string, exec: TeamExec): () => void
}

/** 执行轮开跑：载入计划、在本轮 RunRecord 里放出团队计划（status running）、把组员按依赖跑完。
 *  返回给组长的附录与收尾函数（end：团队整体状态落进 team 原语、摘掉 TeamExec）。
 *  组员阶段结束时本轮已被停止 / 关停（run.cancelled / run.hold）的，调用方直接收尾，不再建组长会话 */
export async function startExecRound(
  host: TeamRoundHost,
  run: RunState,
  record: RunRecord,
  user: UserRef,
): Promise<{ exec: TeamExec; end: () => void }> {
  const team = run.team
  if (team?.kind !== 'exec') throw new Error('不是带队的执行轮')
  const row = await host.plans.load(team.planId)
  if (!row || row.status !== 'running' || row.user_id !== user.id || row.page_id !== run.pageId) {
    throw new Error('这份计划已经不在可以执行的状态了')
  }
  const exec = new TeamExec(host.sub, run, record, user, planOf(row))
  const untrack = host.track(run.runId, exec)
  exec.open()
  record.team({ op: 'plan', team: { ...draftState(row), status: 'running' } })
  const end = (): void => {
    record.team({ op: 'status', status: teamStatusOf(run) })
    exec.close()
    untrack()
  }
  try {
    await exec.runAll()
  } catch (err) {
    end()
    throw err
  }
  return { exec, end }
}

function planOf(row: PlanRow): { goal: string; title: string; tasks: PlanTask[] } {
  return { goal: row.goal, title: row.plan.title, tasks: row.plan.tasks }
}
