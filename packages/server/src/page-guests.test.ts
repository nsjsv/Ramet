// 访客（分享给空间外的人；routes/page-shares.ts、routes/space-guests.ts、page-visibility.ts、agents/guest-gate.ts）：
//   按用户名邀请；访客只看得到分享的页和子页；可编辑的访客能改、能在里面建子页，出不了分享的范围；不能再分享，能退出；
//   「成员可以邀请访客」开关；owner 的访客列表（私人页只计数）与移出；访客不能用 AI；人员目录；同步指纹。
import { describe, expect, it } from 'vitest'
import { base, insertUser, login, pool, postJson } from './agents/test-kit.js'
import { GUEST_NO_AI } from './agents/guest-gate.js'
import { GUESTS_OWNER_ONLY } from './routes/page-shares.js'

type Person = { id: string; cookie: string }

async function person(name: string): Promise<Person> {
  const id = await insertUser(name, 'user')
  return { id, cookie: await login(name) }
}

async function call(who: Person, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: who.cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function newPage(who: Person, body: Record<string, unknown>): Promise<string> {
  const res = await postJson('/api/pages', who.cookie, body)
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: string }).id
}

const listIds = async (who: Person): Promise<string[]> => ((await (await call(who, 'GET', '/api/pages')).json()) as Array<{ id: string }>).map((p) => p.id)
const invite = (who: Person, pageId: string, username: string, level: 'edit' | 'view') => call(who, 'POST', `/api/pages/${pageId}/shares`, { username, level })

/** alice 的团队空间，bob 是 member；gina、gus 不在空间里。alice 有一页公共页（带子页）和一页别的公共页，bob 有一页私人页 */
async function world() {
  const alice = await person('alice')
  const bob = await person('bob')
  const gina = await person('gina')
  const gus = await person('gus')
  const space = ((await (await postJson('/api/spaces', alice.cookie, { name: '团队' })).json()) as { id: string }).id
  await pool.query("INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'member')", [space, bob.id])
  const pub = await newPage(alice, { space_id: space, title: '对外的方案' })
  const pubChild = await newPage(alice, { space_id: space, parent_id: pub, title: '方案附录' })
  const other = await newPage(alice, { space_id: space, title: '内部周报' })
  const secret = await newPage(bob, { space_id: space, private: true, title: 'bob 的草稿' })
  return { alice, bob, gina, gus, space, pub, pubChild, other, secret }
}

describe('访客能看到什么', () => {
  it('按用户名邀请：只看得到分享的页和子页，别的页 404、搜索不到；面板标访客；作为访客进得去的空间', async () => {
    const w = await world()
    expect((await invite(w.bob, w.pub, 'nobody', 'view')).status).toBe(400)
    const res = await invite(w.bob, w.pub, 'gina', 'view')
    expect(res.status).toBe(200)
    const view = (await res.json()) as { shares: Array<{ userId: string; guest: boolean }> }
    expect(view.shares).toEqual([expect.objectContaining({ userId: w.gina.id, guest: true })])
    const ids = await listIds(w.gina)
    expect(ids).toEqual(expect.arrayContaining([w.pub, w.pubChild]))
    expect(ids).not.toContain(w.other)
    expect((await call(w.gina, 'GET', `/api/pages/${w.other}`)).status).toBe(404)
    const hits = (await (await call(w.gina, 'GET', `/api/search?q=${encodeURIComponent('周报')}`)).json()) as Array<{ id: string }>
    expect(hits.map((h) => h.id)).not.toContain(w.other)
    const mine = (await (await call(w.gina, 'GET', '/api/me/shares')).json()) as { shares: Array<{ spaceId: string }>; guestSpaces: Array<{ id: string; name: string }> }
    expect(mine.shares[0]?.spaceId).toBe(w.space)
    expect(mine.guestSpaces).toEqual([{ id: w.space, name: '团队' }])
    // 成员自己不算进「作为访客」
    await invite(w.alice, w.other, 'bob', 'view')
    const bobs = (await (await call(w.bob, 'GET', '/api/me/shares')).json()) as { guestSpaces: unknown[] }
    expect(bobs.guestSpaces).toEqual([])
  })

  it('人员目录：访客只认识分享面板上的人；成员认识成员和访客；都不是 404', async () => {
    const w = await world()
    await invite(w.bob, w.pub, 'gina', 'view')
    const names = async (who: Person) => {
      const res = await call(who, 'GET', `/api/spaces/${w.space}/people`)
      return res.status === 200 ? ((await res.json()) as { people: Array<{ username: string }> }).people.map((p) => p.username).sort() : res.status
    }
    expect(await names(w.gina)).toEqual(['bob', 'gina'])
    expect(await names(w.alice)).toEqual(['alice', 'bob', 'gina'])
    expect(await names(w.gus)).toBe(404)
  })
})

