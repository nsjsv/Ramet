/* ---------- 格子选区上的批量动作：复制、粘贴、清空 / 剪切、填充、选区编辑（TableView 的 ⌘C / ⌘V / ⌘X / 退格 / 填充柄） ----------
 * 动作只算「格子变更」清单（行、属性、改前、改后；值没变的格不进清单），统一经 applyChanges 写：
 * 属性值按「同一份 set 的行」攒成批（setValuesMany，一次乐观、按上限分批），名称列逐行改名。
 * 清单原样进 TableView 的撤销栈（table/undo.ts）：撤销 = 按「改前」再写一遍。
 * 粘贴到单选 / 多选时没有的选项名就地新建（写集合文档，同单元格选择器里敲新名字）；状态不新建。
 * 粘贴超出末行：允许续行时把多出来的行作为新行交回调用方建（同 Notion / 表格软件）。 */
import { readValue, rowValue, TITLE_PROP_ID, type CollectionProp, type CollectionRow, type PropValue } from '@ramet/shared/collection-model'
import { spaceMembers } from '../../people'
import type { NewRowInput, RowSet } from '../collection-api'
import type { CollectionHandle } from '../collection-store'
import { isComputed, nextColor } from '../prop-meta'
import { addOption } from '../schema-ops'
import { cellText, parseCell, parseTsv, planPaste, toTsv, type CellBox, type ParseCtx } from './cell-range'
import { planFill, type FillSpan } from './fill'

type Grid = { handle: CollectionHandle; rows: readonly CollectionRow[]; cols: readonly CollectionProp[]; box: CellBox; spaceId: string | null }

/** 一格的改动：名称列的值是标题字符串，其余是属性值（null = 空） */
export type CellChange = { rowId: string; propId: string; before: PropValue | null; after: PropValue | null }

const writable = (prop: CollectionProp): boolean => prop.id !== TITLE_PROP_ID && !isComputed(prop.type)

/** 存着的值（撤销写回它；状态没设过 = null，不是显示出来的默认选项） */
const storedOf = (row: CollectionRow, prop: CollectionProp): PropValue | null =>
  prop.id === TITLE_PROP_ID ? row.title : (readValue(prop, Object.hasOwn(row.props, prop.id) ? row.props[prop.id] : undefined) ?? null)

/** 这一格改成 after；显示出来没变 = null（状态清空仍显示默认选项，不算改动） */
function changeOf(row: CollectionRow, prop: CollectionProp, after: PropValue | null): CellChange | null {
  if (prop.id === TITLE_PROP_ID) {
    const title = typeof after === 'string' ? after : ''
    return title === row.title ? null : { rowId: row.id, propId: prop.id, before: row.title, after: title }
  }
  const next = { ...row, props: { ...row.props, [prop.id]: after } }
  if (JSON.stringify(rowValue(next, prop)) === JSON.stringify(rowValue(row, prop))) return null
  return { rowId: row.id, propId: prop.id, before: storedOf(row, prop), after }
}

const compact = (list: (CellChange | null)[]): CellChange[] => list.filter((c): c is CellChange => c !== null)

export function copyBox({ rows, cols, box, spaceId }: Grid): string {
  const grid: string[][] = []
  for (let r = box.r0; r <= box.r1; r++) {
    const row = rows[r]
    if (!row) continue
    grid.push(cols.slice(box.c0, box.c1 + 1).map((prop) => cellText(row, prop, spaceId)))
  }
  return toTsv(grid)
}

/** 几行的同一列都写成 value（编辑一格 / 选区里编辑一格） */
export function setCells(rows: readonly CollectionRow[], prop: CollectionProp, value: PropValue | null): CellChange[] {
  return compact(rows.map((row) => changeOf(row, prop, value)))
}

/** 退格 / 剪切：选区里可写的属性全部清空（名称不清） */
export function clearBox({ rows, cols, box }: Grid): CellChange[] {
  const props = cols.slice(box.c0, box.c1 + 1).filter(writable)
  return compact(rows.slice(box.r0, box.r1 + 1).flatMap((row) => props.map((prop) => changeOf(row, prop, null))))
}

/** 粘贴：changes = 已有行的改动；extra = 超出末行的部分（allowExtra 时）作为新行；area = 落到的范围（选区跟着扩过去）；
 *  recognized = 至少有一格认得出（值没变也算）——选择器里粘贴靠它决定是写格子还是照旧贴进筛选框 */
