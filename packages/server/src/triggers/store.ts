// ---------- 定时器：增删改查与上限（Genet 端点与 AI 页的 REST 都只经这里；规则的通用部分也在这里，见 rules.ts） ----------
// 定时器是 source = 'timer' 的规则。Genet 设的定时器只有一个动作：叫 Genet（缺省），或叫 Genet 页名下任务页上的 agent。
// 判定在创建时做一次，到点派发时（hub.ts）再按创建人此刻的权限判一次。
// Genet 端点只看得到 / 改得了「目标在它这一页名下」的定时器（scope.home，按老列 target_page 认）；AI 页看自己的全部。别人的 / 不存在统一 404。
// 老列 target_page / agent / instruction：派发不读，写入时由「第一个 AI 动作」同步（legacyColumns），Genet 的列表据此限定范围。
// 时间按定时器自己记下的时区算（schedule.ts）；改时间表时改用用户此刻的时区：Genet 理解「9 点」用的就是它（时间行），
// 只是用户换了时区不会去挪他没动过的定时器。

import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type * as Y from 'yjs'
import { withTransaction } from '../db.js'
import { ASSISTANT_ID, isAssistantId } from '../agents/assistant-agent.js'
import { loadChoice } from '../agents/session-store.js'
import { checkActions } from './action-check.js'
import { parseActions, type Action } from './actions.js'
import type { TriggerSource } from './payload.js'
import { describeSchedule, localStamp, nextAt, parseSchedule, serverTimeZone, validTimeZone, type Schedule } from './schedule.js'

export const TIMER_LIMITS = {
  /** 每人启用中的定时器 */
  enabled: 20,
  /** 每人 24 小时内含 AI 动作的触发次数（送达 + 还排着的），超了这次跳过 */
  daily: 50,
  /** 连续失败这么多次自动暂停 */
  failStreak: 3,
  name: 40,
  instruction: 4000,
} as const

export const RULE_LIMITS = {
  /** 每人启用中的规则（含定时器） */
  enabled: 100,
  /** 每人 24 小时内只含确定性动作的执行次数 */
  dailyPlain: 1000,
} as const

export type TriggerStatus = 'pending' | 'queued' | 'delivered' | 'skipped' | 'failed'

export type TimerTarget = { kind: 'genet' } | { kind: 'page'; pageId: string; title: string }

export type TimerView = {
  id: string
  name: string
  instruction: string
  schedule: Schedule
  /** 人话的时间表（「每天 09:00」），前端不重写规则 */
  scheduleText: string
  timeZone: string
  nextAt: string | null
  /** 下次触发的当地时间（「2026-11-07 周六 09:00」）；不再触发为空 */
  nextText: string
  target: TimerTarget
  enabled: boolean
  /** 连续失败自动暂停的原因；手动暂停为空 */
  pausedReason: string
  /** 最近一次触发：at = 那次的预定时刻 */
  last: { status: TriggerStatus; reason: string; at: string } | null
}

export class TimerError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message)
  }
}

/** ownerId = 定时器的主人；home = 只看目标在这个 Genet 页名下的（Genet 端点）。目标页进了回收站的照样列出来（能删、能看原因），
 *  所以这里按 pages 而不是 live_pages 认父页 */
export type TimerScope = { ownerId: string; home?: string }

/** 规则的一行（定时器视图与规则视图共用的列） */
export type RuleRow = {
  id: string
  owner_id: string
  name: string
  source: TriggerSource
  instruction: string
  spec: unknown
  config: unknown
  actions: unknown
  time_zone: string
  space_id: string
  scope_page: string | null
  /** 内置规则（triggers/builtin.ts）：'comment' / 'mention'；普通规则为空 */
  builtin: string | null
  target_page: string | null
  agent: string
  enabled: boolean
  next_at: Date | null
  fail_streak: number
  paused_reason: string
  created_at: Date
  target_title: string | null
  scope_title: string | null
  last_status: TriggerStatus | null
  last_reason: string | null
  last_at: Date | null
  last_results: unknown
}

// 页面标题只在它还活着、主人仍是那个空间的成员时给：被移出空间后列表里不该还看得到别人空间里的标题
const TITLE_IF_VISIBLE = (alias: string): string => `CASE WHEN ${alias}.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = ${alias}.space_id AND m.user_id = t.owner_id) THEN ${alias}.title END`

