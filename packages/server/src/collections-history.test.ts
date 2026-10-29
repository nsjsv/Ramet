import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { call, connect, eventually, newCollection, patchRow, postRow, replicaOf, team, updatesOf, watchCollection } from './collections/test-kit.js'

// 集合属性历史与恢复的服务端部分：
//  · 行的属性改动进这一行的「更新」流水（prop 项给原始值，前端按当前定义解读）
//  · 集合页的属性定义 / 视图变化进集合页的「更新」流水（schema 项）
//  · 恢复是客户端对活文档的协同写：写回 props 后副本与增量照常由投影器出，不另写路径

type Entry = { id: string; summary: Record<string, unknown>[]; summary_total: number }

function updates(cookie: string, pageId: string) {
  return call<Entry[]>('GET', `/api/pages/${pageId}/updates`, cookie)
}

function snapshot(cookie: string, pageId: string) {
  return call<{ id: string }>('POST', `/api/pages/${pageId}/snapshots`, cookie)
}

describe('行的「更新」流水带属性差异', () => {
  test('PATCH set → 版本 → GET /updates 最新一条是「状态：未开始 → 进行中」，作者是改的人', async () => {
    const t = await team()
    const c = await newCollection(t)
    const created = await postRow(t.member.cookie, c.id, { title: '写周报', set: { [c.status.id]: c.todo } })
    expect(created.status).toBe(201)
    const rowId = created.body.id
    // 基线版本：改之前的状态（未开始）
    expect((await snapshot(t.member.cookie, rowId)).status).toBe(201)
    expect((await patchRow(t.member.cookie, c.id, rowId, { set: { [c.status.id]: c.doing } })).status).toBe(200)
    // 自动快照（5 分钟去重）未必赶得上：手动存一版；若自动快照先到，手动存版是空增量、返回那一条，摘要相同
    expect((await snapshot(t.member.cookie, rowId)).status).toBe(201)
    await eventually(async () => {
      const res = await updates(t.viewer.cookie, rowId)
      expect(res.status).toBe(200)
      expect(res.body[0]!.summary).toEqual([{ kind: 'prop', prop: c.status.id, from: c.todo, to: c.doing }])
    })
    const latest = await call<{ author_id: string | null }[]>('GET', `/api/pages/${rowId}/updates?limit=1`, t.member.cookie)
    expect(latest.body[0]!.author_id).toBe(t.member.id)
  })

  test('清空与长文本：清空给 to = null；文本截到 80 字', async () => {
    const t = await team()
    const c = await newCollection(t)
    const textId = 'note01'
    // 加一个文本属性（经协同连接改集合文档，同客户端的 addProp）
    const coll = await connect(`page:${c.id}`, t.owner.cookie)
    coll.document.transact(() => {
      const prop = new Y.Map<unknown>()
      ;(coll.document.getMap<unknown>('collection').get('props') as Y.Map<unknown>).set(textId, prop)
      prop.set('name', '备注')
      prop.set('type', 'text')
      prop.set('pos', 5)
    })
    const row = (await postRow(t.member.cookie, c.id, { set: { [c.status.id]: c.done } })).body
    await snapshot(t.member.cookie, row.id)
    const long = '长'.repeat(200)
    await eventually(async () => expect((await patchRow(t.member.cookie, c.id, row.id, { set: { [textId]: long, [c.status.id]: null } })).status).toBe(200))
    await snapshot(t.member.cookie, row.id)
    await eventually(async () => {
      const res = await updates(t.member.cookie, row.id)
      const items = res.body[0]!.summary
      expect(items).toContainEqual({ kind: 'prop', prop: textId, from: null, to: '长'.repeat(80) })
      expect(items).toContainEqual({ kind: 'prop', prop: c.status.id, from: c.done, to: null })
    })
  })
})

describe('集合页的「更新」流水带属性定义 / 视图变化', () => {
  test('新增属性、改视图出 schema 项；只改列宽不出项', async () => {
    const t = await team()
    const c = await newCollection(t)
    const coll = await connect(`page:${c.id}`, t.owner.cookie)
    const root = coll.document.getMap<unknown>('collection')
    expect((await snapshot(t.owner.cookie, c.id)).status).toBe(201)

    const view = c.schema.views[0]!
    // 一个事务：两处改动同一条增量到达，存版时不会只赶上一半
    coll.document.transact(() => {
      const prop = new Y.Map<unknown>()
      ;(root.get('props') as Y.Map<unknown>).set('prio01', prop)
      prop.set('name', '优先级')
      prop.set('type', 'number')
      prop.set('pos', 9)
      ;((root.get('views') as Y.Map<unknown>).get(view.id) as Y.Map<unknown>).set('sorts', [{ prop: c.status.id, dir: 'desc' }])
    })
    await eventually(async () => {
      expect((await snapshot(t.owner.cookie, c.id)).status).toBe(201)
      const res = await updates(t.owner.cookie, c.id)
      expect(res.body[0]!.summary).toEqual([
        { kind: 'schema', op: 'prop_add', text: '优先级' },
        { kind: 'schema', op: 'view_edit', text: view.name },
      ])
    })

    // 只拖列宽：有新版本，但它没有摘要项（前端不列）
    const before = (await updates(t.owner.cookie, c.id)).body.length
    const widths = ((root.get('views') as Y.Map<unknown>).get(view.id) as Y.Map<unknown>).get('widths') as Y.Map<unknown>
    widths.set(c.status.id, 333)
    await eventually(async () => {
      expect((await snapshot(t.owner.cookie, c.id)).status).toBe(201)
      const res = await updates(t.owner.cookie, c.id)
      expect(res.body.length).toBe(before + 1)
      expect(res.body[0]!.summary).toEqual([])
    })
  })
})

describe('恢复走投影器', () => {
  test('经协同连接写回行文档的 props（恢复版本的做法）→ 副本更新、看着集合的连接收到增量', async () => {
    const t = await team()
    const c = await newCollection(t)
    const row = (await postRow(t.member.cookie, c.id, { set: { [c.status.id]: c.doing } })).body
    const deltas = await watchCollection(c.id, t.owner.cookie)
    const conn = await connect(`page:${row.id}`, t.member.cookie)
    const props = conn.document.getMap<unknown>('props')
    conn.document.transact(() => props.set(c.status.id, c.todo))
    await eventually(async () => expect(await replicaOf(row.id)).toEqual({ [c.status.id]: c.todo }))
    await eventually(() => expect(updatesOf(deltas, row.id).at(-1)?.prev).toEqual({ [c.status.id]: c.doing }))
  })
})