export function pasteBox(
  { handle, rows, cols, box, spaceId }: Grid,
  text: string,
  allowExtra: boolean,
): { changes: CellChange[]; extra: NewRowInput[]; area: CellBox | null; recognized: boolean } {
  const grid = parseTsv(text)
  if (grid.length === 0) return { changes: [], extra: [], area: null, recognized: false }
  const people = (spaceId ? spaceMembers(spaceId) : null) ?? []
  const ctx: ParseCtx = {
    optionId: (prop, name) => {
      // 按最新定义找：同一次粘贴里前面刚建的选项后面要认得
      const current = handle.schema()?.props.find((p) => p.id === prop.id) ?? prop
      const hit = current.options.find((o) => o.name === name)
      if (hit) return hit.id
      if (prop.type === 'status') return undefined
      return addOption(handle.doc, prop.id, name, nextColor(current.options.map((o) => o.color))) ?? undefined
    },
    personId: (name) => people.find((p) => p.username === name)?.id,
  }
  const changes: (CellChange | null)[] = []
  let recognized = false
  const plan = planPaste(grid, box, rows.length, cols.length)
  for (const at of plan) {
    const row = rows[at.row]
    const prop = cols[at.col]
    if (!row || !prop) continue
    if (prop.id === TITLE_PROP_ID) {
      recognized = true
      changes.push(changeOf(row, prop, at.text.trim()))
      continue
    }
    const value = parseCell(prop, at.text, ctx)
    if (value === undefined) continue
    recognized = true
    changes.push(changeOf(row, prop, value))
  }
  const extra: NewRowInput[] = []
  const single = grid.length === 1 && grid[0]!.length === 1
  if (allowExtra && !single) {
    for (const line of grid.slice(Math.max(0, rows.length - box.r0))) {
      const input: NewRowInput = {}
      const set: RowSet = {}
      line.forEach((text, j) => {
        const prop = cols[box.c0 + j]
        if (!prop) return
        if (prop.id === TITLE_PROP_ID) input.title = text.trim()
        else {
          const value = parseCell(prop, text, ctx)
          if (value !== undefined && value !== null) set[prop.id] = value
        }
      })
      extra.push(Object.keys(set).length > 0 ? { ...input, set } : input)
    }
  }
  let area: CellBox | null = null
  for (const at of plan) {
    area = area
      ? { r0: Math.min(area.r0, at.row), r1: Math.max(area.r1, at.row), c0: Math.min(area.c0, at.col), c1: Math.max(area.c1, at.col) }
      : { r0: at.row, r1: at.row, c0: at.col, c1: at.col }
  }
  return { changes: compact(changes), extra, area, recognized: recognized || extra.length > 0 }
}

/** 填充柄松手：选区的内容按列填进拖过的行（planFill 决定每格写什么） */
export function fillBox({ rows, cols, box }: Grid, span: FillSpan): CellChange[] {
  const out: (CellChange | null)[] = []
  for (const at of planFill(rows, cols, box, span)) {
    const row = rows[at.row]
    const prop = cols[at.col]
    if (!row || !prop) continue
    out.push(changeOf(row, prop, prop.id === TITLE_PROP_ID && typeof at.value === 'string' ? at.value.trim() : at.value))
  }
  return compact(out)
}

/** 把一份清单按「改后」（做 / 重做）或「改前」（撤销）写进去 */
export function applyChanges(handle: CollectionHandle, changes: readonly CellChange[], side: 'before' | 'after'): void {
  const sets = new Map<string, RowSet>()
  for (const change of changes) {
    const value = change[side]
    if (change.propId === TITLE_PROP_ID) {
      void handle.renameRow(change.rowId, typeof value === 'string' ? value : '')
      continue
    }
    const set = sets.get(change.rowId) ?? {}
    set[change.propId] = value
    sets.set(change.rowId, set)
  }
  writeSets(handle, sets)
}

/** 清单涉及的格子在表格里围成的矩形（不在看得见的行 / 显示的列里的格不算；一格都不在 = null） */
export function changesBox(changes: readonly CellChange[], rowIndex: ReadonlyMap<string, number>, cols: readonly CollectionProp[]): CellBox | null {
  let box: CellBox | null = null
  for (const change of changes) {
    const r = rowIndex.get(change.rowId)
    const c = cols.findIndex((p) => p.id === change.propId)
    if (r === undefined || c < 0) continue
    box = box ? { r0: Math.min(box.r0, r), r1: Math.max(box.r1, r), c0: Math.min(box.c0, c), c1: Math.max(box.c1, c) } : { r0: r, r1: r, c0: c, c1: c }
  }
  return box
}

/** 每行一份 set → 值完全相同的行合成一批（填满选区 / 单格填充时就是一批） */
function writeSets(handle: CollectionHandle, sets: Map<string, RowSet>): void {
  const batches = new Map<string, { set: RowSet; ids: string[] }>()
  for (const [rowId, set] of sets) {
    const key = JSON.stringify(Object.entries(set).sort(([a], [b]) => (a < b ? -1 : 1)))
    const batch = batches.get(key) ?? { set, ids: [] }
    batch.ids.push(rowId)
    batches.set(key, batch)
  }
  for (const { set, ids } of batches.values()) {
    if (ids.length === 1) void handle.setValues(ids[0]!, set)
    else void handle.setValuesMany(ids, set)
  }
}
