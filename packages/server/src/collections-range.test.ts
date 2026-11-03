import { describe, expect, test } from 'vitest'
import { addDays, pickView, type CollectionRow } from '@ramet/shared/collection-model'
import { joinRange, queryWindow, type RowsWindow } from '@ramet/shared/collection-query'
import {
  addProp,
  addView,
  editCollection,
  getRows,
  newCollection,
  patchRow,
  pool,
  postRow,
  schemaOf,
  team,
  windowIds,
  type Fixture,
  type Team,
} from './collections/test-kit.js'

// 按日期范围取的窗口（日历 / 时间线）：range 参数校验、窗口与 shared 现算一致、日期分散的集合只返回范围里的行

/** 集合 + 一个日期属性 + 按它排的日历视图 / 按创建时间排的时间线视图 / 没选日期属性的日历视图 */
async function dated(): Promise<{ t: Team; c: Fixture }> {
  const t = await team()
  const c = await newCollection(t)
  await editCollection(c.id, (root) => {
    addProp(root, 'pdate', { name: '日期', type: 'date', pos: 1 })
    addProp(root, 'pmade', { name: '创建时间', type: 'created_time', pos: 2 })
    addView(root, 'vcal', { layout: 'calendar', dateBy: 'pdate' })
    addView(root, 'vmade', { layout: 'timeline', dateBy: 'pmade' })
    addView(root, 'vnone', { layout: 'calendar' })
  })
  return { t, c }
}

/** 同一份数据交给 shared 现算的窗口（服务端与客户端套增量用的都是它） */
async function expected(collectionId: string, cookie: string, viewId: string, range: string, tz = 0): Promise<RowsWindow> {
  const all: CollectionRow[] = []
  let cursor: string | null = null
  do {
    const page: { body: RowsWindow } = await getRows(cookie, collectionId, { limit: '100', tz: String(tz), ...(cursor ? { cursor } : {}) })
    all.push(...page.body.rows)
    cursor = page.body.next
  } while (cursor)
  const schema = await schemaOf(collectionId)
  return queryWindow(all, pickView(schema, viewId), schema, { range, limit: 100 }, { tzOffset: tz })
}

