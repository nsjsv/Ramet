import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { STATUS_GROUPS } from '@ramet/shared/collection-model'
import { extractTitle, setDocTitle } from './collab.js'
import { initDb } from './db.js'
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
  watchControl,
  windowIds,
} from './collections/test-kit.js'

// 集合的数据底座：建集合、建行、改值 / 改名 / 手动顺序、回收与删除、挪进挪出。
// 不变量：属性值的真相在行文档的 Y.Map('props')，副本由投影器维护；改值与拖动排序只发集合增量
// （只给正连着集合文档的连接），不广播全站的 changed；行的进出、改名照常走页面列表的 changed

/** 等一个去抖周期以上：投影器约 100ms 写副本、增量约 100ms 一批 */
const QUIET_MS = 600

async function pageRow(id: string) {
  const { rows } = await pool.query<{ kind: string; parent_id: string | null; title: string; owner_id: string; deleted_at: string | null; position: number | null }>(
    'SELECT kind, parent_id, title, owner_id, deleted_at, position FROM pages WHERE id = $1',
    [id],
  )
  return rows[0]
}

describe('建集合', () => {
  test('kind 约束接受 collection；重复启动幂等（约束只有一条且含 collection）', async () => {
    await initDb(pool)
    await initDb(pool)
    const { rows } = await pool.query<{ def: string }>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'pages_kind_known'",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.def).toContain("'collection'")
    expect(rows[0]!.def).toContain("'skill'")
  })

  test('建整页集合：页面 kind 是 collection、有 collections 行，文档里是「状态」属性 + 一个表格视图，广播 changed', async () => {
    const t = await team()
    const control = await watchControl(t.member.cookie)
    const res = await postCollection(t.member.cookie, { space_id: t.spaceId, title: ' 迭代任务 ' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ kind: 'collection', title: '迭代任务', space_id: t.spaceId, parent_id: null, inline: false })
    const id = res.body.id
    expect(await pageRow(id)).toMatchObject({ kind: 'collection', title: '迭代任务', owner_id: t.member.id })
    const coll = await pool.query<{ inline: boolean }>('SELECT inline FROM collections WHERE page_id = $1', [id])
    expect(coll.rows).toEqual([{ inline: false }])

    const schema = await schemaOf(id)
    expect(schema.props).toHaveLength(1)
    expect(schema.props[0]).toMatchObject({ name: '状态', type: 'status' })
    expect(schema.props[0]!.options.map((o) => o.group)).toEqual(STATUS_GROUPS.map((g) => g.id))
    expect(schema.views).toHaveLength(1)
    expect(schema.views[0]).toMatchObject({ layout: 'table', filter: { all: [] }, sorts: [], groupBy: null })
    expect(extractTitle(await rowDoc(id))).toBe('迭代任务')
    await eventually(() => expect(control).toContain('changed'))
  })

  test('客户端给的 id：小写 uuid v4 照用；已被占用（含回收站里的）409；形状不对 400', async () => {
    const t = await team()
    const id = crypto.randomUUID()
    const ok = await postCollection(t.owner.cookie, { id, space_id: t.spaceId })
    expect(ok.status).toBe(201)
    expect(ok.body.id).toBe(id)
    expect((await postCollection(t.owner.cookie, { id, space_id: t.spaceId })).status).toBe(409)
    // 普通页面的 id、回收站里页面的 id 也算占用（不能借建集合覆写别人的文档）
    const page = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '别的页' })
    expect((await postCollection(t.owner.cookie, { id: page, space_id: t.spaceId })).status).toBe(409)
    expect(extractTitle(await rowDoc(page))).toBe('别的页')
    expect((await call('POST', `/api/pages/${page}/trash`, t.owner.cookie, {})).status).toBe(200)
    expect((await postCollection(t.owner.cookie, { id: page, space_id: t.spaceId })).status).toBe(409)
    for (const bad of [id.toUpperCase(), 'not-a-uuid', 42, '6ba7b810-9dad-11d1-80b4-00c04fd430c8']) {
      expect((await postCollection(t.owner.cookie, { id: bad, space_id: t.spaceId })).status).toBe(400)
    }
  })

  test('内联集合：必须给父页（同空间、可见）；collections.inline = true', async () => {
    const t = await team()
    expect((await postCollection(t.owner.cookie, { space_id: t.spaceId, inline: true })).status).toBe(400)
    const host = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '宿主' })
    const res = await postCollection(t.owner.cookie, { space_id: t.spaceId, inline: true, parent_id: host })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ parent_id: host, inline: true })
    const coll = await pool.query<{ inline: boolean }>('SELECT inline FROM collections WHERE page_id = $1', [res.body.id])
    expect(coll.rows).toEqual([{ inline: true }])
    // 父页在别的空间（outsider 的个人空间）：与不存在同响应
    const foreign = await postPage(t.outsider.cookie, { title: '别人的页' })
    expect((await postCollection(t.owner.cookie, { space_id: t.spaceId, inline: true, parent_id: foreign })).status).toBe(400)
  })

  test('父页只能为空或是活的 doc 页：挂在集合 / 过程页 / 回收站里的页下面 400（同 parent not found）', async () => {
    const t = await team()
    const c = await newCollection(t)
    const run = crypto.randomUUID()
    await pool.query(`INSERT INTO pages (id, owner_id, space_id, kind, title) VALUES ($1, $2, $3, 'run', '过程')`, [
      run,
      t.owner.id,
      t.spaceId,
    ])
    const trashed = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '要删的' })
    expect((await call('POST', `/api/pages/${trashed}/trash`, t.owner.cookie, {})).status).toBe(200)
    for (const parent of [c.id, run, trashed]) {
      for (const inline of [true, false]) {
        const res = await postCollection(t.owner.cookie, { space_id: t.spaceId, parent_id: parent, inline })
        expect(res.status, `${parent} ${inline}`).toBe(400)
        expect(res.body).toEqual({ error: 'parent_id not found' })
      }
    }
    expect((await pool.query("SELECT 1 FROM pages WHERE kind = 'collection'")).rows).toHaveLength(1)
    // doc 父页照常
    const host = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '宿主' })
    expect((await postCollection(t.owner.cookie, { space_id: t.spaceId, parent_id: host })).status).toBe(201)
  })

  test('viewer 403；非成员与空间不存在同 404；入参形状不对 400', async () => {
    const t = await team()
    expect((await postCollection(t.viewer.cookie, { space_id: t.spaceId })).status).toBe(403)
    const outsider = await postCollection(t.outsider.cookie, { space_id: t.spaceId })
    const missing = await postCollection(t.outsider.cookie, { space_id: crypto.randomUUID() })
    expect(outsider.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(outsider.body).toEqual(missing.body)
    expect((await postCollection(t.owner.cookie, {})).status).toBe(400)
    expect((await postCollection(t.owner.cookie, { space_id: t.spaceId, title: 3 })).status).toBe(400)
    expect((await postCollection(t.owner.cookie, { space_id: t.spaceId, inline: 'yes' })).status).toBe(400)
    expect((await pool.query("SELECT 1 FROM pages WHERE kind = 'collection'")).rows).toHaveLength(0)
  })
})

