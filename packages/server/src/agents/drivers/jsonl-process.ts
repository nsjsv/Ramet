// ---------- 说 JSONL 的 agent 子进程 ----------
// 原生协议（codex app-server、pi / omp 的 rpc 模式等）都是 stdin / stdout 每行一个 JSON。这里只管进程与分帧：
// spawn、严格按 LF 切行、stderr 留尾巴、退出时给出人话原因、kill。协议语义由各驱动自己处理。
//
// 分帧不能用 Node 的 readline：它把 U+2028 / U+2029 也当换行，而 JSON.stringify 不转义这两个字符，
// agent 回复里只要出现一个（从网页 / PDF 复制来的文字常有），一条消息就被劈成两半、两半都解析失败。

import { spawn, type ChildProcess } from 'node:child_process'

export type AgentExit = { code: number | null; signal: NodeJS.Signals | null }

/** 子进程 stderr 只留尾巴：stdout 是协议通道，不能混进去；整段也不该进红条 */
const STDERR_TAIL = 2_000

/** 进程没了的一句人话：退出码或信号 + stderr 末尾几行。kind 是协议名（如「JSONL」），让人知道断的是哪一层 */
export function describeProcessExit(id: string, kind: string, exit: AgentExit | null, stderr: string): string {
  const why = !exit ? 'stdio 已关闭' : exit.signal ? `信号 ${exit.signal}` : `退出码 ${exit.code}`
  const tail = stderr.trim().split('\n').map((line) => line.trim()).filter(Boolean).slice(-6).join(' | ')
  const clipped = tail.length > 500 ? `…${tail.slice(-500)}` : tail
  return clipped ? `${id} 的 ${kind} 进程断了（${why}）：${clipped}` : `${id} 的 ${kind} 进程断了（${why}）`
}

/** 严格 LF 分帧：只按 `\n` 切，去掉行尾一个 `\r`（Windows 上的 CLI 会写 CRLF）。没收全的半行留到下一块 */
export class LineSplitter {
  private buf = ''

  push(chunk: string): string[] {
    this.buf += chunk
    const lines: string[] = []
    let start = 0
    for (let i = this.buf.indexOf('\n'); i >= 0; i = this.buf.indexOf('\n', start)) {
      lines.push(stripCr(this.buf.slice(start, i)))
      start = i + 1
    }
    this.buf = this.buf.slice(start)
    return lines
  }

  /** 流结束时剩下的半行（最后一条消息没写换行）；没有返回 null */
  flush(): string | null {
    const rest = stripCr(this.buf)
    this.buf = ''
    return rest ? rest : null
  }
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

export type JsonlProcessOptions = {
  /** agent id（只用于退出说明） */
  id: string
  /** 退出说明里的协议名 */
  kind?: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** 每条解析成功的消息 */
  onMessage: (msg: unknown) => void
  /** stdout 上不是 JSON 的行（有的 CLI 会往 stdout 打提示）。缺省丢掉 */
  onNoise?: (line: string) => void
  /** 进程结束（stdio 都关了之后，最后一条消息已经交给 onMessage）。crashed = 不是我们 kill 的 */
  onExit?: (info: { exit: AgentExit | null; crashed: boolean; reason: string }) => void
}

export class JsonlProcess {
  private readonly proc: ChildProcess
  private readonly lines = new LineSplitter()
  private stderrTail = ''
  private exitInfo: AgentExit | null = null
  private spawnError: Error | null = null
  private ended = false
  private stopped = false
  private noteEnd: (() => void) | null = null
  /** 进程结束（stdio 关闭）时 resolve，不会 reject */
  readonly done: Promise<void> = new Promise((resolve) => {
    this.noteEnd = resolve
  })

  constructor(private readonly opts: JsonlProcessOptions) {
    this.proc = spawn(opts.command, opts.args ?? [], {
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows：connector 作为后台服务跑时没有控制台，不藏的话每起一个 agent 弹一个黑窗
      windowsHide: true,
    })
    // 起不来（ENOENT / EACCES）走 error 而不是 exit；不接住会变成未处理的 error 事件，把整个进程带走
    this.proc.on('error', (err) => {
      this.spawnError ??= err
    })
    // 对端先死再写 stdin 是 EPIPE：属于进程退出，由 close 说明，这里只防它变成未处理异常
    this.proc.stdin?.on('error', () => {})
    this.proc.on('exit', (code, signal) => {
      this.exitInfo = { code, signal }
    })
    this.proc.stdout?.setEncoding('utf8')
    this.proc.stdout?.on('data', (chunk: string) => {
      for (const line of this.lines.push(chunk)) this.deliver(line)
    })
    this.proc.stdout?.on('end', () => {
      const rest = this.lines.flush()
      if (rest !== null) this.deliver(rest)
    })
    this.proc.stderr?.setEncoding('utf8')
    this.proc.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL)
    })
    // close 在 stdio 全部关闭之后：此时 stdout 上的最后一条消息已经交出去了，再报退出
    this.proc.on('close', (code, signal) => {
      this.exitInfo ??= { code, signal }
      this.ended = true
      this.opts.onExit?.({ exit: this.exitInfo, crashed: !this.stopped, reason: this.describeExit() })
      this.noteEnd?.()
    })
  }

  private deliver(line: string): void {
    if (!line.trim()) return
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      this.opts.onNoise?.(line)
      return
    }
    this.opts.onMessage(msg)
  }

  /** 进程还在、没被 kill */
  get alive(): boolean {
    return !this.ended && !this.stopped && !this.spawnError
  }

  get pid(): number | undefined {
    return this.proc.pid
  }

  get stderr(): string {
    return this.stderrTail
  }

  /** 写一条消息。进程已经没了返回 false（调用方按"进程断了"处理，原因看 describeExit） */
  send(msg: unknown): boolean {
    const stdin = this.proc.stdin
    if (!this.alive || !stdin || stdin.destroyed || !stdin.writable) return false
    stdin.write(`${JSON.stringify(msg)}\n`)
    return true
  }

  /** 为什么没了：起不来就说起不来，否则退出码 / 信号 + stderr 尾巴 */
  describeExit(): string {
    if (this.spawnError) return `${this.opts.id} 起不来（${this.opts.command}）：${this.spawnError.message}`
    return describeProcessExit(this.opts.id, this.opts.kind ?? 'JSONL', this.exitInfo, this.stderrTail)
  }

  /** 主动结束：之后的退出不算崩溃 */
  kill(): void {
    if (this.stopped) return
    this.stopped = true
    if (!this.ended) this.proc.kill()
  }
}
