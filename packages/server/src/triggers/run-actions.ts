// ---------- 动作执行器：叫 Genet / 改属性 / 新建页或行 / 发通知 / 向外 webhook ----------
// 「叫 agent」要走排队发送、可能要先等审批、开跑后还要接着跑后面的动作，归 hub.ts；其余五种在这里，一次跑完。
// 每个动作执行前按规则主人此刻的身份现查权限（页面 / 合集可写、仍是空间成员），不替失权的人做；写入走与界面同一条路：
//   改属性 / 新建行 = collections/write-row.ts（validateValue + DocWriter 记给主人 + 等副本落库），新建页 = page-create.ts，
//   叫 Genet = GenetNotify（与任务回报同一条按 Genet 页的串行链）。
// 动作改了页面就告诉 hub（touched）：那一页之后 10 秒里再触发的规则算自动化连锁，深度 +1（hub.causedBy）。
// 结局：done（reason 是给人看的一句结果，如「HTTP 200」）/ failed + 原因；失败了 hub 不再跑后面的动作。

import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type * as Y from 'yjs'
import { findOption, isPropId, type CollectionProp, type CollectionSchema } from '@ramet/shared/collection-model'
import { pageAccess, setDocTitle, type DocWriter } from '../collab.js'
import type { GenetNotify } from '../agents/genet-notify.js'
import type { Projector } from '../collections/projector.js'
import { readSchema } from '../collections/store.js'
import { insertRow, writeRow, type RowWriteDeps } from '../collections/write-row.js'
import { isUnsafeEndpointError, type SafeFetch } from '../endpoint-guard.js'
import { createDocPage, instantiatePage } from '../page-create.js'
import { collectionGate } from '../routes/collections.js'
import { SET_TITLE } from '../routes/pages.js'
import { EVENT_ROW, type Action } from './actions.js'
import { eventNoticeElement, timerNoticeElement } from './notice.js'
import type { EventPayload, TriggerSource } from './payload.js'
import type { Schedule } from './schedule.js'
import { expand, expandValue, jsonEscape, type TemplateVars } from './template.js'

/** 一次触发在执行时要知道的（hub 从触发记录 + 规则拼出来） */
export type RunEvent = {
  id: string
  owner: { id: string; role: string }
  ruleId: string
  ruleName: string
  source: TriggerSource
  /** 规则所在空间（agent_triggers.space_id） */
  spaceId: string
  scopePage: string | null
  timeZone: string
  /** 定时器的时间表（定时提醒的抬头用）；别的来源没有 */
  schedule: Schedule | null
  scheduledAt: Date
  payload: EventPayload
  external: boolean
  depth: number
}

export type ActionOutcome = { status: 'done'; reason: string } | { status: 'failed' | 'skipped'; reason: string } | { status: 'queued' }

export type ActionDeps = {
  pool: Pool
  now(): Date
  notify: Pick<GenetNotify, 'post'>
  /** 写行 / 改标题的文档通道（collab.ts 的 DocWriter）；测试桩不给 = 这两种动作失败 */
  write?: DocWriter
  getLiveDoc?: (docName: string) => Y.Doc | undefined
  projector?: Pick<Projector, 'flushRow'>
  /** 向外 webhook 用的防护版 fetch（endpoint-guard.ts）；不给 = webhook 失败 */
  fetch?: SafeFetch
  /** 页面列表变了（新建了页 / 行）：广播 changed */
  pagesChanged?(): void
  /** 在合集里建了行：交给「新增了一行」（不等它） */
  rowsAdded?(parentId: string, rowIds: readonly string[], actorId: string): void
  /** 刷新 AI 块（ai-gen.ts 的 runAiGen）：返回失败原因，成功 = null */
  aiGen?(user: { id: string; role: string }, pageId: string, blockId: string): Promise<string | null>
  /** 填 AI 属性（ai-prop.ts 的 fillRow）：返回失败原因，成功 = null */
  aiProp?(user: { id: string; role: string }, collectionId: string, propId: string, rowId: string): Promise<string | null>
  /** 收件箱刷新（发了通知） */
  poke(): void
  /** 动作改了这一页（自动化连锁的记账） */
  touched(pageId: string, depth: number): void
}

