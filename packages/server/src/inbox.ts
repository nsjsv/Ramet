// ---------- 收件箱：汇总所有页面里需要你的事 ----------
// 收件箱只是视图，不带来新权限：每条能看到的东西本来就能看到，每个按钮调的都是已有接口、走已有判定
// （审批 → POST /api/pages/:id/permission；批准 / 拒绝机器接入 → POST /api/connectors/:id/approve|reject）。
// 数据全部现算，只有 inbox_seen（上次看这个对话页的时刻）和 inbox_dismissed（点过「知道了」的条目）是它自己的状态。
//
// 条目类型与「谁看得到」：
//   approval          等你批准。看得到 = 这个页面 + agent 上在飞那一轮的发起人；没有对得上的在飞回合时退回「能回答它的人」。
//                     无论哪种最后都要再过一遍回答判定（与 POST …/permission 同一套：页面可写；ACP 审批再加对这台机器 agent 的使用权，
//                     本机 agent 是全局 admin）。看得到回答不了的审批一条都不给
//   connector_pending 待批准的 agent 接入：只给该空间 space_members.role='owner' 的人（不含全局 admin，与 routes/connectors.ts 的批准门槛同）
//   access_request    有人申请用你的机器：机器主人看得到；只展示，授权必须去设置里走完整流程
//   first_use         有人开始用你的机器了（machine_grants.first_used_at）：机器主人看得到，可「知道了」消掉
//   done              做完待你看：你发起的回合，在你上次看这个对话页之后又有新完成的（最近 7 天、最多 30 条，页面必须仍对你可读）
//   running           你发起的、此刻在飞的回合
//   plan              等你批计划：你发起的、还是草稿的计划；页面必须仍对你可写（owner / member），
//                     viewer / 被移出空间 / 页面进回收站的不给。按钮走 POST …/continue {team} 与 …/team/:id/cancel
//   question          等你回答：agent 的提问（带 form 的审批 = ACP elicitation）。数据源、可见性、回答判定都与 approval 同一套，
//                     只是表单要在页面里答，条目只给入口
// 列举类读路径一律只含自己是成员的空间，全局 admin 也一样。
import type { Pool } from 'pg'
import { pageAccess } from './collab.js'
import { approvalPreview, type ApprovalPreview } from './agents/approval-detail.js'
import { canUse, inConnectorSpace, type MachineScope } from './agents/machine-access.js'
import { parseRemoteId, type ActiveRun, type PendingApproval } from './agents/manager-types.js'
import type { ConnectorAgentInfo } from './agents/protocol.js'
import type { PermissionOption } from './agents/types.js'

export type InboxUser = { id: string; role: string }

/** 收件箱从运行时拿的东西（AgentManager / ConnectorHub 的只读快照），测试可以给桩 */
export type InboxHost = {
  approvals(): PendingApproval[]
  runs(): ActiveRun[]
  /** 中心本机 agent（RAMET_LOCAL_AGENTS=1 才有） */
  localAgents(): Array<{ id: string; label: string }>
  /** connector 此刻上报的 agent 清单；离线时为 undefined，回落库里上一次上报的 */
  onlineAgents(connectorId: string): ConnectorAgentInfo[] | undefined
}

export type InboxItem =
  | {
      type: 'approval'
      key: string
      at: null
      pageId: string
      pageTitle: string
      agentId: string
      agentName: string
      requestId: string
      title: string
      options: PermissionOption[]
      detail: ApprovalPreview
    }
  | {
      type: 'connector_pending'
      key: string
      at: string
      connectorId: string
      machine: string
      owner: string | null
      agents: string[]
      spaceId: string
      spaceName: string
    }
  | {
      type: 'access_request'
      key: string
      at: string
      connectorId: string
      machine: string
      spaceId: string
      spaceName: string
      requestId: string
      username: string
      scopes: MachineScope[]
      note: string
    }
  | {
      type: 'first_use'
      key: string
      at: string
      connectorId: string
      machine: string
      grantId: string
      username: string
      scopes: MachineScope[]
    }
  | {
      type: 'done'
      key: string
      at: string
      pageId: string
      pageTitle: string
      runPageId: string
      agentId: string
      agentName: string
      /** end = 做完；cancelled = 被停止；error = 出错 */
      outcome: string
    }
  | { type: 'running'; key: string; at: string; pageId: string; pageTitle: string; runId: string; agentId: string; agentName: string }
  /** 等你批计划：planId = team_plans 的行；title = 计划标题 */
  | { type: 'plan'; key: string; at: string; pageId: string; pageTitle: string; title: string; planId: string }
  /** 等你回答：agent 的提问（带 form 的审批）。表单在页面里答，这里只给入口 */
  | { type: 'question'; key: string; at: null; pageId: string; pageTitle: string; agentId: string; agentName: string; requestId: string; text: string }

