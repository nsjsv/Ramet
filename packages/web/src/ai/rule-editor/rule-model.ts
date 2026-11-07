/* ---------- 规则编辑器的纯函数（有单测）：来源分组、时间表草稿、动作草稿 ↔ JSON、改了什么 ----------
 * 表单里用「草稿」：时间表四种写法的字段一直都在（切换 kind 不丢填了一半的值），动作的「属性 → 值」是一行一对。
 * 保存时才转成服务端要的 JSON；校验以服务端为准，这里只做「没填」这类一眼看得出的提示，不重写时间表 / 动作的规则。 */

import type { Action, ActionType, AutomationView, RuleDormant, RuleSource, Schedule } from '../automation-api'

/** 列表分组：同一类来源放一起（只显示非空的组）；内置规则（评论找我 / 正文 @我）单独一组，排在最前 */
export type RuleGroup = 'builtin' | 'timer' | 'event' | 'collection' | 'button' | 'ai' | 'other'

export const GROUP_ORDER: readonly RuleGroup[] = ['builtin', 'timer', 'event', 'collection', 'button', 'ai', 'other']

const SOURCE_GROUP: Record<RuleSource, RuleGroup> = {
  timer: 'timer',
  comment: 'event',
  mention: 'event',
  page_watch: 'event',
  webhook: 'event',
  collection: 'collection',
  button: 'button',
  ai_block: 'ai',
  ai_prop: 'ai',
}

export function groupOfSource(source: string): RuleGroup {
  return (SOURCE_GROUP as Record<string, RuleGroup | undefined>)[source] ?? 'other'
}

/** 按组排好，组内保持服务端的顺序（新的在前） */
export function groupRules<T extends { source: string; builtin?: string | null }>(rules: readonly T[]): Array<{ group: RuleGroup; rules: T[] }> {
  const by = new Map<RuleGroup, T[]>()
  for (const r of rules) {
    const g = r.builtin ? 'builtin' : groupOfSource(r.source)
    const list = by.get(g)
    if (list) list.push(r)
    else by.set(g, [r])
  }
  return GROUP_ORDER.flatMap((group) => {
    const list = by.get(group)
    return list ? [{ group, rules: list }] : []
  })
}

/** 一次性的已经触发过：服务端触发时就把它关了，再打开会被拒（时间已过），所以不给开关 */
export function finishedOnce(r: Pick<AutomationView, 'source' | 'config' | 'enabled' | 'last'>): boolean {
  if (r.source !== 'timer' || r.enabled || r.last === null) return false
  const c = r.config
  return typeof c === 'object' && c !== null && (c as { kind?: unknown }).kind === 'once'
}

/** 内置规则还不能生效时，用户能做的那一步：去设置配模型连接 / 打开一次 Genet（服务端在那时才建 Genet 页）；认不出的 code 不给按钮 */
export function dormantFix(dormant: RuleDormant | null | undefined): 'settings' | 'genet' | null {
  if (dormant?.code === 'no_connection') return 'settings'
  if (dormant?.code === 'no_genet_page') return 'genet'
  return null
}

// ---------- 时间表 ----------

export const EVERY_MIN = 60
export const EVERY_MAX = 10080

export type ScheduleKind = Schedule['kind']

export type ScheduleDraft = {
  kind: ScheduleKind
  /** once：'YYYY-MM-DDTHH:MM'（DateField 带时间的值）；没填 = null */
  at: string | null
  /** daily / weekly：用户敲的原文，保存时规整成 HH:MM */
  time: string
  days: number[]
  /** every：分钟；没填 = null */
  minutes: number | null
}

const pad = (n: number): string => String(n).padStart(2, '0')

function localStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 新规则的缺省：每天 09:00；切到「一次」时是明天 09:00，「每周」是工作日，「每隔」是 60 分钟 */
export function defaultScheduleDraft(now: Date): ScheduleDraft {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0)
  return { kind: 'daily', at: localStamp(tomorrow), time: '09:00', days: [1, 2, 3, 4, 5], minutes: EVERY_MIN }
}

