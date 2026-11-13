// 页面可见性的唯一出口（page-visibility.ts）：函数与 SQL 片段在各种人、各种页上的结果。
// 规则：公共区的页给页面所在空间的成员（任意角色），私人区的页只给它的主人（仍得是成员）；全局 admin、空间 owner 都不例外；
// 回收站由调用方选 live_pages / pages 决定；space_id 为空的遗留孤儿页谁都看不到。
// 此外这页或祖先单独分享给了谁（仍得是成员），谁就看得到，角色在区给的与分享给的之间取最宽。
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closePool, getPool, initDb } from './db.js'
import {
  changeVisibleSql,
  pageAccess,
  pageAccessJoin,
  pageRole,
  pageRoleSql,
  pageViewersJoin,
  pageVisibleSql,
  viewersAmong,
  visiblePages,
} from './page-visibility.js'
import { truncateAll } from './test-helpers.js'

if (!process.env.DATABASE_URL) throw new Error('需要 DATABASE_URL 指向测试库')

const pool = getPool()
await initDb(pool)

afterAll(async () => {
  await closePool()
})

type Who = { id: string; role: string }
let owner: Who, member: Who, viewer: Who, outsider: Who, admin: Who
let spaceA = '', spaceB = ''
let live = '', trashed = '', other = '', orphan = '', mine = ''

async function user(name: string, role = 'user'): Promise<Who> {
  const id = crypto.randomUUID()
  await pool.query('INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)', [id, name, 'x', role])
  return { id, role }
}

async function space(ownerId: string): Promise<string> {
  const id = crypto.randomUUID()
  await pool.query('INSERT INTO spaces (id, name, owner_id, is_personal) VALUES ($1, $2, $3, false)', [id, `s-${id.slice(0, 4)}`, ownerId])
  await pool.query("INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'owner')", [id, ownerId])
  return id
}

async function page(spaceId: string | null, ownerId: string, deleted = false, privateOwner: string | null = null): Promise<string> {
  const id = crypto.randomUUID()
  await pool.query('INSERT INTO pages (id, parent_id, owner_id, space_id, in_page_tree, private_owner) VALUES ($1, NULL, $2, $3, true, $4)', [
    id,
    ownerId,
    spaceId,
    privateOwner,
  ])
  if (deleted) await pool.query('UPDATE pages SET deleted_at = now()::text WHERE id = $1', [id])
  return id
}

