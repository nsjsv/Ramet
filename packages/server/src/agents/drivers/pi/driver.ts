// ---------- pi / omp 原生驱动：经 `pi --mode rpc` / `omp --mode rpc-ui` 直接驱动用户本机的 CLI ----------
// 一个实例 = 一个 agent 配置（本机或 connector 上），承载多个会话；pi 系的 RPC 进程一次只绑一个会话，所以每个会话一个进程
// （session.ts），会话之间互不阻塞。pi 与 omp 的基础命令 / 事件同源，omp 多出来的（ready 帧、会话目录、子代理、提问、宿主工具）
// 按方言开关。沿用用户自己的 CLI：登录、模型、审批策略、项目信任都是它自己的。
// 审批 / 会话级状态 / 在飞计数的规则在 DriverBase，这里只管 RPC。

import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { PageTool } from '../../../page-read.js'
import type { AgentConfig, ConfigOption, PromptBlock, PromptResult } from '../../types.js'
import { DriverBase } from '../base.js'
import { cliUnavailable, probeVersion, runnable } from '../cli-version.js'
import { sessionsRoot, type SessionPort } from '../session-port.js'
import type { PiDialect, UiDialogRequest } from './protocol.js'
import { PiSession, type SessionHost, type SessionSpec } from './session.js'
import { ompSessionPort, piSessionPort } from './session-port.js'
import { PiUi } from './ui.js'

export { sessionsRoot }

export class RpcAgentDriver extends DriverBase {
  private readonly sessions = new Map<string, PiSession>()
  private checked = false
  private checking: Promise<void> | null = null
  private stopped = false
  override readonly sessionPort: SessionPort

  constructor(
    protected readonly cfg: AgentConfig,
    readonly dialect: PiDialect,
  ) {
    super()
    this.sessionPort = dialect === 'pi' ? piSessionPort() : ompSessionPort(cfg.env)
  }

  /** 没有常驻进程：检查通过就算连上（会话的 CLI 进程各自起、各自死，死了下一轮按会话记录重起） */
  protected get connected(): boolean {
    return this.checked
  }

  protected get spawned(): boolean {
    return this.checked || this.checking !== null
  }

  private get bin(): string {
    return this.cfg.cli ?? this.cfg.command
  }

  /** 只做轻量检查：CLI 在、能执行、版本够。不起会话进程。版本取不到不拦（只是信息） */
  ready(): Promise<void> {
    if (this.dead) return Promise.reject(new Error(`agent ${this.cfg.id} 已停止`))
    if (this.checked) return Promise.resolve()
    return (this.checking ??= runnable(this.bin)
      .then(async (ok) => {
        if (!ok) throw new Error(`${this.cfg.id}：找不到可执行的 ${this.dialect}（${this.bin}）`)
        const why = cliUnavailable(this.dialect, await probeVersion(this.bin, this.cfg.env))
        if (why) throw new Error(`${this.cfg.id}：${why}`)
        if (this.dead) throw new Error(`agent ${this.cfg.id} 已停止`)
        this.checked = true
      })
      .catch((err: unknown) => {
        // 检查不过就是死的：留着会变成 alive 的僵尸
        this.kill()
        throw err
      })
      .finally(() => {
        this.checking = null
      }))
  }

  private host(): SessionHost {
    return {
      cfg: this.cfg,
      dialect: this.dialect,
      root: join(sessionsRoot(), this.dialect),
      emit: (ev) => this.emit(ev),
      setCommands: (sessionId, list) => {
        this.sessionCommands.set(sessionId, list)
        this.emit({ type: 'commands', list, sessionId })
      },
      setConfigs: (sessionId, options) => {
        if (this.restricted.has(sessionId) || !this.sessions.has(sessionId)) return
        if (JSON.stringify(this.sessionConfigs.get(sessionId)) === JSON.stringify(options)) return
        this.sessionConfigs.set(sessionId, options)
        this.emit({ type: 'config', options, sessionId })
      },
      ui: (session, req, signal) => this.ui(session, req, signal),
      cancelPending: (sessionId) => this.cancelPending(sessionId),
      stopped: () => this.stopped,
    }
  }

  private ui(session: PiSession, req: UiDialogRequest, signal: AbortSignal) {
    const sessionId = session.id
    return new PiUi({
      sessionId,
      dialect: this.dialect,
      restricted: this.restricted.has(sessionId),
      nextId: () => this.nextPermissionId(),
      hold: (event, settle, sig, turnOf) => this.hold(event, settle, sig, turnOf),
      inTurn: () => this.inTurn(sessionId),
      claimLive: (name) => session.events.claimLive(name),
      claimRequested: (name) => session.events.claimRequested(name),
      faceOf: (id) => session.events.faceOf(id),
    }).handle(req, signal)
  }

