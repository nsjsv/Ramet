import { beforeEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { newStatusOptions, newView, type CollectionRow, type RowsDelta } from '@ramet/shared/collection-model'
import { between, queryWindow, type RowsWindow } from '@ramet/shared/collection-query'
import { parseCollection } from '@ramet/shared/collection-model'
import type { Page } from '../api'
import type { NewRowInput, RowPatch } from './collection-api'
import type { CacheOptions } from './collection-cache'
import { createCollectionStore, type CollectionLink, type CollectionTransport, type RowsQuery } from './collection-store'

/* 不变量（collection-store.ts 文件头）：同一集合只开一条连接（引用计数）；schema 在服务端同步过之后才给；
 * 增量用 applyRowsDelta 套到窗口上，reset 全部重取；页面列表里子页集合变了重取、只改名本地改；
 * 写是乐观的（失败重取 + 提示），服务端随后发来的同一改动不会把计数再增减一次。 */

const CID = 'c1'
const OPTS = newStatusOptions()
const [TODO, DOING, DONE] = Object.keys(OPTS) as [string, string, string]

/** 内存里的「服务端」：行 + 集合文档 */
let rows: CollectionRow[] = []
let links: FakeLink[] = []
let fetches: RowsQuery[] = []
let failWrites = false
let patches: RowPatch[] = []
let bulkCalls: number[] = []
let creates: NewRowInput[] = []
/** 建行请求在这之后才落（测「确认之前」的行为） */
let createGate: Promise<void> = Promise.resolve()
/** 改值 / 改名请求在这之后才落（测「改名在途」） */
let patchGate: Promise<void> = Promise.resolve()

type FakeLink = CollectionLink & { synced: () => void; send: (delta: RowsDelta) => void; deny: () => void; destroyed: boolean }

function seedDoc(doc: Y.Doc, groupBy: string | null = null): void {
  doc.transact(() => {
    const root = doc.getMap<unknown>('collection')
    root.set('v', 1)
    const props = new Y.Map<unknown>()
    root.set('props', props)
    const sts = new Y.Map<unknown>()
    props.set('sts001', sts)
    sts.set('name', '状态')
    sts.set('type', 'status')
    sts.set('pos', 0)
    const options = new Y.Map<unknown>()
    sts.set('options', options)
    for (const [id, o] of Object.entries(OPTS)) options.set(id, o)
    const views = new Y.Map<unknown>()
    root.set('views', views)
    const view = new Y.Map<unknown>()
    views.set('v1', view)
    const { widths: _w, ...settings } = newView('表格', 'table', 0, groupBy)
    for (const [k, v] of Object.entries(settings)) view.set(k, v)
    view.set('widths', new Y.Map())
  })
}

function serverSchema(link: FakeLink) {
  return parseCollection(link.doc.getMap('collection').toJSON())
}

const row = (id: string, status?: string, position: number | null = null): CollectionRow => ({
  id,
  title: id.toUpperCase(),
  icon: null,
  props: status ? { sts001: status } : {},
  position,
  created_at: `2026-10-25 00:00:0${rows.length}+00`,
  edited_at: '2026-10-25 00:00:00+00',
  has_body: false,
})

function transport(groupBy: string | null = null): CollectionTransport {
  return {
    connect: (_cid, cached) => {
      const doc = cached ?? new Y.Doc()
      const synced: (() => void)[] = []
      const stateless: ((p: string) => void)[] = []
      const denied: (() => void)[] = []
      const link: FakeLink = {
        doc,
        provider: null,
        onSynced: (cb) => void synced.push(cb),
        onStateless: (cb) => void stateless.push(cb),
        onDenied: (cb) => void denied.push(cb),
        destroy: () => {
          link.destroyed = true
        },
        destroyed: false,
        synced: () => {
          if (!doc.getMap('collection').has('v')) seedDoc(doc, groupBy)
          synced.forEach((cb) => cb())
        },
        send: (delta) => stateless.forEach((cb) => cb(JSON.stringify(delta))),
        deny: () => denied.forEach((cb) => cb()),
      }
      links.push(link)
      return link
    },
    rows: async (_cid, q) => {
      fetches.push(q)
      const link = links[0]!
      const schema = serverSchema(link)
      return queryWindow(rows, schema.views.find((v) => v.id === q.view) ?? schema.views[0]!, schema, { group: q.group, cursor: q.cursor, limit: q.limit })
    },
    createRow: async (_cid, input) => {
      creates.push(input)
      await createGate
      if (failWrites) throw new Error('boom')
      // 位置同服务端：给了 after 就夹在它与下一行之间，否则排到末尾
      const order = rows.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      const i = input.after ? order.findIndex((r) => r.id === input.after) : -1
      const max = Math.max(-1, ...rows.map((r) => r.position ?? -1))
      const position = i >= 0 ? between(order[i]!.position, order[i + 1]?.position) : max + 1
      const created = { ...row(input.id ?? `n${rows.length}`, input.set?.sts001 as string | undefined, position), title: input.title ?? '' }
      rows.push(created)
      return created
    },
    patchRow: async (_cid, rowId, patch) => {
      await patchGate
      if (failWrites) throw new Error('boom')
      patches.push(patch)
      const i = rows.findIndex((r) => r.id === rowId)
      const cur = rows[i]!
      const props = { ...cur.props }
      for (const [k, v] of Object.entries(patch.set ?? {})) {
        if (v === null) delete props[k]
        else props[k] = v
      }
      const at = (id: string | null | undefined) => (id ? rows.find((r) => r.id === id)?.position : undefined)
      const position = patch.after !== undefined || patch.before !== undefined ? between(at(patch.after), at(patch.before)) : cur.position
      rows[i] = { ...cur, props, title: patch.title ?? cur.title, position }
      return rows[i]!
    },
    trashRows: async (_cid, ids) => {
      if (failWrites) throw new Error('boom')
      rows = rows.filter((r) => !ids.includes(r.id))
      return { trashed: ids }
    },
    setRows: async (_cid, ids, set) => {
      if (failWrites) throw new Error('boom')
      bulkCalls.push(ids.length)
      rows = rows.map((r) => {
        if (!ids.includes(r.id)) return r
        const props = { ...r.props }
        for (const [k, v] of Object.entries(set)) {
          if (v === null) delete props[k]
          else props[k] = v
        }
        return { ...r, props }
      })
      return { rows: [] }
    },
    duplicateRows: async () => ({ created: [] }),
    moveRows: async (_cid, ids) => {
      if (failWrites) throw new Error('boom')
      rows = rows.filter((r) => !ids.includes(r.id))
      return { moved: ids }
    },
    tzOffset: () => 480,
  }
}

const page = (id: string, parent: string | null, title = id.toUpperCase(), kind: Page['kind'] = 'doc'): Page => ({
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
const pagesFor = (list: CollectionRow[]): Page[] => [page(CID, null, '集合', 'collection'), ...list.map((r) => page(r.id, CID, r.title))]

const flush = () => new Promise((r) => setTimeout(r, 0))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  rows = []
  links = []
  fetches = []
  failWrites = false
  patches = []
  bulkCalls = []
  creates = []
  createGate = Promise.resolve()
  patchGate = Promise.resolve()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

async function setup(groupBy: string | null = null, cache?: CacheOptions) {
  const store = createCollectionStore(transport(groupBy), cache)
  store.syncPages(pagesFor(rows))
  const h = store.open(CID)
  links[0]!.synced()
  const unwatch = h.watchWindow('v1')
  await flush()
  return { store, h, link: links[0]!, unwatch }
}

describe('连接与 schema', () => {
  test('同一集合只开一条连接，最后一个释放后保活到期才拆；schema 在同步之后才有', async () => {
    const store = createCollectionStore(transport(), { keepMs: 5 })
    const a = store.open(CID)
    const b = store.open(CID)
    expect(links).toHaveLength(1)
    expect(a.schema()).toBeNull()
    links[0]!.synced()
    expect(b.schema()?.props.map((p) => p.id)).toEqual(['sts001'])
    expect(a.status()).toBe('ready')
    a.release()
    a.release() // 同一次 open 多调无效
    b.release()
    expect(links[0]!.destroyed).toBe(false)
    await sleep(20)
    expect(links[0]!.destroyed).toBe(true)
    store.open(CID)
    expect(links).toHaveLength(2)
  })

  test('被拒绝：状态 denied；释放即拆，不保活也不留文档', () => {
    const store = createCollectionStore(transport())
    const h = store.open(CID)
    links[0]!.deny()
    expect(h.status()).toBe('denied')
    h.release()
    expect(links[0]!.destroyed).toBe(true)
    store.open(CID)
    expect(links[1]!.doc).not.toBe(links[0]!.doc)
  })
})

describe('窗口与增量', () => {
  test('首屏带时区；增量（带 prev）套上；reset 全部重取', async () => {
    rows = [row('a', TODO, 0), row('b', TODO, 1)]
    const { h, link } = await setup()
    expect(fetches[0]).toMatchObject({ view: 'v1', tz: 480 })
    expect(h.windowState('v1').window?.rows.map((r) => r.id)).toEqual(['a', 'b'])
    link.send({ t: 'collection.rows', up: [{ row: { ...row('b', DOING, -1) }, prev: { sts001: TODO } }], rm: [] })
    expect(h.windowState('v1').window?.rows.map((r) => r.id)).toEqual(['b', 'a'])
    expect(fetches).toHaveLength(1)
    link.send({ t: 'collection.rows', up: [], rm: [], reset: true })
    await flush()
    expect(fetches).toHaveLength(2)
  })

  test('视图的排序改了重取；只改列宽不重取', async () => {
    rows = [row('a')]
    const { h, link } = await setup()
    const view = (link.doc.getMap('collection').get('views') as Y.Map<Y.Map<unknown>>).get('v1')!
    ;(view.get('widths') as Y.Map<unknown>).set('title', 200)
    await flush()
    expect(fetches).toHaveLength(1)
    view.set('sorts', [{ prop: 'title', dir: 'desc' }])
    await flush()
    expect(fetches).toHaveLength(2)
    expect(h.schema()?.views[0]?.sorts).toEqual([{ prop: 'title', dir: 'desc' }])
  })

  test('取数在途时来的增量：取完再取一次', async () => {
    rows = [row('a')]
    const store = createCollectionStore(transport())
    store.syncPages(pagesFor(rows))
    const h = store.open(CID)
    links[0]!.synced()
    h.watchWindow('v1')
    links[0]!.send({ t: 'collection.rows', up: [{ row: row('a', DOING), prev: { sts001: null } }], rm: [] })
    await flush()
    await flush()
    expect(fetches).toHaveLength(2)
  })

  test('断线重连：再次同步后全部窗口重取（断开期间的增量不会重放）', async () => {
    rows = [row('a')]
    const { link } = await setup()
    expect(fetches).toHaveLength(1)
    link.synced()
    await flush()
    expect(fetches).toHaveLength(2)
  })

  test('续取按 id 去重拼接', async () => {
    rows = Array.from({ length: 70 }, (_, i) => row(`r${String(i).padStart(2, '0')}`, undefined, i))
    const { h } = await setup()
    expect(h.windowState('v1').window?.rows).toHaveLength(50)
    h.loadMore('v1')
    await flush()
    const w = h.windowState('v1').window!
    expect(w.rows).toHaveLength(70)
    expect(new Set(w.rows.map((r) => r.id)).size).toBe(70)
    expect(w.next).toBeNull()
  })
})

describe('页面列表感知行的进出与改名', () => {
  test('子页集合变了重取；只改标题本地改、不取数', async () => {
    rows = [row('a', undefined, 0), row('b', undefined, 1)]
    const { store, h } = await setup()
    store.syncPages(pagesFor(rows).map((p) => (p.id === 'a' ? { ...p, title: '新名字' } : p)))
    expect(h.windowState('v1').window?.rows[0]?.title).toBe('新名字')
    expect(fetches).toHaveLength(1)
    rows.push(row('c', undefined, 2))
    store.syncPages(pagesFor(rows))
    await flush()
    expect(fetches).toHaveLength(2)
    expect(h.windowState('v1').window?.rows.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  test('按名称排序的视图：窗口外的行改名要重取', async () => {
    rows = Array.from({ length: 60 }, (_, i) => row(`r${String(i).padStart(2, '0')}`, undefined, i))
    const { store, link } = await setup()
    ;(link.doc.getMap('collection').get('views') as Y.Map<Y.Map<unknown>>).get('v1')!.set('sorts', [{ prop: 'title', dir: 'asc' }])
    await flush()
    const before = fetches.length
    store.syncPages(pagesFor(rows).map((p) => (p.id === 'r59' ? { ...p, title: '0 排到最前' } : p)))
    await flush()
    expect(fetches.length).toBe(before + 1)
  })
})

describe('写：乐观更新、回声、失败回滚', () => {
  test('改值立刻反映；服务端随后的增量不把分组计数再改一次', async () => {
    rows = [row('a', TODO, 0), row('b', TODO, 1)]
    const { h, link } = await setup('sts001')
    expect(h.windowState('v1').window?.groups).toMatchObject({ [TODO]: 2, [DOING]: 0 })
    const done = h.setValues('a', { sts001: DOING })
    expect(h.windowState('v1').window?.groups).toMatchObject({ [TODO]: 1, [DOING]: 1 })
    expect(await done).toBe(true)
    // 投影器的增量：prev 是改之前的值
    link.send({ t: 'collection.rows', up: [{ row: rows[0]!, prev: { sts001: TODO } }], rm: [] })
    expect(h.windowState('v1').window?.groups).toMatchObject({ [TODO]: 1, [DOING]: 1 })
    expect(h.findRow('a')?.props).toEqual({ sts001: DOING })
  })

  test('看板的另一列（窗口里没有这一行）也只算一次', async () => {
    rows = [row('a', TODO, 0)]
    const { h, link } = await setup('sts001')
    const unwatch = h.watchWindow('v1', DOING)
    await flush()
    expect(h.windowState('v1', DOING).window?.total).toBe(0)
    await h.setValues('a', { sts001: DOING })
    expect(h.windowState('v1', DOING).window?.rows.map((r) => r.id)).toEqual(['a'])
    link.send({ t: 'collection.rows', up: [{ row: rows[0]!, prev: { sts001: TODO } }], rm: [] })
    expect(h.windowState('v1', DOING).window?.total).toBe(1)
    unwatch()
  })

  test('连着改同一格、服务端分批回声：计数只算一次，行不闪回中间值', async () => {
    const DONE = Object.keys(OPTS)[2]!
    rows = [row('a', TODO, 0), row('b', TODO, 1)]
    const { h, link } = await setup('sts001')
    await h.setValues('a', { sts001: DOING })
    await h.setValues('a', { sts001: DONE })
    expect(h.windowState('v1').window?.groups).toMatchObject({ [TODO]: 1, [DOING]: 0, [DONE]: 1 })
    // 第一批只回声到中间那次写
    link.send({ t: 'collection.rows', up: [{ row: { ...rows[0]!, props: { sts001: DOING } }, prev: { sts001: TODO } }], rm: [] })
    expect(h.findRow('a')?.props).toEqual({ sts001: DONE })
    expect(h.windowState('v1').window?.groups).toMatchObject({ [TODO]: 1, [DOING]: 0, [DONE]: 1 })
    link.send({ t: 'collection.rows', up: [{ row: rows[0]!, prev: { sts001: DOING } }], rm: [] })
    expect(h.findRow('a')?.props).toEqual({ sts001: DONE })
    expect(h.windowState('v1').window?.groups).toMatchObject({ [TODO]: 1, [DOING]: 0, [DONE]: 1 })
  })

  test('非法值不发请求', async () => {
    rows = [row('a')]
    const { h } = await setup()
    expect(await h.setValues('a', { sts001: 'nope' })).toBe(false)
    expect(h.error()).toBeTruthy()
    expect(h.findRow('a')?.props).toEqual({})
  })

  test('写失败：提示 + 重取，本地回到服务端的状态', async () => {
    rows = [row('a', TODO)]
    const { h } = await setup()
    failWrites = true
    expect(await h.setValues('a', { sts001: DOING })).toBe(false)
    await flush()
    expect(h.error()).toBe('boom')
    expect(h.findRow('a')?.props).toEqual({ sts001: TODO })
    expect(fetches).toHaveLength(2)
  })

  test('建行：插进窗口；随后的页面列表不再触发重取', async () => {
    rows = [row('a', undefined, 0)]
    const { store, h } = await setup()
    const created = h.createRow({ title: '新行' })!
    expect((await created.ready)?.title).toBe('新行')
    expect(h.windowState('v1').window?.rows.map((r) => r.id)).toContain(created.id)
    expect(h.windowState('v1').window?.total).toBe(2)
    store.syncPages(pagesFor(rows))
    await flush()
    expect(fetches).toHaveLength(1)
  })

  test('删行：立刻摘掉；随后的页面列表不再触发重取', async () => {
    rows = [row('a', undefined, 0), row('b', undefined, 1)]
    const { store, h } = await setup()
    const done = h.trashRows(['a'])
    expect(h.windowState('v1').window?.rows.map((r) => r.id)).toEqual(['b'])
    await done
    store.syncPages(pagesFor(rows))
    await flush()
    expect(fetches).toHaveLength(1)
    expect(h.windowState('v1').window?.total).toBe(1)
  })

  test('批量改值：已加载的行一次乐观套上，请求按上限分批；失败回到服务端的值', async () => {
    rows = Array.from({ length: 3 }, (_, i) => row(`r${i}`, TODO, i))
    const { h } = await setup()
    const ids = [...rows.map((r) => r.id), ...Array.from({ length: 600 }, (_, i) => `x${i}`)]
    const done = h.setValuesMany(ids, { sts001: DONE })
    expect(h.windowState('v1').window?.rows.map((r) => r.props.sts001)).toEqual([DONE, DONE, DONE])
    expect(await done).toBe(true)
    expect(bulkCalls).toEqual([500, 103])
    failWrites = true
    expect(await h.setValuesMany(['r0'], { sts001: TODO })).toBe(false)
    await flush()
    expect(h.findRow('r0')?.props).toEqual({ sts001: DONE })
  })

  test('挪到别的集合：立刻从窗口摘掉', async () => {
    rows = [row('a', undefined, 0), row('b', undefined, 1)]
    const { h } = await setup()
    const done = h.moveRowsTo(['a'], 'other')
    expect(h.windowState('v1').window?.rows.map((r) => r.id)).toEqual(['b'])
    expect(await done).toBe(true)
  })

  test('拖动：邻居都在窗口里就乐观挪到中点', async () => {
    rows = [row('a', undefined, 0), row('b', undefined, 1), row('c', undefined, 2)]
    const { h } = await setup()
    const done = h.moveRow('c', null, 'a')
    expect(h.windowState('v1').window?.rows.map((r) => r.id)).toEqual(['c', 'a', 'b'])
    expect(h.findRow('c')?.position).toBe(-1)
    await done
  })

  test('看板跨列拖到落点：一次乐观增量同时改值与位置，两列计数各自增减，只发一次请求', async () => {
    rows = [row('a', TODO, 0), row('b', DOING, 1), row('c', DOING, 2)]
    const { h, link } = await setup('sts001')
    h.watchWindow('v1', TODO)
    h.watchWindow('v1', DOING)
    await flush()
    const col = (key: string) => h.windowState('v1', key).window!
    expect([col(TODO).total, col(DOING).total]).toEqual([1, 2])
    const done = h.moveRow('a', 'b', 'c', { sts001: DOING })
    expect(col(TODO).rows).toEqual([])
    expect(col(DOING).rows.map((r) => r.id)).toEqual(['b', 'a', 'c'])
    expect(h.findRow('a')).toMatchObject({ props: { sts001: DOING }, position: 1.5 })
    expect([col(TODO).total, col(DOING).total]).toEqual([0, 3])
    expect(h.windowState('v1').window?.groups).toMatchObject({ [TODO]: 0, [DOING]: 3 })
    expect(await done).toBe(true)
    expect(patches).toEqual([{ set: { sts001: DOING }, after: 'b', before: 'c' }])
    // 投影器合并后的一条增量（改值 + 顺序，prev 是改之前的值）：计数与顺序都不再变
    link.send({ t: 'collection.rows', up: [{ row: rows[0]!, prev: { sts001: TODO } }], rm: [] })
    expect(col(DOING).rows.map((r) => r.id)).toEqual(['b', 'a', 'c'])
    expect([col(TODO).total, col(DOING).total]).toEqual([0, 3])
    expect(h.windowState('v1').window?.groups).toMatchObject({ [TODO]: 0, [DOING]: 3 })
  })

  test('跨列拖到落点：邻居不在窗口里也先换列，位置等服务端', async () => {
    rows = [row('a', TODO, 0), row('b', DOING, 1)]
    const { h } = await setup('sts001')
    h.watchWindow('v1', DOING)
    await flush()
    const done = h.moveRow('a', 'zz', null, { sts001: DOING })
    expect(h.findRow('a')).toMatchObject({ props: { sts001: DOING }, position: 0 })
    expect(h.windowState('v1', DOING).window?.total).toBe(2)
    await done.catch(() => undefined)
  })

  test('跨列拖动失败：提示 + 重取，卡片回到原列', async () => {
    rows = [row('a', TODO, 0), row('b', DOING, 1)]
    const { h } = await setup('sts001')
    h.watchWindow('v1', TODO)
    h.watchWindow('v1', DOING)
    await flush()
    failWrites = true
    expect(await h.moveRow('a', 'b', null, { sts001: DOING })).toBe(false)
    await flush()
    expect(h.error()).toBe('boom')
    expect(h.windowState('v1', TODO).window?.rows.map((r) => r.id)).toEqual(['a'])
    expect(h.windowState('v1', DOING).window?.rows.map((r) => r.id)).toEqual(['b'])
  })

  test('跨列拖动带非法值：不挪、不发请求', async () => {
    rows = [row('a', TODO, 0), row('b', DOING, 1)]
    const { h } = await setup('sts001')
    expect(await h.moveRow('a', 'b', null, { sts001: 'nope' })).toBe(false)
    expect(h.findRow('a')).toMatchObject({ props: { sts001: TODO }, position: 0 })
    expect(patches).toEqual([])
  })

  test('改名：本地先改，随后的页面列表不重复处理', async () => {
    rows = [row('a', undefined, 0)]
    const { store, h } = await setup()
    await h.renameRow('a', '  改了  ')
    expect(h.findRow('a')?.title).toBe('改了')
    store.syncPages(pagesFor(rows))
    expect(fetches).toHaveLength(1)
  })
})

describe('保活与冷缓存（回访秒开）', () => {
  test('保活期内再开：同一条连接、窗口原样还在，不重取', async () => {
    rows = [row('a', undefined, 0)]
    const { store, h, unwatch } = await setup()
    const w = h.windowState('v1').window
    unwatch()
    h.release()
    const again = store.open(CID)
    const off = again.watchWindow('v1')
    expect(links).toHaveLength(1)
    expect(again.status()).toBe('ready')
    expect(again.schema()).not.toBeNull()
    expect(again.windowState('v1').window).toBe(w)
    await flush()
    expect(fetches).toHaveLength(1)
    off()
  })

  test('保活期间收到的增量照常套到空闲窗口；行有进出只记下，再看时才重取', async () => {
    rows = [row('a', TODO, 0), row('b', TODO, 1)]
    const { store, h, link, unwatch } = await setup()
    unwatch()
    h.release()
    link.send({ t: 'collection.rows', up: [{ row: row('a', DOING, 0), prev: { sts001: TODO } }], rm: [] })
    rows.push(row('c', undefined, 2))
    store.syncPages(pagesFor(rows))
    await flush()
    expect(fetches).toHaveLength(1) // 没人看：不发请求
    const again = store.open(CID)
    expect(again.findRow('a')?.props).toEqual({ sts001: DOING })
    again.watchWindow('v1')
    expect(again.windowState('v1').window?.rows.map((r) => r.id)).toEqual(['a', 'b']) // 旧内容先留着
    await flush()
    expect(fetches).toHaveLength(2)
    expect(again.windowState('v1').window?.rows.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  test('保活过期后再开：新连接拿旧文档打底，schema 与旧窗口先给，同步后重取', async () => {
    rows = [row('a', undefined, 0)]
    const { store, h, unwatch } = await setup(null, { keepMs: 5 })
    unwatch()
    h.release()
    await sleep(20)
    expect(links[0]!.destroyed).toBe(true)
    rows.push(row('b', undefined, 1))
    const again = store.open(CID)
    expect(links).toHaveLength(2)
    expect(links[1]!.doc).toBe(links[0]!.doc)
    expect(again.status()).toBe('connecting')
    expect(again.schema()?.props.map((p) => p.id)).toEqual(['sts001'])
    again.watchWindow('v1')
    expect(again.windowState('v1').window?.rows.map((r) => r.id)).toEqual(['a'])
    expect(again.windowState('v1').loading).toBe(false)
    await flush()
    expect(fetches).toHaveLength(1) // 同步之前不取（断开期间的改动等同步后一次取齐）
    links[1]!.synced()
    await flush()
    expect(fetches).toHaveLength(2)
    expect(again.status()).toBe('ready')
    expect(again.windowState('v1').window?.rows.map((r) => r.id)).toEqual(['a', 'b'])
  })

  test('空闲的连接有上限：超出按最早空闲的先拆', () => {
    const store = createCollectionStore(transport(), { keepMax: 1 })
    const a = store.open('c1')
    const b = store.open('c2')
    a.release()
    expect(links[0]!.destroyed).toBe(false)
    b.release()
    expect(links[0]!.destroyed).toBe(true)
    expect(links[1]!.destroyed).toBe(false)
  })

  test('冷缓存有上限：最久没用的丢掉，再开就是全新的文档', () => {
    // keepMax 0：一释放就拆，进冷缓存
    const store = createCollectionStore(transport(), { keepMax: 0, coldMax: 1 })
    for (const cid of ['c1', 'c2']) {
      const h = store.open(cid)
      links.at(-1)!.synced()
      h.release()
    }
    expect(links.map((l) => l.destroyed)).toEqual([true, true])
    store.open('c1')
    expect(links[2]!.doc).not.toBe(links[0]!.doc)
    store.open('c2')
    expect(links[3]!.doc).toBe(links[1]!.doc)
  })

  test('reset（登出）：清掉空闲连接与冷缓存；之前打开的释放时也不再留', async () => {
    rows = [row('a', undefined, 0)]
    const { store, h, unwatch } = await setup()
    const other = store.open('c2')
    links[1]!.synced()
    unwatch()
    h.release()
    store.reset()
    expect(links[0]!.destroyed).toBe(true)
    other.release()
    expect(links[1]!.destroyed).toBe(true)
    const again = store.open(CID)
    expect(links[2]!.doc).not.toBe(links[0]!.doc)
    expect(again.schema()).toBeNull()
    expect(again.windowState('v1').window).toBeNull()
    store.open('c2')
    expect(links[3]!.doc).not.toBe(links[1]!.doc)
  })
})

describe('乐观新建', () => {
  test('确认前改名：建行触发的页面列表还带着空标题，不把窗口里的名字改回去', async () => {
    rows = [row('a', undefined, 0)]
    const { store, h } = await setup()
    let openCreate!: () => void
    let openPatch!: () => void
    createGate = new Promise((r) => (openCreate = r))
    patchGate = new Promise((r) => (openPatch = r))
    const created = h.createRow()!
    const renamed = h.renameRow(created.id, '起个名')
    openCreate()
    await created.ready
    await flush()
    // 建行的 changed 广播 → 重拉到的列表：服务端这一行还叫 ''（改名还在途）
    expect(rows.find((r) => r.id === created.id)?.title).toBe('')
    store.syncPages(pagesFor(rows))
    expect(h.findRow(created.id)?.title).toBe('起个名')
    openPatch()
    expect(await renamed).toBe(true)
    // 改名之前发起的重拉晚到：仍是旧名，照样不覆盖
    store.syncPages(pagesFor(rows.map((r) => (r.id === created.id ? { ...r, title: '' } : r))))
    expect(h.findRow(created.id)?.title).toBe('起个名')
    store.syncPages(pagesFor(rows))
    expect(h.findRow(created.id)?.title).toBe('起个名')
    expect(fetches).toHaveLength(1)
  })

  test('建行在途时别的写失败：重取落下后还没建好的行补回窗口，建成后照常', async () => {
    rows = [row('a', TODO, 0)]
    const { h } = await setup()
    let openCreate!: () => void
    createGate = new Promise((r) => (openCreate = r))
    const created = h.createRow()!
    failWrites = true
    expect(await h.setValues('a', { sts001: DOING })).toBe(false)
    await flush()
    expect(fetches).toHaveLength(2) // fail() 重取了
    expect(h.windowState('v1').window?.rows.map((r) => r.id)).toEqual(['a', created.id])
    expect(h.windowState('v1').window?.total).toBe(2)
    failWrites = false
    openCreate()
    expect((await created.ready)?.id).toBe(created.id)
    expect(h.windowState('v1').window?.rows.map((r) => r.id)).toEqual(['a', created.id])
  })

  test('行立即插进窗口（客户端定 id）；确认后取服务端的位置，标题与确认前的改名留本地的', async () => {
    rows = [row('a', undefined, 0)]
    const { h } = await setup()
    let open!: () => void
    createGate = new Promise((r) => (open = r))
    const created = h.createRow({}, { viewId: 'v1' })!
    expect(h.windowState('v1').window?.rows.map((r) => r.id)).toEqual(['a', created.id])
    expect(h.windowState('v1').window?.total).toBe(2)
    expect(creates[0]?.id).toBe(created.id)
    const renamed = h.renameRow(created.id, '起个名')
    await flush()
    expect(patches).toEqual([]) // 确认之前不发
    expect(h.findRow(created.id)?.title).toBe('起个名')
    open()
    expect((await created.ready)?.id).toBe(created.id)
    expect(await renamed).toBe(true)
    expect(patches).toEqual([{ title: '起个名' }])
    expect(h.findRow(created.id)).toMatchObject({ title: '起个名', position: 1 })
    expect(fetches).toHaveLength(1)
  })

  test('确认之前来了一份不带它的页面列表：不当成行有进出，不重取', async () => {
    rows = [row('a', undefined, 0)]
    const { store, h } = await setup()
    let open!: () => void
    createGate = new Promise((r) => (open = r))
    const created = h.createRow()!
    store.syncPages(pagesFor(rows))
    await flush()
    expect(fetches).toHaveLength(1)
    expect(h.findRow(created.id)).toBeTruthy()
    open()
    await created.ready
    store.syncPages(pagesFor(rows))
    await flush()
    expect(fetches).toHaveLength(1)
  })

  test('连点两次得到两行', async () => {
    const { h } = await setup()
    const a = h.createRow()!
    const b = h.createRow()!
    expect(a.id).not.toBe(b.id)
    expect(h.windowState('v1').window?.rows.map((r) => r.id)).toEqual([a.id, b.id])
    await Promise.all([a.ready, b.ready])
    expect(rows.map((r) => r.id)).toEqual([a.id, b.id])
    expect(h.windowState('v1').window?.total).toBe(2)
  })

  test('服务端失败：撤掉这一行并提示；确认前排队的写丢弃', async () => {
    rows = [row('a', undefined, 0)]
    const { h } = await setup()
    failWrites = true
    const created = h.createRow({ set: { sts001: DOING } })!
    expect(h.findRow(created.id)?.props).toEqual({ sts001: DOING })
    const renamed = h.renameRow(created.id, 'x')
    expect(await created.ready).toBeNull()
    expect(await renamed).toBe(false)
    await flush()
    expect(h.windowState('v1').window?.rows.map((r) => r.id)).toEqual(['a'])
    expect(h.windowState('v1').window?.total).toBe(1)
    expect(h.error()).toBe('boom')
    expect(patches).toEqual([])
  })

  test('非法初始值：什么都不建', async () => {
    const { h } = await setup()
    expect(h.createRow({ set: { sts001: 'nope' } })).toBeNull()
    expect(creates).toEqual([])
    expect(h.error()).toBeTruthy()
  })

  test('手动排序且窗口没取完：请求带 after = 已加载的末行，新行接在看得见的末尾', async () => {
    rows = Array.from({ length: 70 }, (_, i) => row(`r${String(i).padStart(2, '0')}`, undefined, i))
    const { h } = await setup()
    const created = h.createRow({}, { viewId: 'v1' })!
    expect(creates[0]?.after).toBe('r49')
    const w = h.windowState('v1').window!
    expect(w.rows).toHaveLength(51)
    expect(w.rows.at(-1)?.id).toBe(created.id)
    expect(w.total).toBe(71)
    await created.ready
    expect(h.findRow(created.id)?.position).toBe(49.5)
    // 续取：服务端从旧末行之后给，新行会再来一次，按 id 去重
    h.loadMore('v1')
    await flush()
    const all = h.windowState('v1').window!
    expect(all.rows).toHaveLength(71)
    expect(new Set(all.rows.map((r) => r.id)).size).toBe(71)
  })

  test('窗口没取完时连点两次：第二行等第一行建成再带 after = 第一行（服务端认得这个邻居）', async () => {
    rows = Array.from({ length: 70 }, (_, i) => row(`r${String(i).padStart(2, '0')}`, undefined, i))
    const { h } = await setup()
    let open!: () => void
    createGate = new Promise((r) => (open = r))
    const a = h.createRow({}, { viewId: 'v1' })!
    const b = h.createRow({}, { viewId: 'v1' })!
    expect(creates.map((c) => c.after)).toEqual(['r49'])
    expect(h.windowState('v1').window?.rows.slice(-2).map((r) => r.id)).toEqual([a.id, b.id])
    open()
    await Promise.all([a.ready, b.ready])
    expect(creates.map((c) => c.after)).toEqual(['r49', a.id])
    expect(h.findRow(a.id)!.position!).toBeLessThan(h.findRow(b.id)!.position!)
  })

  test('建行时窗口正在取数：建成后再取一次，新行不丢', async () => {
    rows = [row('a', undefined, 0)]
    const { store, h } = await setup()
    rows.push(row('b', undefined, 1))
    store.syncPages(pagesFor(rows)) // 行有进出 → 重取（在途）
    const created = h.createRow({}, { viewId: 'v1' })!
    await created.ready
    await flush()
    expect(h.windowState('v1').window?.rows.map((r) => r.id)).toEqual(['a', 'b', created.id])
  })

  test('有排序的视图不改落点（位置由查询决定）', async () => {
    rows = Array.from({ length: 70 }, (_, i) => row(`r${String(i).padStart(2, '0')}`, undefined, i))
    const { h, link } = await setup()
    ;(link.doc.getMap('collection').get('views') as Y.Map<Y.Map<unknown>>).get('v1')!.set('sorts', [{ prop: 'title', dir: 'asc' }])
    await flush()
    h.createRow({}, { viewId: 'v1' })
    expect(creates[0]?.after).toBeUndefined()
  })
})

// 窗口状态对象只在变化时换（useSyncExternalStore 的快照必须稳定）
test('窗口状态在没有变化时是同一个对象', async () => {
  rows = [row('a')]
  const { h } = await setup()
  const w: RowsWindow | null = h.windowState('v1').window
  expect(h.windowState('v1').window).toBe(w)
})