beforeEach(async () => {
  await truncateAll(pool)
  owner = await user('owner')
  member = await user('member')
  viewer = await user('viewer')
  outsider = await user('outsider')
  admin = await user('admin', 'admin')
  spaceA = await space(owner.id)
  spaceB = await space(outsider.id)
  await pool.query("INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [spaceA, member.id, viewer.id])
  live = await page(spaceA, owner.id)
  trashed = await page(spaceA, owner.id, true)
  other = await page(spaceB, outsider.id)
  orphan = await page(null, owner.id)
  // member 的私人页：空间 owner（owner）、viewer、全局 admin 都看不到
  mine = await page(spaceA, member.id, false, member.id)
})

describe('单页', () => {
  it('pageAccess：活页按空间角色；回收站、别的空间、孤儿页、不存在都是 null；admin 不例外', async () => {
    expect(await pageAccess(pool, live, owner)).toBe('owner')
    expect(await pageAccess(pool, live, member)).toBe('member')
    expect(await pageAccess(pool, live, viewer)).toBe('viewer')
    expect(await pageAccess(pool, live, outsider)).toBeNull()
    expect(await pageAccess(pool, live, admin)).toBeNull()
    expect(await pageAccess(pool, trashed, owner)).toBeNull()
    expect(await pageAccess(pool, other, member)).toBeNull()
    expect(await pageAccess(pool, orphan, owner)).toBeNull()
    expect(await pageAccess(pool, crypto.randomUUID(), owner)).toBeNull()
  })

  it('pageRole：按页面行判，回收站里的页也给角色（恢复、永久删除要用）', async () => {
    expect(await pageRole(pool, owner, { id: trashed })).toBe('owner')
    expect(await pageRole(pool, viewer, { id: trashed })).toBe('viewer')
    expect(await pageRole(pool, outsider, { id: trashed })).toBeNull()
    expect(await pageRole(pool, member, { id: live })).toBe('member')
    expect(await pageRole(pool, owner, { id: orphan })).toBeNull()
  })
})

describe('批量与收件人', () => {
  it('visiblePages：只给看得见的活页', async () => {
    const seen = await visiblePages(pool, member, [live, trashed, other, orphan, crypto.randomUUID()])
    expect([...seen.keys()]).toEqual([live])
    expect(seen.get(live)?.space_id).toBe(spaceA)
  })

  it('viewersAmong：候选人里看得到这页的', async () => {
    const all = [owner.id, member.id, viewer.id, outsider.id, admin.id]
    expect((await viewersAmong(pool, live, all)).sort()).toEqual([owner.id, member.id, viewer.id].sort())
    expect(await viewersAmong(pool, other, all)).toEqual([outsider.id])
    expect(await viewersAmong(pool, orphan, all)).toEqual([])
    expect(await viewersAmong(pool, live, [])).toEqual([])
  })
})

describe('SQL 片段', () => {
  it('pageRoleSql / pageVisibleSql', async () => {
    const role = async (who: Who, id: string) =>
      (await pool.query<{ role: string | null }>(`SELECT ${pageRoleSql('p', '$1')} AS role FROM pages p WHERE p.id = $2`, [who.id, id])).rows[0]?.role ?? null
    expect(await role(viewer, live)).toBe('viewer')
    expect(await role(outsider, live)).toBeNull()
    const visible = async (who: Who) =>
      (await pool.query<{ id: string }>(`SELECT p.id FROM pages p WHERE ${pageVisibleSql('p', '$1')} ORDER BY p.id`, [who.id])).rows.map((r) => r.id)
    expect(await visible(member)).toEqual([live, trashed, mine].sort())
    expect(await visible(owner)).toEqual([live, trashed].sort())
    expect(await visible(outsider)).toEqual([other])
    expect(await visible(admin)).toEqual([])
  })

  it('pageAccessJoin：只留看得到的页并带出角色', async () => {
    const { rows } = await pool.query<{ id: string; role: string }>(
      `SELECT p.id, m.role FROM live_pages p ${pageAccessJoin('p', '$1', 'm')} WHERE p.id = ANY($2::text[])`,
      [viewer.id, [live, trashed, other, orphan]],
    )
    expect(rows).toEqual([{ id: live, role: 'viewer' }])
  })

  it('pageViewersJoin：看得到这页的每个人一行', async () => {
    const { rows } = await pool.query<{ user_id: string; role: string }>(
      `SELECT m.user_id, m.role FROM pages p ${pageViewersJoin('p', 'm')} WHERE p.id = $1 ORDER BY m.role`,
      [live],
    )
    expect(rows.map((r) => [r.user_id, r.role])).toEqual(
      [
        [member.id, 'member'],
        [owner.id, 'owner'],
        [viewer.id, 'viewer'],
      ],
    )
    const none = await pool.query(`SELECT m.user_id FROM pages p ${pageViewersJoin('p', 'm')} WHERE p.id = $1`, [orphan])
    expect(none.rowCount).toBe(0)
  })

  it('changeVisibleSql：变更日志只给页面所在空间的成员', async () => {
    const ids = async (who: Who) =>
      (await pool.query<{ page_id: string }>(`SELECT DISTINCT c.page_id FROM page_changes c WHERE ${changeVisibleSql('c', '$1')} ORDER BY c.page_id`, [who.id])).rows.map(
        (r) => r.page_id,
      )
    expect(await ids(viewer)).toEqual([live, trashed].sort())
    expect(await ids(member)).toEqual([live, trashed, mine].sort())
    expect(await ids(outsider)).toEqual([other])
    expect(await ids(admin)).toEqual([])
  })
})

describe('私人区', () => {
  it('单页与批量：只有主人看得到，空间 owner 与全局 admin 也不例外', async () => {
    expect(await pageAccess(pool, mine, member)).toBe('member')
    for (const who of [owner, viewer, outsider, admin]) expect(await pageAccess(pool, mine, who)).toBeNull()
    expect(await pageRole(pool, owner, { id: mine })).toBeNull()
    expect([...(await visiblePages(pool, owner, [mine, live])).keys()]).toEqual([live])
    expect([...(await visiblePages(pool, member, [mine, live])).keys()].sort()).toEqual([mine, live].sort())
  })

  it('主人被移出空间：谁都看不到；回来又看得到', async () => {
    await pool.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [spaceA, member.id])
    expect(await pageAccess(pool, mine, member)).toBeNull()
    await pool.query("INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'member')", [spaceA, member.id])
    expect(await pageAccess(pool, mine, member)).toBe('member')
  })

  it('收件人与片段：看得到的只有主人', async () => {
    expect(await viewersAmong(pool, mine, [owner.id, member.id, viewer.id, admin.id])).toEqual([member.id])
    const { rows } = await pool.query<{ user_id: string }>(`SELECT m.user_id FROM pages p ${pageViewersJoin('p', 'm')} WHERE p.id = $1`, [mine])
    expect(rows.map((r) => r.user_id)).toEqual([member.id])
    const joined = await pool.query(`SELECT p.id FROM live_pages p ${pageAccessJoin('p', '$1', 'm')} WHERE p.id = $2`, [owner.id, mine])
    expect(joined.rowCount).toBe(0)
  })

  it('变更日志：私人页的变更只给主人；挪进私人区那一刻，旧区（公共）的那一条成员照样收到', async () => {
    const ids = async (who: Who) =>
      (await pool.query<{ page_id: string }>(`SELECT DISTINCT c.page_id FROM page_changes c WHERE ${changeVisibleSql('c', '$1')}`, [who.id])).rows.map((r) => r.page_id)
    expect(await ids(owner)).not.toContain(mine)
    expect(await ids(member)).toContain(mine)
    await pool.query('UPDATE pages SET private_owner = $1 WHERE id = $2', [member.id, live])
    expect(await ids(owner)).toContain(live)
    const rows = await pool.query<{ private_owner: string | null }>('SELECT private_owner FROM page_changes WHERE page_id = $1 ORDER BY xid', [live])
    expect(rows.rows.map((r) => r.private_owner)).toEqual(expect.arrayContaining([null, member.id]))
  })
})


