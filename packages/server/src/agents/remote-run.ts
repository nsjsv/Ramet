// ---------- 远端回合的登记、认领、收尸 ----------
// connector 进程才是一轮 prompt 的寿命所有者。中心只投影：open_runs 在 prompt 之前写好，
// server 重启或 socket 掉了都不是结局。真正结束只有：connector 的 end/err、用户 cancel、
// hello 证明这个进程已经不跑它、4403 撤销（hub 会 reject 那次 prompt）。
//
// 收尾只有 closeRun → finalizeRun 这一条。认领回来的回合走同一条，不许再写一份。
import type { Pool } from 'pg'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import type * as Y from 'yjs'
import { agentReplyPhase, ReplyWriter } from './doc.js'
import type { InflightPrompt, ResumePlan } from './hub.js'
import type { MachinePass } from './machine-access.js'
import { drainBot, openBotAsUser, type Bot } from './open-bot.js'
import { finalizeRun } from './run-finalize.js'
import { RunRecord } from './run-record.js'
import { createRunState, type RunState } from './run-state.js'
import { isSessionEvent, type AgentEvent, type PromptResult, type TurnUsage } from './types.js'
import type { ToolProfile } from './tool-profile.js'

const GONE = 'agent 进程已不在（重连时没有这个回合）'

const INSERT_OPEN_RUN = `INSERT INTO open_runs (
  run_id, page_id, reply_id, session_id, agent_id, connector_id, user_id, cwd, started_at, msg_opts, msg_before
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)`
const LIST_OPEN_RUNS = `SELECT run_id, page_id, reply_id, session_id, agent_id, connector_id, user_id, cwd,
  started_at, msg_opts, msg_before, cancel_requested FROM open_runs WHERE connector_id = $1`
const DELETE_OPEN_RUN = `DELETE FROM open_runs WHERE run_id = $1`
const CANCEL_OPEN_RUN = `UPDATE open_runs SET cancel_requested = true WHERE run_id = $1`
const CANCEL_OPEN_PAGE = `UPDATE open_runs SET cancel_requested = true WHERE page_id = $1`

type OpenRunRow = {
  run_id: string
  page_id: string
  reply_id: string
  session_id: string
  agent_id: string
  connector_id: string
  user_id: string
  cwd: string
  started_at: string | number
  msg_opts: unknown
  msg_before: unknown
  cancel_requested: boolean
}

type BotSession = Bot & { revoke?: () => Promise<void> }

export type RemoteRunHost = {
  pool: Pool
  wsPort: () => number
  botSecret: string
  notifyPagesChanged?: () => void
  broadcast(pageId: string, ev: AgentEvent): void
  notifyRunError(pageId: string, message: string, replyId?: string): void
  findRun(runId: string): RunState | undefined
  /** 放进 run 索引。页面槽空着才占上（返回 true）；已经被别的回合占了就只索引，不抢 SSE。 */
  watch(pageId: string, run: RunState): boolean
  /** 收尾广播。hold 且 agent 还没自己结束时不广播已中止，占位块还是 o:run。 */
  release(pageId: string, run: RunState): void
  /** 认领失败、还没开始折事件：腾出页面槽，不广播。 */
  vacate(pageId: string, run: RunState): void
  /** 发起这一轮的人（open_runs.user_id）此刻还能不能用这台机器：能就签出凭据，不能 null。
   *  认领回来的回合要以他的身份接着用适配器，授权在 server 重启期间可能已经被收回 / 过期 */
  passFor(userId: string, connectorId: string): Promise<MachinePass | null>
  /** 这个 session 在 connector 进程里本来就加载着：标上已加载，并绑进会话镜像（页面 + agent）。
   *  重启后的待批审批与命令靠这一步回到前端 */
  attach(pageId: string, catalogId: string, pass: MachinePass, sessionId: string, cwd: string): void
  /** userId = 发起这一轮的人（会话的 MCP 凭证是他的，见 SavedSession.userId） */
  persistFinalHash(pageId: string, catalogId: string, sessionId: string, cwd: string, hash: string, userId: string, tools: ToolProfile): Promise<void>
  restoreBefore(catalogId: string, pass: MachinePass, sessionId: string, before: Record<string, string>): Promise<void>
  bind(runId: string, handlers: {
    onEvent: (ev: AgentEvent, seq: number) => void
    onResumed: () => void
    onEnd: (result: PromptResult) => void
    onError: (message: string) => void
  }): void
}

/** 同一 connector 的 hello 串行。两个 hello 叠在一起会各绑一次、各插一个记录。 */
const helloChain = new Map<string, Promise<void>>()

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function asRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item
  }
  return out
}