const WEBHOOK_TIMEOUT_MS = 10_000
const NOTICE_TEXT_MAX = 2000

const done = (reason = ''): ActionOutcome => ({ status: 'done', reason })
const failed = (reason: string): ActionOutcome => ({ status: 'failed', reason })
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** 规则主人现在的 Genet 页（活的）；没打开过 AI 页 / 进了回收站 = null */
async function genetHome(pool: Pool, userId: string): Promise<string | null> {
  const row = (await pool.query<{ page_id: string }>('SELECT a.page_id FROM assistants a JOIN live_pages p ON p.id = a.page_id WHERE a.user_id = $1', [userId])).rows[0]
  return row?.page_id ?? null
}

const TRUE_WORDS = new Set(['true', '1', 'yes', 'on', '是', '对', '勾选'])
const FALSE_WORDS = new Set(['false', '0', 'no', 'off', '否', '不', ''])

/** 选项按 id 或名字认（规则里写名字更自然，变量展开出来的也是名字） */
function optionId(prop: CollectionProp, raw: string): string {
  return findOption(prop, raw)?.id ?? prop.options.find((o) => o.name === raw.trim())?.id ?? raw
}

/** 变量展开出来的是文字：按属性的类型换成它要的值形状（数字、是否、选项 id、列表），之后照常过 validateValue */
function coerce(prop: CollectionProp, value: unknown): unknown {
  if (typeof value !== 'string') {
    if (Array.isArray(value) && prop.type === 'multi_select') return value.map((v) => (typeof v === 'string' ? optionId(prop, v) : v))
    return value
  }
  const s = value.trim()
  switch (prop.type) {
    case 'number':
      return s === '' ? null : Number.isFinite(Number(s)) ? Number(s) : value
    case 'checkbox':
      return TRUE_WORDS.has(s.toLowerCase()) ? true : FALSE_WORDS.has(s.toLowerCase()) ? false : value
    case 'select':
    case 'status':
      return s === '' ? null : optionId(prop, s)
    case 'multi_select':
      return s === '' ? null : s.split(/[,，]/).map((x) => x.trim()).filter(Boolean).map((x) => optionId(prop, x))
    case 'person':
    case 'relation':
      return s === '' ? null : [s]
    case 'date':
      return s === '' ? null : s
    default:
      return value
  }
}

/** 规则里的「属性 → 值」（键是属性 id 或名字，值可带变量）→ 写入接口要的 { 属性 id: 值 }；认不出的属性 = 原因 */
function mapSet(schema: CollectionSchema, raw: Record<string, unknown>, vars: TemplateVars): { set: Record<string, unknown> } | { error: string } {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    const prop = (isPropId(key) ? schema.props.find((p) => p.id === key) : undefined) ?? schema.props.find((p) => p.name.trim() === key.trim())
    if (!prop) return { error: `合集里没有叫「${key}」的属性` }
    out[prop.id] = coerce(prop, expandValue(value, vars))
  }
  return { set: out }
}

/** 写入接口的错误 → 人话 */
function writeError(error: Record<string, string>, schema: CollectionSchema): string {
  const name = schema.props.find((p) => p.id === error.prop)?.name ?? error.prop
  if (error.error === 'unknown property') return `合集里没有「${name}」这个属性了`
  return name ? `属性「${name}」${error.message ? `：${error.message}` : '的值不对'}` : (error.message ?? '值不对')
}

export class ActionRunner {
  constructor(private deps: ActionDeps) {}

  /** 跑一个动作（agent 除外）。抛错由 hub 兜成失败 */
  async run(action: Exclude<Action, { type: 'agent' }>, ev: RunEvent, vars: TemplateVars): Promise<ActionOutcome> {
    switch (action.type) {
      case 'genet':
        return this.genet(action.instruction, ev, vars)
      case 'set_props':
        return this.setProps(action, ev, vars)
      case 'create_page':
        return this.createPage(action, ev, vars)
      case 'notify':
        return this.notifyUsers(action, ev, vars)
      case 'webhook':
        return this.webhook(action, ev, vars)
      case 'ai_gen':
        return this.aiGen(action, ev)
      case 'ai_prop':
        return this.aiProp(action, ev)
    }
  }

