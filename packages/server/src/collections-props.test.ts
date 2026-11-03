import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { formatNumber, parseCollection, type CollectionRow, type PropJson } from '@ramet/shared/collection-model'
import { mapProps } from './collections/transfer.js'
import { propDiff, schemaDiff } from './updates.js'
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
  pool,
  postPage,
  postRow,
  replicaOf,
  rowDoc,
  schemaOf,
  team,
  trashRows,
  updatesOf,
  watchCollection,
  type Team,
} from './collections/test-kit.js'

/* 集合的新属性类型：邮箱、电话、文件、日期区间（存储值）与创建者、最后编辑者、自动编号（行元数据）。
 * 不变量：非法值 400 且文档与副本都不动；系统生成的类型一律写不进；元数据只由服务端给，窗口与增量同一口径；
 * 编号在集合里只增不减、不复用，取号按创建先后，挪到别的集合在目标里取新号 */

const FILE_A = { id: '0b5f4a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', name: '设计稿.png', mime: 'image/png', size: 1024 }
const FILE_B = { id: '1c6e5b4f-2d3e-4f60-9bac-1d2e3f4a5b6c', name: '说明.pdf', mime: 'application/pdf', size: 2048 }

const PROPS: Record<string, PropJson> = {
  eml: { name: '邮箱', type: 'email', pos: 1 },
  tel: { name: '电话', type: 'phone', pos: 2 },
  fil: { name: '附件', type: 'files', pos: 3 },
  dat: { name: '日期', type: 'date', pos: 4 },
  cby: { name: '创建者', type: 'created_by', pos: 5 },
  eby: { name: '最后编辑者', type: 'edited_by', pos: 6 },
  uid: { name: '编号', type: 'unique_id', pos: 7, cfg: { prefix: 'TASK' } },
}

/** 一个带全部新类型属性的集合（属性在任何连接打开集合文档之前写进库里） */
async function collectionWith(t: Team, props: Record<string, PropJson> = PROPS, title = '任务') {
  const c = await newCollection(t, { title })
  await editCollection(c.id, (root) => {
    for (const [id, json] of Object.entries(props)) addProp(root, id, json)
  })
  return c
}

async function windowRows(cookie: string, cid: string, query: Record<string, string> = {}): Promise<CollectionRow[]> {
  const res = await getRows(cookie, cid, query)
  expect(res.status).toBe(200)
  return res.body.rows
}

const numbersOf = (rows: CollectionRow[]): Record<string, number | null | undefined> =>
  Object.fromEntries(rows.map((r) => [r.title, r.number]))

