import { describe, expect, test } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import {
  addCol,
  addRow,
  alignColumn,
  availability,
  deleteCol,
  deleteRow,
  growCols,
  growRows,
  moveCol,
  moveRow,
  shrinkableCols,
  shrinkableRows,
  tableInfo,
  tableNode,
} from './table-ops'
import { doc, p, posOf, run, schema, stateAt } from './test-schema'
import { formatColWidths, parseColWidths, usableWidths } from './table-widths'

/* 不变量（table-ops.ts 文件头）：表头行恒在第 0 行、不能删 / 移；只剩一行正文 / 一列不能删；
 * 列宽个数随加 / 删 / 移列同事务保持与列数一致。 */

/** 3 列 × (表头 + 2 行) 的表，格里写上「r行c列」方便定位；widths 给了就带列宽 */
function sample(widths = ''): PMNode {
  const t = tableNode(schema, 3, 3)
  let r = 0
  const rows: PMNode[] = []
  t.forEach((row) => {
    const cells: PMNode[] = []
    let c = 0
    row.forEach((cell) => {
      cells.push(cell.type.create(cell.attrs, p(`r${r}c${c}`)))
      c += 1
    })
    rows.push(row.type.create(row.attrs, cells))
    r += 1
  })
  return doc(t.type.create({ ...t.attrs, colwidths: widths }, rows))
}

/** 表格各行的文字（行内用 | 连） */
function grid(d: PMNode): string[] {
  const out: string[] = []
  d.firstChild!.forEach((row) => {
    const cells: string[] = []
    row.forEach((cell) => cells.push(cell.textContent))
    out.push(cells.join('|'))
  })
  return out
}

describe('tableNode', () => {
  test('表头一行 + 正文 rows-1 行，格里是空段落', () => {
    const t = tableNode(schema, 3, 2)
    expect(t.childCount).toBe(3)
    expect(t.firstChild!.type.name).toBe('table_header_row')
    expect(t.child(1).firstChild!.type.name).toBe('table_cell')
    expect(t.child(1).firstChild!.firstChild!.type.name).toBe('paragraph')
  })
})

describe('可用性', () => {
  test('表头行：上方不能插、不能删、不能移', () => {
    const d = sample()
    const a = availability(tableInfo(stateAt(d, posOf(d, 'r0c1')))!)
    expect([a.rowAbove, a.rowDelete, a.rowUp, a.rowDown, a.rowBelow]).toEqual([false, false, false, false, true])
  })

  test('第一行正文不能上移（会顶掉表头），最后一行不能下移', () => {
    const d = sample()
    expect(availability(tableInfo(stateAt(d, posOf(d, 'r1c0')))!).rowUp).toBe(false)
    expect(availability(tableInfo(stateAt(d, posOf(d, 'r2c0')))!).rowDown).toBe(false)
  })
})

describe('行', () => {
  test('上方 / 下方插入正文行', () => {
    const d = sample()
    const above = run(stateAt(d, posOf(d, 'r1c0')), addRow('above'))!
    expect(grid(above.doc)).toEqual(['r0c0|r0c1|r0c2', '||', 'r1c0|r1c1|r1c2', 'r2c0|r2c1|r2c2'])
    const below = run(stateAt(d, posOf(d, 'r0c0')), addRow('below'))!
    expect(grid(below.doc)[1]).toBe('||')
  })

  test('新行的格抄表头同列的对齐', () => {
    const d = sample()
    const aligned = run(stateAt(d, posOf(d, 'r0c2')), alignColumn('right'))!
    const out = run(stateAt(aligned.doc, posOf(aligned.doc, 'r2c2')), addRow('below'))!
    expect(out.doc.firstChild!.child(3).child(2).attrs.alignment).toBe('right')
  })

  test('删正文行；只剩一行正文时不能删', () => {
    const d = sample()
    const once = run(stateAt(d, posOf(d, 'r1c0')), deleteRow)!
    expect(grid(once.doc)).toEqual(['r0c0|r0c1|r0c2', 'r2c0|r2c1|r2c2'])
    expect(deleteRow(stateAt(once.doc, posOf(once.doc, 'r2c0')))).toBe(false)
  })

  test('下移一行', () => {
    const d = sample()
    const out = run(stateAt(d, posOf(d, 'r1c0')), moveRow(1))!
    expect(grid(out.doc).slice(1)).toEqual(['r2c0|r2c1|r2c2', 'r1c0|r1c1|r1c2'])
  })
})

