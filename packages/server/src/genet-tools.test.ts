// Genet 跨空间的工具与个人记忆（routes/memory-tools.ts、my-memories.ts、ramet-tools.ts 的 skill / 派活、personal-memories*.ts）：
//   个人记忆 REST 与 `/记住` 的去处；一次性迁移；read_space（成员 / 非成员 / 空间 AI）；use_skill 的 space；
//   propose_memory 的去处与卡片标题（Genet 缺省个人记忆、指定空间、只读成员被拒）；派活的目标空间（指定、推断、不是成员）与任务页 agent 的记忆；
//   访客看到的页 agent 只能读不能改。
import { describe, expect, it } from 'vitest'
import { ASSISTANT_ID } from './agents/assistant-agent.js'
import { pageMemory, saveContextSpace, taskSpace } from './agents/space-context.js'
import { GUEST_AI_READONLY } from './agents/guest-gate.js'
import { memoryBlockOfPage } from './memories.js'
import { mintPageToken } from './page-read.js'
import { PERSONAL_MEMORIES_MIGRATION } from './personal-memories-schema.js'
import { answerPermission, base, insertUser, login, pool, postJson, SSECollector, waitPermission } from './agents/test-kit.js'

type Person = { id: string; cookie: string }

async function person(name: string): Promise<Person> {
  const id = await insertUser(name, 'user')
  return { id, cookie: await login(name) }
}

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T
}

const tool = (token: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })

/** 会等很久的端点先发头、吐空白保活，最后一段才是 JSON */
const result = async (res: Response): Promise<Record<string, unknown>> => JSON.parse((await res.text()).trim()) as Record<string, unknown>