export const SELECT_RULE = `SELECT t.id, t.owner_id, t.name, t.source, t.instruction, t.spec, t.config, t.actions, t.time_zone, t.space_id, t.scope_page, t.builtin,
    t.target_page, t.agent, t.enabled, t.next_at, t.fail_streak, t.paused_reason, t.created_at,
    ${TITLE_IF_VISIBLE('p')} AS target_title, ${TITLE_IF_VISIBLE('sp')} AS scope_title,
    e.status AS last_status, e.reason AS last_reason, e.scheduled_at AS last_at, e.results AS last_results
  FROM agent_triggers t
  LEFT JOIN pages p ON p.id = t.target_page
  LEFT JOIN pages sp ON sp.id = t.scope_page
  LEFT JOIN LATERAL (
    SELECT status, reason, scheduled_at, results FROM trigger_events WHERE trigger_id = t.id ORDER BY created_at DESC, scheduled_at DESC LIMIT 1
  ) e ON true`

const SELECT_TIMER = `${SELECT_RULE} WHERE t.owner_id = $1 AND t.source = 'timer' AND ($2::text IS NULL OR t.target_page = $2 OR p.parent_id = $2)`

function view(r: RuleRow): TimerView {
  const parsed = parseSchedule(r.spec)
  const schedule = 'error' in parsed ? (r.spec as Schedule) : parsed
  return {
    id: r.id,
    name: r.name,
    instruction: r.instruction,
    schedule,
    scheduleText: 'error' in parsed ? '（时间表认不出来）' : describeSchedule(parsed),
    timeZone: r.time_zone,
    nextAt: r.next_at?.toISOString() ?? null,
    nextText: r.next_at ? localStamp(r.next_at, r.time_zone) : '',
    target: isAssistantId(r.agent)
      ? { kind: 'genet' }
      : { kind: 'page', pageId: r.target_page ?? '', title: r.target_title === null ? '（看不到这一页了）' : r.target_title || '无标题' },
    enabled: r.enabled,
    pausedReason: r.paused_reason,
    last: r.last_status && r.last_at ? { status: r.last_status, reason: r.last_reason ?? '', at: r.last_at.toISOString() } : null,
  }
}

/** 这个人的时区：上报过且还认得就用，否则服务器的 */
export async function userTimeZone(pool: Pick<Pool, 'query'>, userId: string): Promise<string> {
  const raw = (await pool.query<{ time_zone: string | null }>('SELECT time_zone FROM users WHERE id = $1', [userId])).rows[0]?.time_zone
  return validTimeZone(raw) ?? serverTimeZone()
}

/** 浏览器上报的时区；不认得的抛 400 */
export async function setUserTimeZone(pool: Pool, userId: string, raw: unknown): Promise<string> {
  const tz = validTimeZone(raw)
  if (!tz) throw new TimerError(400, '不认识这个时区（要 IANA 名字，如 Asia/Shanghai）')
  await pool.query('UPDATE users SET time_zone = $2 WHERE id = $1', [userId, tz])
  return tz
}

export async function listTimers(pool: Pool, scope: TimerScope): Promise<TimerView[]> {
  const { rows } = await pool.query<RuleRow>(`${SELECT_TIMER} ORDER BY t.created_at DESC, t.id`, [scope.ownerId, scope.home ?? null])
  return rows.map(view)
}

export async function getTimer(pool: Pick<Pool, 'query'>, scope: TimerScope, id: string): Promise<TimerView | null> {
  const row = (await pool.query<RuleRow>(`${SELECT_TIMER} AND t.id = $3`, [scope.ownerId, scope.home ?? null, id])).rows[0]
  return row ? view(row) : null
}

/** 去掉两头空白；空 / 超长 400（按码点数：中文 / emoji 都算一个字） */
export function text(raw: unknown, max: number, what: string): string {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) throw new TimerError(400, `${what}不能为空`)
  if ([...s].length > max) throw new TimerError(400, `${what}最多 ${max} 个字`)
  return s
}

export function schedule(raw: unknown): Schedule {
  const s = parseSchedule(raw)
  if ('error' in s) throw new TimerError(400, s.error)
  return s
}

/** 从 now 起的下一次；一次性的已经过了 400 */
export function firstAt(s: Schedule, tz: string, now: Date): Date {
  const next = nextAt(s, tz, now, now)
  if (!next) throw new TimerError(400, `时间已经过了（现在是 ${localStamp(now, tz)}，${tz}）`)
  return next
}

const TARGET_HINT = '目标只能是 genet（Genet 自己，缺省），或 Genet 派出去的任务页 page:<id>'
/** 目标页进了回收站 / 不在 Genet 名下了（Genet 设定时器时的目标判定） */
export const TARGET_GONE = '目标页已经不在了（进了回收站，或者不在 Genet 名下了）'