const DONE_WINDOW_DAYS = 7
const LIST_MAX = 30

const iso = (d: Date): string => d.toISOString()

/** 收件箱刷新信号的去抖：300ms 内的多次 poke 合并成一次广播。
 *  第一次 poke 起定时器，到点广播一次，延迟有上界，不会被源源不断的事件无限推后 */
export class InboxPoke {
  private timer: NodeJS.Timeout | undefined

  constructor(
    private send: () => void,
    private delayMs = 300,
  ) {}

  poke(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.send()
    }, this.delayMs)
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
}

type PageInfo = { title: string; role: string }

/** 这些页面里我是成员的那些（live_pages + space_members）：标题与我的角色。不是成员 / 已回收 / 不存在的页面没有这一行 */
async function myPages(pool: Pool, userId: string, pageIds: string[]): Promise<Map<string, PageInfo>> {
  if (pageIds.length === 0) return new Map()
  const { rows } = await pool.query<{ id: string; title: string; role: string }>(
    `SELECT p.id, p.title, m.role FROM live_pages p
     JOIN space_members m ON m.space_id = p.space_id AND m.user_id = $2
     WHERE p.id = ANY($1::text[])`,
    [pageIds, userId],
  )
  return new Map(rows.map((r) => [r.id, { title: r.title, role: r.role }]))
}

/** 我对这个 agent 有没有使用权，与 AgentManager.resolve 同一套：本机 agent 归全局 admin；
 *  connector 上的 agent 要在机器所在空间里，且是接入人或有有效授权（canUse 是唯一实现）。不看机器在不在线，离线的审批留着，上线后可以再答 */
async function mayUseAgent(pool: Pool, host: InboxHost, user: InboxUser, agentId: string): Promise<boolean> {
  if (host.localAgents().some((a) => a.id === agentId)) return user.role === 'admin'
  const parsed = parseRemoteId(agentId)
  if (!parsed) return false
  return (await inConnectorSpace(pool, user.id, parsed.connectorId)) && (await canUse(pool, user.id, parsed.connectorId, 'agent'))
}

async function approvalItems(pool: Pool, user: InboxUser, host: InboxHost): Promise<InboxItem[]> {
  const all = host.approvals()
  if (all.length === 0) return []
  const runs = host.runs()
  // 页面 + agent 上有在飞的一轮：只给发起人。没有对得上的在飞回合（审批比一轮活得久、被叫 agent 的审批）才退回「能回答的人」
  const mine = all.filter((a) => {
    const run = runs.find((r) => r.pageId === a.pageId && r.agentId === a.agentId)
    return !run || run.userId === user.id
  })
  const pages = await myPages(pool, user.id, [...new Set(mine.map((a) => a.pageId))])
  const out: InboxItem[] = []
  for (const a of mine) {
    const page = pages.get(a.pageId)
    // 回答判定的前一半：页面可写（viewer 答不了，路由 403 / 404）
    if (!page || (page.role !== 'owner' && page.role !== 'member')) continue
    // 后一半：ACP 审批要对那台机器有 agent 使用权；Ramet 自己的审批不碰任何人的机器，只看页面可写
    if (!a.own && !(await mayUseAgent(pool, host, user, a.agentId))) continue
    if (a.event.form) {
      out.push({
        type: 'question',
        key: `question:${a.pageId}:${a.agentId}:${a.event.requestId}`,
        at: null,
        pageId: a.pageId,
        pageTitle: page.title,
        agentId: a.agentId,
        agentName: '',
        requestId: a.event.requestId,
        text: a.event.title,
      })
      continue
    }
    out.push({
      type: 'approval',
      key: `approval:${a.pageId}:${a.agentId}:${a.event.requestId}`,
      at: null,
      pageId: a.pageId,
      pageTitle: page.title,
      agentId: a.agentId,
      agentName: '',
      requestId: a.event.requestId,
      title: a.event.title,
      options: a.event.options,
      detail: approvalPreview(a.event.toolCall),
    })
  }
  return out
}

