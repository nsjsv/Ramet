// ---------- REST 写关联的值（PATCH rows / rows/set / 建行的 set） ----------
// 正向关联：值就是行文档里对方行的 id 列表（≤ LIST_MAX），整份写；写前核对每个 id 是目标集合的活行、「只能关联一行」时至多一个。
// 反向关联：不存值（见 computed.ts 的「单一真相」），只收增删 { add?: id[], remove?: id[] }：反向值可以有几千行，
// 整份发既超出单次上限，并发时后到的整份还会把别人刚加的冲掉。写反向 = 改源集合那几行的正向关联：
// add 里的源行把这一行加进它的正向关联（只能一行时换成这一行），remove 里的源行从它的正向关联里删掉这一行；
// 逐行经 DocWriter（记给发起人）写源集合的行文档，再等副本落库。只读被点名的源行，不倒排整个源集合。
// 全部换算与校验在任何写入之前做完：不合法整个请求 400，一个字都不改。

import * as Y from 'yjs'
import type { Pool } from 'pg'
import {
  idList,
  isReverseRelation,
  LIST_MAX,
  readValue,
  validateValue,
  type CollectionProp,
  type CollectionSchema,
  type PropValue,
} from '@ramet/shared/collection-model'
import type { DocWriter } from '../collab.js'
import { relationOf, type LiveDoc, type Link } from './computed.js'
import { memberRowsAmong, membersAmong, type CollectionPage } from './store.js'

/** 一次请求最多改源集合的多少行（逐行写文档，同批量改值的上限） */
export const REVERSE_WRITE_MAX = 500

/** 反向关联的一次增删：link 是这个反向关联（带它镜像的正向关联），add / remove 是源集合的行 */
export type ReverseSet = { link: Link; add: string[]; remove: string[] }

export type RelationValue =
  | { ok: false; error: string }
  /** 正向关联：写进行文档的值（null = 删键） */
  | { ok: true; forward: PropValue | null }
  /** 反向关联：不写进行文档；null = 没有要改的（关联已失效时只能删，删也无事可做） */
  | { ok: true; reverse: ReverseSet | null }

/** set 里一个关联属性的值：核对另一端的活行与「只能关联一行」；关联已失效时只能清空 / 只能删 */
export async function checkRelationValue(
  pool: Pool,
  getLiveDoc: LiveDoc | undefined,
  collection: CollectionPage,
  schema: CollectionSchema,
  prop: CollectionProp,
  value: unknown,
): Promise<RelationValue> {
  const link = await relationOf(pool, getLiveDoc, collection, schema, prop)
  if (isReverseRelation(prop)) return reverseValue(pool, link, value)
  // 先去重再截：validateValue 按去重后的列表逐个核对，截在去重前的话重复项会把后面的合法 id 挤出核对范围
  const asked = Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))].slice(0, LIST_MAX + 1) : []
  if (!link && asked.length > 0) return { ok: false, error: '关联已失效' }
  const rows = new Set(link ? await membersAmong(pool, link.other.id, asked) : [])
  const checked = validateValue(prop, value, { rows })
  return checked.ok ? { ok: true, forward: checked.value } : checked
}

type Edit = { add: string[]; remove: string[] }

/** 增删里的一份 id 列表：缺省 = 空；要是非空字符串的列表、去重后 ≤ LIST_MAX */
function editList(record: object, key: 'add' | 'remove'): string[] | string {
  const raw: unknown = Object.hasOwn(record, key) ? (record as Record<string, unknown>)[key] : undefined
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string' || id === '')) return '要填行列表'
  const ids = [...new Set(raw as string[])]
  return ids.length > LIST_MAX ? `一次最多改 ${LIST_MAX} 个` : ids
}

/** 反向关联的增删：形状、上限、同一行不能既加又删；每个 id 都要是源集合的活行 */
async function reverseValue(pool: Pool, link: Link | null, value: unknown): Promise<RelationValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, error: '反向关联要写成 { add, remove }' }
  const add = editList(value, 'add')
  const remove = editList(value, 'remove')
  if (typeof add === 'string') return { ok: false, error: add }
  if (typeof remove === 'string') return { ok: false, error: remove }
  if (add.some((id) => remove.includes(id))) return { ok: false, error: '同一行不能既加又删' }
  if (!link) return add.length > 0 ? { ok: false, error: '关联已失效' } : { ok: true, reverse: null }
  const ids = [...add, ...remove]
  const live = new Set(await membersAmong(pool, link.other.id, ids))
  if (!ids.every((id) => live.has(id))) return { ok: false, error: '只能选关联的集合里的行' }
  return { ok: true, reverse: ids.length > 0 ? { link, add, remove } : null }
}