/** alice 的团队空间「研发组」（bob 是 member、vic 是 viewer）；alice 的 Genet 页；团队空间里一页 */
async function world() {
  const alice = await person('alice')
  const bob = await person('bob')
  const vic = await person('vic')
  const team = await json<{ id: string }>(postJson('/api/spaces', alice.cookie, { name: '研发组' }))
  await pool.query("INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [team.id, bob.id, vic.id])
  const teamPage = await json<{ id: string }>(postJson('/api/pages', alice.cookie, { space_id: team.id, title: '方案' }))
  const genet = await json<{ pageId: string }>(postJson('/api/me/assistant', alice.cookie))
  const genetToken = mintPageToken(alice.id, ASSISTANT_ID, { pageId: genet.pageId, agentId: ASSISTANT_ID, canDispatch: true })
  return { alice, bob, vic, team: team.id, teamPage: teamPage.id, genetPage: genet.pageId, genetToken }
}

const personal = async (userId: string) => (await pool.query<{ text: string }>('SELECT text FROM user_memories WHERE user_id = $1 ORDER BY created_at', [userId])).rows.map((r) => r.text)
const spaceMemories = async (spaceId: string) => (await pool.query<{ text: string }>('SELECT text FROM space_memories WHERE space_id = $1 ORDER BY created_at', [spaceId])).rows.map((r) => r.text)

describe('个人记忆', () => {
  it('REST 只有本人；/记住 在 Genet 页进个人记忆、别的页进空间记忆、只读成员 403、看不到的页 404', async () => {
    const w = await world()
    const added = await json<{ memory: { id: string } }>(postJson('/api/me/memories', w.alice.cookie, { text: '回复用中文' }))
    expect((await json<{ items: unknown[] }>(fetch(`${base}/api/me/memories`, { headers: { cookie: w.bob.cookie } }))).items).toEqual([])
    expect((await fetch(`${base}/api/me/memories/${added.memory.id}`, { method: 'DELETE', headers: { cookie: w.bob.cookie } })).status).toBe(404)
    expect(await personal(w.alice.id)).toEqual(['回复用中文'])

    expect(await json(postJson(`/api/pages/${w.genetPage}/memories`, w.alice.cookie, { text: '先说结论' }))).toMatchObject({ target: 'personal' })
    expect(await json(postJson(`/api/pages/${w.teamPage}/memories`, w.bob.cookie, { text: '提交信息用英文' }))).toMatchObject({ target: { space: '研发组' } })
    expect((await postJson(`/api/pages/${w.teamPage}/memories`, w.vic.cookie, { text: 'x' })).status).toBe(403)
    expect((await postJson(`/api/pages/${w.genetPage}/memories`, w.bob.cookie, { text: 'x' })).status).toBe(404)
    expect(await personal(w.alice.id)).toEqual(['回复用中文', '先说结论'])
    expect(await spaceMemories(w.team)).toEqual(['提交信息用英文'])
  })

  it('一次性迁移：只有主人一个成员的空间里的记忆迁成个人记忆，有别人的空间不动；只跑一次', async () => {
    const solo = await person('solo')
    const pair = await person('pair')
    const mate = await person('mate')
    const space = async (owner: Person) =>
      (await pool.query<{ id: string }>("INSERT INTO spaces (id, name, owner_id, is_personal) VALUES (gen_random_uuid()::text, 'p', $1, true) RETURNING id", [owner.id])).rows[0]!.id
    const soloSpace = await space(solo)
    const pairSpace = await space(pair)
    await pool.query("INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner'), ($3, $5, 'member')", [soloSpace, solo.id, pairSpace, pair.id, mate.id])
    await pool.query("INSERT INTO space_memories (id, space_id, text) VALUES ('m1', $1, '我的偏好'), ('m2', $2, '团队约定')", [soloSpace, pairSpace])
    await pool.query('DROP TABLE IF EXISTS personal_memories_once')
    await pool.query(PERSONAL_MEMORIES_MIGRATION)
    expect(await personal(solo.id)).toEqual(['我的偏好'])
    expect(await spaceMemories(soloSpace)).toEqual([])
    expect(await spaceMemories(pairSpace)).toEqual(['团队约定'])
    // 再跑一次：之后记进单人空间的空间记忆不会被搬走
    await pool.query("INSERT INTO space_memories (id, space_id, text) VALUES ('m3', $1, '后来的公共约定')", [soloSpace])
    await pool.query(PERSONAL_MEMORIES_MIGRATION)
    expect(await spaceMemories(soloSpace)).toEqual(['后来的公共约定'])
  })
})

describe('Genet 的跨空间工具', () => {
  it('read_space：成员读得到（含只读成员），非成员 404，空间 AI 的凭证 403；工具清单里有它', async () => {
    const w = await world()
    await postJson(`/api/spaces/${w.team}/memories`, w.alice.cookie, { text: '提交信息用英文' })
    const res = await json<{ text: string }>(tool(w.genetToken, `/api/ramet/spaces/${w.team}/context`))
    expect(res.text).toContain('[Ramet 空间上下文：「研发组」')
    expect(res.text).toContain('你用 read_space 取的')
    expect(res.text).toContain('提交信息用英文')
    const vicToken = mintPageToken(w.vic.id, 'fake', { pageId: w.teamPage, agentId: 'fake' })
    expect((await tool(vicToken, `/api/ramet/spaces/${w.team}/context`)).status).toBe(200)
    const stranger = await person('stranger')
    expect((await tool(mintPageToken(stranger.id, 'fake'), `/api/ramet/spaces/${w.team}/context`)).status).toBe(404)
    const narrowed = mintPageToken(w.alice.id, 'space-ai', { pageId: w.teamPage, agentId: 'fake', space: w.team })
    expect((await tool(narrowed, `/api/ramet/spaces/${w.team}/context`)).status).toBe(403)
    expect((await json<{ tools: string[] }>(tool(w.genetToken, '/api/ramet/tools'))).tools).toContain('read_space')
    const plain = mintPageToken(w.alice.id, 'fake', { pageId: w.teamPage, agentId: 'fake' })
    expect((await json<{ tools: string[] }>(tool(plain, '/api/ramet/tools'))).tools).not.toContain('read_space')
  })

  it('propose_memory：Genet 缺省进个人记忆（卡片写明），指定空间进那里，只读成员的空间 400；别的 agent 照旧', async () => {
    const w = await world()
    const sse = new SSECollector()
    await sse.start(w.genetPage, w.alice.cookie)
    const pending = tool(w.genetToken, '/api/ramet/memories/propose', { method: 'POST', body: { text: '回复先说结论' } })
    const ask = await waitPermission(sse, (e) => e.requestId.startsWith('ramet-'))
    expect(ask.title).toContain('（写进你的个人记忆）')
    expect((await answerPermission(w.genetPage, w.alice.cookie, ask, 'allow')).status).toBe(200)
    expect(await result(await pending)).toMatchObject({ ok: true, savedTo: '你的个人记忆' })
    expect(await personal(w.alice.id)).toEqual(['回复先说结论'])

    const toTeam = tool(w.genetToken, '/api/ramet/memories/propose', { method: 'POST', body: { text: '周报周五交', space: w.team } })
    const ask2 = await waitPermission(sse, (e) => e.requestId.startsWith('ramet-') && e.requestId !== ask.requestId)
    expect(ask2.title).toContain('（写进「研发组」的空间记忆）')
    expect((await answerPermission(w.genetPage, w.alice.cookie, ask2, 'allow')).status).toBe(200)
    expect(await result(await toTeam)).toMatchObject({ ok: true })
    expect(await spaceMemories(w.team)).toEqual(['周报周五交'])
    sse.stop()

    // vic 的 Genet：研发组里他是只读成员
    const vicGenet = await json<{ pageId: string }>(postJson('/api/me/assistant', w.vic.cookie))
    const vicToken = mintPageToken(w.vic.id, ASSISTANT_ID, { pageId: vicGenet.pageId, agentId: ASSISTANT_ID })
    const denied = await tool(vicToken, '/api/ramet/memories/propose', { method: 'POST', body: { text: 'x', space: w.team } })
    expect(denied.status).toBe(400)
    expect(((await denied.json()) as { error: string }).error).toContain('只读成员')
    // 别的 agent 不能指定空间
    const plain = mintPageToken(w.alice.id, 'fake', { pageId: w.teamPage, agentId: 'fake' })
    expect((await tool(plain, '/api/ramet/memories/propose', { method: 'POST', body: { text: 'x', space: w.team } })).status).toBe(400)
  })

  it('use_skill 的 space：成员的空间可用、非成员读不到；派活的目标空间（指定 / 推断 / 不是成员）记在任务页，任务页 agent 的记忆带上它', async () => {
    const w = await world()
    await pool.query("INSERT INTO pages (id, owner_id, space_id, kind, in_page_tree) VALUES ('sk1', $1, $2, 'skill', false)", [w.alice.id, w.team])
    await pool.query("INSERT INTO skills (page_id, space_id, name, description) VALUES ('sk1', $1, 'review', '代码评审')", [w.team])
    expect((await tool(w.genetToken, `/api/ramet/skills/review?space=${w.team}`)).status).toBe(200)
    expect((await tool(w.genetToken, '/api/ramet/skills/review')).status).toBe(404)
    const stranger = await person('stranger')
    expect((await tool(mintPageToken(stranger.id, ASSISTANT_ID), `/api/ramet/skills/review?space=${w.team}`)).status).toBe(404)

    // 派到不是成员的空间：400（在判 agent 能不能用之前）
    const other = await json<{ id: string }>(postJson('/api/spaces', stranger.cookie, { name: '别人的' }))
    const bad = await tool(w.genetToken, '/api/ramet/dispatch', { method: 'POST', body: { agent: 'fake', title: 't', task: 'x', space: other.id } })
    expect(bad.status).toBe(400)

    // 目标空间的推断：任务说明里提到的页恰好在一个（用户是成员的）空间里才算
    expect(await taskSpace(pool, w.alice.id, undefined, `按 page:${w.teamPage} 改`)).toEqual({ id: w.team, name: '研发组' })
    const mine = await json<{ id: string }>(postJson('/api/pages', w.alice.cookie, {}))
    expect(await taskSpace(pool, w.alice.id, undefined, `page:${w.teamPage} 和 page:${mine.id}`)).toBeNull()
    expect(await taskSpace(pool, w.alice.id, undefined, '没有提到页')).toBeNull()
    expect(await taskSpace(pool, w.alice.id, w.team, '')).toEqual({ id: w.team, name: '研发组' })
    expect(await taskSpace(pool, w.alice.id, other.id, '')).toBe('not-member')

    // 任务页的记忆：没有目标空间时与页面所在空间的记忆块逐字节相同；记了目标空间后多一块，派活人被移出后不再带
    await postJson(`/api/spaces/${w.team}/memories`, w.alice.cookie, { text: '提交信息用英文' })
    const task = await json<{ id: string }>(postJson('/api/pages', w.alice.cookie, { parent_id: w.genetPage, title: '任务' }))
    expect(await pageMemory(pool, task.id)).toBe(await memoryBlockOfPage(pool, task.id))
    await saveContextSpace(pool, task.id, w.team)
    const withTarget = await pageMemory(pool, task.id)
    expect(withTarget).toContain('这个任务在这个空间里做，要守它的约定')
    expect(withTarget).toContain('提交信息用英文')
    // 任务页上的 agent 用目标空间的 skill
    const taskToken = mintPageToken(w.alice.id, 'fake', { pageId: task.id, agentId: 'fake' })
    expect((await tool(taskToken, '/api/ramet/skills/review')).status).toBe(200)
    await pool.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [w.team, w.alice.id])
    expect(await pageMemory(pool, task.id)).toBe(await memoryBlockOfPage(pool, task.id))
  })
})