describe('校验：非法值 400 且未改动，系统生成的类型写不进', () => {
  test('邮箱 / 电话 / 文件 / 日期区间的非法值整个请求 400，文档与副本都不动', async () => {
    const t = await team()
    const c = await collectionWith(t)
    const row = (await postRow(t.owner.cookie, c.id, { title: 'r', set: { eml: 'a@b.co' } })).body
    const bad: Record<string, unknown>[] = [
      { eml: 'not-an-email' },
      { eml: 'a@b' },
      { eml: `${'x'.repeat(320)}@b.co` },
      { tel: '12' },
      { tel: '138-0000-abcd' },
      { tel: '1'.repeat(51) },
      { fil: [{ ...FILE_A, id: 'not-a-uuid' }] },
      { fil: [{ ...FILE_A, id: FILE_A.id.toUpperCase() }] },
      { fil: [{ ...FILE_A, name: '' }] },
      { fil: [{ ...FILE_A, name: '换\n行' }] },
      { fil: [{ ...FILE_A, size: -1 }] },
      { fil: [{ ...FILE_A, size: 1.5 }] },
      { fil: Array.from({ length: 21 }, (_, i) => ({ ...FILE_A, id: FILE_A.id.slice(0, -2) + String(i).padStart(2, '0') })) },
      { fil: FILE_A },
      { dat: '2026-02-30' },
      { dat: '2026-10-01/2026-13-01' },
      { dat: '2026-10-01/' },
      { dat: '2026-10-01 → 2026-10-05' },
      { eml: 'ok@b.co', tel: 'bad' },
    ]
    for (const set of bad) {
      const res = await patchRow(t.member.cookie, c.id, row.id, { set })
      expect(res.status, JSON.stringify(set)).toBe(400)
    }
    expect(await replicaOf(row.id)).toEqual({ eml: 'a@b.co' })
    expect((await rowDoc(row.id)).getMap('props').toJSON()).toEqual({ eml: 'a@b.co' })
    // 批量改值同样整批不写
    const bulk = await call('POST', `/api/collections/${c.id}/rows/set`, t.member.cookie, { ids: [row.id], set: { dat: '2026-02-30' } })
    expect(bulk.status).toBe(400)
  })

  test('创建者 / 最后编辑者 / 编号：建行与改值都 400「自动生成，不能改」', async () => {
    const t = await team()
    const c = await collectionWith(t)
    const row = (await postRow(t.owner.cookie, c.id, { title: 'r' })).body
    for (const set of [{ cby: [t.member.id] }, { eby: [t.member.id] }, { uid: 7 }]) {
      const res = await patchRow(t.member.cookie, c.id, row.id, { set })
      expect(res.status).toBe(400)
      expect(res.body).toMatchObject({ error: 'invalid value', message: '这个属性自动生成，不能改' })
    }
    expect((await postRow(t.owner.cookie, c.id, { set: { uid: 1 } })).status).toBe(400)
    expect(await replicaOf(row.id)).toEqual({})
  })

  test('合法值按规范写法落库：邮箱去空白、区间开始晚于结束交换、起止同一天写成单日、文件只留四个字段并按 id 去重', async () => {
    const t = await team()
    const c = await collectionWith(t)
    const row = (await postRow(t.owner.cookie, c.id, { title: 'r' })).body
    const res = await patchRow(t.member.cookie, c.id, row.id, {
      set: {
        eml: '  amy@example.com ',
        tel: ' +86 (010) 1234-5678 转 8 ',
        dat: '2026-10-10/2026-10-01',
        fil: [{ ...FILE_A, extra: 'x' }, FILE_B, { ...FILE_A, name: '重复的' }],
      },
    })
    expect(res.status).toBe(200)
    const expected = {
      eml: 'amy@example.com',
      tel: '+86 (010) 1234-5678 转 8',
      dat: '2026-10-01/2026-10-10',
      fil: [FILE_A, FILE_B],
    }
    expect(res.body.props).toEqual(expected)
    expect(await replicaOf(row.id)).toEqual(expected)
    expect((await patchRow(t.member.cookie, c.id, row.id, { set: { dat: '2026-10-03/2026-10-03' } })).body.props.dat).toBe('2026-10-03')
    // 空串 / 空列表 = 删键
    expect((await patchRow(t.member.cookie, c.id, row.id, { set: { eml: ' ', fil: [] } })).body.props).toEqual({
      tel: expected.tel,
      dat: '2026-10-03',
    })
  })

  test('服务端窗口按区间语义筛选、按开始日排序，编号按数字排序', async () => {
    const t = await team()
    const c = await collectionWith(t)
    await editCollection(c.id, (root) => {
      addView(root, 'inrange', { filter: { all: [{ prop: 'dat', op: 'eq', value: '2026-10-05' }] }, sorts: [{ prop: 'dat', dir: 'asc' }] })
      addView(root, 'before', { filter: { all: [{ prop: 'dat', op: 'before', value: '2026-10-05' }] } })
      addView(root, 'bynum', { sorts: [{ prop: 'uid', dir: 'desc' }] })
    })
    for (const [title, dat] of [
      ['区间', '2026-10-01/2026-10-10'],
      ['当天', '2026-10-05'],
      ['之前', '2026-10-01/2026-10-04'],
      ['之后', '2026-10-06'],
    ]) {
      expect((await postRow(t.owner.cookie, c.id, { title, set: { dat } })).status).toBe(201)
    }
    expect((await windowRows(t.viewer.cookie, c.id, { view: 'inrange' })).map((r) => r.title)).toEqual(['区间', '当天'])
    expect((await windowRows(t.viewer.cookie, c.id, { view: 'before' })).map((r) => r.title)).toEqual(['之前'])
    expect((await windowRows(t.viewer.cookie, c.id, { view: 'bynum' })).map((r) => r.title)).toEqual(['之后', '之前', '当天', '区间'])
  })
})

