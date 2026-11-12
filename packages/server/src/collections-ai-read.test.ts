import { describe, expect, test } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { toStored, type CollectionSchema, type PropJson } from '@ramet/shared/collection-model'
import type { AiCollection } from './collections/ai-read.js'
import { mintPageToken } from './page-read.js'
import { addProp, addView, base, call, editCollection, newCollection, patchRow, postPage, postRow, schemaOf, team, type Fixture, type Team } from './collections/test-kit.js'

// agent 读合集（read_collection → GET /api/ramet/collections/:id）与 read_page 读到合集页 / 合集行时的说明。
// 凭证直接 mintPageToken（同 page-read.test.ts），不起 agent。

const MCP = fileURLToPath(new URL('./mcp/ramet.mjs', import.meta.url))

async function bearer<T = AiCollection>(path: string, token: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })
  return { status: res.status, body: (await res.json()) as T }
}

function formula(schema: CollectionSchema, name: string, display: string, pos: number): PropJson {
  const stored = toStored(display, schema)
  if (!stored.ok) throw new Error(`${display}: ${stored.error.message}`)
  return { name, type: 'formula', pos, cfg: { expr: stored.expr } }
}

async function newRow(t: Team, cid: string, title: string, set: Record<string, unknown>): Promise<string> {
  const res = await postRow(t.owner.cookie, cid, { title, set })
  expect(res.status).toBe(201)
  return res.body.id
}

/** 任务合集：状态（自带）、负责人、点数、双倍（公式）；视图「已完成」= 状态是完成、按点数倒序。行：甲（进行中）、乙、丙（完成） */
async function fixture() {
  const t = await team()
  const c: Fixture = await newCollection(t)
  await editCollection(c.id, (root) => {
    addProp(root, 'own001', { name: '负责人', type: 'person', pos: 1 })
    addProp(root, 'pts001', { name: '点数', type: 'number', pos: 2 })
  })
  const schema = await schemaOf(c.id)
  await editCollection(c.id, (root) => {
    addProp(root, 'dbl001', formula(schema, '双倍', '[点数] * 2', 3))
    addView(root, 'vdone1', { name: '已完成', filter: { all: [{ prop: c.status.id, op: 'is', value: c.done }] }, sorts: [{ prop: 'pts001', dir: 'desc' }] })
  })
  const a = await newRow(t, c.id, '甲', { [c.status.id]: c.doing, own001: [t.member.id], pts001: 3 })
  const b = await newRow(t, c.id, '乙', { [c.status.id]: c.done, pts001: 5 })
  const d = await newRow(t, c.id, '丙', { [c.status.id]: c.done, pts001: 1 })
  const name = (id: string) => c.status.options.find((o) => o.id === id)!.name
  return { t, c, rows: { a, b, d }, name }
}

describe('GET /api/ramet/collections/:id', () => {
  test('缺省全部行、手动顺序，值写成文字；属性带选项名；给视图按它的筛选和排序；分页续读', async () => {
    const { t, c, rows, name } = await fixture()
    const token = mintPageToken(t.member.id, 'fake')
    const all = await bearer(`/api/ramet/collections/${c.id}`, token)
    expect(all.status).toBe(200)
    expect(all.body.title).toBe('任务')
    expect(all.body.view).toBeNull()
    expect(all.body.total).toBe(3)
    expect(all.body.props.map((p) => [p.name, p.type])).toEqual([
      [c.status.name, '状态'],
      ['负责人', '人员'],
      ['点数', '数字'],
      ['双倍', '公式'],
    ])
    expect(all.body.props[0]!.options).toEqual(c.status.options.map((o) => o.name))
    expect(all.body.views.map((v) => v.name)).toContain('已完成')
    expect(all.body.rows.map((r) => r.id)).toEqual([rows.a, rows.b, rows.d])
    expect(all.body.rows[0]).toEqual({
      id: rows.a,
      title: '甲',
      values: [
        [c.status.name, name(c.doing)],
        ['负责人', t.member.name],
        ['点数', '3'],
        ['双倍', '6'],
      ],
    })

    for (const view of ['已完成', 'vdone1']) {
      const done = await bearer(`/api/ramet/collections/${c.id}?view=${encodeURIComponent(view)}`, token)
      expect(done.body.view).toMatchObject({ id: 'vdone1', name: '已完成' })
      expect(done.body.total).toBe(2)
      expect(done.body.rows.map((r) => r.id)).toEqual([rows.b, rows.d])
    }

    const first = await bearer(`/api/ramet/collections/${c.id}?limit=2`, token)
    expect(first.body.rows.map((r) => r.id)).toEqual([rows.a, rows.b])
    expect(first.body.next).toEqual(expect.any(String))
    const rest = await bearer(`/api/ramet/collections/${c.id}?limit=2&cursor=${encodeURIComponent(first.body.next!)}`, token)
    expect(rest.body.rows.map((r) => r.id)).toEqual([rows.d])
    expect(rest.body.next).toBeNull()

    const unknown = await bearer<{ error: string }>(`/api/ramet/collections/${c.id}?view=${encodeURIComponent('不存在')}`, token)
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toContain('「已完成」')
  })

  test('闸门：非成员 / 不是合集 / 别的空间的空间 AI 同一个 404；空间 AI（含只读）读得到本空间的；精简档 403', async () => {
    const { t, c } = await fixture()
    const path = `/api/ramet/collections/${c.id}`
    expect((await bearer(path, mintPageToken(t.outsider.id, 'fake'))).status).toBe(404)
    const doc = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '普通页' })
    expect((await bearer(`/api/ramet/collections/${doc}`, mintPageToken(t.owner.id, 'fake'))).status).toBe(404)
    expect((await bearer(path, mintPageToken(t.member.id, 'space-ai', { space: 'other-space' }))).status).toBe(404)
    expect((await bearer(path, mintPageToken(t.member.id, 'space-ai', { space: t.spaceId }))).status).toBe(200)
    expect((await bearer(path, mintPageToken(t.viewer.id, 'space-ai', { space: t.spaceId, readOnly: true }))).status).toBe(200)
    expect((await bearer(path, mintPageToken(t.member.id, 'fake', { profile: 'minimal' }))).status).toBe(403)
  })
})

