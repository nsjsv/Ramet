import { afterAll, beforeEach, expect, test } from 'vitest'
import * as Y from 'yjs'
import { closePool, getPool, initDb, withTransaction } from './db.js'
import { copyPageTree } from './clone.js'
import { truncateAll } from './test-helpers.js'

// 测试必须显式指向测试库(如 ramet_test),防止误写开发库
if (!process.env.DATABASE_URL) {
  throw new Error('需要 DATABASE_URL 指向测试库,例如 postgres://postgres:postgres@localhost:5432/ramet_test')
}

// 纯 DB 单测:不开 server,只验 copyPageTree 的树复制契约(空间克隆/公开克隆两个调用方共用)
const pool = getPool()
await initDb(pool)

beforeEach(async () => {
  await truncateAll(pool)
})

afterAll(async () => {
  await closePool()
})

test('copyPageTree:不存在的根跳过不炸;存在的根整树复制且父子映射正确;docs 缺项落合法空文档', async () => {
  const userId = crypto.randomUUID()
  await pool.query('INSERT INTO users (id, username, password) VALUES ($1, $2, $3)', [userId, 'clone-u', 'x'])
  // 源空间与目标空间(目标空间必须真实存在:pages.space_id 有外键)
  const srcSpace = crypto.randomUUID()
  const dstSpace = crypto.randomUUID()
  for (const [id, name] of [
    [srcSpace, '源空间'],
    [dstSpace, '目标空间'],
  ] as const) {
    await pool.query('INSERT INTO spaces (id, name, owner_id, is_personal) VALUES ($1, $2, $3, false)', [
      id,
      name,
      userId,
    ])
  }

  // 源树:parent(顶层,带快照)→ child;ghost 代表"闸门后、事务前被并发删"的根
  const parent = crypto.randomUUID()
  const child = crypto.randomUUID()
  await pool.query('INSERT INTO pages (id, owner_id, space_id, title) VALUES ($1, $2, $3, $4)', [
    parent,
    userId,
    srcSpace,
    '父页',
  ])
  await pool.query('INSERT INTO pages (id, parent_id, owner_id, space_id, title) VALUES ($1, $2, $3, $4, $5)', [
    child,
    parent,
    userId,
    srcSpace,
    '子页',
  ])
  const ghost = crypto.randomUUID()
  // docs 只给 parent:child 无快照(历史脏数据/解析窗口外新建)→ 落合法空文档兜底
  const docs = new Map<string, Uint8Array>([[`page:${parent}`, new Uint8Array([1, 2, 3])]])

  // ghost 排在前面:缺根跳过,其余根的新 id 与入参顺序对应
  const { newRootIds, idMap } = await withTransaction(pool, (client) =>
    copyPageTree(client, [ghost, parent], dstSpace, userId, docs),
  )
  expect(newRootIds).toHaveLength(1)

  // 目标空间恰好两页:新父在顶层,新子挂新父下(父子映射正确)
  const rows = await pool.query<{
    id: string
    parent_id: string | null
    title: string
    owner_id: string | null
    space_id: string
  }>('SELECT id, parent_id, title, owner_id, space_id FROM pages WHERE space_id = $1', [dstSpace])
  expect(rows.rows).toHaveLength(2)
  const newParent = rows.rows.find((r) => r.title === '父页')!
  const newChild = rows.rows.find((r) => r.title === '子页')!
  expect(newParent.id).toBe(newRootIds[0])
  expect(newParent.parent_id).toBeNull()
  expect(newChild.parent_id).toBe(newParent.id)
  expect(newParent.owner_id).toBe(userId)
  // idMap 完整:父与子都在(目录树克隆重映射挂载引用要用)
  expect(idMap.get(parent)).toBe(newParent.id)
  expect(idMap.get(child)).toBe(newChild.id)

  // yjs_documents:有快照的页原样落,缺项页落合法空文档(applyUpdate 不炸且无内容);不写 yjs_updates
  const pdoc = await pool.query<{ state: Buffer }>('SELECT state FROM yjs_documents WHERE doc_name = $1', [
    `page:${newParent.id}`,
  ])
  expect(Buffer.from(pdoc.rows[0]!.state).equals(Buffer.from([1, 2, 3]))).toBe(true)
  const cdoc = new Y.Doc()
  const empty = await pool.query<{ state: Buffer }>('SELECT state FROM yjs_documents WHERE doc_name = $1', [
    `page:${newChild.id}`,
  ])
  Y.applyUpdate(cdoc, empty.rows[0]!.state)
  expect(cdoc.getXmlFragment('prosemirror').length).toBe(0)
  const updates = await pool.query('SELECT COUNT(*)::int AS n FROM yjs_updates')
  expect(updates.rows[0]!.n).toBe(0)

  // 源树原样不动
  const src = await pool.query('SELECT COUNT(*)::int AS n FROM pages WHERE space_id = $1', [srcSpace])
  expect(src.rows[0]!.n).toBe(2)
})
