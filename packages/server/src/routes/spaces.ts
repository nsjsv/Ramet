import { randomBytes, randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import type { Pool } from 'pg'
import { withTransaction } from '../db.js'
import { purgeSpace } from '../page-purge.js'
import { requireAuth, USERNAME_MAX, type AuthEnv, type AuthUser } from '../auth.js'
import { deleteMemberConnectors } from '../agents/connectors.js'

// 用 type 而非 interface:pg 的 query<T> 约束要求隐式索引签名(同 pages.ts)
type SpaceRow = {
  id: string
  name: string
  owner_id: string
  is_personal: boolean
  created_at: string
}

// 列表/详情行:my_role = 我在该空间的实际角色;非成员为 null(列表只含自己参与的空间)
type MySpaceRow = SpaceRow & { my_role: 'owner' | 'member' | 'viewer' | null }

// avatar = 头像的 files.id(NULL = 没上传):对话气泡按发言人画头像,成员之间可见
type MemberRow = {
  user_id: string
  username: string
  role: 'owner' | 'member' | 'viewer'
  created_at: string
  avatar: string | null
}

type InviteRow = { token: string; role: 'member' | 'viewer'; created_by: string; created_at: string }

type InvitePreviewRow = {
  space_id: string
  space_name: string
  role: 'member' | 'viewer'
  created_by_username: string
  created_at: string
}

// ---------- SQL 常量 ----------

const SELECT_MY_SPACES = `SELECT s.id, s.name, s.owner_id, s.is_personal, s.created_at, m.role AS my_role
  FROM spaces s JOIN space_members m ON m.space_id = s.id AND m.user_id = $1
  ORDER BY s.created_at, s.id`
const SELECT_SPACE_BY_ID = 'SELECT id, name, owner_id, is_personal, created_at FROM spaces WHERE id = $1'
// LEFT JOIN:不存在的成员行不该吞掉空间本身,my_role 为 null 交由调用方判定
const SELECT_SPACE_WITH_ROLE = `SELECT s.id, s.name, s.owner_id, s.is_personal, s.created_at, m.role AS my_role
  FROM spaces s LEFT JOIN space_members m ON m.space_id = s.id AND m.user_id = $2
  WHERE s.id = $1`
const INSERT_SPACE = 'INSERT INTO spaces (id, name, owner_id, is_personal) VALUES ($1, $2, $3, false)'
const INSERT_MEMBER = 'INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)'
const UPDATE_SPACE_NAME = 'UPDATE spaces SET name = $1 WHERE id = $2'
const SELECT_MEMBERS = `SELECT m.user_id, u.username, m.role, m.created_at, u.avatar_file_id AS avatar
  FROM space_members m JOIN users u ON u.id = m.user_id
  WHERE m.space_id = $1 ORDER BY m.created_at, m.user_id`
const SELECT_MEMBER_ROLE = 'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2'
const DELETE_MEMBER = 'DELETE FROM space_members WHERE space_id = $1 AND user_id = $2'
const SELECT_MEMBER = `SELECT m.user_id, u.username, m.role, m.created_at, u.avatar_file_id AS avatar
  FROM space_members m JOIN users u ON u.id = m.user_id WHERE m.space_id = $1 AND m.user_id = $2`
const SELECT_USER_BY_NAME = 'SELECT id FROM users WHERE username = $1'
const UPDATE_MEMBER_ROLE = "UPDATE space_members SET role = $3 WHERE space_id = $1 AND user_id = $2 AND role <> 'owner'"
// 按用户名拉人：已在空间里不改动（改角色走 PATCH），冲突就是 409
const INSERT_MEMBER_IF_NEW = 'INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING'
const INSERT_INVITE = `INSERT INTO space_invites (token, space_id, role, created_by)
  VALUES ($1, $2, $3, $4) RETURNING token, role, created_by, created_at`
const SELECT_SPACE_INVITES = `SELECT token, role, created_by, created_at
  FROM space_invites WHERE space_id = $1 ORDER BY created_at, token`
const SELECT_INVITE = 'SELECT token, space_id, role, created_by, created_at FROM space_invites WHERE token = $1'
// 预览把空间名与邀请人一起带出:token 本身即凭证(128bit 不可枚举),不泄露额外信息
const SELECT_INVITE_PREVIEW = `SELECT i.space_id, s.name AS space_name, i.role,
  u.username AS created_by_username, i.created_at
  FROM space_invites i JOIN spaces s ON s.id = i.space_id JOIN users u ON u.id = i.created_by
  WHERE i.token = $1`
const DELETE_INVITE = 'DELETE FROM space_invites WHERE token = $1'
// 接受即落成员行,重复接受幂等(重新邀请可提权/降权);
// 唯一例外是 owner:不能被自己空间的邀请降权,WHERE 把 owner 行摘出更新
const UPSERT_MEMBER_ON_ACCEPT = `INSERT INTO space_members (space_id, user_id, role)
  VALUES ($1, $2, $3)
  ON CONFLICT (space_id, user_id) DO UPDATE SET role = EXCLUDED.role
  WHERE space_members.role <> 'owner'`

// 空间名与用户名同一套规矩:trim 后 1..50 字符
function normalizeSpaceName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  return name && name.length <= USERNAME_MAX ? name : null
}

