// ---------- 规则（自动化）：AI 页「自动」分页的增删改查 ----------
// 一条规则 = 名字 + 触发（来源 + 来源的配置）+ 动作串，以主人的身份执行。定时器也是规则（source = 'timer'，时间表在 spec），
// Genet 设的定时器在这里同样能看、能改动作。来源在 SOURCES 里登记：每个来源说明怎么解析配置、怎么写成一句人话；
// 没登记的来源（合集、按钮…）这里还建不了，由各自的入口建。评论 / 正文提及只有每人一条的内置规则（builtin.ts）：
// 登记了配置怎么解析（能改），但不能在这里新建，也不能删（只能关）、不能改名；列表里排在最前面。
// 校验：名字、来源配置、动作的形状（actions.ts）+ 动作的目标按主人此刻的身份现判（action-check.ts）；不过 400，原因是人话。
// 只有主人能改 / 删自己的规则；挂靠在某一页上的规则（scope_page），那一页的编辑者能看到（只读，GET /api/pages/:id/automations）。

import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type * as Y from 'yjs'
import { myPersonalSpaceId } from '../clone.js'
import { pageAccess } from '../collab.js'
import { withTransaction } from '../db.js'
import { agentNames, type AgentNameHost } from '../agents/agent-names.js'
import { checkActions } from './action-check.js'
import {
  aiState,
  BUILTIN_NO_DELETE,
  BUILTIN_NO_RENAME,
  describeComment,
  describeMention,
  dormantReason,
  ensureBuiltin,
  isBuiltinSource,
  parseCommentConfig,
  parseMentionConfig,
  type AiState,
  type BuiltinSource,
  type Dormant,
} from './builtin.js'
import { describeAction, EVENT_ROW, parseActions, type Action } from './actions.js'
import { isTriggerSource, type TriggerSource } from './payload.js'
import { describeSchedule, localStamp, parseSchedule } from './schedule.js'
import { checkCollectionConfig, describeCollection, parseCollectionConfig, type CollectionConfig } from './sources/collection.js'
import { describeButton, parseButtonConfig } from './sources/button.js'
import { checkWatchPage } from './sources/page-watch.js'
import { describeWatch, parseWatchConfig } from './sources/page-watch-format.js'
import { describeWebhook, HOOK_PREFIX, newHookToken, parseWebhookConfig } from './sources/webhook.js'
import {
  applyPatch,
  checkEnabledLimit,
  clearWatch,
  firstAt,
  legacyColumns,
  queuedOf,
  schedule,
  SELECT_RULE,
  text,
  TIMER_LIMITS,
  TimerError,
  userTimeZone,
  type RulePatch,
  type RuleRow,
  type TriggerStatus,
} from './store.js'

export type ActionResult = { type: string; status: 'done' | 'failed' | 'skipped' | 'queued' | 'waiting'; reason: string }

export type AutomationView = {
  id: string
  name: string
  source: TriggerSource
  /** 来源的配置：定时器 = 时间表（Schedule） */
  config: unknown
  /** 触发的一句话（「每天 09:00」） */
  triggerText: string
  timeZone: string
  nextAt: string | null
  nextText: string
  actions: Action[]
  /** 每个动作的一句话（页面 / agent 写显示名） */
  actionsText: string[]
  enabled: boolean
  pausedReason: string
  /** 挂靠页（合集 / 按钮 / AI 块所在页）；看不到了 title 为「（看不到这一页了）」 */
  scopePage: { id: string; title: string } | null
  /** 最近一次：at = 那次的预定时刻（事件 = 发生时刻）；results = 每个动作的结局 */
  last: { status: TriggerStatus; reason: string; at: string; results: ActionResult[] } | null
  createdAt: string
  /** 内置规则（评论找我 / 正文 @我）：不能删、不能改名；普通规则为 null */
  builtin: BuiltinSource | null
  /** 主人的用户名（挂靠页上给别的编辑者看的：这是谁的规则） */
  ownerName: string
  /** 看的人就是主人（只有主人能改 / 删） */
  mine: boolean
  /** 内置规则此刻还不能生效的原因（code 认补救办法，text「配好模型连接后生效」）：这期间事件来了直接不发；能生效 / 普通规则为 null */
  dormant: Dormant | null
}

/** 来源登记：解析配置（返回存进 spec / config 的值）、写成一句人话；builtinOnly = 只有内置规则，不能在这里新建。
 *  check = 解析之外要查库的校验（建 / 改配置时按主人现判，不行 = 原因）；pages = 配置里提到的页（列表一次查齐标题，describe 的 title 取得到）；
 *  fixedConfig = 配置由服务端写（收到外部请求：地址末 4 位），改规则时不收 config；scoped = 必须挂在某一页上（按钮） */
