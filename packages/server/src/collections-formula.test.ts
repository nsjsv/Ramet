import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { pickView, toStored, type CollectionRefs, type CollectionRow, type CollectionSchema, type PropJson } from '@ramet/shared/collection-model'
import { applyRowsDelta, fillFormulas, queryWindow, type RowsWindow } from '@ramet/shared/collection-query'
import {
  addProp,
  addView,
  call,
  connect,
  editCollection,
  eventually,
  getRows,
  newCollection,
  patchRow,
  postRow,
  schemaOf,
  team,
  updatesOf,
  watchCollection,
  type Team,
} from './collections/test-kit.js'

// 公式（shared 的 collection-formula/）：服务端窗口查询开头按请求的 tz 算一遍（queryWindow 里的 fillFormulas），
// 筛选排序读的就是这些值；增量里的行不带公式值，客户端拿同一个函数在套增量前重算。

type Window = RowsWindow & { refs?: CollectionRefs }

async function windowOf(cookie: string, cid: string, query: Record<string, string> = {}): Promise<Window> {
  const res = await getRows(cookie, cid, query)
  expect(res.status).toBe(200)
  return res.body as Window
}

/** 像客户端那样经协同连接改集合定义，等服务端收下再断开 */
async function liveEdit(cid: string, cookie: string, edit: (root: Y.Map<unknown>) => void): Promise<void> {
  const doc = new Y.Doc()
  const provider = await connect(`page:${cid}`, cookie, { doc })
  doc.transact(() => edit(doc.getMap<unknown>('collection')))
  await eventually(() => expect(provider.hasUnsyncedChanges).toBe(false))
  provider.destroy()
}

/** 公式属性：显示形按当前定义换成存储形 */
function formula(schema: CollectionSchema, name: string, display: string, pos: number): PropJson {
  const stored = toStored(display, schema)
  if (!stored.ok) throw new Error(`${display}: ${stored.error.message}`)
  return { name, type: 'formula', pos, cfg: { expr: stored.expr } }
}

async function newRow(t: Team, cid: string, title: string, set?: Record<string, unknown>): Promise<string> {
  const res = await postRow(t.owner.cookie, cid, { title, ...(set ? { set } : {}) })
  expect(res.status).toBe(201)
  return res.body.id
}

/** 比顺序与算出的值（编辑时间 / 最后编辑者这些元数据在存储钩子落库前后会变，不比） */
const shape = (rows: CollectionRow[]) => rows.map((r) => [r.id, r.computed])

/** 客户端那一侧：拿掉公式值，按同一份 shared 函数现算 */
function strip(rows: CollectionRow[], schema: CollectionSchema): CollectionRow[] {
  const formulas = new Set(schema.props.filter((p) => p.type === 'formula').map((p) => p.id))
  return rows.map((row) => ({ ...row, computed: Object.fromEntries(Object.entries(row.computed ?? {}).filter(([k]) => !formulas.has(k))) }))
}