describe('建行', () => {
  test('返回 Row：kind=doc、父页是集合；标题双写；初始值进行文档并投影进副本；广播 changed', async () => {
    const t = await team()
    const c = await newCollection(t)
    const control = await watchControl(t.member.cookie)
    const res = await postRow(t.member.cookie, c.id, { title: ' 第一行 ', set: { [c.status.id]: c.doing } })
    expect(res.status).toBe(201)
    const row = res.body
    expect(row).toMatchObject({ title: '第一行', props: { [c.status.id]: c.doing }, position: 0, icon: null })
    expect(typeof row.created_at).toBe('string')
    expect(typeof row.edited_at).toBe('string')
    expect(await pageRow(row.id)).toMatchObject({ kind: 'doc', parent_id: c.id, title: '第一行', owner_id: t.member.id })
    const doc = await rowDoc(row.id)
    expect(extractTitle(doc)).toBe('第一行')
    expect(doc.getMap('props').toJSON()).toEqual({ [c.status.id]: c.doing })
    expect(await replicaOf(row.id)).toEqual({ [c.status.id]: c.doing })
    await eventually(() => expect(control).toContain('changed'))
    // 不带值的行：副本行照样有（空属性）；默认排在末尾
    const bare = await postRow(t.member.cookie, c.id)
    expect(bare.status).toBe(201)
    expect(bare.body).toMatchObject({ title: '', position: 1 })
    expect(bare.body.props).toEqual({})
    expect(await replicaOf(bare.body.id)).toEqual({})
    expect(await windowIds(t.viewer.cookie, c.id)).toEqual([row.id, bare.body.id])
  })

  test('非法初始值 400，什么都不建', async () => {
    const t = await team()
    const c = await newCollection(t)
    for (const set of [{ [c.status.id]: 'nope' }, { zzzzzz: 1 }, { title: 'x' }, { [c.status.id]: 1 }]) {
      expect((await postRow(t.owner.cookie, c.id, { title: 'x', set })).status).toBe(400)
    }
    expect((await postRow(t.owner.cookie, c.id, { set: 'x' })).status).toBe(400)
    expect((await pool.query("SELECT 1 FROM pages WHERE kind = 'doc'")).rows).toHaveLength(0)
  })

  test('after / before 定位置：夹在邻居中间；邻居不是这个集合的行 400', async () => {
    const t = await team()
    const c = await newCollection(t)
    const a = (await postRow(t.owner.cookie, c.id, { title: 'a' })).body
    const b = (await postRow(t.owner.cookie, c.id, { title: 'b' })).body
    const mid = await postRow(t.owner.cookie, c.id, { title: 'mid', after: a.id, before: b.id })
    expect(mid.status).toBe(201)
    expect(mid.body.position).toBe(0.5)
    const first = await postRow(t.owner.cookie, c.id, { title: 'first', before: a.id })
    expect(first.body.position).toBe(-1)
    expect(await windowIds(t.owner.cookie, c.id)).toEqual([first.body.id, a.id, mid.body.id, b.id])
    const other = await newCollection(t, { title: '另一个' })
    const stranger = (await postRow(t.owner.cookie, other.id, { title: 's' })).body
    expect((await postRow(t.owner.cookie, c.id, { after: stranger.id })).status).toBe(400)
    expect((await postRow(t.owner.cookie, c.id, { after: a.id, before: a.id })).status).toBe(400)
  })

  test('客户端给 id（乐观新建）：照用；不是小写 uuid v4 400；已被占用 409，原页不受影响', async () => {
    const t = await team()
    const c = await newCollection(t)
    const id = crypto.randomUUID()
    const res = await postRow(t.member.cookie, c.id, { id, title: '乐观', set: { [c.status.id]: c.doing } })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ id, title: '乐观', props: { [c.status.id]: c.doing } })
    expect(await pageRow(id)).toMatchObject({ kind: 'doc', parent_id: c.id })
    for (const bad of ['x', id.toUpperCase(), 1, null]) {
      expect((await postRow(t.member.cookie, c.id, { id: bad })).status).toBe(400)
    }
    // 重复：同一行再建一次、或撞上别的页面（这里是集合页自己）都是 409，什么都不改
    const again = await postRow(t.member.cookie, c.id, { id, title: '覆盖' })
    expect(again.status).toBe(409)
    expect((await postRow(t.member.cookie, c.id, { id: c.id })).status).toBe(409)
    expect(await pageRow(id)).toMatchObject({ title: '乐观' })
    expect(extractTitle(await rowDoc(id))).toBe('乐观')
    expect((await schemaOf(c.id)).props.map((p) => p.id)).toContain(c.status.id)
    expect(await windowIds(t.owner.cookie, c.id)).toEqual([id])
  })

  test('viewer 403；非成员 404；不是集合的页面 404（与不存在同响应）', async () => {
    const t = await team()
    const c = await newCollection(t)
    expect((await postRow(t.viewer.cookie, c.id, { title: 'x' })).status).toBe(403)
    const outsider = await postRow(t.outsider.cookie, c.id, { title: 'x' })
    expect(outsider.status).toBe(404)
    const doc = await postPage(t.owner.cookie, { space_id: t.spaceId })
    const notCollection = await postRow(t.owner.cookie, doc, { title: 'x' })
    const missing = await postRow(t.owner.cookie, crypto.randomUUID(), { title: 'x' })
    expect(notCollection.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(notCollection.body).toEqual(missing.body)
    expect(outsider.body).toEqual(missing.body)
    // 读：viewer 能看窗口，非成员 404
    expect((await getRows(t.viewer.cookie, c.id)).status).toBe(200)
    expect((await getRows(t.outsider.cookie, c.id)).status).toBe(404)
    expect((await getRows(t.owner.cookie, doc)).status).toBe(404)
  })
})

