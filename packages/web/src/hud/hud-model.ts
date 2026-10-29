/* ---------- 右上角工作台的模型：岛 / 停靠的岛 / 面板画的都是这里派生出来的东西（纯函数，有单测）----------
 * 「这一轮」两个来源：在飞的来自 agent-bar 的 store（LiveRun），跑完的来自过程页的 record（GET /api/runs/:id）。
 * 停靠的岛不拉 record：读回复块的 stats（含收尾时算好的改动 / 协作数，shared/run-tally.ts）与 plan 属性。 */
import { decodeStats } from '@ramet/shared/reply-stats'
import { decodePlan, planProgress, SPEND_KEYS, type PlanEntry, type RunEntry, type RunInfo, type RunTally, type SpendKey, type TeamState, type TurnUsage } from '@ramet/shared/run-model'
import type { AskContent, RunRecord } from '../api'
import type { LiveRun, PermissionReq } from '../editor/agent-bar'
import { quickPick } from '../editor/ask-form'
import { HUD_COPY as C } from './hud-copy'

export type HudTab = 'overview' | 'steps' | 'tasks' | 'files' | 'agents'
export const HUD_TABS: readonly HudTab[] = ['overview', 'steps', 'tasks', 'files', 'agents']

/** broken = 没收尾就断了的老块（stats 停在 o:run，又不是正在跑的那一轮） */
export type HudPhase = 'live' | 'ask' | 'end' | 'cancelled' | 'error' | 'broken'

/** 面板画的「这一轮」 */
export type HudRun = {
  replyId: string
  runId: string | null
  agent: string
  live: boolean
  /** 在飞的一轮每次变化递增（store 原地改 RunState，派生的统计按它重算）；跑完的恒为 0 */
  version: number
  outcome?: 'end' | 'cancelled' | 'error'
  /** 用时：在飞的是到现在，跑完的是总用时 */
  ms: number
  entries: RunEntry[]
  plan: PlanEntry[]
  team?: TeamState
  info?: RunInfo
  usage?: TurnUsage
  context?: { used: number; size: number }
}

export function hudFromLive(run: LiveRun, now: number): HudRun {
  return {
    replyId: run.replyId,
    runId: run.runId ?? null,
    agent: run.agent ?? '',
    live: !run.outcome,
    version: run.version,
    ...(run.outcome ? { outcome: run.outcome } : {}),
    ms: Math.max(0, (run.endedAt ?? now) - run.startedAt),
    entries: run.state.entries,
    plan: run.state.plan ?? [],
    ...(run.state.team ? { team: run.state.team } : {}),
    ...(run.state.info ? { info: run.state.info } : {}),
    ...(run.state.info?.usage ? { usage: run.state.info.usage } : {}),
    ...(run.state.info?.context ? { context: run.state.info.context } : {}),
  }
}

export function hudFromRecord(runId: string, r: RunRecord): HudRun {
  const usage = r.usage ?? r.info?.usage
  const context = r.context ?? r.info?.context
  return {
    replyId: r.replyId,
    runId,
    agent: r.agent,
    live: false,
    version: 0,
    outcome: r.outcome,
    ms: r.ms ?? 0,
    entries: r.entries,
    plan: r.plan ?? [],
    ...(r.team ? { team: r.team } : {}),
    ...(r.info ? { info: r.info } : {}),
    ...(usage ? { usage } : {}),
    ...(context ? { context } : {}),
  }
}

/** 岛上画的东西（浮 / 停靠共用）：段缺了 = 不出那一段 */
export type IslandView = {
  agent: string
  phase: HudPhase
  ms: number
  steps: number
  plan: { done: number; total: number; current: boolean } | null
  files: { n: number; add: number; del: number } | null
  agents: { n: number; ids: string[]; live: boolean } | null
}

function planSeg(plan: readonly PlanEntry[]): IslandView['plan'] {
  if (plan.length === 0) return null
  const { done, total } = planProgress(plan)
  return { done, total, current: plan.some((p) => p.status === 'in_progress') }
}

export function islandOf(run: HudRun, tally: RunTally, asking: boolean): IslandView {
  const add = tally.files.reduce((n, f) => n + f.add, 0)
  const del = tally.files.reduce((n, f) => n + f.del, 0)
  return {
    agent: run.agent,
    phase: run.live ? (asking ? 'ask' : 'live') : (run.outcome ?? 'end'),
    ms: run.ms,
    steps: tally.steps,
    plan: planSeg(run.plan),
    files: tally.files.length ? { n: tally.files.length, add, del } : null,
    agents: tally.agents.length
      ? { n: tally.agents.length, ids: tally.agents.map((a) => a.agent ?? run.agent), live: tally.agents.some((a) => a.status === 'running') }
      : null,
  }
}

/** 停靠的岛：读回复块属性。没有 stats 也没有过程页的老回复 = 不出岛 */
export function dockView(attrs: { agent: unknown; stats: unknown; plan: unknown; run: unknown }): IslandView | null {
  const s = decodeStats(attrs.stats)
  if (!s.o && typeof attrs.run !== 'string') return null
  return {
    agent: typeof attrs.agent === 'string' ? attrs.agent : '',
    phase: s.o === 'run' ? 'broken' : (s.o ?? 'end'),
    ms: s.ms ?? 0,
    steps: s.st ?? 0,
    plan: planSeg(decodePlan(attrs.plan)),
    files: s.fc ? { n: s.fc, add: s.fa ?? 0, del: s.fd ?? 0 } : null,
    agents: s.ag ? { n: s.ag, ids: [], live: false } : null,
  }
}

/** 岛上的审批条：buttons = 直接作答的按钮；null = 只有「回答」（打开面板的审批区） */
export type AskBar = {
  kind: 'question' | 'approve'
  title: string
  buttons: Array<{ label: string; optionId: string; content?: AskContent }> | null
}

export function askBarOf(req: PermissionReq): AskBar {
  if (req.form) {
    const quick = quickPick(req.form)
    return {
      kind: 'question',
      title: req.title || req.form.message,
      buttons: quick ? quick.picks.map((p) => ({ label: p.label, optionId: 'accept', content: { [quick.key]: p.value } })) : null,
    }
  }
  return { kind: 'approve', title: req.title, buttons: req.options.map((o) => ({ label: o.name, optionId: o.optionId })) }
}

/** 「时间花在哪」的分段：固定顺序，0 的不出 */
export function spendParts(tally: RunTally): Array<{ key: SpendKey; ms: number; pct: number }> {
  const total = SPEND_KEYS.reduce((n, k) => n + tally.spend[k], 0)
  if (total <= 0) return []
  return SPEND_KEYS.filter((k) => tally.spend[k] > 0).map((k) => ({ key: k, ms: tally.spend[k], pct: tally.spend[k] / total }))
}

/** 总览的「要点」：只说数据里有的事，不编 */
export function highlights(run: HudRun, tally: RunTally, nameOf: (agentId: string) => string): string[] {
  const out: string[] = []
  if (tally.failed) out.push(C.notes.failed(tally.failed))
  const called = [...new Set(tally.agents.map((a) => (a.kind === 'sub' ? C.agentKind.sub : nameOf(a.agent ?? '') || a.label)))]
  if (called.length) out.push(C.notes.agents(called.join(' · ')))
  if (tally.asks) out.push(C.notes.asks(tally.asks))
  if (tally.files.length) out.push(C.notes.files(tally.files.length))
  if (!out.length) out.push(run.live ? C.notes.running : C.notes.readOnly)
  return out
}
