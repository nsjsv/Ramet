// 空间内的私人区（page-area-schema.ts / page-area.ts / page-visibility.ts）：
//   私人页只有主人看得到（别的成员、空间 owner、全局 admin 都不行），子页恒与父页同区（数据库触发器）；
//   换区的权限（公共 → 私人只有创建人和空间 owner）、挪完断开别人的协同连接、增量里摘掉；
//   私人页由主人发布；清空回收站只清自己看得到的；目录树不收私人页；删号先删私人页；
//   空间 AI 的范围只到公共区；agent 不指定位置时建进发起人的私人区；Genet 页是私人的；顶层排序不碰别人的私人页。
import { describe, expect, it } from 'vitest'
import { ensureAssistantPage } from './agents/assistant-agent.js'
import { SPACE_AI_ID, pageInSpace } from './agents/space-ai.js'
import { base, connectDoc, insertUser, login, pool, postJson, waitFor } from './agents/test-kit.js'
import { CALL_PRIVATE } from './comments/space-ai-call.js'
import { PRIVATE_ONLY_TOP, PRIVATIZE_FORBIDDEN, SKILL_NOT_PRIVATE } from './page-area.js'
import { mintPageToken } from './page-read.js'

type Person = { id: string; cookie: string }

async function person(name: string, role: 'user' | 'admin' = 'user'): Promise<Person> {
  const id = await insertUser(name, role)
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

const areaOf = async (id: string): Promise<string | null> =>
  (await pool.query<{ private_owner: string | null }>('SELECT private_owner FROM pages WHERE id = $1', [id])).rows[0]?.private_owner ?? null

const listIds = async (who: Person): Promise<string[]> => ((await (await call(who, 'GET', '/api/pages')).json()) as Array<{ id: string }>).map((p) => p.id)

/** alice 建的团队空间：bob、carol 是成员，root 是全局 admin 且也是成员；dave 不是成员。bob 建一页私人页（带子页）和一页公共页 */
async function world() {
  const alice = await person('alice')
  const bob = await person('bob')
  const carol = await person('carol')
  const root = await person('root', 'admin')
  const dave = await person('dave')
  const space = ((await (await postJson('/api/spaces', alice.cookie, { name: '团队' })).json()) as { id: string }).id
  for (const p of [bob, carol, root]) await pool.query("INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'member')", [space, p.id])
  const secret = await newPage(bob, { space_id: space, private: true, title: '只给自己看的笔记' })
  const secretChild = await newPage(bob, { space_id: space, parent_id: secret, title: '笔记的子页' })
  const shared = await newPage(bob, { space_id: space, title: '公共的周报' })
  return { alice, bob, carol, root, dave, space, secret, secretChild, shared }
}

describe('谁看得到', () => {
  it('私人页只有主人看得到：别的成员、空间 owner、全局 admin 的列表与搜索里都没有', async () => {
    const w = await world()
    expect(await listIds(w.bob)).toEqual(expect.arrayContaining([w.secret, w.secretChild, w.shared]))
    for (const other of [w.alice, w.carol, w.root]) {
      const ids = await listIds(other)
      expect(ids).toContain(w.shared)
      expect(ids).not.toContain(w.secret)
      expect(ids).not.toContain(w.secretChild)
      const hits = (await (await call(other, 'GET', `/api/search?q=${encodeURIComponent('只给自己看')}`)).json()) as Array<{ id: string }>
      expect(hits).toEqual([])
    }
    const mine = (await (await call(w.bob, 'GET', `/api/search?q=${encodeURIComponent('只给自己看')}`)).json()) as Array<{ id: string }>
    expect(mine.map((h) => h.id)).toEqual([w.secret])
  })

  it('主人被移出空间：私人页谁都看不到；回来后原样出现', async () => {
    const w = await world()
    await pool.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [w.space, w.bob.id])
    for (const who of [w.alice, w.carol, w.root, w.bob]) expect(await listIds(who)).not.toContain(w.secret)
    await pool.query("INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'member')", [w.space, w.bob.id])
    expect(await listIds(w.bob)).toEqual(expect.arrayContaining([w.secret, w.secretChild]))
  })
})