it('访客看到的页：agent 读得到，改不了（edit_page、改名、提议记忆都 403）', async () => {
  const w = await world()
  const guest = await person('gina')
  expect((await postJson(`/api/pages/${w.teamPage}/shares`, w.alice.cookie, { username: 'gina', level: 'edit' })).status).toBe(200)
  // gina 在她自己空间的页上跑的 agent，去碰研发组那一页
  const own = await json<{ id: string }>(postJson('/api/pages', guest.cookie, {}))
  const token = mintPageToken(guest.id, 'fake', { pageId: own.id, agentId: 'fake' })
  expect((await tool(token, `/api/pages/${w.teamPage}/text`)).status).toBe(200)
  const edit = await tool(token, `/api/pages/${w.teamPage}/edit`, { method: 'POST', body: { ops: [{ op: 'replace', old: '方案', new: '改' }] } })
  expect(edit.status).toBe(403)
  expect(((await edit.json()) as { message?: string }).message).toBe(GUEST_AI_READONLY)
  const rename = await tool(token, `/api/ramet/pages/${w.teamPage}/rename`, { method: 'POST', body: { title: 'y' } })
  expect(rename.status).toBe(403)
  // 她自己能改（不是 AI）
  expect((await fetch(`${base}/api/pages/${w.teamPage}`, { method: 'PATCH', headers: { cookie: guest.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ title: '她改的' }) })).status).toBe(200)
})
