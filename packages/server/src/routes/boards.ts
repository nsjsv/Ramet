// 目录树 / 目录 / 目录条目一族：`boards` 表只登记空间目录树一行（一空间至多一行，UNIQUE(space_id)），
// 行按需惰性落库（POST /api/spaces/:id/dir-tree，首次写入前不存在）。
// 页面树不是实体：它是空间 pages 按 parent_id 组成的森林，由空间派生，没有行、不可建、不可删，
// 所以这里没有 page_tree 分支。可见 = 我是该空间成员（任意角色），可写 = owner / member，viewer 只读。
// 写路由与 pages.ts 同一套门：先 SELECT 可见性（不可见 404，不泄露存在性），再 writable 门（viewer 403），再写。
// 单一归属由 folder_items 的 UNIQUE (kind,item_id) 保证，挂载用 UPSERT 实现已挂他处即移动。
import { Hono } from 'hono'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv, type AuthUser } from '../auth.js'
import { ENSURE_DIR_TREE, withTransaction } from '../db.js'
import { roleInSpace, trashPageSubtree, writable } from './pages.js'

// 用 type 而非 interface：pg 的 query<T> 约束要求隐式索引签名，interface 给不了
type BoardRow = {
  id: string
  space_id: string
  created_at: string
}
type FolderRow = {
  id: string
  board_id: string
  parent_id: string | null
  name: string
  position: number | null
  created_at: string
  // 目录树所属空间的 id：SELECT_FOLDER 连树行一起取（可写门用），批量 SELECT_FOLDERS 行没有
  space_id?: string
}
type ItemRow = {
  id: string
  board_id: string
  folder_id: string | null
  kind: 'page' | 'file'
  item_id: string
  position: number | null
  created_at: string
  page_title: string | null
  icon_emoji: string | null
  icon_file_id: string | null
  file_name: string | null
  file_mime: string | null
  // 同 FolderRow：SELECT_ITEM 连树行 space_id，批量 SELECT_ITEMS 行没有
  space_id?: string
}

// 排序口径与 pages.ts 一致：position（拖拽排序）优先，NULLS LAST 兜底 created_at（后建的排最后）
const ORDER = 'position ASC NULLS LAST, created_at, id'

// 列表范围（三条 SQL 共用）：我是成员的空间，admin 也一样
const IN_SCOPE = `b.space_id IN (SELECT space_id FROM space_members WHERE user_id = $1)`
// 目录树行。行无 position，按 created_at 定序
const SELECT_BOARDS = `SELECT b.id, b.space_id, b.created_at
  FROM boards b
  WHERE ${IN_SCOPE}
  ORDER BY b.created_at, b.id`
// folders / items 只挂在目录树行上（所有 board 行都是目录树），范围与 board 行一致
const SELECT_FOLDERS = `SELECT f.* FROM folders f JOIN boards b ON b.id = f.board_id
  WHERE b.space_id IS NOT NULL AND ${IN_SCOPE}
  ORDER BY f.${ORDER}`
// 条目 JOIN 出展示字段：页面取 title / 图标，文件取 name / mime。回收站里的页面（live_pages 看不到）
// 不入树，WHERE 把页面条目限定到能 JOIN 上的行；文件条目 JOIN files 必然有行。
// 归属经 board_id 直达目录树行（顶层条目 folder_id 为 NULL，不能从目录 JOIN 起手）
const SELECT_ITEMS = `SELECT fi.*, p.title AS page_title, p.icon_emoji, p.icon_file_id,
  fl.name AS file_name, fl.mime AS file_mime
  FROM folder_items fi
  JOIN boards b ON b.id = fi.board_id
  LEFT JOIN live_pages p ON p.id = fi.item_id AND fi.kind = 'page'
  LEFT JOIN files fl ON fl.id = fi.item_id AND fi.kind = 'file'
  WHERE b.space_id IS NOT NULL AND ${IN_SCOPE}
    AND (fi.kind = 'file' OR p.id IS NOT NULL)
  ORDER BY fi.${ORDER}`
