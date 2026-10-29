import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import type { CollectionRow } from '@ramet/shared/collection-model'
import { startServer } from './index.js'
import { mergeUpdate } from './collections/delta.js'
import { propsDiff, replicaProps } from './collections/store.js'
import {
  call,
  connect,
  delay,
  eventually,
  getRows,
  newCollection,
  onCleanup,
  patchRow,
  pool,
  postPage,
  postRow,
  replicaOf,
  rowDoc,
  team,
  updatesOf,
  watchCollection,
} from './collections/test-kit.js'

// 投影器（collections/projector.ts）：行属性的真相是行文档的 Y.Map('props')，collection_rows 是它的副本。
// 不论改动从哪条路来（REST 经 DocWriter / 浏览器协同连接），副本都由挂在文档上的观察者维护，
// 行在集合里就把增量发给看着这个集合的连接；文档加载时校准过期的副本；REST 写值在响应前副本已落库

describe('协同连接直接改 props', () => {
  test('不经 REST：副本跟着改，集合连接收到带 prev 的增量；连续改动并成一次', async () => {
    const t = await team()
    const c = await newCollection(t)
    const row = (await postRow(t.owner.cookie, c.id, { title: 'r', set: { [c.status.id]: c.todo } })).body
    const deltas = await watchCollection(c.id, t.viewer.cookie)
    const doc = new Y.Doc()
    await connect(`page:${row.id}`, t.member.cookie, { doc })
    const props = doc.getMap<unknown>('props')
    expect(props.toJSON()).toEqual({ [c.status.id]: c.todo })

    props.set(c.status.id, c.doing)
    await eventually(async () => expect(await replicaOf(row.id)).toEqual({ [c.status.id]: c.doing }))
    await eventually(() => {
      const last = updatesOf(deltas, row.id).at(-1)
      expect(last?.row.props).toEqual({ [c.status.id]: c.doing })
      expect(last?.prev).toEqual({ [c.status.id]: c.todo })
    })

    // 一个去抖周期里的连续改动：副本写一次，prev 是这一串改动之前的值
    const before = updatesOf(deltas, row.id).length
    props.set(c.status.id, c.done)
    props.set(c.status.id, c.todo)
    props.set(c.status.id, c.done)
    await eventually(async () => expect(await replicaOf(row.id)).toEqual({ [c.status.id]: c.done }))
    await eventually(() => expect(updatesOf(deltas, row.id).length).toBe(before + 1))
    expect(updatesOf(deltas, row.id).at(-1)?.prev).toEqual({ [c.status.id]: c.doing })
    // 窗口查询读的就是副本
    expect((await getRows(t.viewer.cookie, c.id)).body.rows[0]?.props).toEqual({ [c.status.id]: c.done })
  })

  test('viewer 的协同连接写不进去：副本不变、没有增量', async () => {
    const t = await team()
    const c = await newCollection(t)
    const row = (await postRow(t.owner.cookie, c.id, { title: 'r', set: { [c.status.id]: c.todo } })).body
    const deltas = await watchCollection(c.id, t.owner.cookie)
    const doc = new Y.Doc()
    await connect(`page:${row.id}`, t.viewer.cookie, { doc })
    doc.getMap<unknown>('props').set(c.status.id, c.done)
    await delay(600)
    expect(await replicaOf(row.id)).toEqual({ [c.status.id]: c.todo })
    expect(updatesOf(deltas, row.id)).toHaveLength(0)
  })

  test('协同连接写进来的脏值也投影得进去：JSONB 存不了的 \\u0000 只在副本里清掉、非属性 id 的键不进副本，文档原样保留', async () => {
    const t = await team()
    const c = await newCollection(t)
    const row = (await postRow(t.owner.cookie, c.id, { title: 'r' })).body
    const doc = new Y.Doc()
    await connect(`page:${row.id}`, t.member.cookie, { doc })
    const props = doc.getMap<unknown>('props')
    doc.transact(() => {
      props.set(c.status.id, 'a\u0000b')
      props.set('Not An Id', 1)
      props.set('nested', { deep: ['x\u0000', { 'k\u0000': 2 }] })
    })
    await eventually(async () => expect(await replicaOf(row.id)).toEqual({ [c.status.id]: 'ab', nested: { deep: ['x', { k: 2 }] } }))
    await eventually(async () => expect((await rowDoc(row.id)).getMap('props').get(c.status.id)).toBe('a\u0000b'))
    // 窗口照常下发（值是什么由客户端经 readValue 解读：不是现有选项 = 空）
    expect((await getRows(t.member.cookie, c.id)).body.rows[0]?.props).toEqual({ [c.status.id]: 'ab', nested: { deep: ['x', { k: 2 }] } })
  })
})

