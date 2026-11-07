// ---------- 触发器的时钟与派发（规则 = 触发 + 一串动作） ----------
// 一条流程，定时器与以后的事件源（评论、页面变动、webhook……）都走它，不另写：
//   到点 / 事件来了 → 先落一条触发记录（dedup_key 唯一：同一预定时刻 / 同一事件并发、重复扫描只记一次）→ 事务外派发：
//   按规则（只读 actions）一个个跑动作，每个动作执行前按主人此刻的身份重判（run-actions.ts / 下面的「叫 agent」）；
//   有一个失败就停，记录失败并写明第几个动作。结局写回记录：送达 / 跳过 / 失败 + 原因；连续 3 次失败自动暂停；
//   失败进收件箱（inbox.ts 的 timer_failed）。
//   派发前依次判：时间表 / 动作认得出 → 没暂停 → 连锁深度没到上限 → 每日上限（含 AI 的与只含确定性动作的分开数）→
//   判断层（以后的语义过滤插在这里，定时器不经过它）→ 跑动作。不要把派发写进认领的事务。
// 「叫 agent」走排队发送（权限重判、忙时排队、撤回、广播都现成）：排进去之后记录停在 queued，开跑了（排队观察者 delivered）
//   才接着跑后面的动作；记录里 results 的长度就是下一个要跑的动作，崩在中间的重启后从那里接着跑。
//   触发者不是主人（别人的评论、外部请求）时，开跑前先在目标页弹审批（也进收件箱），主人批了才排进去。
// 防循环：动作改过的页面记 10 秒（touched），这期间那一页上再来的事件深度 +1（causedBy），到 3 层跳过。
// 时钟：一个 setTimeout，睡到最早的 next_at（定时器的下次、盯页面的预计汇报），最多 60 秒（兜住时钟漂移与别处改库）；tick 串行，进行中又来就跑完再跑一次。
// 盯页面复用这套认领：到点的规则在认领事务里交给 watch.close（收走攒着的改动、算摘要），落一条外来的事件记录，之后同一条流程。
// 停机错过的：恢复后每个过期的定时器只补触发一次（认领时下次从「现在」往后排，中间跨过的全部丢弃），通知里注明本应几点。
// now 可注入（测试）：认领、迟到判断、24 小时上限、30 天清理、连锁窗口都用它，不用库里的 now()。

import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type * as Y from 'yjs'
import { withTransaction } from '../db.js'
import type { DocWriter } from '../collab.js'
import { agentNames, type AgentNameHost } from '../agents/agent-names.js'
import { isAssistantPage } from '../agents/assistant-agent.js'
import type { OwnApprovals } from '../agents/own-approvals.js'
import { AGENT_UNAVAILABLE } from '../agents/queue-host.js'
import type { QueueHost, QueueObserver, SendQueue } from '../agents/send-queue.js'
import type { TaskWatch } from '../agents/task-watch.js'
import type { Projector } from '../collections/projector.js'
import type { SafeFetch } from '../endpoint-guard.js'
import type { PageWatch } from './sources/page-watch.js'
import { GENET_PAGE_TARGET, isGenetPage } from './action-check.js'
import { actionReason, hasAi, parseActions, type Action } from './actions.js'
import { cleanPayload, eventCause, type EventPayload, type TriggerSource } from './payload.js'
import { ActionRunner, type ActionOutcome, type RunEvent } from './run-actions.js'
import { nextAt, parseSchedule, type Schedule } from './schedule.js'
import { RULE_LIMITS, TIMER_LIMITS } from './store.js'
import { expand, templateVars, type TemplateVars } from './template.js'

/** 一次认领最多这么多条；满了就接着再认领一批 */
const CLAIM_BATCH = 50
const MAX_SLEEP_MS = 60_000
/** 最短也睡这么久：到期的行被别的事务锁着时，不至于空转 */
const MIN_SLEEP_MS = 1000
/** 崩在落记录与派发之间的：这么久之内的重启后补发，更早的算错过 */
const RECOVER_PENDING_MS = 60 * 60_000
const RETENTION_MS = 30 * 24 * 60 * 60_000
const PRUNE_EVERY_MS = 60 * 60_000
const DAY_MS = 24 * 60 * 60_000
const REASON_MAX = 500
/** 动作改过的页面记这么久：投影器去抖、正文存盘都是异步的，调用链上下文传不过去，按「最近被自动化改过」认连锁 */
const CHAIN_WINDOW_MS = 10_000
/** 连锁到这么深就跳过 */
export const CHAIN_MAX_DEPTH = 3
/** 「叫 agent」的目标页进了回收站 */
export const PAGE_GONE = '目标页已经不在了（进了回收站）'