/** Genet 给的目标 → 动作 + 空间。任务页的 agent = 派活时记下的，没有就用这一页记住的来源 */
async function resolveTarget(pool: Pool, home: string, raw: unknown, instruction: string): Promise<{ action: Action; space: string }> {
  const spec = typeof raw === 'string' ? raw.trim() : ''
  if (!spec || spec === 'genet') {
    const page = (await pool.query<{ space_id: string | null }>('SELECT space_id FROM live_pages WHERE id = $1', [home])).rows[0]
    if (!page?.space_id) throw new TimerError(400, 'Genet 页不在了')
    return { action: { type: 'genet', instruction }, space: page.space_id }
  }
  const id = spec.replace(/^page:/, '')
  const page = (
    await pool.query<{ parent_id: string | null; space_id: string | null }>("SELECT parent_id, space_id FROM live_pages WHERE id = $1 AND kind = 'doc'", [id])
  ).rows[0]
  if (!page?.space_id || page.parent_id !== home) throw new TimerError(400, TARGET_HINT)
  const task = (await pool.query<{ agent: string }>('SELECT agent FROM assistant_tasks WHERE page_id = $1', [id])).rows[0]?.agent
  const agent = task || (await loadChoice(pool, id))
  if (!agent || isAssistantId(agent)) throw new TimerError(400, '这个任务页还没有 agent：先用 dispatch_task 派一次活')
  return { action: { type: 'agent', page: id, agent, instruction }, space: page.space_id }
}

/** 老列 target_page / agent / instruction = 第一个 AI 动作（叫 Genet 的目标页是主人此刻的 Genet 页）；没有 AI 动作 = 空 */
export async function legacyColumns(pool: Pick<Pool, 'query'>, ownerId: string, actions: readonly Action[]): Promise<{ target: string | null; agent: string; instruction: string }> {
  const ai = actions.find((a) => a.type === 'genet' || a.type === 'agent')
  if (ai?.type === 'agent') return { target: ai.page, agent: ai.agent, instruction: ai.instruction }
  if (ai?.type !== 'genet') return { target: null, agent: '', instruction: '' }
  const home = (await pool.query<{ page_id: string }>('SELECT a.page_id FROM assistants a JOIN live_pages p ON p.id = a.page_id WHERE a.user_id = $1', [ownerId])).rows[0]
  return { target: home?.page_id ?? null, agent: ASSISTANT_ID, instruction: ai.instruction }
}

/** 启用中的不能超过上限（定时器 20 个，规则一共 100 个）。先锁住这个人的用户行：并发建两个也不会一起穿过去。
 *  内置规则（builtin.ts）不算：每人固定两条、默认开，算进去就是平白少了两个名额，关掉再开也可能被自己建的规则挡住 */
export async function checkEnabledLimit(db: PoolClient, ownerId: string, exceptId: string, source: TriggerSource): Promise<void> {
  await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [ownerId])
  const counted = await db.query<{ all: number; timers: number }>(
    `SELECT count(*)::int AS all, count(*) FILTER (WHERE source = 'timer')::int AS timers FROM agent_triggers WHERE owner_id = $1 AND enabled AND builtin IS NULL AND id <> $2`,
    [ownerId, exceptId],
  )
  const n = counted.rows[0] ?? { all: 0, timers: 0 }
  if (source === 'timer' && n.timers >= TIMER_LIMITS.enabled) throw new TimerError(400, `启用中的定时器最多 ${TIMER_LIMITS.enabled} 个：先删掉或暂停几个`)
  if (n.all >= RULE_LIMITS.enabled) throw new TimerError(400, `启用中的规则最多 ${RULE_LIMITS.enabled} 个：先删掉或暂停几个`)
}

/** 新建（只有 Genet 能建：home = 它的 Genet 页） */
export async function createTimer(pool: Pool, scope: Required<TimerScope>, input: Record<string, unknown>, now: Date): Promise<TimerView> {
  const name = text(input.name, TIMER_LIMITS.name, '名字')
  const instruction = text(input.instruction, TIMER_LIMITS.instruction, '指令')
  const s = schedule(input.schedule)
  const target = await resolveTarget(pool, scope.home, input.target, instruction)
  const tz = await userTimeZone(pool, scope.ownerId)
  const next = firstAt(s, tz, now)
  const id = randomUUID()
  const legacy = await legacyColumns(pool, scope.ownerId, [target.action])
  await withTransaction(pool, async (db) => {
    await checkEnabledLimit(db, scope.ownerId, id, 'timer')
    await db.query(
      `INSERT INTO agent_triggers (id, space_id, owner_id, source, name, instruction, spec, time_zone, target_page, agent, next_at, actions)
       VALUES ($1, $2, $3, 'timer', $4, $5, $6::jsonb, $7, $8, $9, $10, $11::jsonb)`,
      [id, target.space, scope.ownerId, name, instruction, JSON.stringify(s), tz, legacy.target, legacy.agent, next, JSON.stringify([target.action])],
    )
  })
  return (await getTimer(pool, scope, id))!
}