/** 源集合一行的正向关联要加 / 删哪些（本集合的行 id） */
type Change = Edit
/** 一个反向关联的写入换算：源集合的哪些行、各自怎么改 */
export type ReversePlan = { mirror: CollectionProp; changes: Map<string, Change> }

function changeOf(changes: Map<string, Change>, sourceRow: string): Change {
  let change = changes.get(sourceRow)
  if (!change) {
    change = { add: [], remove: [] }
    changes.set(sourceRow, change)
  }
  return change
}

/** 换算：targets 是本集合里被写反向值的行（每行都套同一份增删）。只读被点名的源行：已经是这样的跳过；
 *  改动的源行太多、或改完会超出正向关联的上限（只能一行的正向关联被要求同时指向两行）= 错误 */
export async function planReverse(
  pool: Pool,
  sets: ReverseSet[],
  targets: string[],
): Promise<{ ok: true; plans: ReversePlan[] } | { ok: false; error: string }> {
  const plans: ReversePlan[] = []
  const touched = new Set<string>()
  for (const set of sets) {
    const mirror = set.link.mirror!
    // 只能关联一行：源集合的一行至多出现在本集合一行的反向值里，把同一个源行加给好几行是自相矛盾的
    if (mirror.cfg.single && targets.length > 1 && set.add.length > 0) return { ok: false, error: '只能关联一行' }
    const sources = await memberRowsAmong(pool, set.link.other.id, [...set.add, ...set.remove])
    const current = new Map(sources.map((row) => [row.id, idList(readValue(mirror, row.props[mirror.id])) ?? []]))
    const changes = new Map<string, Change>()
    for (const source of set.add) {
      const has = current.get(source) ?? []
      const add = targets.filter((target) => !has.includes(target))
      if (add.length > 0) changeOf(changes, source).add.push(...add)
    }
    for (const source of set.remove) {
      const has = current.get(source) ?? []
      const remove = targets.filter((target) => has.includes(target))
      if (remove.length > 0) changeOf(changes, source).remove.push(...remove)
    }
    for (const [source, change] of changes) {
      touched.add(source)
      if (mirror.cfg.single) {
        if (change.add.length > 1) return { ok: false, error: '只能关联一行' }
        continue
      }
      const left = (current.get(source) ?? []).filter((id) => !change.remove.includes(id))
      if (new Set([...left, ...change.add]).size > LIST_MAX) return { ok: false, error: `最多选 ${LIST_MAX} 个` }
    }
    plans.push({ mirror, changes })
  }
  if (touched.size > REVERSE_WRITE_MAX) return { ok: false, error: `一次最多改 ${REVERSE_WRITE_MAX} 行` }
  return { ok: true, plans }
}

/** 按换算好的增删逐行写源集合的行文档。改动按写入那一刻文档里的值套（换算之后别人又改过也不会被覆盖掉） */
export async function writeReverse(
  write: DocWriter,
  flushRow: (rowId: string) => Promise<void>,
  user: { id: string; role: string },
  plans: ReversePlan[],
): Promise<void> {
  for (const { mirror, changes } of plans) {
    for (const [source, change] of changes) {
      await write(
        `page:${source}`,
        user,
        (doc, origin) => {
          const props = doc.getMap<unknown>('props')
          const raw = props.get(mirror.id)
          const current = idList(readValue(mirror, raw instanceof Y.AbstractType ? raw.toJSON() : raw)) ?? []
          const kept = current.filter((id) => !change.remove.includes(id))
          const next = mirror.cfg.single
            ? change.add.length > 0
              ? [change.add[0]!]
              : kept
            : [...kept, ...change.add.filter((id) => !kept.includes(id))].slice(0, LIST_MAX)
          if (next.length === current.length && next.every((id, i) => id === current[i])) return
          doc.transact(() => {
            if (next.length > 0) props.set(mirror.id, next)
            else props.delete(mirror.id)
          }, origin)
        },
        'user',
      )
      await flushRow(source)
    }
  }
}