  /** 填 AI 属性：事件所在的行（或指定的行），以主人的身份、用主人的模型连接 */
  private async aiProp(action: Extract<Action, { type: 'ai_prop' }>, ev: RunEvent): Promise<ActionOutcome> {
    if (!this.deps.aiProp) return failed('没有 AI 属性的生成通道')
    const rowId = action.row === EVENT_ROW ? ev.payload.row?.id : action.row
    if (!rowId) return failed('这次事件没有「所在的行」')
    const gate = await collectionGate(this.deps.pool, ev.owner, action.collection, 'write')
    if (!gate.ok) return failed(gate.status === 403 ? '你已经不能编辑这个合集了' : '那个合集已经不在了')
    this.deps.touched(rowId, ev.depth)
    const reason = await this.deps.aiProp(ev.owner, action.collection, action.prop, rowId)
    return reason ? failed(reason) : done('填了 AI 属性')
  }

  /** 刷新 AI 块：以主人的身份、用主人的模型连接重新生成（等它生成完：结局写进记录） */
  private async aiGen(action: Extract<Action, { type: 'ai_gen' }>, ev: RunEvent): Promise<ActionOutcome> {
    if (!this.deps.aiGen) return failed('没有 AI 块的生成通道')
    const role = await pageAccess(this.deps.pool, action.page, ev.owner)
    if (role === null) return failed('AI 块所在的那一页已经不在了，或者你看不到它了')
    if (role === 'viewer') return failed('你已经不能编辑 AI 块所在的那一页了')
    this.deps.touched(action.page, ev.depth)
    const reason = await this.deps.aiGen(ev.owner, action.page, action.block)
    return reason ? failed(reason) : done('刷新了 AI 块')
  }

  private rowDeps(): RowWriteDeps | null {
    const { pool, write, getLiveDoc, projector } = this.deps
    return write && getLiveDoc && projector ? { pool, write, getLiveDoc, projector } : null
  }

  /** 叫 Genet：定时器写定时提醒，别的来源写事件通知；能不能写 Genet 页由 notify 自己按主人现查 */
  private async genet(raw: string, ev: RunEvent, vars: TemplateVars): Promise<ActionOutcome> {
    const home = await genetHome(this.deps.pool, ev.owner.id)
    if (!home) return failed('Genet 页已经不在了（进了回收站，或者还没打开过 AI 页）')
    const instruction = expand(raw, vars)
    const now = this.deps.now()
    const refused = await this.deps.notify.post(home, ev.owner.id, (frag) =>
      ev.source === 'timer' && ev.schedule
        ? timerNoticeElement(frag, { id: ev.ruleId, name: ev.ruleName, instruction, schedule: ev.schedule, timeZone: ev.timeZone }, ev.scheduledAt, now)
        : eventNoticeElement(frag, { ruleId: ev.ruleId, ruleName: ev.ruleName, instruction, payload: ev.payload, external: ev.external }),
    )
    return refused ? failed(refused) : done()
  }

