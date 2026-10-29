// ---------- connector 第二道闸：这台机器自己说了算 ----------
// 中心判定之外，connector 在本机再判一次：每个驱动机器的帧都带 actor（操作人的 user id），
// 只有两种人能过：
//   1. 机器主人：本地配置里的 ownerId（配对时中心告知并钉住，之后不再接受中心改写）；
//   2. 本地授权名单（grants）里的人：scope 匹配、未过期。名单只加不经过中心：只有本机的 `grant confirm` 命令（grant-cli.ts）
//      能往里加人（addLocalGrant）；中心的帧只能删人（grant-revoked → removeLocalGrants），永远加不了。
// 两边都放行才执行：中心哪怕有 bug、被攻破，也过不了这一关。
//
// 文件就是 ~/.ramet/connector.json（token 同一份）：{ token, cloud, ownerId?, grants? }。
// 每次判定都现读文件：授权名单是别的本机进程（确认 / 收回命令）写的，connector 常驻，不能缓存。
//
// 配置里没有 ownerId（升级前配的对）：没钉住之前拒绝一切人（包括主人，宁可多拒绝）；
// 中心在 welcome 帧里带 ownerId，connector 首次收到就钉进文件，之后固定。中心没有主人（DB 里 owner_id 为空）时不会钉，
// 这台机器就一直没人能用，重新配对后才有。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { MachineScope } from '../agents/machine-access.js'

/** grantId / username 只是给 `grant list` / `grant revoke` 看的（判定只认 userId + scopes + expiresAt） */
export type LocalGrant = { userId: string; scopes: MachineScope[]; expiresAt: string; grantId?: string; username?: string }

export type ConnectorConfig = {
  token: string
  cloud: string
  /** 机器主人（user id）。钉住后只在重新配对时变 */
  ownerId?: string
  grants?: LocalGrant[]
}

const SCOPES: readonly MachineScope[] = ['agent', 'machine']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读配置；文件不存在 / 坏了 = null。grants 里坏掉的条目丢弃（手改文件写错不能放行任何人） */
export function readConnectorConfig(file: string): ConnectorConfig | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!isRecord(raw) || typeof raw.token !== 'string' || !raw.token) return null
  const grants: LocalGrant[] = []
  if (Array.isArray(raw.grants)) {
    for (const g of raw.grants) {
      if (!isRecord(g) || typeof g.userId !== 'string' || !g.userId || typeof g.expiresAt !== 'string') continue
      const scopes = Array.isArray(g.scopes) ? g.scopes.filter((s): s is MachineScope => SCOPES.includes(s as MachineScope)) : []
      if (scopes.length > 0) {
        grants.push({
          userId: g.userId,
          scopes,
          expiresAt: g.expiresAt,
          ...(typeof g.grantId === 'string' && g.grantId ? { grantId: g.grantId } : {}),
          ...(typeof g.username === 'string' && g.username ? { username: g.username } : {}),
        })
      }
    }
  }
  return {
    token: raw.token,
    cloud: typeof raw.cloud === 'string' ? raw.cloud : '',
    ...(typeof raw.ownerId === 'string' && raw.ownerId ? { ownerId: raw.ownerId } : {}),
    ...(grants.length > 0 ? { grants } : {}),
  }
}

/** 整份写回（0600）。配对写入新身份时用；钉主人走 pinOwner（保留其余字段）。
 *  先写临时文件再 rename：常驻的 connector 每帧现读这份文件，读到写了一半的 JSON 会被当成「配置读不到」而拒绝所有人 */
export function writeConnectorConfig(file: string, config: ConnectorConfig): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
}

/** 往本地授权名单加一条（同一个人的旧条目被替换：一人一机只有一条）。只有本机的确认命令调它，
 *  中心的任何帧都不能往名单里加人。没有配置文件 → 'no-config'（不凭空建文件：没配对的机器没有名单可写） */
export function addLocalGrant(file: string, grant: LocalGrant): 'ok' | 'no-config' {
  const config = readConnectorConfig(file)
  if (!config) return 'no-config'
  writeConnectorConfig(file, { ...config, grants: [...(config.grants ?? []).filter((g) => g.userId !== grant.userId), grant] })
  return 'ok'
}

/** 从本地名单删人（按 userId，或按 grantId 只删那一条）；返回删了几条。名单只会因这个变短：中心的收回帧、本机的收回命令、确认失败回滚 */
export function removeLocalGrants(file: string, match: { userId?: string; grantId?: string }): number {
  const config = readConnectorConfig(file)
  if (!config?.grants) return 0
  const kept = config.grants.filter((g) => !((match.userId && g.userId === match.userId) || (match.grantId && g.grantId === match.grantId)))
  const removed = config.grants.length - kept.length
  if (removed > 0) {
    const { grants: _old, ...rest } = config
    writeConnectorConfig(file, kept.length > 0 ? { ...rest, grants: kept } : rest)
  }
  return removed
}

/** 中心告知的主人 → 钉进本地配置。已经钉过的绝不改写（返回 'kept'；与中心说的不一样返回 'conflict'）。
 *  没有配置文件（读不到 token）什么都不做 */
export function pinOwner(file: string, ownerId: string): 'pinned' | 'kept' | 'conflict' | 'no-config' {
  const config = readConnectorConfig(file)
  if (!config) return 'no-config'
  if (config.ownerId) return config.ownerId === ownerId ? 'kept' : 'conflict'
  writeConnectorConfig(file, { ...config, ownerId })
  return 'pinned'
}

export type Verdict = { ok: true } | { ok: false; reason: string }

/** 第二道闸的唯一判定：actor 能不能以 scope 驱动这台机器。缺 actor / 配置读不到 / 主人没钉住 → 一律拒绝 */
export function checkActor(file: string, actor: unknown, scope: MachineScope, now: number = Date.now()): Verdict {
  if (typeof actor !== 'string' || !actor) return { ok: false, reason: '指令没有带操作人，已拒绝' }
  const config = readConnectorConfig(file)
  if (!config) return { ok: false, reason: '本机连接配置读不到，已拒绝' }
  if (!config.ownerId) return { ok: false, reason: '本机还没有记录这台机器的主人（请先让中心下发，或重新配对），已拒绝' }
  if (actor === config.ownerId) return { ok: true }
  for (const g of config.grants ?? []) {
    if (g.userId !== actor || !g.scopes.includes(scope)) continue
    const expires = Date.parse(g.expiresAt)
    if (Number.isFinite(expires) && expires > now) return { ok: true }
  }
  return { ok: false, reason: '这台机器不允许你使用：你不是主人，也不在本机的授权名单里' }
}
