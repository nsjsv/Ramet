// ---------- 公式填值：给行算出每个公式的结果，写进 row.computed ----------
// 两端都在这里算（服务端窗口查询按请求的时区，客户端套增量前按本机时区），没有第二套求值。
// 公式只读本行：存储值、行元数据、服务端算好的关联 / 汇总（computed）、关联到的行的标题（ref_titles）、用户名（ctx.nameOf）。
// TODAY() / NOW() 取一次 ctx.now（缺省此刻）给整批行用；跨零点不会自己刷新，下次取数才按新的一天算。
// 依赖 collection-model 的取值（rowValue 是唯一取值入口），所以由 collection-query 导出，collection-model 不 import 这里。

import {
  dateSpan,
  epochDay,
  fileList,
  findOption,
  formatNumber,
  idList,
  rowValue,
  timeMs,
  TITLE_PROP,
  TITLE_PROP_ID,
  tzMinutes,
  type CollectionProp,
  type CollectionRow,
  type CollectionSchema,
  type PropValue,
} from '../collection-model.js'
import type { QueryCtx } from '../collection-query.js'
import { evaluate, encodeValue } from './evaluate.js'
import { dayOfMs, validDay, WORK_MAX, type EvalEnv, type FormulaDate, type FormulaValue, type Scalar } from './functions.js'
import { compileFormulas } from './index.js'
import type { Node } from './parser.js'
import type { FormulaType } from './types.js'

