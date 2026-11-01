// ---------- 把原生会话记录从跑它的机器同步到中心（换机器搬会话的上半段）----------
// 时机：每轮收尾之后（正常 / 停止 / 出错都算），长回合里每 SYNC_INTERVAL_MS 也拉一次新增。
// 只在发起人自己接入的机器上做（会话记录里有工具结果、读过的文件内容；别人授权给你的机器不碰），
// 而且要 connector 声明了 session 能力、这个 agent 的驱动有会话端口。
// 增量：stat 时把中心已有的每个文件的长度交给 connector，它按这个长度算尾巴哈希；和中心记的一致 = 机器上的文件只在后面追加了，
// 只拉 [已有长度, 新长度)；对不上（被整个重写过）就整份重拉。每块 ≤ SESSION_CHUNK_BYTES，中心同一时刻只有一块在内存里。
// 每页一条串行的 promise 链：同步与下发（session-move.ts）都排在上面，不占页面槽（下一轮不用等同步），
// 但换机器下发前会等这一页的链空，拿到的一定是最新的那份。

import type { Pool } from 'pg'
import { toolOf } from '@ramet/shared/reply-stats'
import type { Conn, ConnectorHub } from './hub.js'
import { assertCanUse, type MachinePass } from './machine-access.js'
import type { SessionMsg } from './protocol.js'
import { ForbiddenError } from './posture.js'
import type { RunState } from './run-state.js'
import { copyFiles, copyPath, CopyWriter, dropCopyFile, dropOtherSessions, saveCopyFile, validCopyName } from './session-copies.js'
import { loadCurrent } from './session-store.js'
import { SESSION_CAP, SESSION_FRAME_TIMEOUT_MS, validSessionId, type SessionReply } from './session-types.js'

/** 长回合里多久拉一次新增 */
export const SYNC_INTERVAL_MS = 60_000
/** 有会话端口的驱动（drivers/<家>/session-port.ts）：别的（老 connector 上经 ACP 的）不支持搬，不发会话帧 */
const PORTED_DRIVERS = new Set(['claude', 'codex', 'pi', 'omp'])

/** 一次同步的对象：哪一页、哪台机器上的哪个 agent、哪个会话、谁发起的 */
export type SyncTarget = { pageId: string; connectorId: string; agentId: string; sessionId: string; userId: string }

/** 会话帧的应答（res.session），对不上的应答当错误 */
export async function sessionFrame<T extends SessionReply['op']>(
  hub: ConnectorHub,
  pass: MachinePass,
  op: T,
  build: (rid: string, actor: string) => Extract<SessionMsg, { rid: string }>,
): Promise<Extract<SessionReply, { op: T }>> {
  const msg = await hub.request(pass, build, SESSION_FRAME_TIMEOUT_MS)
  if (msg.t === 'err') throw new Error(msg.message)
  if (msg.t !== 'res' || msg.session?.op !== op) throw new Error(`connector 没有按 ${op} 应答`)
  return msg.session as Extract<SessionReply, { op: T }>
}

/** 工具本身不支持搬会话（老 connector 上仍经 ACP 的等）：换机器不算「没接上」，照没换时的规则走，不提示 */
export const TOOL_NOT_PORTED = '这个工具不支持换机器接着用会话'

export class SessionSync {
  private chains = new Map<string, Promise<unknown>>()
  /** runId → 长回合的定时同步 */
  private timers = new Map<string, ReturnType<typeof setInterval>>()
  /** 定时同步已经排在链上、还没轮到的页面：同步比间隔还慢时不越排越多 */
  private queued = new Set<string>()

  constructor(
    private readonly pool: Pool,
    readonly hub: ConnectorHub,
    private readonly intervalMs = SYNC_INTERVAL_MS,
  ) {}