describe('创建者 / 最后编辑者', () => {
  test('创建者 = 建行的人；还没被编辑过的行，最后编辑者也是他', async () => {
    const t = await team()
    const c = await collectionWith(t)
    const created = (await postRow(t.member.cookie, c.id, { title: 'r' })).body
    expect(created).toMatchObject({ created_by: t.member.id, edited_by: t.member.id, edited_agent: null })
    expect((await windowRows(t.viewer.cookie, c.id))[0]).toMatchObject({ created_by: t.member.id, edited_by: t.member.id })
  })

  test('REST 改值：增量里立即是改的人，窗口在存储之后也是', async () => {
    const t = await team()
    const c = await collectionWith(t)
    const row = (await postRow(t.member.cookie, c.id, { title: 'r' })).body
    const deltas = await watchCollection(c.id, t.viewer.cookie)
    expect((await patchRow(t.owner.cookie, c.id, row.id, { set: { eml: 'a@b.co' } })).status).toBe(200)
    await eventually(() => expect(updatesOf(deltas, row.id).at(-1)?.row).toMatchObject({ edited_by: t.owner.id, created_by: t.member.id }))
    await eventually(async () => expect((await windowRows(t.viewer.cookie, c.id))[0]?.edited_by).toBe(t.owner.id))
  })

  test('改值同时挪位置（看板拖到别的列）：改值与顺序两条增量同批合并后仍是改的人', async () => {
    const t = await team()
    const c = await collectionWith(t)
    const a = (await postRow(t.member.cookie, c.id, { title: 'a' })).body
    const b = (await postRow(t.member.cookie, c.id, { title: 'b' })).body
    const deltas = await watchCollection(c.id, t.viewer.cookie)
    // 有人开着这一行的页面也一样：REST 写经直连写完即存储，顺序增量取行时最后编辑者已经落库
    await connect(`page:${b.id}`, t.viewer.cookie, { doc: new Y.Doc() })
    expect((await patchRow(t.owner.cookie, c.id, b.id, { set: { eml: 'a@b.co' }, before: a.id })).status).toBe(200)
    await eventually(() => expect(updatesOf(deltas, b.id).at(-1)?.row).toMatchObject({ props: { eml: 'a@b.co' }, edited_by: t.owner.id }))
  })

  test('行页面属性区（协同连接直写）：增量里立即是改的人（库里还没落），窗口在存储之后也是', async () => {
    const t = await team()
    const c = await collectionWith(t)
    const row = (await postRow(t.owner.cookie, c.id, { title: 'r' })).body
    const deltas = await watchCollection(c.id, t.viewer.cookie)
    const doc = new Y.Doc()
    await connect(`page:${row.id}`, t.member.cookie, { doc })
    doc.getMap<unknown>('props').set('tel', '010-1234')
    // 连接还开着，存储钩子要等改动停 ~2s 才跑：这时增量里的 member 只能来自投影器记下的归属（库里会回落成建行的 owner）
    await eventually(() => expect(updatesOf(deltas, row.id).at(-1)?.row.edited_by).toBe(t.member.id))
    await eventually(async () => expect((await windowRows(t.viewer.cookie, c.id))[0]?.edited_by).toBe(t.member.id))
  })

  test('agent 改的带 agent 名；编辑者账号删了不回落成建行的人', async () => {
    const t = await team()
    const c = await collectionWith(t)
    const row = (await postRow(t.owner.cookie, c.id, { title: 'r' })).body
    await pool.query(
      `INSERT INTO edit_marks (page_id, block_id, user_id, actor, actor_agent, edited_at) VALUES ($1, '', $2, 'agent', 'claude', now())`,
      [row.id, t.member.id],
    )
    expect((await windowRows(t.viewer.cookie, c.id))[0]).toMatchObject({ edited_by: t.member.id, edited_agent: 'claude' })
    await pool.query(`UPDATE edit_marks SET user_id = NULL, actor = 'user', actor_agent = NULL WHERE page_id = $1`, [row.id])
    expect((await windowRows(t.viewer.cookie, c.id))[0]).toMatchObject({ edited_by: null, edited_agent: null })
  })
})

