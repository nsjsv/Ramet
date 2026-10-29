// ---------- 项目面板（中心侧）：判定谁能看这台机器的工作区，并把请求转成 connector 帧 ----------
// 中心不运行 agent、不碰用户机器的文件系统，这里只做三件事：
//   1. projectContext：页面 + agent 对应哪台机器、哪个工作区；machine 范围的使用权判定（assertCanUse，唯一出口，
//      接入人或有效的 machine 授权；只有 agent 授权的人、空间 owner、全局 admin 都过不了）；
//   2. askProject：持凭据经 hub.request 发帧（hub 再校验凭据 / 范围 / connector 能力），connector 收到后还会按 actor 再判一次；
//   3. touchedByAgents：本页各轮 run 记录里 agent 改过的文件（改动页标「谁改的」用）。
// 路径约束不在这里：root 是中心给的（页面 + agent 的生效工作区），目标路径是否越界由 connector 执行时判定（connector/project-path.ts）。

import type { Pool } from 'pg'
import { assertCanUse, type MachinePass } from './machine-access.js'
import type { ConnectorHub } from './hub.js'
import type { DrivenMsg } from './protocol.js'
import { ProjectError, type ProjectReply } from './project-types.js'
import { parseRemoteId, UnknownAgentError } from './manager-types.js'
import { recordMachineUse } from './machine-grants.js'
import { effectiveCwd } from './session-store.js'

/** agent 不是 connector 上的（本机 agent / 乱写的 id）：没有项目面板 */
export class NotMachineAgentError extends Error {
  constructor() {
    super('这个 agent 不在用户自己的机器上，没有项目面板')
  }
}

/** 机器现在不在线 */
export class MachineOfflineError extends Error {
  constructor() {
    super('这台机器现在不在线')
  }
}

/** 项目请求的应答上限：git status / ls-files 在大仓库上要几秒；比这更久就当失败，别挂住请求 */
const PROJECT_TIMEOUT_MS = 30_000

export type ProjectCtx = {
  /** machine 范围的使用凭据（assertCanUse 签的） */
  pass: MachinePass
  /** 页面上选的 agent（catalog id，c:<connectorId>:<agentId>） */
  agent: string
  machine: { id: string; name: string; owner: string | null; ownerId: string | null; online: boolean }
  /** 这个页面上这个 agent 的生效工作区（离线时只有用户指定的，没有执行端默认，可能为空） */
  root: string
  /** connector hello 里声明的能力；离线为 [] */
  caps: string[]
}

const SELECT_MACHINE = `SELECT c.id, c.name, c.owner_id, u.username AS owner
  FROM connectors c
  JOIN space_members m ON m.space_id = c.space_id AND m.user_id = $2
  LEFT JOIN users u ON u.id = c.owner_id
  WHERE c.id = $1`

/** 解析「这个人在这个页面上用这个 agent 的机器」。失败：NotMachineAgentError(400) / UnknownAgentError(400，
 *  这台机器不在你的空间里或 agent 已不在) / ForbiddenError(403，没有 machine 授权，文案带主人名)。
 *  顺序同 AgentManager.resolve：先看空间成员资格（不可见按未知处理），再判授权（在「是否在线」之前，离线不是绕过判定的缝） */
export async function projectContext(
  pool: Pool,
  hub: ConnectorHub,
  pageId: string,
  agent: string,
  user: { id: string },
): Promise<ProjectCtx> {
  const parsed = parseRemoteId(agent)
  if (!parsed) throw new NotMachineAgentError()
  const { rows } = await pool.query<{ id: string; name: string; owner_id: string | null; owner: string | null }>(SELECT_MACHINE, [
    parsed.connectorId,
    user.id,
  ])
  const row = rows[0]
  if (!row) throw new UnknownAgentError()
  const pass = await assertCanUse(pool, user, row.id, 'machine')
  const conn = hub.get(row.id)
  if (conn && !conn.agents.some((a) => a.id === parsed.agentId)) throw new UnknownAgentError()
  const root = await effectiveCwd(pool, pageId, { id: agent, ...(conn ? { remote: { defaultCwd: conn.defaultCwd } } : {}) })
  return {
    pass,
    agent,
    machine: { id: row.id, name: row.name, owner: row.owner, ownerId: row.owner_id, online: conn !== undefined },
    root,
    caps: conn?.caps ?? [],
  }
}

/** 发一个项目帧并等应答。机器不在线抛 MachineOfflineError；connector 太旧抛 ConnectorOutdatedError（hub 抛）；
 *  connector 拒绝 / 失败抛 ProjectError（forbidden 是第二道闸拒绝） */
export async function askProject<T extends ProjectReply['op']>(
  hub: ConnectorHub,
  ctx: ProjectCtx,
  op: T,
  build: (rid: string, actor: string) => Extract<DrivenMsg, { rid: string }>,
): Promise<Extract<ProjectReply, { op: T }>> {
  if (!ctx.machine.online) throw new MachineOfflineError()
  const msg = await hub.request(ctx.pass, build, PROJECT_TIMEOUT_MS)
  if (msg.t === 'err') throw new ProjectError(msg.message, msg.code === 'forbidden', msg.code === 'not_found', msg.code === 'conflict')
  if (msg.t !== 'res' || !msg.project || msg.project.op !== op) throw new ProjectError('connector 没有返回预期的内容')
  return msg.project as Extract<ProjectReply, { op: T }>
}