function epoch(value: string | number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : Date.now()
}

/** agent_id 列存的是 catalog id（c:<connectorId>:<agentId>）。remote.agentId 要 connector 侧的原始 id。 */
function remoteTarget(row: OpenRunRow): { connectorId: string; agentId: string } {
  const prefix = `c:${row.connector_id}:`
  const agentId = row.agent_id.startsWith(prefix) ? row.agent_id.slice(prefix.length) : row.agent_id
  return { connectorId: row.connector_id, agentId }
}

export async function insertOpenRun(pool: Pool, row: {
  runId: string
  pageId: string
  replyId: string
  sessionId: string
  agentId: string
  connectorId: string
  userId: string
  cwd: string
  startedAt: number
  msgOpts: Record<string, string>
  msgBefore: Record<string, string>
}): Promise<void> {
  await pool.query(INSERT_OPEN_RUN, [
    row.runId, row.pageId, row.replyId, row.sessionId, row.agentId, row.connectorId, row.userId,
    row.cwd, row.startedAt, JSON.stringify(row.msgOpts), JSON.stringify(row.msgBefore),
  ])
}

export async function deleteOpenRun(pool: Pool, runId: string): Promise<void> {
  await pool.query(DELETE_OPEN_RUN, [runId])
}

/** 断线期间的停止。socket 不在时 cancel 帧送不出去，认领看到这行就不会把回合接回去。 */
export function requestCancel(pool: Pool, runId: string): Promise<void> {
  return pool.query(CANCEL_OPEN_RUN, [runId]).then(() => undefined)
}

export function requestCancelByPage(pool: Pool, pageId: string): Promise<void> {
  return pool.query(CANCEL_OPEN_PAGE, [pageId]).then(() => undefined)
}

/** 重放时 emit 直接丢掉：折进 state，但不往 SSE 推。onResumed 再发一份完整快照。 */
export function openRecord(run: RunState, replyId: string, broadcast: (ev: AgentEvent) => void): RunRecord {
  return new RunRecord(replyId, run.startedAt, (ev) => {
    if (run.replay) return
    broadcast(ev)
  })
}

export function terminalStatus(run: RunState): AgentEvent {
  const runPageId = run.runPageId ?? undefined
  if (run.ended) return { type: 'status', state: 'done', runPageId }
  if (run.revoked) return { type: 'status', state: 'error', message: run.revoked, runPageId }
  if (run.shutdown) return { type: 'status', state: 'error', message: '服务重启，本轮已中止', runPageId }
  if (run.cancelled) return { type: 'status', state: 'done', message: '已停止', runPageId }
  return { type: 'status', state: 'error', message: '生成失败', runPageId }
}

/** 折一条轮次事件进 RunRecord。seq 缺省就按到达顺序计（直播监听器拿不到缓冲下标，和 connector 从
 *  0 递增的序号对齐）。会话级事件（commands / config / 审批）归会话、不归某一轮，由会话镜像处理，这里不碰。 */
export function projectAgentEvent(
  run: RunState,
  record: RunRecord,
  ev: AgentEvent,
  seq: number | undefined,
  sessionId: string,
): void {
  if (isSessionEvent(ev)) return
  if ('sessionId' in ev && ev.sessionId && ev.sessionId !== sessionId) return
  if (typeof seq === 'number' && Number.isFinite(seq)) run.lastSeq = seq
  else run.lastSeq += 1
  if (ev.type === 'text') record.text(ev.delta, ev.parentId)
  else if (ev.type === 'thought') record.thought(ev.delta, ev.parentId)
  else if (ev.type === 'tool') record.tool(ev)
  else if (ev.type === 'usage') record.setContext(ev.used, ev.size, ev.cost, ev._meta)
  else if (ev.type === 'info') record.info(ev.info)
  else if (ev.type === 'plan') record.plan(ev.entries, ev.truncated)
  else if (ev.type === 'terminal') {
    // ACP 终端里跑的命令：实时输出追加到绑定的那一步，退出状态 / 输出被截断并进同一步的 acp（缺省键保持，不抹别的字段）
    if (ev.delta) record.terminalOutput(ev.id, ev.delta)
    if (ev.exit || ev.truncated) {
      record.patchStep({
        id: ev.id,
        ...(ev.exit ? { acp: { terminalExit: ev.exit } } : {}),
        ...(ev.truncated ? { truncated: true } : {}),
      })
    }
  }
}

