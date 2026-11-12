import { describe, expect, test } from 'vitest'
import type { AiCollection } from './collections/ai-read.js'
import { mintPageToken } from './page-read.js'
import { addProp, base, call, editCollection, pool, newCollection, postPage, postRow, replicaOf, rowDoc, team, type Team } from './collections/test-kit.js'

// 改父页进了合集 = 补成一行（collections/adopt.ts）：侧栏拖动（PATCH /api/pages/:id 的 parent_id）与 agent 的 move_page 同一份。
// 口径同合集视图里的「挪到别的合集」：属性按同名同类型对应、排到末尾、有编号就取号；只有普通页能放进合集。

async function bearer<T = Record<string, unknown>>(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json()) as T }
}

async function newRow(t: Team, cid: string, title: string, set: Record<string, unknown> = {}): Promise<string> {
  const res = await postRow(t.owner.cookie, cid, { title, set })
  expect(res.status).toBe(201)
  return res.body.id
}

const patchParent = (t: Team, id: string, body: Record<string, unknown>) => call('PATCH', `/api/pages/${id}`, t.owner.cookie, body)

async function readRows(token: string, cid: string): Promise<AiCollection['rows']> {
  const read = await bearer<AiCollection>('GET', `/api/ramet/collections/${cid}`, token)
  expect(read.status).toBe(200)
  return read.body.rows
}

/** A：状态、点数、负责人；B：状态、点数（同名同类型）、编号，已有一行「旧行」 */
async function fixture() {
  const t = await team()
  const a = await newCollection(t, { title: 'A' })
  const b = await newCollection(t, { title: 'B' })
  await editCollection(a.id, (root) => {
    addProp(root, 'pts00a', { name: '点数', type: 'number', pos: 1 })
    addProp(root, 'own00a', { name: '负责人', type: 'person', pos: 2 })
  })
  await editCollection(b.id, (root) => {
    addProp(root, 'pts00b', { name: '点数', type: 'number', pos: 1 })
    addProp(root, 'num00b', { name: '编号', type: 'unique_id', pos: 2 })
  })
  const old = await newRow(t, b.id, '旧行')
  const row = await newRow(t, a.id, '甲', { [a.status.id]: a.done, pts00a: 3, own00a: [t.member.id] })
  const doneName = a.status.options.find((o) => o.id === a.done)!.name
  return { t, a, b, old, row, doneName, token: mintPageToken(t.member.id, 'fake') }
}

describe('改父页进了合集', () => {
  test('侧栏拖到别的合集：属性按同名同类型对应（选项按名字换），对不上的丢；排在末尾、取号；侧栏下标不重排它', async () => {
    const { t, b, old, row, doneName, token } = await fixture()
    expect((await patchParent(t, row, { parent_id: b.id, index: 0 })).status).toBe(200)
    const rows = await readRows(token, b.id)
    expect(rows.map((r) => r.id)).toEqual([old, row])
    const values = new Map(rows[1]!.values)
    expect(values.get(b.status.name)).toBe(doneName)
    expect(values.get('点数')).toBe('3')
    expect(values.get('编号')).toEqual(expect.any(String))
    expect(values.has('负责人')).toBe(false)
    expect(await replicaOf(row)).toEqual({ [b.status.id]: b.done, pts00b: 3 })
    expect((await rowDoc(row)).getMap('props').toJSON()).toEqual({ [b.status.id]: b.done, pts00b: 3 })
  })

  test('agent 的 move_page 同一份：从合集挪到合集；普通页挪进合集就是一行；挪出去再挪回来值还在', async () => {
    const { t, a, b, old, row, token } = await fixture()
    expect((await bearer('POST', `/api/ramet/pages/${row}/move`, token, { parentId: `collection:${b.id}` })).status).toBe(200)
    expect(await replicaOf(row)).toEqual({ [b.status.id]: b.done, pts00b: 3 })

    const doc = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '普通页' })
    expect((await bearer('POST', `/api/ramet/pages/${doc}/move`, token, { parentId: b.id })).status).toBe(200)
    expect((await readRows(token, b.id)).map((r) => r.id)).toEqual([old, row, doc])

    // 挪出到普通页下，再挪回 B：行文档里的值是 B 的属性 id，B 认得，原样留下
    expect((await bearer('POST', `/api/ramet/pages/${row}/move`, token, { parentId: doc })).status).toBe(200)
    expect((await bearer('POST', `/api/ramet/pages/${row}/move`, token, { parentId: b.id })).status).toBe(200)
    expect(await replicaOf(row)).toEqual({ [b.status.id]: b.done, pts00b: 3 })
    // 回到 A：B 的属性在 A 里按名字对应回去（点数、状态），A 的「负责人」在 B 那一趟已经丢了
    expect((await bearer('POST', `/api/ramet/pages/${row}/move`, token, { parentId: a.id })).status).toBe(200)
    expect(await replicaOf(row)).toEqual({ [a.status.id]: a.done, pts00a: 3 })
  })

  test('合集里只放普通页：合集挪进合集 400（侧栏与 agent 同），什么都不动', async () => {
    const { t, a, b, token } = await fixture()
    const res = await patchParent(t, a.id, { parent_id: b.id })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toContain('合集里只能放普通页面')
    expect((await bearer('POST', `/api/ramet/pages/${a.id}/move`, token, { parentId: b.id })).status).toBe(400)
    expect((await pool.query('SELECT parent_id FROM pages WHERE id = $1', [a.id])).rows[0].parent_id).toBeNull()
  })
})
