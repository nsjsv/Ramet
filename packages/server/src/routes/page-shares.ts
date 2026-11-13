/* ---------- 单页分享（页面的分享面板、侧栏「分享给我的」用；判定在 page-visibility.ts，表在 page-share-schema.ts） ----------
 * GET    /api/pages/:id/shares → { owner, shares }：看得到这页才行（否则 404，不泄露存在性）。owner = 私人页的主人（公共页 null）；
 *   shares = 这页和祖先上给的分享，近的在前；guest = 对象不是这个空间的成员（访客）。直接给的 from = null；继承来的 from = { id, title }，
 *   那个祖先我看不到时 title = null（只分享了子页给我，不该让我知道上面那页叫什么）。
 * PUT    /api/pages/:id/shares/:userId { level: 'edit' | 'view' } → 同 GET：这个空间的成员、且能编辑这页才行，否则 403
 *   （访客能编辑也不能再分享出去：分享出去的范围该由空间里的人定）；不是自己、不是私人页的主人（400）；skill / 过程页不单独分享（400）。
 *   对象不是成员 = 邀请访客：空间关了「成员可以邀请访客」时只有空间 owner 能（403）。
 *   同一人在这页上只有一条，改档位即改它；档位真变了才算一次新的分享（收件箱再提醒一次）。
 * POST   /api/pages/:id/shares { username, level } → 同 PUT，按用户名找人（邀请访客用：不列全站用户）；没有这个用户 400。
 * DELETE /api/pages/:id/shares/:userId → 同 GET（自己退出后看不到了就是空的）：同 PUT 的人收回任何人的，被分享的人也能把自己移除；
 *   只删这一页上直接给的那条（继承来的要到给的那一页上收回），没有 404。
 * GET    /api/me/shares → { shares: [{ pageId, level, by, spaceId }], guestSpaces: [{ id, name }] }：直接分享给我、此刻我看得到的页
 *   （侧栏「分享给我的」、只读判断、面包屑）；guestSpaces = 这些页所在、我又不是成员的空间（空间切换器的「作为访客」）。
 * 写完：广播页面变更（对方的页面列表与分享列表重拉；页面列表的同步指纹带着分享，见 page-sync.ts）、提醒收件箱、
 *   断开这棵子树上的协同连接（只读与否只在连上时定，重连才按新档位；收回的人重连被拒）。
 * 每条路由自带 requireAuth（路径限定），挂载顺序无影响。 */

import { Hono, type Context } from 'hono'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv } from '../auth.js'
import { SELECT_SUBTREE_ALL } from '../page-trash.js'
import { pageAccess, pageVisibleSql, visiblePages, type PageRole } from '../page-visibility.js'
import { roleInSpace, writable } from './pages.js'

export type ShareLevel = 'edit' | 'view'
export type ShareView = { userId: string; username: string; level: ShareLevel; guest: boolean; from: null | { id: string; title: string | null } }
export type SharesView = { owner: { id: string; username: string } | null; shares: ShareView[] }

const SELECT_PAGE = 'SELECT id, space_id, private_owner, kind FROM live_pages WHERE id = $1'
const SELECT_USER = 'SELECT id, username FROM users WHERE id = $1'
const SELECT_USER_BY_NAME = 'SELECT id FROM users WHERE username = $1'
const SELECT_SPACE_POLICY = 'SELECT owner_id, members_invite_guests FROM spaces WHERE id = $1'
// 这页和祖先上的分享；guest = 对象不是页面所在空间的成员
const SELECT_SHARES = `WITH RECURSIVE up(id, parent_id, n) AS (
    SELECT id, parent_id, 0 FROM pages WHERE id = $1
    UNION ALL SELECT p.id, p.parent_id, up.n + 1 FROM pages p JOIN up ON p.id = up.parent_id WHERE up.n < 64
  )
  SELECT s.user_id, u.username, s.level, s.page_id, up.n, sp.title,
    NOT EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = $2 AND m.user_id = s.user_id) AS guest
  FROM up JOIN page_shares s ON s.page_id = up.id JOIN users u ON u.id = s.user_id JOIN pages sp ON sp.id = up.id
  ORDER BY up.n, u.username, s.user_id`
