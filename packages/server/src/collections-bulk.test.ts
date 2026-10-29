import { describe, expect, test } from 'vitest'
import { parseCollection } from '@ramet/shared/collection-model'
import { mapProps } from './collections/transfer.js'
import {
  addProp,
  call,
  editCollection,
  eventually,
  newCollection,
  pool,
  postPage,
  postRow,
  replicaOf,
  rowDoc,
  team,
  watchControl,
  windowIds,
  type Team,
} from './collections/test-kit.js'

/* 集合的批量操作：批量改值 / 复制 / 挪到别的集合。
 * 不变量：ids 只收本集合的活行；set 一次校验、非法整批不写；复制与挪走广播 changed，改值不广播 */

const bulk = (cookie: string, cid: string, op: 'set' | 'duplicate' | 'move', body: unknown) =>
  call<Record<string, unknown>>('POST', `/api/collections/${cid}/rows/${op}`, cookie, body)

async function rowsOf(t: Team, cid: string, titles: string[], set: Record<string, unknown> = {}): Promise<string[]> {
  const ids: string[] = []
  for (const title of titles) ids.push((await postRow(t.owner.cookie, cid, { title, set })).body.id as string)
  return ids
}

describe('批量改值', () => {
  test('多行一次改：文档与副本都改了，快照记给发起人；别的集合的 id 被忽略；不广播 changed', async () => {
    const t = await team()
    const c = await newCollection(t)
    const other = await newCollection(t)
    const [a, b] = await rowsOf(t, c.id, ['a', 'b'], { [c.status.id]: c.todo })
    const [x] = await rowsOf(t, other.id, ['x'], { [other.status.id]: other.todo })
    const control = await watchControl(t.viewer.cookie)

    const res = await bulk(t.member.cookie, c.id, 'set', { ids: [a, b, x], set: { [c.status.id]: c.done } })
    expect(res.status).toBe(200)
    expect((res.body.rows as { id: string }[]).map((r) => r.id).sort()).toEqual([a, b].sort())
    for (const id of [a!, b!]) {
      expect(await replicaOf(id)).toEqual({ [c.status.id]: c.done })
      await eventually(async () => expect((await rowDoc(id)).getMap('props').toJSON()).toEqual({ [c.status.id]: c.done }))
      await eventually(async () => {
        const { rows } = await pool.query('SELECT 1 FROM page_snapshots WHERE page_id = $1 AND author_id = $2', [id, t.member.id])
        expect(rows.length).toBeGreaterThan(0)
      })
    }
    expect(await replicaOf(x!)).toEqual({ [other.status.id]: other.todo })
    expect(control).not.toContain('changed')
  })

  test('任一值非法整批 400、一行都不改；空 set / 空 ids 400；viewer 403', async () => {
    const t = await team()
    const c = await newCollection(t)
    const [a] = await rowsOf(t, c.id, ['a'], { [c.status.id]: c.todo })
    expect((await bulk(t.owner.cookie, c.id, 'set', { ids: [a], set: { [c.status.id]: 'nope' } })).status).toBe(400)
    expect((await bulk(t.owner.cookie, c.id, 'set', { ids: [a], set: { zzz: 1 } })).status).toBe(400)
    expect((await bulk(t.owner.cookie, c.id, 'set', { ids: [a], set: {} })).status).toBe(400)
    expect((await bulk(t.owner.cookie, c.id, 'set', { ids: [], set: { [c.status.id]: c.done } })).status).toBe(400)
    expect(await replicaOf(a!)).toEqual({ [c.status.id]: c.todo })
    expect((await bulk(t.viewer.cookie, c.id, 'set', { ids: [a], set: { [c.status.id]: c.done } })).status).toBe(403)
    expect((await bulk(t.outsider.cookie, c.id, 'set', { ids: [a], set: { [c.status.id]: c.done } })).status).toBe(404)
  })
})

describe('批量复制', () => {
  test('副本紧跟原行，标题 / 属性 / 子页一致，有副本行；广播 changed', async () => {
    const t = await team()
    const c = await newCollection(t)
    const [a, b, d] = await rowsOf(t, c.id, ['a', 'b', 'd'], { [c.status.id]: c.doing })
    const child = await postPage(t.owner.cookie, { space_id: t.spaceId, parent_id: a, title: 'a 的子页' })
    expect(child).toBeTruthy()
    const control = await watchControl(t.viewer.cookie)

    const res = await bulk(t.member.cookie, c.id, 'duplicate', { ids: [a, b] })
    expect(res.status).toBe(201)
    const created = res.body.created as { from: string; id: string }[]
    expect(created.map((x) => x.from)).toEqual([a, b])
    const [a2, b2] = created.map((x) => x.id)
    expect(await windowIds(t.owner.cookie, c.id)).toEqual([a, a2, b, b2, d])
    for (const id of [a2!, b2!]) {
      expect(await replicaOf(id)).toEqual({ [c.status.id]: c.doing })
      expect((await rowDoc(id)).getMap('props').toJSON()).toEqual({ [c.status.id]: c.doing })
    }
    const { rows } = await pool.query<{ title: string; owner_id: string; kind: string; content_text: string | null }>(
      'SELECT title, owner_id, kind, content_text FROM pages WHERE id = $1',
      [a2],
    )
    expect(rows[0]).toMatchObject({ title: 'a', owner_id: t.member.id, kind: 'doc' })
    expect(rows[0]!.content_text).not.toBeNull()
    const kids = await pool.query<{ title: string }>('SELECT title FROM live_pages WHERE parent_id = $1', [a2])
    expect(kids.rows).toEqual([{ title: 'a 的子页' }])
    await eventually(() => expect(control).toContain('changed'))
  })

  test('viewer 403；不是本集合的行不复制', async () => {
    const t = await team()
    const c = await newCollection(t)
    const [a] = await rowsOf(t, c.id, ['a'])
    const loose = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '散页' })
    expect((await bulk(t.viewer.cookie, c.id, 'duplicate', { ids: [a] })).status).toBe(403)
    const res = await bulk(t.owner.cookie, c.id, 'duplicate', { ids: [loose] })
    expect(res.status).toBe(201)
    expect(res.body.created).toEqual([])
  })
})