describe('改值', () => {
  test('合法值写进行文档（快照作者是改的人），副本当场更新，集合连接收到带 prev 的增量，不广播 changed', async () => {
    const t = await team()
    const c = await newCollection(t)
    const row = (await postRow(t.owner.cookie, c.id, { title: 'r', set: { [c.status.id]: c.todo } })).body
    const deltas = await watchCollection(c.id, t.viewer.cookie)
    const control = await watchControl(t.viewer.cookie)

    const res = await patchRow(t.member.cookie, c.id, row.id, { set: { [c.status.id]: c.doing } })
    expect(res.status).toBe(200)
    expect(res.body.props).toEqual({ [c.status.id]: c.doing })
    // 响应前副本已落库：不等去抖
    expect(await replicaOf(row.id)).toEqual({ [c.status.id]: c.doing })
    await eventually(async () => expect((await rowDoc(row.id)).getMap('props').toJSON()).toEqual({ [c.status.id]: c.doing }))
    await eventually(async () => {
      const { rows } = await pool.query<{ author_id: string | null; actor: string }>(
        'SELECT author_id, actor FROM page_snapshots WHERE page_id = $1',
        [row.id],
      )
      expect(rows).toContainEqual({ author_id: t.member.id, actor: 'user' })
    })
    await eventually(() => {
      const ups = updatesOf(deltas, row.id)
      expect(ups.at(-1)?.row.props).toEqual({ [c.status.id]: c.doing })
      expect(ups.at(-1)?.prev).toEqual({ [c.status.id]: c.todo })
    })
    // 清空：null 删键，prev 记旧值
    const cleared = await patchRow(t.member.cookie, c.id, row.id, { set: { [c.status.id]: null } })
    expect(cleared.status).toBe(200)
    expect(cleared.body.props).toEqual({})
    expect(await replicaOf(row.id)).toEqual({})
    await eventually(() => expect(updatesOf(deltas, row.id).at(-1)?.prev).toEqual({ [c.status.id]: c.doing }))
    await delay(QUIET_MS)
    expect(control).not.toContain('changed')
    // 增量只走集合文档，不上全站信令
    expect(control.some((p) => p.includes('collection.rows'))).toBe(false)
  })

  test('非法值（选项不存在 / 类型不符 / 人员不是成员 / 超长 / 只读属性 / 未知属性）400，文档与副本都不动', async () => {
    const t = await team()
    const c = await newCollection(t)
    await editCollection(c.id, (root) => {
      addProp(root, 'ptext', { name: '备注', type: 'text', pos: 1 })
      addProp(root, 'ppers', { name: '负责人', type: 'person', pos: 2 })
      addProp(root, 'pmade', { name: '创建时间', type: 'created_time', pos: 3 })
    })
    const row = (await postRow(t.owner.cookie, c.id, { title: 'r', set: { [c.status.id]: c.todo, ptext: '原文' } })).body
    const bad: Record<string, unknown>[] = [
      { [c.status.id]: 'nope00' },
      { [c.status.id]: 3 },
      { ptext: 5 },
      { ptext: 'x'.repeat(2001) },
      { ptext: 'a\u0000b' },
      { ppers: [t.outsider.id] },
      { ppers: t.member.id },
      { pmade: '2026-01-01' },
      { nosuch: 'x' },
      // 一个合法一个非法：整个请求不写
      { ptext: '新文', [c.status.id]: 'nope00' },
    ]
    for (const set of bad) {
      const res = await patchRow(t.member.cookie, c.id, row.id, { set })
      expect(res.status).toBe(400)
    }
    expect((await patchRow(t.member.cookie, c.id, row.id, { set: 'x' })).status).toBe(400)
    expect(await replicaOf(row.id)).toEqual({ [c.status.id]: c.todo, ptext: '原文' })
    expect((await rowDoc(row.id)).getMap('props').toJSON()).toEqual({ [c.status.id]: c.todo, ptext: '原文' })
    // 成员合法；人员多选去重
    const ok = await patchRow(t.member.cookie, c.id, row.id, { set: { ppers: [t.member.id, t.viewer.id, t.member.id] } })
    expect(ok.status).toBe(200)
    expect(ok.body.props.ppers).toEqual([t.member.id, t.viewer.id])
  })

  test('viewer 403；非成员 404；行不属于这个集合 404', async () => {
    const t = await team()
    const c = await newCollection(t)
    const other = await newCollection(t, { title: '另一个' })
    const row = (await postRow(t.owner.cookie, c.id, { title: 'r' })).body
    const set = { set: { [c.status.id]: c.doing } }
    expect((await patchRow(t.viewer.cookie, c.id, row.id, set)).status).toBe(403)
    expect((await patchRow(t.outsider.cookie, c.id, row.id, set)).status).toBe(404)
    expect((await patchRow(t.owner.cookie, other.id, row.id, set)).status).toBe(404)
    const page = await postPage(t.owner.cookie, { space_id: t.spaceId })
    expect((await patchRow(t.owner.cookie, c.id, page, set)).status).toBe(404)
    expect(await replicaOf(row.id)).toEqual({})
  })
})

