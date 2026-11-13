/* ---------- 空间的访客与人员目录（访客 = 不是这个空间的成员、却有页分享给他的人；分享本身在 routes/page-shares.ts） ----------
 * GET    /api/spaces/:id/people → { people: [{ id, username, avatar }] }：这个空间里我认识的人（@ 候选、人员属性、头像都读这里）。
 *   成员：全体成员 + 本空间的访客（成员能 @ 访客、在页面上认出他）。
 *   访客：只有他能打开的分享面板上的人（分享给他的页和它们的祖先、子页上的分享对象与给分享的人、私人页主人）加上自己，看不到成员名单。
 *   两样都不是 404（不泄露存在性）。
 * GET    /api/spaces/:id/guests → { membersInvite, guests: [{ userId, username, pages: [{ id, title, level }], privateCount }] }：空间 owner。
 *   公共区的页给标题；私人区的页只计数（owner 也看不到别人的私人区）。
 * PATCH  /api/spaces/:id/guests { membersInvite } → 同 GET：成员能不能把页分享给空间外的人（owner 一直能）。
 * DELETE /api/spaces/:id/guests/:userId → 同 GET：删他在这个空间收到的全部分享（含私人区里的）；是成员 400（到成员里移除），没有分享 404。
 * owner 以外：成员 403，非成员 404。每条路由自带 requireAuth（路径限定），挂载顺序无影响。 */

import { Hono, type Context } from 'hono'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv } from '../auth.js'
import { SELECT_SUBTREE_ALL } from '../page-trash.js'
import { roleInSpace } from './pages.js'
import { DELETE_SHARES_IN_SPACE } from './spaces.js'

type Person = { id: string; username: string; avatar: string | null }
type GuestPage = { id: string; title: string; level: 'edit' | 'view' }
export type SpaceGuest = { userId: string; username: string; pages: GuestPage[]; privateCount: number }

const SELECT_SPACE = 'SELECT owner_id, members_invite_guests FROM spaces WHERE id = $1'
// 他在这个空间里有没有分享（活页）：有就是访客
const IS_GUEST = `SELECT 1 FROM page_shares s JOIN live_pages p ON p.id = s.page_id WHERE s.user_id = $2 AND p.space_id = $1 LIMIT 1`
// 成员看到的：成员 + 本空间的访客
const SELECT_PEOPLE_FOR_MEMBER = `SELECT u.id, u.username, u.avatar_file_id AS avatar FROM users u
  WHERE u.id IN (SELECT m.user_id FROM space_members m WHERE m.space_id = $1
    UNION SELECT s.user_id FROM page_shares s JOIN live_pages p ON p.id = s.page_id WHERE p.space_id = $1)
  ORDER BY u.username, u.id`
// 访客看到的：分享给他的页（连同子页）与这些分享根的祖先，这些页上的分享对象、给分享的人、私人页主人，再加他自己
const SELECT_PEOPLE_FOR_GUEST = `WITH RECURSIVE mine AS (
    SELECT p.id, p.parent_id, 0 AS n FROM page_shares s JOIN pages p ON p.id = s.page_id WHERE s.user_id = $2 AND p.space_id = $1
    UNION ALL SELECT a.id, a.parent_id, mine.n + 1 FROM pages a JOIN mine ON a.id = mine.parent_id WHERE mine.n < 64
  ), seen AS (
    SELECT id FROM mine
    UNION SELECT r.shared_id FROM page_share_reach($2) r JOIN pages p ON p.id = r.shared_id WHERE p.space_id = $1
  )
  SELECT u.id, u.username, u.avatar_file_id AS avatar FROM users u WHERE u.id = $2 OR u.id IN (
    SELECT s.user_id FROM page_shares s WHERE s.page_id IN (SELECT id FROM seen)
    UNION SELECT s.granted_by FROM page_shares s WHERE s.page_id IN (SELECT id FROM seen)
    UNION SELECT p.private_owner FROM pages p WHERE p.id IN (SELECT id FROM seen))
  ORDER BY u.username, u.id`