describe('自愈与写后即读', () => {
  test('PATCH set 返回 200 后立即查询就看得到新值：行文档没加载 / 正被别人打开着，两种都不等去抖', async () => {
    const t = await team()
    const c = await newCollection(t)
    const a = (await postRow(t.owner.cookie, c.id, { title: 'a' })).body
    const b = (await postRow(t.owner.cookie, c.id, { title: 'b' })).body
    // a 没有任何连接；b 正被一个浏览器打开着（文档常驻内存，副本靠观察者那条路）
    await connect(`page:${b.id}`, t.member.cookie)
    for (const [row, value] of [
      [a, c.doing],
      [b, c.done],
    ] as const) {
      expect((await patchRow(t.member.cookie, c.id, row.id, { set: { [c.status.id]: value } })).status).toBe(200)
      expect(await replicaOf(row.id)).toEqual({ [c.status.id]: value })
      const window = await getRows(t.member.cookie, c.id)
      expect(window.body.rows.find((r: CollectionRow) => r.id === row.id)?.props).toEqual({ [c.status.id]: value })
    }
  })

  test('副本被改坏 / 被删掉（模拟崩溃窗口）：进程重启后文档再加载时按文档校准', async () => {
    const t = await team()
    const c = await newCollection(t)
    const bad = (await postRow(t.owner.cookie, c.id, { title: 'bad', set: { [c.status.id]: c.doing } })).body
    const gone = (await postRow(t.owner.cookie, c.id, { title: 'gone', set: { [c.status.id]: c.done } })).body
    await pool.query(`UPDATE collection_rows SET props = '{"zzz": 1}' WHERE page_id = $1`, [bad.id])
    await pool.query('DELETE FROM collection_rows WHERE page_id = $1', [gone.id])
    expect((await getRows(t.owner.cookie, c.id)).body.rows.map((r) => r.props)).toEqual([{ zzz: 1 }, {}])

    // 换一个刚起的实例（相当于重启：内存里没有这两份文档），让它们重新加载
    const s2 = await startServer(pool)
    onCleanup(() => s2.close())
    await connect(`page:${bad.id}`, t.member.cookie, { port: s2.port })
    await connect(`page:${gone.id}`, t.member.cookie, { port: s2.port })
    await eventually(async () => expect(await replicaOf(bad.id)).toEqual({ [c.status.id]: c.doing }))
    await eventually(async () => expect(await replicaOf(gone.id)).toEqual({ [c.status.id]: c.done }))
    const window = await getRows(t.owner.cookie, c.id)
    expect(window.body.rows.map((r) => r.props)).toEqual([{ [c.status.id]: c.doing }, { [c.status.id]: c.done }])
  })

  test('校准时发增量：看着集合的连接与加载行文档的连接在同一个实例上', async () => {
    const t = await team()
    const c = await newCollection(t)
    const row = (await postRow(t.owner.cookie, c.id, { title: 'r', set: { [c.status.id]: c.doing } })).body
    await pool.query(`UPDATE collection_rows SET props = '{}' WHERE page_id = $1`, [row.id])
    const deltas = await watchCollection(c.id, t.viewer.cookie)
    await connect(`page:${row.id}`, t.member.cookie)
    await eventually(() => {
      const last = updatesOf(deltas, row.id).at(-1)
      expect(last?.row.props).toEqual({ [c.status.id]: c.doing })
      expect(last?.prev).toEqual({ [c.status.id]: null })
    })
  })

  test('行正文从没字到有字（再删空）：存文档后看着集合的连接收到整行增量，has_body 跟着翻；窗口查询同口径', async () => {
    const t = await team()
    const c = await newCollection(t)
    const row = (await postRow(t.owner.cookie, c.id, { title: 'r' })).body
    expect(row.has_body).toBe(false)
    const deltas = await watchCollection(c.id, t.viewer.cookie)
    const doc = new Y.Doc()
    await connect(`page:${row.id}`, t.member.cookie, { doc })
    const body = doc.getXmlFragment('prosemirror')
    const para = new Y.XmlElement('paragraph')
    para.insert(0, [new Y.XmlText('正文')])
    body.insert(body.length, [para])
    await eventually(() => {
      const last = updatesOf(deltas, row.id).at(-1)
      expect(last?.row.has_body).toBe(true)
      expect(last?.prev).toEqual({})
    })
    expect((await getRows(t.viewer.cookie, c.id)).body.rows[0]?.has_body).toBe(true)

    // 只剩空白 = 没字
    const text = para.get(0) as Y.XmlText
    text.delete(0, text.length)
    text.insert(0, '  ')
    await eventually(() => expect(updatesOf(deltas, row.id).at(-1)?.row.has_body).toBe(false))
  })

  test('拖进集合、还没有副本的行：文档加载时补一行空副本（副本行的存在就是「投影过」）', async () => {
    const t = await team()
    const c = await newCollection(t)
    const page = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '拖进来的' })
    const outside = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '不在集合里' })
    expect((await call('PATCH', `/api/pages/${page}`, t.owner.cookie, { parent_id: c.id })).status).toBe(200)
    expect(await replicaOf(page)).toBeUndefined()
    await connect(`page:${page}`, t.member.cookie)
    await connect(`page:${outside}`, t.member.cookie)
    await eventually(async () => expect(await replicaOf(page)).toEqual({}))
    // 不在集合里、props 为空的普通页面：什么都不写
    await delay(300)
    expect(await replicaOf(outside)).toBeUndefined()
  })
})