type SourceSpec = {
  parse(raw: unknown): { spec: unknown; config: unknown } | { error: string }
  describe(row: Pick<RuleRow, 'spec' | 'config'>, title: (pageId: string) => string | null): string
  check?(deps: Pick<RuleDeps, 'pool' | 'getLiveDoc'>, owner: User, config: unknown): Promise<string | null>
  pages?(config: unknown): string[]
  builtinOnly?: true
  fixedConfig?: true
  scoped?: true
}

/** 事件来源的配置存 config，spec 留空对象 */
const asConfig = (c: object): { spec: unknown; config: unknown } | { error: string } => ('error' in c ? (c as { error: string }) : { spec: {}, config: c })

const SOURCES: Partial<Record<TriggerSource, SourceSpec>> = {
  timer: {
    parse: (raw) => {
      const s = parseSchedule(raw)
      return 'error' in s ? s : { spec: s, config: {} }
    },
    describe: (row) => {
      const s = parseSchedule(row.spec)
      return 'error' in s ? '（时间表认不出来）' : describeSchedule(s)
    },
  },
  comment: { parse: (raw) => asConfig(parseCommentConfig(raw)), describe: (row) => describeComment(row.config), builtinOnly: true },
  mention: { parse: (raw) => asConfig(parseMentionConfig(raw)), describe: (row) => describeMention(row.config), builtinOnly: true },
  page_watch: {
    parse: (raw) => asConfig(parseWatchConfig(raw)),
    describe: (row, title) => {
      const c = parseWatchConfig(row.config)
      return describeWatch(row.config, 'error' in c ? null : title(c.page))
    },
    check: (deps, owner, config) => checkWatchPage(deps.pool, owner.id, (config as { page: string }).page),
    pages: (config) => {
      const c = parseWatchConfig(config)
      return 'error' in c ? [] : [c.page]
    },
  },
  webhook: { parse: (raw) => asConfig(parseWebhookConfig(raw)), describe: (row) => describeWebhook(row.config), fixedConfig: true },
  button: { parse: (raw) => asConfig(parseButtonConfig(raw)), describe: (row) => describeButton(row.config), scoped: true },
  collection: {
    parse: (raw) => asConfig(parseCollectionConfig(raw)),
    describe: (row, title) => {
      const c = parseCollectionConfig(row.config)
      return describeCollection(row.config, 'error' in c ? null : title(c.collection))
    },
    check: (deps, owner, config) => checkCollectionConfig(deps, owner, config as CollectionConfig),
    pages: (config) => {
      const c = parseCollectionConfig(config)
      return 'error' in c ? [] : [c.collection]
    },
  },
}

export type RuleDeps = { pool: Pool; names: AgentNameHost; getLiveDoc?: (docName: string) => Y.Doc | undefined }

type User = { id: string; role: string }

function results(raw: unknown): ActionResult[] {
  return Array.isArray(raw) ? (raw as ActionResult[]) : []
}

/** 挂靠页上给别的编辑者看的别人的规则：webhook 地址只留到域名、请求体不给（地址里常带着对方的密钥） */
function forOthers(a: Action): Action {
  if (a.type !== 'webhook') return a
  let origin = ''
  try {
    origin = new URL(a.url).origin
  } catch {
    origin = ''
  }
  return { type: 'webhook', url: `${origin}/…` }
}

/** 一批规则 → 视图；动作摘要里的页面标题与 agent 名一次查齐（页面标题只给看的人 viewerId 看得到的）。
 *  内置规则只有主人自己看得到（不挂靠页面），dormant 按看的人（= 主人）此刻的状态算 */