  private open(id: string, spec: SessionSpec): PiSession {
    const s = new PiSession(id, spec, this.host())
    this.sessions.set(id, s)
    if (!this.sessionConfigs.has(id)) this.sessionConfigs.set(id, [])
    return s
  }

  /** 起进程；起不来就把会话丢掉再抛（留着只会让下一轮再撞一次） */
  private async started(s: PiSession, resume: boolean): Promise<ConfigOption[]> {
    try {
      await s.start(resume)
    } catch (err) {
      if (this.sessions.get(s.id) === s) this.discardSession(s.id)
      throw err
    }
    return this.sessionConfigs.get(s.id) ?? []
  }

  /** 会话 id 由宿主生成，决定会话记录的位置。当场起进程：选了 agent 就要能看到命令 */
  async newSession(cwd: string, tools: PageTool[] = []): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    await this.ready()
    const sessionId = randomUUID()
    const s = this.open(sessionId, { cwd, tools, restricted: false })
    return { sessionId, configOptions: await this.started(s, false) }
  }

  /** 受限标记与会话在同一个同步段里建好（第一次 prompt 之前 CLI 不会发任何请求）。⌘J 用完即弃，不预先起进程 */
  async newRestrictedSession(cwd: string): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    await this.ready()
    const sessionId = randomUUID()
    this.restricted.add(sessionId)
    this.open(sessionId, { cwd, tools: [], restricted: true })
    return { sessionId, configOptions: [] }
  }

  /** 进程里已有这个会话就只换配置（变了且空闲就按新配置重起）；没有就按会话记录起进程。
   *  记录不在（从没跑完过一轮的会话不落盘）、或 CLI 没能接上它时抛错，调用方据此新建会话、全文重放。
   *  不能交给 CLI 自己判断：两家对不存在的记录都静默新建一个空会话 */
  async loadSession(sessionId: string, cwd: string, tools: PageTool[] = []): Promise<{ configOptions: ConfigOption[] }> {
    await this.ready()
    const spec: SessionSpec = { cwd, tools, restricted: this.restricted.has(sessionId) }
    const existing = this.sessions.get(sessionId)
    if (existing) {
      existing.respec(spec)
      return { configOptions: await this.started(existing, existing.recorded()) }
    }
    const s = new PiSession(sessionId, spec, this.host())
    if (!s.recorded()) throw new Error(`${this.cfg.id} 没有会话 ${sessionId} 的记录`)
    this.sessions.set(sessionId, s)
    if (!this.sessionConfigs.has(sessionId)) this.sessionConfigs.set(sessionId, [])
    return { configOptions: await this.started(s, true) }
  }

  /** 改模型 / 思考档位 / omp 的审批档（规则在 session.ts 的 setConfig）。受限会话没有配置项 */
  async setConfigOption(sessionId: string, configId: string, value: string): Promise<ConfigOption[]> {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error(`Unsupported session ${sessionId}：先 newSession / loadSession`)
    if (this.restricted.has(sessionId)) throw new Error(`${this.cfg.id} 的受限会话没有配置项 ${configId}`)
    await s.setConfig(configId, value)
    return this.sessionConfigs.get(sessionId) ?? []
  }

  async prompt(sessionId: string, blocks: PromptBlock[]): Promise<PromptResult> {
    await this.ready()
    const s = this.sessions.get(sessionId)
    // 这个驱动里没有这个会话，调用方据此先 load 再试
    if (!s) throw new Error(`Unsupported session ${sessionId}：先 newSession / loadSession`)
    this.beginTurn(sessionId)
    try {
      return await s.prompt(blocks)
    } finally {
      this.endTurn(sessionId)
    }
  }

  cancel(sessionId: string): void {
    this.sessions.get(sessionId)?.cancel()
    this.cancelPending(sessionId)
  }

  /** 停掉一个子代理（omp）：句柄是子代理 id（步骤视图里的 handle） */
  killCommand(sessionId: string, handle: string): boolean {
    return this.sessions.get(sessionId)?.stopSubagent(handle) ?? false
  }

  /** 会话记录的位置（pi：会话文件；omp：会话目录）。迁移会话时整份搬的就是它；没有这个会话返回 undefined */
  sessionLocation(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.location
  }

  /** 受限会话用完即弃：连同 CLI 落下的会话记录一起删掉，⌘J 不在用户机器上越攒越多 */
  override discardSession(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    s?.close()
    if (s && this.restricted.has(sessionId)) rmSync(s.location, { recursive: true, force: true })
    this.sessions.delete(sessionId)
    super.discardSession(sessionId)
  }

  kill(): void {
    this.stopped = true
    this.dead = true
    this.checked = false
    for (const s of this.sessions.values()) s.close()
    this.sessions.clear()
    this.cancelAllPending()
  }
}