// 档位没变就什么都不改（不重新提醒）；变了连同给的人、时间一起换成这一次
const UPSERT = `INSERT INTO page_shares (page_id, user_id, level, granted_by) VALUES ($1, $2, $3, $4)
  ON CONFLICT (page_id, user_id) DO UPDATE SET level = EXCLUDED.level, granted_by = EXCLUDED.granted_by, created_at = now()
  WHERE page_shares.level <> EXCLUDED.level`
const DELETE_SHARE = 'DELETE FROM page_shares WHERE page_id = $1 AND user_id = $2'
const SELECT_MINE = `SELECT s.page_id, s.level, u.username AS by, p.space_id FROM page_shares s
  JOIN live_pages p ON p.id = s.page_id LEFT JOIN users u ON u.id = s.granted_by
  WHERE s.user_id = $1 AND ${pageVisibleSql('p', '$1')}
  ORDER BY s.created_at DESC, s.page_id`
// 我作为访客进得去的空间：有页分享给我，我又不是成员
const SELECT_GUEST_SPACES = `SELECT s.id, s.name FROM spaces s WHERE s.id = ANY($1::text[])
  AND NOT EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = s.id AND m.user_id = $2) ORDER BY s.name, s.id`

type PageInfo = { id: string; space_id: string; private_owner: string | null; kind: string }

export const GUESTS_OWNER_ONLY = '这个空间只有 owner 能邀请空间外的人'
const NO_SUCH_USER = '没有这个用户'

export type PageSharesDeps = {
  pool: Pool
  /** 页面列表变了（control 广播 changed） */
  notify?: () => void
  /** 收件箱可能多了 / 少了一条 */
  poke?: () => void
  /** 断开这些页上的协同连接 */
  dropAccess?: (pageIds: string[]) => void
}