  /** 这台机器上的这个 agent 能不能搬会话（同步 / 下发）：在线、主人是 userId、connector 有 session 能力、驱动有端口。
   *  不能就给原因（离线 / 别人的机器 / 老 connector / 不支持的工具），运行条用 */
  movable(connectorId: string, agentId: string, userId: string): { conn: Conn } | { reason: string } {
    const conn = this.hub.get(connectorId)
    if (!conn) return { reason: '那台机器不在线' }
    if (conn.ownerId !== userId) return { reason: '只在你自己接入的机器之间搬会话' }
    if (!conn.caps.includes(SESSION_CAP)) return { reason: `${conn.name} 上的 connector 版本太旧` }
    const driver = conn.agents.find((a) => a.id === agentId)?.driver
    if (!driver || !PORTED_DRIVERS.has(driver)) return { reason: TOOL_NOT_PORTED }
    return { conn }
  }

  /** 排到这一页的链上（前一个失败不影响后一个） */
  enqueue<T>(pageId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(pageId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const settled = next.catch(() => undefined)
    this.chains.set(pageId, settled)
    void settled.then(() => {
      if (this.chains.get(pageId) === settled) this.chains.delete(pageId)
    })
    return next
  }

  /** 这一页还在进行的同步做完（下发之前等它） */
  drain(pageId: string): Promise<void> {
    return this.enqueue(pageId, async () => undefined)
  }

  /** 排队同步一次；失败只记日志（下一次同步 / 换机器时再补） */
  sync(t: SyncTarget): Promise<boolean> {
    return this.enqueue(t.pageId, () => this.pull(t)).catch((err: unknown) => {
      console.warn(`[session-sync] ${t.pageId} ${t.agentId} ${t.sessionId} 同步失败：${err instanceof Error ? err.message : String(err)}`)
      return false
    })
  }

  /** 拉一次（调用方已在这一页的链上）。返回 false = 这台机器现在不能同步（离线 / 不是主人 / 没有能力），什么都没动 */
  async pull(t: SyncTarget): Promise<boolean> {
    if (!validSessionId(t.sessionId) || 'reason' in this.movable(t.connectorId, t.agentId, t.userId)) return false
    const pass = await machinePass(this.pool, t.userId, t.connectorId)
    if (!pass) return false
    const tool = toolOf(`c:${t.connectorId}:${t.agentId}`)
    const known = await copyFiles(this.pool, t.pageId, tool, t.sessionId)
    const stat = await sessionFrame(this.hub, pass, 'session-stat', (rid, actor) => ({
      t: 'session-stat', rid, actor, agent: t.agentId, sessionId: t.sessionId, known: known.map((f) => ({ name: f.name, size: f.size })),
    }))
    // 换了会话：机器上确有新会话的记录了，旧会话的副本先删（行的主键不含会话 id，不先删的话同名文件的行会被新会话改写，
    // 旧目录就没人认领了）。放在 stat 之后：新会话还没有记录（没发出过提示词）时旧的那份留着
    await dropOtherSessions(this.pool, t.pageId, tool, t.sessionId)
    const names = new Set<string>()
    for (const f of stat.files) {
      if (!validCopyName(f.name) || !Number.isSafeInteger(f.size) || f.size < 0) throw new Error('connector 给的会话文件清单不合法')
      names.add(f.name)
      const have = known.find((k) => k.name === f.name)
      // 只在后面追加了：从已有长度接着拉；一样长就不动
      const from = have && f.tailHash === have.tailHash && f.size >= have.size ? have.size : 0
      if (have && from === f.size) continue
      await this.fetchFile(pass, t, tool, f.name, from, f.size)
    }
    // 机器上已经没有的文件：一起删
    for (const k of known) if (!names.has(k.name)) await dropCopyFile(this.pool, t.pageId, tool, t.sessionId, k.name)
    return true
  }

  /** 拉一个文件的 [from, 机器上的长度) 写进中心（from = 0 整份重写）。读的过程中文件还在长没关系：读到哪算哪 */
  private async fetchFile(pass: MachinePass, t: SyncTarget, tool: string, name: string, from: number, size: number): Promise<void> {
    const writer = await CopyWriter.open(copyPath(t.pageId, tool, t.sessionId, name), from)
    try {
      let offset = from
      while (offset < size) {
        const chunk = await sessionFrame(this.hub, pass, 'session-read', (rid, actor) => ({
          t: 'session-read', rid, actor, agent: t.agentId, sessionId: t.sessionId, name, offset,
        }))
        const buf = Buffer.from(chunk.data, 'base64')
        await writer.write(buf)
        offset += buf.length
        if (chunk.eof || buf.length === 0) break
      }
      // 读的时候文件变短了：多半是被整个重写了，这次不收，下一次整份重拉
      if (offset < size) throw new Error(`会话文件 ${name} 读到 ${offset} 字节就结束了（应为 ${size}）`)
      // 整份重写：先删旧行再换文件，中途断了只是「中心没有这个文件」（下次整份重拉），不会出现旧行配新内容
      if (from === 0) await dropCopyFile(this.pool, t.pageId, tool, t.sessionId, name)
      const done = await writer.commit()
      await saveCopyFile(this.pool, t.pageId, tool, t.sessionId, { name, ...done })
    } catch (err) {
      await writer.abort()
      throw err
    }
  }

  /** 一轮绑定好之后：长回合里定时拉新增（收尾时 afterRun 停掉） */
  watch(run: RunState): void {
    if (!run.remote || run.team || this.timers.has(run.runId)) return
    const timer = setInterval(() => {
      const target = targetOf(run)
      if (run.closed || !target || this.queued.has(run.pageId)) return
      this.queued.add(run.pageId)
      void this.enqueue(run.pageId, async () => {
        this.queued.delete(run.pageId)
        return this.pull(target)
      }).catch((err: unknown) => console.warn(`[session-sync] ${run.pageId} 定时同步失败：${err instanceof Error ? err.message : String(err)}`))
    }, this.intervalMs)
    timer.unref?.()
    this.timers.set(run.runId, timer)
  }

  /** 一轮收尾（所有结局，含认领回来的回合）：停掉定时同步，再拉一次。
   *  带队的轮不碰（它们的会话不写回这一页）；中心要关了的远端回合不是结局，等下一个进程认领了再说。
   *  这一轮不能同步（本机 agent、别人授权的机器、不支持的工具）时，中心手里同一工具别的会话的副本已经不是这一页的会话了，删掉 */
  afterRun(run: RunState): void {
    const timer = this.timers.get(run.runId)
    if (timer) clearInterval(timer)
    this.timers.delete(run.runId)
    if (run.team || !run.sessionId || (run.hold && !run.ended)) return
    const target = targetOf(run)
    if (target && !('reason' in this.movable(target.connectorId, target.agentId, target.userId))) {
      void this.sync(target)
      return
    }
    // 只在这一轮真的成了这一页的会话（发出过提示词，current 记成了它）时才删：没发出去就失败的一轮不算换了会话
    const sessionId = run.sessionId
    const tool = toolOf(run.adapterKey)
    void this.enqueue(run.pageId, async () => {
      if ((await loadCurrent(this.pool, run.pageId, tool)) === run.adapterKey) await dropOtherSessions(this.pool, run.pageId, tool, sessionId)
    }).catch(() => undefined)
  }
}

function targetOf(run: RunState): SyncTarget | null {
  if (!run.remote || !run.sessionId) return null
  return { pageId: run.pageId, connectorId: run.remote.connectorId, agentId: run.remote.agentId, sessionId: run.sessionId, userId: run.userId }
}

/** 这台机器的 machine 范围凭据（会话帧都是 machine 范围；主人永远有）。拿不到（机器被删 / 还没批准）= null */
export async function machinePass(pool: Pool, userId: string, connectorId: string): Promise<MachinePass | null> {
  try {
    return await assertCanUse(pool, { id: userId }, connectorId, 'machine')
  } catch (err) {
    if (err instanceof ForbiddenError) return null
    throw err
  }
}
