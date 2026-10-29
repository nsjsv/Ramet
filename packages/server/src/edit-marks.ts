// ---------- 上次编辑：整页与每个可寻址块各记「最后一次是谁、什么时候改的」 ----------
// 采集：活文档挂 afterTransaction（trackEdits）。归属 = 事务 origin 的 context：浏览器连接（Hocuspocus 的 Connection）、
// AI 机器人连接（同形，带 actor）、服务端直写（collab.ts createDocWriter 的 { context }）都是这个形状，
// 与 onChange → noteEditor 的快照归属同一条规则；从库加载、标题播种等没有 context 的内部写入不算。
// 只动块 id 的事务（补 id / 去重换 id）不算编辑，否则打开老页面的人会成为每一块的「编辑者」。
// 落库：存储钩子（onStoreDocument，改动停 ~2s / 断连）批量 upsert（flushEditMarks）。只存最后一次，不是历史。
// 读：GET /api/pages/:id/edit-marks（readEditMarks，整页 + 全部块一次给齐，前端进页面预取）。

import type { Pool } from 'pg'
import * as Y from 'yjs'
import { isAddressable } from '@ramet/shared/block-address'

type Mark = { userId: string; actor: 'user' | 'agent'; agent: string | null; at: Date }
/** 两次落库之间攒下的编辑。块存元素引用、落库时再读 id：新块的 id 可能由下一笔事务才补上 */
type Pending = { page: Mark | null; blocks: Map<Y.XmlElement, Mark> }

const pending = new WeakMap<Y.Doc, Pending>()
const tracked = new WeakSet<Y.Doc>()

type OriginContext = { user?: { id?: string }; actor?: { kind?: string; agent?: string | null } }

function markOf(origin: unknown, at: Date): Mark | null {
  const ctx = (origin as { context?: OriginContext } | null | undefined)?.context
  const userId = ctx?.user?.id
  if (!userId) return null
  const agent = ctx.actor?.kind === 'agent'
  return { userId, actor: agent ? 'agent' : 'user', agent: agent ? (ctx.actor?.agent ?? null) : null, at }
}

/** type 的所有祖先里可寻址的块（含自身，由深到浅；判定与手柄同一份 isAddressable）。不在正文里 → null */
function addressableChain(type: Y.AbstractType<any>, body: Y.XmlFragment): Y.XmlElement[] | null {
  const chain: Y.XmlElement[] = []
  let cur: Y.AbstractType<any> | null = type
  while (cur && cur !== body) {
    if (cur instanceof Y.XmlElement) chain.push(cur)
    cur = cur.parent
  }
  if (cur !== body) return null
  return chain.filter((el, i) => isAddressable(el.nodeName, chain[i + 1]?.nodeName ?? null))
}

/** 本事务新建的元素子树里的可寻址块（粘贴、换块类型都是删旧插新；Yjs 的 changed 只登记事务前就在的类型） */
function collectNew(el: Y.XmlElement, parentName: string | null, out: Y.XmlElement[]): void {
  if (isAddressable(el.nodeName, parentName)) out.push(el)
  el.forEach((child) => {
    if (child instanceof Y.XmlElement) collectNew(child, el.nodeName, out)
  })
}

function createdIn(el: Y.XmlElement, tr: Y.Transaction): boolean {
  const id = el._item?.id
  return !!id && id.clock >= (tr.beforeState.get(id.client) ?? 0)
}

/** 给活文档挂采集监听（每个 Y.Doc 实例一次；文档 unload 后随实例回收） */
export function trackEdits(doc: Y.Doc): void {
  if (tracked.has(doc)) return
  tracked.add(doc)
  const body = doc.getXmlFragment('prosemirror')
  doc.on('afterTransaction', (tr: Y.Transaction) => {
    if (tr.changed.size === 0) return
    const mark = markOf(tr.origin, new Date())
    if (!mark) return
    const touched: Y.XmlElement[] = []
    let edited = false
    tr.changed.forEach((keys, type) => {
      if (keys.size === 1 && keys.has('id')) return
      edited = true
      const chain = addressableChain(type, body)
      if (!chain) return // 标题 / 过程时间线等：只算整页
      touched.push(...chain)
      // 子节点有增删（键 null）：新插进来的元素也是被编辑的块
      if (!keys.has(null) || !(type instanceof Y.XmlElement || type instanceof Y.XmlFragment)) return
      const parentName = type === body ? null : (type as Y.XmlElement).nodeName
      type.forEach((child) => {
        if (child instanceof Y.XmlElement && createdIn(child, tr)) collectNew(child, parentName, touched)
      })
    })
    if (!edited) return
    let batch = pending.get(doc)
    if (!batch) pending.set(doc, (batch = { page: null, blocks: new Map() }))
    batch.page = mark
    for (const el of touched) batch.blocks.set(el, mark)
  })
}