export function pageShareRoutes({ pool, notify, poke, dropAccess }: PageSharesDeps) {
  const app = new Hono<AuthEnv>()
  const auth = requireAuth(pool)

  async function view(pageId: string, page: PageInfo, user: { id: string }): Promise<SharesView> {
    const rows = (
      await pool.query<{ user_id: string; username: string; level: ShareLevel; page_id: string; n: number; title: string; guest: boolean }>(SELECT_SHARES, [
        pageId,
        page.space_id,
      ])
    ).rows
    const fromIds = [...new Set(rows.filter((r) => r.n > 0).map((r) => r.page_id))]
    const seen = await visiblePages(pool, user, fromIds)
    const owner = page.private_owner ? ((await pool.query<{ id: string; username: string }>(SELECT_USER, [page.private_owner])).rows[0] ?? null) : null
    return {
      owner,
      shares: rows.map((r) => ({
        userId: r.user_id,
        username: r.username,
        level: r.level,
        guest: r.guest,
        from: r.n === 0 ? null : { id: r.page_id, title: seen.has(r.page_id) ? r.title : null },
      })),
    }
  }

  /** 这页 + 我在上面的角色；看不到 = null（同一个 404） */
  async function load(c: Context<AuthEnv>): Promise<{ page: PageInfo; role: PageRole } | null> {
    const id = c.req.param('id') ?? ''
    const role = await pageAccess(pool, id, c.get('user'))
    const page = role ? (await pool.query<PageInfo>(SELECT_PAGE, [id])).rows[0] : undefined
    return page && role ? { page, role } : null
  }

  /** 写入口的闸：这个空间的成员、且能编辑这页（访客能编辑也不能再分享出去） */
  async function canManage(page: PageInfo, role: PageRole, user: { id: string }): Promise<boolean> {
    return writable(role) && (await roleInSpace(pool, { id: user.id, role: 'user' }, page.space_id)) !== null
  }

  /** 给 target 这一档（PUT / POST 共用）；不行就是错误响应 */
  async function grant(c: Context<AuthEnv>, page: PageInfo, target: string, level: unknown): Promise<Response> {
    const user = c.get('user')
    if (level !== 'edit' && level !== 'view') return c.json({ error: "level must be 'edit' or 'view'" }, 400)
    if (page.kind === 'skill' || page.kind === 'run') return c.json({ error: `${page.kind} page cannot be shared` }, 400)
    if (target === user.id) return c.json({ error: 'cannot share with yourself' }, 400)
    if (target === page.private_owner) return c.json({ error: 'the owner already has access' }, 400)
    // 对象不是成员 = 邀请访客：空间可以关掉成员的这条路，owner 一直能
    if ((await roleInSpace(pool, { id: target, role: 'user' }, page.space_id)) === null) {
      const policy = (await pool.query<{ owner_id: string; members_invite_guests: boolean }>(SELECT_SPACE_POLICY, [page.space_id])).rows[0]
      if (!policy?.members_invite_guests && policy?.owner_id !== user.id) return c.json({ error: GUESTS_OWNER_ONLY }, 403)
    }
    const res = await pool.query(UPSERT, [page.id, target, level, user.id])
    if (res.rowCount) await changed(page.id)
    return c.json(await view(page.id, page, user))
  }

  async function changed(pageId: string): Promise<void> {
    notify?.()
    poke?.()
    const ids = (await pool.query<{ id: string }>(SELECT_SUBTREE_ALL, [[pageId]])).rows.map((r) => r.id)
    dropAccess?.(ids)
  }

  app.get('/api/pages/:id/shares', auth, async (c) => {
    const hit = await load(c)
    if (!hit) return c.json({ error: 'page not found' }, 404)
    c.header('cache-control', 'no-store')
    return c.json(await view(hit.page.id, hit.page, c.get('user')))
  })

  app.put('/api/pages/:id/shares/:userId', auth, async (c) => {
    const hit = await load(c)
    if (!hit) return c.json({ error: 'page not found' }, 404)
    if (!(await canManage(hit.page, hit.role, c.get('user')))) return c.json({ error: 'forbidden' }, 403)
    const body = (await c.req.json().catch(() => null)) as { level?: unknown } | null
    const target = c.req.param('userId')
    if (!(await pool.query(SELECT_USER, [target])).rows[0]) return c.json({ error: 'user not found' }, 400)
    return grant(c, hit.page, target, body?.level)
  })

  app.post('/api/pages/:id/shares', auth, async (c) => {
    const hit = await load(c)
    if (!hit) return c.json({ error: 'page not found' }, 404)
    if (!(await canManage(hit.page, hit.role, c.get('user')))) return c.json({ error: 'forbidden' }, 403)
    const body = (await c.req.json().catch(() => null)) as { username?: unknown; level?: unknown } | null
    const username = typeof body?.username === 'string' ? body.username.trim() : ''
    if (!username) return c.json({ error: 'username required' }, 400)
    const target = (await pool.query<{ id: string }>(SELECT_USER_BY_NAME, [username])).rows[0]
    if (!target) return c.json({ error: NO_SUCH_USER }, 400)
    return grant(c, hit.page, target.id, body?.level)
  })

  app.delete('/api/pages/:id/shares/:userId', auth, async (c) => {
    const user = c.get('user')
    const hit = await load(c)
    if (!hit) return c.json({ error: 'page not found' }, 404)
    const target = c.req.param('userId')
    if (target !== user.id && !(await canManage(hit.page, hit.role, user))) return c.json({ error: 'forbidden' }, 403)
    const res = await pool.query(DELETE_SHARE, [hit.page.id, target])
    if (!res.rowCount) return c.json({ error: 'share not found' }, 404)
    await changed(hit.page.id)
    const still = await pageAccess(pool, hit.page.id, user)
    return c.json(still ? await view(hit.page.id, hit.page, user) : { owner: null, shares: [] })
  })

  app.get('/api/me/shares', auth, async (c) => {
    const me = c.get('user').id
    const rows = (await pool.query<{ page_id: string; level: ShareLevel; by: string | null; space_id: string }>(SELECT_MINE, [me])).rows
    const spaceIds = [...new Set(rows.map((r) => r.space_id))]
    const guestSpaces = spaceIds.length ? (await pool.query<{ id: string; name: string }>(SELECT_GUEST_SPACES, [spaceIds, me])).rows : []
    c.header('cache-control', 'no-store')
    return c.json({ shares: rows.map((r) => ({ pageId: r.page_id, level: r.level, by: r.by, spaceId: r.space_id })), guestSpaces })
  })

  return app
}