async function views(deps: RuleDeps, viewerId: string, rows: RuleRow[]): Promise<AutomationView[]> {
  const state: AiState | null = rows.some((r) => r.builtin) ? await aiState(deps.pool, viewerId) : null
  const parsed = rows.map((r) => {
    const p = parseActions(r.actions)
    return 'error' in p || r.owner_id === viewerId ? p : p.map(forOthers)
  })
  const pageIds = new Set<string>()
  const agentIds = new Set<string>()
  for (const r of rows) for (const id of SOURCES[r.source]?.pages?.(r.config) ?? []) pageIds.add(id)
  for (const p of parsed) {
    if ('error' in p) continue
    for (const a of p) {
      if (a.type === 'agent') {
        pageIds.add(a.page)
        agentIds.add(a.agent)
      }
      if (a.type === 'create_page') {
        pageIds.add(a.parent)
        if (a.template) pageIds.add(a.template)
      }
      if (a.type === 'set_props' && a.row !== EVENT_ROW) pageIds.add(a.row)
      if (a.type === 'ai_gen') pageIds.add(a.page)
      if (a.type === 'ai_prop') pageIds.add(a.collection)
    }
  }
  const titles = new Map(
    (
      await deps.pool.query<{ id: string; title: string }>(
        `SELECT p.id, p.title FROM live_pages p WHERE p.id = ANY($1::text[])
           AND EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = p.space_id AND m.user_id = $2)`,
        [[...pageIds], viewerId],
      )
    ).rows.map((r) => [r.id, r.title || '无标题']),
  )
  const names = await agentNames(deps.pool, deps.names, agentIds)
  const owners = new Map(
    (await deps.pool.query<{ id: string; username: string }>('SELECT id, username FROM users WHERE id = ANY($1::text[])', [[...new Set(rows.map((r) => r.owner_id))]])).rows.map(
      (r) => [r.id, r.username],
    ),
  )
  const agentLabel = (id: string): string => {
    const n = names.get(id)
    return n ? (n.machine ? `${n.machine} · ${n.label}` : n.label) : id
  }
  return rows.map((r, i) => {
    const p = parsed[i]!
    const actions = 'error' in p ? [] : p
    return {
      id: r.id,
      name: r.name,
      source: r.source,
      config: r.source === 'timer' ? r.spec : r.config,
      triggerText: SOURCES[r.source]?.describe(r, (id) => titles.get(id) ?? null) ?? r.source,
      timeZone: r.time_zone,
      nextAt: r.next_at?.toISOString() ?? null,
      nextText: r.next_at ? localStamp(r.next_at, r.time_zone) : '',
      actions,
      actionsText: 'error' in p ? [`（动作认不出来：${p.error}）`] : actions.map((a) => describeAction(a, { page: (id) => titles.get(id) ?? '看不到的页', agent: agentLabel })),
      enabled: r.enabled,
      pausedReason: r.paused_reason,
      scopePage: r.scope_page ? { id: r.scope_page, title: r.scope_title === null ? '（看不到这一页了）' : r.scope_title || '无标题' } : null,
      last: r.last_status && r.last_at ? { status: r.last_status, reason: r.last_reason ?? '', at: r.last_at.toISOString(), results: results(r.last_results) } : null,
      createdAt: r.created_at.toISOString(),
      ownerName: owners.get(r.owner_id) ?? '已注销用户',
      mine: r.owner_id === viewerId,
      builtin: isBuiltinSource(r.builtin) ? r.builtin : null,
      dormant: r.builtin && state ? dormantReason(r.actions, state) : null,
    }
  })
}

/** 自己的全部：内置规则在最前（先补齐），其余新的在前 */
export async function listRules(deps: RuleDeps, ownerId: string): Promise<AutomationView[]> {
  await ensureBuiltin(deps.pool, ownerId)
  const { rows } = await deps.pool.query<RuleRow>(
    `${SELECT_RULE} WHERE t.owner_id = $1 ORDER BY t.builtin IS NULL, t.builtin, t.created_at DESC, t.id`,
    [ownerId],
  )
  return views(deps, ownerId, rows)
}

/** 挂在这一页上的规则：那一页的编辑者看得到（只读；改 / 删仍只有主人）。看不到 / 不能编辑这一页 = null */
export async function listScoped(deps: RuleDeps, user: User, pageId: string): Promise<AutomationView[] | null> {
  const role = await pageAccess(deps.pool, pageId, user)
  if (role === null || role === 'viewer') return null
  const { rows } = await deps.pool.query<RuleRow>(`${SELECT_RULE} WHERE t.scope_page = $1 ORDER BY t.created_at DESC, t.id`, [pageId])
  return views(deps, user.id, rows)
}

export async function getRule(deps: RuleDeps, ownerId: string, id: string): Promise<AutomationView | null> {
  const row = (await deps.pool.query<RuleRow>(`${SELECT_RULE} WHERE t.owner_id = $1 AND t.id = $2`, [ownerId, id])).rows[0]
  return row ? ((await views(deps, ownerId, [row]))[0] ?? null) : null
}

function actionsOf(raw: unknown): Action[] {
  const parsed = parseActions(raw)
  if ('error' in parsed) throw new TimerError(400, parsed.error)
  return parsed
}