const SELECT_BOARD = 'SELECT * FROM boards WHERE id = $1'
// 目录 / 条目行连目录树 space_id 一起取：可见门与可写门都要它（folder / item 行本身不带空间）
const SELECT_FOLDER = `SELECT f.*, b.space_id AS space_id FROM folders f JOIN boards b ON b.id = f.board_id
  WHERE f.id = $1 AND b.space_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = b.space_id AND m.user_id = $2)`
const SELECT_ITEM = `SELECT fi.*, b.space_id AS space_id FROM folder_items fi
  JOIN boards b ON b.id = fi.board_id
  WHERE fi.id = $1 AND b.space_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = b.space_id AND m.user_id = $2)`
const VISIBLE_PAGE = `SELECT 1 FROM live_pages p JOIN space_members m ON m.space_id = p.space_id AND m.user_id = $2
  WHERE p.id = $1`
const SELECT_BOARD_BY_SPACE = 'SELECT id, space_id, created_at FROM boards WHERE space_id = $1'
const INSERT_FOLDER = 'INSERT INTO folders (id, board_id, parent_id, name) VALUES ($1, $2, $3, $4)'
const DELETE_BOARD = 'DELETE FROM boards WHERE id = $1'
const DELETE_FOLDER = 'DELETE FROM folders WHERE id = $1'
const DELETE_ITEM = 'DELETE FROM folder_items WHERE id = $1'

// 删目录 / 目录树要把范围内挂载的页面本体一起移入回收站。
// 目录子树（含自身）的 id 集，删单个目录时用来圈定这个目录及其子目录里挂的页面
const SELECT_FOLDER_SUBTREE = `WITH RECURSIVE sub AS (
  SELECT id FROM folders WHERE id = $1
  UNION
  SELECT f.id FROM folders f JOIN sub s ON f.parent_id = s.id
) SELECT id FROM sub`
// 目录树里的页面条目 id（DISTINCT 只是防御，一个页面只会挂一次）
const SELECT_BOARD_PAGE_ITEMS = `SELECT DISTINCT item_id FROM folder_items
  WHERE board_id = $1 AND kind = 'page'`
// 目录子树（含该目录）里的页面条目 id
const SELECT_FOLDER_PAGE_ITEMS = `SELECT DISTINCT item_id FROM folder_items
  WHERE kind = 'page' AND folder_id = ANY($1::text[])`

// 兄弟列表重排（同 pages.ts：index 是摘除自身后在目标兄弟列表里的插入下标，整列重写 0..n-1）。
// where 由内部调用方拼，表名 / 过滤都是本文件常量，无注入面
async function reorder(
  pool: Pool,
  table: string,
  where: string,
  params: unknown[],
  movedId: string,
  index: number,
): Promise<void> {
  const kids = (
    await pool.query<{ id: string }>(`SELECT id FROM ${table} WHERE ${where} ORDER BY ${ORDER}`, params)
  ).rows.map((r) => r.id)
  const at = Math.min(index, kids.length)
  kids.splice(at, 0, movedId)
  await withTransaction(pool, async (client) => {
    for (let i = 0; i < kids.length; i++) {
      await client.query(`UPDATE ${table} SET position = $1 WHERE id = $2`, [i, kids[i]!])
    }
  })
}

