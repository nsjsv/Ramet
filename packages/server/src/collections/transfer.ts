// ---------- 行挪到别的集合时的属性对应（rows/move） ----------
// 源属性对应目标里「同名（trim 后全等）且同类型」的第一个属性（schema.props 已按 pos 排好）；
// 单选 / 状态 / 多选的值是选项 id，按选项名换成目标的选项 id；对不上的值丢弃，不在目标集合自动建属性 / 选项。
// 最后一律过 validateValue（人员只认目标空间成员——同空间才能挪，实际等价），不通过的也丢。
// 其余存储类型（文本、数字、日期含区间、邮箱、电话、文件…）按值原样搬；系统生成的类型（创建者、编号…）与汇总不在行文档里，
// 万一有脏键也过不了 validateValue，天然不搬 —— 编号由目标集合重新取号（collections/store.ts 的 moveRowsTo）。
// 关联：只有正向关联存值，且只在目标里同名的正向关联指向同一个目标集合时才搬（对方行 id 只在那个集合里有意义）；
// 反向关联的值是倒排算出来的，从不搬。行 id 不在这里核对是不是对方的活行：读时由计算值过滤（computed.ts）。

import {
  findOption,
  idList,
  isReverseRelation,
  readValue,
  validateValue,
  type CollectionProp,
  type CollectionSchema,
  type PropValue,
} from '@ramet/shared/collection-model'

/** 目标属性能不能接源属性的值：同类型；关联还要都是正向、指向同一个目标集合 */
function accepts(from: CollectionProp, to: CollectionProp): boolean {
  if (from.type !== to.type) return false
  if (from.type !== 'relation') return true
  return !isReverseRelation(from) && !isReverseRelation(to) && !!from.cfg.target && from.cfg.target === to.cfg.target
}

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
    const dst = to.props.find((p) => accepts(src, p) && p.name.trim() === name && out[p.id] === undefined)
    if (!dst) continue
    if (dst.type === 'relation') {
      // 按目标的定义读（「只能关联一行」时只留第一个）
      const ids = idList(readValue(dst, value))
      if (ids) out[dst.id] = ids
      continue
    }
    const checked = validateValue(dst, convert(src, dst, value), { members })
    if (checked.ok && checked.value !== null) out[dst.id] = checked.value
  }
  return out
}