// 同一批里 block_id 已去重（ON CONFLICT 不能在一条语句里改同一行两次）；乱序到达的旧标记不覆盖新的
const UPSERT_MARKS = `INSERT INTO edit_marks (page_id, block_id, user_id, actor, actor_agent, edited_at)
  SELECT $1, b, u, a, g, t
  FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::timestamptz[]) AS x(b, u, a, g, t)
  WHERE EXISTS (SELECT 1 FROM pages WHERE id = $1)
  ON CONFLICT (page_id, block_id) DO UPDATE SET user_id = EXCLUDED.user_id, actor = EXCLUDED.actor,
    actor_agent = EXCLUDED.actor_agent, edited_at = EXCLUDED.edited_at
  WHERE edit_marks.edited_at <= EXCLUDED.edited_at`

/** 把攒下的编辑落库。先摘下暂存再写（落库期间的新编辑进下一批）。尽力而为：失败只记日志，不顶给 Hocuspocus 钩子 */
export async function flushEditMarks(pool: Pool, pageId: string, doc: Y.Doc): Promise<void> {
  const batch = pending.get(doc)
  if (!batch) return
  pending.delete(doc)
  const rows = new Map<string, Mark>()
  if (batch.page) rows.set('', batch.page)
  for (const [el, mark] of batch.blocks) {
    if (el._item?.deleted) continue
    const id: unknown = el.getAttribute('id')
    if (typeof id !== 'string' || !id) continue
    const prev = rows.get(id)
    if (!prev || prev.at <= mark.at) rows.set(id, mark)
  }
  if (rows.size === 0) return
  const marks = [...rows.values()]
  try {
    await pool.query(UPSERT_MARKS, [
      pageId,
      [...rows.keys()],
      marks.map((m) => m.userId),
      marks.map((m) => m.actor),
      marks.map((m) => m.agent),
      marks.map((m) => m.at),
    ])
  } catch (err) {
    console.error(`上次编辑落库失败(page:${pageId}):`, err)
  }
}

/** 一条标记的对外形状；人名 / 头像在 EditMarks.users 里按 id 只给一份 */
export type MarkOut = { at: string; user_id: string | null; actor: 'user' | 'agent'; actor_agent: string | null }

/** GET /api/pages/:id/edit-marks：整页 + 全部块一次给齐（进页面预取，菜单打开即画，不等请求） */
export type EditMarks = {
  /** 头像文件 id：只在编辑者仍是该页所在空间成员时给（头像只给有共同空间的人看） */
  users: Record<string, { username: string; avatar: string | null }>
  page: MarkOut | null
  blocks: Record<string, MarkOut>
}

type MarkRow = { block_id: string; edited_at: Date; user_id: string | null; actor: string; actor_agent: string | null }

const SELECT_MARKS = 'SELECT block_id, edited_at, user_id, actor, actor_agent FROM edit_marks WHERE page_id = $1'
// 整页没有精确记录（老页面 / 不经协同写入的过程页）：回落最新一条版本快照
const SELECT_SNAPSHOT_MARK = `SELECT '' AS block_id, created_at::timestamptz AS edited_at, author_id AS user_id, actor, actor_agent
  FROM page_snapshots WHERE page_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`
const SELECT_USERS = `SELECT u.id, u.username, CASE WHEN m.user_id IS NOT NULL THEN u.avatar_file_id END AS avatar
  FROM users u LEFT JOIN space_members m ON m.space_id = $2 AND m.user_id = u.id
  WHERE u.id = ANY($1::text[])`

function markOut(row: MarkRow): MarkOut {
  const agent = row.actor === 'agent'
  return { at: row.edited_at.toISOString(), user_id: row.user_id, actor: agent ? 'agent' : 'user', actor_agent: agent ? row.actor_agent : null }
}

/** 一页的全部上次编辑。块没有记录就不在 blocks 里（不回落：块级没有可信的替代来源）。调用方负责可见性闸门 */
export async function readEditMarks(pool: Pool, page: { id: string; space_id: string | null }): Promise<EditMarks> {
  const rows = (await pool.query<MarkRow>(SELECT_MARKS, [page.id])).rows
  if (!rows.some((r) => r.block_id === '')) rows.push(...(await pool.query<MarkRow>(SELECT_SNAPSHOT_MARK, [page.id])).rows)
  const out: EditMarks = { users: {}, page: null, blocks: {} }
  for (const row of rows) {
    if (row.block_id === '') out.page = markOut(row)
    else out.blocks[row.block_id] = markOut(row)
  }
  const ids = [...new Set(rows.map((r) => r.user_id).filter((id): id is string => !!id))]
  if (ids.length > 0) {
    const users = await pool.query<{ id: string; username: string; avatar: string | null }>(SELECT_USERS, [ids, page.space_id])
    for (const u of users.rows) out.users[u.id] = { username: u.username, avatar: u.avatar }
  }
  return out
}
