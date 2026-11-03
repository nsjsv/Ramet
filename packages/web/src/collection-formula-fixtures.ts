/* 公式测试共用的夹具（collection-formula*.test.ts）：一份带常见属性的定义、按显示形建公式、在一行上算一个公式。
 * 不是测试文件，vitest 不会单独跑它。 */
import {
  checkFormula,
  compileFormulas,
  parseCollection,
  toStored,
  type CollectionRow,
  type CollectionSchema,
  type FormulaError,
} from '@ramet/shared/collection-model'
import { fillFormulas, type QueryCtx } from '@ramet/shared/collection-query'

export const T = '0b0c3c1e-6f7a-4b2c-9d8e-112233445566'
export const FILE_A = { id: '0b5f4a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', name: 'a.png', mime: 'image/png', size: 1 }
export const FILE_B = { id: '1c6e5b4f-2d3e-4f60-9bac-1d2e3f4a5b6c', name: 'b.pdf', mime: 'application/pdf', size: 2 }

export const BASE: Record<string, Record<string, unknown>> = {
  pri: { name: '单价', type: 'number', pos: 0 },
  qty: { name: '数量', type: 'number', pos: 1 },
  don: { name: '完成', type: 'checkbox', pos: 2 },
  beg: { name: '开始', type: 'date', pos: 3 },
  uid: { name: '编号', type: 'unique_id', pos: 4, cfg: { prefix: 'T' } },
  tag: { name: '标签', type: 'multi_select', pos: 5, options: { ta: { name: 'A', pos: 0 }, tb: { name: 'B', pos: 1 } } },
  sts: {
    name: '状态',
    type: 'status',
    pos: 6,
    options: { st: { name: '未开始', group: 'todo', pos: 0 }, sd: { name: '已完成', group: 'done', pos: 0 } },
  },
  who: { name: '负责人', type: 'person', pos: 7 },
  fil: { name: '附件', type: 'files', pos: 8 },
  sub: { name: '子任务', type: 'relation', pos: 9, cfg: { target: T, reverse: null, single: false } },
  hrs: { name: '工时', type: 'rollup', pos: 10, cfg: { relation: 'sub', prop: 'p00001', fn: 'sum' } },
  shw: { name: '子任务值', type: 'rollup', pos: 11, cfg: { relation: 'sub', prop: 'p00002', fn: 'show_original' } },
  cre: { name: '创建时间', type: 'created_time', pos: 12 },
  txt: { name: '备注', type: 'text', pos: 13 },
  cby: { name: '创建者', type: 'created_by', pos: 14 },
  lat: { name: '最晚', type: 'rollup', pos: 15, cfg: { relation: 'sub', prop: 'p00003', fn: 'latest' } },
}

/** 2026-11-02 20:00 UTC：UTC 下是 11-02，东八区已经是 11-03 */
export const NOW = Date.UTC(2026, 10, 2, 20, 0, 0)

export function mkRow(extra: Partial<CollectionRow> = {}): CollectionRow {
  return {
    id: 'r1',
    title: '任务',
    icon: null,
    props: {},
    position: null,
    created_at: '2026-11-02T08:00:00.000Z',
    edited_at: '2026-11-02T08:00:00.000Z',
    has_body: false,
    ...extra,
  }
}

/** 基础属性 + 给出的公式（显示形，按名字互相引用），经 toStored 存成存储形：集合文档里 props 的 JSON */
export function propsWith(formulas: Record<string, [string, string]>, props: Record<string, Record<string, unknown>> = BASE): Record<string, Record<string, unknown>> {
  const json: Record<string, Record<string, unknown>> = { ...props }
  let pos = 100
  for (const [id, [name]] of Object.entries(formulas)) json[id] = { name, type: 'formula', pos: pos++, cfg: { expr: '' } }
  const named = parseCollection({ props: json })
  for (const [id, [, display]] of Object.entries(formulas)) {
    const stored = toStored(display, named)
    if (!stored.ok) throw new Error(`${display}: ${stored.error.message}`)
    json[id] = { ...json[id], cfg: { expr: stored.expr } }
  }
  return json
}

export function schemaWith(formulas: Record<string, [string, string]>, props: Record<string, Record<string, unknown>> = BASE): CollectionSchema {
  return parseCollection({ props: propsWith(formulas, props) })
}

export function calc(display: string, row: Partial<CollectionRow> = {}, ctx: QueryCtx = { now: NOW }): unknown {
  const schema = schemaWith({ fx0001: ['结果', display] })
  const compiled = compileFormulas(schema).get('fx0001')!
  if (!compiled.ok) throw new Error(`${display}: ${compiled.error.message}`)
  return fillFormulas([mkRow(row)], schema, ctx)[0]!.computed?.fx0001
}

/** 存储形直接给（测语法错误等 toStored 之前就会挡掉的写法） */
export function errorOfStored(expr: string, props: Record<string, Record<string, unknown>> = BASE): FormulaError {
  const schema = parseCollection({ props: { ...props, fx0001: { name: '结果', type: 'formula', pos: 100, cfg: { expr } } } })
  const compiled = compileFormulas(schema).get('fx0001')!
  if (compiled.ok) throw new Error(`${expr} 应当编译失败`)
  return compiled.error
}

export function errorOf(display: string): FormulaError {
  const check = checkFormula(display, schemaWith({ fx0001: ['结果', '1'] }), 'fx0001')
  if (check.ok) throw new Error(`${display} 应当编译失败`)
  return check.error
}

export function typeOf(display: string): string {
  const check = checkFormula(display, schemaWith({ fx0001: ['结果', '1'] }), 'fx0001')
  if (!check.ok) throw new Error(`${display}: ${check.error.message}`)
  return check.type
}