export type RulePatch = { name?: string; schedule?: Schedule; actions?: Action[]; enabled?: boolean }

/** 盯页面的规则暂停 / 恢复 / 改了盯哪一页：攒着的改动作废、不再排汇报（规则行由调用方锁着；恢复后从下一次别人的改动重新攒） */
export async function clearWatch(db: Pick<PoolClient, 'query'>, ruleId: string): Promise<void> {
  await db.query('DELETE FROM page_watch_windows WHERE trigger_id = $1', [ruleId])
  await db.query("UPDATE agent_triggers SET next_at = NULL WHERE id = $1 AND source = 'page_watch'", [ruleId])
}

/** 改一条规则（锁着的那一行 cur）：名字 / 时间表 / 动作 / 启用。规则的改动与定时器的改动都经这里。
 *  改时间表或从暂停恢复：下次从现在重算、失败计数与自动暂停的原因清掉；恢复与改动作之前按主人此刻的身份重判动作。
 *  暂停：不再排下次。已经进了排队发送、还没发出去的那一条不撤回：它是暂停之前到点的那一次，照常发出去
 *  （主人在任务页的排队区能撤回；要连它一起作废就删掉规则） */
export async function applyPatch(
  pool: Pool,
  db: PoolClient,
  cur: RuleRow,
  owner: { id: string; role: string },
  patch: RulePatch,
  now: Date,
  /** 判属性名时读合集定义用活文档（刚加的属性可能还没落盘） */
  getLiveDoc?: (docName: string) => Y.Doc | undefined,
): Promise<void> {
  const timer = cur.source === 'timer'
  const enabled = patch.enabled ?? cur.enabled
  const resumed = enabled && !cur.enabled
  const zone = patch.schedule ? await userTimeZone(pool, owner.id) : cur.time_zone
  let { next_at: next, fail_streak: streak, paused_reason: paused } = cur
  if (timer && (patch.schedule || resumed)) {
    const first = nextAt(patch.schedule ?? (parseSchedule(cur.spec) as Schedule), zone, now, now)
    if (!first) {
      throw new TimerError(400, patch.schedule ? `时间已经过了（现在是 ${localStamp(now, zone)}，${zone}）` : '这个一次性的定时已经过了时间：改个时间再启用')
    }
    next = first
  }
  // 暂停着只改时间表：自动暂停的原因与失败计数留着，不然 AI 页上看起来像是手动暂停的，原因也丢了
  if (enabled && (resumed || patch.schedule)) {
    streak = 0
    paused = ''
  }
  if (!enabled) next = null
  const parsed = patch.actions ?? parseActions(cur.actions)
  if ((resumed || (patch.actions && enabled)) && !('error' in parsed)) {
    const builtin = Boolean(cur.builtin)
    const reason = await checkActions(
      { pool, ...(getLiveDoc ? { getLiveDoc } : {}), owner, source: cur.source, spaceId: cur.space_id, ...(builtin ? { genetOptional: true } : {}) },
      parsed,
    )
    // 内置规则删不掉：只提示改动作
    if (reason) throw new TimerError(400, resumed && !patch.actions ? `${reason}：恢复了也触发不了，${builtin ? '' : '删掉它，或者'}改一下动作` : reason)
  }
  if (resumed && !cur.builtin) await checkEnabledLimit(db, owner.id, cur.id, cur.source)
  if (cur.source === 'page_watch' && (!enabled || resumed)) {
    await clearWatch(db, cur.id)
    next = null
  }
  const legacy = patch.actions ? await legacyColumns(pool, owner.id, patch.actions) : null
  await db.query(
    `UPDATE agent_triggers SET name = COALESCE($2, name), spec = COALESCE($3::jsonb, spec), time_zone = $4, enabled = $5, next_at = $6,
       fail_streak = $7, paused_reason = $8, actions = COALESCE($9::jsonb, actions),
       target_page = CASE WHEN $9::jsonb IS NULL THEN target_page ELSE $10 END,
       agent = CASE WHEN $9::jsonb IS NULL THEN agent ELSE $11 END,
       instruction = CASE WHEN $9::jsonb IS NULL THEN instruction ELSE $12 END, updated_at = now() WHERE id = $1`,
    [
      cur.id, patch.name ?? null, patch.schedule ? JSON.stringify(patch.schedule) : null, zone, enabled, next, streak, paused,
      patch.actions ? JSON.stringify(patch.actions) : null, legacy?.target ?? null, legacy?.agent ?? '', legacy?.instruction ?? '',
    ],
  )
}