describe('子页恒与父页同区', () => {
  it('建在私人页下、挪到私人页下都跟着变私人；直接改子页的区无效；多层一起传', async () => {
    const w = await world()
    expect(await areaOf(w.secret)).toBe(w.bob.id)
    expect(await areaOf(w.secretChild)).toBe(w.bob.id)
    const grand = await newPage(w.bob, { space_id: w.space, parent_id: w.shared })
    // 公共页（连孙页）挪到私人页下：整棵变私人
    expect((await call(w.bob, 'PATCH', `/api/pages/${w.shared}`, { parent_id: w.secret })).status).toBe(200)
    expect(await areaOf(w.shared)).toBe(w.bob.id)
    expect(await areaOf(grand)).toBe(w.bob.id)
    // 直接把子页改成公共：触发器按父页改回去
    await pool.query('UPDATE pages SET private_owner = NULL WHERE id = $1', [w.secretChild])
    expect(await areaOf(w.secretChild)).toBe(w.bob.id)
    // 私人页下建合集：合集与它的行都私人
    const col = await postJson('/api/collections', w.bob.cookie, { space_id: w.space, parent_id: w.secret, title: '书单' })
    expect(col.status).toBe(201)
    const colId = ((await col.json()) as { id: string }).id
    expect(await areaOf(colId)).toBe(w.bob.id)
    // 顶层合集、顶层页可以指定建进私人区，缺省公共
    const topCol = ((await (await postJson('/api/collections', w.bob.cookie, { space_id: w.space, title: '私人书单', private: true })).json()) as { id: string }).id
    expect(await areaOf(topCol)).toBe(w.bob.id)
    expect(await areaOf(await newPage(w.bob, { space_id: w.space }))).toBeNull()
    // 从公共模板新建：要求私人就进私人区，缺省公共
    const template = await newPage(w.bob, { space_id: w.space, title: '公共模板' })
    const made = async (body: unknown) => ((await (await postJson(`/api/pages/${template}/instantiate`, w.bob.cookie, body)).json()) as { id: string }).id
    expect(await areaOf(await made({ space_id: w.space, private: true }))).toBe(w.bob.id)
    expect(await areaOf(await made({ space_id: w.space }))).toBeNull()
  })
})