const SELECT_PENDING = `SELECT c.id, c.name, c.agents, c.created_at, c.space_id, s.name AS space_name, u.username AS owner
  FROM connectors c
  JOIN space_members m ON m.space_id = c.space_id AND m.user_id = $1 AND m.role = 'owner'
  JOIN spaces s ON s.id = c.space_id
  LEFT JOIN users u ON u.id = c.owner_id
  WHERE c.status = 'pending' ORDER BY c.created_at, c.id LIMIT ${LIST_MAX}`

async function pendingConnectorItems(pool: Pool, user: InboxUser, host: InboxHost): Promise<InboxItem[]> {
  const { rows } = await pool.query<{
    id: string
    name: string
    agents: ConnectorAgentInfo[] | null
    created_at: Date
    space_id: string
    space_name: string
    owner: string | null
  }>(SELECT_PENDING, [user.id])
  return rows.map((r) => ({
    type: 'connector_pending' as const,
    key: `connector_pending:${r.id}`,
    at: iso(r.created_at),
    connectorId: r.id,
    machine: r.name,
    owner: r.owner,
    agents: (host.onlineAgents(r.id) ?? r.agents ?? []).map((a) => a.label),
    spaceId: r.space_id,
    spaceName: r.space_name,
  }))
}

// 主人 = connectors.owner_id；已批准的机器才有「申请使用」。申请人必须仍是这个空间的 owner / member（授权也只能给他们）
const SELECT_REQUESTS = `SELECT r.id, r.connector_id, r.scopes, r.note, r.created_at, c.name AS machine, c.space_id, s.name AS space_name, u.username
  FROM machine_access_requests r
  JOIN connectors c ON c.id = r.connector_id AND c.owner_id = $1 AND c.status = 'approved'
  JOIN spaces s ON s.id = c.space_id
  JOIN users u ON u.id = r.user_id
  JOIN space_members rm ON rm.space_id = c.space_id AND rm.user_id = r.user_id AND rm.role IN ('owner', 'member')
  WHERE r.resolved_at IS NULL ORDER BY r.created_at, r.id LIMIT ${LIST_MAX}`

async function accessRequestItems(pool: Pool, user: InboxUser): Promise<InboxItem[]> {
  const { rows } = await pool.query<{
    id: string
    connector_id: string
    scopes: MachineScope[]
    note: string
    created_at: Date
    machine: string
    space_id: string
    space_name: string
    username: string
  }>(SELECT_REQUESTS, [user.id])
  return rows.map((r) => ({
    type: 'access_request' as const,
    key: `access_request:${r.id}`,
    at: iso(r.created_at),
    connectorId: r.connector_id,
    machine: r.machine,
    spaceId: r.space_id,
    spaceName: r.space_name,
    requestId: r.id,
    username: r.username,
    scopes: r.scopes,
    note: r.note,
  }))
}

export const FIRST_USE_PREFIX = 'first_use:'
// 授权最长 30 天，首次使用的提醒也只留这么久；点过「知道了」的不再给
const SELECT_FIRST_USE = `SELECT g.id, g.connector_id, g.scopes, g.first_used_at, c.name AS machine, u.username
  FROM machine_grants g
  JOIN connectors c ON c.id = g.connector_id AND c.owner_id = $1
  LEFT JOIN users u ON u.id = g.user_id
  WHERE g.first_used_at IS NOT NULL AND g.first_used_at > now() - interval '30 days'
    AND NOT EXISTS (SELECT 1 FROM inbox_dismissed d WHERE d.user_id = $1 AND d.item_key = '${FIRST_USE_PREFIX}' || g.id)
  ORDER BY g.first_used_at DESC, g.id LIMIT ${LIST_MAX}`

