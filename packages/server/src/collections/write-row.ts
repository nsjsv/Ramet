// ---------- 写一行的值 / 建一行（集合的 REST 与自动化的「改属性」「新建行」共用的一份实现） ----------
// 规则同 routes/collections.ts 文件头：set 的每个键都要是现有属性、每个值都过 validateValue（人员只能选空间成员，关联只能选
// 另一端集合的活行），有一个不行整个不写；值写进行文档的 Y.Map('props')、记给发起的人（'user'：快照作者与更新流水由此而来），
// 写完等副本落库再返回（写的人随后查询一定看得到），反向关联换算成源集合那几行正向关联的改动。
// 闸门（集合可写、行是这个集合的活行、邻居合法）由调用方先判：REST 按请求的人，自动化按规则主人此刻的身份。

import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import * as Y from 'yjs'
import { isPropId, validateValue, type CollectionSchema, type PropValue } from '@ramet/shared/collection-model'
import { setDocTitle, type DocWriter } from '../collab.js'
import { SET_TITLE } from '../routes/pages.js'
import type { Projector } from './projector.js'
import { checkRelationValue, planReverse, writeReverse, type ReversePlan, type ReverseSet } from './relation-set.js'
import { createRow, readSchema, spaceMembers, type CollectionPage } from './store.js'

export type RowWriteDeps = {
  pool: Pool
  write: DocWriter
  getLiveDoc: (docName: string) => Y.Doc | undefined
  projector: Pick<Projector, 'flushRow'>
}

type User = { id: string; role: string }

export type SetResult = { ok: true; values: [string, PropValue | null][]; reverse: ReverseSet[] } | { ok: false; error: Record<string, string> }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 集合有自动编号属性才取号（见 collections/store.ts 的 assignNumbers） */
export const numbered = (schema: CollectionSchema): boolean => schema.props.some((prop) => prop.type === 'unique_id')

/** set 的每个键都必须是现有属性，值都要过 validateValue。有一个不行就整个不写。反向关联的值单独收进 reverse（不写本行文档） */
export async function readSet(
  deps: Pick<RowWriteDeps, 'pool' | 'getLiveDoc'>,
  raw: unknown,
  schema: CollectionSchema,
  collection: CollectionPage,
): Promise<SetResult> {
  if (raw === undefined) return { ok: true, values: [], reverse: [] }
  if (!isRecord(raw)) return { ok: false, error: { error: 'set must be an object' } }
  const values: [string, PropValue | null][] = []
  const reverse: ReverseSet[] = []
  let members: ReadonlySet<string> | undefined
  for (const [key, value] of Object.entries(raw)) {
    // 名称不在 set 里改（它是页面标题，走 title），created_time / edited_time 由 validateValue 拒绝
    const prop = isPropId(key) ? schema.props.find((p) => p.id === key) : undefined
    if (!prop) return { ok: false, error: { error: 'unknown property', prop: key } }
    if (prop.type === 'relation') {
      const checked = await checkRelationValue(deps.pool, deps.getLiveDoc, collection, schema, prop, value)
      if (!checked.ok) return { ok: false, error: { error: 'invalid value', prop: key, message: checked.error } }
      if (!('reverse' in checked)) values.push([key, checked.forward])
      else if (checked.reverse) reverse.push(checked.reverse)
      continue
    }
    if (prop.type === 'person' && !members) members = new Set((await spaceMembers(deps.pool, collection.space_id)).keys())
    const checked = validateValue(prop, value, { members })
    if (!checked.ok) return { ok: false, error: { error: 'invalid value', prop: key, message: checked.error } }
    values.push([key, checked.value])
  }
  return { ok: true, values, reverse }
}

/** 反向关联的写入求差（targets = 被写的本集合行）；没有反向关联 = 空计划 */
export async function reversePlans(pool: Pool, set: SetResult | null, targets: string[]): Promise<{ ok: true; plans: ReversePlan[] } | { ok: false; error: string }> {
  if (!set?.ok || set.reverse.length === 0) return { ok: true, plans: [] }
  return planReverse(pool, set.reverse, targets)
}