describe('换区', () => {
  it('公共 → 私人：创建人与空间 owner 可以，别的成员 403；落进做的人的私人区；私人 → 公共主人可以', async () => {
    const w = await world()
    const r1 = await call(w.carol, 'PATCH', `/api/pages/${w.shared}`, { private: true })
    expect(r1.status).toBe(403)
    expect(((await r1.json()) as { error: string }).error).toBe(PRIVATIZE_FORBIDDEN)
    expect((await call(w.alice, 'PATCH', `/api/pages/${w.shared}`, { private: true })).status).toBe(200)
    expect(await areaOf(w.shared)).toBe(w.alice.id)
    expect(await listIds(w.bob)).not.toContain(w.shared)
    expect((await call(w.alice, 'PATCH', `/api/pages/${w.shared}`, { private: false })).status).toBe(200)
    expect(await areaOf(w.shared)).toBeNull()
    expect((await call(w.bob, 'PATCH', `/api/pages/${w.shared}`, { private: true })).status).toBe(200)
    expect((await call(w.bob, 'PATCH', `/api/pages/${w.secret}`, { private: false })).status).toBe(200)
    expect(await areaOf(w.secretChild)).toBeNull()
  })

  it('子页不能单独换区；skill 页不能私人；看不到的父页与不存在同样 400', async () => {
    const w = await world()
    const child = await call(w.bob, 'PATCH', `/api/pages/${w.secretChild}`, { private: false })
    expect(child.status).toBe(400)
    expect(((await child.json()) as { error: string }).error).toBe(PRIVATE_ONLY_TOP)
    const skill = crypto.randomUUID()
    await pool.query("INSERT INTO pages (id, owner_id, space_id, kind, in_page_tree) VALUES ($1, $2, $3, 'skill', false)", [skill, w.bob.id, w.space])
    const r = await call(w.bob, 'PATCH', `/api/pages/${skill}`, { private: true })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toBe(SKILL_NOT_PRIVATE)
    // carol 把公共页挪到 bob 的私人页下：她看不到那一页，同「不存在」
    expect((await call(w.carol, 'PATCH', `/api/pages/${w.shared}`, { parent_id: w.secret })).status).toBe(400)
    expect(await areaOf(w.shared)).toBeNull()
  })

  it('挪进私人区：开着这页的别人被断开、重连被拒；增量里收到摘掉', async () => {
    const w = await world()
    const first = (await (await call(w.carol, 'GET', '/api/pages/sync')).json()) as { cursor: string; members: string }
    const carolDoc = await connectDoc(w.shared, w.carol.cookie)
    let refused = false
    carolDoc.on('authenticationFailed', () => {
      refused = true
    })
    expect((await call(w.bob, 'PATCH', `/api/pages/${w.shared}`, { private: true })).status).toBe(200)
    await waitFor(() => refused)
    carolDoc.destroy()
    const delta = (await (await call(w.carol, 'GET', `/api/pages/sync?since=${first.cursor}&members=${first.members}`)).json()) as { rm?: string[]; full?: unknown }
    expect(delta.full).toBeUndefined()
    expect(delta.rm).toContain(w.shared)
    // 主人自己照常连得上
    const bobDoc = await connectDoc(w.shared, w.bob.cookie)
    bobDoc.destroy()
  })

  it('顶层排序只排同一区：重排公共页不动别人的私人页', async () => {
    const w = await world()
    const carolSecret = await newPage(w.carol, { space_id: w.space, private: true })
    await pool.query('UPDATE pages SET position = 7 WHERE id = $1', [carolSecret])
    expect((await call(w.bob, 'PATCH', `/api/pages/${w.shared}`, { index: 0 })).status).toBe(200)
    const pos = (await pool.query<{ position: number }>('SELECT position FROM pages WHERE id = $1', [carolSecret])).rows[0]?.position
    expect(pos).toBe(7)
  })
})

describe('发布、回收站、目录树、删号', () => {
  it('私人页由主人发布（他只是成员）；空间 owner 看不到它、发布不了', async () => {
    const w = await world()
    expect((await call(w.alice, 'PATCH', `/api/pages/${w.secret}/publish`, { published: true })).status).toBe(404)
    expect((await call(w.bob, 'PATCH', `/api/pages/${w.secret}/publish`, { published: true })).status).toBe(200)
    expect((await fetch(`${base}/api/public/pages/${w.secret}`)).status).toBe(200)
    // 公共页照旧只有空间 owner 能发布
    expect((await call(w.bob, 'PATCH', `/api/pages/${w.shared}/publish`, { published: true })).status).toBe(403)
  })

  it('清空回收站只清自己看得到的：别人的私人页还在', async () => {
    const w = await world()
    expect((await call(w.bob, 'POST', `/api/pages/${w.secret}/trash`)).status).toBe(200)
    expect((await call(w.bob, 'POST', `/api/pages/${w.shared}/trash`)).status).toBe(200)
    const trashForAlice = (await (await call(w.alice, 'GET', '/api/pages/trash')).json()) as Array<{ id: string }>
    expect(trashForAlice.map((t) => t.id)).toEqual([w.shared])
    expect((await call(w.alice, 'DELETE', `/api/pages/trash?space_id=${w.space}`)).status).toBe(200)
    const left = (await pool.query<{ id: string }>('SELECT id FROM pages WHERE id = ANY($1::text[])', [[w.secret, w.shared]])).rows.map((r) => r.id)
    expect(left).toEqual([w.secret])
  })

  it('目录树不收私人页；页挪进私人区时从目录树里摘掉', async () => {
    const w = await world()
    const tree = ((await (await postJson(`/api/spaces/${w.space}/dir-tree`, w.alice.cookie)).json()) as { board: { id: string } }).board.id
    const attach = (who: Person, id: string) => call(who, 'PUT', `/api/boards/${tree}/items`, { kind: 'page', item_id: id })
    expect((await attach(w.bob, w.secret)).status).toBe(400)
    const loose = await newPage(w.bob, { space_id: w.space, title: '挂进目录树的页' })
    expect((await attach(w.bob, loose)).status).toBe(201)
    expect((await call(w.bob, 'PATCH', `/api/pages/${loose}`, { private: true })).status).toBe(200)
    const mounted = await pool.query("SELECT 1 FROM folder_items WHERE kind = 'page' AND item_id = $1", [loose])
    expect(mounted.rowCount).toBe(0)
  })

  it('删号：先删掉他的全部私人页，预览里有数', async () => {
    const w = await world()
    const impact = (await (await call(w.root, 'GET', `/api/admin/users/${w.bob.id}/delete-impact`)).json()) as { purgePrivatePages: number }
    expect(impact.purgePrivatePages).toBe(2)
    expect((await call(w.root, 'DELETE', `/api/admin/users/${w.bob.id}`)).status).toBe(200)
    const left = await pool.query('SELECT 1 FROM pages WHERE id = ANY($1::text[])', [[w.secret, w.secretChild]])
    expect(left.rowCount).toBe(0)
    expect(await listIds(w.alice)).toContain(w.shared)
  })
})

