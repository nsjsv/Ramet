import { describe, expect, test } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { toStored } from '@ramet/shared/collection-model'
import type { AiCollection } from './collections/ai-read.js'
import { mintPageToken } from './page-read.js'
import { addProp, base, call, editCollection, newCollection, pool, postPage, postRow, replicaOf, rowDoc, schemaOf, team, type Fixture, type Team } from './collections/test-kit.js'

// agent 写合集：set_props（POST /api/ramet/rows/set）与 create_page 建在合集下（POST /api/ramet/pages 带 props）。
// 结果用 read_collection 的端点读回来比文字（同一口径），凭证直接 mintPageToken。

const MCP = fileURLToPath(new URL('./mcp/ramet.mjs', import.meta.url))

async function bearer<T = Record<string, unknown>>(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json()) as T }
}

const setProps = (token: string, body: unknown) => bearer<{ count?: number; error?: string }>('POST', '/api/ramet/rows/set', token, body)

async function valuesOf(token: string, cid: string): Promise<Map<string, Map<string, string>>> {
  const read = await bearer<AiCollection>('GET', `/api/ramet/collections/${cid}`, token)
  expect(read.status).toBe(200)
  return new Map(read.body.rows.map((r) => [r.id, new Map(r.values)]))
}

async function newRow(t: Team, cid: string, title: string, set: Record<string, unknown> = {}): Promise<string> {
  const res = await postRow(t.owner.cookie, cid, { title, set })
  expect(res.status).toBe(201)
  return res.body.id
}

/** 任务合集：状态（自带）、负责人、点数、截止、双倍（公式）；两行甲、乙 */
async function fixture() {
  const t = await team()
  const c: Fixture = await newCollection(t)
  await editCollection(c.id, (root) => {
    addProp(root, 'own001', { name: '负责人', type: 'person', pos: 1 })
    addProp(root, 'pts001', { name: '点数', type: 'number', pos: 2 })
    addProp(root, 'due001', { name: '截止', type: 'date', pos: 3 })
  })
  const stored = toStored('[点数] * 2', await schemaOf(c.id))
  if (!stored.ok) throw new Error(stored.error.message)
  await editCollection(c.id, (root) => addProp(root, 'dbl001', { name: '双倍', type: 'formula', pos: 4, cfg: { expr: stored.expr } }))
  const a = await newRow(t, c.id, '甲', { pts001: 1 })
  const b = await newRow(t, c.id, '乙')
  const name = (id: string) => c.status.options.find((o) => o.id === id)!.name
  return { t, c, a, b, name, token: mintPageToken(t.member.id, 'fake') }
}

describe('set_props', () => {
  test('按属性名写人话的值：选项名、用户名、数字串、日期区间；一次改几行；改一行的标题双写', async () => {
    const { t, c, a, b, name, token } = await fixture()
    const res = await setProps(token, { rowIds: [`page:${a}`], props: { [c.status.name]: name(c.done), 负责人: [t.member.name], 点数: '8', 截止: '2026-11-20 → 2026-11-22' } })
    expect(res).toMatchObject({ status: 200, body: { count: 1 } })
    let rows = await valuesOf(token, c.id)
    expect(Object.fromEntries(rows.get(a)!)).toMatchObject({ [c.status.name]: name(c.done), 负责人: t.member.name, 点数: '8', 截止: '2026-11-20 → 2026-11-22', 双倍: '16' })
    expect(await replicaOf(a)).toMatchObject({ [c.status.id]: c.done, own001: [t.member.id], pts001: 8, due001: '2026-11-20/2026-11-22' })

    expect((await setProps(token, { rowIds: [a, b], props: { [c.status.name]: name(c.doing), 点数: null } })).body.count).toBe(2)
    rows = await valuesOf(token, c.id)
    for (const id of [a, b]) {
      expect(rows.get(id)!.get(c.status.name)).toBe(name(c.doing))
      expect(rows.get(id)!.has('点数')).toBe(false)
    }

    expect((await setProps(token, { rowIds: [b], title: '乙（改）' })).status).toBe(200)
    expect((await pool.query('SELECT title FROM pages WHERE id = $1', [b])).rows[0].title).toBe('乙（改）')
    expect((await rowDoc(b)).getXmlFragment('title').toString()).toContain('乙（改）')
  })

  test('有一个值不对就一行都不改，原因能照着改：属性名 / 选项 / 成员 / 数字 / 算出来的属性 / 名称；title 只能改一行', async () => {
    const { c, a, b, name, token } = await fixture()
    const bad = async (props: Record<string, unknown>, has: string) => {
      const res = await setProps(token, { rowIds: [a, b], props })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain(has)
    }
    await bad({ [c.status.name]: name(c.done), 优先级: '高' }, '没有叫「优先级」的属性')
    await bad({ [c.status.name]: '搁置' }, `可选：「${name(c.todo)}」`)
    await bad({ 负责人: 'nobody' }, '没有叫「nobody」的人')
    await bad({ 点数: '很多' }, '要填数字')
    await bad({ 双倍: 3 }, '值由 Ramet 算出来')
    await bad({ 名称: '新名字' }, '改它用 title')
    await bad({ 截止: '下周' }, '截止')
    expect((await valuesOf(token, c.id)).get(a)!.get('点数')).toBe('1')
    expect((await setProps(token, { rowIds: [a, b], title: 'x' })).status).toBe(400)
  })

  test('关联按标题或 page: 认；同名的要求用 id；反向关联指到对方合集去改', async () => {
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
    const site = await newRow(t, projects.id, '官网')
    const twinA = await newRow(t, projects.id, '重名')
    await newRow(t, projects.id, '重名')
    const job = await newRow(t, tasks.id, '画稿')
    const token = mintPageToken(t.member.id, 'fake')

    expect((await setProps(token, { rowIds: [job], props: { 所属项目: '官网' } })).status).toBe(200)
    expect((await valuesOf(token, tasks.id)).get(job)!.get('所属项目')).toBe('官网')
    expect((await setProps(token, { rowIds: [job], props: { 所属项目: '重名' } })).body.error).toContain('page:<行id>')
    expect((await setProps(token, { rowIds: [job], props: { 所属项目: [`page:${twinA}「重名」`, site] } })).status).toBe(200)
    // 关联的值按对方合集的手动顺序排，不按写入的先后
    expect((await valuesOf(token, tasks.id)).get(job)!.get('所属项目')).toBe('官网、重名')
    const reverse = await setProps(token, { rowIds: [site], props: { 任务: '画稿' } })
    expect(reverse.status).toBe(400)
    expect(reverse.body.error).toContain(`合集「任务」（collection:${tasks.id}）`)
  })

  test('闸门：viewer 403；非成员 / 别的空间的空间 AI / 不是合集的行 404；只读空间 AI 与精简档 403；行不在同一个合集 400', async () => {
    const { t, a } = await fixture()
    const body = { rowIds: [a], props: { 点数: 2 } }
    expect((await setProps(mintPageToken(t.viewer.id, 'fake'), body)).status).toBe(403)
    expect((await setProps(mintPageToken(t.outsider.id, 'fake'), body)).status).toBe(404)
    expect((await setProps(mintPageToken(t.member.id, 'space-ai', { space: 'other' }), body)).status).toBe(404)
    expect((await setProps(mintPageToken(t.member.id, 'space-ai', { space: t.spaceId }), body)).status).toBe(200)
    expect((await setProps(mintPageToken(t.member.id, 'space-ai', { space: t.spaceId, readOnly: true }), body)).status).toBe(403)
    expect((await setProps(mintPageToken(t.member.id, 'fake', { profile: 'minimal' }), body)).status).toBe(403)
    const doc = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '普通页' })
    expect((await setProps(mintPageToken(t.member.id, 'fake'), { rowIds: [doc], props: { 点数: 2 } })).status).toBe(404)
    const other = await newCollection(t, { title: '别的' })
    const elsewhere = await newRow(t, other.id, '丙')
    expect((await setProps(mintPageToken(t.member.id, 'fake'), { rowIds: [a, elsewhere], props: { 点数: 2 } })).status).toBe(400)
  })
})