/** 已有规则的时间表 → 草稿（认不出的形状回落缺省） */
export function scheduleDraftOf(config: unknown, now: Date): ScheduleDraft {
  const base = defaultScheduleDraft(now)
  const c = config && typeof config === 'object' ? (config as Record<string, unknown>) : {}
  switch (c.kind) {
    case 'once':
      return { ...base, kind: 'once', at: typeof c.at === 'string' ? c.at : base.at }
    case 'daily':
      return { ...base, kind: 'daily', time: typeof c.time === 'string' ? c.time : base.time }
    case 'weekly':
      return {
        ...base,
        kind: 'weekly',
        time: typeof c.time === 'string' ? c.time : base.time,
        days: Array.isArray(c.days) ? c.days.filter((d): d is number => typeof d === 'number') : base.days,
      }
    case 'every':
      return { ...base, kind: 'every', minutes: typeof c.minutes === 'number' ? c.minutes : base.minutes }
    default:
      return base
  }
}

/** 「9:00」「09：30」「930」「9」→ HH:MM；认不出 = null */
export function normalizeTime(raw: string): string | null {
  const s = raw.trim().replace('：', ':')
  let h: number
  let m: number
  const colon = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (colon) {
    h = Number(colon[1])
    m = Number(colon[2])
  } else if (/^\d{1,2}$/.test(s)) {
    h = Number(s)
    m = 0
  } else if (/^\d{3,4}$/.test(s)) {
    h = Number(s.slice(0, -2))
    m = Number(s.slice(-2))
  } else return null
  return h <= 23 && m <= 59 ? `${pad(h)}:${pad(m)}` : null
}

export type Fail = { error: string }

/** 草稿 → 时间表；只拦「没填 / 写法不对」，时间是否已过、间隔上下限的最终口径在服务端 */
export function scheduleOf(d: ScheduleDraft, msg: { noAt: string; badTime: string; noDays: string; badMinutes: string }): Schedule | Fail {
  switch (d.kind) {
    case 'once':
      return d.at ? { kind: 'once', at: d.at } : { error: msg.noAt }
    case 'daily':
    case 'weekly': {
      const time = normalizeTime(d.time)
      if (!time) return { error: msg.badTime }
      if (d.kind === 'daily') return { kind: 'daily', time }
      const days = [...new Set(d.days)].filter((x) => x >= 1 && x <= 7).sort((a, b) => a - b)
      return days.length > 0 ? { kind: 'weekly', days, time } : { error: msg.noDays }
    }
    case 'every':
      return d.minutes !== null && Number.isInteger(d.minutes) && d.minutes >= EVERY_MIN && d.minutes <= EVERY_MAX
        ? { kind: 'every', minutes: d.minutes }
        : { error: msg.badMinutes }
  }
}

// ---------- 动作 ----------

export const MAX_ACTIONS = 10
export const ACTION_TYPES: readonly ActionType[] = ['genet', 'agent', 'set_props', 'create_page', 'notify', 'webhook']
/** set_props 的 row 写它 = 事件所在的那一行（定时规则没有事件行） */
export const EVENT_ROW = 'event'

export type Pair = { key: string; value: string }

type Uid = { uid: string }
export type ActionDraft = Uid &
  (
    | { type: 'genet'; instruction: string }
    | { type: 'agent'; page: string; agent: string; instruction: string }
    | { type: 'set_props'; row: string; pairs: Pair[] }
    | { type: 'create_page'; parent: string; title: string; template: string; pairs: Pair[] }
    | { type: 'notify'; to: 'owner' | 'members'; members: string[]; text: string }
    | { type: 'webhook'; url: string; body: string }
    | { type: 'ai_gen'; page: string; block: string }
    | { type: 'ai_prop'; collection: string; prop: string; row: string }
  )

let seq = 0
const uid = (): string => `a${++seq}`

/** 这种来源的事件有没有「所在的行」（合集行）：定时、评论、正文提及都没有 */
export function hasEventRow(source: string): boolean {
  return source !== 'timer' && source !== 'comment' && source !== 'mention' && source !== 'page_watch' && source !== 'webhook'
}

