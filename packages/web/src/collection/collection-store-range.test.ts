import { beforeEach, describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { newView, parseCollection, type CollectionRow, type RowsDelta } from '@ramet/shared/collection-model'
import { queryWindow } from '@ramet/shared/collection-query'
import type { Page } from '../api'
import type { NewRowInput, RowPatch } from './collection-api'
import { createCollectionStore, type CollectionLink, type CollectionTransport, type RowsQuery } from './collection-store'
import { IDLE_RANGE_MAX } from './collection-windows'

/* 按日期范围取的窗口（日历 / 时间线）在 store 里：窗口按 (视图, 范围) 区分，首屏带 range、按上限取；
 * 乐观改日期时行在各个范围的窗口之间进出、计数精确，服务端随后的回声不再改一次；换了日期属性重取；冷缓存按同一个范围打底；
 * 没人看的范围窗口有上限。
 * 通用的连接 / 增量 / 乐观写在 collection-store.test.ts，这里的假服务端只够日期范围用 */

const CID = 'c1'
const OCT = '2026-10-01..2026-10-31'
const NOV = '2026-11-01..2026-11-30'

let rows: CollectionRow[] = []
let links: FakeLink[] = []
let fetches: RowsQuery[] = []
let patches: RowPatch[] = []
let creates: NewRowInput[] = []

type FakeLink = CollectionLink & { synced: () => void; send: (delta: RowsDelta) => void; destroyed: boolean }

/** 集合文档：一个日期属性 + 按它排的日历视图 cal */
function seedDoc(doc: Y.Doc): void {
  doc.transact(() => {
    const root = doc.getMap<unknown>('collection')
    root.set('v', 1)
    const props = new Y.Map<unknown>()
    root.set('props', props)
    const dat = new Y.Map<unknown>()
    props.set('dat001', dat)
    dat.set('name', '日期')
    dat.set('type', 'date')
    dat.set('pos', 0)
    const views = new Y.Map<unknown>()
    root.set('views', views)
    const view = new Y.Map<unknown>()
    views.set('cal', view)
    const { widths: _w, ...settings } = newView('日历', 'calendar', 0, null, 'dat001')
    for (const [k, v] of Object.entries(settings)) view.set(k, v)
    view.set('widths', new Y.Map())
  })
}

const row = (id: string, dat: string | undefined, position: number): CollectionRow => ({
  id,
  title: id.toUpperCase(),
  icon: null,
  props: dat ? { dat001: dat } : {},
  position,
  created_at: '2026-10-25 00:00:00+00',
  edited_at: '2026-10-25 00:00:00+00',
  has_body: false,
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
        destroy: () => {
          link.destroyed = true
        },
        destroyed: false,
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
      return queryWindow(rows, view, schema, { group: q.group, range: q.range, cursor: q.cursor, limit: q.limit }, { tzOffset: q.tz })
    },
    createRow: async (_cid, input) => {
      creates.push(input)
      const created = { ...row(input.id ?? `n${rows.length}`, input.set?.dat001 as string | undefined, rows.length), title: input.title ?? '' }
      rows.push(created)
      return created
    },
    patchRow: async (_cid, rowId, patch) => {
      patches.push(patch)
      const i = rows.findIndex((r) => r.id === rowId)
      const props = { ...rows[i]!.props }
      for (const [k, v] of Object.entries(patch.set ?? {})) {
        if (v === null) delete props[k]
        else props[k] = v
      }
      rows[i] = { ...rows[i]!, props }
      return rows[i]!
    },
    trashRows: unused,
    setRows: unused,
    duplicateRows: unused,
    moveRows: unused,
    tzOffset: () => 480,
  }
}

const page = (id: string, parent: string | null, kind: Page['kind'] = 'doc'): Page => ({
  id,
  parent_id: parent,
  title: id.toUpperCase(),
  kind,
  created_at: '',
  space_id: 's1',
  published: false,
  publish_includes_runs: false,
  icon: null,
})
const pagesFor = (list: CollectionRow[]): Page[] => [page(CID, null, 'collection'), ...list.map((r) => page(r.id, CID))]

const flush = () => new Promise((r) => setTimeout(r, 0))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  rows = []
  links = []
  fetches = []
  patches = []
  creates = []
})

/** 打开集合、同步、看十月那一屏 */
async function calendar() {
  const store = createCollectionStore(transport())
  store.syncPages(pagesFor(rows))
  const h = store.open(CID)
  links[0]!.synced()
  h.watchWindow('cal', { range: OCT })
  await flush()
  return { h, link: links[0]! }
}