const PERSON_TYPES = new Set(['person', 'created_by', 'edited_by'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 时间戳 → 看的人那一天、带时刻；认不出或越界 = 空 */
function stampDate(stamp: string, tz: number): FormulaDate | null {
  const ms = timeMs(stamp)
  if (!Number.isFinite(ms)) return null
  const day = dayOfMs(ms, tz)
  return validDay(day) ? { start: day, end: day, ms } : null
}

/** 日期写法（单日 / 区间 / 时间戳）→ 日期值 */
function dateValue(raw: PropValue | undefined, tz: number): FormulaDate | null {
  if (typeof raw !== 'string') return null
  const span = dateSpan(raw)
  if (span) return { start: epochDay(span.start), end: epochDay(span.end) }
  return stampDate(raw, tz)
}

type Reader = (row: CollectionRow, prop: CollectionProp) => FormulaValue

function makeReader(ctx: QueryCtx, tz: number): Reader {
  const nameOf = (id: string): string => ctx.nameOf?.(id) ?? id
  const optionName = (prop: Pick<CollectionProp, 'options'>, id: string): string =>
    prop.options.find((option) => option.id === id)?.name ?? id
  return (row, prop) => {
    if (prop.id === TITLE_PROP_ID) return typeof row.title === 'string' && row.title !== '' ? row.title : null
    const value = rowValue(row, prop)
    switch (prop.type) {
      case 'ai':
      case 'text':
      case 'url':
      case 'email':
      case 'phone':
        return typeof value === 'string' ? value : null
      case 'number':
        return typeof value === 'number' ? value : null
      case 'unique_id':
        if (typeof value !== 'number') return null
        return prop.cfg.prefix ? formatNumber(prop, value) : value
      case 'select':
      case 'status':
        return typeof value === 'string' ? (findOption(prop, value)?.name ?? null) : null
      case 'multi_select':
        return idList(value)?.map((id) => optionName(prop, id)) ?? null
      case 'checkbox':
        return value === true
      case 'date':
      case 'created_time':
      case 'edited_time':
        return dateValue(value, tz)
      case 'person':
      case 'created_by':
      case 'edited_by':
        return idList(value)?.map(nameOf) ?? null
      case 'files':
        return fileList(value)?.map((file) => file.name) ?? null
      case 'relation': {
        const titles = isRecord(row.ref_titles) ? row.ref_titles : {}
        return idList(value)?.map((id) => (Object.hasOwn(titles, id) && typeof titles[id] === 'string' ? (titles[id] as string) : '')) ?? null
      }
      case 'rollup':
        return rollupValue(prop, value, ctx, tz, nameOf, optionName)
      case 'formula':
        // 公式引用公式由 formulaFiller 按求值顺序从本行刚算出的结果里取，不走这里
        return null
      // 按钮没有值
      case 'button':
        return null
    }
  }
}

/** 汇总在公式里的值：数字、日期照原样；逐个显示的列表把目标属性的值换成能读的字（选项名、用户名、文件名） */
function rollupValue(
  prop: CollectionProp,
  value: PropValue | undefined,
  ctx: QueryCtx,
  tz: number,
  nameOf: (id: string) => string,
  optionName: (prop: Pick<CollectionProp, 'options'>, id: string) => string,
): FormulaValue {
  if (value === undefined) return null
  if (typeof value === 'number') return value
  if (typeof value === 'string') return dateValue(value, tz)
  if (!Array.isArray(value)) return null
  const refs = ctx.refs
  const target = refs && Object.hasOwn(refs, prop.id) ? refs[prop.id]?.prop : undefined
  const items: Scalar[] = []
  for (const item of value) {
    if (typeof item === 'number' || typeof item === 'boolean') items.push(item)
    else if (typeof item === 'string') {
      if (target && target.options.length > 0) items.push(optionName(target, item))
      else if (target && PERSON_TYPES.has(target.type)) items.push(nameOf(item))
      else items.push(item)
    } else if (isRecord(item) && typeof item.name === 'string') items.push(item.name)
  }
  return items
}

type Step = { prop: CollectionProp; ast: Node; type: FormulaType }

/** 这份定义下给一行填公式的函数；没有公式 = null（行原样不动，与没有公式时逐字节一致） */
export function formulaFiller(schema: CollectionSchema, ctx: QueryCtx = {}): ((row: CollectionRow) => CollectionRow) | null {
  const compiled = compileFormulas(schema)
  if (compiled.size === 0) return null
  const byId = new Map(schema.props.map((prop) => [prop.id, prop]))
  const steps: Step[] = []
  for (const [id, c] of compiled) if (c.ok) steps.push({ prop: byId.get(id)!, ast: c.ast, type: c.type })
  const failed = [...compiled].filter(([, c]) => !c.ok).map(([id]) => id)
  const tz = tzMinutes(ctx.tzOffset)
  const now = typeof ctx.now === 'number' && Number.isFinite(ctx.now) ? ctx.now : Date.now()
  const read = makeReader(ctx, tz)
  return (row) => {
    const results = new Map<string, FormulaValue>()
    const seen = new Map<string, FormulaValue>()
    const env: EvalEnv = {
      now,
      tz,
      // 工作量按行给：同一行在服务端窗口里、客户端增量里记出的数一样，哪几格为空也一样
      work: { left: WORK_MAX },
      ref: (id) => {
        if (results.has(id)) return results.get(id)!
        if (!seen.has(id)) {
          const prop = id === TITLE_PROP_ID ? TITLE_PROP : byId.get(id)
          seen.set(id, prop ? read(row, prop) : null)
        }
        return seen.get(id)!
      },
    }
    const computed: Record<string, unknown> = isRecord(row.computed) ? { ...row.computed } : {}
    for (const step of steps) {
      const value = evaluate(step.ast, env)
      results.set(step.prop.id, value)
      const encoded = encodeValue(value, step.type)
      if (encoded === undefined) delete computed[step.prop.id]
      else computed[step.prop.id] = encoded
    }
    // 有误的公式整列为空：别留着服务端 / 旧定义算出的值
    for (const id of failed) delete computed[id]
    return { ...row, computed }
  }
}

/** 给每行算出公式的值（不改入参：有公式时返回新行，没有公式原样返回同一个数组） */
export function fillFormulas(rows: CollectionRow[], schema: CollectionSchema, ctx: QueryCtx = {}): CollectionRow[] {
  const fill = formulaFiller(schema, ctx)
  return fill ? rows.map(fill) : rows
}