describe('访客能做什么', () => {
  it('可编辑：改正文、在里面建子页；建顶层、挪到顶层、挪到看不到的页下都不行；只读的访客写不了', async () => {
    const w = await world()
    await invite(w.bob, w.pub, 'gina', 'edit')
    await invite(w.bob, w.other, 'gus', 'view')
    expect((await call(w.gina, 'PATCH', `/api/pages/${w.pubChild}`, { title: '附录 v2' })).status).toBe(200)
    const kid = await newPage(w.gina, { space_id: w.space, parent_id: w.pub, title: '访客建的' })
    expect(await listIds(w.alice)).toContain(kid)
    // 没给空间也跟父页
    await newPage(w.gina, { parent_id: w.pubChild })
    expect((await postJson('/api/pages', w.gina.cookie, { space_id: w.space, title: '顶层' })).status).toBe(400)
    expect((await call(w.gina, 'PATCH', `/api/pages/${kid}`, { parent_id: null })).status).toBe(400)
    expect((await call(w.gina, 'PATCH', `/api/pages/${kid}`, { parent_id: w.other })).status).toBe(400)
    expect((await call(w.gus, 'PATCH', `/api/pages/${w.other}`, { title: 'x' })).status).toBe(403)
    expect((await postJson('/api/pages', w.gus.cookie, { space_id: w.space, parent_id: w.other })).status).toBe(400)
  })

  it('访客不能再分享出去、改不了别人的档位，能把自己移除', async () => {
    const w = await world()
    await invite(w.bob, w.pub, 'gina', 'edit')
    await invite(w.bob, w.pub, 'gus', 'view')
    expect((await invite(w.gina, w.pub, 'alice', 'view')).status).toBe(403)
    expect((await call(w.gina, 'PUT', `/api/pages/${w.pub}/shares/${w.gus.id}`, { level: 'edit' })).status).toBe(403)
    expect((await call(w.gina, 'DELETE', `/api/pages/${w.pub}/shares/${w.gus.id}`)).status).toBe(403)
    expect((await call(w.gina, 'DELETE', `/api/pages/${w.pub}/shares/${w.gina.id}`)).status).toBe(200)
    expect(await listIds(w.gina)).not.toContain(w.pub)
  })

  it('访客在宿主空间的页上不能用 AI', async () => {
    const w = await world()
    await invite(w.bob, w.pub, 'gina', 'edit')
    const res = await postJson(`/api/pages/${w.pub}/continue`, w.gina.cookie, { agent: 'fake' })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { message: string }).message).toBe(GUEST_NO_AI)
    const member = await postJson(`/api/pages/${w.pub}/continue`, w.bob.cookie, { agent: 'fake' })
    expect(((await member.json().catch(() => ({}))) as { message?: string }).message).not.toBe(GUEST_NO_AI)
  })
})

