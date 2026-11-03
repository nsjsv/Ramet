// ---------- store 写关联：一格的整份新值 → 发给服务端的写法与乐观的行 ----------
// 编辑器报的是一格的整份新值（同别的类型）。正向关联照常整份写（存在行文档里，≤ LIST_MAX）；
// 反向关联不存值，按这一行现在的值换算成增删发给服务端：反向值可以有几千行，整份发会超出单次上限，
// 并发时后到的整份还会把别人刚加的冲掉。乐观地直接改 computed（客户端从不自己算关联，这里只是先显示用户刚点的那一项，
// 回声到了以服务端为准）。正向关联的乐观行要删掉 computed 里这一项：rowValue 以 computed 为准，不删的话回声之前格子一直是旧值。
import {
  idList,
  isReverseRelation,
  LIST_MAX,
  rowValue,
  validateValue,
  type CollectionProp,
  type CollectionRow,
  type CollectionSchema,
  type PropValue,
  type RowUpdate,
  type ValidateResult,
} from '@ramet/shared/collection-model'
import { COPY } from '../copy'
import type { RowSet, RowWrite } from './collection-api'

/** 关联值写前的规范化：正向按定义校验形状、上限与「只能关联一行」（选的是不是对方集合的活行由服务端核对，
 *  选择器的候选本来就只有对方集合的行）；反向原样交给 splitWrite 换算 */
export function normalizeRelation(prop: CollectionProp, raw: unknown): ValidateResult {
  if (isReverseRelation(prop)) return { ok: true, value: (raw ?? null) as PropValue | null }
  const ids = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
  return validateValue(prop, raw, { rows: new Set(ids) })
}

/** 一次改值拆成三份：stored = 写进行文档的（乐观地改 props）、wire = 请求里的 set、shown = 乐观地改 computed 的（反向关联） */
export type SplitWrite = { stored: RowSet; wire: RowWrite; shown: Record<string, string[]> }

/** current = 这一行现在的样子（窗口里或属性区单独取的那份；都没有按空算）。增删超过单次上限 = 错误文字 */
export function splitWrite(schema: CollectionSchema | null, set: RowSet, current: CollectionRow | undefined): SplitWrite | string {
  const out: SplitWrite = { stored: {}, wire: {}, shown: {} }
  for (const [key, value] of Object.entries(set)) {
    const prop = schema?.props.find((p) => p.id === key)
    if (!prop || !isReverseRelation(prop)) {
      out.stored[key] = value
      out.wire[key] = value
      continue
    }
    const before = new Set((current && idList(rowValue(current, prop))) ?? [])
    const after = idList(value ?? undefined) ?? []
    const next = new Set(after)
    const add = after.filter((id) => !before.has(id))
    const remove = [...before].filter((id) => !next.has(id))
    if (add.length > LIST_MAX || remove.length > LIST_MAX) return COPY.collection.relation.tooMany(LIST_MAX)
    if (add.length === 0 && remove.length === 0) continue
    out.wire[key] = { ...(add.length > 0 ? { add } : {}), ...(remove.length > 0 ? { remove } : {}) }
    out.shown[key] = after
  }
  return out
}

/** 乐观的一行：props 套上新值（prev 只含改到的键），改过存储值的关联去掉 computed 里的旧值，反向关联的 computed 换成新值。
 *  position 缺省 = 位置不变 */
export function withValues(old: CollectionRow, stored: RowSet, shown: Record<string, string[]> = {}, position?: number): RowUpdate {
  const props = { ...old.props }
  const prev: Record<string, unknown> = {}
  let computed = old.computed
  for (const [key, value] of Object.entries(stored)) {
    prev[key] = Object.hasOwn(old.props, key) ? old.props[key] : null
    if (value === null) delete props[key]
    else props[key] = value
    if (computed && Object.hasOwn(computed, key)) {
      computed = { ...computed }
      delete computed[key]
    }
  }
  if (Object.keys(shown).length > 0) computed = { ...computed, ...shown }
  return { row: { ...old, props, ...(computed ? { computed } : {}), ...(position === undefined ? {} : { position }) }, prev }
}

/** 改值里有没有反向关联（批量改值时每行的增删不一样，要逐行发） */
export function hasReverse(schema: CollectionSchema | null, set: RowSet): boolean {
  return Object.keys(set).some((key) => schema?.props.some((p) => p.id === key && isReverseRelation(p)) === true)
}
