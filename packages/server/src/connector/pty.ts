// ---------- connector 的终端执行端：pty 的开 / 写 / 改尺寸 / 关 / 回放 / 闲置回收 ----------
// 跑在 agent 所在机器上。node-pty 只在这个进程里动态加载（loadNodePty），中心进程不加载它；加载不上（没装 / 平台不支持）时
// connector 的 hello 里不带 `terminal` 能力，中心对这台机器回 409，其余能力（agent、项目面板）不受影响。
//
// 归属由这里判，不只靠中心（帧已过 connector/index.ts 的第二道闸：actor 是主人或 machine 范围的授权人）：
//   - pty 属于打开它的人（actor）。input / resize / attach / detach 只有他能做；
//   - close：他自己，或机器主人（isOwner）。主人能在 list 里看到这台机器上所有人的终端并关掉，但不能往别人的终端里输入；
//   - 别人的 ptyId（不论存不存在于别人名下）一律 forbidden，一个字节也写不进去。
// 授权一变就收：closeActor（grant-revoked / access-reduced 帧）立刻关；tick 里的 stillAllowed 再兜一层，本机名单是权威，
// 到期 / 被收窄的人哪怕中心没通知（离线、有 bug），最多 ACCESS_TICK_MS 之后他的终端也会被关掉。
//
// 输出：node-pty 的 onData 先在 mergeMs 内合并成块（seq 递增），留最近 replayBytes 做回放，同时喂给这个终端的权威屏幕
// （pty-screen.ts）；只有中心 attach 过（subscribed）才往中心推 pty-data。没有订阅者（浏览器关了 / 中心断了）超过 idleMs
// （7 天）就关掉。attach：全新打开 / 断得太久缓冲接不上 → 屏幕快照；短暂断线 → 按 seq 补差量（见 attach）。

import { randomUUID } from 'node:crypto'
import type { ConnMsg, PtyMsg } from '../agents/protocol.js'
import {
  PTY_COLS_DEFAULT,
  PTY_COLS_MAX,
  PTY_IDLE_MS,
  PTY_INPUT_MAX,
  PTY_MAX_PER_ACTOR,
  PTY_REPLAY_BYTES,
  PTY_ROWS_DEFAULT,
  PTY_ROWS_MAX,
  PtyError,
  type PtyChunk,
  type PtyExitReason,
  type PtyInfo,
  type PtyReply,
} from '../agents/pty-types.js'
import { resolveInRoot } from './project-path.js'
import { PtyScreen } from './pty-screen.js'

/** node-pty 里用得到的那一小截接口（自己声明一份：测试可以注入假的，也不依赖它的类型包是否装上） */
export type PtyProcess = {
  readonly pid: number
  onData(listener: (data: string) => void): unknown
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): unknown
  resize(cols: number, rows: number): void
  write(data: string): void
  kill(signal?: string): void
  pause(): void
  resume(): void
}
export type PtyModule = {
  spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): PtyProcess
}

/** 动态加载 node-pty。装不上（--omit=optional / 平台没有预编译包）→ null，connector 就不声明终端能力 */
export async function loadNodePty(): Promise<PtyModule | null> {
  try {
    const mod = await import('@lydell/node-pty')
    return typeof mod.spawn === 'function' ? (mod as unknown as PtyModule) : null
  } catch {
    return null
  }
}

/** 终端的环境变量：继承 connector 进程的，但去掉所有 RAMET_*（那是 Ramet 自己的配置，不该进别人的 shell），并设 TERM */
export function ptyEnv(src: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(src)) {
    if (value === undefined || /^RAMET_/i.test(key)) continue
    out[key] = value
  }
  out.TERM = 'xterm-256color'
  return out
}

/** shell 的可执行文件名（/bin/zsh → zsh；Windows 的 C:\\...\\cmd.exe → cmd） */
function shellName(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file
  return base.replace(/\.exe$/i, '')
}

/** 候选 shell：$SHELL（没有就 /bin/sh）；Windows 用 COMSPEC。第一个能起来的就用（$SHELL 写错了不该让终端整个不可用） */
function shellCandidates(): string[] {
  if (process.platform === 'win32') return [process.env.COMSPEC || 'cmd.exe']
  return [...new Set([process.env.SHELL, '/bin/sh'].filter((s): s is string => Boolean(s)))]
}

