/* ---------- 页面树的页拖进目录树 ----------
 * 目录树条目是叶子：挂进来的页脱离父页、移出页面树（同一事务）；带子页的页、非文档页、
 * 别的空间的页一律 400，页面原样不动。 */
import { expect, test } from 'vitest'
import { pagesInPageTree } from '@ramet/shared/page-tree'
import { base, pool, setupPage } from './agents/test-kit.js'

type PageBody = { id: string; space_id: string; parent_id: string | null; in_page_tree: boolean }

const call = async (method: string, path: string, cookie: string, body?: unknown): Promise<{ status: number; body: { id?: string; error?: string } }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json()) as { id?: string; error?: string } }
}

test('拖进目录树:脱离父页并移出页面树;有子页 / 非文档页 / 别的空间的页 400 且不动', async () => {
  const { cookie, pageId: parentId } = await setupPage()
  const spaceId = (await pool.query<{ space_id: string }>('SELECT space_id FROM pages WHERE id = $1', [parentId])).rows[0]!.space_id
  const newPage = async (body: Record<string, unknown>): Promise<string> => (await call('POST', '/api/pages', cookie, body)).body.id!
  const leafId = await newPage({ space_id: spaceId, parent_id: parentId })
  const board = (await (await fetch(`${base}/api/spaces/${spaceId}/dir-tree`, { method: 'POST', headers: { cookie } })).json()) as {
    board: { id: string }
  }
  const folder = await call('POST', `/api/boards/${board.board.id}/folders`, cookie, { name: '夹' })
  const attach = (pageId: string) => call('PUT', `/api/folders/${folder.body.id}/items`, cookie, { kind: 'page', item_id: pageId })

  // 有子页的页拒收
  expect(await attach(parentId)).toMatchObject({ status: 400, body: { error: 'page has children' } })
  // 叶子页挂进目录：父子关系拿掉、不再是页面树成员，页面树只剩原父页
  expect((await attach(leafId)).status).toBe(201)
  const listed = ((await (await fetch(`${base}/api/pages`, { headers: { cookie } })).json()) as PageBody[]).filter(
    (p) => p.space_id === spaceId,
  )
  expect(listed.find((p) => p.id === leafId)).toMatchObject({ parent_id: null, in_page_tree: false })
  expect(pagesInPageTree(listed).map((p) => p.id)).toEqual([parentId])
  // 子页挪走后原父页成了叶子，可以挂到目录树顶层
  expect((await call('PUT', `/api/boards/${board.board.id}/items`, cookie, { kind: 'page', item_id: parentId })).status).toBe(201)

  // 别的空间的页不能借这棵目录树改写
  const otherSpace = (await call('POST', '/api/spaces', cookie, { name: '别处' })).body.id!
  const other = await newPage({ space_id: otherSpace })
  expect((await attach(other)).body.error).toBe('page not in this space')
  expect((await pool.query('SELECT in_page_tree FROM pages WHERE id = $1', [other])).rows[0]).toEqual({ in_page_tree: true })

  // 集合不是普通文档页
  const coll = await newPage({ space_id: spaceId })
  await pool.query(`UPDATE pages SET kind = 'collection' WHERE id = $1`, [coll])
  expect((await attach(coll)).body.error).toBe('only doc pages can be attached')
})
