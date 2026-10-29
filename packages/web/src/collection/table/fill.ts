/* ---------- 表格的填充柄：选区右下角的小方块，按住往下 / 往上拖，把选区的内容按列填进拖过的行（纯函数，TableView 用） ----------
 * 只沿竖直方向填（拖到选区左右两侧不算）；拖回选区里面 = 不填。
 * 每一列各算各的（同 Excel）：
 * · 数字 / 日期列，选区里这一列有两格及以上、都有值、且等差（日期按天）→ 顺着这个步长续成序列（往上拖就往回减）
 * · 其余一律按选区里的值循环复制（往上拖时也保持同一周期，紧挨选区的那一格是选区最近一端的值）
 * 名称列复制标题（改名）；计算列（创建 / 编辑时间）不填。 */
import { isCalendarDate, rowValue, TITLE_PROP_ID, type CollectionProp, type CollectionRow, type PropValue } from '@ramet/shared/collection-model'
import { isComputed } from '../prop-meta'
import type { CellBox } from './cell-range'

/** 拖过的行（看得见的行的下标，闭区间；不含选区本身） */
export type FillSpan = { r0: number; r1: number }

/** 鼠标停在第 at 行时要填哪些行：选区下方 / 上方的那一段，停在选区里 = null */
export function fillSpan(box: CellBox, at: number): FillSpan | null {
  if (at > box.r1) return { r0: box.r1 + 1, r1: at }
  if (at < box.r0) return { r0: at, r1: box.r0 - 1 }
  return null
}

/** 一格的写入：名称列是标题字符串，其余是属性值（null = 清空） */
export type FillWrite = { row: number; col: number; value: PropValue | null }

/** 选区 + 拖过的行 → 每一格写什么（只给拖过的行；计算列跳过） */
export function planFill(rows: readonly CollectionRow[], cols: readonly CollectionProp[], box: CellBox, span: FillSpan): FillWrite[] {
  const out: FillWrite[] = []
  const n = box.r1 - box.r0 + 1
  for (let c = box.c0; c <= box.c1; c++) {
    const prop = cols[c]
    if (!prop || isComputed(prop.type)) continue
    const src: (PropValue | undefined)[] = []
    for (let r = box.r0; r <= box.r1; r++) {
      const row = rows[r]
      src.push(row ? (prop.id === TITLE_PROP_ID ? row.title : rowValue(row, prop)) : undefined)
    }
    const series = seriesOf(prop, src)
    for (let r = span.r0; r <= span.r1; r++) {
      if (!rows[r]) continue
      // k = 相对选区第一格的偏移（往上拖是负的）
      const k = r - box.r0
      const value = series ? series(k) : src[((k % n) + n) % n]
      if (value === null) continue // 序列越界（日期超出 0001–9999）：这一格不动
      out.push({ row: r, col: c, value: value ?? (prop.id === TITLE_PROP_ID ? '' : null) })
    }
  }
  return out
}

/** 等差序列：第 k 格（相对选区第一格）的值；不成序列 = null */
function seriesOf(prop: CollectionProp, src: readonly (PropValue | undefined)[]): ((k: number) => PropValue | null) | null {
  if (src.length < 2 || prop.id === TITLE_PROP_ID) return null
  if (prop.type === 'number') {
    if (!src.every((v): v is number => typeof v === 'number')) return null
    const nums = src as number[]
    const step = nums[1]! - nums[0]!
    if (!steady(nums, step)) return null
    // 按源值与步长里最多的小数位取整：0.1 + 0.2 不出 0.30000000000000004
    const digits = Math.max(...nums.map(decimals), decimals(step))
    return (k) => round(nums[0]! + k * step, digits)
  }
  if (prop.type === 'date') {
    if (!src.every((v): v is string => typeof v === 'string' && isCalendarDate(v))) return null
    const days = (src as string[]).map(dayOf)
    const step = days[1]! - days[0]!
    if (!steady(days, step)) return null
    return (k) => {
      const iso = new Date((days[0]! + k * step) * DAY).toISOString().slice(0, 10)
      return isCalendarDate(iso) ? iso : null
    }
  }
  return null
}

const DAY = 86_400_000
const dayOf = (iso: string): number => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY)

function steady(values: readonly number[], step: number): boolean {
  const eps = 1e-9 * Math.max(1, ...values.map(Math.abs))
  return values.every((v, i) => i === 0 || Math.abs(v - values[i - 1]! - step) <= eps)
}

function decimals(n: number): number {
  const s = String(n)
  if (s.includes('e')) return 0
  return s.split('.')[1]?.length ?? 0
}

function round(n: number, digits: number): number {
  const v = Number(n.toFixed(Math.min(digits, 12)))
  return v === 0 ? 0 : v
}