  /** 改属性：行 = 事件所在行或指定行，必须是主人此刻可写的合集里的活行 */
  private async setProps(action: Extract<Action, { type: 'set_props' }>, ev: RunEvent, vars: TemplateVars): Promise<ActionOutcome> {
    const deps = this.rowDeps()
    if (!deps) return failed('没有文档写入通道')
    const rowId = action.row === EVENT_ROW ? ev.payload.row?.id : action.row
    if (!rowId) return failed('这个事件没有对应的合集行')
    const parent = (await deps.pool.query<{ parent_id: string | null }>("SELECT parent_id FROM live_pages WHERE id = $1 AND kind = 'doc'", [rowId])).rows[0]?.parent_id
    const gate = parent ? await collectionGate(deps.pool, ev.owner, parent, 'write') : null
    if (!parent || !gate) return failed('要改的行已经不在了（进了回收站，或者不在合集里了）')
    if (!gate.ok) return failed(gate.status === 403 ? '你已经不能编辑这个合集了' : '要改的行已经不在了（进了回收站，或者不在合集里了）')
    const schema = await readSchema(deps.pool, parent, deps.getLiveDoc)
    const mapped = mapSet(schema, action.set, vars)
    if ('error' in mapped) return failed(mapped.error)
    // 先记下「这一行被自动化改了」再写：写完投影器立刻交出「属性改了」，那时就要认得出这是连锁
    this.deps.touched(rowId, ev.depth)
    const written = await writeRow(deps, ev.owner, gate.collection, rowId, { set: mapped.set })
    if (!written.ok) return failed(writeError(written.error, schema))
    return done()
  }

  /** 新建页 / 行：父页是合集 = 建一行（属性同改属性），是文档页 = 建子页（有模板就从模板复制） */
  private async createPage(action: Extract<Action, { type: 'create_page' }>, ev: RunEvent, vars: TemplateVars): Promise<ActionOutcome> {
    const { pool } = this.deps
    const parent = (await pool.query<{ kind: string; space_id: string | null }>('SELECT kind, space_id FROM live_pages WHERE id = $1', [action.parent])).rows[0]
    if (!parent?.space_id) return failed('要建在的那一页已经不在了')
    const title = [...expand(action.title, vars).replace(/\s+/g, ' ').trim()].slice(0, 200).join('')
    let id: string | null
    if (parent.kind === 'collection') {
      const deps = this.rowDeps()
      if (!deps) return failed('没有文档写入通道')
      const gate = await collectionGate(pool, ev.owner, action.parent, 'write')
      if (!gate.ok) return failed(gate.status === 403 ? '你已经不能编辑这个合集了' : '要建在的合集已经不在了')
      const schema = await readSchema(pool, action.parent, deps.getLiveDoc)
      const mapped = action.props ? mapSet(schema, action.props, vars) : undefined
      if (mapped && 'error' in mapped) return failed(mapped.error)
      // 新行的 id 先定下来、先记连锁（同改属性：建好就会交出「新增了一行」）
      const rowId = randomUUID()
      this.deps.touched(rowId, ev.depth)
      const created = await insertRow(deps, ev.owner, gate.collection, { id: rowId, title, ...(mapped ? { set: mapped.set } : {}), after: null, before: null })
      if (!created) return failed('要建在的合集已经不在了')
      if (created === 'taken') return failed('行 id 冲突了，再试一次')
      if (!created.ok) return failed(writeError(created.error, schema))
      id = created.id
      this.deps.rowsAdded?.(action.parent, [id], ev.owner.id)
    } else if (parent.kind === 'doc') {
      const role = await pageAccess(pool, action.parent, ev.owner)
      if (role === null) return failed('要建在的那一页已经不在了，或者你看不到它了')
      if (role === 'viewer') return failed('你已经不能编辑要建在的那一页了')
      id = action.template ? await this.fromTemplate(action.template, parent.space_id, action.parent, title, ev) : randomUUID()
      if (!id) return failed('模板页已经不在了，或者你看不到它')
      if (!action.template) await createDocPage(pool, ev.owner, { id, parentId: action.parent, spaceId: parent.space_id, title })
    } else return failed('只能建在文档页或合集下')
    this.deps.pagesChanged?.()
    this.deps.touched(id, ev.depth)
    return done(`建了 page:${id}`)
  }

  /** 从模板复制一份到父页下，标题换成规则给的（文档的标题片段与 pages.title 双写） */
  private async fromTemplate(template: string, spaceId: string, parentId: string, title: string, ev: RunEvent): Promise<string | null> {
    const { pool, write, getLiveDoc } = this.deps
    if ((await pageAccess(pool, template, ev.owner)) === null) return null
    const id = await instantiatePage(pool, getLiveDoc, ev.owner, template, spaceId, parentId)
    if (id && title && write) {
      await write(`page:${id}`, ev.owner, (doc, origin) => doc.transact(() => setDocTitle(doc, title), origin), 'user')
      await pool.query(SET_TITLE, [title, id])
    }
    return id
  }

