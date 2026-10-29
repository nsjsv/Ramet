// ---------- 终端订阅的中心侧扇出（项目面板的终端分页）----------
// connector 只往中心推中心 attach 过的终端的输出（pty-data / pty-exit，同一条 WSS）；浏览器经 SSE 订阅。
// 这里是两者之间的扇出：同一个终端可以有多个浏览器订阅，每个订阅各自 attach 一次（拿自己 after 之后的回放），
// 实时输出按 (connector, ptyId) 分发给所有订阅，各自用 seq 去重。最后一个订阅走了就通知 connector detach（它起 30 分钟闲置计时）。
//
// 归属不在这里判：attach 是带 actor 的驱动帧，connector 按 actor 校验，不是自己的终端就拒绝，订阅随即作废。
// 授权一变（收回 / 到期 / 收窄），manager 调 dropUser 结束这个人在这台机器上的全部订阅；connector 掉线则 connectorGone 结束该机器上的全部订阅。
// 订阅持有的 MachinePass 只用于最后的 detach（connector 会再判一次，授权没了被拒也无妨）。

import type { ConnMsg, DrivenMsg } from './protocol.js'
import type { MachinePass } from './machine-access.js'
import { ProjectError, type ProjectReply } from './project-types.js'
import type { PtyExitReason, PtyInfo, PtySnapshot } from './pty-types.js'

/** 终端请求的应答上限：都是本机操作，比这更久就是出问题了 */
export const PTY_TIMEOUT_MS = 15_000
/** 订阅在 attach 应答回来之前，实时输出先攒着；攒太多说明 connector 在狂刷，放弃这次订阅 */
const QUEUE_MAX = 4096

export type PtyEvent =
  | { type: 'data'; seq: number; data: string }
  | { type: 'exit'; code: number | null; reason: PtyExitReason }
  /** 中心结束了这个订阅：revoked = 授权没了；offline = 机器掉线了 */
  | { type: 'end'; reason: 'revoked' | 'offline' }

/** snapshot：全新打开 / 断得太久时 connector 给的屏幕快照（老 connector 没有，此时照旧是回放）。
 *  订阅者先按它还原屏幕，之后只会收到 seq > snapshot.seq 的输出 */
export type PtyMeta = { pty: PtyInfo; lost: boolean; snapshot?: PtySnapshot }

type Handlers = {
  /** attach 成功后、回放之前调用一次 */
  ready(meta: PtyMeta): void
  event(ev: PtyEvent): void
}

type Sub = {
  userId: string
  connectorId: string
  ptyId: string
  pass: MachinePass
  handlers: Handlers
  ready: boolean
  queue: PtyEvent[]
  /** 已交给订阅者的最大 seq（回放与实时去重） */
  lastSeq: number
  done: boolean
}

/** bridge 需要的 hub 能力（hub 自己构造 bridge，传自己进来；用接口避免循环依赖） */
export interface PtyHub {
  request(
    pass: MachinePass,
    build: (rid: string, actor: string) => Extract<DrivenMsg, { rid: string }>,
    timeoutMs?: number,
  ): Promise<ConnMsg>
}

const keyOf = (connectorId: string, ptyId: string): string => `${connectorId}\0${ptyId}`

export class PtyBridge {
  private subs = new Map<string, Set<Sub>>()

  constructor(private hub: PtyHub) {}

  /** hub.handle 把 connector 推来的 pty-data / pty-exit 交进来 */
  ingest(connectorId: string, msg: Extract<ConnMsg, { t: 'pty-data' | 'pty-exit' }>): void {
    const set = this.subs.get(keyOf(connectorId, msg.ptyId))
    if (!set) return
    const ev: PtyEvent =
      msg.t === 'pty-data' ? { type: 'data', seq: msg.seq, data: msg.data } : { type: 'exit', code: msg.code, reason: msg.reason }
    for (const sub of [...set]) this.deliver(sub, ev)
  }

  /** 这台机器的连接没了：它上面的全部订阅结束（浏览器自己重连、重新 attach 续传） */
  connectorGone(connectorId: string): void {
    this.finish((sub) => sub.connectorId === connectorId, 'offline', false)
  }

  /** 此人在这台机器上的使用权没了（收回 / 到期 / 收窄）：他的订阅当场结束 */
  dropUser(connectorId: string, userId: string): number {
    return this.finish((sub) => sub.connectorId === connectorId && sub.userId === userId, 'revoked', true)
  }

  /** 此刻的订阅数（测试用） */
  count(connectorId?: string): number {
    let n = 0
    for (const set of this.subs.values()) for (const sub of set) if (!connectorId || sub.connectorId === connectorId) n += 1
    return n
  }