async function firstUseItems(pool: Pool, user: InboxUser): Promise<InboxItem[]> {
  const { rows } = await pool.query<{
    id: string
    connector_id: string
    scopes: MachineScope[]
    first_used_at: Date
    machine: string
    username: string | null
  }>(SELECT_FIRST_USE, [user.id])
  return rows.map((r) => ({
    type: 'first_use' as const,
    key: `${FIRST_USE_PREFIX}${r.id}`,
    at: iso(r.first_used_at),
    connectorId: r.connector_id,
    machine: r.machine,
    grantId: r.id,
    username: r.username ?? '',
    scopes: r.scopes,
  }))
}

// 过程页（kind='run'）的 owner_id = 发起这一轮的人、parent_id = 对话页；每个对话页只取最新的一轮。
// 页面必须仍对我可读：对话页是活的（live_pages），且我是它所在空间的成员（列举类：全局 admin 也不例外）
const SELECT_DONE = `SELECT p.id AS page_id, p.title, rp.id AS run_page_id, rp.done_at, r.record->>'agent' AS agent, r.record->>'outcome' AS outcome
  FROM (
    SELECT DISTINCT ON (parent_id) id, parent_id, created_at::timestamptz AS done_at
    FROM live_pages
    WHERE kind = 'run' AND owner_id = $1 AND parent_id IS NOT NULL
      AND created_at::timestamptz > now() - interval '${DONE_WINDOW_DAYS} days'
    ORDER BY parent_id, created_at::timestamptz DESC, id
  ) rp
  JOIN live_pages p ON p.id = rp.parent_id
  JOIN space_members m ON m.space_id = p.space_id AND m.user_id = $1
  LEFT JOIN inbox_seen s ON s.user_id = $1 AND s.page_id = p.id
  LEFT JOIN runs r ON r.page_id = rp.id
  WHERE s.seen_at IS NULL OR rp.done_at > s.seen_at
  ORDER BY rp.done_at DESC, rp.id LIMIT ${LIST_MAX}`

async function doneItems(pool: Pool, user: InboxUser): Promise<InboxItem[]> {
  const { rows } = await pool.query<{
    page_id: string
    title: string
    run_page_id: string
    done_at: Date
    agent: string | null
    outcome: string | null
  }>(SELECT_DONE, [user.id])
  return rows.map((r) => ({
    type: 'done' as const,
    key: `done:${r.page_id}`,
    at: iso(r.done_at),
    pageId: r.page_id,
    pageTitle: r.title,
    runPageId: r.run_page_id,
    agentId: r.agent ?? '',
    agentName: '',
    outcome: r.outcome ?? 'end',
  }))
}

async function runningItems(pool: Pool, user: InboxUser, host: InboxHost): Promise<InboxItem[]> {
  const mine = host.runs().filter((r) => r.userId === user.id)
  if (mine.length === 0) return []
  const pages = await myPages(pool, user.id, [...new Set(mine.map((r) => r.pageId))])
  const out: InboxItem[] = []
  for (const r of mine) {
    const page = pages.get(r.pageId)
    if (!page) continue
    out.push({
      type: 'running',
      key: `running:${r.runId}`,
      at: new Date(r.startedAt).toISOString(),
      pageId: r.pageId,
      pageTitle: page.title,
      runId: r.runId,
      agentId: r.agentId,
      agentName: '',
    })
  }
  return out
}

// 我发起的草稿计划。页面是活的（live_pages），且我在它所在空间是 owner / member（能开工 / 取消才给；全局 admin 也不例外）
const SELECT_PLANS = `SELECT t.id, t.page_id, t.plan->>'title' AS title, t.created_at, p.title AS page_title
  FROM team_plans t
  JOIN live_pages p ON p.id = t.page_id
  JOIN space_members m ON m.space_id = p.space_id AND m.user_id = $1 AND m.role IN ('owner', 'member')
  WHERE t.user_id = $1 AND t.status = 'draft'
  ORDER BY t.created_at DESC, t.id LIMIT ${LIST_MAX}`

async function planItems(pool: Pool, user: InboxUser): Promise<InboxItem[]> {
  const { rows } = await pool.query<{ id: string; page_id: string; title: string | null; created_at: Date; page_title: string }>(SELECT_PLANS, [user.id])
  return rows.map((r) => ({
    type: 'plan' as const,
    key: `plan:${r.id}`,
    at: iso(r.created_at),
    pageId: r.page_id,
    pageTitle: r.page_title,
    title: r.title ?? '',
    planId: r.id,
  }))
}

