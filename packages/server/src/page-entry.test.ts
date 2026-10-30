/* ---------- 子页入口：页面树里挂在文档页下的页，父页正文里必须有它的子页面块 ----------
 * 建子页、换父页、挂进目录树都由服务端维护入口；调用方自己插入口时（斜杠建页 / `[[新名字`）传 link_in_parent: false。 */
import { expect, test } from 'vitest'
import * as Y from 'yjs'
import { base, pool, setupPage, waitFor } from './agents/test-kit.js'
import { loadDocFromDb } from './collab.js'

const call = async (method: string, path: string, cookie: string, body?: unknown): Promise<{ status: number; body: { id?: string; error?: string } }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json()) as { id?: string; error?: string } }
}

async function refsIn(pageId: string): Promise<string[]> {
  const doc = await loadDocFromDb(pool, `page:${pageId}`)
  return doc.getXmlFragment('prosemirror').toArray().flatMap((el) =>
    el instanceof Y.XmlElement && el.nodeName === 'page_ref' ? [String(el.getAttribute('pageId'))] : [],
  )
}

test('建子页 / 换父页 / 挂进目录树:父页正文的入口跟着走;调用方自己插入口时不重复', async () => {
  const { cookie, pageId: a } = await setupPage()
  const spaceId = (await pool.query<{ space_id: string }>('SELECT space_id FROM pages WHERE id = $1', [a])).rows[0]!.space_id
  const create = async (body: Record<string, unknown>): Promise<string> => {
    const res = await call('POST', '/api/pages', cookie, { space_id: spaceId, ...body })
    expect(res.status).toBe(201)
    return res.body.id!
  }
  const b = await create({})

  // 侧栏「新建子页」：服务端在父页末尾补入口
  const child = await create({ parent_id: a, title: '子' })
  await waitFor(async () => (await refsIn(a)).length > 0)
  expect(await refsIn(a)).toEqual([child])
  // 斜杠建页 / `[[新名字`：入口由调用方插，服务端不补
  const own = await create({ parent_id: a, link_in_parent: false })
  expect(await refsIn(a)).toEqual([child])
  // 顶层页没有父页，什么也不写
  await create({})

  // 换父页：新父页补、旧父页摘
  expect((await call('PATCH', `/api/pages/${child}`, cookie, { parent_id: b })).status).toBe(200)
  await waitFor(async () => (await refsIn(b)).includes(child))
  await waitFor(async () => !(await refsIn(a)).includes(child))
  // 同父重排不动正文
  expect((await call('PATCH', `/api/pages/${child}`, cookie, { index: 0 })).status).toBe(200)
  expect(await refsIn(b)).toEqual([child])
  // 挪到顶层：旧父页摘掉，不往别处补
  expect((await call('PATCH', `/api/pages/${child}`, cookie, { parent_id: null })).status).toBe(200)
  await waitFor(async () => (await refsIn(b)).length === 0)

  // 挂进目录树：目录树条目就是入口，旧父页里的入口摘掉
  expect((await call('PATCH', `/api/pages/${own}`, cookie, { parent_id: b })).status).toBe(200)
  await waitFor(async () => (await refsIn(b)).includes(own))
  const board = (await (await fetch(`${base}/api/spaces/${spaceId}/dir-tree`, { method: 'POST', headers: { cookie } })).json()) as {
    board: { id: string }
  }
  expect((await call('PUT', `/api/boards/${board.board.id}/items`, cookie, { kind: 'page', item_id: own })).status).toBe(201)
  await waitFor(async () => (await refsIn(b)).length === 0)
})