/** 四个出口 + 认领回来的 end/err 共用。park=true：远端 prompt 还在跑，不写文档、不删行。 */
export async function closeRun(opts: {
  pool: Pool
  run: RunState
  record: RunRecord | null
  writer: ReplyWriter | null
  bot: { provider: HocuspocusProvider; doc: Y.Doc; revoke?: () => Promise<void> } | null
  agentId: string
  ownerId: string
  usage: TurnUsage | undefined
  park: boolean
  restore: () => Promise<void>
  persistFinalHash: (hash: string, tools: ToolProfile) => Promise<void>
  notifyPagesChanged?: () => void
}): Promise<void> {
  if (opts.run.closed) return
  opts.run.closed = true
  const bot = opts.bot
  try {
    if (opts.park) {
      // 进程要退了，connector 上的 agent 还在跑。占位块保持 o:run，绑定行留给下一个进程。
      console.log(`[agent] 远端回合 ${opts.run.runId} 跨重启保留，不收尾`)
      if (bot) await drainBot(bot.provider)
      return
    }
    await opts.restore().catch((err: unknown) => {
      console.error(`[agent] 还原消息级配置失败(${opts.run.pageId}): ${errText(err)}`)
    })
    if (!opts.record || !opts.writer || !bot) {
      console.error(`[agent] 回合 ${opts.run.runId} 没有可写的回复块，绑定行保留`)
      return
    }
    await finalizeRun({
      pool: opts.pool,
      bot,
      writer: opts.writer,
      record: opts.record,
      run: opts.run,
      agentId: opts.agentId,
      ownerId: opts.ownerId,
      usage: opts.usage,
      notifyPagesChanged: opts.notifyPagesChanged,
      persistFinalHash: opts.persistFinalHash,
    })
    if (opts.run.bound) {
      await deleteOpenRun(opts.pool, opts.run.runId).catch((err: unknown) => {
        console.error(`[agent] 删除 open_runs ${opts.run.runId} 失败: ${errText(err)}`)
      })
    }
  } finally {
    bot?.provider.destroy()
    await bot?.revoke?.()?.catch(() => undefined)
  }
}

type Opened =
  | { kind: 'ready'; bot: BotSession; writer: ReplyWriter }
  | { kind: 'missing' | 'finished' | 'unavailable' }

/** 用 user_id 临时签一张会话去开文档，不把浏览器 cookie 存进 open_runs。 */
async function openReply(row: OpenRunRow, host: RemoteRunHost): Promise<Opened> {
  let bot: BotSession
  try {
    bot = await openBotAsUser({
      pool: host.pool,
      pageId: row.page_id,
      wsPort: host.wsPort,
      botSecret: host.botSecret,
      userId: row.user_id,
      agentId: row.agent_id,
    })
  } catch (err) {
    console.error(`[agent] 认领 ${row.run_id} 打开文档失败: ${errText(err)}`)
    return { kind: 'unavailable' }
  }
  const phase = agentReplyPhase(bot.doc, row.reply_id)
  if (phase !== 'open') {
    bot.provider.destroy()
    await bot.revoke?.()?.catch(() => undefined)
    return { kind: phase === 'missing' ? 'missing' : 'finished' }
  }
  const writer = ReplyWriter.bind(bot.doc, row.reply_id)
  if (!writer) {
    bot.provider.destroy()
    await bot.revoke?.()?.catch(() => undefined)
    return { kind: 'missing' }
  }
  return { kind: 'ready', bot, writer }
}

function reveal(run: RunState, record: RunRecord, occupied: boolean, host: RemoteRunHost): void {
  if (!run.replay) return
  // 先冲刷再关 replay：冲刷会走 emit，replay 还开着就不会把增量再推一遍，快照里已经有全文。
  record.flush()
  run.replay = false
  if (!occupied) return
  host.broadcast(run.pageId, record.snapshot(run.adapterKey))
  host.broadcast(run.pageId, { type: 'status', state: 'running' })
}

async function listOpenRuns(pool: Pool, connectorId: string): Promise<OpenRunRow[]> {
  const { rows } = await pool.query<OpenRunRow>(LIST_OPEN_RUNS, [connectorId])
  return rows
}