/** 本机 agent 用目录里的名字；connector 上的 agent = `<机器名> · <agent 名>`（与 /api/agents 的 label 同形）。查不到就回落 id */
async function agentNames(pool: Pool, host: InboxHost, ids: Set<string>): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const remote = new Map<string, Array<{ id: string; agentId: string }>>()
  for (const id of ids) {
    const local = host.localAgents().find((a) => a.id === id)
    if (local) {
      names.set(id, local.label)
      continue
    }
    const parsed = parseRemoteId(id)
    if (!parsed) continue
    const list = remote.get(parsed.connectorId) ?? []
    list.push({ id, agentId: parsed.agentId })
    remote.set(parsed.connectorId, list)
  }
  if (remote.size > 0) {
    const { rows } = await pool.query<{ id: string; name: string; agents: ConnectorAgentInfo[] | null }>(
      'SELECT id, name, agents FROM connectors WHERE id = ANY($1::text[])',
      [[...remote.keys()]],
    )
    for (const row of rows) {
      const agents = host.onlineAgents(row.id) ?? row.agents ?? []
      for (const { id, agentId } of remote.get(row.id) ?? []) {
        names.set(id, `${row.name} · ${agents.find((a) => a.id === agentId)?.label ?? agentId}`)
      }
    }
  }
  return names
}

/** 当前用户的收件箱。顺序只是同类挨着，分组与排序是前端的事 */
export async function collectInbox(pool: Pool, user: InboxUser, host: InboxHost): Promise<InboxItem[]> {
  const [approvals, pending, requests, firstUse, plans, done, running] = await Promise.all([
    approvalItems(pool, user, host),
    pendingConnectorItems(pool, user, host),
    accessRequestItems(pool, user),
    firstUseItems(pool, user),
    planItems(pool, user),
    doneItems(pool, user),
    runningItems(pool, user, host),
  ])
  const items = [...approvals, ...pending, ...requests, ...firstUse, ...plans, ...done, ...running]
  const ids = new Set<string>()
  for (const item of items) if ('agentId' in item && item.agentId) ids.add(item.agentId)
  const names = await agentNames(pool, host, ids)
  for (const item of items) if ('agentName' in item) item.agentName = names.get(item.agentId) ?? item.agentId
  return items
}

const UPSERT_SEEN = `INSERT INTO inbox_seen (user_id, page_id, seen_at) VALUES ($1, $2, now())
  ON CONFLICT (user_id, page_id) DO UPDATE SET seen_at = now()`

/** 打开了这个对话页，「做完待你看」据此消掉。页面对我不可读（不存在 / 已回收 / 不是成员）返回 false，不写行 */
export async function markSeen(pool: Pool, user: InboxUser, pageId: string): Promise<boolean> {
  if (!(await pageAccess(pool, pageId, user))) return false
  await pool.query(UPSERT_SEEN, [user.id, pageId])
  return true
}

export type DismissResult = 'ok' | 'invalid' | 'not-found'

const SELECT_MY_GRANT = `SELECT 1 FROM machine_grants g JOIN connectors c ON c.id = g.connector_id AND c.owner_id = $1
  WHERE g.id = $2 AND g.first_used_at IS NOT NULL`
const INSERT_DISMISSED = 'INSERT INTO inbox_dismissed (user_id, item_key) VALUES ($1, $2) ON CONFLICT DO NOTHING'

/** 点「知道了」。key 只认收件箱里本来就会给我的那类（现在只有 first_use:<授权 id>），格式不对返回 invalid；
 *  授权不存在或不是我的机器上的返回 not-found（不写行，也不区分这两种，免得探别人的授权 id） */
export async function dismissItem(pool: Pool, user: InboxUser, key: string): Promise<DismissResult> {
  if (!key.startsWith(FIRST_USE_PREFIX)) return 'invalid'
  const grantId = key.slice(FIRST_USE_PREFIX.length)
  if (!grantId || grantId.length > 100) return 'invalid'
  if (!(await pool.query(SELECT_MY_GRANT, [user.id, grantId])).rowCount) return 'not-found'
  await pool.query(INSERT_DISMISSED, [user.id, key])
  return 'ok'
}