/** 发一个项目帧，发出去就返回，不等 connector 应答。只用于终端输入：前端一批按键收到回复才发下一批（保序），
 *  回复若要等 connector 一个来回（远端机器 0.6s 级），连续打字就会一批批卡住。顺序由前端串行加中心按到达顺序写进同一条 ws 保证。
 *  发帧前的拒绝（离线 / 太旧 / 不支持终端 / 凭据）照常抛，调用方翻成 409 等；发出去之后 connector 的拒绝（不是你的终端、终端已关）
 *  交给 onLate。不是你的终端照样一个字节写不进去（connector 判），终端已关由输出流的 exit / end 告诉前端 */
export function sendProject(
  hub: ConnectorHub,
  ctx: ProjectCtx,
  build: (rid: string, actor: string) => Extract<DrivenMsg, { rid: string }>,
  onLate: (err: Error) => void,
): void {
  if (!ctx.machine.online) throw new MachineOfflineError()
  hub.dispatch(ctx.pass, build, PROJECT_TIMEOUT_MS).then(
    (msg) => {
      if (msg.t === 'err') onLate(new ProjectError(msg.message, msg.code === 'forbidden', msg.code === 'not_found', msg.code === 'conflict'))
    },
    (err: unknown) => onLate(err instanceof Error ? err : new Error(String(err))),
  )
}

/** 非机器主人的使用要留痕（读文件 / 看 diff / 打开面板 → files；写文件 → write；打开 / 关闭终端 → terminal）：写不进审计就不放行。
 *  主人自己用不记（recordMachineUse 内判） */
export function recordProjectUse(
  pool: Pool,
  ctx: ProjectCtx,
  userId: string,
  pageId: string,
  detail: Record<string, unknown>,
  action: 'files' | 'terminal' | 'preview' | 'write' = 'files',
): Promise<void> {
  return recordMachineUse(
    pool,
    { remote: { connectorId: ctx.machine.id, agentId: '', defaultCwd: '', ownerId: ctx.machine.ownerId } },
    userId,
    action,
    pageId,
    { agent: ctx.agent, ...detail },
  )
}

// ---------- 谁改的 ----------

// 本页各轮 run 的过程页（pages.kind = 'run'，parent_id = 对话页）的 record 里，改动类工具步骤（edit / delete / move）的位置信息。
// 只在 SQL 里抽出路径（不把整份 record 拉回来）；同一路径多个 agent 改过，取最近一轮的
const TOUCH_PATHS = ['$.entries[*] ? (@.k == "tool" && (@.kind == "edit" || @.kind == "delete" || @.kind == "move")).acp.locations[*].path',
  '$.entries[*] ? (@.k == "tool" && (@.kind == "edit" || @.kind == "delete" || @.kind == "move")).detail']
const SELECT_TOUCHED = `SELECT agent, path, (extract(epoch FROM last_at::timestamptz) * 1000)::float8 AS at FROM (
    SELECT r.record->>'agent' AS agent, (t.v #>> '{}') AS path, max(p.created_at) AS last_at
    FROM live_pages p
    JOIN runs r ON r.page_id = p.id
    CROSS JOIN LATERAL (
      SELECT jsonb_path_query(r.record, $2::jsonpath) AS v
      UNION ALL
      SELECT jsonb_path_query(r.record, $3::jsonpath) AS v
    ) t
    WHERE p.parent_id = $1 AND p.kind = 'run'
    GROUP BY 1, 2
  ) x WHERE path IS NOT NULL ORDER BY last_at ASC LIMIT 5000`

/** agent 报的绝对路径转成相对 root 的 `/` 路径；不在 root 之下返回 null（Windows 的反斜杠先换成 /） */
export function relativeToRoot(root: string, absolute: string): string | null {
  const norm = (p: string): string => p.replace(/\\/g, '/')
  const base = norm(root).replace(/\/+$/, '')
  const path = norm(absolute)
  return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null
}

/** 本页 agent 改过的文件：相对 root 的路径 → { agent（catalog id）, at（那一轮过程页的时间，毫秒）}。靠工具步骤的位置信息识别，
 *  agent 经命令行（sed -i、重定向）改的文件认不出来；用户后来又改过同一个文件也仍归 agent（尽力而为；
 *  随手 AI 落盘的由 project-write.ts 的 quick_writes 按时间盖过它） */
export async function touchedByAgents(pool: Pool, pageId: string, root: string): Promise<Map<string, { agent: string; at: number }>> {
  const { rows } = await pool.query<{ agent: string | null; path: string; at: number }>(SELECT_TOUCHED, [pageId, ...TOUCH_PATHS])
  const out = new Map<string, { agent: string; at: number }>()
  for (const row of rows) {
    const rel = row.agent ? relativeToRoot(root, row.path) : null
    if (rel && row.agent) out.set(rel, { agent: row.agent, at: row.at }) // 按时间升序：后面（更近的一轮）覆盖前面
  }
  return out
}