/** 规则所在空间：挂靠页的 > 第一个带页面的动作所在的 > Genet 页的 > 个人空间。收件箱按它限定成员、发通知按它认收件人 */
async function spaceOf(pool: Pool, owner: User, actions: readonly Action[], scopePage: string | null): Promise<string> {
  const spaceOfPage = async (id: string): Promise<string | null> =>
    (await pool.query<{ space_id: string | null }>('SELECT space_id FROM live_pages WHERE id = $1', [id])).rows[0]?.space_id ?? null
  if (scopePage) {
    const s = await spaceOfPage(scopePage)
    if (!s) throw new TimerError(400, '挂靠的那一页不在了')
    return s
  }
  for (const a of actions) {
    const page =
      a.type === 'agent' || a.type === 'ai_gen'
        ? a.page
        : a.type === 'ai_prop'
          ? a.collection
          : a.type === 'create_page'
            ? a.parent
            : a.type === 'set_props' && a.row !== EVENT_ROW
              ? a.row
              : null
    const s = page ? await spaceOfPage(page) : null
    if (s) return s
  }
  const legacy = await legacyColumns(pool, owner.id, actions)
  const genet = legacy.agent && legacy.target ? await spaceOfPage(legacy.target) : null
  const personal = genet ?? (await myPersonalSpaceId(pool, owner.id))
  if (!personal) throw new TimerError(400, '找不到你的个人空间')
  return personal
}

/** 新建的结果；hookPath = 收到外部请求的地址（/api/hooks/<密钥>），只在这一次给（库里只有哈希），别的来源为 null */
export type Created = { rule: AutomationView; hookPath: string | null }

/** 新建：{ name, source, config, actions, scopePage? } */
export async function createRule(deps: RuleDeps, owner: User, input: Record<string, unknown>, now: Date): Promise<Created> {
  const { pool } = deps
  const name = text(input.name, TIMER_LIMITS.name, '名字')
  const source = input.source ?? 'timer'
  const spec = isTriggerSource(source) ? SOURCES[source] : undefined
  if (!isTriggerSource(source) || !spec || spec.builtinOnly) throw new TimerError(400, '这种触发还不能在这里建')
  const parsedConfig = spec.parse(input.config)
  if ('error' in parsedConfig) throw new TimerError(400, parsedConfig.error)
  const configReason = await spec.check?.(deps, owner, parsedConfig.config)
  if (configReason) throw new TimerError(400, configReason)
  const actions = actionsOf(input.actions)
  const given = typeof input.scopePage === 'string' && input.scopePage ? input.scopePage.replace(/^page:/, '') : null
  // 合集的规则挂在那个合集上（编辑者在合集里看得到）
  const own = source === 'collection' ? (parsedConfig.config as CollectionConfig).collection : null
  if (own && given && given !== own) throw new TimerError(400, '合集的规则只能挂在它自己的合集上')
  const scopePage = own ?? given
  if (spec.scoped && !scopePage) throw new TimerError(400, '按钮的规则要挂在按钮所在的页上')
  if (scopePage) {
    const role = await pageAccess(pool, scopePage, owner)
    if (role === null || role === 'viewer') throw new TimerError(400, '挂靠的那一页不在了，或者你不能编辑它')
  }
  const space = await spaceOf(pool, owner, actions, scopePage)
  const reason = await checkActions({ pool, ...(deps.getLiveDoc ? { getLiveDoc: deps.getLiveDoc } : {}), owner, source, spaceId: space }, actions)
  if (reason) throw new TimerError(400, reason)
  const tz = await userTimeZone(pool, owner.id)
  const next = source === 'timer' ? firstAt(schedule(parsedConfig.spec), tz, now) : null
  const legacy = await legacyColumns(pool, owner.id, actions)
  const id = randomUUID()
  const hook = source === 'webhook' ? newHookToken() : null
  const config = hook ? { hint: hook.hint } : parsedConfig.config
  await withTransaction(pool, async (db) => {
    await checkEnabledLimit(db, owner.id, id, source)
    await db.query(
      `INSERT INTO agent_triggers (id, space_id, owner_id, source, name, instruction, spec, config, time_zone, target_page, agent, next_at, actions, scope_page, hook_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13::jsonb, $14, $15)`,
      [id, space, owner.id, source, name, legacy.instruction, JSON.stringify(parsedConfig.spec), JSON.stringify(config), tz, legacy.target, legacy.agent, next,
        JSON.stringify(actions), scopePage, hook?.hash ?? null],
    )
  })
  return { rule: (await getRule(deps, owner.id, id))!, hookPath: hook ? HOOK_PREFIX + hook.token : null }
}