export type PtyDeps = {
  send: (msg: ConnMsg) => boolean
  /** 这个人是不是这台机器的主人（本机钉住的 ownerId）：close / list 用 */
  isOwner: (actor: string) => boolean
  /** 不对网页开放的路径（connector 的配置目录）：终端的起始目录也不能落在其中 */
  protect: readonly string[]
  /** 此刻这个人还有没有 machine 范围的使用权（读本机名单）。tick 里据此回收：授权到期 / 被收窄的人，他的终端要关 */
  stillAllowed?: (actor: string) => boolean
  /** 往中心写 socket 的积压字节数：太多就暂停 pty 的读（子进程会被 pty 缓冲挡住），免得慢链路把内存堆爆 */
  backlog?: () => number
  /** 测试注入：固定 shell */
  shell?: string
  maxPerActor?: number
  replayBytes?: number
  idleMs?: number
  /** 输出合并窗口 */
  mergeMs?: number
  /** 回收巡检间隔（0 = 不自动巡检，测试手动 tick） */
  tickMs?: number
  log?: (line: string) => void
}

type Entry = {
  id: string
  actor: string
  root: string
  /** 起的是哪个 shell（可执行文件名，如 zsh / bash）：网页上终端 ⌘J 把它交给模型，建议的命令才对得上语法 */
  shell: string
  proc: PtyProcess
  cols: number
  rows: number
  createdAt: number
  /** 进程还没退出（被 remove 时也置 false：不再接受输入） */
  alive: boolean
  /** 收到了 onExit（进程确实结束了）：SIGKILL 兜底据此判断，别对一个已经回收的 pid 发信号 */
  exited: boolean
  exitCode: number | null
  /** 已经被 remove（关掉 / 清掉）：晚到的 onData / onExit 不再处理 */
  removed: boolean
  chunks: Array<PtyChunk & { size: number }>
  bytes: number
  /** 权威屏幕：每块输出都喂给它，attach 时据它出快照 */
  screen: PtyScreen
  nextSeq: number
  /** 合并窗口里还没成块的输出 */
  pending: string
  timer: NodeJS.Timeout | null
  /** 中心 attach 过：输出才往中心推 */
  subscribed: boolean
  /** 没有订阅者的起点（有订阅者 = null） */
  idleSince: number | null
  paused: boolean
}

const MERGE_MAX_CHARS = 32 * 1024
/** 往中心的积压超过它就暂停读 pty，降到 LOW 以下再恢复 */
const BACKLOG_HIGH = 2 * 1024 * 1024
const BACKLOG_LOW = 512 * 1024
const ACCESS_TICK_MS = 15_000

const clampSize = (value: unknown, fallback: number, max: number): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(Math.max(n, 1), max)
}

export class PtyManager {
  private ptys = new Map<string, Entry>()
  private ticker: NodeJS.Timeout | null = null
  private resumer: NodeJS.Timeout | null = null
  private readonly max: number
  private readonly replayBytes: number
  private readonly idleMs: number
  private readonly mergeMs: number

  constructor(
    private mod: PtyModule,
    private deps: PtyDeps,
  ) {
    this.max = deps.maxPerActor ?? PTY_MAX_PER_ACTOR
    this.replayBytes = deps.replayBytes ?? PTY_REPLAY_BYTES
    this.idleMs = deps.idleMs ?? PTY_IDLE_MS
    this.mergeMs = deps.mergeMs ?? 16
    const tickMs = deps.tickMs ?? ACCESS_TICK_MS
    if (tickMs > 0) {
      this.ticker = setInterval(() => this.tick(), tickMs)
      this.ticker.unref()
    }
  }

  get size(): number {
    return this.ptys.size
  }

  /** 一帧对应一个应答。归属在各方法里判（own / close / list） */
  async handle(msg: PtyMsg): Promise<PtyReply> {
    switch (msg.t) {
      case 'pty-open':
        return this.open(msg.actor, msg)
      case 'pty-input':
        return this.input(msg.actor, msg.ptyId, msg.data)
      case 'pty-resize':
        return this.resize(msg.actor, msg.ptyId, msg.cols, msg.rows)
      case 'pty-close':
        return this.close(msg.actor, msg.ptyId)
      case 'pty-attach':
        return this.attach(msg.actor, msg.ptyId, msg.after)
      case 'pty-detach':
        return this.detach(msg.actor, msg.ptyId)
      case 'pty-list':
        return this.list(msg.actor)
    }
  }