describe('改属性定义与视图', () => {
  test('经集合文档的协同连接改属性名与视图设置：存储钩子跑完也不广播 changed，也不发行增量', async () => {
    const t = await team()
    const c = await newCollection(t)
    await postRow(t.owner.cookie, c.id, { title: 'r', set: { [c.status.id]: c.todo } })
    const control = await watchControl(t.viewer.cookie)
    const deltas = await watchCollection(c.id, t.viewer.cookie)
    const doc = new Y.Doc()
    await connect(`page:${c.id}`, t.member.cookie, { doc })
    const root = doc.getMap<unknown>('collection')
    const status = (root.get('props') as Y.Map<unknown>).get(c.status.id) as Y.Map<unknown>
    const view = (root.get('views') as Y.Map<unknown>).get(c.schema.views[0]!.id) as Y.Map<unknown>
    doc.transact(() => {
      status.set('name', '阶段')
      view.set('sorts', [{ prop: c.status.id, dir: 'desc' }])
    })
    await eventually(async () => expect((await schemaOf(c.id)).props[0]?.name).toBe('阶段'))
    // 存储钩子（自动快照所在的那一步）确实跑过了，才算覆盖到「存储时也不广播」
    await eventually(async () => {
      const { rows } = await pool.query('SELECT 1 FROM page_snapshots WHERE page_id = $1 AND author_id = $2', [c.id, t.member.id])
      expect(rows.length).toBeGreaterThan(0)
    })
    await delay(QUIET_MS)
    expect(control).not.toContain('changed')
    expect(deltas).toHaveLength(0)
  })
})

