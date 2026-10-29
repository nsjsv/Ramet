import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { readValue, type Condition } from '@ramet/shared/collection-model'
import { serializeDoc } from './agents/doc.js'
import { collectSubtreeIds } from './clone.js'
import { textOf } from './updates.js'
import {
  addProp,
  addView,
  call,
  editCollection,
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
  windowIds,
  type Fixture,
  type Team,
} from './collections/test-kit.js'

// 集合与现有功能的边界：窗口查询（筛选 / 排序 / 分组 / 翻页 / 上限）、改类型后的解读、公开页拦截、
// 复制不带集合、agent 读到一行引用、页面列表不带属性值、搜索按标题能搜到

// 固定用户 id：id 的先后与用户名相反（owner = zed、member = amy），这样人员排序按名字比才排得对
const OWNER_ID = '00000000-0000-4000-8000-000000000001'
const MEMBER_ID = 'ffffffff-ffff-4fff-bfff-ffffffffffff'

type Matrix = { t: Team; c: Fixture; r1: string; r2: string; r3: string; r4: string }

/** 每种属性类型各一个属性 + 四行数据（r3 什么都没填）。属性 id 固定，好写条件 */
async function matrix(): Promise<Matrix> {
  const t = await team({ owner: OWNER_ID, member: MEMBER_ID })
  const c = await newCollection(t)
  await editCollection(c.id, (root) => {
    addProp(root, 'ptext', { name: '文本', type: 'text', pos: 1 })
    addProp(root, 'pnum', { name: '数字', type: 'number', pos: 2 })
    addProp(root, 'psel', {
      name: '单选',
      type: 'select',
      pos: 3,
      options: { oa: { name: 'A', color: 'red', pos: 0 }, ob: { name: 'B', color: 'blue', pos: 1 } },
    })
    addProp(root, 'pmulti', {
      name: '多选',
      type: 'multi_select',
      pos: 4,
      options: { ma: { name: 'M', color: 'gray', pos: 0 }, mb: { name: 'N', color: 'green', pos: 1 } },
    })
    addProp(root, 'pdate', { name: '日期', type: 'date', pos: 5 })
    addProp(root, 'pcheck', { name: '勾选', type: 'checkbox', pos: 6 })
    addProp(root, 'purl', { name: '链接', type: 'url', pos: 7 })
    addProp(root, 'ppers', { name: '负责人', type: 'person', pos: 8 })
    addProp(root, 'pmade', { name: '创建时间', type: 'created_time', pos: 9 })
    addProp(root, 'pedit', { name: '编辑时间', type: 'edited_time', pos: 10 })
  })
  const add = async (title: string, set: Record<string, unknown>): Promise<string> => {
    const res = await postRow(t.owner.cookie, c.id, { title, set })
    expect(res.status).toBe(201)
    return res.body.id
  }
  const r1 = await add('甲', {
    ptext: 'Hello World',
    pnum: 5,
    psel: 'oa',
    pmulti: ['ma', 'mb'],
    pdate: '2026-01-02',
    pcheck: true,
    purl: 'https://a.example',
    ppers: [OWNER_ID],
    [c.status.id]: c.todo,
  })
  const r2 = await add('乙', { ptext: 'other', pnum: 10, psel: 'ob', pmulti: ['mb'], pdate: '2026-03-04', ppers: [MEMBER_ID], [c.status.id]: c.doing })
  const r3 = await add('丙', {})
  const r4 = await add('丁', { psel: 'oa', pnum: 7 })
  return { t, c, r1, r2, r3, r4 }
}