describe('自动编号', () => {
  test('加编号属性后老行按创建先后得到 1..n，新行接着编号；没有编号属性的集合不取号', async () => {
    const t = await team()
    const c = await newCollection(t)
    for (const title of ['一', '二', '三']) await postRow(t.owner.cookie, c.id, { title })
    expect(Object.values(numbersOf(await windowRows(t.owner.cookie, c.id)))).toEqual([null, null, null])
    expect((await pool.query('SELECT 1 FROM collection_row_numbers')).rows).toHaveLength(0)

    await editCollection(c.id, (root) => addProp(root, 'uid', PROPS.uid!))
    expect(numbersOf(await windowRows(t.viewer.cookie, c.id))).toEqual({ 一: 1, 二: 2, 三: 3 })
    expect((await postRow(t.member.cookie, c.id, { title: '四' })).body.number).toBe(4)
    const prop = (await schemaOf(c.id)).props.find((p) => p.id === 'uid')!
    expect(prop.cfg).toEqual({ prefix: 'TASK' })
    expect(formatNumber(prop, 4)).toBe('TASK-4')
  })

  test('同时建行号码不重复、连续；复制出来的行也取号', async () => {
    const t = await team()
    const c = await collectionWith(t)
    const made = await Promise.all(Array.from({ length: 8 }, (_, i) => postRow(i % 2 ? t.owner.cookie : t.member.cookie, c.id, { title: `r${i}` })))
    const numbers = made.map((res) => {
      expect(res.status).toBe(201)
      return res.body.number
    })
    expect([...numbers].sort((a, b) => a! - b!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    const dup = await call<{ created: { id: string }[] }>('POST', `/api/collections/${c.id}/rows/duplicate`, t.owner.cookie, { ids: [made[0]!.body.id] })
    expect(dup.status).toBe(201)
    const copy = (await windowRows(t.owner.cookie, c.id)).find((r) => r.id === dup.body.created[0]!.id)
    expect(copy?.number).toBe(9)
  })

  test('回收再恢复号码不变；回收 / 物理删除的号不再发出去', async () => {
    const t = await team()
    const c = await collectionWith(t)
    const ids: string[] = []
    for (const title of ['一', '二', '三']) ids.push((await postRow(t.owner.cookie, c.id, { title })).body.id)
    expect((await trashRows(t.owner.cookie, c.id, [ids[1]])).status).toBe(200)
    expect((await postRow(t.owner.cookie, c.id, { title: '四' })).body.number).toBe(4)
    expect((await call('POST', `/api/pages/${ids[1]}/restore`, t.owner.cookie, {})).status).toBe(200)
    expect(numbersOf(await windowRows(t.owner.cookie, c.id))).toEqual({ 一: 1, 二: 2, 三: 3, 四: 4 })
    await pool.query('DELETE FROM pages WHERE id = $1', [ids[2]])
    expect((await postRow(t.owner.cookie, c.id, { title: '五' })).body.number).toBe(5)
  })

  test('不经建行接口进集合的行在下次查询时补号', async () => {
    const t = await team()
    const c = await collectionWith(t)
    await postRow(t.owner.cookie, c.id, { title: '一' })
    const page = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '拖进来的' })
    expect((await call('PATCH', `/api/pages/${page}`, t.owner.cookie, { parent_id: c.id })).status).toBe(200)
    expect(numbersOf(await windowRows(t.viewer.cookie, c.id))).toEqual({ 一: 1, 拖进来的: 2 })
  })

  test('挪到别的集合：在目标里取新号；目标没有编号属性就没有号，原集合的号不跟过去', async () => {
    const t = await team()
    const c = await collectionWith(t)
    const dest = await collectionWith(t, { uid: PROPS.uid! }, '目标')
    const plain = await newCollection(t, { title: '没编号' })
    await postRow(t.owner.cookie, dest.id, { title: '目标的第一行' })
    const ids: string[] = []
    for (const title of ['一', '二']) ids.push((await postRow(t.owner.cookie, c.id, { title })).body.id)

    const move = (from: string, to: string, id: string) =>
      call('POST', `/api/collections/${from}/rows/move`, t.owner.cookie, { ids: [id], to })
    expect((await move(c.id, dest.id, ids[1]!)).status).toBe(200)
    expect(numbersOf(await windowRows(t.owner.cookie, dest.id))).toEqual({ 目标的第一行: 1, 二: 2 })
    expect((await move(c.id, plain.id, ids[0]!)).status).toBe(200)
    expect(numbersOf(await windowRows(t.owner.cookie, plain.id))).toEqual({ 一: null })
    // 原集合下一个号照旧往后：挪走的号不回收
    expect((await postRow(t.owner.cookie, c.id, { title: '三' })).body.number).toBe(3)
  })
})