describe('改名', () => {
  test('行文档的标题片段与 pages.title 一起改，广播 changed', async () => {
    const t = await team()
    const c = await newCollection(t)
    const row = (await postRow(t.owner.cookie, c.id, { title: '旧名' })).body
    const control = await watchControl(t.viewer.cookie)
    const res = await patchRow(t.member.cookie, c.id, row.id, { title: '  新名字 ' })
    expect(res.status).toBe(200)
    expect(res.body.title).toBe('新名字')
    expect((await pageRow(row.id))?.title).toBe('新名字')
    await eventually(async () => expect(extractTitle(await rowDoc(row.id))).toBe('新名字'))
    expect((await rowDoc(row.id)).getXmlFragment('title').length).toBe(1)
    await eventually(() => expect(control).toContain('changed'))
    expect((await patchRow(t.member.cookie, c.id, row.id, { title: 1 })).status).toBe(400)
  })

  test('setDocTitle：改第一段的文字、删多余段落、换掉带格式的文字；标题没变不产生增量', () => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment('title')
    const p1 = new Y.XmlElement('paragraph')
    const p2 = new Y.XmlElement('paragraph')
    fragment.insert(0, [p1, p2])
    const text = new Y.XmlText()
    p1.insert(0, [text])
    text.insert(0, '粗体', { strong: true })
    const t2 = new Y.XmlText()
    p2.insert(0, [t2])
    t2.insert(0, '第二段')
    setDocTitle(doc, '新标题')
    expect(extractTitle(doc)).toBe('新标题')
    expect(fragment.length).toBe(1)
    expect((fragment.get(0) as Y.XmlElement).length).toBe(1)
    let updates = 0
    doc.on('update', () => updates++)
    setDocTitle(doc, '新标题')
    expect(updates).toBe(0)
    setDocTitle(doc, '')
    expect(extractTitle(doc)).toBe('')
    // 空的标题片段：补一个段落
    const empty = new Y.Doc()
    setDocTitle(empty, '从无到有')
    expect(extractTitle(empty)).toBe('从无到有')
    expect(empty.getXmlFragment('title').length).toBe(1)
  })
})

