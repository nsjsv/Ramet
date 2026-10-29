// ---------- ACP 终端（terminal/create · output · wait_for_exit · kill · release）----------
// AcpAgent 声明 clientCapabilities.terminal 后，agent 把要跑的命令交给客户端执行而不是自己 spawn：
// 输出因此能实时进这一轮的过程（回复里的实时终端 / 项目面板），也能被用户「停止这条命令」。
// 跑在 AcpAgent 所在的机器上（connector 进程，或 RAMET_LOCAL_AGENTS=1 时的中心进程），两处共用这一份。
//
// 约束：
//   - cwd 必须在会话工作区之内（两边都 realpath，按路径分隔符比前缀；不给 cwd = 会话工作区）；
//   - 环境变量 = 本进程的去掉所有 RAMET_*（Ramet 自己的配置）+ agent 要求的那些；
//   - 输出（stdout + stderr 按到达顺序合并）按 outputByteLimit 从头截断保留，截断点落在字符边界；没给上限用默认值，且有硬上限；
//   - 实时转发给 run 事件的输出另有总量上限（FORWARD_MAX），命令狂刷也不会撑爆事件缓冲 / 带宽，超出的只标 truncated。
//
// 终端与「这一步」的对应：agent 随后发的 tool_call(_update) 的 content 里带 `{type:'terminal', terminalId}`，
// bind() 据此把 terminalId 和 toolCallId 对上；对上之前攒下的输出（和已退出的状态）在 bind 时一并发出，之后实时转发。

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { TextDecoder } from 'node:util'
import type {
  CreateTerminalRequest,
  KillTerminalRequest,
  ReleaseTerminalRequest,
  TerminalOutputRequest,
  WaitForTerminalExitRequest,
} from '@agentclientprotocol/sdk'
import { within } from '../connector/project-path.js'
import type { AgentEvent, TerminalExit } from './types.js'

const OUTPUT_LIMIT_DEFAULT = 1_000_000
const OUTPUT_LIMIT_MAX = 16_000_000
/** 实时转发给 run 事件的输出总量（字符）：超出的不再转发，只标一次 truncated */
const FORWARD_MAX = 256_000
/** 转发合并窗口：窗口内的输出合成一条事件 */
const FORWARD_MS = 80
/** 同一个适配器进程同时存在的终端上限（没 release 的也算）：agent 忘了 release 不能无限堆 */
const MAX_TERMINALS = 32
/** 进程退出后等 stdio 收尾的宽限（后台孙进程握着管道不放时，'close' 永远不来） */
const EXIT_GRACE_MS = 150
/** kill 之后多久还没退就 SIGKILL */
const KILL_GRACE_MS = 2000

/** 参数 / 越界等「agent 请求本身有问题」：AcpAgent 把它回成 invalid params，message 是人话 */
export class TerminalError extends Error {}

type Term = {
  id: string
  sessionId: string
  child: ChildProcess
  /** 保留的输出（按到达顺序的块；总字节 ≤ limit 附近，读取时再精确截） */
  chunks: Buffer[]
  bytes: number
  limit: number
  truncated: boolean
  exit: TerminalExit | null
  waiters: Array<(exit: TerminalExit) => void>
  /** 绑定的工具步骤（toolCallId）；还没绑定 = 输出只攒着 */
  toolCallId: string | null
  /** 还没转发出去的输出（转发合并窗口里） */
  pending: string
  timer: NodeJS.Timeout | null
  forwarded: number
  forwardTruncated: boolean
  /** 已经转发过 exit 事件 */
  exitSent: boolean
  /** 被我们 kill 过（kill 请求 / release）：用于 SIGKILL 兜底 */
  killing: boolean
  graceTimer: NodeJS.Timeout | null
  decoder: TextDecoder
}