describe('单页分享', () => {
  let kid = ''
  const share = (pageId: string, who: Who, level: 'edit' | 'view') =>
    pool.query(
      'INSERT INTO page_shares (page_id, user_id, level) VALUES ($1, $2, $3) ON CONFLICT (page_id, user_id) DO UPDATE SET level = EXCLUDED.level',
      [pageId, who.id, level],
    )

  beforeEach(async () => {
    kid = crypto.randomUUID()
    await pool.query('INSERT INTO pages (id, parent_id, owner_id, space_id, in_page_tree) VALUES ($1, $2, $3, $4, true)', [kid, mine, member.id, spaceA])
  })

  it('私人页分享给只读成员：本页与子页都是 viewer；空间 owner 拿到的也只是分享的那一档', async () => {
    await share(mine, viewer, 'view')
    expect(await pageAccess(pool, mine, viewer)).toBe('viewer')
    expect(await pageAccess(pool, kid, viewer)).toBe('viewer')
    expect(await pageAccess(pool, mine, owner)).toBeNull()
    await share(mine, owner, 'view')
    expect(await pageAccess(pool, kid, owner)).toBe('viewer')
    await share(mine, owner, 'edit')
    expect(await pageAccess(pool, mine, owner)).toBe('member')
    expect([...(await visiblePages(pool, viewer, [mine, kid, live])).keys()].sort()).toEqual([mine, kid, live].sort())
  })

  it('只分享子页：父页仍看不到', async () => {
    await share(kid, viewer, 'edit')
    expect(await pageAccess(pool, kid, viewer)).toBe('member')
    expect(await pageAccess(pool, mine, viewer)).toBeNull()
  })

  it('可编辑分享把只读成员升到 member，只限这一页和子页；不会把 owner 降级', async () => {
    const sub = crypto.randomUUID()
    await pool.query('INSERT INTO pages (id, parent_id, owner_id, space_id, in_page_tree) VALUES ($1, $2, $3, $4, true)', [sub, live, owner.id, spaceA])
    const sibling = await page(spaceA, owner.id)
    await share(live, viewer, 'edit')
    await share(live, owner, 'view')
    expect(await pageAccess(pool, live, viewer)).toBe('member')
    expect(await pageAccess(pool, sub, viewer)).toBe('member')
    expect(await pageAccess(pool, sibling, viewer)).toBe('viewer')
    expect(await pageAccess(pool, live, owner)).toBe('owner')
  })

  it('不是成员的人（访客）：分享即权限，只有分享给的那一档，空间里别的页仍看不到', async () => {
    expect(await pageAccess(pool, mine, outsider)).toBeNull()
    await share(mine, outsider, 'edit')
    expect(await pageAccess(pool, mine, outsider)).toBe('member')
    expect(await pageAccess(pool, kid, outsider)).toBe('member')
    expect(await pageAccess(pool, live, outsider)).toBeNull()
    expect(await viewersAmong(pool, kid, [outsider.id])).toEqual([outsider.id])
    await share(live, outsider, 'view')
    expect(await pageAccess(pool, live, outsider)).toBe('viewer')
    expect([...(await visiblePages(pool, outsider, [mine, kid, live])).keys()].sort()).toEqual([mine, kid, live].sort())
  })

  it('收件人与片段：分享对象在列，按人取最宽', async () => {
    await share(mine, viewer, 'view')
    await share(live, viewer, 'edit')
    expect((await viewersAmong(pool, kid, [owner.id, member.id, viewer.id])).sort()).toEqual([member.id, viewer.id].sort())
    const roles = async (id: string) =>
      (await pool.query<{ user_id: string; role: string }>(`SELECT m.user_id, m.role FROM pages p ${pageViewersJoin('p', 'm')} WHERE p.id = $1`, [id])).rows
        .map((r) => [r.user_id, r.role])
        .sort()
    expect(await roles(kid)).toEqual(
      [
        [member.id, 'member'],
        [viewer.id, 'viewer'],
      ].sort(),
    )
    expect(await roles(live)).toEqual(
      [
        [member.id, 'member'],
        [owner.id, 'owner'],
        [viewer.id, 'member'],
      ].sort(),
    )
    const joined = await pool.query<{ id: string; role: string }>(
      `SELECT p.id, m.role FROM live_pages p ${pageAccessJoin('p', '$1', 'm')} WHERE p.id = ANY($2::text[]) ORDER BY p.id`,
      [viewer.id, [mine, kid, other]],
    )
    expect(joined.rows).toEqual(
      [
        { id: mine, role: 'viewer' },
        { id: kid, role: 'viewer' },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    )
    const visible = await pool.query<{ id: string }>(`SELECT p.id FROM live_pages p WHERE ${pageVisibleSql('p', '$1')} AND p.space_id = $2`, [viewer.id, spaceA])
    expect(visible.rows.map((r) => r.id).sort()).toEqual([live, mine, kid].sort())
  })

  it('变更日志：分享给他的页的变更他收得到', async () => {
    const ids = async (who: Who) =>
      (await pool.query<{ page_id: string }>(`SELECT DISTINCT c.page_id FROM page_changes c WHERE ${changeVisibleSql('c', '$1')}`, [who.id])).rows.map((r) => r.page_id)
    expect(await ids(viewer)).not.toContain(kid)
    await share(mine, viewer, 'view')
    expect(await ids(viewer)).toEqual(expect.arrayContaining([mine, kid]))
    expect(await ids(owner)).not.toContain(kid)
  })
})