describe('按公式筛选 / 排序的窗口', () => {
  test('数字 / 文本 / 是否 / 日期公式：服务端窗口与 shared 现算一致；写公式 400', async () => {
    const t = await team()
    const c = await newCollection(t)
    await editCollection(c.id, (root) => {
      addProp(root, 'pri001', { name: '单价', type: 'number', pos: 1 })
      addProp(root, 'qty001', { name: '数量', type: 'number', pos: 2 })
      addProp(root, 'don001', { name: '完成', type: 'checkbox', pos: 3 })
      addProp(root, 'beg001', { name: '开始', type: 'date', pos: 4 })
    })
    const base = await schemaOf(c.id)
    await editCollection(c.id, (root) => {
      addProp(root, 'tot001', formula(base, '总价', '[单价] * [数量]', 10))
      addProp(root, 'lab001', formula(base, '标记', 'IF([完成], "✅", "⏳") & [名称]', 11))
      addProp(root, 'due001', formula(base, '到期', 'DATEADD([开始], 7, "D")', 12))
      addProp(root, 'big001', formula(base, '大单', '[单价] * [数量] >= 10', 13))
      addView(root, 'vtot01', { filter: { all: [{ prop: 'tot001', op: 'gt', value: 5 }] }, sorts: [{ prop: 'tot001', dir: 'desc' }] })
      addView(root, 'vdue01', { filter: { all: [{ prop: 'due001', op: 'before', value: '2026-10-20' }] }, sorts: [{ prop: 'lab001', dir: 'asc' }] })
      addView(root, 'vbig01', { filter: { all: [{ prop: 'big001', op: 'checked' }, { prop: 'lab001', op: 'contains', value: '✅' }] } })
    })
    const r1 = await newRow(t, c.id, '甲', { pri001: 3, qty001: 4, don001: true, beg001: '2026-10-01' })
    const r2 = await newRow(t, c.id, '乙', { pri001: 2, qty001: 2, beg001: '2026-10-10' })
    const r3 = await newRow(t, c.id, '丙', { pri001: 10, qty001: 1, don001: true })
    const r4 = await newRow(t, c.id, '丁', { pri001: 1, qty001: 7, beg001: '2026-11-01' })

    const all = await windowOf(t.owner.cookie, c.id)
    const byId = new Map(all.rows.map((r) => [r.id, r.computed]))
    expect(byId.get(r1)).toEqual({ tot001: 12, lab001: '✅甲', due001: '2026-10-08', big001: true })
    expect(byId.get(r3)).toEqual({ tot001: 10, lab001: '✅丙', big001: true })

    expect((await windowOf(t.owner.cookie, c.id, { view: 'vtot01' })).rows.map((r) => r.id)).toEqual([r1, r3, r4])
    expect((await windowOf(t.owner.cookie, c.id, { view: 'vdue01' })).rows.map((r) => r.id).sort()).toEqual([r1, r2].sort())
    expect((await windowOf(t.owner.cookie, c.id, { view: 'vbig01' })).rows.map((r) => r.id)).toEqual([r1, r3])

    // 客户端拿同一份 shared 函数现算：同样的行、同样的顺序、同样的值
    const schema = await schemaOf(c.id)
    for (const view of ['vtot01', 'vdue01', 'vbig01']) {
      const server = await windowOf(t.owner.cookie, c.id, { view, tz: '480' })
      const local = queryWindow(strip(all.rows, schema), pickView(schema, view), schema, {}, { tzOffset: 480 })
      expect(shape(server.rows)).toEqual(shape(local.rows))
      expect(server.total).toBe(local.total)
    }

    const res = await patchRow(t.owner.cookie, c.id, r1, { set: { tot001: 1 } })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: 'invalid value', prop: 'tot001', message: '这个属性自动生成，不能改' })
  })

  test('按请求的时区算：创建时间折成看的人的那一天', async () => {
    const t = await team()
    const c = await newCollection(t)
    await editCollection(c.id, (root) => addProp(root, 'cre001', { name: '创建时间', type: 'created_time', pos: 1 }))
    const base = await schemaOf(c.id)
    await editCollection(c.id, (root) => addProp(root, 'day001', formula(base, '那天', 'TEXT([创建时间])', 2)))
    const row = await newRow(t, c.id, '甲')
    const schema = await schemaOf(c.id)
    for (const tz of ['840', '-720', '0']) {
      const got = (await windowOf(t.owner.cookie, c.id, { tz })).rows.find((r) => r.id === row)!
      const local = fillFormulas(strip([got], schema), schema, { tzOffset: Number(tz) })[0]!
      expect(got.computed?.day001).toBe(local.computed?.day001)
    }
    const east = (await windowOf(t.owner.cookie, c.id, { tz: '840' })).rows[0]!.computed?.day001
    const west = (await windowOf(t.owner.cookie, c.id, { tz: '-720' })).rows[0]!.computed?.day001
    expect(east).not.toBe(west)
  })

  test('人员类属性在公式里是用户名（服务端查成员名单）', async () => {
    const t = await team()
    const c = await newCollection(t)
    await editCollection(c.id, (root) => {
      addProp(root, 'who001', { name: '负责人', type: 'person', pos: 1 })
      addProp(root, 'cby001', { name: '创建者', type: 'created_by', pos: 2 })
    })
    const base = await schemaOf(c.id)
    await editCollection(c.id, (root) => addProp(root, 'nam001', formula(base, '名单', 'JOIN([负责人], ",") & "|" & JOIN([创建者])', 3)))
    const row = await newRow(t, c.id, '甲', { who001: [t.member.id, t.owner.id] })
    const got = (await windowOf(t.viewer.cookie, c.id)).rows.find((r) => r.id === row)!
    expect(got.computed?.nam001).toBe(`${t.member.name},${t.owner.name}|${t.owner.name}`)
  })

  test('写坏的公式（超长、超深、循环、引用已删的属性）不影响窗口，整列为空', async () => {
    const t = await team()
    const c = await newCollection(t)
    await editCollection(c.id, (root) => {
      addProp(root, 'num001', { name: '数', type: 'number', pos: 1 })
      addProp(root, 'bad001', { name: '超长', type: 'formula', pos: 2, cfg: { expr: '1+'.repeat(3000) + '1' } })
      addProp(root, 'bad002', { name: '超深', type: 'formula', pos: 3, cfg: { expr: '('.repeat(500) + '1' + ')'.repeat(500) } })
      addProp(root, 'bad003', { name: '甲', type: 'formula', pos: 4, cfg: { expr: '[@bad004] + 1' } })
      addProp(root, 'bad004', { name: '乙', type: 'formula', pos: 5, cfg: { expr: '[@bad003] + 1' } })
      addProp(root, 'bad005', { name: '已删', type: 'formula', pos: 6, cfg: { expr: '[@gone01] * 2' } })
      addProp(root, 'ok0001', { name: '好的', type: 'formula', pos: 7, cfg: { expr: '[@num001] * 2' } })
      addView(root, 'vbad01', { filter: { all: [{ prop: 'bad003', op: 'gt', value: 1 }] }, sorts: [{ prop: 'bad001', dir: 'asc' }] })
    })
    const row = await newRow(t, c.id, '甲', { num001: 4 })
    const w = await windowOf(t.owner.cookie, c.id)
    expect(w.rows.find((r) => r.id === row)?.computed).toEqual({ ok0001: 8 })
    // 有误公式上的条件 / 排序不参与（运算对不上输出类型，解析时丢掉）
    expect((await windowOf(t.owner.cookie, c.id, { view: 'vbad01' })).rows.map((r) => r.id)).toEqual([row])
  })

  test('对长文本连写几百次文字处理：这一行的工作量用完，那几格为空，窗口照常返回', async () => {
    const t = await team()
    const c = await newCollection(t)
    let hostile = 'LEN([@txt001])'
    while (hostile.length < 1980) hostile += '+LEN([@txt001])'
    await editCollection(c.id, (root) => {
      addProp(root, 'txt001', { name: '备注', type: 'text', pos: 1 })
      addProp(root, 'ok0001', { name: '字数', type: 'formula', pos: 2, cfg: { expr: 'LEN([@txt001])' } })
      addProp(root, 'big001', { name: '很多', type: 'formula', pos: 3, cfg: { expr: hostile } })
      addProp(root, 'big002', { name: '更多', type: 'formula', pos: 4, cfg: { expr: hostile } })
    })
    const long = await newRow(t, c.id, '长', { txt001: 'x'.repeat(2000) })
    const short = await newRow(t, c.id, '短', { txt001: 'ab' })
    const w = await windowOf(t.owner.cookie, c.id)
    const terms = hostile.split('+').length
    expect(w.rows.find((r) => r.id === long)?.computed).toEqual({ ok0001: 2000 })
    expect(w.rows.find((r) => r.id === short)?.computed).toEqual({ ok0001: 2, big001: 2 * terms, big002: 2 * terms })
  })
})