describe('列与列宽', () => {
  test('右侧插列：列宽在对应位置补一个', () => {
    const d = sample('100,200,300')
    const out = run(stateAt(d, posOf(d, 'r1c0')), addCol('right'))!
    expect(grid(out.doc)[0]).toBe('r0c0||r0c1|r0c2')
    expect(out.doc.firstChild!.attrs.colwidths).toBe('100,120,200,300')
  })

  test('删列：列宽去掉对应项；只剩一列不能删', () => {
    const d = sample('100,200,300')
    const out = run(stateAt(d, posOf(d, 'r1c1')), deleteCol)!
    expect(grid(out.doc)[0]).toBe('r0c0|r0c2')
    expect(out.doc.firstChild!.attrs.colwidths).toBe('100,300')
  })

  test('左移列：列宽跟着换位', () => {
    const d = sample('100,200,300')
    const out = run(stateAt(d, posOf(d, 'r1c2')), moveCol(-1))!
    expect(grid(out.doc)[0]).toBe('r0c0|r0c2|r0c1')
    expect(out.doc.firstChild!.attrs.colwidths).toBe('100,300,200')
  })

  test('没调过列宽：列操作不写宽度', () => {
    const d = sample()
    const out = run(stateAt(d, posOf(d, 'r1c0')), addCol('left'))!
    expect(out.doc.firstChild!.attrs.colwidths).toBe('')
  })

  test('没调过列宽 + 量出的现宽：插列时定下现宽，新列补默认宽（不让原有各列一起缩）', () => {
    const d = sample()
    const out = run(stateAt(d, posOf(d, 'r1c0')), addCol('left', [150.4, 250, 300]))!
    expect(out.doc.firstChild!.attrs.colwidths).toBe('120,150,250,300')
    // 个数对不上（量的时候表格已经变了）：照旧不写
    expect(run(stateAt(d, posOf(d, 'r1c0')), addCol('left', [150, 250]))!.doc.firstChild!.attrs.colwidths).toBe('')
  })

  test('整列对齐', () => {
    const d = sample()
    const out = run(stateAt(d, posOf(d, 'r2c1')), alignColumn('center'))!
    const aligns: unknown[] = []
    out.doc.firstChild!.forEach((row) => aligns.push(row.child(1).attrs.alignment))
    expect(aligns).toEqual(['center', 'center', 'center'])
  })
})

describe('末尾增减（底部 / 右侧「+」条）', () => {
  test('加 n 行正文：不看选区，空格抄表头对齐', () => {
    const d = sample()
    const aligned = run(stateAt(d, posOf(d, 'r0c1')), alignColumn('center'))!
    const out = run(stateAt(aligned.doc, posOf(aligned.doc, 'r0c0')), growRows(0, 2))!
    expect(grid(out.doc)).toEqual(['r0c0|r0c1|r0c2', 'r1c0|r1c1|r1c2', 'r2c0|r2c1|r2c2', '||', '||'])
    expect(out.doc.firstChild!.child(4).child(1).attrs.alignment).toBe('center')
  })

  test('加 n 列：表头行是表头格，调过列宽的补默认宽', () => {
    const d = sample('100,200,300')
    const out = run(stateAt(d, posOf(d, 'r1c0')), growCols(0, 2))!
    expect(grid(out.doc)[0]).toBe('r0c0|r0c1|r0c2||')
    expect(out.doc.firstChild!.child(0).child(4).type.name).toBe('table_header')
    expect(out.doc.firstChild!.child(1).child(4).type.name).toBe('table_cell')
    expect(out.doc.firstChild!.attrs.colwidths).toBe('100,200,300,120,120')
  })

  test('没调过列宽的表格往外拉列：定下量出的现宽再补默认宽；往回收不定宽', () => {
    const d = sample()
    const out = run(stateAt(d, posOf(d, 'r1c0')), growCols(0, 2, [150, 250, 300]))!
    expect(out.doc.firstChild!.attrs.colwidths).toBe('150,250,300,120,120')
    const wide = run(stateAt(d, posOf(d, 'r1c0')), growCols(0, 2))!.doc
    expect(run(stateAt(wide, posOf(wide, 'r1c0')), growCols(0, -1, [1, 2, 3, 4, 5]))!.doc.firstChild!.attrs.colwidths).toBe('')
  })

  test('往回收：只收末尾连续的空行，有内容的不收', () => {
    const d = run(stateAt(sample(), posOf(sample(), 'r0c0')), growRows(0, 2))!.doc
    expect(shrinkableRows(d.firstChild!)).toBe(2)
    expect(grid(run(stateAt(d, posOf(d, 'r0c0')), growRows(0, -2))!.doc)).toEqual(['r0c0|r0c1|r0c2', 'r1c0|r1c1|r1c2', 'r2c0|r2c1|r2c2'])
    expect(growRows(0, -3)(stateAt(d, posOf(d, 'r0c0')))).toBe(false)
  })

  test('往回收列：整列连表头都空才收，列宽同删', () => {
    const d = run(stateAt(sample('100,200,300'), posOf(sample(), 'r0c0')), growCols(0, 2))!.doc
    expect(shrinkableCols(d.firstChild!)).toBe(2)
    const out = run(stateAt(d, posOf(d, 'r0c0')), growCols(0, -1))!
    expect(grid(out.doc)[1]).toBe('r1c0|r1c1|r1c2|')
    expect(out.doc.firstChild!.attrs.colwidths).toBe('100,200,300,120')
    expect(shrinkableCols(sample().firstChild!)).toBe(0)
  })

  test('至少留一行正文、一列', () => {
    const t = tableNode(schema, 2, 1)
    expect(shrinkableRows(t)).toBe(0)
    expect(shrinkableCols(t)).toBe(0)
  })

  test('delta = 0 或位置不是表格：不执行', () => {
    const d = sample()
    expect(growRows(0, 0)(stateAt(d, posOf(d, 'r0c0')))).toBe(false)
    expect(growCols(1, 1)(stateAt(d, posOf(d, 'r0c0')))).toBe(false)
  })
})

describe('列宽串', () => {
  test('解析 / 格式化 / 与列数对不上按没调过', () => {
    expect(parseColWidths('120, 80')).toEqual([120, 80])
    expect(parseColWidths('a,1')).toEqual([])
    expect(formatColWidths([10.4, 200])).toBe('48,200')
    expect(usableWidths('100,200', 3)).toEqual([])
  })
})