describe('create_page 建在合集下', () => {
  test('建的是一行：带属性值与正文、排在末尾；props 不对不建；父页不是合集时不收 props', async () => {
    const { t, c, a, b, name, token } = await fixture()
    const created = await bearer<{ id: string }>('POST', '/api/ramet/pages', token, {
      title: '丙',
      parentId: `collection:${c.id}`,
      text: '要做的事：写周报',
      props: { [c.status.name]: name(c.done), 点数: 3 },
    })
    expect(created.status).toBe(200)
    const read = await bearer<AiCollection>('GET', `/api/ramet/collections/${c.id}`, token)
    expect(read.body.rows.map((r) => r.id)).toEqual([a, b, created.body.id])
    expect(Object.fromEntries(read.body.rows[2]!.values)).toMatchObject({ [c.status.name]: name(c.done), 点数: '3', 双倍: '6' })
    const text = await bearer<{ lines: string[] }>('GET', `/api/pages/${created.body.id}/text`, token)
    expect(text.body.lines.join('\n')).toContain('要做的事：写周报')
    expect((await pool.query('SELECT content_text FROM pages WHERE id = $1', [created.body.id])).rows[0].content_text).toContain('写周报')

    const before = (await pool.query("SELECT count(*)::int AS n FROM live_pages WHERE parent_id = $1", [c.id])).rows[0].n
    const bad = await bearer<{ error: string }>('POST', '/api/ramet/pages', token, { title: '丁', parentId: c.id, props: { 点数: '很多' } })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toContain('要填数字')
    expect((await pool.query("SELECT count(*)::int AS n FROM live_pages WHERE parent_id = $1", [c.id])).rows[0].n).toBe(before)

    const doc = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '普通页' })
    expect((await bearer('POST', '/api/ramet/pages', token, { title: '子页', parentId: doc, props: { 点数: 1 } })).status).toBe(400)
    expect((await bearer('POST', '/api/ramet/pages', mintPageToken(t.viewer.id, 'fake'), { title: '戊', parentId: c.id })).status).toBe(403)
  })
})

describe('MCP 进程', () => {
  test('set_props 与带 props 的 create_page', async () => {
    const { c, a, name, token } = await fixture()
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [MCP], env: { RAMET_PAGE_URL: base, RAMET_PAGE_TOKEN: token }, stderr: 'inherit' }))
    try {
      const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text
      expect((await client.listTools()).tools.map((x) => x.name)).toContain('set_props')
      expect(text(await client.callTool({ name: 'set_props', arguments: { rowIds: [a], props: { 点数: 5 } } }))).toBe('已改合集「任务」里的 1 行。')
      const failed = await client.callTool({ name: 'set_props', arguments: { rowIds: [a], props: { 点数: '很多' } } })
      expect(failed.isError).toBe(true)
      expect(text(failed)).toContain('要填数字')
      expect(text(await client.callTool({ name: 'create_page', arguments: { title: '丙', parentId: `collection:${c.id}`, props: { [c.status.name]: name(c.done) } } }))).toContain('已新建')
      const rows = await valuesOf(token, c.id)
      expect(rows.get(a)!.get('点数')).toBe('5')
      expect([...rows.values()].some((v) => v.get(c.status.name) === name(c.done))).toBe(true)
    } finally {
      await client.close()
    }
  })
})