async function ownerOf(pool: Pick<Pool, 'query'>, ownerId: string): Promise<{ id: string; role: string }> {
  const role = (await pool.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [ownerId])).rows[0]?.role
  return { id: ownerId, role: role ?? 'user' }
}

/** 改名字 / 指令 / 时间表 / 启用（Genet 的 update_timer 与 AI 页的开关）。指令只能改「只有一个 AI 动作」的定时器：
 *  在 AI 页上配了几个动作的，指令要到那里逐个改 */
export async function updateTimer(pool: Pool, scope: TimerScope, id: string, patch: Record<string, unknown>, now: Date): Promise<TimerView> {
  const keys = ['name', 'instruction', 'schedule', 'enabled'].filter((k) => patch[k] !== undefined)
  if (keys.length === 0) throw new TimerError(400, '没有要改的（可改 name / instruction / schedule / enabled）')
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new TimerError(400, 'enabled 要写成 true / false')
  const name = patch.name !== undefined ? text(patch.name, TIMER_LIMITS.name, '名字') : undefined
  const instruction = patch.instruction !== undefined ? text(patch.instruction, TIMER_LIMITS.instruction, '指令') : undefined
  const rescheduled = patch.schedule !== undefined ? schedule(patch.schedule) : undefined
  const owner = await ownerOf(pool, scope.ownerId)
  await withTransaction(pool, async (db) => {
    const cur = (await db.query<RuleRow>(`${SELECT_TIMER} AND t.id = $3 FOR UPDATE OF t`, [scope.ownerId, scope.home ?? null, id])).rows[0]
    if (!cur) throw new TimerError(404, '没有这个定时器')
    let actions: Action[] | undefined
    if (instruction !== undefined) {
      const parsed = parseActions(cur.actions)
      const only = 'error' in parsed || parsed.length !== 1 ? null : parsed[0]!
      if (only?.type !== 'genet' && only?.type !== 'agent') throw new TimerError(400, '这个定时器有好几个动作：指令要到 AI 页「自动」里逐个改')
      actions = [{ ...only, instruction }]
    }
    const rulePatch: RulePatch = {
      ...(name !== undefined ? { name } : {}),
      ...(rescheduled ? { schedule: rescheduled } : {}),
      ...(actions ? { actions } : {}),
      ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
    }
    await applyPatch(pool, db, cur, owner, rulePatch, now)
  })
  return (await getTimer(pool, scope, id))!
}

/** 这条规则还排在 send_queue 里的触发记录（删之前查：删了就对不上是哪条规则排的了） */
export async function queuedOf(db: Pick<PoolClient, 'query'>, ruleId: string): Promise<string[]> {
  const queued = await db.query<{ id: string }>('SELECT q.trigger_event AS id FROM send_queue q JOIN trigger_events e ON e.id = q.trigger_event WHERE e.trigger_id = $1', [ruleId])
  return queued.rows.map((r) => r.id)
}

/** 删掉（物理删，触发记录级联）。没有 / 不是自己的 = null。
 *  queued = 它排进排队发送、还没发出去的那几条的触发记录 id，调用方交给 SendQueue 一起拿掉：send_queue.trigger_event 不挂外键，
 *  记录删了排队项还在，不拿掉的话定时器删了那条指令照样会写进任务页开跑 */
export async function deleteTimer(pool: Pool, scope: TimerScope, id: string): Promise<{ name: string; queued: string[] } | null> {
  return withTransaction(pool, async (db) => {
    const cur = (await db.query<RuleRow>(`${SELECT_TIMER} AND t.id = $3 FOR UPDATE OF t`, [scope.ownerId, scope.home ?? null, id])).rows[0]
    if (!cur) return null
    const queued = await queuedOf(db, id)
    await db.query('DELETE FROM agent_triggers WHERE id = $1', [id])
    return { name: cur.name, queued }
  })
}
