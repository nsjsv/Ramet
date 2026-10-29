// ---------- 一轮 run 的运行状态（页面互斥、订阅快照、收尾的唯一事实源）----------
// 远端回合的登记 / 认领模块（remote-run.ts）也要按 runId 找到它，而 manager 与 remote-run 互相引用不值得，
// 所以形状放在这里，createRunState 只是把字段填齐。
import { randomUUID } from 'node:crypto'
import type { RunRecord } from './run-record.js'
import type { PromptResult } from './types.js'
import type { PromptEnv } from './prompt-env.js'

/** 这一轮是带队的哪一轮（null = 普通对话）。
 *  plan = 计划轮（组长出计划，goal = 用户 `/带队` 后面的目标）；exec = 执行轮（用户确认后开工，planId = team_plans 的行）。
 *  两种轮都不复用旧会话、不把会话 / 收尾 hash 写回 agent_session（见 agents/team.ts 文件头） */
export type TeamRound = { kind: 'plan'; goal: string } | { kind: 'exec'; planId: string; /** draft → running 的翻转成功了（收尾只收口自己翻转过的计划） */ begun?: boolean }

export type RunState = {
  /** 稳定回合身份（server 生成的 uuid）：跨 server 重启认领与事件重放都按它，不是连接本地的 rid */
  runId: string
  pageId: string
  /** 发起这一轮的人（机器使用权的主体）：收回授权时按它找这个人在这台机器上在飞的回合 */
  userId: string
  adapterKey: string
  sessionId: string | null
  cancelled: boolean
  /** 使用授权被收回而中止的原因（置位时 cancelled 同时为真）。这一轮收成 error + 这句原因，不是「已停止」 */
  revoked: string | null
  ended: boolean
  /** 服务关停中止的一轮（结果记 error，不是用户点的停止）。只用于本机 agent */
  shutdown: boolean
  /** 远端回合遇上 server 关停：这不是结局。finally 不收尾、不删绑定行、不 cancel */
  hold: boolean
  /** closeRun 已开始（同步置位）。prompt 的 finally 和 4403 的 onError 可能各走一次 */
  closed: boolean
  /** 本轮的过程与当前那段话:订阅快照、收尾写回复、归档过程页的唯一事实源(占位块建好后才有) */
  record: RunRecord | null
  /** 本轮开始时刻(相对时间的零点、归档页标题) */
  startedAt: number
  /** 归档产出的过程页 id(没有条目或归档失败为 null) */
  runPageId: string | null
  /** 关停时与 prompt 竞速:adapter/connector 不回也能走到收尾 */
  abort: PromiseWithResolvers<PromptResult>
  /** continue()/认领 收尾广播完成 */
  finished: PromiseWithResolvers<void>
  /** 远端执行目标（本机为 null）：绑定行与 cancel 路由要它 */
  remote: { connectorId: string; agentId: string } | null
  /** 跨重启认领的重放中：折事件但不推 SSE，直到 connector 报 resumed 再发一次快照 */
  replay: boolean
  /** 已折进 record 的最后 seq。-1 = 还没有事件（重连 after=-1，全部重放） */
  lastSeq: number
  /** 这条消息的配置覆盖与覆盖前的值（收尾还原；认领时从绑定行取） */
  msgOpts: Record<string, string>
  msgBefore: Record<string, string>
  /** open_runs 绑定行已写（收尾要删） */
  bound: boolean
  /** 本轮开头解析好的提示词环境（agent 实际看到的引用与各回复的过程摘要，prompt-env.ts）。收尾基线 hash 必须用它算，
   *  与开头的 hash 同一口径。认领回来的回合没有（开头不在本进程），不落收尾 hash，下一轮全文重放 */
  seen: PromptEnv | null
  /** 带队的哪一轮；普通对话 = null。判定只在两处：continue 带 team（执行轮）、runTurn 认出 `/带队`（计划轮） */
  team: TeamRound | null
}

/** 两个构造点（continue 发一轮、认领续上一轮）必须同一份字段，漏一个 hold/bound 就会把远端回合收成结束。 */
export function createRunState(opts: {
  pageId: string
  userId: string
  adapterKey: string
  remote: RunState['remote']
  runId?: string
  startedAt?: number
  replay?: boolean
  team?: TeamRound | null
}): RunState {
  return {
    runId: opts.runId ?? randomUUID(),
    pageId: opts.pageId,
    userId: opts.userId,
    adapterKey: opts.adapterKey,
    sessionId: null,
    cancelled: false,
    revoked: null,
    ended: false,
    shutdown: false,
    hold: false,
    closed: false,
    record: null,
    startedAt: opts.startedAt ?? Date.now(),
    runPageId: null,
    abort: Promise.withResolvers<PromptResult>(),
    finished: Promise.withResolvers<void>(),
    remote: opts.remote,
    replay: opts.replay ?? false,
    lastSeq: -1,
    msgOpts: {},
    msgBefore: {},
    bound: false,
    seen: null,
    team: opts.team ?? null,
  }
}