describe('按日期范围取的窗口（日历 / 时间线）', () => {
  test('首屏带范围、按上限取；只有范围里的行；不限范围的窗口是另一个', async () => {
    rows = [row('a', '2026-10-03', 0), row('b', '2026-09-30/2026-10-01', 1), row('c', '2026-11-01', 2), row('d', undefined, 3)]
    const { h } = await calendar()
    expect(fetches[0]).toMatchObject({ view: 'cal', range: OCT, limit: 100, tz: 480 })
    expect(fetches[0]?.group).toBeUndefined()
    expect(h.windowState('cal', { range: OCT }).window?.rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(h.windowState('cal', { range: OCT }).window?.range).toBe(OCT)
    expect(h.windowState('cal').window).toBeNull()
  })

  test('乐观改日期：挪出范围立刻摘掉、挪进来立刻出现；服务端随后的增量不把计数再改一次', async () => {
    rows = [row('a', '2026-10-03', 0), row('b', '2026-10-05', 1), row('c', '2026-11-02', 2)]
    const { h, link } = await calendar()
    h.watchWindow('cal', { range: NOV })
    await flush()
    const oct = () => h.windowState('cal', { range: OCT }).window!
    const nov = () => h.windowState('cal', { range: NOV }).window!
    const moved = h.setValues('a', { dat001: '2026-11-04' })
    expect(oct().rows.map((r) => r.id)).toEqual(['b'])
    expect(oct().total).toBe(1)
    expect(nov().rows.map((r) => r.id)).toEqual(['a', 'c'])
    expect(nov().total).toBe(2)
    expect(await moved).toBe(true)
    link.send({ t: 'collection.rows', up: [{ row: rows[0]!, prev: { dat001: '2026-10-03' } }], rm: [] })
    expect(oct().total).toBe(1)
    expect(nov().total).toBe(2)
    expect(nov().rows.map((r) => r.id)).toEqual(['a', 'c'])
    // 拉成跨月的区间：两边都有它
    await h.setValues('c', { dat001: '2026-10-30/2026-11-02' })
    expect(oct().rows.map((r) => r.id)).toEqual(['b', 'c'])
    expect(nov().rows.map((r) => r.id)).toEqual(['a', 'c'])
    expect(patches.at(-1)).toEqual({ set: { dat001: '2026-10-30/2026-11-02' } })
  })

  test('新建带日期的行：落进那个范围的窗口；未排期（none）的窗口收没日期的', async () => {
    rows = [row('a', '2026-10-03', 0)]
    const { h } = await calendar()
    h.watchWindow('cal', { range: 'none' })
    await flush()
    const created = h.createRow({ set: { dat001: '2026-10-20' } }, { viewId: 'cal', range: OCT })!
    expect(h.windowState('cal', { range: OCT }).window?.rows.map((r) => r.id)).toEqual(['a', created.id])
    expect(h.windowState('cal', { range: 'none' }).window?.rows).toEqual([])
    const blank = h.createRow({}, { viewId: 'cal', range: 'none' })!
    expect(h.windowState('cal', { range: 'none' }).window?.rows.map((r) => r.id)).toEqual([blank.id])
    await created.ready
    await blank.ready
    expect(creates.map((c) => c.set)).toEqual([{ dat001: '2026-10-20' }, undefined])
  })

  test('换了日期属性：按范围取的窗口重取', async () => {
    rows = [row('a', '2026-10-03', 0)]
    const { h, link } = await calendar()
    const before = fetches.length
    ;((link.doc.getMap('collection').get('views') as Y.Map<Y.Map<unknown>>).get('cal') as Y.Map<unknown>).set('dateBy', null)
    await flush()
    expect(fetches.length).toBe(before + 1)
    expect(h.windowState('cal', { range: OCT }).window?.range).toBeUndefined()
  })

  test('冷缓存：按范围取的窗口原样打底，同步后按同一个范围重取', async () => {
    rows = [row('a', '2026-10-03', 0)]
    const store = createCollectionStore(transport(), { keepMs: 1 })
    store.syncPages(pagesFor(rows))
    const first = store.open(CID)
    links[0]!.synced()
    const off = first.watchWindow('cal', { range: OCT })
    await flush()
    off()
    first.release()
    await sleep(10)
    expect(links[0]!.destroyed).toBe(true)
    fetches = []
    const second = store.open(CID)
    expect(second.windowState('cal', { range: OCT }).window?.rows.map((r) => r.id)).toEqual(['a'])
    second.watchWindow('cal', { range: OCT })
    links[1]!.synced()
    await flush()
    expect(fetches).toEqual([expect.objectContaining({ view: 'cal', range: OCT })])
  })

  test('翻过很多个月：没人看的范围窗口只留最近的 IDLE_RANGE_MAX 个，还在看的与不限范围的不丢；丢掉的再看就重取', async () => {
    rows = [row('a', '2026-10-03', 0)]
    const { h } = await calendar()
    const offAll = h.watchWindow('cal')
    await flush()
    offAll()
    const month = (i: number): string => {
      const m = String((i % 12) + 1).padStart(2, '0')
      const y = 2020 + Math.floor(i / 12)
      return `${y}-${m}-01..${y}-${m}-28`
    }
    const count = IDLE_RANGE_MAX + 3
    for (let i = 0; i < count; i++) {
      const off = h.watchWindow('cal', { range: month(i) })
      await flush()
      off()
    }
    const kept = Array.from({ length: count }, (_, i) => h.windowState('cal', { range: month(i) }).window !== null)
    expect(kept).toEqual(Array.from({ length: count }, (_, i) => i >= count - IDLE_RANGE_MAX))
    expect(h.windowState('cal', { range: OCT }).window?.rows.map((r) => r.id)).toEqual(['a'])
    expect(h.windowState('cal').window).not.toBeNull()
    fetches = []
    h.watchWindow('cal', { range: month(0) })
    expect(fetches).toEqual([expect.objectContaining({ range: month(0) })])
  })
})