export type TriggerHubDeps = {
  pool: Pool
  now?: () => Date
  queue: Pick<SendQueue, 'enqueue' | 'discardTriggered'>
  host: Pick<QueueHost, 'writable' | 'usable' | 'running'>
  /** agent 的显示名（agents/agent-names.ts）：回报抬头、审批卡、失败原因里写的 agent 名 */
  names: AgentNameHost
  /** 任务回报：目标在 Genet 名下时开跑前登记回报；notify = 往 Genet 页写通知 + 叫醒（与任务回报同一条链） */
  tasks: Pick<TaskWatch, 'arm' | 'disarm' | 'notify'>
  /** 收件箱 / AI 页刷新（不带内容的 'inbox' 信号） */
  poke(): void
  /** 以下测试桩可以不给：不给的那几种动作执行时失败 */
  /** 外来事件叫 agent 之前的审批（Ramet 自己的审批，弹在目标页、进收件箱） */
  approvals?: Pick<OwnApprovals, 'decide'>
  write?: DocWriter
  getLiveDoc?: (docName: string) => Y.Doc | undefined
  projector?: Pick<Projector, 'flushRow'>
  /** 向外 webhook 的防护版 fetch */
  fetch?: SafeFetch
  /** 页面列表变了（动作新建了页 / 行） */
  pagesChanged?(): void
  /** 动作在合集里建了行：交给「新增了一行」 */
  rowsAdded?(parentId: string, rowIds: readonly string[], actorId: string): void
  /** 刷新 AI 块的动作（ai-gen.ts）：返回失败原因，成功 = null */
  aiGen?(user: { id: string; role: string }, pageId: string, blockId: string): Promise<string | null>
  /** 填 AI 属性的动作（ai-prop.ts）：返回失败原因，成功 = null */
  aiProp?(user: { id: string; role: string }, collectionId: string, propId: string, rowId: string): Promise<string | null>
  /** 盯页面：到点的规则收窗口、算摘要（sources/page-watch.ts）。不给 = 到点的盯页面规则只清掉 next_at */
  watch?: Pick<PageWatch, 'close'>
}

/** 事件源（以后的评论、页面变动…）交来的一个事件；每条匹配的规则各落一条记录 */
export type EmitInput = {
  source: Exclude<TriggerSource, 'timer'>
  /** 事件自己的幂等键（如 comment:<评论 id>）；记录的 dedup_key = `${key}:${规则 id}` */
  key: string
  /** 触发者；null = 外部 */
  actorId: string | null
  /** 触发者不是规则主人：缺省按 actorId 判（外部来的没有 actorId，来源自己传 true） */
  external?: boolean
  payload: Omit<EventPayload, 'source'>
  /** 连锁深度：来源用 causedBy(事件所在页) 得到 */
  depth?: number
  /** 只找挂在这一页上的规则 */
  scopePage?: string
  /** 只找这个人的规则 */
  ownerId?: string
  /** 来源自己的过滤（config 里的条件；actions 给「这条规则此刻能不能生效」这类判断用） */
  match?(rule: { id: string; ownerId: string; config: unknown; actions: unknown }): boolean
}

type Due = { id: string; owner_id: string; source: TriggerSource; spec: unknown; config: unknown; time_zone: string; next_at: Date; actions: unknown }

type Result = { type: string; status: 'done' | 'failed' | 'skipped' | 'queued' | 'waiting'; reason: string }

type EventRow = {
  id: string
  owner_id: string
  scheduled_at: Date
  status: string
  payload: unknown
  external: boolean
  depth: number
  results: Result[]
  ai: boolean
  role: string
  trigger_id: string
  name: string
  source: TriggerSource
  spec: unknown
  time_zone: string
  enabled: boolean
  actions: unknown
  space_id: string
  scope_page: string | null
}

/** 有时钟的来源：定时器（下次）、盯页面（预计汇报）；别的来源 next_at 恒为空，这里再按 source 限定一次 */
const CLOCKED = `source IN ('timer', 'page_watch')`
/** 认领到期的 */
const SELECT_DUE = `SELECT id, owner_id, source, spec, config, time_zone, next_at, actions FROM agent_triggers
  WHERE ${CLOCKED} AND enabled AND next_at IS NOT NULL AND next_at <= $1 ORDER BY next_at LIMIT ${CLAIM_BATCH} FOR UPDATE SKIP LOCKED`
const INSERT_EVENT = `INSERT INTO trigger_events (id, trigger_id, owner_id, dedup_key, scheduled_at, created_at, status, ai, payload, actor_id, external, depth)
  VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8::jsonb, $9, $10, $11) ON CONFLICT (dedup_key) DO NOTHING RETURNING id`
const SELECT_EVENT = `SELECT e.id, e.owner_id, e.scheduled_at, e.status, e.payload, e.external, e.depth, e.results, e.ai, u.role,
    t.id AS trigger_id, t.name, t.source, t.spec, t.time_zone, t.enabled, t.actions, t.space_id, t.scope_page
  FROM trigger_events e JOIN agent_triggers t ON t.id = e.trigger_id JOIN users u ON u.id = e.owner_id WHERE e.id = $1`