/** 收到外部请求的规则换一个地址：旧地址立刻失效，新地址只在这一次给。不是自己的 / 没有 = null */
export async function rotateHook(deps: RuleDeps, ownerId: string, id: string): Promise<Created | null> {
  const hook = newHookToken()
  const { rows } = await deps.pool.query<{ source: string }>(
    `UPDATE agent_triggers SET hook_hash = CASE WHEN source = 'webhook' THEN $3 ELSE hook_hash END,
       config = CASE WHEN source = 'webhook' THEN jsonb_build_object('hint', $4::text) ELSE config END, updated_at = now()
     WHERE owner_id = $1 AND id = $2 RETURNING source`,
    [ownerId, id, hook.hash, hook.hint],
  )
  if (!rows[0]) return null
  if (rows[0].source !== 'webhook') throw new TimerError(400, '只有「收到外部请求」的规则有地址')
  return { rule: (await getRule(deps, ownerId, id))!, hookPath: HOOK_PREFIX + hook.token }
}

/** 改：{ name?, config?, actions?, enabled? }，只填要改的 */
export async function updateRule(deps: RuleDeps, owner: User, id: string, raw: Record<string, unknown>, now: Date): Promise<AutomationView> {
  const { pool } = deps
  const keys = ['name', 'config', 'actions', 'enabled'].filter((k) => raw[k] !== undefined)
  if (keys.length === 0) throw new TimerError(400, '没有要改的（可改 name / config / actions / enabled）')
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new TimerError(400, 'enabled 要写成 true / false')
  const patch: RulePatch = {}
  if (raw.name !== undefined) patch.name = text(raw.name, TIMER_LIMITS.name, '名字')
  if (raw.actions !== undefined) patch.actions = actionsOf(raw.actions)
  if (typeof raw.enabled === 'boolean') patch.enabled = raw.enabled
  await withTransaction(pool, async (db) => {
    const cur = (await db.query<RuleRow>(`${SELECT_RULE} WHERE t.owner_id = $1 AND t.id = $2 FOR UPDATE OF t`, [owner.id, id])).rows[0]
    if (!cur) throw new TimerError(404, '没有这条规则')
    if (cur.builtin && patch.name !== undefined && patch.name !== cur.name) throw new TimerError(400, BUILTIN_NO_RENAME)
    if (raw.config !== undefined) {
      const src = SOURCES[cur.source]
      const parsed = src?.fixedConfig ? undefined : src?.parse(raw.config)
      if (!src || !parsed) throw new TimerError(400, '这种触发的配置不能在这里改')
      if ('error' in parsed) throw new TimerError(400, parsed.error)
      const reason = await src.check?.(deps, owner, parsed.config)
      if (reason) throw new TimerError(400, reason)
      if (cur.source === 'collection' && (parsed.config as CollectionConfig).collection !== cur.scope_page) throw new TimerError(400, '不能把规则挪到别的合集上')
      if (cur.source === 'timer') patch.schedule = schedule(parsed.spec)
      else await db.query('UPDATE agent_triggers SET config = $2::jsonb WHERE id = $1', [id, JSON.stringify(parsed.config)])
      // 盯页面换了范围 / 时长：攒着的按旧配置算的，作废
      if (cur.source === 'page_watch' && JSON.stringify(parsed.config) !== JSON.stringify(cur.config)) {
        await clearWatch(db, id)
        cur.next_at = null
      }
    }
    if (patch.actions) {
      const space = await spaceOf(pool, owner, patch.actions, cur.scope_page)
      if (space !== cur.space_id) {
        await db.query('UPDATE agent_triggers SET space_id = $2 WHERE id = $1', [id, space])
        cur.space_id = space
      }
    }
    await applyPatch(pool, db, cur, owner, patch, now, deps.getLiveDoc)
  })
  return (await getRule(deps, owner.id, id))!
}

/** 删掉（物理删，触发记录级联）；queued 同 deleteTimer。不是自己的 / 没有 = null；内置规则 400（只能关） */
export async function deleteRule(pool: Pool, ownerId: string, id: string): Promise<{ name: string; queued: string[] } | null> {
  return withTransaction(pool, async (db) => {
    const cur = (await db.query<{ name: string; builtin: string | null }>('SELECT name, builtin FROM agent_triggers WHERE owner_id = $1 AND id = $2 FOR UPDATE', [ownerId, id]))
      .rows[0]
    if (!cur) return null
    if (cur.builtin) throw new TimerError(400, BUILTIN_NO_DELETE)
    const queued = await queuedOf(db, id)
    await db.query('DELETE FROM agent_triggers WHERE id = $1', [id])
    return { name: cur.name, queued }
  })
}