// 本空间的访客分享：对象不是成员；回收站里的页不算
const SELECT_GUEST_SHARES = `SELECT s.user_id, u.username, p.id, p.title, s.level, p.private_owner IS NOT NULL AS private
  FROM page_shares s JOIN live_pages p ON p.id = s.page_id JOIN users u ON u.id = s.user_id
  WHERE p.space_id = $1 AND NOT EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = $1 AND m.user_id = s.user_id)
  ORDER BY u.username, s.user_id, p.title, p.id`
const SET_POLICY = 'UPDATE spaces SET members_invite_guests = $2 WHERE id = $1'

export type SpaceGuestsDeps = {
  pool: Pool
  notify?: () => void
  poke?: () => void
  dropAccess?: (pageIds: string[]) => void
}

export function spaceGuestRoutes({ pool, notify, poke, dropAccess }: SpaceGuestsDeps) {
  const app = new Hono<AuthEnv>()
  const auth = requireAuth(pool)

  /** 空间 owner 的闸：成员 403，非成员 / 不存在 404 */
  async function ownerGate(c: Context<AuthEnv>): Promise<{ id: string; membersInvite: boolean } | Response> {
    const user = c.get('user')
    const id = c.req.param('id') ?? ''
    const space = (await pool.query<{ owner_id: string; members_invite_guests: boolean }>(SELECT_SPACE, [id])).rows[0]
    if (space && space.owner_id === user.id) return { id, membersInvite: space.members_invite_guests }
    if (space && (await roleInSpace(pool, user, id)) !== null) return c.json({ error: 'forbidden' }, 403)
    return c.json({ error: 'space not found' }, 404)
  }

  app.get('/api/spaces/:id/people', auth, async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    c.header('cache-control', 'no-store')
    if ((await roleInSpace(pool, user, id)) !== null) {
      return c.json({ people: (await pool.query<Person>(SELECT_PEOPLE_FOR_MEMBER, [id])).rows })
    }
    if (!(await pool.query(IS_GUEST, [id, user.id])).rowCount) return c.json({ error: 'space not found' }, 404)
    return c.json({ people: (await pool.query<Person>(SELECT_PEOPLE_FOR_GUEST, [id, user.id])).rows })
  })

  app.get('/api/spaces/:id/guests', auth, async (c) => {
    const gate = await ownerGate(c)
    if (gate instanceof Response) return gate
    const rows = (
      await pool.query<{ user_id: string; username: string; id: string; title: string; level: 'edit' | 'view'; private: boolean }>(SELECT_GUEST_SHARES, [gate.id])
    ).rows
    const guests = new Map<string, SpaceGuest>()
    for (const r of rows) {
      const g = guests.get(r.user_id) ?? { userId: r.user_id, username: r.username, pages: [], privateCount: 0 }
      if (r.private) g.privateCount += 1
      else g.pages.push({ id: r.id, title: r.title, level: r.level })
      guests.set(r.user_id, g)
    }
    c.header('cache-control', 'no-store')
    return c.json({ membersInvite: gate.membersInvite, guests: [...guests.values()] })
  })

  app.patch('/api/spaces/:id/guests', auth, async (c) => {
    const gate = await ownerGate(c)
    if (gate instanceof Response) return gate
    const body = (await c.req.json().catch(() => null)) as { membersInvite?: unknown } | null
    if (typeof body?.membersInvite !== 'boolean') return c.json({ error: 'membersInvite must be a boolean' }, 400)
    await pool.query(SET_POLICY, [gate.id, body.membersInvite])
    return c.json({ membersInvite: body.membersInvite })
  })

  app.delete('/api/spaces/:id/guests/:userId', auth, async (c) => {
    const gate = await ownerGate(c)
    if (gate instanceof Response) return gate
    const target = c.req.param('userId')
    if ((await roleInSpace(pool, { id: target, role: 'user' }, gate.id)) !== null) return c.json({ error: 'is a member' }, 400)
    const roots = (await pool.query<{ page_id: string }>(DELETE_SHARES_IN_SPACE, [gate.id, target])).rows.map((r) => r.page_id)
    if (roots.length === 0) return c.json({ error: 'guest not found' }, 404)
    notify?.()
    poke?.()
    dropAccess?.((await pool.query<{ id: string }>(SELECT_SUBTREE_ALL, [roots])).rows.map((r) => r.id))
    return c.json({})
  })

  return app
}
