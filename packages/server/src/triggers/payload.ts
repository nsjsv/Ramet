// ---------- 事件载荷：一次触发「谁、哪一页 / 哪一行、写了什么、变了什么」（纯函数） ----------
// 来源（定时器、以后的评论 / 页面变动 / webhook…）落触发记录时把它存进 trigger_events.payload；动作里的变量（template.ts）、
// 写给 Genet 的事件通知（notice.ts）、向外 webhook 的缺省请求体都从这里取。存进库之前一律过 cleanPayload：
// 字段限长、只留认得的键，外来的长文本不会把一条记录撑大，也不会把不认识的结构带进提示词。

/** 规则的来源（agent_triggers.source 的 CHECK 与这里同一份） */
export const TRIGGER_SOURCES = ['timer', 'comment', 'mention', 'page_watch', 'webhook', 'collection', 'button', 'ai_block', 'ai_prop'] as const
export type TriggerSource = (typeof TRIGGER_SOURCES)[number]

export function isTriggerSource(raw: unknown): raw is TriggerSource {
  return typeof raw === 'string' && (TRIGGER_SOURCES as readonly string[]).includes(raw)
}

/** 来源的人话名字（规则列表的分组、事件通知的抬头） */
export const SOURCE_LABEL: Record<TriggerSource, string> = {
  timer: '定时',
  comment: '评论',
  mention: '提及',
  page_watch: '页面改动',
  webhook: '外部请求',
  collection: '合集变化',
  button: '按钮',
  ai_block: 'AI 块',
  ai_prop: 'AI 属性',
}

export type EventPayload = {
  source: TriggerSource
  /** 触发者；没有 = 系统（定时）或外部（webhook） */
  actor?: { id: string; name: string }
  page?: { id: string; title: string }
  /** 事件所在的合集行：props = 属性名 → 显示文字 */
  row?: { id: string; props: Record<string, string> }
  /** 事件带来的文字（评论原文、webhook 的负载摘录……） */
  text?: string
  /** 变了什么（属性名 / 从 / 到） */
  changes?: Array<{ prop: string; from: string; to: string }>
  /** 来源自己的零碎信息（按钮名、webhook 名…），只当显示用：[说明, 值]，按来源给的顺序一行一条。
   *  不用对象：载荷存在 JSONB 里，对象的键会按长度重排，通知里的几行就乱了序 */
  extra?: Array<[string, string]>
}

const LIMIT = { id: 100, name: 200, text: 4000, value: 500, props: 50, changes: 20, extra: 20 } as const

function str(raw: unknown, max: number): string {
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') return ''
  const s = String(raw)
  return [...s].length > max ? `${[...s].slice(0, max).join('')}…` : s
}

function record(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
}

function idName(raw: unknown, nameKey: 'name' | 'title'): { id: string; name: string } | undefined {
  const r = record(raw)
  const id = str(r?.id, LIMIT.id)
  return id ? { id, name: str(r?.[nameKey], LIMIT.name) } : undefined
}

function strings(raw: unknown, max: number): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(record(raw) ?? {}).slice(0, max)) out[str(k, LIMIT.name)] = str(v, LIMIT.value)
  return out
}

/** [说明, 值] 的列表，保持顺序、说明为空的丢掉。也收对象（键值对），按 Object.entries 的顺序 */
function labeled(raw: unknown, max: number): Array<[string, string]> {
  const list: unknown[] = Array.isArray(raw) ? raw : Object.entries(record(raw) ?? {})
  const out: Array<[string, string]> = []
  for (const item of list) {
    if (out.length >= max) break
    if (!Array.isArray(item)) continue
    const label = str(item[0], LIMIT.name)
    if (label) out.push([label, str(item[1], LIMIT.value)])
  }
  return out
}

/** 规整一份载荷（来源交来的、库里读出来的都过这里）：只留认得的键、限长；source 认不出时用 fallback */
export function cleanPayload(raw: unknown, fallback: TriggerSource): EventPayload {
  const r = record(raw) ?? {}
  const out: EventPayload = { source: isTriggerSource(r.source) ? r.source : fallback }
  const actor = idName(r.actor, 'name')
  if (actor) out.actor = actor
  const page = idName(r.page, 'title')
  if (page) out.page = { id: page.id, title: page.name }
  const row = record(r.row)
  const rowId = str(row?.id, LIMIT.id)
  if (rowId) out.row = { id: rowId, props: strings(row?.props, LIMIT.props) }
  const text = str(r.text, LIMIT.text)
  if (text) out.text = text
  if (Array.isArray(r.changes)) {
    const changes = r.changes
      .slice(0, LIMIT.changes)
      .map(record)
      .filter((c): c is Record<string, unknown> => c !== null)
      .map((c) => ({ prop: str(c.prop, LIMIT.name), from: str(c.from, LIMIT.value), to: str(c.to, LIMIT.value) }))
      .filter((c) => c.prop)
    if (changes.length > 0) out.changes = changes
  }
  const extra = labeled(r.extra, LIMIT.extra)
  if (extra.length > 0) out.extra = extra
  return out
}

/** 「bob 在《周报》的评论」：事件通知的抬头、审批卡上的起因都用这一句。没有触发者（定时 / 外部请求）就只写来源 */
export function eventCause(p: EventPayload): string {
  const who = p.actor?.name ?? ''
  const where = p.page ? `在《${p.page.title || '无标题'}》` : ''
  const what = SOURCE_LABEL[p.source]
  if (!who && !where) return what
  return `${who}${where ? `${who ? ' ' : ''}${where}` : ''}的${what}`
}

/** 载荷里除了正文以外的几行说明（行的属性、变了什么、零碎信息）：事件通知与提示词里用 */
export function detailLines(p: EventPayload): string[] {
  const out: string[] = []
  if (p.row) {
    const props = Object.entries(p.row.props).map(([k, v]) => `${k}：${v || '（空）'}`)
    out.push(props.length > 0 ? `行 row:${p.row.id} · ${props.join(' · ')}` : `行 row:${p.row.id}`)
  }
  for (const c of p.changes ?? []) out.push(`${c.prop}：${c.from || '（空）'} → ${c.to || '（空）'}`)
  for (const [k, v] of p.extra ?? []) out.push(`${k}：${v}`)
  return out
}