describe('窗口查询', () => {
  test('每种类型的筛选都在服务端生效；创建时间按请求带来的时区折算', async () => {
    const m = await matrix()
    const { t, c, r1, r2, r3, r4 } = m
    // r1 的创建时间定在 UTC 2001-05-01 20:00：东八区已是 5 月 2 日
    await pool.query(`UPDATE pages SET created_at = '2001-05-01 20:00:00+00' WHERE id = $1`, [r1])
    const cases: [string, Condition, string[], Record<string, string>?][] = [
      ['vname', { prop: 'title', op: 'contains', value: '甲' }, [r1]],
      ['vtext', { prop: 'ptext', op: 'contains', value: 'hello' }, [r1]],
      ['vurl', { prop: 'purl', op: 'empty' }, [r2, r3, r4]],
      ['vnum', { prop: 'pnum', op: 'gt', value: 6 }, [r2, r4]],
      ['vsel', { prop: 'psel', op: 'is', value: 'oa' }, [r1, r4]],
      ['vstat', { prop: c.status.id, op: 'in_group', value: 'doing' }, [r2]],
      ['vmulti', { prop: 'pmulti', op: 'contains', value: 'mb' }, [r1, r2]],
      ['vpers', { prop: 'ppers', op: 'contains', value: MEMBER_ID }, [r2]],
      ['vdate', { prop: 'pdate', op: 'before', value: '2026-02-01' }, [r1]],
      ['vcheck', { prop: 'pcheck', op: 'checked' }, [r1]],
      // 编辑时间 = 创建时间、正文、属性三者最晚：r1 建了以后没改过，跟着创建时间回到 2001 年
      ['vedit', { prop: 'pedit', op: 'after', value: '2002-01-01' }, [r2, r3, r4]],
      ['vmade', { prop: 'pmade', op: 'eq', value: '2001-05-02' }, [r1], { tz: '480' }],
      ['vmade', { prop: 'pmade', op: 'eq', value: '2001-05-02' }, [], { tz: '0' }],
    ]
    await editCollection(c.id, (root) => {
      for (const [view, cond] of cases) addView(root, view, { filter: { all: [cond] } })
    })
    for (const [view, , expected, query] of cases) {
      expect(await windowIds(t.member.cookie, c.id, { view, ...query }), view).toEqual(expected)
    }
  })

  test('多级排序、人员按用户名排序、手动顺序、分组计数、按组取窗口、cursor 翻页', async () => {
    const { t, c, r1, r2, r3, r4 } = await matrix()
    await editCollection(c.id, (root) => {
      addView(root, 'vsort', { sorts: [{ prop: 'psel', dir: 'asc' }, { prop: 'pnum', dir: 'desc' }] })
      addView(root, 'vpeople', { sorts: [{ prop: 'ppers', dir: 'asc' }] })
      addView(root, 'vgroup', { groupBy: c.status.id })
    })
    // 选项按定义顺序比（A 在 B 前），同为 A 时数字降序；空值排最后
    expect(await windowIds(t.member.cookie, c.id, { view: 'vsort' })).toEqual([r4, r1, r2, r3])
    // 人员按用户名：amy（member）在 zed（owner）前 —— 按 id 比恰好相反
    expect(await windowIds(t.member.cookie, c.id, { view: 'vpeople' })).toEqual([r2, r1, r3, r4])
    // 没有排序 = 手动顺序；拖动后跟着变
    expect(await windowIds(t.member.cookie, c.id)).toEqual([r1, r2, r3, r4])
    expect((await patchRow(t.member.cookie, c.id, r4, { after: r1, before: r2 })).status).toBe(200)
    expect(await windowIds(t.member.cookie, c.id)).toEqual([r1, r4, r2, r3])

    // 分组：状态的空值读成缺省选项（未开始），没有「无值」组；各组计数（每个组都有键）；按组取只给这一组
    const grouped = await call<{ rows: { id: string }[]; total: number; groups: Record<string, number> }>(
      'GET',
      `/api/collections/${c.id}/rows?view=vgroup`,
      t.viewer.cookie,
    )
    expect(grouped.body.groups).toEqual({ [c.todo]: 3, [c.doing]: 1, [c.done]: 0 })
    expect(grouped.body.rows.map((r) => r.id)).toEqual([r1, r4, r3, r2])
    const doing = await getRows(t.viewer.cookie, c.id, { view: 'vgroup', group: c.doing })
    expect(doing.body).toMatchObject({ total: 1, group: c.doing, next: null })
    expect(doing.body.rows.map((r) => r.id)).toEqual([r2])
    expect(doing.body.groups).toEqual(grouped.body.groups)
    expect(await windowIds(t.viewer.cookie, c.id, { view: 'vgroup', group: '' })).toEqual([])

    // 翻页：游标接着上一页的末行
    const page1 = await getRows(t.viewer.cookie, c.id, { limit: '2' })
    expect(page1.body.rows.map((r) => r.id)).toEqual([r1, r4])
    expect(page1.body.total).toBe(4)
    expect(page1.body.next).not.toBeNull()
    const page2 = await getRows(t.viewer.cookie, c.id, { limit: '2', cursor: page1.body.next! })
    expect(page2.body.rows.map((r) => r.id)).toEqual([r2, r3])
    expect(page2.body.next).toBeNull()
    // 视图 id 不存在：用第一个视图
    expect(await windowIds(t.viewer.cookie, c.id, { view: 'nosuch' })).toEqual([r1, r4, r2, r3])
  })

  test('5,000 行：首屏只下发一个窗口（缺省 50、上限 100），筛选 / 排序 / 翻页都按窗口取', async () => {
    const t = await team()
    const c = await newCollection(t)
    await pool.query(
      `INSERT INTO pages (id, parent_id, owner_id, space_id, kind, title, position)
       SELECT gen_random_uuid()::text, $1, $2, $3, 'doc', 'row ' || g, g FROM generate_series(1, 5000) g`,
      [c.id, t.owner.id, t.spaceId],
    )
    const first = await getRows(t.member.cookie, c.id)
    expect(first.status).toBe(200)
    expect(first.body.rows).toHaveLength(50)
    expect(first.body.total).toBe(5000)
    expect(first.body.rows[0]?.title).toBe('row 1')
    expect((await getRows(t.member.cookie, c.id, { limit: 'abc' })).body.rows).toHaveLength(50)
    const big = await getRows(t.member.cookie, c.id, { limit: '1000' })
    expect(big.body.rows).toHaveLength(100)
    const next = await getRows(t.member.cookie, c.id, { limit: '1000', cursor: big.body.next! })
    expect(next.body.rows).toHaveLength(100)
    expect(next.body.rows[0]?.title).toBe('row 101')

    await editCollection(c.id, (root) => {
      addView(root, 'vfilter', { filter: { all: [{ prop: 'title', op: 'contains', value: 'row 1' }] } })
      addView(root, 'vdesc', { sorts: [{ prop: 'title', dir: 'desc' }] })
    })
    // 'row 1'、'row 10'–'row 19'、'row 100'–'row 199'、'row 1000'–'row 1999'
    const filtered = await getRows(t.member.cookie, c.id, { view: 'vfilter', limit: '100' })
    expect(filtered.body.total).toBe(1111)
    expect(filtered.body.rows).toHaveLength(100)
    const sorted = await getRows(t.member.cookie, c.id, { view: 'vdesc' })
    expect(sorted.body.rows).toHaveLength(50)
    expect(sorted.body.rows[0]?.title).toBe('row 5000')
  })
})