describe('关联与汇总', () => {
  test('关联写对方行的标题、属性说明里写目标合集；汇总按输出类型写；反向关联与单行读同口径', async () => {
    const t = await team()
    const projects = await newCollection(t, { title: '项目' })
    const tasks = await newCollection(t, { title: '任务' })
    const rel = await call<{ prop: string; reverse: string }>('POST', `/api/collections/${tasks.id}/relations`, t.owner.cookie, {
      name: '所属项目',
      target: projects.id,
      two_way: true,
      reverse_name: '任务',
    })
    expect(rel.status).toBe(201)
    await editCollection(projects.id, (root) => addProp(root, 'cnt001', { name: '任务数', type: 'rollup', pos: 9, cfg: { relation: rel.body.reverse, prop: 'title', fn: 'count' } }))
    const p = await newRow(t, projects.id, '官网改版', {})
    const a = await newRow(t, tasks.id, '画稿', {})
    const b = await newRow(t, tasks.id, '写文案', {})
    for (const id of [a, b]) expect((await patchRow(t.owner.cookie, tasks.id, id, { set: { [rel.body.prop]: [p] } })).status).toBe(200)

    const token = mintPageToken(t.member.id, 'fake')
    const read = await bearer(`/api/ramet/collections/${tasks.id}`, token)
    expect(read.body.props.find((x) => x.name === '所属项目')).toMatchObject({ type: '关联', note: `关联到合集「项目」 collection:${projects.id}` })
    expect(read.body.rows.find((r) => r.id === a)!.values).toContainEqual(['所属项目', '官网改版'])
    const back = await bearer(`/api/ramet/collections/${projects.id}`, token)
    expect(back.body.rows[0]!.values).toEqual(expect.arrayContaining([['任务', '画稿、写文案'], ['任务数', '2']]))
    const row = await bearer<{ row?: { values: Array<[string, string]> } }>(`/api/pages/${p}/text`, token)
    expect(row.body.row!.values).toEqual(expect.arrayContaining([['任务', '画稿、写文案'], ['任务数', '2']]))
  })
})

describe('read_page 读到合集', () => {
  test('合集页标出 collection；合集行从第 1 行读时带所在合集与属性，翻页不带', async () => {
    const { t, c, rows, name } = await fixture()
    const token = mintPageToken(t.member.id, 'fake')
    const page = await bearer<{ collection?: true; lines: string[] }>(`/api/pages/${c.id}/text`, token)
    expect(page.body).toMatchObject({ collection: true, lines: [] })
    const row = await bearer<{ row?: { collection: { id: string; title: string }; values: Array<[string, string]> } }>(`/api/pages/${rows.b}/text`, token)
    expect(row.body.row).toEqual({
      collection: { id: c.id, title: '任务' },
      values: [
        [c.status.name, name(c.done)],
        ['点数', '5'],
        ['双倍', '10'],
      ],
    })
    expect((await bearer<{ row?: unknown }>(`/api/pages/${rows.b}/text?offset=2`, token)).body.row).toBeUndefined()
  })
})

describe('MCP 进程', () => {
  test('read_collection 收正文里的 collection: 记号并排成文字；read_page 读合集页指向 read_collection', async () => {
    const { t, c, rows, name } = await fixture()
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [MCP], env: { RAMET_PAGE_URL: base, RAMET_PAGE_TOKEN: mintPageToken(t.member.id, 'fake') }, stderr: 'inherit' }),
    )
    try {
      expect((await client.listTools()).tools.map((x) => x.name)).toContain('read_collection')
      const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]!.text)
      const read = text(await client.callTool({ name: 'read_collection', arguments: { collectionId: `collection:${c.id}` } }))
      expect(read).toContain(`# 合集「任务」 collection:${c.id}`)
      expect(read).toContain('全部 3 行')
      expect(read).toContain(`- page:${rows.a}「甲」 — ${c.status.name}：${name(c.doing)}；负责人：${t.member.name}；点数：3；双倍：6`)
      const limited = text(await client.callTool({ name: 'read_collection', arguments: { collectionId: c.id, view: '已完成', limit: 1 } }))
      expect(limited).toContain('按视图「已完成」的筛选和排序读，命中 2 行')
      expect(limited).toContain('cursor 填')
      const page = text(await client.callTool({ name: 'read_page', arguments: { pageId: c.id } }))
      expect(page).toContain('read_collection')
      const row = text(await client.callTool({ name: 'read_page', arguments: { pageId: rows.b } }))
      expect(row).toContain(`这一页是合集「任务」（collection:${c.id}）里的一行。属性：${c.status.name}：${name(c.done)}；点数：5；双倍：10`)
    } finally {
      await client.close()
    }
  })
})