describe('GET rows?range=', () => {
  test('range 认不出 / 反序 / 跨度超过上限 → 400；合法的与 none → 200；非成员仍是 404', async () => {
    const { t, c } = await dated()
    for (const bad of ['', 'garbage', '2026-10-31..2026-10-01', '2026-02-30..2026-03-01', '2026-01-01..2029-12-31', '2026-10-01', 'NONE']) {
      const res = await getRows(t.member.cookie, c.id, { view: 'vcal', range: bad })
      expect(res.status, bad).toBe(400)
      expect(res.body).toEqual({ error: 'invalid range' })
    }
    expect((await getRows(t.viewer.cookie, c.id, { view: 'vcal', range: '2026-10-01..2026-10-31' })).status).toBe(200)
    expect((await getRows(t.viewer.cookie, c.id, { view: 'vcal', range: 'none' })).status).toBe(200)
    expect((await getRows(t.outsider.cookie, c.id, { view: 'vcal', range: 'garbage' })).status).toBe(404)
  })

  test('日期属性：与范围有交集的单日 / 区间都在，没有日期的只在 none 里；与 shared 现算一致；改了日期立即进出', async () => {
    const { t, c } = await dated()
    const put = async (title: string, date?: string): Promise<string> => {
      const res = await postRow(t.owner.cookie, c.id, { title, ...(date ? { set: { pdate: date } } : {}) })
      expect(res.status).toBe(201)
      return res.body.id
    }
    const before = await put('之前', '2026-09-30')
    const first = await put('首日', '2026-10-01')
    const across = await put('跨月', '2026-09-28/2026-10-02')
    const inside = await put('月中', '2026-10-10/2026-10-12')
    const after = await put('之后', '2026-11-01')
    const blank = await put('没日期')
    const range = '2026-10-01..2026-10-31'

    const win = await getRows(t.member.cookie, c.id, { view: 'vcal', range })
    expect(win.status).toBe(200)
    expect(win.body.range).toBe(range)
    expect(win.body.total).toBe(3)
    expect(new Set(win.body.rows.map((r) => r.id))).toEqual(new Set([first, across, inside]))
    const shared = await expected(c.id, t.member.cookie, 'vcal', range)
    expect(win.body.rows.map((r) => r.id)).toEqual(shared.rows.map((r) => r.id))
    expect(win.body.total).toBe(shared.total)
    expect(await windowIds(t.member.cookie, c.id, { view: 'vcal', range: 'none' })).toEqual([blank])

    // 改了日期：写完立即查询就在 / 不在范围里
    expect((await patchRow(t.owner.cookie, c.id, inside, { set: { pdate: '2026-12-01' } })).status).toBe(200)
    expect((await patchRow(t.owner.cookie, c.id, after, { set: { pdate: '2026-10-31/2026-11-03' } })).status).toBe(200)
    expect((await patchRow(t.owner.cookie, c.id, blank, { set: { pdate: '2026-10-20' } })).status).toBe(200)
    expect(new Set(await windowIds(t.member.cookie, c.id, { view: 'vcal', range }))).toEqual(new Set([first, across, after, blank]))
    expect(await windowIds(t.member.cookie, c.id, { view: 'vcal', range: 'none' })).toEqual([])
    expect(await windowIds(t.member.cookie, c.id, { view: 'vcal', range: '2026-09-30..2026-09-30' })).toEqual(
      (await expected(c.id, t.member.cookie, 'vcal', '2026-09-30..2026-09-30')).rows.map((r) => r.id),
    )
    expect(before).toBeTruthy()
  })

  test('创建时间按请求的 tz 折成那一天再判（与 shared 现算一致）', async () => {
    const { t, c } = await dated()
    const a = (await postRow(t.owner.cookie, c.id, { title: 'a' })).body.id
    const b = (await postRow(t.owner.cookie, c.id, { title: 'b' })).body.id
    // UTC 10-04 20:00 = 东八区 10-05 04:00；UTC 10-05 12:00 两边都是 10-05
    await pool.query(`UPDATE pages SET created_at = '2026-10-04 20:00:00+00' WHERE id = $1`, [a])
    await pool.query(`UPDATE pages SET created_at = '2026-10-05 12:00:00+00' WHERE id = $1`, [b])
    const range = '2026-10-05..2026-10-05'
    expect(await windowIds(t.member.cookie, c.id, { view: 'vmade', range, tz: '0' })).toEqual([b])
    expect(new Set(await windowIds(t.member.cookie, c.id, { view: 'vmade', range, tz: '480' }))).toEqual(new Set([a, b]))
    for (const tz of [0, 480, -600]) {
      const server = await getRows(t.member.cookie, c.id, { view: 'vmade', range, tz: String(tz) })
      const shared = await expected(c.id, t.member.cookie, 'vmade', range, tz)
      expect(server.body.rows.map((r) => r.id)).toEqual(shared.rows.map((r) => r.id))
      expect(server.body.total).toBe(shared.total)
    }
  })

  test('视图没选日期属性：range 不生效（同 group 在没有分组时），响应也不带 range', async () => {
    const { t, c } = await dated()
    await postRow(t.owner.cookie, c.id, { title: 'a', set: { pdate: '2020-01-01' } })
    await postRow(t.owner.cookie, c.id, { title: 'b' })
    const res = await getRows(t.member.cookie, c.id, { view: 'vnone', range: '2026-10-01..2026-10-31' })
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(2)
    expect(res.body.range).toBeUndefined()
  })

  test('日期分散在 3 年里：一个月的范围只返回那个月的行（逐行与公式算出的一致），按窗口续取能取完', async () => {
    const { t, c } = await dated()
    // 「只返回范围里的行」用几百行就能断言；大集合的首屏性能由 collections-compat 的 5,000 行用例管。
    // 第 n 行的日期 = 2024-01-01 + (n * 7 mod 1096) 天；每 10 行有一行是区间（跨 5 天）
    const total = 600
    await pool.query(
      `WITH g AS (
         SELECT gen_random_uuid()::text AS id, n, DATE '2024-01-01' + ((n * 7) % 1096) AS d FROM generate_series(1, $4::int) n
       ), p AS (
         INSERT INTO pages (id, parent_id, owner_id, space_id, kind, title, position)
         SELECT id, $1, $2, $3, 'doc', 'row ' || n, n FROM g RETURNING id
       )
       INSERT INTO collection_rows (page_id, props)
       SELECT g.id, jsonb_build_object('pdate', CASE WHEN n % 10 = 0
         THEN to_char(d, 'YYYY-MM-DD') || '/' || to_char(d + 4, 'YYYY-MM-DD') ELSE to_char(d, 'YYYY-MM-DD') END)
       FROM g JOIN p ON p.id = g.id`,
      [c.id, t.owner.id, t.spaceId, total],
    )
    const from = '2025-03-01'
    const to = '2025-03-31'
    const want = new Set<string>()
    for (let n = 1; n <= total; n++) {
      const start = addDays('2024-01-01', (n * 7) % 1096)
      const end = n % 10 === 0 ? addDays(start, 4) : start
      if (start <= to && end >= from) want.add(`row ${n}`)
    }
    expect(want.size).toBeGreaterThan(10)
    const range = joinRange(from, to)
    const first = await getRows(t.member.cookie, c.id, { view: 'vcal', range, limit: '5' })
    expect(first.status).toBe(200)
    expect(first.body.total).toBe(want.size)
    const rows = [...first.body.rows]
    let cursor = first.body.next
    while (cursor) {
      const page = await getRows(t.member.cookie, c.id, { view: 'vcal', range, limit: '5', cursor })
      rows.push(...page.body.rows)
      cursor = page.body.next
    }
    expect(new Set(rows.map((r) => r.title))).toEqual(want)
    expect(rows).toHaveLength(want.size)
    const shared = await expected(c.id, t.member.cookie, 'vcal', range)
    expect(shared.total).toBe(first.body.total)
  })
})
