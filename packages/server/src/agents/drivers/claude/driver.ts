// ---------- Claude Code 原生驱动：经 Claude Agent SDK 直接驱动用户本机的 claude ----------
// 一个实例 = 一个 agent 配置（本机或 connector 上），承载多个会话；每个会话一个 SDK query()（session.ts），
// 会话之间互不阻塞。沿用用户自己的 claude：登录、模型、权限规则、CLAUDE.md 都是它自己的（不做 claude.ai 登录）。
// 审批 / 会话级状态 / 在飞计数的规则在 DriverBase，这里只管 SDK。

import { randomUUID } from 'node:crypto'
import type { PageTool } from '../../../page-read.js'
import type { AgentConfig, ConfigOption, PromptBlock, PromptResult } from '../../types.js'
import { DriverBase } from '../base.js'
import { cliUnavailable, probeVersion, runnable } from '../cli-version.js'
import { ClaudePermissions } from './permissions.js'
import { ClaudeSession, type SessionHost, type SessionSpec } from './session.js'
import { claudeSessionPort } from './session-port.js'
import type { SessionPort } from '../session-port.js'

export class ClaudeDriver extends DriverBase {
  private readonly sessions = new Map<string, ClaudeSession>()
  private checked = false
  private checking: Promise<void> | null = null
  private stopped = false
  private readonly permissions = new ClaudePermissions({
    restricted: (sessionId) => this.restricted.has(sessionId),
    nextId: () => this.nextPermissionId(),
    hold: (event, settle, signal, turnOf) => this.hold(event, settle, signal, turnOf),
    inTurn: (sessionId) => this.inTurn(sessionId),
  })

  /** 没有常驻进程：检查通过就算连上（会话的 CLI 进程各自起、各自死，死了下一轮 resume 重起） */
  protected get connected(): boolean {
    return this.checked
  }

  protected get spawned(): boolean {
    return this.checked || this.checking !== null
  }

  override readonly sessionPort: SessionPort

  constructor(cfg: AgentConfig) {
    super(cfg)
    this.sessionPort = claudeSessionPort(cfg.env)
  }

  private get bin(): string {
    return this.cfg.cli ?? this.cfg.command
  }

  /** 只做轻量检查：CLI 在、能执行、版本够（SDK 是静态依赖，能走到这里就已加载）。不起会话进程。
   *  版本取不到不拦（只是信息）；取到了且低于最低版本，给出明确原因，免得到了会话里才因协议不认而失败 */
  ready(): Promise<void> {
    if (this.dead) return Promise.reject(new Error(`agent ${this.cfg.id} 已停止`))
    if (this.checked) return Promise.resolve()
    return (this.checking ??= runnable(this.bin)
      .then(async (ok) => {
        if (!ok) throw new Error(`${this.cfg.id}：找不到可执行的 claude（${this.bin}）`)
        const why = cliUnavailable('claude', await probeVersion(this.bin, this.cfg.env))
        if (why) throw new Error(`${this.cfg.id}：${why}`)
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
      emit: (ev) => this.emit(ev),
      setCommands: (sessionId, list) => {
        this.sessionCommands.set(sessionId, list)
        this.emit({ type: 'commands', list, sessionId })
      },
      canUseTool: (sessionId) => this.permissions.canUseTool(sessionId),
      onElicitation: (sessionId) => this.permissions.onElicitation(sessionId),
      setConfigs: (sessionId, options) => {
        this.sessionConfigs.set(sessionId, options)
        this.emit({ type: 'config', options, sessionId })
      },
      cancelPending: (sessionId) => this.cancelPending(sessionId),
      stopped: () => this.stopped,
    }
  }

  private open(id: string, spec: SessionSpec, persisted: boolean): ClaudeSession {
    const s = new ClaudeSession(id, spec, persisted, this.host())
    this.sessions.set(id, s)
    if (!this.sessionConfigs.has(id)) this.sessionConfigs.set(id, [])
    return s
  }

  /** 起进程拿配置项；起不来就把会话丢掉再抛（留着只会让下一轮再撞一次） */
  private async started(s: ClaudeSession): Promise<ConfigOption[]> {
    try {
      return await s.start()
    } catch (err) {
      if (this.sessions.get(s.id) === s) this.discardSession(s.id)
      throw err
    }
  }

  /** 会话 id 由宿主生成并交给 CLI（--session-id），之后 resume 用同一个 id。当场起进程：选了 agent 就要能看到模型 / 模式 / 命令 */
  async newSession(cwd: string, tools: PageTool[] = []): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    await this.ready()
    const sessionId = randomUUID()
    const s = this.open(sessionId, { cwd, tools, restricted: false }, false)
    return { sessionId, configOptions: await this.started(s) }
  }

  /** 受限标记与会话在同一个同步段里建好（SDK 在第一次 prompt 之前不会问任何审批）。随手 AI 用完即弃，不预先起进程 */
  async newRestrictedSession(cwd: string): Promise<{ sessionId: string; configOptions: ConfigOption[] }> {
    await this.ready()
    const sessionId = randomUUID()
    this.restricted.add(sessionId)
    this.open(sessionId, { cwd, tools: [], restricted: true }, false)
    return { sessionId, configOptions: [] }
  }

  /** 进程里已有这个会话就只换配置（变了且空闲就按新配置重起）；没有就用 resume 起进程。
   *  CLI 那边没有这份会话记录时起不来，抛错（调用方据此新建会话、全文重放） */
  async loadSession(sessionId: string, cwd: string, tools: PageTool[] = []): Promise<{ configOptions: ConfigOption[] }> {
    await this.ready()
    const spec: SessionSpec = { cwd, tools, restricted: this.restricted.has(sessionId) }
    const existing = this.sessions.get(sessionId)
    if (existing) existing.respec(spec)
    const s = existing ?? this.open(sessionId, spec, true)
    return { configOptions: await this.started(s) }
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<ConfigOption[]> {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error(`Unsupported session ${sessionId}：先 newSession / loadSession`)
    return s.setConfig(configId, value)
  }

  async prompt(sessionId: string, blocks: PromptBlock[]): Promise<PromptResult> {
    await this.ready()
    const s = this.sessions.get(sessionId)
    // 这个进程里没有这个会话，调用方据此先 load 再试
    if (!s) throw new Error(`Unsupported session ${sessionId}：先 newSession / loadSession`)
    this.beginTurn(sessionId)
    try {
      return await s.prompt(blocks)
    } finally {
      this.endTurn(sessionId)
    }
  }

  cancel(sessionId: string): void {
    this.cancelPending(sessionId)
    this.sessions.get(sessionId)?.cancel()
  }

  /** 停掉一个子代理 / 后台命令：句柄是 task_id（步骤视图里的 handle） */
  killCommand(sessionId: string, handle: string): boolean {
    return this.sessions.get(sessionId)?.stopTask(handle) ?? false
  }

  override discardSession(sessionId: string): void {
    this.sessions.get(sessionId)?.close()
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