describe('agent 与空间 AI', () => {
  it('空间 AI 的范围只到公共区：私人页读不到、搜不到、改不了', async () => {
    const w = await world()
    expect(await pageInSpace(pool, w.secret, w.space)).toBe(false)
    expect(await pageInSpace(pool, w.shared, w.space)).toBe(true)
    const token = mintPageToken(w.bob.id, SPACE_AI_ID, { pageId: w.shared, agentId: SPACE_AI_ID, canDispatch: false, space: w.space })
    const ai = (method: string, path: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    expect((await ai('GET', `/api/pages/${w.secret}/text`)).status).toBe(404)
    expect((await ai('GET', `/api/pages/${w.shared}/text`)).status).toBe(200)
    expect((await ai('POST', `/api/pages/${w.secret}/edit`, { ops: [{ op: 'replace', old: '', new: '写进去' }] })).status).toBe(404)
    const found = (await (await ai('POST', '/api/ramet/search', { query: '只给自己看' })).json()) as { results: Array<{ id: string }> }
    expect(found.results).toEqual([])
  })

  it('评论里在私人页上叫空间 AI：直接失败，原因写明', async () => {
    const w = await world()
    await pool.query('UPDATE pages SET page_comments = true WHERE id = $1', [w.secret])
    const res = await postJson(`/api/pages/${w.secret}/comments`, w.bob.cookie, { kind: 'page', body: `@[空间 AI](agent:${SPACE_AI_ID}) 帮我看看` })
    expect(res.status).toBe(201)
    await waitFor(async () => (await pool.query('SELECT 1 FROM comment_ai_calls')).rowCount === 1)
    const call = (await pool.query<{ state: string; reason: string }>('SELECT state, reason FROM comment_ai_calls')).rows[0]
    expect(call).toEqual({ state: 'failed', reason: CALL_PRIVATE })
  })

  it('agent 不指定位置建页：落进发起人自己那个空间的私人区；有父页跟父页', async () => {
    const w = await world()
    const token = mintPageToken(w.bob.id, 'test-agent', { agentId: 'test-agent' })
    const make = async (body: unknown) =>
      (await (
        await fetch(`${base}/api/ramet/pages`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      ).json()) as { id: string }
    const loose = await make({ title: '随手记' })
    expect(await areaOf(loose.id)).toBe(w.bob.id)
    const home = (await pool.query<{ space_id: string; is_personal: boolean }>('SELECT p.space_id, s.is_personal FROM pages p JOIN spaces s ON s.id = p.space_id WHERE p.id = $1', [loose.id])).rows[0]
    expect(home?.is_personal).toBe(true)
    const under = await make({ title: '公共页下', parentId: w.shared })
    expect(await areaOf(under.id)).toBeNull()
  })

  it('Genet 页建在主人的私人区', async () => {
    const w = await world()
    const { pageId } = await ensureAssistantPage(pool, { id: w.bob.id })
    expect(await areaOf(pageId)).toBe(w.bob.id)
  })
})