const SETTLE = `UPDATE trigger_events SET status = $2, reason = $3, settled_at = $4 WHERE id = $1 AND status IN ('pending', 'queued') RETURNING trigger_id`
const SAVE_RESULTS = `UPDATE trigger_events SET results = $2::jsonb, status = COALESCE($3, status) WHERE id = $1 AND status IN ('pending', 'queued')`
// 右边的 fail_streak 都是改之前的值
const COUNT_FAIL = `UPDATE agent_triggers SET fail_streak = fail_streak + 1,
    enabled = CASE WHEN fail_streak + 1 >= $2 THEN false ELSE enabled END,
    next_at = CASE WHEN fail_streak + 1 >= $2 THEN NULL ELSE next_at END,
    paused_reason = CASE WHEN fail_streak + 1 >= $2 THEN $3 ELSE paused_reason END,
    updated_at = now()
  WHERE id = $1`
/** 这条规则排在这一页上、还没发出去的指令 */
const SELECT_IN_QUEUE = `SELECT q.trigger_event AS event FROM send_queue q JOIN trigger_events e ON e.id = q.trigger_event WHERE e.trigger_id = $1 AND q.page_id = $2`
const COUNT_USED = `SELECT count(*)::int AS n FROM trigger_events WHERE owner_id = $1 AND ai = $2 AND status IN ('delivered', 'queued') AND created_at > $3`

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class TriggerHub {
  readonly now: () => Date
  /** 接到 SendQueue.observe 上：「叫 agent」的排队项离开队列时把结局写回触发记录、开跑了就接着跑后面的动作 */
  readonly queueObserver: QueueObserver
  private runner: ActionRunner
  private timer: NodeJS.Timeout | null = null
  private pass: Promise<void> | null = null
  private again = false
  private disposed = false
  private lastPrune = 0
  /** 排时钟的序号：并发的两次只认最后一次 */
  private seq = 0
  /** 动作改过的页面 → 那次触发的深度、记到什么时候 */
  private recent = new Map<string, { depth: number; until: number }>()
  /** 停在审批上的「规则:页面」→ 那条记录与收回那张卡的开关：同一规则在同一页上再来一次就跳过，不叠审批卡；规则删了卡跟着收回 */
  private waiting = new Map<string, { eventId: string; cancel: AbortController }>()
  /** 不在 tick 里的活（开跑后接着跑的动作、等审批的）：dispose 先中止审批再等它们 */
  private inflight = new Set<Promise<void>>()

  constructor(private deps: TriggerHubDeps) {
    this.now = deps.now ?? (() => new Date())
    this.runner = new ActionRunner({
      pool: deps.pool,
      now: this.now,
      notify: deps.tasks.notify,
      ...(deps.write ? { write: deps.write } : {}),
      ...(deps.getLiveDoc ? { getLiveDoc: deps.getLiveDoc } : {}),
      ...(deps.projector ? { projector: deps.projector } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.pagesChanged ? { pagesChanged: deps.pagesChanged } : {}),
      ...(deps.rowsAdded ? { rowsAdded: deps.rowsAdded } : {}),
      ...(deps.aiGen ? { aiGen: deps.aiGen } : {}),
      ...(deps.aiProp ? { aiProp: deps.aiProp } : {}),
      poke: deps.poke,
      touched: (pageId, depth) => this.touched(pageId, depth),
    })
    this.queueObserver = {
      beforeStart: (item) => this.arm(item.pageId, item.userId, item.agent),
      delivered: async (item) => this.detach(this.proceed(item.triggerEvent)),
      dropped: async (item, reason, armed) => {
        if (armed) await this.deps.tasks.disarm(item.pageId)
        await this.endQueued(item.triggerEvent, 'failed', reason)
      },
      withdrawn: (item) => this.endQueued(item.triggerEvent, 'skipped', '排队的指令被撤回了'),
    }
  }

  /** 监听成功后调：先收拾上次停机留下的记录，再排第一次 */
  start(): void {
    void this.recover()
      .catch((err: unknown) => console.error(`[triggers] 启动恢复失败：${errText(err)}`))
      .finally(() => void this.tick())
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const w of this.waiting.values()) w.cancel.abort()
    await this.pass?.catch(() => undefined)
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight])
  }

  /** 规则增删改了：重排时钟，AI 页 / 收件箱重拉 */
  changed(): void {
    this.deps.poke()
    void this.schedule()
  }

  /** 规则删掉了：它排着还没发出去的指令一起拿掉（queued = 删之前查出的触发记录），再同 changed */
  async removed(queued: readonly string[]): Promise<void> {
    // 规则已经删掉了：这里失败不能让删除的请求报错
    await this.deps.queue.discardTriggered(queued).catch((err: unknown) => console.error(`[triggers] 拿掉排队的指令失败：${errText(err)}`))
    await this.dropOrphanCards().catch((err: unknown) => console.error(`[triggers] 收回审批卡失败：${errText(err)}`))
    this.changed()
  }

  /** 停在审批上、记录已经随规则级联删掉的：卡留着点了也没处落结局，收回 */
  private async dropOrphanCards(): Promise<void> {
    if (this.waiting.size === 0) return
    const ids = [...this.waiting.values()].map((w) => w.eventId)
    const { rows } = await this.deps.pool.query<{ id: string }>('SELECT id FROM trigger_events WHERE id = ANY($1::text[])', [ids])
    const alive = new Set(rows.map((r) => r.id))
    for (const w of this.waiting.values()) if (!alive.has(w.eventId)) w.cancel.abort()
  }

  /** 这一页上来的事件的连锁深度：最近 10 秒被动作改过 = 那次的深度 + 1，否则 0（不是自动化引起的） */
  causedBy(pageId: string): number {
    const r = this.recent.get(pageId)
    return r && r.until > this.now().getTime() ? r.depth + 1 : 0
  }

  /** 事件源的入口：找这个来源启用中的规则，每条落一条记录再派发（同定时器的流程）。返回落下的记录 id */
  async emit(e: EmitInput): Promise<string[]> {
    const now = this.now()
    const { rows } = await this.deps.pool.query<{ id: string; owner_id: string; config: unknown; actions: unknown }>(
      `SELECT id, owner_id, config, actions FROM agent_triggers WHERE source = $1 AND enabled
         AND ($2::text IS NULL OR scope_page = $2) AND ($3::text IS NULL OR owner_id = $3) ORDER BY created_at, id`,
      [e.source, e.scopePage ?? null, e.ownerId ?? null],
    )
    const payload = cleanPayload({ ...e.payload, source: e.source }, e.source)
    const ids: string[] = []
    for (const r of rows) {
      if (e.match && !e.match({ id: r.id, ownerId: r.owner_id, config: r.config, actions: r.actions })) continue
      const parsed = parseActions(r.actions)
      const external = e.external ?? (e.actorId !== null && e.actorId !== r.owner_id)
      const ins = await this.deps.pool.query<{ id: string }>(INSERT_EVENT, [
        randomUUID(), r.id, r.owner_id, `${e.key}:${r.id}`, now, now, 'error' in parsed || hasAi(parsed), JSON.stringify(payload), e.actorId, external, e.depth ?? 0,
      ])
      if (ins.rows[0]) ids.push(ins.rows[0].id)
    }
    if (ids.length > 0) this.deps.poke()
    for (const id of ids) await this.deliverOrFail(id)
    return ids
  }

  /** 来源热路径上交来的活（评论写入之后、正文存盘之后的扫描与 emit）：调用方不等它（emit 要跑完动作），出错只记日志；
   *  关停时 dispose 等它们做完（它们会写文档，得在 hocuspocus 关掉之前）。已经在关停就不再接 */
  background(work: () => Promise<unknown>): void {
    if (this.disposed) return
    this.detach(
      Promise.resolve()
        .then(work)
        .then(() => undefined),
      '事件来源',
    )
  }

  /** 认领到期的并派发。返回的 promise 覆盖调用之后开始的一整趟（进行中再来就跑完再跑一次） */
  tick(): Promise<void> {
    if (this.pass) {
      this.again = true
      return this.pass
    }
    const pass = (async () => {
      try {
        do {
          this.again = false
          await this.runOnce()
        } while (this.again && !this.disposed)
      } finally {
        this.pass = null
        void this.schedule()
      }
    })()
    this.pass = pass
    return pass
  }

  private async runOnce(): Promise<void> {
    try {
      const now = this.now()
      await this.prune(now)
      const claimed = await this.claim(now)
      if (claimed.length > 0) this.deps.poke()
      for (const id of claimed) {
        await this.deliverOrFail(id)
      }
      if (claimed.length >= CLAIM_BATCH) this.again = true
    } catch (err) {
      console.error(`[triggers] 扫描失败：${errText(err)}`)
    }
  }

  /** 认领：同一个事务里把下次排好、落一条 pending 记录。行锁 + SKIP LOCKED 挡并发的扫描，dedup_key 挡重复的记录 */
  private claim(now: Date): Promise<string[]> {
    return withTransaction(this.deps.pool, async (db) => {
      const out: string[] = []
      for (const r of (await db.query<Due>(SELECT_DUE, [now])).rows) {
        if (r.source === 'page_watch') {
          const id = await this.claimWatch(db, r, now)
          if (id) out.push(id)
          continue
        }
        const s = parseSchedule(r.spec)
        if ('error' in s) {
          await db.query("UPDATE agent_triggers SET enabled = false, next_at = NULL, paused_reason = '时间表认不出来', updated_at = now() WHERE id = $1", [r.id])
          continue
        }
        const scheduled = r.next_at
        // 错过的不连补：下次从「现在」与这次预定时刻里晚的那个往后排，中间跨过的全丢掉
        const once = s.kind === 'once'
        const next = once ? null : nextAt(s, r.time_zone, new Date(Math.max(now.getTime(), scheduled.getTime())), scheduled)
        await db.query('UPDATE agent_triggers SET next_at = $2, enabled = $3, updated_at = now() WHERE id = $1', [r.id, next, !once && next !== null])
        const key = `timer:${r.id}:${scheduled.toISOString()}`
        const parsed = parseActions(r.actions)
        const ai = 'error' in parsed || hasAi(parsed)
        const ins = await db.query<{ id: string }>(INSERT_EVENT, [randomUUID(), r.id, r.owner_id, key, scheduled, now, ai, '{}', null, false, 0])
        if (ins.rows[0]) out.push(ins.rows[0].id)
      }
      return out
    })
  }

  /** 盯页面到点：收窗口、算摘要，落一条外来的事件记录（触发者 = 最后动手的别人）；什么都没变 = 不落 */
  private async claimWatch(db: PoolClient, r: Due, now: Date): Promise<string | null> {
    const fired = this.deps.watch ? await this.deps.watch.close(db, r, now) : null
    if (!fired) {
      await db.query('UPDATE agent_triggers SET next_at = NULL WHERE id = $1', [r.id])
      return null
    }
    const parsed = parseActions(r.actions)
    const payload = cleanPayload({ ...fired.payload, source: 'page_watch' }, 'page_watch')
    const ins = await db.query<{ id: string }>(INSERT_EVENT, [
      randomUUID(), r.id, r.owner_id, `${fired.key}:${r.id}`, r.next_at, now, 'error' in parsed || hasAi(parsed), JSON.stringify(payload), fired.actorId, true, fired.depth,
    ])
    return ins.rows[0]?.id ?? null
  }

  /** 派发抛错（写文档失败、库连不上……）也要落个结局：不然记录一直停在 pending，列表上永远是「正在触发」，也不进收件箱 */
  private async deliverOrFail(eventId: string): Promise<void> {
    try {
      await this.deliver(eventId)
    } catch (err) {
      console.error(`[triggers] 派发 ${eventId} 失败：${errText(err)}`)
      await this.settle(eventId, 'failed', `派发出错：${errText(err)}`).catch(() => undefined)
    }
  }

  private load(eventId: string): Promise<EventRow | undefined> {
    return this.deps.pool.query<EventRow>(SELECT_EVENT, [eventId]).then((r) => r.rows[0])
  }

  /** 派发一条记录（事务外）。崩在动作串中间的（重启补发）从没跑的那个动作接着跑 */
  private async deliver(eventId: string): Promise<void> {
    const ev = await this.load(eventId)
    if (!ev || ev.status !== 'pending') return
    let schedule: Schedule | null = null
    if (ev.source === 'timer') {
      const s = parseSchedule(ev.spec)
      if ('error' in s) return this.settle(ev.id, 'failed', '时间表认不出来')
      schedule = s
      // 恢复时补发的：这期间被暂停了就不发（一次性的在认领时就关掉了，那不是暂停）
      if (!ev.enabled && s.kind !== 'once') return this.settle(ev.id, 'skipped', '定时器已经暂停了')
    } else if (!ev.enabled) return this.settle(ev.id, 'skipped', '规则已经暂停了')
    const actions = parseActions(ev.actions)
    if ('error' in actions) return this.settle(ev.id, 'failed', `动作认不出来：${actions.error}`)
    if (ev.depth >= CHAIN_MAX_DEPTH) return this.settle(ev.id, 'skipped', '自动化连锁太深')
    const limit = ev.ai ? TIMER_LIMITS.daily : RULE_LIMITS.dailyPlain
    const since = new Date(this.now().getTime() - DAY_MS)
    const used = (await this.deps.pool.query<{ n: number }>(COUNT_USED, [ev.owner_id, ev.ai, since])).rows[0]?.n ?? 0
    if (used >= limit) {
      return this.settle(ev.id, 'skipped', ev.ai ? `24 小时内已经触发了 ${limit} 次，这次跳过` : `24 小时内已经执行了 ${limit} 次（不含 AI 的规则），这次跳过`)
    }
    // 判断层（以后的语义过滤）插在这里
    await this.runFrom(ev, schedule, actions, ev.results.length)
  }

  private runEvent(ev: EventRow, schedule: Schedule | null): RunEvent {
    return {
      id: ev.id,
      owner: { id: ev.owner_id, role: ev.role },
      ruleId: ev.trigger_id,
      ruleName: ev.name,
      source: ev.source,
      spaceId: ev.space_id,
      scopePage: ev.scope_page,
      timeZone: ev.time_zone,
      schedule,
      scheduledAt: ev.scheduled_at,
      payload: cleanPayload(ev.payload, ev.source),
      external: ev.external,
      depth: ev.depth,
    }
  }

  /** 从第 start 个动作往后跑；遇到「叫 agent」排进队就停在那里（开跑后 proceed 接着跑），失败 / 跳过就收尾 */
  private async runFrom(row: EventRow, schedule: Schedule | null, actions: Action[], start: number): Promise<void> {
    const ev = this.runEvent(row, schedule)
    const vars = templateVars(ev.payload, ev.ruleName, this.now(), ev.timeZone)
    const results = row.results.slice(0, start)
    for (let i = start; i < actions.length; i++) {
      const action = actions[i]!
      let out: ActionOutcome
      try {
        out = action.type === 'agent' ? await this.agent(ev, actions, results, i, action, vars) : await this.runner.run(action, ev, vars)
      } catch (err) {
        out = { status: 'failed', reason: `出错了：${errText(err)}` }
      }
      if (out.status === 'queued') return
      results[i] = { type: action.type, status: out.status, reason: out.reason }
      await this.deps.pool.query(SAVE_RESULTS, [ev.id, JSON.stringify(results), null])
      if (out.status !== 'done') return this.settle(ev.id, out.status, actionReason(actions, i, out.reason))
    }
    await this.settle(ev.id, 'delivered', '')
  }

  // ---------- 叫 agent ----------

  /** 目标页、写权限、agent 可用（排进队之前判；等完审批再判一次）。能跑 = null */
  private async agentRefusal(ev: RunEvent, action: Extract<Action, { type: 'agent' }>): Promise<string | null> {
    const page = (await this.deps.pool.query("SELECT 1 FROM live_pages WHERE id = $1 AND kind = 'doc'", [action.page])).rowCount
    if (!page) return PAGE_GONE
    // 保存时就拦了（action-check.ts）；这里兜不经保存入口写进库里的规则
    if (await isGenetPage(this.deps.pool, action.page)) return GENET_PAGE_TARGET
    if (!(await this.deps.host.writable(action.page, ev.owner))) return '你已经不能编辑目标页了'
    const unusable = await this.deps.host.usable(action.page, ev.owner, action.agent)
    if (!unusable) return null
    return unusable === AGENT_UNAVAILABLE ? `${(await this.label(action.agent)) || action.agent} 现在用不了：它所在的机器不在线，或者已经没有这个 agent` : unusable
  }

  private async agent(ev: RunEvent, actions: Action[], results: Result[], i: number, action: Extract<Action, { type: 'agent' }>, vars: TemplateVars): Promise<ActionOutcome> {
    const refused = await this.agentRefusal(ev, action)
    if (refused) return { status: 'failed', reason: refused }
    // 上一次的指令还排着：任务页在跑 = 它会排在这一轮后面发出去，这次不堆积。
    // 任务页空着 = 那条卡住了（队列因上一轮出错 / 被停而暂停，或重启丢了内存里的暂停态，都没有下一次结束来派发它），
    // 不顶替的话之后每次到点都被它挡成跳过，规则悄悄停摆；用这一次顶替它，空页上 enqueue 当场派发
    const stale = (await this.deps.pool.query<{ event: string }>(SELECT_IN_QUEUE, [ev.ruleId, action.page])).rows.map((r) => r.event)
    if (stale.length > 0) {
      if (this.deps.host.running(action.page)) return { status: 'skipped', reason: '上一次的指令还排着没发出去' }
      await this.deps.queue.discardTriggered(stale)
      for (const old of stale) await this.endQueued(old, 'skipped', '一直没发出去，被下一次顶替了')
    }
    if (!ev.external) return this.enqueue(ev, actions, results, i, action, vars)
    // 外来事件：主人批了才开跑。等审批期间记录停在 queued（不超时）；同一规则同一页已经有一张卡就不再叠
    const key = `${ev.ruleId}:${action.page}`
    if (this.waiting.has(key)) return { status: 'skipped', reason: '上一次的审批还没处理' }
    const approvals = this.deps.approvals
    if (!approvals) return { status: 'failed', reason: '没法弹出审批，不能替外来的事件开跑' }
    results[i] = { type: 'agent', status: 'waiting', reason: '' }
    await this.deps.pool.query(SAVE_RESULTS, [ev.id, JSON.stringify(results), 'queued'])
    const cancel = new AbortController()
    // 已经在关停（dispose 收过这些卡了）：不再挂一张等不到人的卡，不然 dispose 一直等它
    if (this.disposed) cancel.abort()
    this.waiting.set(key, { eventId: ev.id, cancel })
    this.detach(this.approve(approvals, ev, actions, results, i, action, vars, cancel.signal).finally(() => this.waiting.delete(key)))
    return { status: 'queued' }
  }

  private async approve(
    approvals: Pick<OwnApprovals, 'decide'>,
    ev: RunEvent,
    actions: Action[],
    results: Result[],
    i: number,
    action: Extract<Action, { type: 'agent' }>,
    vars: TemplateVars,
    signal: AbortSignal,
  ): Promise<void> {
    const label = (await this.label(action.agent)) || action.agent
    const title = (await this.deps.pool.query<{ title: string }>('SELECT title FROM pages WHERE id = $1', [action.page])).rows[0]?.title || '无标题'
    const instruction = expand(action.instruction, vars)
    const decision = await approvals.decide(
      { pageId: action.page, agentId: action.agent },
      {
        title: `规则「${ev.ruleName}」想让 ${label} 在《${title}》干活（起因：${eventCause(ev.payload)}）`,
        toolCall: { kind: 'other', title: '自动化', content: [{ type: 'content', content: { type: 'text', text: instruction } }] },
        labels: { allow: '开跑', reject: '不跑' },
        // 开跑是以主人的身份、用主人的机器：卡只给主人看、只认主人答（目标页上别的编辑者看不到也点不了）；
        // 它不属于这一页上的哪一轮，别人停掉这一页上的运行不该替主人把它拒了
        only: ev.owner.id,
        detached: true,
      },
      signal,
    )
    // 服务要关了：记录留在 queued，重启时的恢复把它收成失败
    if (this.disposed) return
    // 等的这段时间规则删了（记录级联没了）/ 记录已经有了结局：不再开跑
    const cur = await this.load(ev.id)
    if (!cur || cur.status !== 'queued') return
    const reason = !decision.allowed ? '用户没同意' : decision.by !== ev.owner.id ? '只有规则的主人能批准' : await this.agentRefusal(ev, action)
    if (!reason) {
      await this.enqueue(ev, actions, results, i, action, vars)
      return
    }
    results[i] = { type: 'agent', status: 'failed', reason }
    await this.deps.pool.query(SAVE_RESULTS, [ev.id, JSON.stringify(results), null])
    await this.settle(ev.id, 'failed', actionReason(actions, i, reason))
  }

  /** 先置 queued 再入队：页面空着时 enqueue 当场派发，观察者会在它返回之前把这一步记成开跑了 */
  private async enqueue(ev: RunEvent, actions: Action[], results: Result[], i: number, action: Extract<Action, { type: 'agent' }>, vars: TemplateVars): Promise<ActionOutcome> {
    results[i] = { type: 'agent', status: 'queued', reason: '' }
    await this.deps.pool.query(SAVE_RESULTS, [ev.id, JSON.stringify(results), 'queued'])
    this.touched(action.page, ev.depth)
    try {
      await this.deps.queue.enqueue(action.page, ev.owner, { agent: action.agent, kind: 'message', text: expand(action.instruction, vars), images: [], triggerEvent: ev.id })
    } catch (err) {
      results[i] = { type: 'agent', status: 'failed', reason: `排不进去：${errText(err)}` }
      await this.deps.pool.query(SAVE_RESULTS, [ev.id, JSON.stringify(results), null])
      await this.settle(ev.id, 'failed', actionReason(actions, i, `排不进去：${errText(err)}`))
    }
    return { status: 'queued' }
  }

  /** 排进队的那一步开跑了：记成做完，后面还有动作就接着跑（记录回到 pending：崩在中间的，重启后从下一个动作接着跑） */
  private async proceed(eventId: string): Promise<void> {
    const row = await this.load(eventId)
    if (!row || row.status !== 'queued') return
    const at = row.results.findLastIndex((r) => r.status === 'queued')
    const actions = parseActions(row.actions)
    if (at < 0 || 'error' in actions) return this.settle(row.id, 'delivered', '')
    const results = [...row.results]
    results[at] = { type: 'agent', status: 'done', reason: '' }
    if (at + 1 >= actions.length) {
      await this.deps.pool.query(SAVE_RESULTS, [row.id, JSON.stringify(results), null])
      return this.settle(row.id, 'delivered', '')
    }
    await this.deps.pool.query(SAVE_RESULTS, [row.id, JSON.stringify(results), 'pending'])
    const schedule = row.source === 'timer' ? parseSchedule(row.spec) : null
    await this.runFrom({ ...row, results }, schedule && !('error' in schedule) ? schedule : null, actions, at + 1)
  }

  /** 排着的那一步被丢掉 / 撤回：记下这一步的结局，整条记录收尾（失败原因带上是第几个动作） */
  private async endQueued(eventId: string, status: 'failed' | 'skipped', reason: string): Promise<void> {
    const row = await this.load(eventId)
    const actions = row ? parseActions(row.actions) : null
    const at = row ? row.results.findLastIndex((r) => r.status === 'queued') : -1
    if (!row || !actions || 'error' in actions || at < 0) return this.settle(eventId, status, reason)
    const results = [...row.results]
    results[at] = { type: 'agent', status, reason }
    await this.deps.pool.query(SAVE_RESULTS, [row.id, JSON.stringify(results), null])
    await this.settle(row.id, status, actionReason(actions, at, reason))
  }

  /** agent 的显示名，写法同派活记下的（/api/agents 的 label：connector 上的是「机器 · 名字」）；认不出 = 空 */
  private async label(agent: string): Promise<string> {
    const n = (await agentNames(this.deps.pool, this.deps.names, [agent])).get(agent)
    return n ? (n.machine ? `${n.machine} · ${n.label}` : n.label) : ''
  }

  /** 页上的指令开跑之前：页在主人的 Genet 名下就登记「这一轮做完回报 Genet」（同派活）。显示名认不出就给空，arm 沿用原来记下的 */
  private async arm(pageId: string, userId: string, agent: string): Promise<void> {
    const home = (await this.deps.pool.query<{ parent_id: string | null }>('SELECT parent_id FROM live_pages WHERE id = $1', [pageId])).rows[0]?.parent_id
    if (home && (await isAssistantPage(this.deps.pool, userId, home))) {
      await this.deps.tasks.arm({ pageId, homeId: home, userId, agent, label: await this.label(agent) })
    }
  }

  /** 动作改了这一页（深度 depth）：之后 10 秒内这一页上来的事件算它引起的（causedBy） */
  touched(pageId: string, depth: number): void {
    const now = this.now().getTime()
    if (this.recent.size > 1000) for (const [id, r] of this.recent) if (r.until <= now) this.recent.delete(id)
    this.recent.set(pageId, { depth, until: now + CHAIN_WINDOW_MS })
  }

  /** 不在调用方等待里的活：出错只记日志，dispose 等它们 */
  private detach(task: Promise<void>, what = '接着跑动作'): void {
    const tracked = task.catch((err: unknown) => console.error(`[triggers] ${what}失败：${errText(err)}`))
    this.inflight.add(tracked)
    void tracked.finally(() => this.inflight.delete(tracked))
  }

  /** 结局写回记录（只有还没结局的才写）；失败计数，连续失败到上限自动暂停 */
  private async settle(eventId: string, status: 'delivered' | 'skipped' | 'failed', reason: string): Promise<void> {
    const now = this.now()
    const text = reason.slice(0, REASON_MAX)
    await withTransaction(this.deps.pool, async (db) => {
      const row = (await db.query<{ trigger_id: string }>(SETTLE, [eventId, status, text, now])).rows[0]
      if (!row) return
      if (status === 'delivered') await db.query('UPDATE agent_triggers SET fail_streak = 0 WHERE id = $1', [row.trigger_id])
      if (status === 'failed') {
        const paused = `连续 ${TIMER_LIMITS.failStreak} 次没能触发，已自动暂停：${text}`
        await db.query(COUNT_FAIL, [row.trigger_id, TIMER_LIMITS.failStreak, paused])
      }
    })
    if (status === 'failed') console.error(`[triggers] 触发记录 ${eventId} 失败：${text}`)
    this.deps.poke()
  }

  /** 上次停机留下的：刚记下没派发的（1 小时内）补发，更早的算错过；进了排队却已经不在队里的收成失败（含等审批时重启的） */
  private async recover(): Promise<void> {
    const now = this.now()
    const pending = await this.deps.pool.query<{ id: string; created_at: Date }>("SELECT id, created_at FROM trigger_events WHERE status = 'pending' ORDER BY created_at")
    for (const r of pending.rows) {
      if (now.getTime() - r.created_at.getTime() <= RECOVER_PENDING_MS) {
        await this.deliverOrFail(r.id)
      } else await this.settle(r.id, 'failed', '服务重启，错过了这次')
    }
    const lost = await this.deps.pool.query<{ id: string; waiting: boolean }>(
      `SELECT e.id, COALESCE(e.results -> -1 ->> 'status' = 'waiting', false) AS waiting FROM trigger_events e
        WHERE e.status = 'queued' AND NOT EXISTS (SELECT 1 FROM send_queue q WHERE q.trigger_event = e.id)`,
    )
    for (const r of lost.rows) {
      await this.settle(r.id, 'failed', r.waiting ? '等你批准的时候服务重启了，这次作废' : '排队的指令丢了（服务重启时它已经不在队里）')
    }
  }

  /** 触发记录、「不用处理」的标记留 30 天 */
  private async prune(now: Date): Promise<void> {
    if (Date.now() - this.lastPrune < PRUNE_EVERY_MS) return
    this.lastPrune = Date.now()
    const before = new Date(now.getTime() - RETENTION_MS)
    await this.deps.pool.query('DELETE FROM trigger_events WHERE created_at < $1', [before])
    await this.deps.pool.query('DELETE FROM quiet_turns WHERE at < $1', [before])
  }

  /** 睡到最早的 next_at（最多 60 秒） */
  private async schedule(): Promise<void> {
    if (this.disposed) return
    const seq = ++this.seq
    let wait = MAX_SLEEP_MS
    try {
      const at = (
        await this.deps.pool.query<{ at: Date | null }>(`SELECT min(next_at) AS at FROM agent_triggers WHERE ${CLOCKED} AND enabled AND next_at IS NOT NULL`)
      ).rows[0]?.at
      if (at) wait = Math.min(Math.max(at.getTime() - this.now().getTime(), MIN_SLEEP_MS), MAX_SLEEP_MS)
    } catch (err) {
      if (!this.disposed) console.error(`[triggers] 排时钟失败：${errText(err)}`)
    }
    if (this.disposed || seq !== this.seq) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, wait)
    this.timer.unref()
  }
}