/** 新加一个动作的空表单。没有「事件所在的行」的来源，改属性缺省要指定行 */
export function newAction(type: ActionType, source: string): ActionDraft {
  switch (type) {
    case 'genet':
      return { uid: uid(), type, instruction: '' }
    case 'agent':
      return { uid: uid(), type, page: '', agent: '', instruction: '' }
    case 'set_props':
      return { uid: uid(), type, row: hasEventRow(source) ? EVENT_ROW : '', pairs: [{ key: '', value: '' }] }
    case 'create_page':
      return { uid: uid(), type, parent: '', title: '', template: '', pairs: [] }
    case 'notify':
      return { uid: uid(), type, to: 'owner', members: [], text: '' }
    case 'webhook':
      return { uid: uid(), type, url: '', body: '' }
    // 不在「添加动作」里（ACTION_TYPES 不含它），只从 AI 块的「自动更新」建
    case 'ai_gen':
      return { uid: uid(), type, page: '', block: '' }
    case 'ai_prop':
      return { uid: uid(), type, collection: '', prop: '', row: EVENT_ROW }
  }
}

/** 属性值 → 表单里的文字。服务端按属性类型把文字换回它要的形状（数字、是否、选项、逗号分隔的多选），所以这里只管显示 */
export function valueText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(valueText).join(', ')
  return ''
}

const pairsOf = (set: Record<string, unknown> | undefined): Pair[] => Object.entries(set ?? {}).map(([key, v]) => ({ key, value: valueText(v) }))

/** 一对都空的行是表单里的空位，不算数；只填了值没填属性名的留着（服务端会说「有空的属性名」） */
function setOf(pairs: readonly Pair[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of pairs) {
    if (!p.key.trim() && !p.value.trim()) continue
    out[p.key.trim()] = p.value
  }
  return out
}

export function draftOf(a: Action): ActionDraft {
  switch (a.type) {
    case 'genet':
      return { uid: uid(), type: 'genet', instruction: a.instruction }
    case 'agent':
      return { uid: uid(), type: 'agent', page: a.page, agent: a.agent, instruction: a.instruction }
    case 'set_props':
      return { uid: uid(), type: 'set_props', row: a.row, pairs: pairsOf(a.set) }
    case 'create_page':
      return { uid: uid(), type: 'create_page', parent: a.parent, title: a.title, template: a.template ?? '', pairs: pairsOf(a.props) }
    case 'notify':
      return a.to === 'owner'
        ? { uid: uid(), type: 'notify', to: 'owner', members: [], text: a.text }
        : { uid: uid(), type: 'notify', to: 'members', members: [...a.to], text: a.text }
    case 'webhook':
      return { uid: uid(), type: 'webhook', url: a.url, body: a.body ?? '' }
    case 'ai_gen':
      return { uid: uid(), type: 'ai_gen', page: a.page, block: a.block }
    case 'ai_prop':
      return { uid: uid(), type: 'ai_prop', collection: a.collection, prop: a.prop, row: a.row }
  }
}

/** 草稿 → 动作 JSON（只去两头空白、丢空位；形状与内容的校验在服务端） */
export function actionOf(d: ActionDraft): Action {
  switch (d.type) {
    case 'genet':
      return { type: 'genet', instruction: d.instruction.trim() }
    case 'agent':
      return { type: 'agent', page: d.page, agent: d.agent, instruction: d.instruction.trim() }
    case 'set_props':
      return { type: 'set_props', row: d.row, set: setOf(d.pairs) }
    case 'create_page': {
      const out: Action = { type: 'create_page', parent: d.parent, title: d.title.trim() }
      if (d.template) out.template = d.template
      const props = setOf(d.pairs)
      if (Object.keys(props).length > 0) out.props = props
      return out
    }
    case 'notify':
      return { type: 'notify', to: d.to === 'owner' ? 'owner' : [...d.members], text: d.text.trim() }
    case 'webhook':
      return d.body.trim() ? { type: 'webhook', url: d.url.trim(), body: d.body } : { type: 'webhook', url: d.url.trim() }
    case 'ai_gen':
      return { type: 'ai_gen', page: d.page, block: d.block }
    case 'ai_prop':
      return { type: 'ai_prop', collection: d.collection, prop: d.prop, row: d.row }
  }
}