describe('跨集合移动与历史摘要', () => {
  test('mapProps：邮箱 / 电话 / 文件 / 日期区间按值搬（同名同类型、过校验），系统生成的类型不搬', () => {
    const json = (props: Record<string, PropJson>) => parseCollection({ props })
    const from = json(PROPS)
    const to = json({
      e2: { name: '邮箱', type: 'email', pos: 0 },
      t2: { name: '电话', type: 'text', pos: 1 },
      f2: { name: '附件', type: 'files', pos: 2 },
      d2: { name: '日期', type: 'date', pos: 3 },
      c2: { name: '创建者', type: 'created_by', pos: 4 },
      u2: { name: '编号', type: 'unique_id', pos: 5 },
    })
    const mapped = mapProps(
      from,
      to,
      { eml: 'a@b.co', tel: '010-1234', fil: [FILE_A, { id: 'bad' }], dat: '2026-10-01/2026-10-05', cby: ['u1'], uid: 3 },
      new Set(),
    )
    // 电话在目标里是文本（类型不同）：不搬；文件里读不出的项在校验时整格被拒，不会只搬一半
    expect(mapped).toEqual({ e2: 'a@b.co', d2: '2026-10-01/2026-10-05' })
    expect(mapProps(from, to, { fil: [FILE_A] }, new Set())).toEqual({ f2: [FILE_A] })
  })

  test('流水：文件只留文件名；编号前缀改了算属性定义的变化', () => {
    expect(propDiff({}, { fil: [FILE_A, { other: 1 }] })).toEqual([{ kind: 'prop', prop: 'fil', from: null, to: [{ name: FILE_A.name }, null] }])
    const before = parseCollection({ props: { uid: PROPS.uid } })
    const after = parseCollection({ props: { uid: { ...PROPS.uid, cfg: { prefix: 'BUG' } } } })
    expect(schemaDiff(before, after)).toEqual([{ kind: 'schema', op: 'prop_edit', text: '编号' }])
    // 配置里当前类型不认得的字段不算变化
    const noise = parseCollection({ props: { uid: { ...PROPS.uid, cfg: { prefix: 'TASK', target: 'x' } } } })
    expect(schemaDiff(before, noise)).toEqual([])
  })
})
