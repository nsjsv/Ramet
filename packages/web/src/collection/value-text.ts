/* ---------- 属性值 → 一行文字（「更新」流水的属性项：「状态：未开始 → 进行中」） ----------
 * 读值一律经 readValue（同表格口径）：类型对不上、选项已删的读不出，显示「（已失效的值）」，原值不动。
 * 属性名、选项名按当前属性定义显示（服务端只给原始值）；属性已删 / 定义还没到时不解读值，只说「改了 X」。 */
import { findOption, readValue, type CollectionProp, type CollectionSchema } from '@ramet/shared/collection-model'
import type { UpdateSummaryItem } from '../api'
import { COPY } from '../copy'
import { personOf, spaceMembers } from '../people'

const H = COPY.collection.history

/** 一个非空的原始值按属性当前类型读成文字 */
export function valueText(prop: CollectionProp, raw: unknown, spaceId: string | null): string {
  const value = readValue(prop, raw)
  if (value === undefined) return H.invalid
  switch (prop.type) {
    case 'select':
    case 'status':
      return optionName(prop, String(value))
    case 'multi_select':
      return (value as string[]).map((id) => optionName(prop, id)).join('、')
    case 'person':
      return (value as string[]).map((id) => personName(spaceId, id)).join('、')
    case 'checkbox':
      return value === true ? H.yes : H.no
    default:
      return String(value)
  }
}

function optionName(prop: CollectionProp, id: string): string {
  return findOption(prop, id)?.name || H.unnamed
}

/** 人员显示名：名单没到先「…」（personOf 顺带发起取数，到了 subscribePeople 通知重画）；到了还找不到 = 已不在空间 */
function personName(spaceId: string | null, id: string): string {
  const person = personOf(spaceId, id)
  if (person) return person.username
  return spaceId && spaceMembers(spaceId) === null ? H.loadingPerson : H.unknownPerson
}

type PropItem = Extract<UpdateSummaryItem, { kind: 'prop' }>

const isEmpty = (raw: unknown): boolean => raw === null || raw === undefined

/** 属性项的一行文字。schema = null（定义还没到）只给占位「改了 属性」；属性已删给「改了 已删除的属性」 */
export function propItemText(item: PropItem, schema: CollectionSchema | null, spaceId: string | null): string {
  if (!schema) return H.touched(H.someProp)
  const prop = schema.props.find((p) => p.id === item.prop)
  if (!prop) return H.touched(H.deletedProp)
  const name = prop.name || COPY.collection.types[prop.type]
  if (isEmpty(item.from)) return H.set(name, valueText(prop, item.to, spaceId))
  if (isEmpty(item.to)) return H.clear(name, valueText(prop, item.from, spaceId))
  return H.change(name, valueText(prop, item.from, spaceId), valueText(prop, item.to, spaceId))
}

/** 摘要项排序：属性项按当前属性顺序（已删的属性排在属性项最后，服务端给的 id 序不变），其余项原样跟在后面 */
export function orderSummary<T extends UpdateSummaryItem>(items: readonly T[], schema: CollectionSchema | null): T[] {
  if (!schema) return [...items]
  const rank = new Map(schema.props.map((p, i) => [p.id, i]))
  const key = (item: T): number => (item.kind === 'prop' ? (rank.get(item.prop) ?? schema.props.length) : Number.POSITIVE_INFINITY)
  // Array.prototype.sort 是稳定排序：同键保持服务端顺序
  return [...items].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    return ka === kb ? 0 : ka < kb ? -1 : 1
  })
}
