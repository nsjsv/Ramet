/* ---------- 页面在页面树与目录树之间拖动 ----------
 * 拖进目录树：目录树条目是叶子，挂进来的页脱离父页、移出页面树（同一事务）；带子页的页、非文档页、
 * 别的空间的页一律 400，页面原样不动。
 * 拖回页面树：挂到某页下时父页正文必须同时有它的入口（子页面块），不能有父页里找不到的子页。 */
import { expect, test } from 'vitest'
import * as Y from 'yjs'
import { pagesInPageTree } from '@ramet/shared/page-tree'
import { base, pool, setupPage, waitFor } from './agents/test-kit.js'
import { loadDocFromDb } from './collab.js'

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

test('目录树的页拖回页面树:挂到某页下 = 父页正文补入口;顶层不补;非页面条目 / 父页不在页面树 400 且不动', async () => {
  const { cookie, pageId: parentId } = await setupPage()
  const spaceId = (await pool.query<{ space_id: string }>('SELECT space_id FROM pages WHERE id = $1', [parentId])).rows[0]!.space_id
  const board = (await (await fetch(`${base}/api/spaces/${spaceId}/dir-tree`, { method: 'POST', headers: { cookie } })).json()) as {
    board: { id: string }
  }
  // 目录树文档：建页时就不进页面树，再挂到目录树顶层
  const dirDoc = async (title: string): Promise<{ pageId: string; itemId: string }> => {
    const pageId = (await call('POST', '/api/pages', cookie, { space_id: spaceId, in_page_tree: false, title })).body.id!
    const itemId = (await call('PUT', `/api/boards/${board.board.id}/items`, cookie, { kind: 'page', item_id: pageId })).body.id!
    return { pageId, itemId }
  }
  const toTree = (itemId: string, body: Record<string, unknown>) => call('POST', `/api/folder-items/${itemId}/to-page-tree`, cookie, body)
  const pageRow = async (id: string) =>
    (await pool.query('SELECT parent_id, in_page_tree FROM pages WHERE id = $1', [id])).rows[0] as { parent_id: string | null; in_page_tree: boolean }
  const refsIn = async (id: string): Promise<string[]> => {
    const doc = await loadDocFromDb(pool, `page:${id}`)
    return doc.getXmlFragment('prosemirror').toArray().flatMap((el) =>
      el instanceof Y.XmlElement && el.nodeName === 'page_ref' ? [String(el.getAttribute('pageId'))] : [],
    )
  }

  const a = await dirDoc('甲')
  const b = await dirDoc('乙')
  // 父页本身在目录树里（不进页面树）：挂过去就哪棵树都看不见，拒收且不动
  expect((await toTree(a.itemId, { parent_id: b.pageId })).body.error).toBe('parent is not in the page tree')
  expect(await pageRow(a.pageId)).toEqual({ parent_id: null, in_page_tree: false })
  // 上传的文件不是页面
  const fileId = crypto.randomUUID()
  await pool.query('INSERT INTO files (id, name, mime, size) VALUES ($1, $2, $3, $4)', [fileId, 'a.txt', 'text/plain', 1])
  const fileItem = (await call('PUT', `/api/boards/${board.board.id}/items`, cookie, { kind: 'file', item_id: fileId })).body.id!
  expect((await toTree(fileItem, { parent_id: null })).status).toBe(400)

  // 挂到页面树里的页下：成为子页，目录树里的条目没了，父页正文末尾有它的入口
  expect((await toTree(a.itemId, { parent_id: parentId, index: 0 })).status).toBe(200)
  expect(await pageRow(a.pageId)).toEqual({ parent_id: parentId, in_page_tree: true })
  expect((await pool.query('SELECT 1 FROM folder_items WHERE id = $1', [a.itemId])).rows).toEqual([])
  await waitFor(async () => (await refsIn(parentId)).includes(a.pageId))

  // 落到空间顶层：不往任何正文里加东西；下标按页面树算（根级的目录树文档不占位）
  expect((await toTree(b.itemId, { parent_id: null, index: 0 })).status).toBe(200)
  expect(await pageRow(b.pageId)).toEqual({ parent_id: null, in_page_tree: true })
  const roots = await pool.query<{ id: string }>(
    `SELECT id FROM live_pages WHERE space_id = $1 AND parent_id IS NULL AND in_page_tree ORDER BY position ASC NULLS LAST, created_at, id`,
    [spaceId],
  )
  expect(roots.rows.map((r) => r.id)).toEqual([b.pageId, parentId])
  expect(await refsIn(parentId)).toEqual([a.pageId])
})