/** 这个进程里没有 waiter。气泡还开着就收成终态；已经收过尾或被删了就只删行，不再插一块。 */
async function bury(row: OpenRunRow, host: RemoteRunHost, outcome: 'error' | 'cancelled', message: string): Promise<void> {
  const opened = await openReply(row, host)
  if (opened.kind === 'unavailable') return
  if (opened.kind !== 'ready') {
    await deleteOpenRun(host.pool, row.run_id).catch(() => undefined)
    return
  }
  const run = createRunState({
    pageId: row.page_id,
    userId: row.user_id,
    adapterKey: row.agent_id,
    remote: remoteTarget(row),
    runId: row.run_id,
    startedAt: epoch(row.started_at),
  })
  run.bound = true
  run.sessionId = row.session_id
  if (outcome === 'cancelled') run.cancelled = true
  const record = openRecord(run, opened.writer.id, () => undefined)
  run.record = record
  if (outcome === 'error') host.notifyRunError(row.page_id, message, record.replyId)
  await closeRun({
    pool: host.pool,
    run,
    record,
    writer: opened.writer,
    bot: opened.bot,
    agentId: row.agent_id,
    ownerId: row.user_id,
    usage: undefined,
    park: false,
    restore: async () => undefined,
    persistFinalHash: async () => undefined,
    notifyPagesChanged: host.notifyPagesChanged,
  })
  host.broadcast(row.page_id, terminalStatus(run))
}

/** 没有内存里的 run：绑回原来那块 agent_reply，重放进一份新 RunRecord。返回 false = 放进 drop。 */
async function adopt(row: OpenRunRow, host: RemoteRunHost): Promise<boolean> {
  // 授权是回合开始时判的，server 重启的这段时间里可能已经被收回 / 过期：此刻再判一次。
  // 不通过就不接回去，占位块收成出错，drop 让 connector 取消还在烧的 prompt
  const pass = await host.passFor(row.user_id, row.connector_id)
  if (!pass) {
    await bury(row, host, 'error', '你对这台机器的使用授权已失效，本轮已中止')
    return false
  }
  const opened = await openReply(row, host)
  if (opened.kind === 'missing' || opened.kind === 'finished') {
    // 气泡没了或已经是终态。取消 connector 上还在烧的 prompt，不要再插第二块。
    await deleteOpenRun(host.pool, row.run_id).catch(() => undefined)
    return false
  }
  const run = createRunState({
    pageId: row.page_id,
    userId: row.user_id,
    adapterKey: row.agent_id,
    remote: remoteTarget(row),
    runId: row.run_id,
    startedAt: epoch(row.started_at),
    replay: true,
  })
  run.bound = true
  run.sessionId = row.session_id
  run.msgOpts = asRecord(row.msg_opts)
  run.msgBefore = asRecord(row.msg_before)
  const occupied = host.watch(row.page_id, run)
  const slot: { writer: ReplyWriter | null; bot: BotSession | null } =
    opened.kind === 'ready' ? { writer: opened.writer, bot: opened.bot } : { writer: null, bot: null }
  const record = openRecord(run, row.reply_id, (ev) => {
    if (occupied) host.broadcast(row.page_id, ev)
  })
  run.record = record
  // 这个 session 在 connector 进程里本来就加载着。标上，收尾还原配置时不要再 session/load 出新会话；
  // 同时绑进会话镜像，重启后的待批审批与命令靠这一步回到前端。
  host.attach(row.page_id, row.agent_id, pass, row.session_id, row.cwd)

  let finishing = false
  const finish = (result?: PromptResult, error?: string): void => {
    if (finishing) return
    finishing = true
    void (async () => {
      try {
        reveal(run, record, occupied, host)
        if (run.hold && !result) {
          await closeRun({
            pool: host.pool,
            run,
            record,
            writer: slot.writer,
            bot: slot.bot,
            agentId: row.agent_id,
            ownerId: row.user_id,
            usage: undefined,
            park: true,
            restore: async () => undefined,
            persistFinalHash: async () => undefined,
            notifyPagesChanged: host.notifyPagesChanged,
          })
          return
        }
        if (error && !run.cancelled && !run.hold) host.notifyRunError(row.page_id, error, run.record?.replyId)
        if (result) {
          if (result.stopReason === 'cancelled' || run.cancelled) run.cancelled = true
          else run.ended = true
        }
        if (!slot.writer || !slot.bot) {
          const again = await openReply(row, host)
          if (again.kind !== 'ready') {
            if (again.kind === 'missing' || again.kind === 'finished') {
              await deleteOpenRun(host.pool, row.run_id).catch(() => undefined)
            }
            return
          }
          slot.writer = again.writer
          slot.bot = again.bot
        }
        await closeRun({
          pool: host.pool,
          run,
          record,
          writer: slot.writer,
          bot: slot.bot,
          agentId: row.agent_id,
          ownerId: row.user_id,
          usage: result?.usage,
          park: false,
          restore: () => host.restoreBefore(row.agent_id, pass, row.session_id, run.msgBefore),
          persistFinalHash: (hash, tools) => host.persistFinalHash(row.page_id, row.agent_id, row.session_id, row.cwd, hash, row.user_id, tools),
          notifyPagesChanged: host.notifyPagesChanged,
        })
      } catch (err) {
        console.error(`[agent] 认领回合 ${row.run_id} 收尾失败: ${errText(err)}`)
        if (!run.cancelled) host.notifyRunError(row.page_id, errText(err), run.record?.replyId)
      } finally {
        if (occupied) host.release(row.page_id, run)
        else host.vacate(row.page_id, run)
      }
    })()
  }

  try {
    host.bind(row.run_id, {
      onEvent: (ev, seq) => projectAgentEvent(run, record, ev, seq, row.session_id),
      onResumed: () => reveal(run, record, occupied, host),
      onEnd: (result) => finish(result),
      onError: (message) => finish(undefined, message),
    })
  } catch (err) {
    slot.bot?.provider.destroy()
    await slot.bot?.revoke?.()?.catch(() => undefined)
    host.vacate(row.page_id, run)
    throw err
  }
  return true
}

