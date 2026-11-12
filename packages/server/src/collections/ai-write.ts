// ---------- agent 写合集：「属性名 → 人话的值」换成写入接口要的 { 属性 id: 值 }（set_props 与 create_page 建行共用） ----------
// 这里只做换算，之后照常过 write-row.ts 的 readSet / validateValue（与界面同一份校验）：
//   选项按名字（或 id）认；人员按空间成员的用户名（或 id）认；关联按对方合集里的行 id / page:<id> / 唯一的标题认；
//   日期收 'YYYY-MM-DD'、区间 'a/b' 或 read_collection 写出来的 'a → b'；是否收 true / false 与「是 / 否」。
//   空值（null、''、[]）= 清空。名称不在这里改（它是行的标题，走 title）。
// 算出来的属性、文件、反向关联直接拒，原因写成 agent 能照着改的话；名字对不上时列出有哪些，省得它瞎猜再试。

import type { Pool } from 'pg'
import { findOption, isPropId, isReverseRelation, TITLE_NAME, type CollectionProp, type CollectionSchema } from '@ramet/shared/collection-model'
import { TYPE_NAMES } from './ai-names.js'
import { memberRows, spaceMembers, type CollectionPage } from './store.js'

export type AiSet = { ok: true; set: Record<string, unknown> } | { ok: false; error: string }

const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 'on', '是', '对', '勾选', '已勾选'])
const FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'off', '否', '不', '不是', '未勾选'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** 一次最多列出多少个候选名字（选项、成员很多时不把整张名单塞进错误里） */
const NAMES_SHOWN = 20

/** 值由 Ramet 自己算或记（行元数据、公式、汇总、按钮），写不进去 */
const COMPUTED = new Set(['created_time', 'edited_time', 'created_by', 'edited_by', 'unique_id', 'rollup', 'formula', 'button'])

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })
const isEmpty = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)
export const listing = (names: string[]): string => {
  const shown = names.slice(0, NAMES_SHOWN).map((n) => `「${n}」`).join('、')
  return names.length > NAMES_SHOWN ? `${shown} 等 ${names.length} 个` : shown
}

/** 多值：数组原样，字符串按逗号 / 顿号拆 */
function items(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return value.split(/[,，、]/).map((x) => x.trim()).filter(Boolean)
  return [value]
}

/** 选项按 id 或名字认（trim 后全等）；对不上 = 原因（列出可选的） */
export function optionOf(prop: CollectionProp, raw: unknown): string | { error: string } {
  const key = String(raw).trim()
  const id = findOption(prop, key)?.id ?? prop.options.find((o) => o.name.trim() === key)?.id
  if (id) return id
  return { error: `属性「${prop.name}」没有选项「${key}」${prop.options.length ? `，可选：${listing(prop.options.map((o) => o.name))}` : '（还没有任何选项）'}` }
}

/** 名字查找（一次请求里查一次、缓存住）：空间成员、某个合集的行（只认同空间的合集，失效的关联可能指到了别的空间） */
export type Lookups = {
  members(): Promise<Map<string, string>>
  rowsOf(collectionId: string): Promise<Array<{ id: string; title: string }>>
}

export function lookups(pool: Pool, collection: CollectionPage): Lookups {
  let members: Map<string, string> | undefined
  const rows = new Map<string, Array<{ id: string; title: string }>>()
  return {
    members: async () => (members ??= await spaceMembers(pool, collection.space_id)),
    rowsOf: async (id) => {
      const cached = rows.get(id)
      if (cached) return cached
      const inSpace = (await pool.query('SELECT 1 FROM live_pages WHERE id = $1 AND space_id = $2', [id, collection.space_id])).rowCount
      const found = inSpace ? (await memberRows(pool, id)).map((r) => ({ id: r.id, title: r.title })) : []
      rows.set(id, found)
      return found
    },
  }
}

/** 成员按用户 id 或用户名（不分大小写）认 */
export async function personOf(prop: CollectionProp, raw: unknown, look: Lookups): Promise<string | { error: string }> {
  const key = String(raw).trim()
  const members = await look.members()
  if (members.has(key)) return key
  const hit = [...members].filter(([, name]) => name.toLowerCase() === key.toLowerCase())
  if (hit.length === 1) return hit[0]![0]
  return { error: `属性「${prop.name}」只能选空间成员，没有叫「${key}」的人；成员有：${listing([...members.values()])}` }
}

