/* ---------- 表格的格子选区：矩形范围、复制成 TSV、粘贴解析（纯函数，TableView 用） ----------
 * 选区 = 锚点格与光标格围成的矩形（按看得见的行与显示的列算下标）。
 * 复制：每格按显示口径转文字（选项 / 人员 / 创建者给名字，文件给文件名，关联给对方行的标题，多值用「、」连；日期区间「开始 → 结束」；
 * 编号带前缀；汇总给显示的文字；公式按输出类型，粘贴不写公式），
 * TSV 与 Excel / 表格软件互通（含制表符、换行、引号的格加引号）。
 * 粘贴：一格内容贴到多格选区 = 填满选区；多格内容从选区左上角铺开，超出表格的部分丢掉（不新建行 / 列）。
 * 文字 → 值按目标属性类型解析，认不出的格跳过（不写也不清空）；空文字 = 清空。文件、关联和系统生成的类型粘贴不进去
 * （文字里没有文件；标题不唯一，认不回是哪一行）。 */
import {
  isComputedProp,
  rowValue,
  TEXT_MAX,
  TITLE_PROP_ID,
  validateValue,
  type CollectionProp,
  type CollectionRefs,
  type CollectionRow,
  type PropValue,
} from '@ramet/shared/collection-model'
import { parseNumberInput } from '../prop-meta'
import { parseDateInput } from '../../ui/date-model'
import { shownText } from '../value-text'

export type CellPos = { row: number; col: number }
export type CellBox = { r0: number; r1: number; c0: number; c1: number }

export function boxOf(a: CellPos, b: CellPos): CellBox {
  return { r0: Math.min(a.row, b.row), r1: Math.max(a.row, b.row), c0: Math.min(a.col, b.col), c1: Math.max(a.col, b.col) }
}

export const boxSize = (box: CellBox): number => (box.r1 - box.r0 + 1) * (box.c1 - box.c0 + 1)

/** 一格的文字（与格子显示同口径；空 / 读不出 = 空串）。关联给对方行的标题，汇总给显示的文字（refs = 汇总的目标属性定义） */
export function cellText(row: CollectionRow, prop: CollectionProp, spaceId: string | null, refs?: CollectionRefs | null): string {
  if (prop.id === TITLE_PROP_ID) return row.title
  const value = rowValue(row, prop)
  if (value === undefined) return ''
  // 是否类（复选框、输出是否的公式）复制成勾 / 空：贴回复选框认得出
  if (prop.type === 'checkbox' || (prop.type === 'formula' && prop.output === 'boolean')) return value === true ? CHECKED_TEXT : ''
  return shownText(prop, value, spaceId, refs)
}

const CHECKED_TEXT = '✓'

function quote(text: string): string {
  return /[\t\n\r"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toTsv(grid: readonly (readonly string[])[]): string {
  return grid.map((line) => line.map(quote).join('\t')).join('\n')
}

/** TSV → 二维文字（认 Excel 的引号写法；末尾的换行不算一行） */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let i = 0
  let quoted = false
  const src = text.replace(/\r\n?/g, '\n')
  while (i < src.length) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i += 2
        continue
      }
      if (ch === '"') quoted = false
      else cell += ch
      i++
      continue
    }
    if (ch === '"' && cell === '') quoted = true
    else if (ch === '\t') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
    i++
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/** 粘贴落到哪些格：一格内容填满选区；否则从左上角铺开，裁到表格范围内 */
export function planPaste(grid: readonly (readonly string[])[], box: CellBox, rows: number, cols: number): { row: number; col: number; text: string }[] {
  const out: { row: number; col: number; text: string }[] = []
  const single = grid.length === 1 && grid[0]!.length === 1
  if (single) {
    const text = grid[0]![0]!
    for (let r = box.r0; r <= box.r1; r++) for (let c = box.c0; c <= box.c1; c++) out.push({ row: r, col: c, text })
    return out
  }
  grid.forEach((line, i) =>
    line.forEach((text, j) => {
      const r = box.r0 + i
      const c = box.c0 + j
      if (r < rows && c < cols) out.push({ row: r, col: c, text })
    }),
  )
  return out
}

const TRUE_TEXT = new Set(['✓', '√', '✔', '☑', 'x', 'true', 'yes', 'y', '1', '是', '对', '勾选'])
const FALSE_TEXT = new Set(['false', 'no', 'n', '0', '否', '☐'])
const LIST_SPLIT = /[,，、;；\n]/

export type ParseCtx = {
  /** 选项名 → 选项 id（调用方按最新定义找，单选 / 多选找不到可以就地新建；状态不新建） */
  optionId: (prop: CollectionProp, name: string) => string | undefined
  /** 成员名 → 用户 id */
  personId: (name: string) => string | undefined
}

/** 粘贴的文字 → 属性值；null = 清空，undefined = 认不出（这一格不动）。名称列不走这里（改名） */
export function parseCell(prop: CollectionProp, text: string, ctx: ParseCtx): PropValue | null | undefined {
  if (isComputedProp(prop) || prop.type === 'files' || prop.type === 'relation' || prop.id === TITLE_PROP_ID) return undefined
  const t = text.trim()
  if (t === '') return null
  let value: unknown
  switch (prop.type) {
    case 'ai':
    case 'text':
      value = [...text].slice(0, TEXT_MAX).join('')
      break
    case 'number':
      value = parseNumberInput(t)
      break
    case 'url':
    case 'email':
    case 'phone':
      value = t
      break
    case 'date':
      value = parseDateInput(t)
      break
    case 'checkbox': {
      const k = t.toLowerCase()
      if (TRUE_TEXT.has(k)) return true
      return FALSE_TEXT.has(k) ? null : undefined
    }
    case 'select':
    case 'status':
      value = ctx.optionId(prop, t)
      break
    case 'multi_select':
    case 'person': {
      const ids = names(t)
        .map((name) => (prop.type === 'person' ? ctx.personId(name) : ctx.optionId(prop, name)))
        .filter((id): id is string => id !== undefined)
      if (ids.length === 0) return undefined
      value = [...new Set(ids)]
      break
    }
  }
  if (value === undefined || value === null) return undefined
  // 人员要成员名单才验得了：名字已经按成员找过 id，这里只验形状
  if (prop.type === 'person') return value as string[]
  const checked = validateValue(prop, value)
  return checked.ok ? checked.value : undefined
}

function names(text: string): string[] {
  return text
    .split(LIST_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}
