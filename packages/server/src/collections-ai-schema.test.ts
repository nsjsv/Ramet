import { describe, expect, test } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { AiCollection } from './collections/ai-read.js'
import { mintPageToken } from './page-read.js'
import { addProp, base, editCollection, newCollection, pool, postPage, postRow, rowDoc, schemaOf, team, type Team } from './collections/test-kit.js'

// agent 查询与改结构：read_collection 的 where / sort / query，create_collection 与 edit_collection（collections/ai-schema.ts）。
// 结构写下去之后用 parseCollection（schemaOf）读回来比，与界面读的是同一份。

const MCP = fileURLToPath(new URL('./mcp/ramet.mjs', import.meta.url))

async function bearer<T = Record<string, unknown>>(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json()) as T }
}

type Created = { id: string; title: string; parentId: string | null; changes: string[]; error?: string }
const createCollection = (token: string, body: unknown) => bearer<Created>('POST', '/api/ramet/collections', token, body)
const editSchema = (token: string, cid: string, ops: unknown) => bearer<{ changes?: string[]; error?: string }>('POST', `/api/ramet/collections/${cid}/schema`, token, { ops })
const read = (token: string, cid: string, q: Record<string, unknown> = {}) => {
  const params = new URLSearchParams(Object.entries(q).map(([k, v]): [string, string] => [k, typeof v === 'string' ? v : JSON.stringify(v)]))
  return bearer<AiCollection & { error?: string }>('GET', `/api/ramet/collections/${cid}?${params}`, token)
}

async function newRow(t: Team, cid: string, title: string, set: Record<string, unknown> = {}): Promise<string> {
  const res = await postRow(t.owner.cookie, cid, { title, set })
  expect(res.status).toBe(201)
  return res.body.id
}

describe('read_collection 的临时查询', () => {
  test('where 按名字和人话的值筛（叠在视图上）、sort 换排序、query 找关键词；写错了 400 并说明能用什么', async () => {
    const t = await team()
    const c = await newCollection(t)
    await editCollection(c.id, (root) => {
      addProp(root, 'pts001', { name: '点数', type: 'number', pos: 1 })
      addProp(root, 'own001', { name: '负责人', type: 'person', pos: 2 })
    })
    const done = c.status.options.find((o) => o.id === c.done)!.name
    const a = await newRow(t, c.id, '写周报', { [c.status.id]: c.done, pts001: 1 })
    const b = await newRow(t, c.id, '修 bug', { [c.status.id]: c.done, pts001: 5, own001: [t.member.id] })
    const d = await newRow(t, c.id, '画原型', { [c.status.id]: c.doing, pts001: 3 })
    const token = mintPageToken(t.member.id, 'fake')

    const byStatus = await read(token, c.id, { where: [{ prop: c.status.name, op: '=', value: done }], sort: [{ prop: '点数', dir: 'desc' }] })
    expect(byStatus.body.rows.map((r) => r.id)).toEqual([b, a])
    expect(byStatus.body.where).toEqual([`${c.status.name} 是 ${done}`])
    expect(byStatus.body.sort).toEqual(['点数 降序'])
    expect((await read(token, c.id, { where: [{ prop: '点数', op: '>=', value: '3' }] })).body.rows.map((r) => r.id)).toEqual([b, d])
    expect((await read(token, c.id, { where: [{ prop: '负责人', op: '包含', value: t.member.name }] })).body.rows.map((r) => r.id)).toEqual([b])
    expect((await read(token, c.id, { where: [{ prop: '负责人', op: '为空' }] })).body.total).toBe(2)
    expect((await read(token, c.id, { query: 'BUG' })).body.rows.map((r) => r.id)).toEqual([b])

    const bad = async (q: Record<string, unknown>, has: string) => {
      const res = await read(token, c.id, q)
      expect(res.status).toBe(400)
      expect(res.body.error).toContain(has)
    }
    await bad({ where: [{ prop: '优先级', op: '=', value: '高' }] }, '没有叫「优先级」的属性')
    await bad({ where: [{ prop: '点数', op: '包含', value: 1 }] }, '能用：eq（=）')
    await bad({ where: [{ prop: '点数', op: '>', value: '很多' }] }, '一个数字')
    await bad({ where: [{ prop: c.status.name, op: '=', value: '搁置' }] }, '没有选项「搁置」')
    await bad({ where: '状态=完成' }, 'where / sort 要是 JSON')
  })
})