describe('挪到别的集合', () => {
  test('同名同类型对应、选项按名对应、对不上的丢弃；行排到目标末尾', async () => {
    const t = await team()
    const src = await newCollection(t)
    const dst = await newCollection(t)
    await editCollection(src.id, (root) => {
      addProp(root, 'ptext', { name: '备注', type: 'text', pos: 1 })
      addProp(root, 'ptag', { name: '标签', type: 'multi_select', pos: 2, options: { ta: { name: 'A', color: 'red', pos: 0 }, tb: { name: 'B', color: 'blue', pos: 1 } } })
      addProp(root, 'pnum', { name: '分数', type: 'number', pos: 3 })
      addProp(root, 'pown', { name: '负责人', type: 'person', pos: 4 })
    })
    await editCollection(dst.id, (root) => {
      addProp(root, 'qtext', { name: '备注', type: 'text', pos: 1 })
      addProp(root, 'qtag', { name: '标签', type: 'multi_select', pos: 2, options: { ub: { name: 'B', color: 'gray', pos: 0 } } })
      // 同名不同类型：不对应
      addProp(root, 'qnum', { name: '分数', type: 'text', pos: 3 })
      addProp(root, 'qown', { name: '负责人', type: 'person', pos: 4 })
    })
    const [old] = await rowsOf(t, dst.id, ['old'])
    const [r] = await rowsOf(t, src.id, ['r'], {
      [src.status.id]: src.done,
      ptext: '说明',
      ptag: ['ta', 'tb'],
      pnum: 3,
      pown: [t.member.id],
    })
    const control = await watchControl(t.viewer.cookie)

    const res = await bulk(t.member.cookie, src.id, 'move', { ids: [r], to: dst.id })
    expect(res.status).toBe(200)
    expect(res.body.moved).toEqual([r])
    const want = { [dst.status.id]: dst.done, qtext: '说明', qtag: ['ub'], qown: [t.member.id] }
    expect(await replicaOf(r!)).toEqual(want)
    await eventually(async () => expect((await rowDoc(r!)).getMap('props').toJSON()).toEqual(want))
    expect(await windowIds(t.owner.cookie, src.id)).toEqual([])
    expect(await windowIds(t.owner.cookie, dst.id)).toEqual([old, r])
    await eventually(() => expect(control).toContain('changed'))
  })

  test('目标是自己 / 不是集合 / 在回收站 / 别的空间 400 或 404；目标只读 403', async () => {
    const t = await team()
    const src = await newCollection(t)
    const [r] = await rowsOf(t, src.id, ['r'])
    const page = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '页' })
    expect((await bulk(t.owner.cookie, src.id, 'move', { ids: [r], to: src.id })).status).toBe(400)
    expect((await bulk(t.owner.cookie, src.id, 'move', { ids: [r] })).status).toBe(400)
    expect((await bulk(t.owner.cookie, src.id, 'move', { ids: [r], to: page })).status).toBe(404)
    const gone = await newCollection(t)
    expect((await call('POST', `/api/pages/${gone.id}/trash`, t.owner.cookie, {})).status).toBe(200)
    expect((await bulk(t.owner.cookie, src.id, 'move', { ids: [r], to: gone.id })).status).toBe(404)
    // 别的空间：owner 自己的个人空间里的集合
    const mine = await call<{ id: string }>('GET', '/api/spaces', t.owner.cookie)
    const personal = (mine.body as unknown as { id: string; is_personal: boolean }[]).find((s) => s.is_personal)
    if (personal) {
      const far = await call<{ id: string }>('POST', '/api/collections', t.owner.cookie, { space_id: personal.id })
      expect((await bulk(t.owner.cookie, src.id, 'move', { ids: [r], to: far.body.id })).status).toBe(400)
    }
    // viewer：源集合就写不了
    const dst = await newCollection(t)
    expect((await bulk(t.viewer.cookie, src.id, 'move', { ids: [r], to: dst.id })).status).toBe(403)
    const { rows } = await pool.query('SELECT parent_id FROM pages WHERE id = $1', [r])
    expect(rows[0]).toEqual({ parent_id: src.id })
  })
})

describe('纯函数 mapProps', () => {
  test('同名重复时按顺序各对一个；created_time 之类不存值的跳过；未知键丢弃', () => {
    const from = parseCollection({
      v: 1,
      props: { a: { name: 'x', type: 'text', pos: 0 }, b: { name: 'x', type: 'text', pos: 1 }, c: { name: '状态', type: 'select', pos: 2, options: { o1: { name: '开', color: 'red', pos: 0 } } } },
      views: {},
    })
    const to = parseCollection({
      v: 1,
      props: { p: { name: ' x ', type: 'text', pos: 0 }, q: { name: 'x', type: 'text', pos: 1 }, s: { name: '状态', type: 'select', pos: 2, options: { k9: { name: '关', color: 'red', pos: 0 } } } },
      views: {},
    })
    expect(mapProps(from, to, { a: '1', b: '2', c: 'o1', zz: 'drop' }, new Set())).toEqual({ p: '1', q: '2' })
  })
})
