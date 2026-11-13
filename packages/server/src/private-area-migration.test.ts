// 私人区的存量迁移（page-area-schema.ts 的 PAGE_AREA_MIGRATION），只跑一次：
//   注册时得到的空间没有别的成员 → 除 skill 页外全部进主人私人区（子页、回收站里的一起）；
//   有别的成员 → 只有主人的 Genet 页（连任务页）进他的私人区；其它空间不动；
//   之后主人把页挪回公共区，重启不会再被收回去。
import { afterAll, beforeEach, expect, it } from 'vitest'
import { closePool, getPool, initDb } from './db.js'
import { truncateAll } from './test-helpers.js'

if (!process.env.DATABASE_URL) throw new Error('需要 DATABASE_URL 指向测试库')

const pool = getPool()
await initDb(pool)

beforeEach(async () => {
  await truncateAll(pool)
  await pool.query('DROP TABLE IF EXISTS private_area_once')
})

afterAll(async () => {
  await closePool()
})

async function user(name: string): Promise<string> {
  const id = crypto.randomUUID()
  await pool.query("INSERT INTO users (id, username, password, role) VALUES ($1, $2, 'x', 'user')", [id, name])
  return id
}

async function space(ownerId: string, personal: boolean, members: string[] = []): Promise<string> {
  const id = crypto.randomUUID()
  await pool.query('INSERT INTO spaces (id, name, owner_id, is_personal) VALUES ($1, $2, $3, $4)', [id, `s-${id.slice(0, 4)}`, ownerId, personal])
  await pool.query("INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'owner')", [id, ownerId])
  for (const m of members) await pool.query("INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'member')", [id, m])
  return id
}

async function page(spaceId: string, ownerId: string, opts: { parent?: string; kind?: string; trashed?: boolean } = {}): Promise<string> {
  const id = crypto.randomUUID()
  await pool.query('INSERT INTO pages (id, parent_id, owner_id, space_id, kind, in_page_tree) VALUES ($1, $2, $3, $4, $5, true)', [
    id,
    opts.parent ?? null,
    ownerId,
    spaceId,
    opts.kind ?? 'doc',
  ])
  if (opts.trashed) await pool.query('UPDATE pages SET deleted_at = now()::text WHERE id = $1', [id])
  return id
}

const areaOf = async (id: string): Promise<string | null> =>
  (await pool.query<{ private_owner: string | null }>('SELECT private_owner FROM pages WHERE id = $1', [id])).rows[0]?.private_owner ?? null

it('三种空间各按规则收进私人区；再启动一次不变；挪回公共的不会被再收回去', async () => {
  const solo = await user('solo')
  const host = await user('host')
  const guest = await user('guest')
  const soloSpace = await space(solo, true)
  const sharedSpace = await space(host, true, [guest])
  const team = await space(solo, false, [host])

  const note = await page(soloSpace, solo)
  const noteChild = await page(soloSpace, solo, { parent: note })
  const binned = await page(soloSpace, solo, { trashed: true })
  const skill = await page(soloSpace, solo, { kind: 'skill' })

  const genet = await page(sharedSpace, host)
  const task = await page(sharedSpace, host, { parent: genet })
  await pool.query('INSERT INTO assistants (user_id, page_id) VALUES ($1, $2)', [host, genet])
  const sharedNote = await page(sharedSpace, host)

  const teamPage = await page(team, solo)

  await initDb(pool)
  expect(await areaOf(note)).toBe(solo)
  expect(await areaOf(noteChild)).toBe(solo)
  expect(await areaOf(binned)).toBe(solo)
  expect(await areaOf(skill)).toBeNull()
  expect(await areaOf(genet)).toBe(host)
  expect(await areaOf(task)).toBe(host)
  expect(await areaOf(sharedNote)).toBeNull()
  expect(await areaOf(teamPage)).toBeNull()

  // 主人把一页挪回公共区，重启后还是公共的
  await pool.query('UPDATE pages SET private_owner = NULL WHERE id = $1', [note])
  await initDb(pool)
  expect(await areaOf(note)).toBeNull()
  expect(await areaOf(noteChild)).toBeNull()
  expect(await areaOf(binned)).toBe(solo)
})