/** 把第 i 项挪 delta 位（越界不动） */
export function moveItem<T>(list: readonly T[], i: number, delta: number): T[] {
  const j = i + delta
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return [...list]
  const next = [...list]
  const [item] = next.splice(i, 1)
  next.splice(j, 0, item!)
  return next
}

/** 服务端的「第 N 个动作：…」→ 第几个（0 起）；不是动作的错 = null */
export function errorIndex(message: string): number | null {
  const m = /^第 (\d+) 个动作/.exec(message)
  return m ? Number(m[1]) - 1 : null
}

// ---------- 变量 ----------

/** 每种来源有意义的变量（定时器没有触发者、页面、文字）。row.<属性名> 只给事件带着合集行的来源 */
export function varsFor(source: string): string[] {
  if (source === 'timer') return ['now', 'rule']
  const base = ['actor', 'page', 'page_link', 'text', 'now', 'rule']
  return hasEventRow(source) ? [...base, 'row.属性名'] : base
}

/** 在 [start, end) 处插入 {{name}}，返回新文字与光标位置 */
export function insertVar(text: string, start: number, end: number, name: string): { text: string; caret: number } {
  const token = `{{${name}}}`
  const a = Math.max(0, Math.min(start, text.length))
  const b = Math.max(a, Math.min(end, text.length))
  return { text: text.slice(0, a) + token + text.slice(b), caret: a + token.length }
}

// ---------- 改了什么 ----------

/** 编辑现有规则：只发改了的字段。改时间表会按此刻的时区与时间重排下次（every 的步长也从现在算），没动就别发 */
export function changedFields(
  baseline: { name: string; config: string; actions: string },
  next: { name: string; config: unknown | undefined; actions: Action[] },
): { name?: string; config?: unknown; actions?: Action[] } {
  const out: { name?: string; config?: unknown; actions?: Action[] } = {}
  if (next.name.trim() !== baseline.name) out.name = next.name.trim()
  if (next.config !== undefined && JSON.stringify(next.config) !== baseline.config) out.config = next.config
  if (JSON.stringify(next.actions) !== baseline.actions) out.actions = next.actions
  return out
}

// ---------- 页面选择 ----------

type PageLike = { id: string; parent_id: string | null; kind: string; space_id: string | null; is_template?: boolean; in_page_tree?: boolean }

export type PagePurpose = 'doc' | 'parent' | 'row' | 'template' | 'collection'

/** 各个选择框里列哪些页：agent 跑在文档页上；新建页建在文档页或合集下；改属性改的是合集里的行；模板是任意文档页（标了模板的排前面）；合集的触发选合集 */
export function pageChoices<T extends PageLike>(pages: readonly T[], purpose: PagePurpose): T[] {
  const byId = new Map(pages.map((p) => [p.id, p]))
  switch (purpose) {
    case 'doc':
      return pages.filter((p) => p.kind === 'doc')
    case 'parent':
      return pages.filter((p) => p.kind === 'doc' || p.kind === 'collection')
    case 'row':
      return pages.filter((p) => p.kind === 'doc' && p.parent_id !== null && byId.get(p.parent_id)?.kind === 'collection')
    case 'collection':
      return pages.filter((p) => p.kind === 'collection')
    case 'template': {
      const docs = pages.filter((p) => p.kind === 'doc')
      return [...docs.filter((p) => p.is_template), ...docs.filter((p) => !p.is_template)]
    }
  }
}

/** 规则所在空间（发通知能选哪些成员）：挂靠页的 > 第一个带页面的动作所在的 > 个人空间（与服务端 rules.ts 的 spaceOf 同序） */
export function ruleSpace(
  drafts: readonly ActionDraft[],
  scopePage: string | null,
  pages: readonly PageLike[],
  personal: string | null,
): string | null {
  const spaceOf = (id: string): string | null => pages.find((p) => p.id === id)?.space_id ?? null
  if (scopePage) return spaceOf(scopePage) ?? personal
  for (const d of drafts) {
    const page = d.type === 'agent' ? d.page : d.type === 'create_page' ? d.parent : d.type === 'set_props' && d.row !== EVENT_ROW ? d.row : ''
    const s = page ? spaceOf(page) : null
    if (s) return s
  }
  return personal
}