  /** 规则所在空间：有挂靠页就是挂靠页的空间（挂靠页进了回收站 = null） */
  private async ruleSpace(ev: RunEvent): Promise<string | null> {
    if (!ev.scopePage) return ev.spaceId
    return (await this.deps.pool.query<{ space_id: string | null }>('SELECT space_id FROM live_pages WHERE id = $1', [ev.scopePage])).rows[0]?.space_id ?? null
  }

  /** 发通知：收件人必须是规则所在空间（有挂靠页就是挂靠页的空间）的成员，主人自己也一样 */
  private async notifyUsers(action: Extract<Action, { type: 'notify' }>, ev: RunEvent, vars: TemplateVars): Promise<ActionOutcome> {
    const { pool } = this.deps
    const scoped = await this.ruleSpace(ev)
    if (!scoped) return failed('规则挂靠的那一页已经不在了')
    const wanted = action.to === 'owner' ? [ev.owner.id] : action.to
    const members = (await pool.query<{ user_id: string }>('SELECT user_id FROM space_members WHERE space_id = $1 AND user_id = ANY($2::text[])', [scoped, wanted])).rows.map(
      (r) => r.user_id,
    )
    if (members.length === 0) return failed(action.to === 'owner' ? '你已经不是规则所在空间的成员了' : '收件人都已经不是这个空间的成员了')
    const text = [...expand(action.text, vars)].slice(0, NOTICE_TEXT_MAX).join('')
    const page = ev.payload.page?.id ?? null
    const live = page ? ((await pool.query('SELECT 1 FROM live_pages WHERE id = $1', [page])).rowCount ?? 0) > 0 : false
    for (const user of members) {
      await pool.query(
        'INSERT INTO automation_notices (id, user_id, space_id, trigger_id, event_id, rule_name, text, page_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [randomUUID(), user, scoped, ev.ruleId, ev.id, ev.ruleName, text, live ? page : null, this.deps.now()],
      )
    }
    this.deps.poke()
    const skipped = wanted.length - members.length
    return done(`通知了 ${members.length} 人${skipped > 0 ? `（${skipped} 人不是空间成员，没发）` : ''}`)
  }

  /** 向外 webhook：POST JSON，只看状态码（响应体不读），2xx 才算成 */
  private async webhook(action: Extract<Action, { type: 'webhook' }>, ev: RunEvent, vars: TemplateVars): Promise<ActionOutcome> {
    if (!this.deps.fetch) return failed('没有出站通道')
    // 请求体带着事件内容往外发：主人得仍是规则所在空间的成员，不替被移出去的人把空间里的事发出去
    const space = await this.ruleSpace(ev)
    if (!space) return failed('规则挂靠的那一页已经不在了')
    const member = await this.deps.pool.query('SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2', [space, ev.owner.id])
    if (!member.rowCount) return failed('你已经不是规则所在空间的成员了')
    const body = action.body
      ? expand(action.body, vars, jsonEscape)
      : JSON.stringify({
          rule: { id: ev.ruleId, name: ev.ruleName },
          event: { id: ev.id, source: ev.source, at: ev.scheduledAt.toISOString(), external: ev.external },
          payload: ev.payload,
        })
    let status: number
    try {
      const res = await this.deps.fetch(action.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', 'user-agent': 'Ramet-Automation' },
        body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      })
      status = res.status
      await res.body?.cancel().catch(() => undefined)
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return failed(`${WEBHOOK_TIMEOUT_MS / 1000} 秒内没有响应`)
      return failed(isUnsafeEndpointError(err) ? errText(err) : `请求失败：${errText(err)}`)
    }
    return status >= 200 && status < 300 ? done(`HTTP ${status}`) : failed(`对方返回 HTTP ${status}`)
  }
}