/** 把校验过的值写进行文档的 Y.Map('props')：null 删键，与现值相同的不写（不产生没有内容变化的增量） */
export function writeProps(doc: Y.Doc, values: [string, PropValue | null][]): void {
  const props = doc.getMap<unknown>('props')
  for (const [key, value] of values) {
    if (value === null) {
      props.delete(key)
      continue
    }
    const current = props.get(key)
    if (current instanceof Y.AbstractType || JSON.stringify(current) !== JSON.stringify(value)) props.set(key, value)
  }
}

export type WriteFailure = { ok: false; error: Record<string, string> }

/** 改一行的值与标题：全部校验过才动手（非法 = 原因，文档一个字都不改）。标题同普通页面双写（文档标题片段 + pages.title），
 *  页面列表变了由调用方广播（titled = 改了标题） */
export async function writeRow(
  deps: RowWriteDeps,
  user: User,
  collection: CollectionPage,
  rowId: string,
  input: { set?: unknown; title?: string },
): Promise<{ ok: true; titled: boolean } | WriteFailure> {
  const set = input.set === undefined ? null : await readSet(deps, input.set, await readSchema(deps.pool, collection.id, deps.getLiveDoc), collection)
  if (set && !set.ok) return set
  const plans = await reversePlans(deps.pool, set, [rowId])
  if (!plans.ok) return { ok: false, error: { error: 'invalid value', message: plans.error } }
  const values = set?.values ?? []
  const title = input.title
  // 值与标题一次写进行文档，记给发起的人
  if (values.length > 0 || title !== undefined) {
    await deps.write(
      `page:${rowId}`,
      user,
      (doc, origin) => {
        doc.transact(() => {
          writeProps(doc, values)
          if (title !== undefined) setDocTitle(doc, title)
        }, origin)
      },
      'user',
    )
  }
  // 副本当场落库再返回（不等投影器的去抖）。增量照常由投影器发
  if (values.length > 0) await deps.projector.flushRow(rowId)
  await writeReverse(deps.write, deps.projector.flushRow, user, plans.plans)
  if (title !== undefined) await deps.pool.query(SET_TITLE, [title, rowId])
  return { ok: true, titled: title !== undefined }
}

/** 建一行：值的校验同 writeRow；新行的初值与建页同一事务写进副本（新行文档还没加载过，投影器看不到）。
 *  after / before 由调用方先判过；id 给了必须是还没被占用的（'taken'）。null = 集合在这期间进了回收站 */
export async function insertRow(
  deps: RowWriteDeps,
  user: User,
  collection: CollectionPage,
  input: { id?: string; title: string; set?: unknown; after: string | null; before: string | null },
): Promise<{ ok: true; id: string; renumbered: boolean } | WriteFailure | null | 'taken'> {
  const schema = await readSchema(deps.pool, collection.id, deps.getLiveDoc)
  const set = input.set === undefined ? null : await readSet(deps, input.set, schema, collection)
  if (set && !set.ok) return set
  // 带反向关联值的新行：先定下 id 才能求差（新行现在的反向值必然为空）
  const newId = input.id ?? (set?.reverse.length ? randomUUID() : undefined)
  const plans = await reversePlans(deps.pool, set, newId ? [newId] : [])
  if (!plans.ok) return { ok: false, error: { error: 'invalid value', message: plans.error } }
  const props: Record<string, PropValue> = {}
  for (const [key, value] of set?.values ?? []) if (value !== null) props[key] = value
  const created = await createRow(deps.pool, {
    ...(newId ? { id: newId } : {}),
    collectionId: collection.id,
    spaceId: collection.space_id,
    ownerId: user.id,
    title: input.title,
    props,
    after: input.after,
    before: input.before,
    numbered: numbered(schema),
  })
  if (!created || created === 'taken') return created
  await writeReverse(deps.write, deps.projector.flushRow, user, plans.plans)
  return { ok: true, ...created }
}