describe('公式引用关联 / 汇总', () => {
  async function pair(t: Team) {
    const a = await newCollection(t, { title: '任务' })
    const b = await newCollection(t, { title: '项目' })
    await editCollection(b.id, (root) => addProp(root, 'num001', { name: '工时', type: 'number', pos: 5 }))
    const res = await call<{ prop: string; reverse: string | null }>('POST', `/api/collections/${a.id}/relations`, t.owner.cookie, {
      name: '项目',
      target: b.id,
      two_way: false,
    })
    expect(res.status).toBe(201)
    return { a, b, rel: res.body.prop }
  }

  test('关联在公式里是对方行的标题；汇总改了，增量里带新的汇总值，客户端套增量时用同一个函数重算公式', async () => {
    const t = await team()
    const { a, b, rel } = await pair(t)
    await liveEdit(a.id, t.owner.cookie, (root) => {
      addProp(root, 'sum001', { name: '工时合计', type: 'rollup', pos: 9, cfg: { relation: rel, prop: 'num001', fn: 'sum' } })
    })
    const withRollup = await schemaOf(a.id)
    await liveEdit(a.id, t.owner.cookie, (root) => {
      addProp(root, 'dbl001', formula(withRollup, '两倍', '[工时合计] * 2', 10))
      addProp(root, 'nam001', formula(withRollup, '项目们', 'COUNT([项目]) & ":" & JOIN([项目], "/")', 11))
      addView(root, 'vdbl01', { filter: { all: [{ prop: 'dbl001', op: 'gt', value: 8 }] } })
    })
    const b1 = await newRow(t, b.id, 'b1', { num001: 3 })
    const b2 = await newRow(t, b.id, 'b2', { num001: 1 })
    const a1 = await newRow(t, a.id, 'a1', { [rel]: [b2, b1] })
    const schema = await schemaOf(a.id)
    const view = pickView(schema, 'vdbl01')

    const all = await windowOf(t.owner.cookie, a.id)
    expect(all.rows.find((r) => r.id === a1)?.computed).toMatchObject({ sum001: 4, dbl001: 8, nam001: '2:b1/b2' })
    let client = await windowOf(t.viewer.cookie, a.id, { view: 'vdbl01' })
    expect(client.rows).toEqual([])

    const deltas = await watchCollection(a.id, t.viewer.cookie)
    expect((await patchRow(t.member.cookie, b.id, b1, { set: { num001: 5 } })).status).toBe(200)
    await eventually(() => expect(updatesOf(deltas, a1).at(-1)?.row.computed?.sum001).toBe(6))
    // 增量里的行带着新的汇总值、不带公式值（公式由客户端算）
    const last = updatesOf(deltas, a1).at(-1)!
    expect(last.prev).toEqual({})
    expect(last.row.computed?.dbl001).toBeUndefined()
    for (const delta of deltas) client = applyRowsDelta(client, delta, view, schema)
    expect(client.rows.map((r) => r.id)).toEqual([a1])
    expect(client.rows[0]!.computed?.dbl001).toBe(12)
    expect(client.total).toBe(1)
    // 与服务端窗口一致
    expect(shape((await windowOf(t.viewer.cookie, a.id, { view: 'vdbl01' })).rows)).toEqual(shape(client.rows))
  })

  test('汇总不能以公式为目标（读成已失效）', async () => {
    const t = await team()
    const { a, b, rel } = await pair(t)
    await liveEdit(b.id, t.owner.cookie, (root) => addProp(root, 'fml001', { name: '算的', type: 'formula', pos: 6, cfg: { expr: '[@num001] * 2' } }))
    await liveEdit(a.id, t.owner.cookie, (root) => {
      addProp(root, 'sum001', { name: '合计', type: 'rollup', pos: 9, cfg: { relation: rel, prop: 'fml001', fn: 'sum' } })
    })
    const b1 = await newRow(t, b.id, 'b1', { num001: 3 })
    await newRow(t, a.id, 'a1', { [rel]: [b1] })
    const w = await windowOf(t.owner.cookie, a.id)
    expect(w.refs?.sum001).toEqual({ state: 'broken' })
    expect(w.rows[0]?.computed?.sum001).toBeUndefined()
  })
})