// 管理权 = 空间 owner;成员/只读不可管理,全局 admin 也没有例外
function canAdminister(user: AuthUser, space: { owner_id: string }): boolean {
  return space.owner_id === user.id
}

// notify:树/空间变更广播回调(注入 notifyPagesChanged,测试可不传保持原签名)。
// 空间增删改、成员退出/移除、邀请接受成功后调(影响空间可见性),
// GET 与邀请创建/撤销/预览不通知。
// dropConnectors:成员被移出空间 / 降为只读 / 空间被删时,他在该空间接入的机器已在库里删掉,这里断开它们的在线连接
// (注入 hub.closeOne,测试可不传保持原签名)。reason 是给 connector 的断开原因。
export function spacesRoutes(
  pool: Pool,
  notify?: () => void,
  dropConnectors?: (connectorIds: string[], reason: string) => void,
) {
  const app = new Hono<AuthEnv>()
  // 全族路由都要求登录,鉴权统一挂全量
  app.use('*', requireAuth(pool))

  app.get('/api/spaces', async (c) => {
    const user = c.get('user')
    // 列表隔离在 SQL 层:所有人(含 admin)都只看自己是成员的空间
    const rows = await pool.query<MySpaceRow>(SELECT_MY_SPACES, [user.id])
    return c.json(rows.rows)
  })

  app.post('/api/spaces', async (c) => {
    const user = c.get('user')
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null
    const name = normalizeSpaceName(body?.name)
    if (!name) return c.json({ error: 'invalid name' }, 400)
    const id = randomUUID()
    // 空间行 + owner 成员行同一事务。不预建树注册行:页面树是空间的派生视图,
    // 目录树行在该空间首次写入时按需落库
    const row = await withTransaction(pool, async (client) => {
      await client.query(INSERT_SPACE, [id, name, user.id])
      await client.query(INSERT_MEMBER, [id, user.id, 'owner'])
      return (await client.query<SpaceRow>(SELECT_SPACE_BY_ID, [id])).rows[0]
    })
    notify?.()
    return c.json({ ...row, my_role: 'owner' }, 201)
  })

  app.patch('/api/spaces/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null
    const name = normalizeSpaceName(body?.name)
    if (!name) return c.json({ error: 'invalid name' }, 400)
    const row = (await pool.query<MySpaceRow>(SELECT_SPACE_WITH_ROLE, [id, user.id])).rows[0]
    // 非成员与不存在同响应 404(不泄露存在性);是成员但非 owner 403
    if (!row || row.my_role === null) return c.json({ error: 'space not found' }, 404)
    if (!canAdminister(user, row)) return c.json({ error: 'forbidden' }, 403)
    await pool.query(UPDATE_SPACE_NAME, [name, id])
    notify?.()
    return c.json({ ...row, name, my_role: row.my_role })
  })

  app.delete('/api/spaces/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const row = (await pool.query<MySpaceRow>(SELECT_SPACE_WITH_ROLE, [id, user.id])).rows[0]
    if (!row || row.my_role === null) return c.json({ error: 'space not found' }, 404)
    if (!canAdminister(user, row)) return c.json({ error: 'forbidden' }, 403)
    // 个人空间是页面树的家底,不可删(删号时的单人空间清理走 purgeSpace,不经这里)
    if (row.is_personal) return c.json({ error: 'cannot delete personal space' }, 400)
    const dropped = await withTransaction(pool, (client) => purgeSpace(client, id))
    // 空间里接入的机器随空间删掉了：断开在线连接（4403，connector 不再重连）
    dropConnectors?.(dropped, '空间已删除')
    notify?.()
    return c.json({})
  })

  app.get('/api/spaces/:id/members', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const row = (await pool.query<MySpaceRow>(SELECT_SPACE_WITH_ROLE, [id, user.id])).rows[0]
    // 非成员与不存在同响应 404,不泄露存在性
    if (!row || row.my_role === null) return c.json({ error: 'space not found' }, 404)
    return c.json((await pool.query<MemberRow>(SELECT_MEMBERS, [id])).rows)
  })

  app.delete('/api/spaces/:id/members/:userId', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const targetId = c.req.param('userId')
    const row = (await pool.query<MySpaceRow>(SELECT_SPACE_WITH_ROLE, [id, user.id])).rows[0]
    if (!row) return c.json({ error: 'space not found' }, 404)
    const isMember = row.my_role !== null
    if (targetId === user.id) {
      // 退群:成员/只读可退,非成员没什么可退(404 与"看不到此空间"一致)
      if (!isMember) return c.json({ error: 'space not found' }, 404)
    } else if (!canAdminister(user, row)) {
      // 移除他人是管理动作:非成员 404 不泄露,是成员但非 owner 403
      if (!isMember) return c.json({ error: 'space not found' }, 404)
      return c.json({ error: 'forbidden' }, 403)
    }
    const target = (await pool.query<{ role: MemberRow['role'] }>(SELECT_MEMBER_ROLE, [id, targetId])).rows[0]
    // 目标不在空间里,或目标是 owner(owner 不可被移除也不可自退,退群语义不适用于空间的最后锚点)
    if (!target) return c.json({ error: 'not a member' }, 400)
    if (target.role === 'owner') return c.json({ error: 'owner cannot be removed' }, 400)
    // 删成员行与删他在该空间接入的机器同一事务(确认配对建机器时对成员行 FOR SHARE,两者互斥,不会漏出无主的机器);
    // 在线连接在提交后断开。退出空间 = 他的机器不再属于这个空间
    const dropped = await withTransaction(pool, async (client) => {
      await client.query(DELETE_MEMBER, [id, targetId])
      return deleteMemberConnectors(client, id, targetId)
    })
    dropConnectors?.(dropped, '已不是空间成员')
    notify?.()
    return c.json({})
  })

  /** 管理动作的闸门（改角色 / 拉人 / 邀请）：空间存在；只有 owner 才行。
   *  是成员但不是 owner → 403；非成员与不存在同响应 404（不泄露存在性） */
  async function adminGate(c: Context<AuthEnv>, spaceId: string): Promise<{ row: SpaceRow } | { res: Response }> {
    const user = c.get('user')
    const row = (await pool.query<SpaceRow>(SELECT_SPACE_BY_ID, [spaceId])).rows[0]
    if (!row) return { res: c.json({ error: 'space not found' }, 404) }
    if (canAdminister(user, row)) return { row }
    const member = (await pool.query(SELECT_MEMBER_ROLE, [spaceId, user.id])).rows[0]
    return { res: member ? c.json({ error: 'forbidden' }, 403) : c.json({ error: 'space not found' }, 404) }
  }

  // 改成员角色（member ⇄ viewer）。owner 的角色不可改（空间的最后锚点）；目标不在空间里 400
  app.patch('/api/spaces/:id/members/:userId', async (c) => {
    const id = c.req.param('id')
    const targetId = c.req.param('userId')
    const gate = await adminGate(c, id)
    if ('res' in gate) return gate.res
    const body = (await c.req.json().catch(() => null)) as { role?: unknown } | null
    if (body?.role !== 'member' && body?.role !== 'viewer') return c.json({ error: 'role must be member or viewer' }, 400)
    const target = (await pool.query<{ role: MemberRow['role'] }>(SELECT_MEMBER_ROLE, [id, targetId])).rows[0]
    if (!target) return c.json({ error: 'not a member' }, 400)
    if (target.role === 'owner') return c.json({ error: 'owner role cannot be changed' }, 400)
    // 降为只读(viewer):他接入的机器同样不能留(接入的 agent 会写这个空间的页面)。改角色与删机器同一事务
    const dropped = await withTransaction(pool, async (client) => {
      await client.query(UPDATE_MEMBER_ROLE, [id, targetId, body.role])
      return body.role === 'viewer' ? deleteMemberConnectors(client, id, targetId) : []
    })
    dropConnectors?.(dropped, '已改为只读成员')
    notify?.()
    return c.json((await pool.query<MemberRow>(SELECT_MEMBER, [id, targetId])).rows[0])
  })

  // 按用户名直接拉人进空间（不走邀请链接）。只授 member|viewer，永不授 owner；用户不存在 404，已在空间里 409
  app.post('/api/spaces/:id/members', async (c) => {
    const id = c.req.param('id')
    const gate = await adminGate(c, id)
    if ('res' in gate) return gate.res
    const body = (await c.req.json().catch(() => null)) as { username?: unknown; role?: unknown } | null
    if (body?.role !== 'member' && body?.role !== 'viewer') return c.json({ error: 'role must be member or viewer' }, 400)
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    if (!username) return c.json({ error: 'username required' }, 400)
    const target = (await pool.query<{ id: string }>(SELECT_USER_BY_NAME, [username])).rows[0]
    if (!target) return c.json({ error: 'user not found' }, 404)
    const inserted = await pool.query(INSERT_MEMBER_IF_NEW, [id, target.id, body.role])
    if (!inserted.rowCount) return c.json({ error: 'already a member' }, 409)
    notify?.()
    return c.json((await pool.query<MemberRow>(SELECT_MEMBER, [id, target.id])).rows[0], 201)
  })

  app.post('/api/spaces/:id/invites', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const gate = await adminGate(c, id)
    if ('res' in gate) return gate.res
    const body = (await c.req.json().catch(() => null)) as { role?: unknown } | null
    // 邀请只授 member|viewer,永不授 owner
    if (body?.role !== 'member' && body?.role !== 'viewer') {
      return c.json({ error: 'role must be member or viewer' }, 400)
    }
    // 多链接并存,各自可撤,不做合并去重
    const token = randomBytes(32).toString('hex')
    const invite = (await pool.query<InviteRow>(INSERT_INVITE, [token, id, body.role, user.id])).rows[0]
    return c.json(invite, 201)
  })

  app.get('/api/spaces/:id/invites', async (c) => {
    const id = c.req.param('id')
    const gate = await adminGate(c, id)
    if ('res' in gate) return gate.res
    return c.json((await pool.query<InviteRow>(SELECT_SPACE_INVITES, [id])).rows)
  })

  // 撤销邀请:路径里只有 token,权限按"该空间 owner"判
  app.delete('/api/invites/:token', async (c) => {
    const user = c.get('user')
    const token = c.req.param('token')
    const invite = (await pool.query<{ space_id: string }>(SELECT_INVITE, [token])).rows[0]
    if (!invite) return c.json({ error: 'invite not found' }, 404)
    const row = (await pool.query<SpaceRow>(SELECT_SPACE_BY_ID, [invite.space_id])).rows[0]
    if (!row) return c.json({ error: 'invite not found' }, 404)
    if (!canAdminister(user, row)) {
      const member = (await pool.query(SELECT_MEMBER_ROLE, [invite.space_id, user.id])).rows[0]
      if (!member) return c.json({ error: 'invite not found' }, 404)
      return c.json({ error: 'forbidden' }, 403)
    }
    await pool.query(DELETE_INVITE, [token])
    return c.json({})
  })

  // 预览:任何登录用户持有效 token 即可见空间名与邀请人;不存在/已撤销一律 404
  app.get('/api/invites/:token', async (c) => {
    const row = (await pool.query<InvitePreviewRow>(SELECT_INVITE_PREVIEW, [c.req.param('token')])).rows[0]
    if (!row) return c.json({ error: 'invite not found' }, 404)
    return c.json(row)
  })

  app.post('/api/invites/:token/accept', async (c) => {
    const user = c.get('user')
    const token = c.req.param('token')
    // 查邀请 + 落成员行同一事务:撤销与接受的竞争不会产生半态
    let dropped: string[] = []
    let reason = ''
    const res = await withTransaction(pool, async (client) => {
      const invite = (await client.query<{ space_id: string; role: 'member' | 'viewer' }>(SELECT_INVITE, [token]))
        .rows[0]
      if (!invite) return c.json({ error: 'invite not found' }, 404)
      await client.query(UPSERT_MEMBER_ON_ACCEPT, [invite.space_id, user.id, invite.role])
      // 回实际生效的角色:已是 owner 的老成员接受邀请后仍是 owner
      const my = (await client.query<{ role: MemberRow['role'] }>(SELECT_MEMBER_ROLE, [invite.space_id, user.id]))
        .rows[0]
      // 重新邀请可降权(member → viewer):和 PATCH 改角色同一条规矩,他在该空间接入的机器一并删掉
      if (my?.role === 'viewer') {
        dropped = await deleteMemberConnectors(client, invite.space_id, user.id)
        reason = '已改为只读成员'
      }
      return c.json({ space_id: invite.space_id, role: my?.role ?? invite.role }, 200)
    })
    // 事务提交后才断开 / 广播:收通知的端 refresh 不该读到未提交的成员行
    dropConnectors?.(dropped, reason)
    notify?.()
    return res
  })

  return app
}