describe('手动顺序', () => {
  test('写邻居中点：窗口反映新顺序，集合连接收到增量（prev 为空），不广播 changed', async () => {
    const t = await team()
    const c = await newCollection(t)
    const r1 = (await postRow(t.owner.cookie, c.id, { title: '1' })).body
    const r2 = (await postRow(t.owner.cookie, c.id, { title: '2' })).body
    const r3 = (await postRow(t.owner.cookie, c.id, { title: '3' })).body
    expect([r1.position, r2.position, r3.position]).toEqual([0, 1, 2])
    expect(await windowIds(t.owner.cookie, c.id)).toEqual([r1.id, r2.id, r3.id])
    const deltas = await watchCollection(c.id, t.viewer.cookie)
    const control = await watchControl(t.viewer.cookie)
    const res = await patchRow(t.member.cookie, c.id, r3.id, { after: r1.id, before: r2.id })
    expect(res.status).toBe(200)
    expect(res.body.position).toBe(0.5)
    expect(await windowIds(t.owner.cookie, c.id)).toEqual([r1.id, r3.id, r2.id])
    // 只有这一行的 position 变了（不整列重写）
    expect((await pageRow(r1.id))?.position).toBe(0)
    expect((await pageRow(r2.id))?.position).toBe(1)
    await eventually(() => {
      const last = updatesOf(deltas, r3.id).at(-1)
      expect(last?.row.position).toBe(0.5)
      expect(last?.prev).toEqual({})
    })
    // 拖到最前（只有后邻居）/ 最后（只有前邻居）
    expect((await patchRow(t.member.cookie, c.id, r2.id, { before: r1.id })).status).toBe(200)
    expect(await windowIds(t.owner.cookie, c.id)).toEqual([r2.id, r1.id, r3.id])
    expect((await patchRow(t.member.cookie, c.id, r2.id, { after: r3.id })).status).toBe(200)
    expect(await windowIds(t.owner.cookie, c.id)).toEqual([r1.id, r3.id, r2.id])
    await delay(QUIET_MS)
    expect(control).not.toContain('changed')
    expect(control.some((p) => p.includes('collection.rows'))).toBe(false)
  })

  test('中点精度用尽 / 邻居没排过：同一事务里给这个集合的行重编号，其余行顺序不变', async () => {
    const t = await team()
    const c = await newCollection(t)
    const ids: string[] = []
    for (const n of ['a', 'b', 'c', 'd', 'e']) ids.push((await postRow(t.owner.cookie, c.id, { title: n })).body.id)
    const [a, b, cc, d, e] = ids as [string, string, string, string, string]
    // a 与 b 相邻且之间夹不进任何双精度；d、e 没排过（拖进来的行常见）
    await pool.query('UPDATE pages SET position = $1 WHERE id = $2', [1, a])
    await pool.query('UPDATE pages SET position = $1 WHERE id = $2', [1 + Number.EPSILON, b])
    await pool.query('UPDATE pages SET position = $1 WHERE id = $2', [7, cc])
    await pool.query('UPDATE pages SET position = NULL WHERE id = ANY($1::text[])', [[d, e]])
    // 没排过的行按创建时间排：定死两个时间，顺序不靠两次请求的毫秒差
    await pool.query(`UPDATE pages SET created_at = '2026-01-01 00:00:01+00' WHERE id = $1`, [d])
    await pool.query(`UPDATE pages SET created_at = '2026-01-01 00:00:02+00' WHERE id = $1`, [e])
    expect(await windowIds(t.owner.cookie, c.id)).toEqual([a, b, cc, d, e])

    const res = await patchRow(t.owner.cookie, c.id, cc, { after: a, before: b })
    expect(res.status).toBe(200)
    expect(await windowIds(t.owner.cookie, c.id)).toEqual([a, cc, b, d, e])
    const positions = async () =>
      Object.fromEntries((await pool.query<{ id: string; position: number }>('SELECT id, position FROM pages WHERE id = ANY($1::text[])', [ids])).rows.map((r) => [r.id, r.position]))
    expect(await positions()).toEqual({ [a]: 0, [b]: 1, [d]: 2, [e]: 3, [cc]: 0.5 })

    // 邻居没排过：先重编号再取中点
    await pool.query('UPDATE pages SET position = NULL WHERE id = ANY($1::text[])', [[d, e]])
    expect((await patchRow(t.owner.cookie, c.id, a, { after: d, before: e })).status).toBe(200)
    expect(await windowIds(t.owner.cookie, c.id)).toEqual([cc, b, d, a, e])
  })

  test('重编号（邻居没排过）时集合连接只收到 reset、不收逐行改动；建行定位置重编号同样；不重编号的拖动照常逐行', async () => {
    const t = await team()
    const c = await newCollection(t)
    const ids: string[] = []
    for (const n of ['a', 'b', 'c']) ids.push((await postRow(t.owner.cookie, c.id, { title: n })).body.id)
    const [a, b, cc] = ids as [string, string, string]
    await pool.query('UPDATE pages SET position = NULL WHERE id = ANY($1::text[])', [[a, b]])
    await pool.query(`UPDATE pages SET created_at = '2026-01-01 00:00:01+00' WHERE id = $1`, [a])
    await pool.query(`UPDATE pages SET created_at = '2026-01-01 00:00:02+00' WHERE id = $1`, [b])
    const deltas = await watchCollection(c.id, t.viewer.cookie)
    const resets = () => deltas.filter((d) => d.reset === true)

    expect((await patchRow(t.member.cookie, c.id, cc, { after: a, before: b })).status).toBe(200)
    expect(await windowIds(t.owner.cookie, c.id)).toEqual([a, cc, b])
    await eventually(() => expect(resets()).toHaveLength(1))
    // 带 reset 的批次不带逐行改动；也没有别的批次（拖动的那一行同样没有逐行下发）
    await delay(QUIET_MS)
    expect(deltas).toEqual([{ t: 'collection.rows', up: [], rm: [], reset: true }])

    // 建行时邻居没排过：同样重编号、同样只发 reset
    await pool.query('UPDATE pages SET position = NULL WHERE id = $1', [a])
    const d = await postRow(t.member.cookie, c.id, { title: 'd', after: a, before: cc })
    expect(d.status).toBe(201)
    await eventually(() => expect(resets()).toHaveLength(2))
    // 重编号后的顺序：cc 0、b 1、a 2，邻居次序已过时（a 在 cc 后），放在 a 之后
    expect(await windowIds(t.owner.cookie, c.id)).toEqual([cc, b, a, d.body.id])

    // 不重编号的拖动（a 与 d 相邻且都排过）：照常逐行下发（prev 为空），没有新的 reset
    expect((await patchRow(t.member.cookie, c.id, b, { after: a, before: d.body.id })).status).toBe(200)
    expect(await windowIds(t.owner.cookie, c.id)).toEqual([cc, a, b, d.body.id])
    await eventually(() => expect(updatesOf(deltas, b).at(-1)?.prev).toEqual({}))
    await delay(QUIET_MS)
    expect(resets()).toHaveLength(2)
  })

  test('只给一侧邻居（客户端窗口没取完）：另一侧按全局手动顺序找实际相邻的行，不撞上 / 越过没加载的行', async () => {
    const t = await team()
    const c = await newCollection(t)
    const ids: string[] = []
    for (const n of ['a', 'b', 'c']) ids.push((await postRow(t.owner.cookie, c.id, { title: n })).body.id)
    const [a, b, cc] = ids as [string, string, string]
    const fresh = async () => {
      for (const [i, id] of ids.entries()) await pool.query('UPDATE pages SET position = $1 WHERE id = $2', [i, id])
      expect(await windowIds(t.owner.cookie, c.id)).toEqual([a, b, cc])
    }
    // 只发 after = a 挪 c：落在 a 与 b 之间（取 a + 1 会和 b 撞位置）
    await fresh()
    expect((await patchRow(t.member.cookie, c.id, cc, { after: a })).status).toBe(200)
    expect(await windowIds(t.owner.cookie, c.id)).toEqual([a, cc, b])
    // 只发 before = c 挪 a：落在 b 与 c 之间
    await fresh()
    expect((await patchRow(t.member.cookie, c.id, a, { before: cc })).status).toBe(200)
    expect(await windowIds(t.owner.cookie, c.id)).toEqual([b, a, cc])
    // 建行带单侧 after 同一逻辑；真在末尾 / 开头才是 ±1
    await fresh()
    const mid = await postRow(t.member.cookie, c.id, { title: 'mid', after: a })
    expect(mid.body.position).toBe(0.5)
    const head = await postRow(t.member.cookie, c.id, { title: 'head', before: a })
    expect(head.body.position).toBe(-1)
    const tail = await postRow(t.member.cookie, c.id, { title: 'tail', after: cc })
    expect(tail.body.position).toBe(3)
    expect(await windowIds(t.owner.cookie, c.id)).toEqual([head.body.id, a, mid.body.id, b, cc, tail.body.id])
  })

  test('邻居不合法 400：不是这个集合的行、是自己、两侧同一行、不是字符串', async () => {
    const t = await team()
    const c = await newCollection(t)
    const r1 = (await postRow(t.owner.cookie, c.id, { title: '1' })).body
    const r2 = (await postRow(t.owner.cookie, c.id, { title: '2' })).body
    const page = await postPage(t.owner.cookie, { space_id: t.spaceId })
    for (const body of [{ after: page }, { after: r1.id }, { after: r2.id, before: r2.id }, { before: 3 }]) {
      expect((await patchRow(t.owner.cookie, c.id, r1.id, body)).status).toBe(400)
    }
    expect(await windowIds(t.owner.cookie, c.id)).toEqual([r1.id, r2.id])
  })
})

