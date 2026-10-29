// ---------- 随手 AI 的本地通道（中心侧）----------
// 用户在设置里选一台自己能用的机器上的 agent（user_ai_settings.local_agent，目录 id `c:<connectorId>:<agentId>`），
// 请求经 connector 的 WSS 发到那台机器，在受限会话里让 agent 做一次改写（connector/quick.ts）。中心只做判定、转发、留痕：
//   - 判定与机器上的其他入口同一处（manager.resolve → assertCanUse(…, 'agent')）：没有 agent 授权（只有 machine 授权、
//     空间 owner、全局 admin、同空间成员都不算）抛 ForbiddenError（403），机器一侧一个帧都没有；
//   - 机器不在线 / agent 已不在 → 409 local agent unavailable；connector 太旧（hello 没有 quick 能力）→ 409 connector outdated，不发帧；
//   - 非机器主人用别人的机器：先 await 把使用记录写进 machine_usage_log（action='quick'），再发帧；
//   - 每人同时只有一个在飞的本地调用；授权收回 / 收窄时 hub.cancelQuickOf 当场取消。
// 输出形状与本站通道一致（AsyncIterable<ModelChunk>），routes/quick.ts 的 SSE 循环两条通道共用。
import type { Pool } from 'pg'
import { ConnectorOutdatedError, QUICK_CAP } from './agents/project-types.js'
import type { ConnectorHub } from './agents/hub.js'
import { recordMachineUse } from './agents/machine-grants.js'
import { parseRemoteId, type CatalogAgent, type ResolvedAgent } from './agents/manager-types.js'
import type { ConnMsg } from './agents/protocol.js'
import { LocalQuickError, type ModelChunk } from './quick.js'

/** 比 connector 自己的 60 秒超时多留一点：正常情况下 connector 先收尾并回 err，中心的超时只是兜底 */
const REQUEST_TIMEOUT_MS = 75_000

type User = { id: string; role: string }

/** 中心要从 AgentManager 借的两个能力（注入，便于测试、避免反向依赖） */
export type LocalQuickHost = {
  hub: ConnectorHub
  /** id → 执行目标，同时是机器使用权的唯一判定点（manager.resolve）：不能用抛 ForbiddenError，离线 / 不存在返回 null */
  resolve: (agentId: string, user: User) => Promise<ResolvedAgent | null>
  /** 该用户现在能用的 agent 目录（manager.catalog） */
  catalog: (user: User) => Promise<CatalogAgent[]>
}

const BUSY_MESSAGE = '上一次本地随手 AI 还没结束，稍后再试'

const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' })

/** 设置里能选的本地通道 agent：必须是 connector 上的 agent，且现在在用户的可用目录里（接入人 ∨ 有效 agent 授权，且在线） */
export async function isSelectableLocalAgent(host: LocalQuickHost, user: User, agentId: string): Promise<boolean> {
  if (!parseRemoteId(agentId)) return false
  return (await host.catalog(user)).some((a) => a.id === agentId)
}

/** 每人同时一个：在飞的用户（进程内，单实例部署）。流真正开始时占位、结束时放，没开过流的不占 */
const busy = new Set<string>()

/** 开流前的全部判定与留痕。通过返回一个「开流」函数（SSE 开始后调用）；不通过抛错（调用方在开流前回 JSON 状态码）。
 *  prompt 是中心拼好的整段文本（固定 system + 任务消息）；kind 只用于使用记录（不记正文） */
export async function prepareLocalQuick(
  host: LocalQuickHost,
  pool: Pool,
  user: User,
  localAgent: string | null,
  prompt: string,
  kind: string,
): Promise<(signal: AbortSignal) => AsyncGenerator<ModelChunk>> {
  if (!localAgent) throw new LocalQuickError('no local agent', '还没有选本地通道用哪台机器上的 agent，请先到设置 → 随手 AI 里选择')
  if (!parseRemoteId(localAgent)) throw new LocalQuickError('local agent unavailable', '本地通道只能用接入的机器上的 agent，请到设置里重新选择')
  // 不是接入人、也没有有效 agent 授权会在这里抛 ForbiddenError（403）
  const agent = await host.resolve(localAgent, user)
  if (!agent || !agent.remote) throw new LocalQuickError('local agent unavailable', '选中的 agent 现在用不了（机器不在线，或这个 agent 已经不在了）')
  const { connectorId, agentId } = agent.remote
  const conn = host.hub.get(connectorId)
  if (!conn) throw new LocalQuickError('local agent unavailable', '选中的机器现在不在线')
  if (!conn.caps.includes(QUICK_CAP)) {
    throw new ConnectorOutdatedError('这台机器上的 connector 版本太旧，升级后才能把它用作随手 AI 的本地通道')
  }
  if (busy.has(user.id)) throw new LocalQuickError('quick busy', BUSY_MESSAGE)
  // 非主人用别人的机器：留痕写进审计才放行（主人自己用不记）
  await recordMachineUse(pool, agent, user.id, 'quick', null, { agent: agent.id, kind })

  const pass = agent.pass
  let used = false
  return async function* open(signal: AbortSignal): AsyncGenerator<ModelChunk> {
    if (used) throw new Error('本地通道的流只能开一次')
    used = true
    if (busy.has(user.id)) throw new LocalQuickError('quick busy', BUSY_MESSAGE)
    busy.add(user.id)
    const queue: string[] = []
    let wake: () => void = () => undefined
    let finished: { msg: ConnMsg } | { error: Error } | null = null
    let revoked: string | null = null
    let rid = ''
    let stopped = false
    const stop = (): void => {
      if (stopped || !rid || finished) return
      stopped = true // 只让机器停一次（abort 监听和收尾都会调到这里）
      host.hub.cancelQuick(connectorId, rid)
    }
    const untrack = host.hub.trackQuick(connectorId, user.id, (reason) => {
      revoked = reason
      stop()
      wake()
    })
    const onAbort = (): void => {
      stop()
      wake()
    }
    signal.addEventListener('abort', onAbort)
    try {
      void host.hub
        .request(
          pass,
          (r, actor) => {
            rid = r
            return { t: 'quick', rid: r, actor, agent: agentId, prompt }
          },
          REQUEST_TIMEOUT_MS,
          undefined,
          (text) => {
            queue.push(text)
            wake()
          },
        )
        .then(
          (msg) => {
            finished = { msg }
            wake()
          },
          (error: unknown) => {
            finished = { error: error instanceof Error ? error : new Error(String(error)) }
            wake()
          },
        )
      for (;;) {
        while (queue.length > 0) yield { type: 'delta', text: queue.shift()! }
        if (revoked !== null) throw new LocalQuickError('revoked', revoked)
        if (signal.aborted) throw abortError()
        if (finished) break
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
      const end = finished as { msg: ConnMsg } | { error: Error }
      if ('error' in end) throw new LocalQuickError('machine', end.error.message)
      const msg = end.msg
      if (msg.t === 'err') throw new LocalQuickError(msg.code === 'forbidden' ? 'forbidden' : 'agent', msg.message)
      yield { type: 'stop', reason: msg.t === 'res' ? (msg.quick?.stopReason ?? 'end_turn') : 'end_turn' }
    } finally {
      signal.removeEventListener('abort', onAbort)
      untrack()
      stop()
      busy.delete(user.id)
    }
  }
}
