// ---------- 随手 AI 本地通道（connector 侧）：在这台机器上用 agent 做一次受限的文本改写 ----------
// 中心发来 quick 帧（agent 范围的驱动帧：已过 connector 的第二道闸 checkActor）。这里起一个受限会话：
//   - 临时空目录当 cwd，不给 MCP 工具（agent 摸不到页面，也摸不到工作区）；
//   - agent 经 ACP 向客户端要读文件 / 写文件 / 开终端，一律拒绝；request_permission 自动拒绝（见 acp.ts 的 restricted）；
//   - 会话此刻在「跳过全部确认」档（posture.ts 的表）就先切到非危险档，切不了就拒绝运行；
//   - agent 一开始调用工具（tool 事件）就中止本次：改写用不着工具，调了说明它在做别的；
//   - 每人同时一个、整台机器同时 MAX_TOTAL 个、60 秒超时、输出上限；
//   - 结束（含失败 / 取消 / 超时）一律清理临时目录和适配器里的会话记录。
// 文本增量用 quick-delta 帧回传，结束 res { quick }，失败 err。
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { errorText, type AcpAgent } from '../agents/acp.js'
import { unrestrictedModesOf } from '../agents/posture.js'
import type { CenterMsg, ConnMsg } from '../agents/protocol.js'
import type { ConfigOption } from '../agents/types.js'

/** 一次调用的墙钟上限 */
export const QUICK_TIMEOUT_MS = 60_000
/** 中心拼好的 prompt 上限（字符）：远大于正常的 2 万字正文 + 上下文，防止被灌 */
export const QUICK_PROMPT_MAX = 100_000
/** agent 输出上限（字符） */
export const QUICK_OUTPUT_MAX = 100_000
/** 这台机器同时跑几个 quick（每人至多一个） */
export const QUICK_MAX_TOTAL = 4
/** 取消 / 超时后最多再等 agent 这么久才放弃等它收尾（agent 不响应 cancel 也不能让这一次永远占着名额） */
const CANCEL_GRACE_MS = 5_000

export type QuickDeps = {
  /** 取（必要时起）这个 agent 的适配器；本机没有这个 agent 会抛 */
  adapter: (agentId: string) => AcpAgent
  send: (msg: ConnMsg) => void
  log: (line: string) => void
  /** 测试注入：超时（缺省 QUICK_TIMEOUT_MS）与临时目录的父目录（缺省系统临时目录） */
  timeoutMs?: number
  tmpRoot?: string
}

type Run = { actor: string; abort: (reason: string) => void }

type QuickFrame = Extract<CenterMsg, { t: 'quick' }>

/** 受限会话的 mode：在「跳过全部确认」档就切到非危险档。agent 没把 mode 暴露成配置项 / 不在 posture 表里 = 无从判断，放行 */
async function ensureSafeMode(adapter: AcpAgent, agentId: string, sessionId: string, options: ConfigOption[]): Promise<void> {
  const unrestricted = unrestrictedModesOf(agentId)
  const mode = options.find((o) => o.category === 'mode')
  if (!mode || !unrestricted.includes(mode.currentValue)) return
  const target = mode.options.find((o) => o.value === 'default') ?? mode.options.find((o) => !unrestricted.includes(o.value))
  if (!target) throw new Error('这个 agent 当前处于「跳过全部确认」，又没有可切换的安全模式，随手 AI 拒绝运行')
  let next: ConfigOption[]
  try {
    next = await adapter.setConfigOption(sessionId, mode.id, target.value)
  } catch (err) {
    throw new Error(`这个 agent 当前处于「跳过全部确认」，切换到安全模式失败，随手 AI 拒绝运行：${errorText(err)}`)
  }
  const now = next.find((o) => o.id === mode.id)
  if (!now || unrestricted.includes(now.currentValue)) {
    throw new Error('这个 agent 当前处于「跳过全部确认」，没能切到安全模式，随手 AI 拒绝运行')
  }
}

export class QuickRunner {
  private runs = new Map<string, Run>()

  constructor(private deps: QuickDeps) {}

  /** 在飞的 quick 数（测试用） */
  get active(): number {
    return this.runs.size
  }

  /** 处理一个已过第二道闸的 quick 帧。应答（res / err）都经 deps.send；不抛 */
  start(msg: QuickFrame): void {
    void this.run(msg).catch((err: unknown) => {
      // run 内部已把失败变成 err 帧；走到这里只剩没想到的异常，也不能让它变成 unhandled rejection
      this.deps.log(`quick 异常 ${errorText(err)}`)
    })
  }

  /** 中心让停（按 rid）。非驱动帧：只会让机器停下来 */
  cancel(rid: string): void {
    this.runs.get(rid)?.abort('已取消')
  }