describe('回收与删除', () => {
  test('删行即进回收站：广播 changed，查询里没有它；别的集合的行、不存在的 id 不受影响', async () => {
    const t = await team()
    const c = await newCollection(t)
    const other = await newCollection(t, { title: '另一个' })
    const r1 = (await postRow(t.owner.cookie, c.id, { title: '1' })).body
    const r2 = (await postRow(t.owner.cookie, c.id, { title: '2' })).body
    const stranger = (await postRow(t.owner.cookie, other.id, { title: 's' })).body
    const control = await watchControl(t.viewer.cookie)
    expect((await trashRows(t.viewer.cookie, c.id, [r1.id])).status).toBe(403)
    expect((await trashRows(t.outsider.cookie, c.id, [r1.id])).status).toBe(404)
    for (const bad of [[], 'x', [1]]) expect((await trashRows(t.owner.cookie, c.id, bad)).status).toBe(400)
    const res = await trashRows(t.member.cookie, c.id, [r1.id, stranger.id, crypto.randomUUID()])
    expect(res.status).toBe(200)
    expect(res.body.trashed).toEqual([r1.id])
    expect((await pageRow(r1.id))?.deleted_at).not.toBeNull()
    expect((await pageRow(stranger.id))?.deleted_at).toBeNull()
    expect(await windowIds(t.owner.cookie, c.id)).toEqual([r2.id])
    await eventually(() => expect(control).toContain('changed'))
  })

  test('集合进回收站：行跟着不可见；恢复后行和值回来；物理删除后 collection_rows 与 collections 不残留', async () => {
    const t = await team()
    const c = await newCollection(t)
    const r1 = (await postRow(t.owner.cookie, c.id, { title: '1', set: { [c.status.id]: c.done } })).body
    const r2 = (await postRow(t.owner.cookie, c.id, { title: '2' })).body
    expect((await call('POST', `/api/pages/${c.id}/trash`, t.owner.cookie, {})).status).toBe(200)
    expect((await getRows(t.owner.cookie, c.id)).status).toBe(404)
    expect((await postRow(t.owner.cookie, c.id, { title: 'x' })).status).toBe(404)
    expect((await pageRow(r1.id))?.deleted_at).not.toBeNull()

    expect((await call('POST', `/api/pages/${c.id}/restore`, t.owner.cookie, {})).status).toBe(200)
    const back = await getRows(t.owner.cookie, c.id)
    expect(back.body.rows.map((r) => [r.id, r.props])).toEqual([
      [r1.id, { [c.status.id]: c.done }],
      [r2.id, {}],
    ])

    expect((await call('POST', `/api/pages/${c.id}/trash`, t.owner.cookie, {})).status).toBe(200)
    expect((await call('DELETE', `/api/pages/${c.id}`, t.owner.cookie)).status).toBe(200)
    const left = await pool.query('SELECT page_id FROM collection_rows WHERE page_id = ANY($1::text[])', [[r1.id, r2.id]])
    expect(left.rows).toHaveLength(0)
    expect((await pool.query('SELECT 1 FROM collections WHERE page_id = $1', [c.id])).rows).toHaveLength(0)
    expect((await pool.query('SELECT 1 FROM pages WHERE id = ANY($1::text[])', [[c.id, r1.id, r2.id]])).rows).toHaveLength(0)
  })
})