describe('空间 owner 的管控', () => {
  it('关掉「成员可以邀请访客」：成员邀请访客 403、成员之间照常，owner 照样能；只有 owner 能改开关', async () => {
    const w = await world()
    expect((await call(w.bob, 'PATCH', `/api/spaces/${w.space}/guests`, { membersInvite: false })).status).toBe(403)
    expect((await call(w.gina, 'PATCH', `/api/spaces/${w.space}/guests`, { membersInvite: false })).status).toBe(404)
    expect((await call(w.alice, 'PATCH', `/api/spaces/${w.space}/guests`, { membersInvite: false })).status).toBe(200)
    const denied = await invite(w.bob, w.pub, 'gina', 'view')
    expect(denied.status).toBe(403)
    expect(((await denied.json()) as { error: string }).error).toBe(GUESTS_OWNER_ONLY)
    expect((await invite(w.bob, w.pub, 'alice', 'view')).status).toBe(200)
    expect((await invite(w.alice, w.pub, 'gina', 'view')).status).toBe(200)
  })

  it('访客列表：公共区的页给标题，私人区只计数；移出空间删他的全部分享；成员不能在这里移除', async () => {
    const w = await world()
    await invite(w.bob, w.pub, 'gina', 'edit')
    await invite(w.bob, w.secret, 'gina', 'view')
    expect((await call(w.bob, 'GET', `/api/spaces/${w.space}/guests`)).status).toBe(403)
    const list = (await (await call(w.alice, 'GET', `/api/spaces/${w.space}/guests`)).json()) as {
      membersInvite: boolean
      guests: Array<{ userId: string; username: string; pages: Array<{ id: string; title: string; level: string }>; privateCount: number }>
    }
    expect(list.membersInvite).toBe(true)
    expect(list.guests).toEqual([{ userId: w.gina.id, username: 'gina', pages: [{ id: w.pub, title: '对外的方案', level: 'edit' }], privateCount: 1 }])
    expect(JSON.stringify(list)).not.toContain('bob 的草稿')
    expect((await call(w.alice, 'DELETE', `/api/spaces/${w.space}/guests/${w.bob.id}`)).status).toBe(400)
    expect((await call(w.alice, 'DELETE', `/api/spaces/${w.space}/guests/${w.gina.id}`)).status).toBe(200)
    expect(await listIds(w.gina)).not.toContain(w.pub)
    expect(await listIds(w.gina)).not.toContain(w.secret)
    expect((await call(w.alice, 'DELETE', `/api/spaces/${w.space}/guests/${w.gina.id}`)).status).toBe(404)
  })
})

it('同步指纹：分享给访客 / 子树挪进分享范围 / 收回，访客整表', async () => {
  const w = await world()
  const sync = async (mark?: { cursor: string; members: string }) =>
    (await (await call(w.gina, 'GET', mark ? `/api/pages/sync?since=${mark.cursor}&members=${mark.members}` : '/api/pages/sync')).json()) as {
      cursor: string
      members: string
      full?: Array<{ id: string }>
      changed?: Array<{ id: string }>
    }
  let mark = await sync()
  await invite(w.bob, w.pub, 'gina', 'view')
  let res = await sync(mark)
  expect(res.full?.map((p) => p.id)).toEqual(expect.arrayContaining([w.pub, w.pubChild]))
  mark = res
  // alice 把一棵公共树挪到分享的根下面：挪的那页有日志，它的子页没有，只能整表
  const tree = await newPage(w.alice, { space_id: w.space, title: '另一棵' })
  const leaf = await newPage(w.alice, { space_id: w.space, parent_id: tree, title: '另一棵的叶子' })
  mark = await sync(mark)
  expect((await call(w.alice, 'PATCH', `/api/pages/${tree}`, { parent_id: w.pub })).status).toBe(200)
  res = await sync(mark)
  expect(res.full?.map((p) => p.id)).toEqual(expect.arrayContaining([tree, leaf]))
  mark = res
  expect((await call(w.bob, 'DELETE', `/api/pages/${w.pub}/shares/${w.gina.id}`)).status).toBe(200)
  res = await sync(mark)
  expect(res.full).toBeDefined()
  expect(res.full?.map((p) => p.id)).not.toContain(w.pub)
})