describe('create_collection', () => {
  test('建在给的页下：ops 演练进初始结构（自定义的「状态」换掉自带的、看板 / 日历视图、公式、编号前缀）', async () => {
    const t = await team()
    const host = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '项目页' })
    const token = mintPageToken(t.member.id, 'fake')
    const res = await createCollection(token, {
      title: '需求',
      parentId: `page:${host}`,
      ops: [
        { op: 'add_prop', name: '状态', type: 'status', options: ['待评估', '开发中', '已上线'] },
        { op: 'add_prop', name: '优先级', type: '单选', options: ['高', '中', '低'] },
        { op: 'add_prop', name: '工时', type: 'number' },
        { op: 'add_prop', name: '双倍', type: 'formula', formula: '[工时] * 2' },
        { op: 'add_prop', name: '编号', type: 'unique_id', prefix: 'REQ' },
        { op: 'add_prop', name: '截止', type: 'date' },
        { op: 'add_view', name: '按状态', layout: 'board' },
        { op: 'add_view', name: '日程', layout: '日历' },
      ],
    })
    expect(res.status).toBe(200)
    expect(res.body.parentId).toBe(host)
    const page = (await pool.query('SELECT kind, parent_id, space_id, title FROM pages WHERE id = $1', [res.body.id])).rows[0]
    expect(page).toEqual({ kind: 'collection', parent_id: host, space_id: t.spaceId, title: '需求' })
    const schema = await schemaOf(res.body.id)
    expect(schema.props.map((p) => [p.name, p.type])).toEqual([
      ['状态', 'status'],
      ['优先级', 'select'],
      ['工时', 'number'],
      ['双倍', 'formula'],
      ['编号', 'unique_id'],
      ['截止', 'date'],
    ])
    const status = schema.props[0]!
    expect(status.options.map((o) => [o.name, o.group])).toEqual([
      ['待评估', 'todo'],
      ['开发中', 'doing'],
      ['已上线', 'done'],
    ])
    expect(schema.props[1]!.options.map((o) => o.name)).toEqual(['高', '中', '低'])
    expect(schema.props[3]!.output).toBe('number')
    expect(schema.props[4]!.cfg.prefix).toBe('REQ')
    expect(schema.views.map((v) => [v.name, v.layout])).toEqual([
      ['表格', 'table'],
      ['按状态', 'board'],
      ['日程', 'calendar'],
    ])
    expect(schema.views[1]!.groupBy).toBe(status.id)
    expect(schema.views[2]!.dateBy).toBe(schema.props[5]!.id)

    // 有一步不行就不建：库里没有多出合集
    const before = (await pool.query("SELECT count(*)::int AS n FROM pages WHERE kind = 'collection'")).rows[0].n
    const bad = await createCollection(token, { title: '坏的', parentId: host, ops: [{ op: 'add_prop', name: 'x', type: 'number' }, { op: 'add_prop', name: 'y', type: '按钮' }] })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toContain('第 2 步')
    expect((await pool.query("SELECT count(*)::int AS n FROM pages WHERE kind = 'collection'")).rows[0].n).toBe(before)
    // 只能建在普通页下
    expect((await createCollection(token, { title: '套娃', parentId: res.body.id })).status).toBe(400)
    expect((await createCollection(mintPageToken(t.viewer.id, 'fake'), { title: '只读', parentId: host })).status).toBe(403)
  })
})

