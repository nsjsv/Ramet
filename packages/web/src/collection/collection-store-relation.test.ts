import { beforeEach, describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { newView, parseCollection, rowValue, type CollectionRefs, type CollectionRow, type PropJson, type RowsDelta } from '@ramet/shared/collection-model'
import { queryWindow } from '@ramet/shared/collection-query'
import type { Page } from '../api'
import type { RowPatch } from './collection-api'
import { createCollectionStore, type CollectionHandle, type CollectionLink, type CollectionTransport, type RowsQuery } from './collection-store'

/* 关联与汇总在 store 里（collection-store.ts、relation-write.ts、row-watch.ts、collection-deps.ts）：
 * 窗口响应的 refs 记在 handle 上；乐观改正向关联要去掉 computed 里的旧值（rowValue 退回存储值）；
 * 反向关联按现在的值换算成增删发出去，乐观地直接改 computed；关联 / 汇总的定义变了自己重取；
 * 关联到的集合的行进出 / 改名（页面列表）重取；属性区单独取的那一行跟着增量走、reset 重取。
 * 通用的连接 / 增量 / 乐观写在 collection-store.test.ts，这里的假服务端只够关联用 */

const CID = 'c1'
const B = '0b0c3c1e-6f7a-4b2c-9d8e-112233445566'
const S = '1b0c3c1e-6f7a-4b2c-9d8e-112233445566'
const REFS: CollectionRefs = { rel001: { state: 'ok', target: { id: B, title: '项目' } } }

let rows: CollectionRow[] = []
let links: FakeLink[] = []
let fetches: RowsQuery[] = []
let patches: { rowId: string; patch: RowPatch }[] = []
let rowFetches: string[] = []

type FakeLink = CollectionLink & { synced: () => void; send: (delta: RowsDelta) => void }

const PROPS: Record<string, PropJson> = {
  rel001: { name: '项目', type: 'relation', pos: 0, cfg: { target: B, reverse: null, single: false } },
  rev001: { name: '父任务', type: 'relation', pos: 1, cfg: { target: S, mirror: 'fwd001' } },
  sum001: { name: '数量', type: 'rollup', pos: 2, cfg: { relation: 'rel001', prop: 'title', fn: 'count' } },
}

function seedDoc(doc: Y.Doc): void {
  doc.transact(() => {
    const root = doc.getMap<unknown>('collection')
    root.set('v', 1)
    const props = new Y.Map<unknown>()
    root.set('props', props)
    for (const [id, json] of Object.entries(PROPS)) {
      const prop = new Y.Map<unknown>()
      props.set(id, prop)
      for (const [k, v] of Object.entries(json)) prop.set(k, v)
    }
    const views = new Y.Map<unknown>()
    root.set('views', views)
    const view = new Y.Map<unknown>()
    views.set('v1', view)
    const { widths: _w, ...settings } = newView('表格', 'table', 0)
    for (const [k, v] of Object.entries(settings)) view.set(k, v)
    view.set('widths', new Y.Map())
  })
}

const row = (id: string, props: Record<string, unknown>, computed: Record<string, unknown>, position: number): CollectionRow => ({
  id,
  title: id.toUpperCase(),
  icon: null,
  props,
  position,
  created_at: '2026-10-25 00:00:00+00',
  edited_at: '2026-10-25 00:00:00+00',
  has_body: false,
  computed,
})

function transport(): CollectionTransport {
  const unused = async (): Promise<never> => {
    throw new Error('not in this test')
  }
  return {
    connect: (_cid, cached) => {
      const doc = cached ?? new Y.Doc()
      const synced: (() => void)[] = []
      const stateless: ((p: string) => void)[] = []
      const link: FakeLink = {
        doc,
        provider: null,
        onSynced: (cb) => void synced.push(cb),
        onStateless: (cb) => void stateless.push(cb),
        onDenied: () => undefined,
        destroy: () => undefined,
        synced: () => {
          if (!doc.getMap('collection').has('v')) seedDoc(doc)
          synced.forEach((cb) => cb())
        },
        send: (delta) => stateless.forEach((cb) => cb(JSON.stringify(delta))),
      }
      links.push(link)
      return link
    },
    rows: async (_cid, q) => {
      fetches.push(q)
      const schema = parseCollection(links[0]!.doc.getMap('collection').toJSON())
      const view = schema.views.find((v) => v.id === q.view) ?? schema.views[0]!
      return { ...queryWindow(rows, view, schema, { cursor: q.cursor, limit: q.limit }, { tzOffset: q.tz }), refs: REFS }
    },
    row: async (_cid, rowId) => {
      rowFetches.push(rowId)
      return { row: rows.find((r) => r.id === rowId)!, refs: REFS }
    },
    createRow: unused,
    patchRow: async (_cid, rowId, patch) => {
      patches.push({ rowId, patch })
      return rows.find((r) => r.id === rowId)!
    },
    trashRows: unused,
    setRows: unused,
    duplicateRows: unused,
    moveRows: unused,
    tzOffset: () => 0,
  }
}

const page = (id: string, parent: string | null, kind: Page['kind'] = 'doc', title = id.toUpperCase()): Page => ({
  id,
  parent_id: parent,
  title,
  kind,
  created_at: '',
  space_id: 's1',
  published: false,
  publish_includes_runs: false,
  icon: null,
})

const flush = () => new Promise((r) => setTimeout(r, 0))

const schemaProp = (handle: CollectionHandle, id: string) => handle.schema()!.props.find((p) => p.id === id)!
const shown = (handle: CollectionHandle, rowId: string, propId: string) => rowValue(handle.findRow(rowId)!, schemaProp(handle, propId))

async function opened(): Promise<{ handle: CollectionHandle; link: FakeLink; store: ReturnType<typeof createCollectionStore> }> {
  const store = createCollectionStore(transport())
  const handle = store.open(CID)
  const link = links[0]!
  link.synced()
  handle.watchWindow('v1')
  await flush()
  return { handle, link, store }
}

beforeEach(() => {
  links = []
  fetches = []
  patches = []
  rowFetches = []
  rows = [
    row('a1', { rel001: ['b1', 'gone'] }, { rel001: ['b1'], rev001: ['s1', 's2'], sum001: 1 }, 0),
    row('a2', {}, { rel001: [], rev001: ['s2'], sum001: 0 }, 1),
  ]
})

describe('窗口与 refs', () => {
  test('窗口响应里的 refs 记在 handle 上', async () => {
    const { handle } = await opened()
    expect(handle.refs()).toEqual(REFS)
  })
})

describe('乐观写关联', () => {
  test('正向：去掉 computed 里的旧值、退回存储值；回声带回服务端算好的', async () => {
    const { handle, link } = await opened()
    expect(shown(handle, 'a1', 'rel001')).toEqual(['b1'])
    await handle.setValues('a1', { rel001: ['b1', 'b2'] })
    expect(patches.at(-1)).toEqual({ rowId: 'a1', patch: { set: { rel001: ['b1', 'b2'] } } })
    const optimistic = handle.findRow('a1')!
    expect(optimistic.computed).toEqual({ rev001: ['s1', 's2'], sum001: 1 })
    expect(shown(handle, 'a1', 'rel001')).toEqual(['b1', 'b2'])
    link.send({
      t: 'collection.rows',
      up: [{ row: row('a1', { rel001: ['b1', 'b2'] }, { rel001: ['b1', 'b2'], rev001: ['s1', 's2'], sum001: 2 }, 0), prev: { rel001: ['b1', 'gone'] } }],
      rm: [],
    })
    expect(handle.findRow('a1')!.computed).toEqual({ rel001: ['b1', 'b2'], rev001: ['s1', 's2'], sum001: 2 })
  })

  test('正向连改两次、第一次的回声先到：行里保持第二次的值，computed 里第一次算出的那份不显示', async () => {
    const { handle, link } = await opened()
    await handle.setValues('a1', { rel001: ['b1', 'b2'] })
    await handle.setValues('a1', { rel001: ['b2'] })
    link.send({
      t: 'collection.rows',
      up: [{ row: row('a1', { rel001: ['b1', 'b2'] }, { rel001: ['b1', 'b2'], rev001: ['s1', 's2'], sum001: 2 }, 0), prev: { rel001: ['b1', 'gone'] } }],
      rm: [],
    })
    expect(shown(handle, 'a1', 'rel001')).toEqual(['b2'])
    expect(handle.findRow('a1')!.computed?.sum001).toBe(2)
  })

  test('反向：按现在的值换算成增删发出去，乐观地改 computed，不碰 props', async () => {
    const { handle } = await opened()
    expect(await handle.setValues('a1', { rev001: ['s1', 's3'] })).toBe(true)
    expect(patches.at(-1)).toEqual({ rowId: 'a1', patch: { set: { rev001: { add: ['s3'], remove: ['s2'] } } } })
    const a1 = handle.findRow('a1')!
    expect(a1.computed?.rev001).toEqual(['s1', 's3'])
    expect(Object.hasOwn(a1.props, 'rev001')).toBe(false)
    // 没变的不发增删
    await handle.setValues('a1', { rev001: ['s1', 's3'] })
    expect(patches.at(-1)!.patch.set).toEqual({})
    // 清空：只删
    await handle.setValues('a2', { rev001: null })
    expect(patches.at(-1)).toEqual({ rowId: 'a2', patch: { set: { rev001: { remove: ['s2'] } } } })
  })

  test('反向一次加减超过上限：不发请求，给提示', async () => {
    const { handle } = await opened()
    const many = Array.from({ length: 101 }, (_, i) => `n${i}`)
    expect(await handle.setValues('a1', { rev001: many })).toBe(false)
    expect(patches).toEqual([])
    expect(handle.error()).toContain('100')
  })

  test('批量改反向关联：每行的增删不一样，逐行发', async () => {
    const { handle } = await opened()
    expect(await handle.setValuesMany(['a1', 'a2'], { rev001: ['s2', 's9'] })).toBe(true)
    expect(patches).toEqual([
      { rowId: 'a1', patch: { set: { rev001: { add: ['s9'], remove: ['s1'] } } } },
      { rowId: 'a2', patch: { set: { rev001: { add: ['s9'] } } } },
    ])
  })
})

describe('什么时候重取', () => {
  test('关联 / 汇总的定义变了（服务端不给本集合发 reset）：窗口重取；只改名不取', async () => {
    const { handle, link } = await opened()
    const before = fetches.length
    const props = link.doc.getMap('collection').get('props') as Y.Map<Y.Map<unknown>>
    props.get('sum001')!.set('name', '项目数')
    await flush()
    expect(fetches.length).toBe(before)
    props.get('sum001')!.set('cfg', { relation: 'rel001', prop: 'title', fn: 'count_values' })
    await flush()
    expect(fetches.length).toBe(before + 1)
    expect(handle.schema()!.props.find((p) => p.id === 'sum001')!.cfg.fn).toBe('count_values')
  })

  test('关联到的集合有行进出、改名、本身换了空间：重取；无关的页面变化不取', async () => {
    const { store } = await opened()
    const base = [page(CID, null, 'collection'), page('a1', CID), page('a2', CID), page(B, null, 'collection'), page('b1', B), page(S, null, 'collection'), page('x', null)]
    store.syncPages(base)
    await flush()
    const count = fetches.length
    store.syncPages([...base.filter((p) => p.id !== 'x'), page('x', null, 'doc', '无关的改名')])
    await flush()
    expect(fetches.length).toBe(count)
    store.syncPages([...base.filter((p) => p.id !== 'b1'), page('b1', B, 'doc', '改了名')])
    await flush()
    expect(fetches.length).toBe(count + 1)
    store.syncPages([...base, page('s9', S)])
    await flush()
    expect(fetches.length).toBe(count + 2)
    store.syncPages(base.map((p) => (p.id === B ? { ...p, space_id: 's2' } : p)))
    await flush()
    expect(fetches.length).toBe(count + 3)
  })
})

describe('属性区单独取的一行', () => {
  test('取一次、跟着增量换、reset 与关联定义变了都重取；没人看就丢', async () => {
    const { handle, link } = await opened()
    const stop = handle.watchRow('a2')
    await flush()
    expect(rowFetches).toEqual(['a2'])
    expect(handle.rowState('a2')).toEqual({ row: rows[1], refs: REFS })
    link.send({ t: 'collection.rows', up: [{ row: row('a2', {}, { rel001: [], rev001: ['s2', 's5'], sum001: 0 }, 1), prev: {} }], rm: [] })
    expect(handle.rowState('a2').row?.computed?.rev001).toEqual(['s2', 's5'])
    link.send({ t: 'collection.rows', up: [], rm: [], reset: true })
    await flush()
    expect(rowFetches).toEqual(['a2', 'a2'])
    const props = link.doc.getMap('collection').get('props') as Y.Map<Y.Map<unknown>>
    props.get('rel001')!.set('cfg', { target: B, reverse: null, single: true })
    await flush()
    expect(rowFetches).toEqual(['a2', 'a2', 'a2'])
    stop()
    link.send({ t: 'collection.rows', up: [], rm: [], reset: true })
    await flush()
    expect(rowFetches).toHaveLength(3)
    expect(handle.rowState('a2').row).toBeNull()
  })

  test('空闲窗口错过了 reset（stale）：findRow 给属性区重取的那一份，反向关联按显示的值换算，删得掉别人刚加的', async () => {
    const store = createCollectionStore(transport())
    const handle = store.open(CID)
    links[0]!.synced()
    const unwatch = handle.watchWindow('v1')
    await flush()
    unwatch()
    handle.watchRow('a1')
    await flush()
    // 别人加了 s3：服务端随后只发 reset，空闲窗口只记 stale 不取，属性区那一行重取
    rows[0] = row('a1', { rel001: ['b1'] }, { rel001: ['b1'], rev001: ['s1', 's2', 's3'], sum001: 1 }, 0)
    links[0]!.send({ t: 'collection.rows', up: [], rm: [], reset: true })
    await flush()
    expect(handle.findRow('a1')!.computed?.rev001).toEqual(['s1', 's2', 's3'])
    await handle.setValues('a1', { rev001: ['s1', 's2'] })
    expect(patches.at(-1)).toEqual({ rowId: 'a1', patch: { set: { rev001: { remove: ['s3'] } } } })
  })

  test('没有窗口（只开着行页面）：findRow 给属性区那一份，反向关联按它换算、乐观地改它', async () => {
    rows.push(row('a3', {}, { rel001: [], rev001: ['s7'], sum001: 0 }, 2))
    const store = createCollectionStore(transport())
    const handle = store.open(CID)
    links[0]!.synced()
    handle.watchRow('a3')
    await flush()
    expect(fetches).toEqual([])
    expect(handle.rowState('a3').row?.computed?.rev001).toEqual(['s7'])
    await handle.setValues('a3', { rev001: [] })
    expect(patches.at(-1)).toEqual({ rowId: 'a3', patch: { set: { rev001: { remove: ['s7'] } } } })
    expect(handle.rowState('a3').row?.computed?.rev001).toEqual([])
  })
})