  async open(actor: string, f: { root: string; cols?: number; rows?: number }): Promise<PtyReply> {
    // 先把路径约束做完（realpath、不落在配置目录里），再点数——两步之间别的 open 可能插进来，所以点数放在 await 之后紧挨着 spawn
    const { root } = await resolveInRoot(f.root, '', this.deps.protect)
    this.evictExited(actor)
    if ([...this.ptys.values()].filter((e) => e.actor === actor && e.alive).length >= this.max) {
      throw new PtyError(`你在这台机器上最多同时开 ${this.max} 个终端，先关掉一个`)
    }
    const cols = clampSize(f.cols, PTY_COLS_DEFAULT, PTY_COLS_MAX)
    const rows = clampSize(f.rows, PTY_ROWS_DEFAULT, PTY_ROWS_MAX)
    let proc: PtyProcess | null = null
    let shell = ''
    let lastError = ''
    for (const file of this.deps.shell ? [this.deps.shell] : shellCandidates()) {
      try {
        proc = this.mod.spawn(file, [], { name: 'xterm-256color', cols, rows, cwd: root, env: ptyEnv(process.env) })
        shell = shellName(file)
        break
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
    }
    if (!proc) throw new PtyError(`终端启动失败：${lastError}`)
    const entry: Entry = {
      id: randomUUID(),
      actor,
      root,
      shell,
      proc,
      cols,
      rows,
      createdAt: Date.now(),
      alive: true,
      exited: false,
      exitCode: null,
      removed: false,
      chunks: [],
      bytes: 0,
      screen: new PtyScreen(cols, rows),
      nextSeq: 0,
      pending: '',
      timer: null,
      subscribed: false,
      idleSince: Date.now(),
      paused: false,
    }
    this.ptys.set(entry.id, entry)
    proc.onData((data) => this.onData(entry, data))
    proc.onExit((e) => this.onExit(entry, e))
    this.deps.log?.(`终端 open actor=${actor} root=${root} pty=${entry.id}`)
    return { op: 'pty-open', pty: this.info(entry) }
  }

  input(actor: string, ptyId: string, data: unknown): PtyReply {
    const e = this.own(actor, ptyId)
    if (typeof data !== 'string') throw new PtyError('输入无效')
    if (data.length > PTY_INPUT_MAX) throw new PtyError('一次输入太长')
    if (!e.alive) throw new PtyError('这个终端已经退出了')
    e.proc.write(data)
    return { op: 'pty-input' }
  }

  resize(actor: string, ptyId: string, cols: unknown, rows: unknown): PtyReply {
    const e = this.own(actor, ptyId)
    const c = clampSize(cols, e.cols, PTY_COLS_MAX)
    const r = clampSize(rows, e.rows, PTY_ROWS_MAX)
    if (e.alive && (c !== e.cols || r !== e.rows)) {
      e.proc.resize(c, r)
      this.flush(e) // 改尺寸之前的输出先入屏幕，屏幕的 resize 排在它们之后（与真实终端的先后一致）
      e.screen.resize(c, r)
      e.cols = c
      e.rows = r
    }
    return { op: 'pty-resize' }
  }

  /** 关闭：打开它的人，或机器主人。不存在 → not_found（调用方当成「已经关了」） */
  close(actor: string, ptyId: string): PtyReply {
    const e = this.ptys.get(ptyId)
    if (!e) throw new PtyError('这个终端不存在或已经关闭', 'not_found')
    if (e.actor !== actor && !this.deps.isOwner(actor)) throw new PtyError('这不是你的终端', 'forbidden')
    this.deps.log?.(`终端 close actor=${actor} pty=${ptyId}${e.actor === actor ? '' : `（机器主人关闭了 ${e.actor} 的终端）`}`)
    this.remove(e, 'closed')
    return { op: 'pty-close' }
  }

  /** 订阅：此后输出实时推给中心；应答里要么是 after 之后的回放（短暂断线、缓冲还接得上），要么是屏幕快照
   *  （全新打开 after = -1，或断得太久缓冲已经接不上）。
   *  先订阅、再取快照：等快照的这段时间里新来的块照常推给中心，它们的 seq 都大于 snapshot.seq，中心按 seq 去重后
   *  接在快照之后，一条不丢、一条不重（pty-screen.ts 保证快照与 seq 严格对齐）。补差量的路径在同一个同步段里完成，同理 */
  async attach(actor: string, ptyId: string, after: unknown): Promise<PtyReply> {
    const e = this.own(actor, ptyId)
    const since = typeof after === 'number' && Number.isFinite(after) ? Math.floor(after) : -1
    this.flush(e)
    e.subscribed = true
    e.idleSince = null
    const first = e.chunks[0]?.seq ?? e.nextSeq
    if (since >= 0 && since + 1 >= first) {
      return {
        op: 'pty-attach',
        pty: this.info(e),
        replay: e.chunks.filter((c) => c.seq > since).map(({ seq, data }) => ({ seq, data })),
        last: e.nextSeq - 1,
        lost: false,
      }
    }
    const snapshot = await e.screen.snapshot()
    return { op: 'pty-attach', pty: this.info(e), replay: [], last: snapshot.seq, lost: false, snapshot }
  }

  /** 中心不再有订阅者：停止推送，起闲置计时 */
  detach(actor: string, ptyId: string): PtyReply {
    const e = this.own(actor, ptyId)
    this.unsubscribe(e, Date.now())
    return { op: 'pty-detach' }
  }

  /** 机器主人看到这台机器上所有人的终端，其他人只看到自己的 */
  list(actor: string): PtyReply {
    const all = this.deps.isOwner(actor)
    return { op: 'pty-list', ptys: [...this.ptys.values()].filter((e) => all || e.actor === actor).map((e) => this.info(e)) }
  }

  /** 此人的终端全关（授权收回 / 收窄）。返回关了几个 */
  closeActor(actor: string, reason: PtyExitReason = 'revoked'): number {
    let n = 0
    for (const e of [...this.ptys.values()]) {
      if (e.actor !== actor) continue
      this.remove(e, reason)
      n += 1
    }
    if (n > 0) this.deps.log?.(`终端 已关闭 actor=${actor} 共 ${n} 个（${reason}）`)
    return n
  }

  /** socket 没了：所有终端都没有订阅者了（输出留在回放缓冲里，重连后 attach 补齐） */
  onDisconnect(): void {
    const now = Date.now()
    for (const e of this.ptys.values()) this.unsubscribe(e, now)
    this.resumeAll()
  }

  /** 巡检：授权不再有效的人的终端关掉；没有订阅者太久的关掉。测试直接调（可传时钟） */
  tick(now: number = Date.now()): void {
    if (this.deps.stillAllowed) {
      for (const actor of new Set([...this.ptys.values()].map((e) => e.actor))) {
        if (!this.deps.stillAllowed(actor)) this.closeActor(actor, 'revoked')
      }
    }
    for (const e of [...this.ptys.values()]) {
      if (!e.subscribed && e.idleSince !== null && now - e.idleSince > this.idleMs) {
        this.deps.log?.(`终端 闲置超时 pty=${e.id}`)
        this.remove(e, 'idle')
      }
    }
  }

  /** connector 收尾：全部关掉 */
  dispose(): void {
    if (this.ticker) clearInterval(this.ticker)
    if (this.resumer) clearInterval(this.resumer)
    this.ticker = this.resumer = null
    for (const e of [...this.ptys.values()]) this.remove(e, 'shutdown')
  }

  /** 取得「我的」终端：不存在 → not_found；是别人的 → forbidden（连主人也不行：主人只能关，不能输入 / 订阅） */
  private own(actor: string, ptyId: string): Entry {
    const e = typeof ptyId === 'string' ? this.ptys.get(ptyId) : undefined
    if (!e) throw new PtyError('这个终端不存在或已经关闭', 'not_found')
    if (e.actor !== actor) throw new PtyError('这不是你的终端', 'forbidden')
    return e
  }

  private info(e: Entry): PtyInfo {
    return {
      ptyId: e.id,
      actor: e.actor,
      root: e.root,
      ...(e.shell ? { shell: e.shell } : {}),
      cols: e.cols,
      rows: e.rows,
      alive: e.alive,
      exitCode: e.exitCode,
      createdAt: e.createdAt,
    }
  }

  /** 已退出的终端占着回放槽，同一人超过上限就清掉最老的（不然开了又 exit 五次就再也开不了了） */
  private evictExited(actor: string): void {
    const exited = [...this.ptys.values()].filter((e) => e.actor === actor && !e.alive).sort((a, b) => a.createdAt - b.createdAt)
    for (const e of exited.slice(0, Math.max(0, exited.length - (this.max - 1)))) this.remove(e, 'closed')
  }

  private unsubscribe(e: Entry, now: number): void {
    if (!e.subscribed) return
    e.subscribed = false
    e.idleSince = now
  }

  private onData(e: Entry, data: string): void {
    if (e.removed) return
    e.pending += data
    if (e.pending.length >= MERGE_MAX_CHARS) this.flush(e)
    else e.timer ??= setTimeout(() => this.flush(e), this.mergeMs)
  }

  /** 合并窗口里的输出成块：进回放缓冲，订阅着就推给中心 */
  private flush(e: Entry): void {
    if (e.timer) {
      clearTimeout(e.timer)
      e.timer = null
    }
    if (!e.pending) return
    const data = e.pending
    e.pending = ''
    const chunk = { seq: e.nextSeq++, data, size: Buffer.byteLength(data) }
    e.chunks.push(chunk)
    e.bytes += chunk.size
    e.screen.feed(chunk.seq, data)
    while (e.bytes > this.replayBytes && e.chunks.length > 1) e.bytes -= e.chunks.shift()!.size
    if (!e.subscribed) return
    this.deps.send({ t: 'pty-data', ptyId: e.id, seq: chunk.seq, data })
    this.relieve(e)
  }

  /** 往中心的积压太多：暂停这个 pty 的读，等 socket 排空再恢复 */
  private relieve(e: Entry): void {
    if (!this.deps.backlog || e.paused || this.deps.backlog() < BACKLOG_HIGH) return
    e.paused = true
    e.proc.pause()
    this.resumer ??= setInterval(() => {
      if ((this.deps.backlog?.() ?? 0) < BACKLOG_LOW) this.resumeAll()
    }, 50)
  }

  private resumeAll(): void {
    if (this.resumer) {
      clearInterval(this.resumer)
      this.resumer = null
    }
    for (const e of this.ptys.values()) {
      if (!e.paused) continue
      e.paused = false
      if (e.alive) e.proc.resume()
    }
  }

  private onExit(e: Entry, ev: { exitCode: number; signal?: number }): void {
    e.exited = true
    if (e.removed) return // 被 remove 的终端已经通知过订阅者了
    this.flush(e)
    e.alive = false
    // 被信号杀掉（signal 非 0）没有退出码
    e.exitCode = ev.signal ? null : ev.exitCode
    if (e.subscribed) this.deps.send({ t: 'pty-exit', ptyId: e.id, code: e.exitCode, reason: 'exited' })
    if (!e.subscribed) e.idleSince ??= Date.now()
  }

  /** 摘掉一个终端：杀进程（还活着的话）、通知订阅者。晚到的 onData / onExit 因 removed 被忽略 */
  private remove(e: Entry, reason: PtyExitReason): void {
    if (e.removed) return
    e.removed = true
    if (e.timer) clearTimeout(e.timer)
    e.timer = null
    e.screen.dispose()
    this.ptys.delete(e.id)
    const wasAlive = e.alive
    e.alive = false
    if (wasAlive) {
      try {
        e.proc.kill()
      } catch {
        // 已经退了
      }
      // SIGHUP 杀不掉忽略它的程序：3 秒后还在就 SIGKILL（Windows 没有信号，proc.kill() 已经是强杀）
      if (process.platform !== 'win32') {
        const pid = e.proc.pid
        const t = setTimeout(() => {
          if (e.exited) return
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // 已经没了
          }
        }, 3000)
        t.unref()
      }
    }
    if (e.subscribed) this.deps.send({ t: 'pty-exit', ptyId: e.id, code: e.exitCode, reason })
  }
}