  /** 此人的授权没了：他在飞的 quick 当场中止 */
  cancelActor(actor: string): void {
    for (const run of [...this.runs.values()]) {
      if (run.actor === actor) run.abort('你对这台机器的使用授权已收回，已中止')
    }
  }

  dispose(): void {
    for (const run of [...this.runs.values()]) run.abort('connector 已停止')
  }

  private async run(msg: QuickFrame): Promise<void> {
    const { send, log } = this.deps
    const fail = (message: string): void => send({ t: 'err', rid: msg.rid, message })
    if (typeof msg.prompt !== 'string' || !msg.prompt.trim() || msg.prompt.length > QUICK_PROMPT_MAX) return fail('随手 AI 的请求内容不合法')
    if (typeof msg.agent !== 'string' || !msg.agent) return fail('缺少 agent')
    if (this.runs.has(msg.rid) || [...this.runs.values()].some((r) => r.actor === msg.actor)) {
      return fail('你已经有一次随手 AI 在这台机器上运行，等它结束再试')
    }
    if (this.runs.size >= QUICK_MAX_TOTAL) return fail('这台机器上的随手 AI 太忙了，稍后再试')

    let reason: string | null = null
    let sessionId: string | null = null
    let adapter: AcpAgent | null = null
    let graceTimer: NodeJS.Timeout | null = null
    let wakeGrace: () => void = () => undefined
    const grace = new Promise<void>((resolve) => {
      wakeGrace = resolve
    })
    const abort = (why: string): void => {
      if (reason !== null) return
      reason = why
      if (adapter && sessionId) adapter.cancel(sessionId)
      // agent 不响应 cancel 也不能一直占着名额：再等一会儿就放弃等它收尾
      graceTimer = setTimeout(wakeGrace, CANCEL_GRACE_MS)
    }
    this.runs.set(msg.rid, { actor: msg.actor, abort })
    const timer = setTimeout(() => abort('随手 AI 超时（60 秒），已中止'), this.deps.timeoutMs ?? QUICK_TIMEOUT_MS)

    const dir = await mkdtemp(join(this.deps.tmpRoot ?? tmpdir(), 'ramet-quick-')).catch(() => null)
    let off = (): void => undefined
    let prompting: Promise<unknown> | null = null
    let settled = false
    // 终结帧（res / err）最后发：中心收到它就意味着这一次已经收拾干净（临时目录删了、会话记录丢了、名额放了）
    let terminal: ConnMsg
    try {
      if (!dir) throw new Error('建不出临时目录')
      adapter = this.deps.adapter(msg.agent)
      const session = await adapter.newRestrictedSession(dir)
      sessionId = session.sessionId
      if (reason !== null) throw new Error(reason)
      log(`quick agent=${msg.agent} session=${sessionId}`)
      await ensureSafeMode(adapter, msg.agent, sessionId, session.configOptions)
      let total = 0
      const sid = sessionId
      off = adapter.on((ev) => {
        if (!('sessionId' in ev) || ev.sessionId !== sid) return
        if (ev.type === 'text' && !ev.parentId && ev.delta) {
          total += ev.delta.length
          if (total > QUICK_OUTPUT_MAX) abort('随手 AI 输出太长，已中止')
          else if (reason === null) send({ t: 'quick-delta', rid: msg.rid, text: ev.delta })
        } else if (ev.type === 'tool') {
          // 改写用不着工具：agent 要调就中止（读写文件 / 终端 / 审批本来也都被拒绝了，这里是再收紧一道）
          abort('这个 agent 想在随手 AI 里调用工具，已中止；换一个 agent 或到设置里换成「本站」通道')
        }
      })
      if (reason !== null) throw new Error(reason)
      const run = adapter.prompt(sid, [{ type: 'text', text: msg.prompt }])
      prompting = run
      void run.then(
        () => (settled = true),
        () => (settled = true),
      )
      const result = await Promise.race([run, grace.then(() => null)])
      if (reason !== null) throw new Error(reason)
      if (!result) throw new Error('agent 没有响应')
      terminal = { t: 'res', rid: msg.rid, quick: { stopReason: result.stopReason } }
    } catch (err) {
      const message = reason ?? errorText(err)
      log(`quick 失败 ${message}`)
      terminal = { t: 'err', rid: msg.rid, message }
    }
    clearTimeout(timer)
    if (graceTimer) clearTimeout(graceTimer)
    off()
    // 受限标记要留到 agent 真的收尾：它没收尾就丢掉记录，后来的审批请求会被当成普通会话的审批挂住
    if (adapter && sessionId) {
      const a = adapter
      const s = sessionId
      if (settled || !prompting) a.discardSession(s)
      else void prompting.then(() => a.discardSession(s), () => a.discardSession(s))
    }
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    this.runs.delete(msg.rid)
    send(terminal)
  }
}
