// 单页分享（page-share-schema.ts / routes/page-shares.ts / page-visibility.ts 的分享分支）：
//   私人页、公共页都能单独分享给同空间的成员（可编辑 / 只读，子页跟着；空间外的人见 page-guests.test.ts）；接口的权限矩阵；收回即断开协同连接；
//   同步指纹带着分享（给 / 改 / 收回后对方整表）；把公共页挪进私人区清掉这一页上的分享；私人页只有主人能换区；
//   被分享的人收件箱里有一条，打开那一页即看过。
import { describe, expect, it } from 'vitest'
import { base, connectDoc, insertUser, login, pool, postJson, waitFor } from './agents/test-kit.js'
import { AREA_OWNER_ONLY } from './page-area.js'

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
const share = (who: Person, pageId: string, target: Person, level: 'edit' | 'view') => call(who, 'PUT', `/api/pages/${pageId}/shares/${target.id}`, { level })
const rename = (who: Person, pageId: string, title: string) => call(who, 'PATCH', `/api/pages/${pageId}`, { title })
const inboxShares = async (who: Person) =>
  ((await (await call(who, 'GET', '/api/inbox')).json()) as { items: Array<{ type: string; pageId: string; level?: string; actor?: { name: string } | null }> }).items.filter(
    (i) => i.type === 'share',
  )

/** alice 建的团队空间：bob、carol 是 member，vic 是 viewer；dave 不是成员。bob 有一页私人页（带子页），alice 有一页公共页（带子页） */
async function world() {
  const alice = await person('alice')
  const bob = await person('bob')
  const carol = await person('carol')
  const vic = await person('vic')
  const dave = await person('dave')
  const space = ((await (await postJson('/api/spaces', alice.cookie, { name: '团队' })).json()) as { id: string }).id
  for (const p of [bob, carol]) await pool.query("INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'member')", [space, p.id])
  await pool.query("INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'viewer')", [space, vic.id])
  const secret = await newPage(bob, { space_id: space, private: true, title: '方案草稿' })
  const secretChild = await newPage(bob, { space_id: space, parent_id: secret, title: '草稿附录' })
  const pub = await newPage(alice, { space_id: space, title: '公共的周报' })
  const pubChild = await newPage(alice, { space_id: space, parent_id: pub, title: '周报附录' })
  const other = await newPage(alice, { space_id: space, title: '别的公共页' })
  return { alice, bob, carol, vic, dave, space, secret, secretChild, pub, pubChild, other }
}

describe('分享私人页', () => {
  it('只读分享：列表、搜索、协同连接都看得到（含子页），改不了；能评论；没分享给的人看不到', async () => {
    const w = await world()
    expect((await share(w.bob, w.secret, w.carol, 'view')).status).toBe(200)
    expect(await listIds(w.carol)).toEqual(expect.arrayContaining([w.secret, w.secretChild]))
    expect(await listIds(w.alice)).not.toContain(w.secret)
    const hits = (await (await call(w.carol, 'GET', `/api/search?q=${encodeURIComponent('草稿附录')}`)).json()) as Array<{ id: string }>
    expect(hits.map((h) => h.id)).toContain(w.secretChild)
    expect((await rename(w.carol, w.secretChild, '改了')).status).toBe(403)
    const doc = await connectDoc(w.secretChild, w.carol.cookie)
    doc.destroy()
    await pool.query('UPDATE pages SET page_comments = true WHERE id = $1', [w.secret])
    const thread = await postJson(`/api/pages/${w.secret}/comments`, w.carol.cookie, { kind: 'page', body: '看过了' })
    expect(thread.status).toBeLessThan(300)
    expect(await listIds(w.dave)).not.toContain(w.secret)
  })

  it('改成可编辑后能改；收回后在线的连接被断开、重连被拒，列表里摘掉', async () => {
    const w = await world()
    await share(w.bob, w.secret, w.carol, 'view')
    expect((await share(w.bob, w.secret, w.carol, 'edit')).status).toBe(200)
    expect((await rename(w.carol, w.secretChild, '附录 v2')).status).toBe(200)
    const doc = await connectDoc(w.secretChild, w.carol.cookie)
    let refused = false
    doc.on('authenticationFailed', () => {
      refused = true
    })
    expect((await call(w.bob, 'DELETE', `/api/pages/${w.secret}/shares/${w.carol.id}`)).status).toBe(200)
    await waitFor(() => refused)
    doc.destroy()
    expect(await listIds(w.carol)).not.toContain(w.secretChild)
  })

  it('分享面板：直接给的与继承来的；继承的祖先我看不到时不给标题；主人在列', async () => {
    const w = await world()
    await share(w.bob, w.secret, w.alice, 'view')
    await share(w.bob, w.secretChild, w.carol, 'edit')
    const view = (await (await call(w.carol, 'GET', `/api/pages/${w.secretChild}/shares`)).json()) as {
      owner: { id: string } | null
      shares: Array<{ userId: string; level: string; from: null | { id: string; title: string | null } }>
    }
    expect(view.owner?.id).toBe(w.bob.id)
    expect(view.shares).toEqual([
      { userId: w.carol.id, username: 'carol', level: 'edit', guest: false, from: null },
      { userId: w.alice.id, username: 'alice', level: 'view', guest: false, from: { id: w.secret, title: null } },
    ])
    const bobs = (await (await call(w.bob, 'GET', `/api/pages/${w.secretChild}/shares`)).json()) as { shares: Array<{ from: { title: string | null } | null }> }
    expect(bobs.shares[1]?.from?.title).toBe('方案草稿')
    expect((await call(w.dave, 'GET', `/api/pages/${w.secret}/shares`)).status).toBe(404)
  })
})