describe('改属性类型', () => {
  test('不兼容的值读成空（readValue 为 undefined），原值仍在文档和副本里；改回原类型就回来', async () => {
    const t = await team()
    const c = await newCollection(t)
    const row = (await postRow(t.owner.cookie, c.id, { title: 'r', set: { [c.status.id]: c.todo } })).body
    await editCollection(c.id, (root) => {
      addView(root, 'vempty', { filter: { all: [{ prop: c.status.id, op: 'empty' }] } })
    })
    expect(await windowIds(t.owner.cookie, c.id, { view: 'vempty' })).toEqual([])

    const setType = (type: string) =>
      editCollection(c.id, (root) => {
        const prop = (root.get('props') as Y.Map<unknown>).get(c.status.id) as Y.Map<unknown>
        prop.set('type', type)
      })
    await setType('number')
    const asNumber = (await schemaOf(c.id)).props.find((p) => p.id === c.status.id)!
    expect(asNumber.type).toBe('number')
    expect(readValue(asNumber, (await replicaOf(row.id))?.[c.status.id])).toBeUndefined()
    // 服务端的筛选按同一口径：读不出来的值算空
    expect(await windowIds(t.owner.cookie, c.id, { view: 'vempty' })).toEqual([row.id])
    // 原值一个字没动
    expect(await replicaOf(row.id)).toEqual({ [c.status.id]: c.todo })
    expect((await rowDoc(row.id)).getMap('props').toJSON()).toEqual({ [c.status.id]: c.todo })

    await setType('status')
    const back = (await schemaOf(c.id)).props.find((p) => p.id === c.status.id)!
    expect(readValue(back, (await replicaOf(row.id))?.[c.status.id])).toBe(c.todo)
    expect(await windowIds(t.owner.cookie, c.id, { view: 'vempty' })).toEqual([])
  })
})