  /** 订阅一个终端。attach 失败（不是你的 / 不存在 / 机器离线 / 授权不够）抛错，订阅不留痕。
   *  成功后依次：handlers.ready(meta)、回放（seq > after）、实时输出。终端已经退出时紧接着补一个 exit 事件 */
  async subscribe(pass: MachinePass, ptyId: string, after: number, handlers: Handlers): Promise<{ meta: PtyMeta; unsubscribe: () => void }> {
    const sub: Sub = {
      userId: pass.userId,
      connectorId: pass.machine,
      ptyId,
      pass,
      handlers,
      ready: false,
      queue: [],
      lastSeq: after,
      done: false,
    }
    const key = keyOf(sub.connectorId, ptyId)
    let set = this.subs.get(key)
    if (!set) this.subs.set(key, (set = new Set()))
    set.add(sub) // 先登记再 attach：attach 应答之后紧跟着的实时输出不能漏
    let reply: Extract<ProjectReply, { op: 'pty-attach' }>
    try {
      const msg = await this.hub.request(pass, (rid, actor) => ({ t: 'pty-attach', rid, actor, ptyId, after }), PTY_TIMEOUT_MS)
      if (msg.t === 'err') throw new ProjectError(msg.message, msg.code === 'forbidden', msg.code === 'not_found')
      if (msg.t !== 'res' || msg.project?.op !== 'pty-attach') throw new ProjectError('connector 没有返回预期的内容')
      reply = msg.project
    } catch (err) {
      this.remove(sub, false)
      throw err
    }
    if (sub.done) throw new ProjectError('订阅已结束') // attach 等应答期间授权被收回 / 机器掉线
    const meta: PtyMeta = { pty: reply.pty, lost: reply.lost, ...(reply.snapshot ? { snapshot: reply.snapshot } : {}) }
    // 快照已含 seq ≤ snapshot.seq 的全部输出，排队里这部分（connector 先订阅、后取快照，期间推来的）按 seq 去重丢掉
    if (reply.snapshot) sub.lastSeq = Math.max(sub.lastSeq, reply.snapshot.seq)
    handlers.ready(meta)
    sub.ready = true
    for (const c of reply.replay) this.emit(sub, { type: 'data', seq: c.seq, data: c.data })
    for (const ev of sub.queue.splice(0)) this.emit(sub, ev)
    if (!reply.pty.alive) this.emit(sub, { type: 'exit', code: reply.pty.exitCode, reason: 'exited' })
    return { meta, unsubscribe: () => this.remove(sub, true) }
  }

  private deliver(sub: Sub, ev: PtyEvent): void {
    if (sub.done) return
    if (!sub.ready) {
      if (sub.queue.length >= QUEUE_MAX) sub.queue.length = 0
      sub.queue.push(ev)
      return
    }
    this.emit(sub, ev)
  }

  private emit(sub: Sub, ev: PtyEvent): void {
    if (sub.done) return
    if (ev.type === 'data') {
      if (ev.seq <= sub.lastSeq) return
      sub.lastSeq = ev.seq
    }
    try {
      sub.handlers.event(ev)
    } catch {
      // 订阅者（SSE 写出）挂了，不能拖垮别的订阅，等它自己 unsubscribe
    }
  }

  /** 结束符合条件的订阅并告诉订阅者原因。detach = 要不要通知 connector（connector 掉线了就没必要） */
  private finish(match: (sub: Sub) => boolean, reason: 'revoked' | 'offline', detach: boolean): number {
    let n = 0
    for (const set of [...this.subs.values()]) {
      for (const sub of [...set]) {
        if (!match(sub) || sub.done) continue
        n += 1
        const wasReady = sub.ready
        this.remove(sub, detach)
        if (wasReady) {
          try {
            sub.handlers.event({ type: 'end', reason })
          } catch {
            // 同上
          }
        }
      }
    }
    return n
  }

  /** 摘掉订阅；该终端没有别的订阅了就通知 connector detach（尽力而为，授权没了或机器掉线被拒 / 发不出去都无妨） */
  private remove(sub: Sub, detach: boolean): void {
    if (sub.done) return
    sub.done = true
    const key = keyOf(sub.connectorId, sub.ptyId)
    const set = this.subs.get(key)
    if (!set) return
    set.delete(sub)
    if (set.size > 0) return
    this.subs.delete(key)
    if (!detach) return
    void this.hub
      .request(sub.pass, (rid, actor) => ({ t: 'pty-detach', rid, actor, ptyId: sub.ptyId }), PTY_TIMEOUT_MS)
      .catch(() => undefined)
  }
}
