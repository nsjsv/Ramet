import { describe, expect, test, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import { parseCollection, type CollectionRefs, type CollectionRow, type CollectionSchema, type PropJson } from '@ramet/shared/collection-model'
import type { RowsWindow } from '@ramet/shared/collection-query'
import { mapProps } from './collections/transfer.js'
import {
  addProp,
  call,
  connect,
  delay,
  editCollection,
  eventually,
  getRows,
  newCollection,
  patchRow,
  pool,
  postCollection,
  postPage,
  postRow,
  replicaOf,
  rowDoc,
  schemaOf,
  team,
  trashRows,
  updatesOf,
  watchCollection,
  type Fixture,
  type Team,
} from './collections/test-kit.js'

// 关联与汇总（collections/computed.ts、relation-set.ts、fanout.ts、routes/collection-relations.ts）：
// 只有正向关联存值，反向关联由源集合副本倒排、汇总沿关联统计，都由服务端算好放进 row.computed；
// 两条写路径（REST / 协同直写）改正向关联、REST 改反向关联都双向生效；依赖方集合只在加载着时才跟着重算。

type Window = RowsWindow & { refs?: CollectionRefs }
type Relation = { prop: string; reverse: string | null }

function relate(cookie: string, from: string, body: Record<string, unknown>) {
  return call<Relation>('POST', `/api/collections/${from}/relations`, cookie, body)
}

async function relation(t: Team, from: string, to: string, extra: Record<string, unknown> = {}): Promise<Relation> {
  const res = await relate(t.owner.cookie, from, { name: '关联', target: to, two_way: true, ...extra })
  expect(res.status).toBe(201)
  return res.body
}

async function windowOf(cookie: string, cid: string, query: Record<string, string> = {}): Promise<Window> {
  const res = await getRows(cookie, cid, query)
  expect(res.status).toBe(200)
  return res.body as Window
}

async function computedOf(cookie: string, cid: string, rowId: string): Promise<Record<string, unknown>> {
  const row = (await windowOf(cookie, cid)).rows.find((r) => r.id === rowId)
  return row?.computed ?? {}
}

async function newRow(t: Team, cid: string, title: string, set?: Record<string, unknown>): Promise<string> {
  const res = await postRow(t.owner.cookie, cid, { title, ...(set ? { set } : {}) })
  expect(res.status).toBe(201)
  return res.body.id
}

/** 像客户端那样经协同连接改集合定义，等服务端收下 */
async function liveEdit(cid: string, cookie: string, edit: (root: Y.Map<unknown>) => void): Promise<void> {
  const doc = new Y.Doc()
  const provider = await connect(`page:${cid}`, cookie, { doc })
  doc.transact(() => edit(doc.getMap<unknown>('collection')))
  await eventually(() => expect(provider.hasUnsyncedChanges).toBe(false))
  // 断开：集合文档不因为这条连接一直加载着（扇出只算加载着的集合）
  provider.destroy()
}

/** 集合文档还没被加载时在库里加属性（刚建好的集合） */
function withProps(cid: string, props: Record<string, PropJson>): Promise<void> {
  return editCollection(cid, (root) => {
    for (const [id, json] of Object.entries(props)) addProp(root, id, json)
  })
}

function rollupProp(name: string, pos: number, cfg: Record<string, unknown>): PropJson {
  return { name, type: 'rollup', pos, cfg }
}

/** 任务（A）↔ 项目（B）：B 带「工时」「完成」两个属性 */
async function pair(t: Team, extra: Record<string, unknown> = {}): Promise<{ a: Fixture; b: Fixture; rel: Relation }> {
  const a = await newCollection(t, { title: '任务' })
  const b = await newCollection(t, { title: '项目' })
  await withProps(b.id, { num001: { name: '工时', type: 'number', pos: 5 }, chk001: { name: '完成', type: 'checkbox', pos: 6 } })
  const rel = await relation(t, a.id, b.id, extra)
  return { a, b, rel }
}

describe('关联的定义：建 / 改 / 删', () => {
  test('双向：两侧各一个属性互相记着；单向：对方集合不动；自关联：两个属性都在本集合', async () => {
    const t = await team()
    const { a, b, rel } = await pair(t, { name: '所属项目', reverse_name: '任务们', single: true })
    const sa = await schemaOf(a.id)
    const sb = await schemaOf(b.id)
    const p = sa.props.find((x) => x.id === rel.prop)!
    const q = sb.props.find((x) => x.id === rel.reverse)!
    expect(p).toMatchObject({ name: '所属项目', type: 'relation', cfg: { target: b.id, reverse: rel.reverse, single: true } })
    expect(q).toMatchObject({ name: '任务们', type: 'relation', cfg: { target: a.id, mirror: rel.prop } })

    const c = await newCollection(t, { title: '标签' })
    const one = await relation(t, a.id, c.id, { two_way: false })
    expect(one.reverse).toBeNull()
    expect((await schemaOf(c.id)).props.map((x) => x.type)).toEqual(['status'])
    // 没起名：正向缺省叫对方集合名，反向缺省叫本集合名
    const created = await relate(t.owner.cookie, c.id, { target: b.id, two_way: true })
    expect(created.status).toBe(201)
    const named = created.body
    expect((await schemaOf(c.id)).props.find((x) => x.id === named.prop)?.name).toBe('项目')
    expect((await schemaOf(b.id)).props.find((x) => x.id === named.reverse)?.name).toBe('标签')

    const self = await relation(t, a.id, a.id, { name: '子任务', reverse_name: '父任务' })
    const after = await schemaOf(a.id)
    expect(after.props.find((x) => x.id === self.prop)?.cfg).toEqual({ target: a.id, reverse: self.reverse, single: false })
    expect(after.props.find((x) => x.id === self.reverse)?.cfg).toEqual({ target: a.id, mirror: self.prop })
  })

  test('权限：viewer 403，非成员 404，目标不是集合 / 不存在 404，目标在别的空间 400；GET schema / 单行同读权限', async () => {
    const t = await team()
    const a = await newCollection(t)
    const b = await newCollection(t, { title: '项目' })
    expect((await relate(t.viewer.cookie, a.id, { target: b.id })).status).toBe(403)
    expect((await relate(t.outsider.cookie, a.id, { target: b.id })).status).toBe(404)
    expect((await relate(t.owner.cookie, a.id, { target: randomUUID() })).status).toBe(404)
    const page = await postPage(t.owner.cookie, { title: '普通页', space_id: t.spaceId })
    expect((await relate(t.owner.cookie, a.id, { target: page })).status).toBe(404)
    expect((await relate(t.owner.cookie, a.id, {})).status).toBe(400)
    // 别的空间：owner 是那边的成员也不行（400）；不是成员 404（不泄露存在性）
    const elsewhere = await postCollection(t.owner.cookie, { space_id: await personalSpace(t.owner.id), title: '别处' })
    expect(elsewhere.status).toBe(201)
    expect((await relate(t.owner.cookie, a.id, { target: elsewhere.body.id })).status).toBe(400)
    expect((await relate(t.member.cookie, a.id, { target: elsewhere.body.id })).status).toBe(404)
    expect((await schemaOf(a.id)).props.map((x) => x.type)).toEqual(['status'])

    const rel = await relation(t, a.id, b.id)
    expect((await call('PATCH', `/api/collections/${a.id}/relations/${rel.prop}`, t.viewer.cookie, { single: true })).status).toBe(403)
    expect((await call('DELETE', `/api/collections/${a.id}/relations/${rel.prop}`, t.outsider.cookie)).status).toBe(404)
    expect((await call('DELETE', `/api/collections/${a.id}/relations/nope01`, t.owner.cookie)).status).toBe(404)
    expect((await call('DELETE', `/api/collections/${a.id}/relations/${a.status.id}`, t.owner.cookie)).status).toBe(400)

    const schema = await call<{ title: string; schema: CollectionSchema }>('GET', `/api/collections/${b.id}/schema`, t.viewer.cookie)
    expect(schema.status).toBe(200)
    expect(schema.body.title).toBe('项目')
    expect(schema.body.schema.props.map((x) => x.id)).toContain(rel.reverse)
    expect((await call('GET', `/api/collections/${b.id}/schema`, t.outsider.cookie)).status).toBe(404)
    const row = await newRow(t, a.id, 'r')
    expect((await call('GET', `/api/collections/${a.id}/rows/${row}`, t.outsider.cookie)).status).toBe(404)
    expect((await call('GET', `/api/collections/${b.id}/rows/${row}`, t.owner.cookie)).status).toBe(404)
  })

  test('改：关掉 / 打开双向、换目标（旧反向删掉、新目标里建）、改只能一行；从反向那一侧关掉双向', async () => {
    const t = await team()
    const { a, b, rel } = await pair(t)
    const path = `/api/collections/${a.id}/relations/${rel.prop}`
    const off = await call<Relation>('PATCH', path, t.owner.cookie, { two_way: false })
    expect(off.body).toEqual({ prop: rel.prop, reverse: null })
    expect((await schemaOf(b.id)).props.some((x) => x.id === rel.reverse)).toBe(false)
    expect((await schemaOf(a.id)).props.find((x) => x.id === rel.prop)?.cfg).toEqual({ target: b.id, reverse: null, single: false })

    const on = await call<Relation>('PATCH', path, t.owner.cookie, { two_way: true, reverse_name: '回指', single: true })
    expect(on.body.reverse).toBeTruthy()
    expect((await schemaOf(b.id)).props.find((x) => x.id === on.body.reverse)).toMatchObject({ name: '回指', cfg: { target: a.id, mirror: rel.prop } })
    expect((await schemaOf(a.id)).props.find((x) => x.id === rel.prop)?.cfg).toEqual({ target: b.id, reverse: on.body.reverse, single: true })

    const c = await newCollection(t, { title: '别的' })
    const moved = await call<Relation>('PATCH', path, t.owner.cookie, { target: c.id })
    expect((await schemaOf(b.id)).props.some((x) => x.id === on.body.reverse)).toBe(false)
    expect((await schemaOf(c.id)).props.find((x) => x.id === moved.body.reverse)?.cfg).toEqual({ target: a.id, mirror: rel.prop })

    // 从反向那一侧：不能换目标；关掉双向 = 删掉自己、正向变单向
    const back = `/api/collections/${c.id}/relations/${moved.body.reverse}`
    expect((await call('PATCH', back, t.owner.cookie, { target: b.id })).status).toBe(400)
    expect((await call('PATCH', back, t.owner.cookie, { two_way: false })).status).toBe(200)
    expect((await schemaOf(c.id)).props.some((x) => x.id === moved.body.reverse)).toBe(false)
    expect((await schemaOf(a.id)).props.find((x) => x.id === rel.prop)?.cfg).toMatchObject({ target: c.id, reverse: null })

    // 普通属性改成关联
    const conv = await call<Relation>('PATCH', `/api/collections/${a.id}/relations/${a.status.id}`, t.owner.cookie, { target: b.id, two_way: false })
    expect(conv.status).toBe(200)
    expect((await schemaOf(a.id)).props.find((x) => x.id === a.status.id)).toMatchObject({ type: 'relation', cfg: { target: b.id, reverse: null } })
  })

  test('删：从任一侧删都删两侧；值留在行文档里', async () => {
    const t = await team()
    const { a, b, rel } = await pair(t)
    const b1 = await newRow(t, b.id, 'b1')
    const a1 = await newRow(t, a.id, 'a1', { [rel.prop]: [b1] })
    const res = await call<{ deleted: { collection: string; prop: string }[] }>('DELETE', `/api/collections/${b.id}/relations/${rel.reverse}`, t.owner.cookie)
    expect(res.body.deleted).toEqual([
      { collection: b.id, prop: rel.reverse },
      { collection: a.id, prop: rel.prop },
    ])
    expect((await schemaOf(a.id)).props.some((x) => x.id === rel.prop)).toBe(false)
    expect((await schemaOf(b.id)).props.some((x) => x.id === rel.reverse)).toBe(false)
    expect((await rowDoc(a1)).getMap('props').get(rel.prop)).toEqual([b1])
    // 集合里没有关联 / 汇总了：窗口不带 refs、行不带 computed
    const w = await windowOf(t.owner.cookie, a.id)
    expect(w.refs).toBeUndefined()
    expect(w.rows[0]?.computed).toBeUndefined()

    const again = await relation(t, a.id, b.id)
    await call('DELETE', `/api/collections/${a.id}/relations/${again.prop}`, t.owner.cookie)
    expect((await schemaOf(b.id)).props.some((x) => x.id === again.reverse)).toBe(false)
  })
})

async function personalSpace(userId: string): Promise<string> {
  const id = randomUUID()
  await pool.query('INSERT INTO spaces (id, name, owner_id, is_personal) VALUES ($1, $2, $3, false)', [id, '别的空间', userId])
  await pool.query(`INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, userId])
  return id
}

describe('双向同步', () => {
  test('REST 写正向：对方的反向值、refs、ref_titles；对方集合加载着时收到扇出的增量', async () => {
    const t = await team()
    const { a, b, rel } = await pair(t)
    const b1 = await newRow(t, b.id, 'b1')
    const b2 = await newRow(t, b.id, 'b2')
    const a1 = await newRow(t, a.id, 'a1')
    const deltas = await watchCollection(b.id, t.viewer.cookie)
    const res = await patchRow(t.member.cookie, a.id, a1, { set: { [rel.prop]: [b2, b1] } })
    expect(res.status).toBe(200)
    // 写接口返回的行也带好计算值：按目标集合的手动顺序排
    expect(res.body.computed?.[rel.prop]).toEqual([b1, b2])
    expect(res.body.ref_titles).toEqual({ [b1]: 'b1', [b2]: 'b2' })

    const w = await windowOf(t.viewer.cookie, b.id)
    expect(w.refs?.[rel.reverse!]).toEqual({ state: 'ok', target: { id: a.id, title: '任务' } })
    expect(w.rows.map((r) => [r.title, r.computed?.[rel.reverse!]])).toEqual([
      ['b1', [a1]],
      ['b2', [a1]],
    ])
    await eventually(() => {
      for (const id of [b1, b2]) {
        const last = updatesOf(deltas, id).at(-1)
        expect(last?.row.computed?.[rel.reverse!]).toEqual([a1])
        expect(last?.prev).toEqual({})
      }
    })
    // 不在目标集合里的 id：400，什么都没写
    const bad = await patchRow(t.member.cookie, a.id, a1, { set: { [rel.prop]: [randomUUID()] } })
    expect(bad.status).toBe(400)
    expect((await rowDoc(a1)).getMap('props').get(rel.prop)).toEqual([b2, b1])
  })

  test('REST 写反向（增删）：换算成源集合那几行正向关联的改动，记给发起人；源集合的观看者收到增量', async () => {
    const t = await team()
    const { a, b, rel } = await pair(t)
    const b1 = await newRow(t, b.id, 'b1')
    const b2 = await newRow(t, b.id, 'b2')
    const a1 = await newRow(t, a.id, 'a1', { [rel.prop]: [b1] })
    const a2 = await newRow(t, a.id, 'a2')
    const deltas = await watchCollection(a.id, t.viewer.cookie)
    const res = await patchRow(t.member.cookie, b.id, b2, { set: { [rel.reverse!]: { add: [a1, a2] } } })
    expect(res.status).toBe(200)
    expect(res.body.computed?.[rel.reverse!]).toEqual([a1, a2])
    // 反向值不进本行文档
    expect((await rowDoc(b2)).getMap('props').get(rel.reverse!)).toBeUndefined()
    expect((await rowDoc(a1)).getMap('props').get(rel.prop)).toEqual([b1, b2])
    expect((await rowDoc(a2)).getMap('props').get(rel.prop)).toEqual([b2])
    await eventually(() => {
      expect(updatesOf(deltas, a2).at(-1)?.row.computed?.[rel.prop]).toEqual([b2])
      expect(updatesOf(deltas, a2).at(-1)?.row.edited_by).toBe(t.member.id)
    })

    // 去掉：只删这一行，别的不动
    await patchRow(t.member.cookie, b.id, b2, { set: { [rel.reverse!]: { remove: [a1] } } })
    expect((await rowDoc(a1)).getMap('props').get(rel.prop)).toEqual([b1])
    expect((await computedOf(t.owner.cookie, b.id, b1))[rel.reverse!]).toEqual([a1])
    expect((await computedOf(t.owner.cookie, b.id, b2))[rel.reverse!]).toEqual([a2])
    // 批量改反向值 / 建行时带反向值
    const set = await call<{ rows: CollectionRow[] }>('POST', `/api/collections/${b.id}/rows/set`, t.member.cookie, {
      ids: [b1, b2],
      set: { [rel.reverse!]: { add: [a1], remove: [a2] } },
    })
    expect(set.body.rows.map((r) => r.computed?.[rel.reverse!])).toEqual([[a1], [a1]])
    expect((await rowDoc(a1)).getMap('props').get(rel.prop)).toEqual([b1, b2])
    expect((await rowDoc(a2)).getMap('props').get(rel.prop)).toBeUndefined()
    const b3 = await postRow(t.member.cookie, b.id, { title: 'b3', set: { [rel.reverse!]: { add: [a2] } } })
    expect(b3.status).toBe(201)
    expect(b3.body.computed?.[rel.reverse!]).toEqual([a2])
    expect((await rowDoc(a2)).getMap('props').get(rel.prop)).toEqual([b3.body.id])
  })

  test('反向只收增删：两个请求同时加都留下；已有一百多个反向值时照样能加一个；不合法的写法 400 且一个字都不改', async () => {
    const t = await team()
    const { a, b, rel } = await pair(t)
    const b1 = await newRow(t, b.id, 'b1')
    const b2 = await newRow(t, b.id, 'b2')
    const a1 = await newRow(t, a.id, 'a1')
    const a2 = await newRow(t, a.id, 'a2')
    const a3 = await newRow(t, a.id, 'a3')
    // 不同目标行同时给同一个源行加：源行文档按写入那一刻的值套，两次都在
    const both = await Promise.all([
      patchRow(t.member.cookie, b.id, b1, { set: { [rel.reverse!]: { add: [a1] } } }),
      patchRow(t.owner.cookie, b.id, b2, { set: { [rel.reverse!]: { add: [a1] } } }),
    ])
    expect(both.map((r) => r.status)).toEqual([200, 200])
    expect([...((await rowDoc(a1)).getMap('props').get(rel.prop) as string[])].sort()).toEqual([b1, b2].sort())
    // 同一目标行同时加不同的源行：互不覆盖（整份发的话后到的那份会冲掉先到的）
    await Promise.all([
      patchRow(t.member.cookie, b.id, b1, { set: { [rel.reverse!]: { add: [a2] } } }),
      patchRow(t.owner.cookie, b.id, b1, { set: { [rel.reverse!]: { add: [a3] } } }),
    ])
    expect([...((await computedOf(t.owner.cookie, b.id, b1))[rel.reverse!] as string[])].sort()).toEqual([a1, a2, a3].sort())

    // 已有 150 个反向值（超过单次上限）：加一个、删一个都只动被点名的那一行
    const many = 150
    await pool.query(
      `WITH g AS (SELECT gen_random_uuid()::text AS id, n FROM generate_series(1, $4::int) n),
       p AS (INSERT INTO pages (id, parent_id, owner_id, space_id, kind, title, position)
             SELECT id, $1, $2, $3, 'doc', 'row ' || n, 100 + n FROM g RETURNING id)
       INSERT INTO collection_rows (page_id, props) SELECT p.id, jsonb_build_object($5::text, jsonb_build_array($6::text)) FROM p`,
      [a.id, t.owner.id, t.spaceId, many, rel.prop, b2],
    )
    const a4 = await newRow(t, a.id, 'a4')
    const added = await patchRow(t.member.cookie, b.id, b2, { set: { [rel.reverse!]: { add: [a4] } } })
    expect(added.status).toBe(200)
    expect(added.body.computed?.[rel.reverse!]).toHaveLength(many + 2)
    expect((await rowDoc(a4)).getMap('props').get(rel.prop)).toEqual([b2])
    const removed = await patchRow(t.member.cookie, b.id, b2, { set: { [rel.reverse!]: { remove: [a1] } } })
    expect(removed.body.computed?.[rel.reverse!]).toHaveLength(many + 1)
    expect((await rowDoc(a1)).getMap('props').get(rel.prop)).toEqual([b1])

    const stranger = await newRow(t, b.id, '不是源集合的行')
    const bad: unknown[] = [
      [a2], // 整份列表
      null,
      { add: a2 },
      { add: [a2], remove: [a2] },
      { add: [stranger] },
      { remove: [randomUUID()] },
      { add: Array.from({ length: 101 }, () => randomUUID()) },
    ]
    for (const value of bad) {
      const res = await patchRow(t.member.cookie, b.id, b1, { set: { [rel.reverse!]: value, num001: 1 } })
      expect([JSON.stringify(value).slice(0, 40), res.status]).toEqual([JSON.stringify(value).slice(0, 40), 400])
    }
    expect((await rowDoc(b1)).getMap('props').get('num001')).toBeUndefined()
    expect([...((await computedOf(t.owner.cookie, b.id, b1))[rel.reverse!] as string[])].sort()).toEqual([a1, a2, a3].sort())
  })

  test('协同直写正向（行页面属性区那条路）：对方集合的反向值跟着变', async () => {
    const t = await team()
    const { a, b, rel } = await pair(t)
    const b1 = await newRow(t, b.id, 'b1')
    const a1 = await newRow(t, a.id, 'a1')
    const deltas = await watchCollection(b.id, t.owner.cookie)
    const doc = new Y.Doc()
    await connect(`page:${a1}`, t.member.cookie, { doc })
    doc.getMap<unknown>('props').set(rel.prop, [b1])
    await eventually(() => expect(updatesOf(deltas, b1).at(-1)?.row.computed?.[rel.reverse!]).toEqual([a1]))
    expect((await computedOf(t.owner.cookie, b.id, b1))[rel.reverse!]).toEqual([a1])
    doc.getMap<unknown>('props').delete(rel.prop)
    // 新旧两份 id 表的并集都重算：去掉的那一行也收到
    await eventually(() => expect(updatesOf(deltas, b1).at(-1)?.row.computed?.[rel.reverse!]).toEqual([]))
  })

  test('只能关联一行：正向多给 400；反向写入时替换；批量让同一行指向两行 400', async () => {
    const t = await team()
    const { a, b, rel } = await pair(t, { single: true })
    const b1 = await newRow(t, b.id, 'b1')
    const b2 = await newRow(t, b.id, 'b2')
    const a1 = await newRow(t, a.id, 'a1')
    expect((await patchRow(t.member.cookie, a.id, a1, { set: { [rel.prop]: [b1, b2] } })).status).toBe(400)
    await patchRow(t.member.cookie, a.id, a1, { set: { [rel.prop]: [b1] } })
    await patchRow(t.member.cookie, b.id, b2, { set: { [rel.reverse!]: { add: [a1] } } })
    expect((await rowDoc(a1)).getMap('props').get(rel.prop)).toEqual([b2])
    expect((await computedOf(t.owner.cookie, b.id, b1))[rel.reverse!]).toEqual([])
    const bulk = await call('POST', `/api/collections/${b.id}/rows/set`, t.member.cookie, { ids: [b1, b2], set: { [rel.reverse!]: { add: [a1] } } })
    expect(bulk.status).toBe(400)
    expect((await rowDoc(a1)).getMap('props').get(rel.prop)).toEqual([b2])
  })

  test('自关联（父任务 / 子任务）：同一批里两行一起更新', async () => {
    const t = await team()
    const a = await newCollection(t)
    const rel = await relation(t, a.id, a.id, { name: '子任务', reverse_name: '父任务' })
    const parent = await newRow(t, a.id, '父')
    const child = await newRow(t, a.id, '子')
    const deltas = await watchCollection(a.id, t.viewer.cookie)
    await patchRow(t.member.cookie, a.id, parent, { set: { [rel.prop]: [child] } })
    expect((await computedOf(t.owner.cookie, a.id, child))[rel.reverse!]).toEqual([parent])
    await eventually(() => {
      expect(updatesOf(deltas, parent).at(-1)?.row.computed?.[rel.prop]).toEqual([child])
      expect(updatesOf(deltas, child).at(-1)?.row.computed?.[rel.reverse!]).toEqual([parent])
    })

    // 挂在自关联上的汇总：子行改值，父行在同一批里跟着变；重算出来的行不再往外扇，增量不会自己转个不停
    await liveEdit(a.id, t.owner.cookie, (root) => {
      addProp(root, 'num001', { name: '工时', type: 'number', pos: 8 })
      addProp(root, 'sum001', rollupProp('子任务工时', 9, { relation: rel.prop, prop: 'num001', fn: 'sum' }))
      addProp(root, 'up0001', rollupProp('父任务工时', 10, { relation: rel.reverse, prop: 'num001', fn: 'sum' }))
    })
    await patchRow(t.member.cookie, a.id, child, { set: { num001: 4 } })
    await eventually(() => {
      const batch = deltas.find((d) => d.up.some((u) => u.row.id === child && u.row.props.num001 === 4))
      expect(batch?.up.find((u) => u.row.id === parent)?.row.computed?.sum001).toBe(4)
    })
    await patchRow(t.member.cookie, a.id, parent, { set: { num001: 2 } })
    await eventually(() => expect(updatesOf(deltas, child).at(-1)?.row.computed?.up0001).toBe(2))
    await delay(300)
    const settled = deltas.length
    await delay(700)
    expect(deltas.length).toBe(settled)
  })

  test('viewer 看得到关联与汇总、改不了', async () => {
    const t = await team()
    const { a, b, rel } = await pair(t)
    const b1 = await newRow(t, b.id, 'b1')
    const a1 = await newRow(t, a.id, 'a1', { [rel.prop]: [b1] })
    expect((await computedOf(t.viewer.cookie, a.id, a1))[rel.prop]).toEqual([b1])
    expect((await patchRow(t.viewer.cookie, a.id, a1, { set: { [rel.prop]: [] } })).status).toBe(403)
    expect((await patchRow(t.viewer.cookie, b.id, b1, { set: { [rel.reverse!]: { remove: [a1] } } })).status).toBe(403)
    const one = await call<{ row: CollectionRow; refs: CollectionRefs }>('GET', `/api/collections/${a.id}/rows/${a1}`, t.viewer.cookie)
    expect(one.status).toBe(200)
    expect(one.body.row.computed?.[rel.prop]).toEqual([b1])
    expect(one.body.refs[rel.prop]?.state).toBe('ok')
  })
})

describe('对方的行与集合', () => {
  test('对方行进回收站后两侧都不显示，恢复后回来', async () => {
    const t = await team()
    const { a, b, rel } = await pair(t)
    const b1 = await newRow(t, b.id, 'b1')
    const b2 = await newRow(t, b.id, 'b2')
    const a1 = await newRow(t, a.id, 'a1', { [rel.prop]: [b1, b2] })
    expect((await trashRows(t.owner.cookie, b.id, [b1])).status).toBe(200)
    expect((await computedOf(t.owner.cookie, a.id, a1))[rel.prop]).toEqual([b2])
    const trashed = (await windowOf(t.owner.cookie, a.id)).rows[0]!
    expect(trashed.ref_titles).toEqual({ [b2]: 'b2' })
    await trashRows(t.owner.cookie, a.id, [a1])
    expect((await computedOf(t.owner.cookie, b.id, b2))[rel.reverse!]).toEqual([])
    expect((await call('POST', `/api/pages/${b1}/restore`, t.owner.cookie)).status).toBe(200)
    expect((await call('POST', `/api/pages/${a1}/restore`, t.owner.cookie)).status).toBe(200)
    expect((await computedOf(t.owner.cookie, a.id, a1))[rel.prop]).toEqual([b1, b2])
    expect((await computedOf(t.owner.cookie, b.id, b2))[rel.reverse!]).toEqual([a1])
  })

  test('对方集合挪到别的空间：关联已失效（不透出对方的名字与行）、汇总为空，写只能清空；挪回来恢复', async () => {
    const t = await team()
    const { a, b, rel } = await pair(t)
    await liveEdit(a.id, t.owner.cookie, (root) => addProp(root, 'cnt001', rollupProp('数量', 9, { relation: rel.prop, prop: 'title', fn: 'count' })))
    const b1 = await newRow(t, b.id, 'b1')
    const a1 = await newRow(t, a.id, 'a1', { [rel.prop]: [b1] })
    expect((await computedOf(t.member.cookie, a.id, a1)).cnt001).toBe(1)
    const elsewhere = await personalSpace(t.owner.id)
    await pool.query('UPDATE pages SET space_id = $1 WHERE id = $2', [elsewhere, b.id])
    const w = await windowOf(t.member.cookie, a.id)
    expect(w.refs?.[rel.prop]).toEqual({ state: 'broken' })
    expect(w.refs?.cnt001).toEqual({ state: 'broken' })
    expect(w.rows[0]?.computed).toEqual({ [rel.prop]: [] })
    expect(w.rows[0]?.ref_titles).toEqual({})
    expect((await patchRow(t.member.cookie, a.id, a1, { set: { [rel.prop]: [b1] } })).status).toBe(400)
    await pool.query('UPDATE pages SET space_id = $1 WHERE id = $2', [t.spaceId, b.id])
    expect((await computedOf(t.member.cookie, a.id, a1))).toEqual({ [rel.prop]: [b1], cnt001: 1 })
  })

  test('经协同连接手写一个指向别的空间集合的关联：读不到那边的名字、行标题与汇总，那边的改动也不扇出 / reset 过来', async () => {
    const t = await team()
    const a = await newCollection(t)
    // 别的空间：只有 outsider 是成员
    const elsewhere = await personalSpace(t.outsider.id)
    const created = await postCollection(t.outsider.cookie, { space_id: elsewhere, title: '机密项目' })
    expect(created.status).toBe(201)
    const b = created.body.id
    await withProps(b, { num001: { name: '工时', type: 'number', pos: 5 } })
    const secret = await postRow(t.outsider.cookie, b, { title: '机密行', set: { num001: 5 } })
    expect(secret.status).toBe(201)
    const b1 = secret.body.id
    // REST 建不了（目标在别的空间），直接往自己集合的文档里写定义、往行文档里写值
    await liveEdit(a.id, t.owner.cookie, (root) => {
      addProp(root, 'rel001', { name: '偷看', type: 'relation', pos: 5, cfg: { target: b, reverse: null, single: false } })
      addProp(root, 'sum001', rollupProp('工时', 6, { relation: 'rel001', prop: 'num001', fn: 'sum' }))
      addProp(root, 'shw001', rollupProp('名字', 7, { relation: 'rel001', prop: 'title', fn: 'show_original' }))
    })
    const a1 = await newRow(t, a.id, 'a1')
    const doc = new Y.Doc()
    const provider = await connect(`page:${a1}`, t.owner.cookie, { doc })
    doc.getMap<unknown>('props').set('rel001', [b1])
    await eventually(async () => expect(await replicaOf(a1)).toMatchObject({ rel001: [b1] }))
    provider.destroy()
    // 这次直写自己的那条增量先发完，下面只看对方改动引起的
    await delay(300)

    const w = await windowOf(t.owner.cookie, a.id)
    expect(w.refs).toEqual({ rel001: { state: 'broken' }, sum001: { state: 'broken' }, shw001: { state: 'broken' } })
    expect(w.rows[0]?.computed).toEqual({ rel001: [] })
    expect(w.rows[0]?.ref_titles).toEqual({})
    expect(JSON.stringify(w)).not.toContain('机密')
    const one = await call('GET', `/api/collections/${a.id}/rows/${a1}`, t.owner.cookie)
    expect(one.status).toBe(200)
    expect(JSON.stringify(one.body)).not.toContain('机密')
    // 对方的集合本身：非成员一律 404
    expect((await call('GET', `/api/collections/${b}/schema`, t.owner.cookie)).status).toBe(404)
    expect((await call('GET', `/api/collections/${b}/rows/${b1}`, t.owner.cookie)).status).toBe(404)
    expect((await patchRow(t.owner.cookie, a.id, a1, { set: { rel001: [b1] } })).status).toBe(400)

    const deltas = await watchCollection(a.id, t.viewer.cookie)
    await patchRow(t.outsider.cookie, b, b1, { set: { num001: 9 } })
    await liveEdit(b, t.outsider.cookie, (root) => ((root.get('props') as Y.Map<unknown>).get('num001') as Y.Map<unknown>).set('type', 'text'))
    await delay(500)
    expect(deltas).toEqual([])
  })
})

describe('汇总', () => {
  test('各计算方式的结果；对方行改值后加载着的集合收到新值', async () => {
    const t = await team()
    const { a, b, rel } = await pair(t)
    await liveEdit(a.id, t.owner.cookie, (root) => {
      addProp(root, 'sum001', rollupProp('工时合计', 9, { relation: rel.prop, prop: 'num001', fn: 'sum' }))
      addProp(root, 'cnt001', rollupProp('数量', 10, { relation: rel.prop, prop: 'title', fn: 'count' }))
      addProp(root, 'shw001', rollupProp('项目名', 11, { relation: rel.prop, prop: 'title', fn: 'show_original' }))
      addProp(root, 'pct001', rollupProp('完成率', 12, { relation: rel.prop, prop: 'chk001', fn: 'percent_checked' }))
      // 计算方式不适用于目标类型：读成已失效
      addProp(root, 'bad001', rollupProp('坏的', 13, { relation: rel.prop, prop: 'chk001', fn: 'sum' }))
    })
    const b1 = await newRow(t, b.id, 'b1', { num001: 3, chk001: true })
    const b2 = await newRow(t, b.id, 'b2', { num001: 5 })
    const b3 = await newRow(t, b.id, 'b3')
    const a1 = await newRow(t, a.id, 'a1', { [rel.prop]: [b3, b1, b2] })
    const a2 = await newRow(t, a.id, 'a2')
    const w = await windowOf(t.owner.cookie, a.id)
    expect(w.refs?.sum001).toEqual({ state: 'ok', target: { id: b.id, title: '项目' }, prop: { type: 'number', options: [], cfg: {} } })
    expect(w.refs?.bad001).toEqual({ state: 'broken' })
    const byId = new Map(w.rows.map((r) => [r.id, r.computed]))
    expect(byId.get(a1)).toEqual({ [rel.prop]: [b1, b2, b3], sum001: 8, cnt001: 3, shw001: ['b1', 'b2', 'b3'], pct001: 1 / 3 })
    expect(byId.get(a2)).toEqual({ [rel.prop]: [], cnt001: 0 })
    // 按汇总筛选 / 排序（服务端窗口读的就是 computed）
    await liveEdit(a.id, t.owner.cookie, (root) => {
      const view = new Y.Map<unknown>()
      ;(root.get('views') as Y.Map<unknown>).set('vsum01', view)
      for (const [k, v] of Object.entries({ name: 'v', layout: 'table', pos: 9, filter: { all: [{ prop: 'sum001', op: 'gt', value: 1 }] }, sorts: [], groupBy: null, shown: null })) view.set(k, v)
      view.set('widths', new Y.Map())
    })
    expect((await windowOf(t.owner.cookie, a.id, { view: 'vsum01' })).rows.map((r) => r.id)).toEqual([a1])

    const deltas = await watchCollection(a.id, t.viewer.cookie)
    await patchRow(t.member.cookie, b.id, b2, { set: { num001: 10 } })
    await eventually(() => {
      const last = updatesOf(deltas, a1).at(-1)
      expect(last?.row.computed?.sum001).toBe(13)
      expect(last?.prev).toEqual({})
    })
    // 汇总不碰到的属性改了：不扇出
    const before = updatesOf(deltas, a1).length
    await liveEdit(b.id, t.owner.cookie, (root) => addProp(root, 'txt001', { name: '备注', type: 'text', pos: 20 }))
    await patchRow(t.member.cookie, b.id, b2, { set: { txt001: 'x' } })
    await delay(400)
    expect(updatesOf(deltas, a1)).toHaveLength(before)
  })

  test('扇出只对加载着的集合：没人看的依赖方不算', async () => {
    const t = await team()
    const { a, b, rel } = await pair(t)
    await liveEdit(a.id, t.owner.cookie, (root) => addProp(root, 'sum001', rollupProp('工时合计', 9, { relation: rel.prop, prop: 'num001', fn: 'sum' })))
    const b1 = await newRow(t, b.id, 'b1', { num001: 1 })
    await newRow(t, a.id, 'a1', { [rel.prop]: [b1] })
    // 等集合文档都卸载（建关联、加属性时加载过）
    await eventually(async () => {
      const spy = vi.spyOn(pool, 'query')
      try {
        await patchRow(t.member.cookie, b.id, b1, { set: { num001: Math.random() } })
        await delay(300)
        const linking = spy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].includes('?|'))
        expect(linking).toHaveLength(0)
      } finally {
        spy.mockRestore()
      }
    })
    // 有人看着就算
    const deltas = await watchCollection(a.id, t.viewer.cookie)
    await patchRow(t.member.cookie, b.id, b1, { set: { num001: 42 } })
    await eventually(() => expect(deltas.flatMap((d) => d.up).at(-1)?.row.computed?.sum001).toBe(42))
  })

  test('依赖的集合改了定义：加载着的依赖方收到 reset；只改视图不发', async () => {
    const t = await team()
    const { a, b, rel } = await pair(t)
    await liveEdit(a.id, t.owner.cookie, (root) => addProp(root, 'sum001', rollupProp('工时合计', 9, { relation: rel.prop, prop: 'num001', fn: 'sum' })))
    const deltas = await watchCollection(a.id, t.viewer.cookie)
    const viewId = (await schemaOf(b.id)).views[0]!.id
    await liveEdit(b.id, t.owner.cookie, (root) => ((root.get('views') as Y.Map<unknown>).get(viewId) as Y.Map<unknown>).set('name', '改名'))
    await delay(400)
    expect(deltas.some((d) => d.reset)).toBe(false)
    await liveEdit(b.id, t.owner.cookie, (root) => ((root.get('props') as Y.Map<unknown>).get('num001') as Y.Map<unknown>).set('type', 'text'))
    await eventually(() => expect(deltas.some((d) => d.reset)).toBe(true))
    expect((await windowOf(t.owner.cookie, a.id)).refs?.sum001).toEqual({ state: 'broken' })
  })

  test('扇出的量：几百行指向同一行，改它一次，依赖方一批收到全部', async () => {
    const t = await team()
    const { a, b, rel } = await pair(t)
    await liveEdit(a.id, t.owner.cookie, (root) => addProp(root, 'sum001', rollupProp('工时合计', 9, { relation: rel.prop, prop: 'num001', fn: 'sum' })))
    const b1 = await newRow(t, b.id, 'b1', { num001: 1 })
    const total = 300
    await pool.query(
      `WITH g AS (SELECT gen_random_uuid()::text AS id, n FROM generate_series(1, $4::int) n),
       p AS (INSERT INTO pages (id, parent_id, owner_id, space_id, kind, title, position)
             SELECT id, $1, $2, $3, 'doc', 'row ' || n, n FROM g RETURNING id)
       INSERT INTO collection_rows (page_id, props) SELECT p.id, jsonb_build_object($5::text, jsonb_build_array($6::text)) FROM p`,
      [a.id, t.owner.id, t.spaceId, total, rel.prop, b1],
    )
    expect((await windowOf(t.owner.cookie, b.id)).rows[0]?.computed?.[rel.reverse!]).toHaveLength(total)
    const deltas = await watchCollection(a.id, t.viewer.cookie)
    const started = Date.now()
    await patchRow(t.member.cookie, b.id, b1, { set: { num001: 7 } })
    await eventually(() => {
      const got = new Set(deltas.flatMap((d) => d.up.filter((u) => u.row.computed?.sum001 === 7).map((u) => u.row.id)))
      expect(got.size).toBe(total)
    })
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('mapProps：跨集合移动', () => {
  const T = '0b0c3c1e-6f7a-4b2c-9d8e-112233445566'
  const T2 = '1b0c3c1e-6f7a-4b2c-9d8e-112233445566'
  const schema = (props: Record<string, PropJson>) => parseCollection({ props })
  test('正向关联只在目标里同名的正向关联指向同一个目标集合时搬；反向关联与汇总不搬', () => {
    const from = schema({
      rel001: { name: '项目', type: 'relation', pos: 0, cfg: { target: T, reverse: null } },
      rel002: { name: '标签', type: 'relation', pos: 1, cfg: { target: T2, reverse: null } },
      rev001: { name: '父', type: 'relation', pos: 2, cfg: { target: T, mirror: 'xyz001' } },
      sum001: { name: '合计', type: 'rollup', pos: 3, cfg: { relation: 'rel001', prop: 'title', fn: 'count' } },
    })
    const to = schema({
      oth001: { name: '项目', type: 'relation', pos: 0, cfg: { target: T2, reverse: null } },
      dst001: { name: '项目', type: 'relation', pos: 1, cfg: { target: T, reverse: null, single: true } },
      dst002: { name: '标签', type: 'relation', pos: 2, cfg: { target: T, reverse: null } },
      dst003: { name: '父', type: 'relation', pos: 3, cfg: { target: T, mirror: 'abc001' } },
      dst004: { name: '合计', type: 'rollup', pos: 4, cfg: { relation: 'dst001', prop: 'title', fn: 'count' } },
    })
    const out = mapProps(from, to, { rel001: ['r1', 'r2'], rel002: ['x'], rev001: ['y'], sum001: 3 }, new Set())
    // 只能关联一行：按目标的定义只留第一个
    expect(out).toEqual({ dst001: ['r1'] })
  })
})