describe('公开、复制、agent、页面列表、搜索', () => {
  test('已公开祖先下的集合页和行：公开端点一律不存在；公开树里没有集合（勾了「连过程一起公开」也一样）', async () => {
    const t = await team()
    const host = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '公开的文档' })
    const coll = await postCollection(t.owner.cookie, { space_id: t.spaceId, parent_id: host, inline: true, title: '内嵌集合' })
    expect(coll.status).toBe(201)
    const row = (await postRow(t.owner.cookie, coll.body.id, { title: '行' })).body
    const sub = await postPage(t.owner.cookie, { space_id: t.spaceId, parent_id: host, title: '普通子页' })
    const run = crypto.randomUUID()
    await pool.query(`INSERT INTO pages (id, parent_id, owner_id, space_id, kind, title) VALUES ($1, $2, $3, $4, 'run', '过程')`, [
      run,
      host,
      t.owner.id,
      t.spaceId,
    ])
    const published = await call('PATCH', `/api/pages/${host}/publish`, t.owner.cookie, { published: true, includeRuns: true })
    expect(published.status).toBe(200)

    const tree = await call<{ kind: string; children: { id: string; kind: string }[] }>('GET', `/api/public/pages/${host}`, null)
    expect(tree.status).toBe(200)
    expect(tree.body.children.map((n) => n.id).sort()).toEqual([sub, run].sort())
    // 每个节点带 kind：前端只给 doc 页摆「克隆到我的空间」（复制只带 doc 页，过程页克隆必然 404）
    expect(tree.body.kind).toBe('doc')
    expect(Object.fromEntries(tree.body.children.map((n) => [n.id, n.kind]))).toEqual({ [sub]: 'doc', [run]: 'run' })
    const runTree = await call<{ kind: string }>('GET', `/api/public/pages/${run}`, null)
    expect(runTree.body.kind).toBe('run')
    expect((await call('POST', `/api/public/pages/${run}/clone`, t.outsider.cookie, {})).status).toBe(404)
    for (const id of [coll.body.id, row.id]) {
      expect((await call('GET', `/api/public/pages/${id}`, null)).status).toBe(404)
      expect((await call('GET', `/api/public/pages/${id}/doc`, null)).status).toBe(404)
      expect((await call('POST', `/api/public/pages/${id}/clone`, t.outsider.cookie, {})).status).toBe(404)
    }
    // 行本身是 doc 页、能单独打开公开开关：谓词看的是整条祖先链（含自身），照样不公开
    expect((await call('PATCH', `/api/pages/${row.id}/publish`, t.owner.cookie, { published: true })).status).toBe(200)
    expect((await call('GET', `/api/public/pages/${row.id}`, null)).status).toBe(404)
    expect((await call('GET', `/api/public/pages/${row.id}/doc`, null)).status).toBe(404)
    // 别的公开页照常
    expect((await call('GET', `/api/public/pages/${sub}/doc`, null)).status).toBe(200)
    expect((await call('GET', `/api/public/pages/${run}`, null)).status).toBe(200)
  })

  test('复制不带集合页和行：从模板新建、克隆公开页；源集合不受影响', async () => {
    const t = await team()
    const host = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '模板页' })
    const child = await postPage(t.owner.cookie, { space_id: t.spaceId, parent_id: host, title: '子页' })
    const inner = await postCollection(t.owner.cookie, { space_id: t.spaceId, parent_id: host, inline: true, title: '内嵌集合' })
    const innerRow = (await postRow(t.owner.cookie, inner.body.id, { title: '内嵌行' })).body
    const top = await newCollection(t, { title: '顶层集合' })
    await postRow(t.owner.cookie, top.id, { title: '顶层行' })
    expect((await call('PATCH', `/api/pages/${host}/publish`, t.owner.cookie, { published: true })).status).toBe(200)
    const before = (await pool.query('SELECT count(*)::int AS n FROM pages')).rows[0].n as number

    const titlesIn = async (spaceId: string, exclude: string[] = []) =>
      (await pool.query<{ title: string; kind: string }>('SELECT title, kind FROM pages WHERE space_id = $1 AND NOT (id = ANY($2::text[]))', [spaceId, exclude])).rows
        .map((r) => `${r.kind}:${r.title}`)
        .sort()
    const original = (await pool.query<{ id: string }>('SELECT id FROM pages WHERE space_id = $1', [t.spaceId])).rows.map((r) => r.id)

    // 从模板新建（同空间）
    const inst = await call<{ id: string }>('POST', `/api/pages/${host}/instantiate`, t.member.cookie, { space_id: t.spaceId })
    expect(inst.status).toBe(201)
    expect(await titlesIn(t.spaceId, original)).toEqual(['doc:子页', 'doc:模板页'])

    // 克隆公开页（落进克隆者的个人空间）
    const cloned = await call<{ id: string }>('POST', `/api/public/pages/${host}/clone`, t.outsider.cookie, {})
    expect(cloned.status).toBe(201)
    const personal = (await pool.query<{ space_id: string }>('SELECT space_id FROM pages WHERE id = $1', [cloned.body.id])).rows[0]!.space_id
    expect(await titlesIn(personal)).toEqual(['doc:子页', 'doc:模板页'])

    // 源集合原样
    expect(await windowIds(t.owner.cookie, inner.body.id)).toEqual([innerRow.id])
    expect((await pool.query('SELECT 1 FROM pages WHERE id = $1 AND deleted_at IS NULL', [child])).rows).toHaveLength(1)
    expect((await pool.query("SELECT count(*)::int AS n FROM pages WHERE kind = 'collection'")).rows[0].n).toBe(2)
    expect(((await pool.query('SELECT count(*)::int AS n FROM pages')).rows[0].n as number) - before).toBe(2 + 2)
  })

  test('模板根是集合页：从模板新建 404，不产生新页；收集要复制的子树时不进集合', async () => {
    const t = await team()
    const c = await newCollection(t, { title: '想当模板的集合' })
    const row = (await postRow(t.owner.cookie, c.id, { title: '行' })).body
    expect((await call('PATCH', `/api/pages/${c.id}`, t.owner.cookie, { is_template: true })).status).toBe(200)
    const count = async () => (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM pages')).rows[0]!.n
    const before = await count()
    expect((await call('POST', `/api/pages/${c.id}/instantiate`, t.member.cookie, { space_id: t.spaceId })).status).toBe(404)
    expect(await count()).toBe(before)
    // 根与子页同一条规则：集合根一个都不收（不去解析它下面每一行的文档）；doc 根照收，但不进它下面的集合
    expect(await collectSubtreeIds(pool, [c.id])).toEqual([])
    const host = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '宿主' })
    const inner = await postCollection(t.owner.cookie, { space_id: t.spaceId, parent_id: host, inline: true })
    await postRow(t.owner.cookie, inner.body.id, { title: '内嵌行' })
    expect(await collectSubtreeIds(pool, [host])).toEqual([host])
    // 源集合原样
    expect(await windowIds(t.owner.cookie, c.id)).toEqual([row.id])
  })

  test('「集合」块与「链接视图」块：textOf 与 agent 序列化都读出一行引用（名称 + 集合 id），不带数据', () => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment('prosemirror')
    const block = (name: string, attrs: Record<string, string>) => {
      const el = new Y.XmlElement(name)
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value)
      return el
    }
    const para = new Y.XmlElement('paragraph')
    const text = new Y.XmlText()
    para.insert(0, [text])
    text.insert(0, '前面一段')
    const cid = '11111111-2222-4333-8444-555555555555'
    const inline = block('collection_inline', { id: 'b1', collectionId: cid, viewId: 'v1', title: '任务' })
    const link = block('collection_link', { id: 'b2', collectionId: cid, viewId: 'v2', title: '任务' })
    const untitled = block('collection_link', { id: 'b3', collectionId: cid, viewId: 'v1' })
    fragment.insert(0, [para, inline, link, untitled])
    expect(textOf(inline)).toBe(`集合「任务」 collection:${cid}`)
    expect(textOf(link)).toBe(`集合「任务」 collection:${cid}`)
    expect(textOf(untitled)).toBe(`集合「」 collection:${cid}`)
    expect(serializeDoc(fragment)).toBe(`前面一段\n\n集合「任务」 collection:${cid}\n\n集合「任务」 collection:${cid}\n\n集合「」 collection:${cid}`)
    // 整篇文字（搜索索引 / read_page 的行）：每个集合块各占一行，相邻的两个不粘在一起
    expect(textOf(fragment)).toBe(`前面一段\n集合「任务」 collection:${cid}\n集合「任务」 collection:${cid}\n集合「」 collection:${cid}`)
  })

  test('/api/pages 不带属性值；搜索按标题搜得到集合与行、按正文搜得到行', async () => {
    const t = await team()
    const c = await newCollection(t, { title: '季度目标清单' })
    await editCollection(c.id, (root) => addProp(root, 'pnote', { name: '备注', type: 'text', pos: 1 }))
    const row = (await postRow(t.owner.cookie, c.id, { title: '独一无二的行', set: { pnote: 'SECRET-VALUE-42' } })).body
    const list = await call<Record<string, unknown>[]>('GET', '/api/pages', t.member.cookie)
    expect(list.status).toBe(200)
    expect(list.body.map((p) => p.id)).toEqual(expect.arrayContaining([c.id, row.id]))
    expect(JSON.stringify(list.body)).not.toContain('SECRET-VALUE-42')
    for (const page of list.body) expect(page).not.toHaveProperty('props')

    const search = async (q: string) =>
      (await call<{ id: string }[]>('GET', `/api/search?q=${encodeURIComponent(q)}`, t.member.cookie)).body.map((h) => h.id)
    expect(await search('季度目标清单')).toEqual([c.id])
    expect(await search('独一无二')).toEqual([row.id])
    // 属性值暂不进搜索；新建的集合页与行正文索引是空串，不会被无关的词命中
    expect(await search('SECRET-VALUE-42')).toEqual([])
    expect(await search('完全无关的词')).toEqual([])
    expect((await pool.query<{ content_text: string | null }>('SELECT content_text FROM pages WHERE id = ANY($1::text[])', [[c.id, row.id]])).rows).toEqual([
      { content_text: '' },
      { content_text: '' },
    ])
    // 正文：行页面的正文照常进搜索索引
    await pool.query('UPDATE pages SET content_text = $1 WHERE id = $2', ['行里写的正文段落', row.id])
    expect(await search('正文段落')).toContain(row.id)
  })
})
