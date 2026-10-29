// 在飞 prompt 的寿命在 connector 进程里，不在某一条 websocket 上。
// 中心重启或网络断开都不是这一轮的结果：事件从 prompt 一开始就留在这里，
// 直到适配器 end/err，或中心在 welcome 里明确不要（drop / 不在 resume 里）。
//
// seq 是缓冲下标，从 0 递增，一条即将发出去的 ev/end/err 一个号。中心的
// welcome.resume.after 指的就是这个下标。已经占号的不能再合并——合并会让
// 重放和 after 对不齐。断线期间还没占号的相邻 text/thought 先合成一条再占号；
// 工具、权限、用量以及任何非文字事件各自占号，不能并进正文。
// 这里只做缓冲和重放，不把 AgentEvent 折成 RunRecord（那是中心的事）。

import type { ConnMsg } from '../agents/protocol.js'
import type { AgentEvent, TurnUsage } from '../agents/types.js'

export type InflightIdentity = { runId: string; agent: string; sessionId: string }

type Delta = Extract<AgentEvent, { type: 'text' | 'thought' }>
type EvRec = { t: 'ev'; rid: string; runId: string; seq: number; ev: AgentEvent }
type EndRec = { t: 'end'; rid: string; runId: string; seq: number; stopReason: string; usage?: TurnUsage }
type ErrRec = { t: 'err'; rid: string; runId: string; seq: number; message: string }

type Run = {
  runId: string
  agent: string
  sessionId: string
  /** 这一轮 prompt 自己的请求号。后来的 config/new/load 不能改它。 */
  rid: string
  /** 最近一次 hello 的代号。等于当前代号的是这条连接上才开始的，welcome 没点名也不能取消。 */
  wave: number
  events: EvRec[]
  nextSeq: number
  /** 还没占号的 text/thought。断线期间相邻增量堆在这里。 */
  tail: Delta | null
  terminal: EndRec | ErrRec | null
  /** 这条连接上可以往外送了（welcome 重放已发完，或 prompt 就是在 live 时开始的）。 */
  live: boolean
  /** 当前 socket 已经写出的最大 seq。断线清掉：下一次只认中心给的 after。 */
  sentSeq: number
  /** 曾经成功写出过的最大 seq。不断线清：旧中心没有 after，靠它只补缺口。 */
  deliveredSeq: number
  /** 这条连接上 seq ≤ 它的不再发（中心已经折进 RunRecord）。断线清成 -1。 */
  replayedThrough: number
}

export type Inflight = {
  /** 发 hello 时调用一次。含「断线期间已经 end、但终态还没写进 socket」的回合：
   *  不报的话中心会当成这个进程已经不跑它，把那一轮收成 error。不含事件日志。 */
  helloList(): InflightIdentity[]
  /** socket 没了。不取消适配器，只是停止往外送，好让断线期间的增量合成。 */
  onDisconnect(): void
  /**
   * resume 缺省 = 旧中心：不取消、不重放积压。
   * resume 是数组（可空）= 中心还要的完整集合；不在里面的在飞回合按 drop 取消。
   */
  onWelcome(resume: { runId: string; after: number }[] | undefined, drop: string[] | undefined): void
  /** 重复 runId 返回 false，调用方不能再开一轮 prompt。 */
  begin(input: { runId: string; agent: string; sessionId: string; rid: string }): boolean
  push(runId: string, ev: AgentEvent): void
  finish(runId: string, outcome: { t: 'end'; stopReason: string; usage?: TurnUsage } | { t: 'err'; message: string }): void
  /** 适配器还在跑（终态还没产生）才返回。已经 end 的不能再 cancel 会话。 */
  running(runId: string): InflightIdentity | undefined
  /** 这个会话上还有没交出去的 prompt 时，返回它的 rid。 */
  ownerRid(sessionId: string): string | undefined
}

function isDelta(ev: AgentEvent): ev is Delta {
  return ev.type === 'text' || ev.type === 'thought'
}