describe('edit_collection', () => {
  test('改名 / 加选项 / 删属性 / 带筛选的视图 / 改合集名；整批先演练，有一步不行一个字都不改', async () => {
    const t = await team()
    const c = await newCollection(t)
    await editCollection(c.id, (root) => {
      addProp(root, 'pts001', { name: '点数', type: 'number', pos: 1 })
      addProp(root, 'tag001', { name: '标签', type: 'multi_select', pos: 2, options: { opt001: { name: '前端', color: 'blue', pos: 0 } } })
    })
    const token = mintPageToken(t.member.id, 'fake')
    const done = c.status.options.find((o) => o.id === c.done)!.name
    const res = await editSchema(token, c.id, [
      { op: 'rename_prop', prop: '点数', name: '工时' },
      { op: 'add_options', prop: '标签', options: ['前端', '后端', '设计'] },
      { op: 'add_view', name: '已完成的大活', layout: 'table', where: [{ prop: c.status.name, op: '=', value: done }, { prop: '工时', op: '>', value: 3 }], sort: [{ prop: '工时', dir: 'desc' }] },
      { op: 'delete_prop', prop: '标签' },
      { op: 'rename', title: '任务清单' },
    ])
    expect(res.status).toBe(200)
    expect(res.body.changes).toHaveLength(5)
    const schema = await schemaOf(c.id)
    expect(schema.props.map((p) => p.name)).toEqual([c.status.name, '工时'])
    const view = schema.views.find((v) => v.name === '已完成的大活')!
    expect(view.filter.all).toEqual([
      { prop: c.status.id, op: 'is', value: c.done },
      { prop: 'pts001', op: 'gt', value: 3 },
    ])
    expect(view.sorts).toEqual([{ prop: 'pts001', dir: 'desc' }])
    expect((await pool.query('SELECT title FROM pages WHERE id = $1', [c.id])).rows[0].title).toBe('任务清单')
    expect((await rowDoc(c.id)).getXmlFragment('title').toString()).toContain('任务清单')

    for (const [ops, has] of [
      [[{ op: 'rename_prop', prop: '工时', name: '状态' }], '已经有叫「状态」'],
      [[{ op: 'add_prop', name: '坏公式', type: 'formula', formula: '[不存在] + 1' }], '公式'],
      [[{ op: 'add_view', name: '板', layout: 'board', group_by: '工时' }], '只能按单选或状态分组'],
      [[{ op: 'add_prop', name: 'ok', type: 'text' }, { op: 'fly' }], '第 2 步：不认识的操作「fly」'],
      [[{ op: 'delete_prop', prop: '名称' }], '不能改名或删除'],
    ] as const) {
      const bad = await editSchema(token, c.id, ops)
      expect(bad.status).toBe(400)
      expect(bad.body.error).toContain(has)
    }
    expect((await schemaOf(c.id)).props.map((p) => p.name)).toEqual([c.status.name, '工时'])
  })

  test('双向关联（对方合集多一个反向关联）与沿它的汇总；删关联连另一端一起删', async () => {
    const t = await team()
    const projects = await newCollection(t, { title: '项目' })
    const tasks = await newCollection(t, { title: '任务' })
    const token = mintPageToken(t.member.id, 'fake')
    expect((await editSchema(token, tasks.id, [{ op: 'add_prop', name: '所属项目', type: 'relation', target: `collection:${projects.id}`, two_way: true, reverse_name: '任务' }])).status).toBe(200)
    expect((await editSchema(token, projects.id, [{ op: 'add_prop', name: '任务数', type: 'rollup', relation: '任务', of: '名称', fn: 'count' }])).status).toBe(200)
    const forward = (await schemaOf(tasks.id)).props.find((p) => p.name === '所属项目')!
    const reverse = (await schemaOf(projects.id)).props.find((p) => p.name === '任务')!
    expect(forward.cfg).toMatchObject({ target: projects.id, reverse: reverse.id })
    expect(reverse.cfg).toMatchObject({ target: tasks.id, mirror: forward.id })
    expect((await schemaOf(projects.id)).props.find((p) => p.name === '任务数')!.cfg).toMatchObject({ relation: reverse.id, prop: 'title', fn: 'count' })

    const p = await newRow(t, projects.id, '官网')
    await newRow(t, tasks.id, '画稿', { [forward.id]: [p] })
    expect(new Map((await read(token, projects.id)).body.rows[0]!.values).get('任务数')).toBe('1')

    expect((await editSchema(token, tasks.id, [{ op: 'delete_prop', prop: '所属项目' }])).status).toBe(200)
    expect((await schemaOf(projects.id)).props.some((x) => x.name === '任务')).toBe(false)
  })

  test('闸门：viewer 403；非成员 / 别的空间的空间 AI 404；只读空间 AI 与精简档 403', async () => {
    const t = await team()
    const c = await newCollection(t)
    const ops = [{ op: 'add_prop', name: '备注', type: 'text' }]
    expect((await editSchema(mintPageToken(t.viewer.id, 'fake'), c.id, ops)).status).toBe(403)
    expect((await editSchema(mintPageToken(t.outsider.id, 'fake'), c.id, ops)).status).toBe(404)
    expect((await editSchema(mintPageToken(t.member.id, 'space-ai', { space: 'other' }), c.id, ops)).status).toBe(404)
    expect((await editSchema(mintPageToken(t.member.id, 'space-ai', { space: t.spaceId, readOnly: true }), c.id, ops)).status).toBe(403)
    expect((await editSchema(mintPageToken(t.member.id, 'fake', { profile: 'minimal' }), c.id, ops)).status).toBe(403)
    expect((await editSchema(mintPageToken(t.member.id, 'space-ai', { space: t.spaceId }), c.id, ops)).status).toBe(200)
  })
})

describe('MCP 进程', () => {
  test('create_collection → edit_collection → 带 where 的 read_collection', async () => {
    const t = await team()
    const host = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '项目页' })
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [MCP], env: { RAMET_PAGE_URL: base, RAMET_PAGE_TOKEN: mintPageToken(t.member.id, 'fake') }, stderr: 'inherit' }))
    try {
      const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text
      const names = (await client.listTools()).tools.map((x) => x.name)
      expect(names).toEqual(expect.arrayContaining(['create_collection', 'edit_collection']))
      const made = text(await client.callTool({ name: 'create_collection', arguments: { title: '读书', parentId: host, ops: [{ op: 'add_prop', name: '评分', type: 'number' }] } }))
      expect(made).toContain('已新建合集「读书」 collection:')
      expect(made).toContain('- 加了数字属性「评分」')
      const id = /collection:([0-9a-f-]{36})/.exec(made)![1]!
      expect(text(await client.callTool({ name: 'edit_collection', arguments: { collectionId: `collection:${id}`, ops: [{ op: 'add_prop', name: '作者', type: 'text' }] } }))).toContain('加了文本属性「作者」')
      await client.callTool({ name: 'create_page', arguments: { title: '三体', parentId: id, props: { 评分: 9 } } })
      await client.callTool({ name: 'create_page', arguments: { title: '围城', parentId: id, props: { 评分: 7 } } })
      const got = text(await client.callTool({ name: 'read_collection', arguments: { collectionId: id, where: [{ prop: '评分', op: '>', value: 8 }] } }))
      expect(got).toContain('条件：评分 > 8，命中 1 行')
      expect(got).toContain('「三体」')
      expect(got).not.toContain('「围城」')
    } finally {
      await client.close()
    }
  })
})