describe('权限矩阵', () => {
  it('只读的人分享 403、给自己 / 给主人 400、看不到的页 404；被分享的人能把自己移除', async () => {
    const w = await world()
    expect((await share(w.vic, w.pub, w.carol, 'view')).status).toBe(403)
    expect((await share(w.carol, w.pub, w.carol, 'view')).status).toBe(400)
    await share(w.bob, w.secret, w.carol, 'edit')
    expect((await share(w.carol, w.secret, w.bob, 'view')).status).toBe(400)
    expect((await share(w.alice, w.secret, w.carol, 'view')).status).toBe(404)
    expect((await call(w.carol, 'PUT', `/api/pages/${w.pub}/shares/${w.vic.id}`, { level: 'admin' })).status).toBe(400)
    // 可编辑的人能再分享给别人
    expect((await share(w.carol, w.secretChild, w.vic, 'view')).status).toBe(200)
    expect(await listIds(w.vic)).toContain(w.secretChild)
    // 只读的 vic 收不回别人的，但能退出自己的
    expect((await call(w.vic, 'DELETE', `/api/pages/${w.secretChild}/shares/${w.carol.id}`)).status).toBe(403)
    expect((await call(w.vic, 'DELETE', `/api/pages/${w.secret}/shares/${w.carol.id}`)).status).toBe(404)
    expect((await call(w.vic, 'DELETE', `/api/pages/${w.secretChild}/shares/${w.vic.id}`)).status).toBe(200)
    expect(await listIds(w.vic)).not.toContain(w.secretChild)
  })

  it('被移出空间 / 自己退出：他在这个空间收到的分享一并删掉，回来也不恢复', async () => {
    const w = await world()
    await share(w.bob, w.secret, w.carol, 'view')
    await share(w.alice, w.pub, w.vic, 'edit')
    expect((await call(w.alice, 'DELETE', `/api/spaces/${w.space}/members/${w.carol.id}`)).status).toBe(200)
    expect((await call(w.vic, 'DELETE', `/api/spaces/${w.space}/members/${w.vic.id}`)).status).toBe(200)
    expect(await listIds(w.carol)).not.toContain(w.secret)
    expect(await listIds(w.vic)).not.toContain(w.pub)
    expect((await pool.query('SELECT 1 FROM page_shares WHERE user_id = ANY($1::text[])', [[w.carol.id, w.vic.id]])).rowCount).toBe(0)
    await pool.query("INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'member')", [w.space, w.carol.id])
    expect(await listIds(w.carol)).not.toContain(w.secret)
  })

  it('公共页分享给只读成员（可编辑）：这页和子页能改，别的公共页仍只读', async () => {
    const w = await world()
    expect((await rename(w.vic, w.pub, 'x')).status).toBe(403)
    await share(w.alice, w.pub, w.vic, 'edit')
    expect((await rename(w.vic, w.pub, '周报 v2')).status).toBe(200)
    expect((await rename(w.vic, w.pubChild, '附录 v2')).status).toBe(200)
    expect((await rename(w.vic, w.other, 'x')).status).toBe(403)
  })
})

