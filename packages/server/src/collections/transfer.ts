// ---------- 行挪到别的集合时的属性对应（rows/move） ----------
// 源属性对应目标里「同名（trim 后全等）且同类型」的第一个属性（schema.props 已按 pos 排好）；
// 单选 / 状态 / 多选的值是选项 id，按选项名换成目标的选项 id；对不上的值丢弃，不在目标集合自动建属性 / 选项。
// 最后一律过 validateValue（人员只认目标空间成员——同空间才能挪，实际等价），不通过的也丢。

import { findOption, validateValue, type CollectionProp, type CollectionSchema, type PropValue } from '@ramet/shared/collection-model'

/** 源选项 id → 目标同名选项 id；对不上 = undefined */
function optionIn(from: CollectionProp, to: CollectionProp, id: unknown): string | undefined {
  if (typeof id !== 'string') return undefined
  const name = findOption(from, id)?.name
  return name === undefined ? undefined : to.options.find((o) => o.name === name)?.id
}

function convert(from: CollectionProp, to: CollectionProp, value: unknown): unknown {
  if (to.type === 'select' || to.type === 'status') return optionIn(from, to, value) ?? null
  if (to.type === 'multi_select') {
    if (!Array.isArray(value)) return null
    const ids = [...new Set(value.map((id) => optionIn(from, to, id)).filter((id): id is string => id !== undefined))]
    return ids.length > 0 ? ids : null
  }
  return value
}

/** 一行的属性值（行文档 Y.Map('props') 的 JSON）按目标集合的定义改写；返回只含有值的键 */
export function mapProps(
  from: CollectionSchema,
  to: CollectionSchema,
  props: Record<string, unknown>,
  members: ReadonlySet<string>,
): Record<string, PropValue> {
  const out: Record<string, PropValue> = {}
  for (const [key, value] of Object.entries(props)) {
    const src = from.props.find((p) => p.id === key)
    if (!src) continue
    const name = src.name.trim()
    const dst = to.props.find((p) => p.type === src.type && p.name.trim() === name && out[p.id] === undefined)
    if (!dst) continue
    const checked = validateValue(dst, convert(src, dst, value), { members })
    if (checked.ok && checked.value !== null) out[dst.id] = checked.value
  }
  return out
}
