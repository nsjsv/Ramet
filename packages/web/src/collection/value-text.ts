/* ---------- 属性值 → 一行文字（「更新」流水的属性项：「状态：未开始 → 进行中」；表格复制也按这个口径） ----------
 * 读值一律经 readValue（同表格口径）：类型对不上、选项已删的读不出，显示「（已失效的值）」，原值不动。
 * 属性名、选项名按当前属性定义显示（服务端只给原始值）；属性已删 / 定义还没到时不解读值，只说「改了 X」。
 * 文件例外：流水里的文件只剩文件名（服务端摘要不给 id），readValue 认不出，直接读名字。
 * 关联写对方行的标题（页面列表里取，已不在的写「已不在的行」）；汇总按输出类型（列表输出按目标属性的口径，目标定义在 refs）。
 * 公式按输出类型写（公式不进流水，只有复制走到这里）。 */
import {
  fileList,
  findOption,
  formatNumber,
  formulaNumberText,
  idList,
  readValue,
  rollupOutput,
  type CollectionProp,
  type CollectionRefs,
  type CollectionSchema,
  type FormulaType,
  type PropValue,
} from '@ramet/shared/collection-model'
import type { UpdateSummaryItem } from '../api'
import { COPY } from '../copy'
import { personOf, spaceMembers } from '../people'
import { collectionPages } from './collection-store'
import { formatDate, formatStamp, formulaDate } from './prop-meta'
import { itemValue, relationText, rollupDate, rollupNumber, rollupTarget } from './relation-model'

const H = COPY.collection.history

/** 一个非空的原始值按属性当前类型读成文字 */
export function valueText(prop: CollectionProp, raw: unknown, spaceId: string | null): string {
  if (prop.type === 'files') return fileNames(raw) ?? H.invalid
  const value = readValue(prop, raw)
  return value === undefined ? H.invalid : shownText(prop, value, spaceId)
}

/** 读出来的值 → 文字（多值用「、」连）；refs = 汇总的目标属性定义（复制时从窗口来，没有就按原样写） */
export function shownText(prop: CollectionProp, value: PropValue, spaceId: string | null, refs?: CollectionRefs | null): string {
  switch (prop.type) {
    case 'relation':
      return relationText(idList(value) ?? [], collectionPages(), COPY.collection.relation.missing, COPY.untitled)
    case 'rollup':
      return rollupText(prop, value, spaceId, refs)
    case 'select':
    case 'status':
      return optionName(prop, String(value))
    case 'multi_select':
      return (idList(value) ?? []).map((id) => optionName(prop, id)).join('、')
    case 'person':
    case 'created_by':
    case 'edited_by':
      return (idList(value) ?? []).map((id) => personName(spaceId, id)).join('、')
    case 'checkbox':
      return value === true ? H.yes : H.no
    case 'date':
      return typeof value === 'string' ? formatDate(value) : String(value)
    case 'created_time':
    case 'edited_time':
      return typeof value === 'string' ? formatStamp(value) : String(value)
    case 'unique_id':
      return typeof value === 'number' ? formatNumber(prop, value) : String(value)
    case 'files':
      return (fileList(value) ?? []).map((f) => f.name).join('、')
    case 'formula':
      return formulaText(prop.output, value)
    default:
      return String(value)
  }
}

/** 公式结果的文字（格子与复制同口径）：数字最多 15 位有效数字（0.1 + 0.2 写成 0.3，同 TEXT()），日期同日期格，
 *  是否写是 / 否，列表逐项用「、」连 */
export function formulaText(output: FormulaType | null | undefined, value: PropValue): string {
  if (typeof value === 'number') return formulaNumberText(value)
  if (typeof value === 'boolean') return value ? H.yes : H.no
  if (Array.isArray(value)) return value.map((item) => (typeof item === 'object' ? item.name : formulaText(null, item))).join('、')
  return output === 'date' ? formulaDate(value) : value
}

/** 汇总值的文字：数字（占比是百分数）、日期、列表（按目标属性逐项写，用「、」连） */
function rollupText(prop: CollectionProp, value: PropValue, spaceId: string | null, refs?: CollectionRefs | null): string {
  const target = rollupTarget(refs?.[prop.id])
  switch (rollupOutput(prop.cfg.fn)) {
    case 'number':
      return typeof value === 'number' ? rollupNumber(prop.cfg.fn, value, target, COPY.collection.rollup.days) : ''
    case 'date':
      return typeof value === 'string' ? rollupDate(value) : ''
    case 'list':
      if (!Array.isArray(value)) return ''
      return value
        .map((item) => (typeof item === 'object' ? item.name : target ? shownText(target, itemValue(target, item), spaceId) : String(item)))
        .join('、')
  }
}

/** 文件列表（含流水里只剩 { name } 的）里的文件名；一个都没有 = undefined */
function fileNames(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return undefined
  const names = raw.flatMap((item: unknown) => {
    const name = typeof item === 'object' && item !== null && Object.hasOwn(item, 'name') ? (item as { name: unknown }).name : undefined
    return typeof name === 'string' && name !== '' ? [name] : []
  })
  return names.length ? names.join('、') : undefined
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