/** 关联到的行：page:<id>（可带「标题」）、行 id，或对方合集里唯一的标题 */
export async function rowOf(prop: CollectionProp, target: string, raw: unknown, look: Lookups): Promise<string | { error: string }> {
  const key = String(raw).trim()
  const ref = /^page:([^\s「#]+)/.exec(key)?.[1] ?? (UUID.test(key) ? key : null)
  if (ref) return ref
  const hit = (await look.rowsOf(target)).filter((r) => r.title.trim() === key)
  if (hit.length === 1) return hit[0]!.id
  if (hit.length > 1) return { error: `属性「${prop.name}」：对方合集里有 ${hit.length} 行都叫「${key}」，用 page:<行id> 指定是哪一行` }
  return { error: `属性「${prop.name}」：对方合集里没有叫「${key}」的行（可以先用 read_collection 读那个合集）` }
}

/** 一个值按属性类型换成写入接口要的形状；换不了 = 原因 */
async function coerce(prop: CollectionProp, value: unknown, look: Lookups): Promise<{ value: unknown } | { error: string }> {
  if (isEmpty(value)) return { value: null }
  switch (prop.type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/[,，\s]/g, ''))
      return Number.isFinite(n) ? { value: n } : { error: `属性「${prop.name}」要填数字` }
    }
    case 'checkbox': {
      if (typeof value === 'boolean') return { value }
      const word = String(value).trim().toLowerCase()
      return TRUE_WORDS.has(word) ? { value: true } : FALSE_WORDS.has(word) ? { value: false } : { error: `属性「${prop.name}」要填 true 或 false` }
    }
    case 'select':
    case 'status': {
      const id = optionOf(prop, value)
      return typeof id === 'string' ? { value: id } : id
    }
    case 'multi_select':
    case 'person':
    case 'relation': {
      const out: string[] = []
      for (const item of items(value)) {
        const target = prop.cfg.target
        const id =
          prop.type === 'multi_select' ? optionOf(prop, item) : prop.type === 'person' ? await personOf(prop, item, look) : target ? await rowOf(prop, target, item, look) : { error: `属性「${prop.name}」的关联已失效` }
        if (typeof id !== 'string') return id
        out.push(id)
      }
      return { value: out }
    }
    case 'date':
      return { value: String(value).trim().replace(/\s*(→|->|~|～|至|到)\s*/, '/') }
    default:
      return { value: typeof value === 'string' ? value : typeof value === 'number' ? String(value) : value }
  }
}

/** 不能由 agent 写的属性：原因；能写 = null */
async function refused(pool: Pool, collection: CollectionPage, prop: CollectionProp): Promise<string | null> {
  if (COMPUTED.has(prop.type)) return `「${prop.name}」是${TYPE_NAMES[prop.type]}，值由 Ramet 算出来，不能直接改`
  if (prop.type === 'files') return `「${prop.name}」是文件属性，agent 还不能往里放文件`
  if (isReverseRelation(prop)) {
    const source = prop.cfg.target
    const title = source ? (await pool.query<{ title: string }>('SELECT title FROM live_pages WHERE id = $1 AND space_id = $2', [source, collection.space_id])).rows[0]?.title : undefined
    const where = title === undefined ? '对方合集' : `合集「${title || '无标题'}」（collection:${source}）`
    return `「${prop.name}」是反向关联，值由${where}里的关联算出来：要改就去那边改对应行的关联`
  }
  return null
}

/** 「属性名（或 id）→ 人话的值」→ 写入接口的 set。raw 不是对象 / 属性名对不上 / 值换不了 = 原因 */
export async function aiSet(
  pool: Pool,
  collection: CollectionPage,
  schema: CollectionSchema,
  raw: unknown,
): Promise<AiSet> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('props 要写成 { 属性名: 值 }')
  const look = lookups(pool, collection)
  const set: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = key.trim()
    if (name === TITLE_NAME) return fail(`「${TITLE_NAME}」就是行的标题，改它用 title`)
    const prop = (isPropId(name) ? schema.props.find((p) => p.id === name) : undefined) ?? schema.props.find((p) => p.name.trim() === name)
    if (!prop) return fail(`合集里没有叫「${name}」的属性；有：${listing(schema.props.map((p) => p.name || TYPE_NAMES[p.type]))}`)
    const why = await refused(pool, collection, prop)
    if (why) return fail(why)
    const coerced = await coerce(prop, value, look)
    if ('error' in coerced) return fail(coerced.error)
    set[prop.id] = coerced.value
  }
  return { ok: true, set }
}

/** write-row.ts 的校验错误（{ error, prop?, message? }）→ 人话 */
export function aiWriteError(error: Record<string, string>, schema: CollectionSchema): string {
  const prop = schema.props.find((p) => p.id === error.prop)
  if (error.error === 'unknown property') return `合集里没有「${prop?.name ?? error.prop}」这个属性了`
  const message = error.message ?? '值不对'
  return prop ? `属性「${prop.name}」：${message}` : message
}