// notify：目录 / 目录树删除会连带页面回收，必须广播让各端页面树跟上。
// 回收只用 pages.ts 的 trashPageSubtree（这里不另写回收 SQL）：它只盖章活子树，
// 已回收 / 不存在的条目天然 no-op，目录里混着已回收页面时删除不会重复计数
export function boardsRoutes(pool: Pool, notify?: () => void) {
  const app = new Hono<AuthEnv>()
  app.use('*', requireAuth(pool))

  // 目录树可见门：任意空间成员（任意角色），admin 也不例外。不可见与不存在同响应 404
  async function visibleBoard(user: AuthUser, id: string): Promise<BoardRow | null> {
    const board = (await pool.query<BoardRow>(SELECT_BOARD, [id])).rows[0]
    if (!board) return null
    const member = await pool.query('SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2', [
      board.space_id,
      user.id,
    ])
    return member.rows.length > 0 ? board : null
  }
  // 目录树可写门：可写角色才动得了树 / 目录 / 条目，viewer 可见不可写（调用方 403）
  async function canWriteBoard(user: AuthUser, board: { space_id: string }): Promise<boolean> {
    return writable(await roleInSpace(pool, user, board.space_id))
  }
  async function visibleFolder(user: AuthUser, id: string): Promise<FolderRow | null> {
    return (await pool.query<FolderRow>(SELECT_FOLDER, [id, user.id])).rows[0] ?? null
  }
  // 目录 / 条目写门（空间角色）：viewer 403，非成员已在 SELECT 层 404 先挡
  async function folderWritable(user: AuthUser, row: { space_id?: string }): Promise<boolean> {
    return row.space_id !== undefined && writable(await roleInSpace(pool, user, row.space_id))
  }

  // parent 闸门（建目录 / 移动共用）：parent（null 即顶层）必须属于同一目录树
  async function parentInBoard(pool: Pool, parentId: string | null, boardId: string): Promise<boolean> {
    if (parentId === null) return true
    if (typeof parentId !== 'string') return false
    return (
      (await pool.query('SELECT 1 FROM folders WHERE id = $1 AND board_id = $2', [parentId, boardId])).rows
        .length > 0
    )
  }

  // 防环：父不能落进自己的子树。WITH RECURSIVE 沿 parent 链一次取全祖先，
  // UNION 去重保证库里已有环时递归终止（同 pages.ts validParent）
  async function validParent(pool: Pool, folderId: string, parentId: string | null, boardId: string): Promise<boolean> {
    if (parentId === null) return true
    const { rows } = await pool.query(
      `WITH RECURSIVE ancestors AS (
         SELECT id, parent_id FROM folders WHERE id = $2 AND board_id = $3
         UNION
         SELECT f.id, f.parent_id FROM folders f JOIN ancestors a ON f.id = a.parent_id
       )
       SELECT 1 FROM ancestors WHERE id = $1 LIMIT 1`,
      [folderId, parentId, boardId],
    )
    return rows.length === 0
  }

  // 扁平下发 boards / folders / items 三数组，前端按 parent_id / folder_id 组树（同 pages）
  app.get('/api/boards', async (c) => {
    const args = [c.get('user').id]
    const [boards, folders, items] = await Promise.all([
      pool.query<BoardRow>(SELECT_BOARDS, args),
      pool.query<FolderRow>(SELECT_FOLDERS, args),
      pool.query<ItemRow>(SELECT_ITEMS, args),
    ])
    return c.json({
      boards: boards.rows.map((b) => ({
        id: b.id,
        space_id: b.space_id,
        created_at: b.created_at,
      })),
      folders: folders.rows,
      items: items.rows.map((it) => ({
        id: it.id,
        board_id: it.board_id,
        folder_id: it.folder_id,
        kind: it.kind,
        item_id: it.item_id,
        created_at: it.created_at,
        title: it.page_title,
        icon:
          it.kind === 'page' && (it.icon_emoji || it.icon_file_id)
            ? it.icon_emoji
              ? { kind: 'emoji' as const, value: it.icon_emoji }
              : { kind: 'image' as const, value: it.icon_file_id! }
            : null,
        name: it.file_name,
        mime: it.file_mime,
      })),
    })
  })

  // 惰性补建该空间目录树行（幂等）：新空间默认 0 行，行在首次新建目录树或首次写入时落。
  // 非成员与空间不存在同响应 404（不泄露存在性），viewer 403，已存在回 200，新建回 201
  app.post('/api/spaces/:id/dir-tree', async (c) => {
    const user = c.get('user')
    const spaceId = c.req.param('id')
    const role = await roleInSpace(pool, user, spaceId)
    if (role === null) return c.json({ error: 'space not found' }, 404)
    if (!writable(role)) return c.json({ error: 'forbidden' }, 403)
    const inserted = (await pool.query(ENSURE_DIR_TREE, [spaceId])).rowCount
    const board = (await pool.query<BoardRow>(SELECT_BOARD_BY_SPACE, [spaceId])).rows[0]!
    return c.json({ board }, inserted === 1 ? 201 : 200)
  })

  // 删目录树：整棵树里的页面移入回收站（可恢复），文件条目只脱挂（files 无删除语义），
  // 目录 / 条目三级级联一次清。回收与删行同一事务，要么页面进了回收站且树没了，要么都没发生
  app.delete('/api/boards/:id', async (c) => {
    const user = c.get('user')
    const board = await visibleBoard(user, c.req.param('id'))
    if (!board) return c.json({ error: 'board not found' }, 404)
    if (!(await canWriteBoard(user, board))) return c.json({ error: 'forbidden' }, 403)
    const trashed = await withTransaction(pool, async (client) => {
      const items = (await client.query<{ item_id: string }>(SELECT_BOARD_PAGE_ITEMS, [board.id])).rows
      const ids = await trashPageSubtree(client, items.map((r) => r.item_id))
      await client.query(DELETE_BOARD, [board.id])
      return ids
    })
    notify?.()
    return c.json({ trashed })
  })

  app.post('/api/boards/:id/folders', async (c) => {
    const user = c.get('user')
    const board = await visibleBoard(user, c.req.param('id'))
    if (!board) return c.json({ error: 'board not found' }, 404)
    if (!(await canWriteBoard(user, board))) return c.json({ error: 'forbidden' }, 403)
    const body = (await c.req.json().catch(() => ({}))) as { parent_id?: unknown; name?: unknown }
    if (typeof body.name !== 'string') return c.json({ error: 'name must be a string' }, 400)
    const parentId = body.parent_id ?? null
    // parent 必须属于同一目录树，违规与不存在同响应
    if (!(await parentInBoard(pool, parentId as string | null, board.id))) {
      return c.json({ error: 'parent_id not found' }, 400)
    }
    const id = crypto.randomUUID()
    await pool.query(INSERT_FOLDER, [id, board.id, parentId, body.name])
    return c.json((await visibleFolder(user, id))!, 201)
  })

  app.patch('/api/folders/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const folder = await visibleFolder(user, id)
    if (!folder) return c.json({ error: 'folder not found' }, 404)
    if (!(await folderWritable(user, folder))) return c.json({ error: 'forbidden' }, 403)
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; parent_id?: unknown; index?: unknown }
    if (body.name !== undefined) {
      if (typeof body.name !== 'string') return c.json({ error: 'name must be a string' }, 400)
      await pool.query('UPDATE folders SET name = $1 WHERE id = $2', [body.name, id])
    }
    if (body.parent_id !== undefined) {
      const parentId = body.parent_id ?? null
      if (typeof parentId !== 'string' && parentId !== null) {
        return c.json({ error: 'parent_id must be a string or null' }, 400)
      }
      if (!(await parentInBoard(pool, parentId, folder.board_id))) {
        return c.json({ error: 'parent_id not found' }, 400)
      }
      if (!(await validParent(pool, id, parentId, folder.board_id))) {
        return c.json({ error: 'parent_id would create a cycle' }, 400)
      }
      await pool.query('UPDATE folders SET parent_id = $1 WHERE id = $2', [parentId, id])
    }
    if (body.index !== undefined) {
      if (typeof body.index !== 'number' || !Number.isInteger(body.index) || body.index < 0) {
        return c.json({ error: 'index must be a non-negative integer' }, 400)
      }
      const targetParent = body.parent_id !== undefined ? body.parent_id ?? null : folder.parent_id
      // 兄弟列表限同一目录树，缺过滤会把别的树的同级目录一起重排
      await reorder(
        pool,
        'folders',
        'parent_id IS NOT DISTINCT FROM $1 AND board_id = $2 AND id <> $3',
        [targetParent, folder.board_id, id],
        id,
        body.index,
      )
    }
    return c.json((await visibleFolder(user, id))!)
  })

  // 删目录：子树里挂的页面（含子目录里的）移入回收站（可恢复），文件条目只脱挂；
  // 目录与挂载行的删除靠 ON DELETE CASCADE（PG 逐层展开）。回收与级联删同一事务
  app.delete('/api/folders/:id', async (c) => {
    const user = c.get('user')
    const folder = await visibleFolder(user, c.req.param('id'))
    if (!folder) return c.json({ error: 'folder not found' }, 404)
    if (!(await folderWritable(user, folder))) return c.json({ error: 'forbidden' }, 403)
    const trashed = await withTransaction(pool, async (client) => {
      const subtree = (await client.query<{ id: string }>(SELECT_FOLDER_SUBTREE, [folder.id])).rows.map((r) => r.id)
      const items = (await client.query<{ item_id: string }>(SELECT_FOLDER_PAGE_ITEMS, [subtree])).rows
      const ids = await trashPageSubtree(client, items.map((r) => r.item_id))
      await client.query(DELETE_FOLDER, [folder.id])
      return ids
    })
    notify?.()
    return c.json({ trashed })
  })

  // 挂载体校验（kind / item_id，本体存在且可见）。目录级和树顶层两处挂载入口共用
  async function itemTargetError(user: AuthUser, body: { kind?: unknown; item_id?: unknown }): Promise<string | null> {
    if (body.kind !== 'page' && body.kind !== 'file') return 'kind must be page or file'
    if (typeof body.item_id !== 'string') return 'item_id must be a string'
    if (body.kind === 'page') {
      // 页面必须存在（未进回收站）且是我所在空间的页，admin 也不例外：挂进目录后标题会进目录树列表，
      // 而列表是列举类读路径（同 visiblePages）
      const visible = await pool.query(VISIBLE_PAGE, [body.item_id, user.id])
      if (!visible.rows[0]) return 'page not found'
    } else {
      if (!(await pool.query('SELECT 1 FROM files WHERE id = $1', [body.item_id])).rows[0]) {
        return 'file not found'
      }
    }
    return null
  }

  // 挂载写库（UPSERT：已挂他处即移动；folderId null 即目录树顶层条目）。两处入口共用
  async function attach(
    user: AuthUser,
    boardId: string,
    folderId: string | null,
    body: { kind: 'page' | 'file'; item_id: string },
  ): Promise<ItemRow | null> {
    const id = crypto.randomUUID()
    const { rows: upserted } = await pool.query<{ id: string }>(
      `INSERT INTO folder_items (id, board_id, folder_id, kind, item_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (kind, item_id) DO UPDATE SET board_id = EXCLUDED.board_id, folder_id = EXCLUDED.folder_id
       RETURNING id`,
      [id, boardId, folderId, body.kind, body.item_id],
    )
    return (await pool.query<ItemRow>(SELECT_ITEM, [upserted[0]!.id, user.id])).rows[0] ?? null
  }

  // 挂载到目录：已挂他处即移动，UNIQUE (kind,item_id) 保证全局单归属
  app.put('/api/folders/:id/items', async (c) => {
    const user = c.get('user')
    const folder = await visibleFolder(user, c.req.param('id'))
    if (!folder) return c.json({ error: 'folder not found' }, 404)
    if (!(await folderWritable(user, folder))) return c.json({ error: 'forbidden' }, 403)
    const body = (await c.req.json().catch(() => ({}))) as { kind?: unknown; item_id?: unknown }
    const err = await itemTargetError(user, body)
    if (err) return c.json({ error: err }, 400)
    const row = await attach(user, folder.board_id, folder.id, body as { kind: 'page' | 'file'; item_id: string })
    return c.json(row!, 201)
  })

  // 挂载到目录树顶层（folder_id NULL 的根级条目）
  app.put('/api/boards/:id/items', async (c) => {
    const user = c.get('user')
    const board = await visibleBoard(user, c.req.param('id'))
    if (!board) return c.json({ error: 'board not found' }, 404)
    if (!(await canWriteBoard(user, board))) return c.json({ error: 'forbidden' }, 403)
    const body = (await c.req.json().catch(() => ({}))) as { kind?: unknown; item_id?: unknown }
    const err = await itemTargetError(user, body)
    if (err) return c.json({ error: err }, 400)
    const row = await attach(user, board.id, null, body as { kind: 'page' | 'file'; item_id: string })
    return c.json(row!, 201)
  })

  app.patch('/api/folder-items/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const item = (await pool.query<ItemRow>(SELECT_ITEM, [id, user.id])).rows[0]
    if (!item) return c.json({ error: 'folder item not found' }, 404)
    if (!(await folderWritable(user, item))) return c.json({ error: 'forbidden' }, 403)
    const body = (await c.req.json().catch(() => ({}))) as { folder_id?: unknown; index?: unknown }
    let targetFolder = item.folder_id
    // 排序范围的树归属：默认原地，挪目录后是落点目录所在的目录树
    let scopeBoardId = item.board_id
    if (body.folder_id !== undefined && body.folder_id !== null) {
      if (typeof body.folder_id !== 'string') return c.json({ error: 'folder_id must be a string' }, 400)
      // 目标目录必须在可见目录集里
      const target = await visibleFolder(user, body.folder_id)
      if (!target) return c.json({ error: 'folder_id not found' }, 400)
      // 同步归属树：board_id 恒等于落点目录的树，挪目录连树一起换
      await pool.query(
        'UPDATE folder_items SET folder_id = $1, board_id = $2 WHERE id = $3',
        [target.id, target.board_id, id],
      )
      scopeBoardId = target.board_id
    } else if (body.folder_id === null) {
      // 挪回目录树顶层（folder_id NULL），树不变，board_id 原样
      await pool.query('UPDATE folder_items SET folder_id = NULL WHERE id = $1', [id])
      targetFolder = null // 排序范围跟随新归属（根级），不能沿用 UPDATE 前的旧目录
    }
    if (body.index !== undefined) {
      if (typeof body.index !== 'number' || !Number.isInteger(body.index) || body.index < 0) {
        return c.json({ error: 'index must be a non-negative integer' }, 400)
      }
      await reorder(
        pool,
        'folder_items',
        // 根级条目 folder_id 为 NULL，= 比较永不成立，必须用 IS NOT DISTINCT FROM（与 folders PATCH 同口径）；
        // 目录树必须圈进来：顶层条目（folder_id NULL）在所有树都存在，缺 board_id 会把别的树重排掉
        'folder_id IS NOT DISTINCT FROM $1 AND board_id = $2 AND id <> $3',
        [targetFolder, scopeBoardId, id],
        id,
        body.index,
      )
    }
    return c.json((await pool.query<ItemRow>(SELECT_ITEM, [id, user.id])).rows[0]!)
  })

  app.delete('/api/folder-items/:id', async (c) => {
    const user = c.get('user')
    const item = (await pool.query<ItemRow>(SELECT_ITEM, [c.req.param('id'), user.id])).rows[0]
    if (!item) return c.json({ error: 'folder item not found' }, 404)
    if (!(await folderWritable(user, item))) return c.json({ error: 'forbidden' }, 403)
    await pool.query(DELETE_ITEM, [item.id])
    return c.json({})
  })

  return app
}