/** 只有同一种文字、同一个子代理流才能并。thought 不能并进 text，换 parent 也不能。 */
function sameChunk(a: Delta, b: Delta): boolean {
  return a.type === b.type && a.parentId === b.parentId && a.sessionId === b.sessionId
}

export function createInflight(opts: {
  send: (msg: ConnMsg) => boolean
  cancel: (agent: string, sessionId: string) => void
  log?: (line: string) => void
}): Inflight {
  const runs = new Map<string, Run>()
  /** 当前这条连接已经 welcome 过。新 prompt 的事件可以直接送。 */
  let connLive = false
  /** helloList 自增。begin 时抄下来，用来区分「重连前就在跑」和「这条连接上才开始」。 */
  let wave = 0

  function send(msg: ConnMsg): boolean {
    try {
      return opts.send(msg)
    } catch {
      return false
    }
  }

  function sealTail(run: Run): void {
    const tail = run.tail
    if (!tail) return
    run.tail = null
    run.events.push({ t: 'ev', rid: run.rid, runId: run.runId, seq: run.nextSeq++, ev: tail })
  }

  function markSent(run: Run, seq: number): void {
    run.sentSeq = seq
    if (seq > run.deliveredSeq) run.deliveredSeq = seq
  }

  /** 写出失败的末尾文字还没人拿到，把号退回去，好继续和后面的增量合成。工具事件已经占号就留着。 */
  function backoffTail(run: Run): void {
    if (run.terminal) return
    const last = run.events.at(-1)
    if (!last || last.seq <= run.sentSeq || last.seq !== run.nextSeq - 1) return
    if (!isDelta(last.ev)) return
    run.events.pop()
    run.nextSeq = last.seq
    run.tail = last.ev
  }

  function emitEv(run: Run, ev: EvRec): boolean {
    if (!send(ev)) {
      // 只退回「正在发、且是目前最后一个号」的文字。中间那条失败不能把后面的号拆掉。
      if (ev.seq === run.nextSeq - 1) backoffTail(run)
      return false
    }
    markSent(run, ev.seq)
    return true
  }

  /** 终态已经写进 socket，或中心表示已经有了：缓冲可以放。没写成功就留着，等下一次 welcome。 */
  function pump(run: Run): void {
    if (!run.live) return
    for (const ev of [...run.events]) {
      if (ev.seq <= run.replayedThrough || ev.seq <= run.sentSeq) continue
      if (!emitEv(run, ev)) return
    }
    if (!run.terminal) return
    if (run.terminal.seq <= run.replayedThrough || run.terminal.seq <= run.sentSeq) {
      runs.delete(run.runId)
      return
    }
    if (!send(run.terminal)) return
    markSent(run, run.terminal.seq)
    runs.delete(run.runId)
  }

  function dropRun(run: Run): void {
    const stillRunning = run.terminal === null
    runs.delete(run.runId)
    if (!stillRunning) return
    // 没绑定的回合不能空转烧 token。已经 end 的只是把没交出去的缓冲丢掉，不能再 cancel 会话。
    opts.log?.(`中心不要 runId=${run.runId}，取消本地 prompt`)
    opts.cancel(run.agent, run.sessionId)
  }

  /** 先补 seq > after 的事件，再 resumed，终态放在 resumed 之后。
   *  中心要等 resumed 才从「静默折进 RunRecord」切到往 SSE 推。 */
  function replay(run: Run, after: number): void {
    sealTail(run)
    run.replayedThrough = after
    for (const ev of [...run.events]) {
      if (ev.seq <= after || ev.seq <= run.sentSeq) continue
      if (!emitEv(run, ev)) return
    }
    if (!send({ t: 'resumed', runId: run.runId })) return
    run.live = true
    // 重放循环里新到的文字还堆在尾巴上，占号后排在 resumed 后面，算这条连接上的新事件。
    sealTail(run)
    pump(run)
  }

  /** 旧中心不认 resume。不取消，也不把已经交给它的前缀再倒一遍（没有 after，重放会重复）。
   *  断线期间没写出的缺口照常补上——那些消息它认识。缓冲留到这一轮真正结束，
   *  这样下一次如果换成会 resume 的中心，after = -1 仍能整段重放。 */
  function adoptLegacy(): void {
    connLive = true
    for (const run of [...runs.values()]) {
      sealTail(run)
      run.sentSeq = run.deliveredSeq
      run.replayedThrough = run.deliveredSeq
      run.live = true
      pump(run)
    }
  }

  return {
    helloList() {
      wave += 1
      const out: InflightIdentity[] = []
      for (const run of runs.values()) {
        out.push({ runId: run.runId, agent: run.agent, sessionId: run.sessionId })
      }
      return out
    },

    onDisconnect() {
      connLive = false
      for (const run of runs.values()) {
        run.live = false
        run.sentSeq = -1
        run.replayedThrough = -1
      }
    },

    onWelcome(resume, drop) {
      if (resume === undefined) {
        adoptLegacy()
        return
      }
      const wanted = new Set(resume.map((item) => item.runId))
      const rejected = new Set(drop ?? [])
      for (const run of [...runs.values()]) {
        if (wanted.has(run.runId)) continue
        // 这条连接上才开始的 prompt 不在 hello 里，welcome 也不会点它的名。
        // 只有中心把它写进 drop 才取消；否则空 resume 会把刚收到的 prompt 杀掉。
        if (run.wave === wave && !rejected.has(run.runId)) continue
        dropRun(run)
      }
      connLive = true
      for (const item of resume) {
        const run = runs.get(item.runId)
        if (run) replay(run, item.after)
      }
      // resume 没点名、但也没资格 drop 的（本波才 begin 的）直接开送，不插 resumed。
      for (const run of [...runs.values()]) {
        if (run.live || wanted.has(run.runId)) continue
        run.live = true
        sealTail(run)
        pump(run)
      }
    },

    begin(input) {
      if (runs.has(input.runId)) return false
      runs.set(input.runId, {
        runId: input.runId,
        agent: input.agent,
        sessionId: input.sessionId,
        rid: input.rid,
        wave,
        events: [],
        nextSeq: 0,
        tail: null,
        terminal: null,
        live: connLive,
        sentSeq: -1,
        deliveredSeq: -1,
        replayedThrough: -1,
      })
      return true
    },

    push(runId, ev) {
      const run = runs.get(runId)
      if (!run || run.terminal) return
      const sid = 'sessionId' in ev ? ev.sessionId : undefined
      // 同一个适配器进程上别的会话的事件不能占这个 run 的 seq。
      if (sid && sid !== run.sessionId) return
      if (isDelta(ev)) {
        if (run.tail && sameChunk(run.tail, ev)) {
          run.tail = { ...run.tail, delta: run.tail.delta + ev.delta }
        } else {
          sealTail(run)
          run.tail = { ...ev }
        }
        // socket 还开着就马上占号发出去：合成只发生在还没占号的尾巴上，
        // 不能为了合并把正在流的正文憋到下一条工具事件。
        if (run.live) {
          sealTail(run)
          pump(run)
        }
        return
      }
      sealTail(run)
      run.events.push({ t: 'ev', rid: run.rid, runId: run.runId, seq: run.nextSeq++, ev })
      if (run.live) pump(run)
    },

    finish(runId, outcome) {
      const run = runs.get(runId)
      if (!run || run.terminal) return
      sealTail(run)
      const seq = run.nextSeq++
      if (outcome.t === 'end') {
        run.terminal = {
          t: 'end',
          rid: run.rid,
          runId: run.runId,
          seq,
          stopReason: outcome.stopReason,
          ...(outcome.usage ? { usage: outcome.usage } : {}),
        }
      } else {
        run.terminal = { t: 'err', rid: run.rid, runId: run.runId, seq, message: outcome.message }
      }
      pump(run)
    },

    running(runId) {
      const run = runs.get(runId)
      if (!run || run.terminal) return undefined
      return { runId: run.runId, agent: run.agent, sessionId: run.sessionId }
    },

    ownerRid(sessionId) {
      for (const run of runs.values()) {
        if (run.sessionId === sessionId) return run.rid
      }
      return undefined
    },
  }
}