describe('换区', () => {
  it('私人页只有主人能换区：可编辑的分享对象挪不出、也挪不进自己的私人区', async () => {
    const w = await world()
    await share(w.bob, w.secret, w.carol, 'edit')
    const out = await call(w.carol, 'PATCH', `/api/pages/${w.secretChild}`, { parent_id: w.pub })
    expect(out.status).toBe(403)
    expect(((await out.json()) as { error: string }).error).toBe(AREA_OWNER_ONLY)
    expect((await call(w.carol, 'PATCH', `/api/pages/${w.secret}`, { private: true })).status).toBe(403)
    expect(await listIds(w.alice)).not.toContain(w.secretChild)
  })

  it('公共页挪进私人区：清掉这一页上单独给的分享，子页上的保留', async () => {
    const w = await world()
    await share(w.alice, w.pub, w.vic, 'edit')
    await share(w.alice, w.pubChild, w.carol, 'view')
    expect((await call(w.alice, 'PATCH', `/api/pages/${w.pub}`, { private: true })).status).toBe(200)
    const left = (await pool.query<{ page_id: string }>('SELECT page_id FROM page_shares')).rows.map((r) => r.page_id)
    expect(left).toEqual([w.pubChild])
    expect(await listIds(w.vic)).not.toContain(w.pub)
    expect(await listIds(w.carol)).toEqual(expect.arrayContaining([w.pubChild]))
    expect(await listIds(w.carol)).not.toContain(w.pub)
  })
})

describe('同步与收件箱', () => {
  it('同步指纹带着分享：给 / 改档位 / 收回后对方整表；主人把子树挪进分享的范围，对方也整表', async () => {
    const w = await world()
    const sync = async (mark?: { cursor: string; members: string }) =>
      (await (await call(w.carol, 'GET', mark ? `/api/pages/sync?since=${mark.cursor}&members=${mark.members}` : '/api/pages/sync')).json()) as {
        cursor: string
        members: string
        full?: Array<{ id: string }>
      }
    let mark = await sync()
    expect((await sync(mark)).full).toBeUndefined()
    await share(w.bob, w.secret, w.carol, 'view')
    let res = await sync(mark)
    expect(res.full?.map((p) => p.id)).toEqual(expect.arrayContaining([w.secret, w.secretChild]))
    mark = res
    await share(w.bob, w.secret, w.carol, 'edit')
    res = await sync(mark)
    expect(res.full).toBeDefined()
    mark = res
    // bob 把私人区里另一棵树挪到分享的根下面：挪的那页有日志，它的子页没有，只能整表
    const extra = await newPage(w.bob, { space_id: w.space, private: true, title: '另一棵' })
    const extraKid = await newPage(w.bob, { space_id: w.space, parent_id: extra, title: '另一棵的子页' })
    mark = await sync(mark)
    expect((await call(w.bob, 'PATCH', `/api/pages/${extra}`, { parent_id: w.secret })).status).toBe(200)
    res = await sync(mark)
    expect(res.full?.map((p) => p.id)).toEqual(expect.arrayContaining([extra, extraKid]))
    mark = res
    await call(w.bob, 'DELETE', `/api/pages/${w.secret}/shares/${w.carol.id}`)
    res = await sync(mark)
    expect(res.full?.map((p) => p.id)).not.toContain(w.secret)
  })

  it('收件箱：别人分享给我的一条（带档位与分享人），打开那一页后消失；改档位再提醒一次', async () => {
    const w = await world()
    await share(w.bob, w.secret, w.carol, 'view')
    const items = await inboxShares(w.carol)
    expect(items).toEqual([expect.objectContaining({ pageId: w.secret, level: 'view', actor: expect.objectContaining({ name: 'bob' }) })])
    expect(await inboxShares(w.bob)).toEqual([])
    expect((await postJson('/api/inbox/seen', w.carol.cookie, { pageId: w.secret })).status).toBe(200)
    expect(await inboxShares(w.carol)).toEqual([])
    // 同档位再给一次不算新的
    await share(w.bob, w.secret, w.carol, 'view')
    expect(await inboxShares(w.carol)).toEqual([])
    await new Promise((r) => setTimeout(r, 20))
    await share(w.bob, w.secret, w.carol, 'edit')
    expect((await inboxShares(w.carol)).map((i) => i.level)).toEqual(['edit'])
  })

  it('我的分享列表：直接给我的、此刻看得到的', async () => {
    const w = await world()
    await share(w.bob, w.secret, w.carol, 'view')
    await share(w.alice, w.pub, w.carol, 'edit')
    const mine = (await (await call(w.carol, 'GET', '/api/me/shares')).json()) as { shares: Array<{ pageId: string; level: string; by: string | null }> }
    expect(mine.shares.map((s) => [s.pageId, s.level, s.by]).sort()).toEqual(
      [
        [w.secret, 'view', 'bob'],
        [w.pub, 'edit', 'alice'],
      ].sort(),
    )
  })
})