export type TerminalsHost = {
  emit: (ev: AgentEvent) => void
  /** 会话的工作区（newSession / loadSession 的 cwd）。未知会话 = undefined → 拒绝 */
  sessionCwd: (sessionId: string) => string | undefined
}

/** 命令行里有空白 / shell 元字符、又没给 args：agent 给的是一整条命令行（管道、重定向…），交给 shell 跑；否则直接 exec */
const SHELLISH = /[\s|&;<>()$`\\"'*?~#]/

function resolveSpawn(command: string, args: string[]): { file: string; args: string[] } {
  if (args.length === 0 && SHELLISH.test(command)) {
    return process.platform === 'win32'
      ? { file: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', command] }
      : { file: '/bin/sh', args: ['-c', command] }
  }
  return { file: command, args }
}

/** 本进程环境去掉 RAMET_* 再叠上 agent 要的变量 */
function commandEnv(extra: ReadonlyArray<{ name: string; value: string }> | null | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^RAMET_/i.test(key)) env[key] = value
  }
  for (const { name, value } of extra ?? []) {
    if (typeof name === 'string' && name && typeof value === 'string') env[name] = value
  }
  return env
}

/** 保留 buf 的最后 limit 字节，起点落在字符边界（跳过开头的 UTF-8 续字节） */
function tailOnBoundary(buf: Buffer, limit: number): Buffer {
  if (buf.length <= limit) return buf
  let start = buf.length - limit
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++
  return buf.subarray(start)
}

export class AcpTerminals {
  private terms = new Map<string, Term>()

  constructor(private host: TerminalsHost) {}

  get count(): number {
    return this.terms.size
  }

  async create(p: CreateTerminalRequest): Promise<{ terminalId: string }> {
    if (typeof p.command !== 'string' || !p.command) throw new TerminalError('缺少要执行的命令')
    if (this.terms.size >= MAX_TERMINALS) throw new TerminalError('同时存在的终端太多，请先 release 不用的')
    const cwd = await this.workingDir(p.sessionId, p.cwd)
    const limit = Math.min(Math.max(Math.floor(p.outputByteLimit ?? OUTPUT_LIMIT_DEFAULT), 1), OUTPUT_LIMIT_MAX)
    const { file, args } = resolveSpawn(p.command, Array.isArray(p.args) ? p.args.map(String) : [])
    const child = spawn(file, args, {
      cwd,
      env: commandEnv(p.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      // 自成一组：kill 时连它的子孙一起收（npm test 这类命令会再起一堆进程）
      detached: process.platform !== 'win32',
      windowsHide: true, // 同 acp.ts：后台服务没有控制台，agent 每跑一条命令都会弹黑窗
    })
    const term: Term = {
      id: randomUUID(),
      sessionId: p.sessionId,
      child,
      chunks: [],
      bytes: 0,
      limit,
      truncated: false,
      exit: null,
      waiters: [],
      toolCallId: null,
      pending: '',
      timer: null,
      forwarded: 0,
      forwardTruncated: false,
      exitSent: false,
      killing: false,
      graceTimer: null,
      decoder: new TextDecoder('utf-8'),
    }
    this.terms.set(term.id, term)
    child.stdout?.on('data', (buf: Buffer) => this.append(term, buf))
    child.stderr?.on('data', (buf: Buffer) => this.append(term, buf))
    // 起不来（找不到命令 / 没权限）：像 shell 一样把原因写进输出并以 127 / 126 退出，不回 JSON-RPC 错误
    child.on('error', (err: NodeJS.ErrnoException) => {
      this.append(term, Buffer.from(`${p.command}: ${err.code === 'ENOENT' ? '找不到命令' : err.message}\n`))
      this.finish(term, { terminalId: term.id, exitCode: err.code === 'ENOENT' ? 127 : 126, signal: null })
    })
    child.on('exit', (code, signal) => {
      const exit: TerminalExit = { terminalId: term.id, exitCode: signal ? null : code, signal }
      // 孙进程握着管道时 'close' 不来：宽限一小会儿收完输出就算结束
      term.graceTimer = setTimeout(() => this.finish(term, exit), EXIT_GRACE_MS)
      child.once('close', () => this.finish(term, exit))
    })
    return { terminalId: term.id }
  }

  output(p: TerminalOutputRequest): { output: string; truncated: boolean; exitStatus: { exitCode: number | null; signal: string | null } | null } {
    const term = this.get(p.sessionId, p.terminalId)
    const buf = tailOnBoundary(Buffer.concat(term.chunks), term.limit)
    return {
      output: buf.toString('utf8'),
      truncated: term.truncated || buf.length < term.bytes,
      exitStatus: term.exit ? { exitCode: term.exit.exitCode, signal: term.exit.signal } : null,
    }
  }

  async waitForExit(p: WaitForTerminalExitRequest): Promise<{ exitCode: number | null; signal: string | null }> {
    const term = this.get(p.sessionId, p.terminalId)
    const exit = term.exit ?? (await new Promise<TerminalExit>((resolve) => term.waiters.push(resolve)))
    return { exitCode: exit.exitCode, signal: exit.signal }
  }

  /** agent 的 terminal/kill：杀掉命令，终端仍然有效（还能取输出 / 等退出） */
  kill(p: KillTerminalRequest): void {
    this.stop(this.get(p.sessionId, p.terminalId))
  }

  /** agent 的 terminal/release：杀掉（若还在跑）并忘掉这个终端；它的输出已经随步骤保存在 run 里 */
  release(p: ReleaseTerminalRequest): void {
    const term = this.get(p.sessionId, p.terminalId)
    this.stop(term)
    this.drop(term)
  }

  /** 用户在界面上点「停止这条命令」。终端不存在 / 不属于这个会话 / 已经退出 → false */
  killByUser(sessionId: string, terminalId: string): boolean {
    const term = this.terms.get(terminalId)
    if (!term || term.sessionId !== sessionId || term.exit) return false
    this.stop(term)
    return true
  }

  /** agent 发的 tool_call(_update) 里带了 `{type:'terminal', terminalId}`：把终端对上这一步，攒着的输出与退出状态现在发出 */
  bind(sessionId: string, terminalId: string, toolCallId: string): void {
    const term = this.terms.get(terminalId)
    if (!term || term.sessionId !== sessionId || term.toolCallId === toolCallId) return
    term.toolCallId = toolCallId
    const buf = tailOnBoundary(Buffer.concat(term.chunks), term.limit)
    // 转发的是「已经攒下的」+ 之后新到的；pending 里还没转发的并进来，免得重复
    term.pending = ''
    if (term.timer) clearTimeout(term.timer)
    term.timer = null
    term.forwarded = 0
    this.forward(term, new TextDecoder('utf-8').decode(buf))
    if (term.exit) this.sendExit(term)
  }

  /** 适配器进程没了 / 被回收：所有命令都杀掉 */
  killAll(): void {
    for (const term of [...this.terms.values()]) {
      this.stop(term)
      this.drop(term)
    }
  }


  /** 终端必须存在、且属于发请求的这个会话（同一个适配器进程上别的会话的终端不能碰） */
  private get(sessionId: string, terminalId: string): Term {
    const term = this.terms.get(terminalId)
    if (!term || term.sessionId !== sessionId) throw new TerminalError('终端不存在（已 release？）')
    return term
  }

  /** cwd：不给 = 会话工作区；给了必须是绝对路径，realpath 后在会话工作区（realpath）之内 */
  private async workingDir(sessionId: string, cwd: string | null | undefined): Promise<string> {
    const base = this.host.sessionCwd(sessionId)
    if (!base) throw new TerminalError('不认识这个会话的工作区')
    let root: string
    try {
      root = await realpath(base)
    } catch {
      throw new TerminalError('会话的工作区目录不存在或不可访问')
    }
    if (cwd === undefined || cwd === null || cwd === '') return root
    if (typeof cwd !== 'string' || cwd.includes('\0') || !isAbsolute(cwd)) throw new TerminalError('cwd 必须是绝对路径')
    let real: string
    try {
      real = await realpath(cwd)
    } catch {
      throw new TerminalError('cwd 不存在')
    }
    if (!within(root, real)) throw new TerminalError('cwd 在会话的工作区之外')
    return real
  }

  private append(term: Term, buf: Buffer): void {
    term.chunks.push(buf)
    term.bytes += buf.length
    // 整块丢掉最老的，直到再丢就会少于 limit：读取时再精确地截到 limit
    while (term.chunks.length > 1 && term.bytes - term.chunks[0]!.length >= term.limit) {
      term.bytes -= term.chunks.shift()!.length
      term.truncated = true
    }
    if (term.toolCallId) this.forward(term, term.decoder.decode(buf, { stream: true }))
    else term.decoder.decode(buf, { stream: true }) // 没绑定：bind 时整份重新转发，这里只让解码器保持状态
  }

  /** 把输出并进转发窗口；窗口到期合成一条 terminal 事件。总量封顶 */
  private forward(term: Term, text: string): void {
    if (!text || !term.toolCallId) return
    if (term.forwardTruncated) return
    const room = FORWARD_MAX - term.forwarded
    if (text.length > room) {
      text = text.slice(0, Math.max(room, 0))
      term.forwardTruncated = true
    }
    term.forwarded += text.length
    term.pending += text
    if (term.forwardTruncated) {
      this.flush(term)
      this.host.emit({ type: 'terminal', id: term.toolCallId, truncated: true, sessionId: term.sessionId })
      return
    }
    term.timer ??= setTimeout(() => this.flush(term), FORWARD_MS)
  }

  private flush(term: Term): void {
    if (term.timer) clearTimeout(term.timer)
    term.timer = null
    if (!term.pending || !term.toolCallId) return
    const delta = term.pending
    term.pending = ''
    this.host.emit({ type: 'terminal', id: term.toolCallId, delta, sessionId: term.sessionId })
  }

  private sendExit(term: Term): void {
    if (term.exitSent || !term.exit || !term.toolCallId) return
    this.flush(term)
    term.exitSent = true
    this.host.emit({ type: 'terminal', id: term.toolCallId, exit: term.exit, sessionId: term.sessionId })
  }

  /** 命令结束（进程退出且输出收完，或起不来）：记退出状态、唤醒 wait_for_exit、转发 exit */
  private finish(term: Term, exit: TerminalExit): void {
    if (term.exit) return
    if (term.graceTimer) clearTimeout(term.graceTimer)
    term.graceTimer = null
    term.exit = exit
    for (const resolve of term.waiters.splice(0)) resolve(exit)
    this.sendExit(term)
  }

  /** 杀命令（SIGTERM 整个进程组，2 秒后还没退就 SIGKILL）。已经退出的什么也不做 */
  private stop(term: Term): void {
    if (term.exit || term.killing) return
    term.killing = true
    const send = (signal: NodeJS.Signals): void => {
      const pid = term.child.pid
      try {
        if (pid && process.platform !== 'win32') process.kill(-pid, signal) // 负数 = 整个进程组
        else term.child.kill(signal)
      } catch {
        try {
          term.child.kill(signal)
        } catch {
          // 已经没了
        }
      }
    }
    send('SIGTERM')
    const t = setTimeout(() => {
      if (!term.exit) send('SIGKILL')
    }, KILL_GRACE_MS)
    t.unref()
  }

  private drop(term: Term): void {
    if (term.timer) clearTimeout(term.timer)
    term.timer = null
    term.pending = ''
    if (term.graceTimer && term.exit) clearTimeout(term.graceTimer)
    this.terms.delete(term.id)
  }
}