describe('挪进挪出', () => {
  test('用 PATCH /api/pages 把普通页挪到集合下：查询里出现、属性全空；挪出后没有', async () => {
    const t = await team()
    const c = await newCollection(t)
    const row = (await postRow(t.owner.cookie, c.id, { title: '原有' })).body
    const page = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '拖进来的' })
    expect((await call('PATCH', `/api/pages/${page}`, t.member.cookie, { parent_id: c.id })).status).toBe(200)
    const inside = await getRows(t.member.cookie, c.id)
    expect(inside.body.total).toBe(2)
    const moved = inside.body.rows.find((r) => r.id === page)
    expect(moved?.title).toBe('拖进来的')
    expect(moved?.props).toEqual({})
    // 已有值的行挪出去再挪回来：值还在（值在行文档里，副本跟着行走）
    await patchRow(t.owner.cookie, c.id, row.id, { set: { [c.status.id]: c.todo } })
    expect((await call('PATCH', `/api/pages/${row.id}`, t.member.cookie, { parent_id: null })).status).toBe(200)
    expect(await windowIds(t.member.cookie, c.id)).toEqual([page])
    expect((await call('PATCH', `/api/pages/${page}`, t.member.cookie, { parent_id: null })).status).toBe(200)
    expect((await getRows(t.member.cookie, c.id)).body.total).toBe(0)
    expect((await call('PATCH', `/api/pages/${row.id}`, t.member.cookie, { parent_id: c.id })).status).toBe(200)
    const again = await getRows(t.member.cookie, c.id)
    expect(again.body.rows.map((r) => r.props)).toEqual([{ [c.status.id]: c.todo }])
  })
})