function keepLive(inflight: InflightPrompt[], host: RemoteRunHost): ResumePlan {
  // 认领自己失败时也不能把 inflight 全丢进 drop：hub 收到空 resume 会让 connector 取消还在跑的 agent。
  return {
    resume: inflight.map((item) => ({ runId: item.runId, after: host.findRun(item.runId)?.lastSeq ?? -1 })),
    drop: [],
  }
}

async function resumeBody(connectorId: string, inflight: InflightPrompt[], host: RemoteRunHost): Promise<ResumePlan> {
  let rows: OpenRunRow[]
  try {
    rows = await listOpenRuns(host.pool, connectorId)
  } catch (err) {
    console.error(`[agent] 读取 open_runs 失败: ${errText(err)}`)
    return keepLive(inflight, host)
  }
  const byId = new Map(rows.map((row) => [row.run_id, row]))
  const seen = new Set(inflight.map((item) => item.runId))
  const resume: ResumePlan['resume'] = []
  const drop: string[] = []

  for (const item of inflight) {
    try {
      const row = byId.get(item.runId)
      const live = host.findRun(item.runId)
      if (row?.cancel_requested || live?.cancelled) {
        // 断线期间点过停止。connector 会按 drop 取消；这里不把回合接回去。
        if (live) live.cancelled = true
        else if (row) await bury(row, host, 'cancelled', '已停止')
        drop.push(item.runId)
        continue
      }
      if (live) {
        // 本进程的 prompt promise 还挂在 hub 上。不要 bindRun，那会换掉直播的 handlers。
        resume.push({ runId: item.runId, after: live.lastSeq })
        continue
      }
      if (!row) {
        drop.push(item.runId)
        continue
      }
      const kept = await adopt(row, host)
      if (kept) resume.push({ runId: item.runId, after: -1 })
      else drop.push(item.runId)
    } catch (err) {
      console.error(`[agent] 认领 ${item.runId} 失败: ${errText(err)}`)
      const live = host.findRun(item.runId)
      if (live) resume.push({ runId: item.runId, after: live.lastSeq })
      else drop.push(item.runId)
    }
  }

  for (const row of rows) {
    if (seen.has(row.run_id)) continue
    try {
      const live = host.findRun(row.run_id)
      if (live) {
        // 不放进 resume。hub 会用「进程已不再跑该回合」拒绝还挂着的 prompt，直播 finally 收尸。
        if (row.cancel_requested) live.cancelled = true
        continue
      }
      await bury(row, host, row.cancel_requested ? 'cancelled' : 'error', GONE)
    } catch (err) {
      console.error(`[agent] 收尸 ${row.run_id} 失败: ${errText(err)}`)
    }
  }
  return { resume, drop }
}

export function planRemoteResume(
  connectorId: string,
  inflight: InflightPrompt[],
  host: RemoteRunHost,
): Promise<ResumePlan> {
  const prev = helloChain.get(connectorId) ?? Promise.resolve()
  const run = prev.catch(() => undefined).then(() => resumeBody(connectorId, inflight, host))
  const settled = run.then(() => undefined, (err: unknown) => {
    console.error(`[agent] connector ${connectorId} 认领失败: ${errText(err)}`)
  })
  helloChain.set(connectorId, settled)
  void settled.then(() => {
    if (helloChain.get(connectorId) === settled) helloChain.delete(connectorId)
  })
  // hub 的 claim 一抛就把 inflight 全部当 drop。这里吞掉，改成至少续上还在内存里的回合。
  return run.catch(() => keepLive(inflight, host))
}