describe('纯函数', () => {
  test('replicaProps：只留属性 id 的键，null 视作没有，清洗字符串与非有限数', () => {
    expect(
      replicaProps({ abc: 'x\u0000y', title: 'no', __proto__x: 1, 'Bad Key': 1, n: null, f: Number.NaN, ok: [1, 'a\udc00', 'b\ud800'] }),
    ).toEqual({ abc: 'xy', ok: [1, 'a\ufffd', 'b\ufffd'] })
    expect(replicaProps(null)).toEqual({})
    expect(replicaProps([1, 2])).toEqual({})
  })

  test('propsDiff：只记变了的键，旧值没有记 null；键序不同不算变', () => {
    expect(propsDiff({ a: 1, b: [1, 2], c: { x: 1, y: 2 } }, { a: 2, b: [1, 2], c: { y: 2, x: 1 }, d: true })).toEqual({ a: 1, d: null })
    expect(propsDiff({ a: 1 }, {})).toEqual({ a: 1 })
  })

  test('同一批里一行只出现一次：row 取最新，prev 取最早（后来才改的键取它当时的旧值）', () => {
    const row = (title: string): CollectionRow => ({
      id: 'r',
      title,
      icon: null,
      props: {},
      position: 0,
      created_at: '2026-10-25 00:00:00+00',
      edited_at: '2026-10-25 00:00:00+00',
      has_body: false,
    })
    expect(mergeUpdate({ row: row('1'), prev: { a: 1 } }, { row: row('2'), prev: { a: 2, b: null } })).toEqual({
      row: row('2'),
      prev: { a: 1, b: null },
    })
    expect(mergeUpdate({ row: row('1'), prev: { a: 1 } }, { row: row('2'), prev: {} })).toEqual({ row: row('2'), prev: { a: 1 } })
    // 最早那次没有 prev（本批才进集合）：合并后仍没有
    expect(mergeUpdate({ row: row('1') }, { row: row('2'), prev: { a: 1 } })).toEqual({ row: row('2') })
  })
})
