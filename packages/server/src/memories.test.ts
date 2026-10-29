/* ---------- 空间公共记忆：REST 权限矩阵 + 上限 + 广播 + 纯函数 ----------
 * 人：alice 全局 admin、空间 owner；bob 成员；carol 只读成员；dave 不在空间里；erin 另一个空间的 owner（造「跨空间删」）。
 * 提议（propose_memory）与注入 / hash 的集成测试在 agents/memory-agent.test.ts。 */
import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { MEMORY_ITEM_MAX, MEMORY_SPACE_MAX, addMemory, charCount, cleanMemoryText, memoryBlock, memoryBlockOfPage } from './memories.js'
import { promptHash, withMemory } from './agents/prompt-env.js'
import { base, insertUser, joinPageSpace, login, pageOwnership, pool, postJson, s, setupPage, userIdOf, waitFor } from './agents/test-kit.js'

type Who = 'alice' | 'bob' | 'carol' | 'dave' | 'erin'
type World = { spaceId: string; otherSpaceId: string; pageId: string; cookie: Record<Who, string>; id: Record<Who, string> }

async function world(): Promise<World> {
  const { cookie: alice, pageId } = await setupPage()
  const { spaceId } = await pageOwnership(pageId)
  const cookie = { alice } as Record<Who, string>
  cookie.bob = await joinPageSpace(pageId, 'bob', { role: 'member' })
  cookie.carol = await joinPageSpace(pageId, 'carol', { role: 'viewer' })
  await insertUser('dave')
  cookie.dave = await login('dave')
  await insertUser('erin')
  cookie.erin = await login('erin')
  const otherSpaceId = ((await (await postJson('/api/spaces', cookie.erin, { name: 'erin 的空间' })).json()) as { id: string }).id
  const id = {} as Record<Who, string>
  for (const who of Object.keys(cookie) as Who[]) id[who] = await userIdOf(who)
  return { spaceId, otherSpaceId, pageId, cookie, id }
}

const call = (method: string, path: string, cookie: string | null, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

type ListBody = { items: Array<{ id: string; text: string; created_by: string | null; created_by_name: string | null; source_page_id: string | null }>; chars: number; limits: { item: number; space: number } }

async function list(spaceId: string, cookie: string): Promise<ListBody> {
  const res = await call('GET', `/api/spaces/${spaceId}/memories`, cookie)
  expect(res.status).toBe(200)
  return (await res.json()) as ListBody
}

const rows = async (spaceId: string): Promise<number> => Number((await pool.query('SELECT count(*) FROM space_memories WHERE space_id = $1', [spaceId])).rows[0].count)

/** 连 control:global，收服务端的 stateless 广播 */
async function connectControl(cookie: string, onStateless: (payload: string) => void): Promise<HocuspocusProvider> {
  const wsProvider = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${s.port}/collab`,
    WebSocketPolyfill: class extends WebSocket {
      constructor(url: string) {
        super(url, undefined, { headers: { cookie } })
      }
    } as unknown as typeof WebSocket,
    quiet: true,
  })
  const provider = new HocuspocusProvider({ websocketProvider: wsProvider, name: 'control:global', token: 'test', quiet: true, onStateless: ({ payload }) => onStateless(payload) })
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('control provider 同步超时')), 10_000)
    provider.on('synced', () => {
      clearTimeout(t)
      resolve()
    })
  })
  return provider
}

test('读：空间任意成员（含只读）可读；非成员与不存在的空间同响应 404；未登录 401', async () => {
  const w = await world()
  await addMemory(pool, w.spaceId, '部署只用 scripts/deploy.sh', w.id.alice, null)
  for (const who of ['alice', 'bob', 'carol'] as const) {
    const body = await list(w.spaceId, w.cookie[who])
    expect(body.items.map((i) => i.text), who).toEqual(['部署只用 scripts/deploy.sh'])
    expect(body.items[0]).toMatchObject({ created_by_name: 'alice' })
    expect(body.chars).toBe(charCount('部署只用 scripts/deploy.sh'))
    expect(body.limits).toEqual({ item: MEMORY_ITEM_MAX, space: MEMORY_SPACE_MAX })
  }
  const denied = await call('GET', `/api/spaces/${w.spaceId}/memories`, w.cookie.dave)
  const missing = await call('GET', '/api/spaces/no-such-space/memories', w.cookie.dave)
  expect(denied.status).toBe(404)
  expect(missing.status).toBe(404)
  expect(await denied.json()).toEqual(await missing.json())
  expect((await call('GET', `/api/spaces/${w.spaceId}/memories`, null)).status).toBe(401)
  // erin 在别的空间里是 owner，也看不到这个空间的记忆
  expect((await call('GET', `/api/spaces/${w.spaceId}/memories`, w.cookie.erin)).status).toBe(404)
})

test('写：owner / member 可添加（去首尾空白）；只读 403；非成员 404；空内容 400；记的人写在 created_by', async () => {
  const w = await world()
  const path = `/api/spaces/${w.spaceId}/memories`
  const ok = await call('POST', path, w.cookie.bob, { text: '  注释用中文\r\n提交信息也是  ' })
  expect(ok.status).toBe(201)
  const { memory } = (await ok.json()) as { memory: { text: string; created_by: string; created_by_name: string } }
  expect(memory).toMatchObject({ text: '注释用中文\n提交信息也是', created_by: w.id.bob, created_by_name: 'bob' })
  expect((await call('POST', path, w.cookie.alice, { text: 'owner 也能记' })).status).toBe(201)

  expect((await call('POST', path, w.cookie.carol, { text: '只读不能记' })).status).toBe(403)
  expect((await call('POST', path, w.cookie.dave, { text: '外人不能记' })).status).toBe(404)
  expect((await call('POST', path, w.cookie.erin, { text: '别的空间的 owner 也不能记' })).status).toBe(404)
  expect((await call('POST', path, null, { text: '未登录' })).status).toBe(401)
  expect(await rows(w.spaceId)).toBe(2)

  for (const text of ['', '   ', '\n\t\n']) {
    const res = await call('POST', path, w.cookie.bob, { text })
    expect(res.status, JSON.stringify(text)).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'empty' })
  }
  expect((await call('POST', path, w.cookie.bob, {})).status).toBe(400)
  expect((await call('POST', path, w.cookie.bob, { text: 42 })).status).toBe(400)
  expect(await rows(w.spaceId)).toBe(2)
})

test('上限：单条 2000 字（按码点，中文 / emoji 一视同仁）；每空间合计 30000 字，刚好顶满可以、再多一个字 413', async () => {
  const w = await world()
  const path = `/api/spaces/${w.spaceId}/memories`
  expect((await call('POST', path, w.cookie.bob, { text: '长'.repeat(MEMORY_ITEM_MAX) })).status).toBe(201)
  const tooLong = await call('POST', path, w.cookie.bob, { text: '长'.repeat(MEMORY_ITEM_MAX + 1) })
  expect(tooLong.status).toBe(413)
  expect(await tooLong.json()).toMatchObject({ error: 'too_long', message: expect.stringContaining('2000') })
  // emoji 一个字符占两个 UTF-16 单元，但只算一个字
  expect((await call('POST', path, w.cookie.bob, { text: '😀'.repeat(MEMORY_ITEM_MAX) })).status).toBe(201)
  expect(await rows(w.spaceId)).toBe(2)
  await pool.query('DELETE FROM space_memories WHERE space_id = $1', [w.spaceId])

  // 合计：先塞到 29990 字（直接写库，绕过 2000 字的单条限制）
  for (let i = 0; i < 14; i++) await pool.query('INSERT INTO space_memories (id, space_id, text) VALUES ($1, $2, $3)', [`seed-${i}`, w.spaceId, '字'.repeat(2000)])
  await pool.query('INSERT INTO space_memories (id, space_id, text) VALUES ($1, $2, $3)', ['seed-last', w.spaceId, '字'.repeat(1990)])
  expect((await list(w.spaceId, w.cookie.bob)).chars).toBe(29990)
  const full = await call('POST', path, w.cookie.bob, { text: '这一条一共有十一个字啊' })
  expect(full.status).toBe(413)
  expect(await full.json()).toMatchObject({ error: 'space_full', message: expect.stringContaining('30000') })
  expect(await rows(w.spaceId)).toBe(15)
  expect((await call('POST', path, w.cookie.bob, { text: '刚好十个字的内容啊啊' })).status).toBe(201)
  expect((await list(w.spaceId, w.cookie.bob)).chars).toBe(30000)
  expect((await call('POST', path, w.cookie.bob, { text: '多' })).status).toBe(413)
  // 别的空间不受这个空间的合计影响
  expect((await call('POST', `/api/spaces/${w.otherSpaceId}/memories`, w.cookie.erin, { text: '另一个空间照常' })).status).toBe(201)
})

test('并发添加不会一起越过合计上限', async () => {
  const w = await world()
  await pool.query('INSERT INTO space_memories (id, space_id, text) VALUES ($1, $2, $3)', ['seed', w.spaceId, '字'.repeat(MEMORY_SPACE_MAX - 5)])
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => addMemory(pool, w.spaceId, `并发${i}`.padEnd(4, '。'), w.id.bob, null)))
  // 剩 5 个字，每条 4 个字：只有一条放得下
  expect(results.filter((r) => r.ok)).toHaveLength(1)
  expect(await rows(w.spaceId)).toBe(2)
})

test('删：owner / member 可删；只读 403；非成员 404；记忆必须属于这个空间（跨空间的 id 当不存在）', async () => {
  const w = await world()
  const mine = (await addMemory(pool, w.spaceId, '这个空间的记忆', w.id.alice, null)) as { ok: true; memory: { id: string } }
  const theirs = (await addMemory(pool, w.otherSpaceId, '别的空间的记忆', w.id.erin, null)) as { ok: true; memory: { id: string } }
  const del = (spaceId: string, mid: string, who: Who): Promise<Response> => call('DELETE', `/api/spaces/${spaceId}/memories/${mid}`, w.cookie[who])

  expect((await del(w.spaceId, mine.memory.id, 'carol')).status).toBe(403)
  expect((await del(w.spaceId, mine.memory.id, 'dave')).status).toBe(404)
  expect((await del(w.spaceId, mine.memory.id, 'erin')).status).toBe(404)
  expect((await call('DELETE', `/api/spaces/${w.spaceId}/memories/${mine.memory.id}`, null)).status).toBe(401)
  // 跨空间：bob 是这个空间的 member，拿别的空间的记忆 id 来删，404，且那条还在
  expect((await del(w.spaceId, theirs.memory.id, 'bob')).status).toBe(404)
  // 反过来：erin 是另一个空间的 owner，拿这个空间的记忆 id 来删她自己的空间，404
  expect((await del(w.otherSpaceId, mine.memory.id, 'erin')).status).toBe(404)
  expect(await rows(w.spaceId)).toBe(1)
  expect(await rows(w.otherSpaceId)).toBe(1)

  expect((await del(w.spaceId, 'no-such-memory', 'bob')).status).toBe(404)
  expect((await del(w.spaceId, mine.memory.id, 'bob')).status).toBe(200)
  expect(await rows(w.spaceId)).toBe(0)
  expect((await del(w.spaceId, mine.memory.id, 'bob')).status).toBe(404) // 重复删
})

test('增删后经 control:global 广播不带内容的 memories 信号；失败的请求不广播', async () => {
  const w = await world()
  const got: string[] = []
  const control = await connectControl(w.cookie.carol, (payload) => got.push(payload))
  const path = `/api/spaces/${w.spaceId}/memories`
  const added = (await (await call('POST', path, w.cookie.bob, { text: '保密的内容' })).json()) as { memory: { id: string } }
  await waitFor(() => got.includes('memories'))
  expect(got.filter((p) => p === 'memories')).toHaveLength(1)
  await call('DELETE', `${path}/${added.memory.id}`, w.cookie.bob)
  await waitFor(() => got.filter((p) => p === 'memories').length === 2)
  // 被拒的写（只读 / 空内容）不广播
  await call('POST', path, w.cookie.carol, { text: 'x' })
  await call('POST', path, w.cookie.bob, { text: '' })
  await new Promise((r) => setTimeout(r, 300))
  expect(got).toEqual(['memories', 'memories'])
  control.destroy()
})

test('删空间连带清记忆；删号不改写历史（created_by 没有外键，显示名查不到）；页面物理删后 source_page_id 置空', async () => {
  const w = await world()
  const kept = (await addMemory(pool, w.spaceId, '来自页面的记忆', w.id.bob, w.pageId)) as { ok: true; memory: { id: string } }
  expect((await call('DELETE', `/api/admin/users/${w.id.bob}`, w.cookie.alice)).status).toBe(200)
  const after = await list(w.spaceId, w.cookie.alice)
  expect(after.items[0]).toMatchObject({ id: kept.memory.id, created_by: w.id.bob, created_by_name: null })
  await pool.query('DELETE FROM pages WHERE id = $1', [w.pageId])
  expect((await list(w.spaceId, w.cookie.alice)).items[0]).toMatchObject({ source_page_id: null })
  await pool.query('DELETE FROM spaces WHERE id = $1', [w.spaceId])
  expect(await rows(w.spaceId)).toBe(0)
})

test('memoryBlock / promptHash：没有记忆时恒等（老会话不因上线重放）；有记忆时逐条标明来源、hash 随记忆变', () => {
  expect(memoryBlock([])).toBe('')
  expect(withMemory('', '>> 你好')).toBe('>> 你好')
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
  expect(promptHash('', '>> 你好')).toBe(sha('>> 你好'))

  const block = memoryBlock([{ text: '注释用中文' }, { text: '第一行\n第二行' }])
  expect(block).toBe('这个空间的公共记忆（由成员确认记下，所有 agent 共享，请遵循）：\n- 注释用中文\n- 第一行\n  第二行')
  expect(withMemory(block, '>> 你好')).toBe(`${block}\n\n>> 你好`)
  const withBlock = promptHash(block, '>> 你好')
  expect(withBlock).not.toBe(sha('>> 你好'))
  expect(withBlock).not.toBe(promptHash(memoryBlock([{ text: '注释用中文' }]), '>> 你好'))
  expect(promptHash(block, '>> 你好')).toBe(withBlock) // 稳定
  // 把记忆「拼进文档」不会伪造出同一个 hash（长度前缀 + NUL 前导）
  expect(promptHash('', `${block}\n\n>> 你好`)).not.toBe(withBlock)
  expect(cleanMemoryText('  a\r\nb  ')).toBe('a\nb')
})

test('memoryBlockOfPage：按页面所在空间取全部记忆（按添加顺序）；页面已回收 / 不存在 = 空', async () => {
  const w = await world()
  expect(await memoryBlockOfPage(pool, w.pageId)).toBe('')
  await addMemory(pool, w.spaceId, '甲', w.id.alice, null)
  await addMemory(pool, w.spaceId, '乙', w.id.alice, null)
  await addMemory(pool, w.otherSpaceId, '别的空间', w.id.erin, null)
  expect(await memoryBlockOfPage(pool, w.pageId)).toBe(memoryBlock([{ text: '甲' }, { text: '乙' }]))
  expect(await memoryBlockOfPage(pool, 'no-such-page')).toBe('')
  expect((await postJson(`/api/pages/${w.pageId}/trash`, w.cookie.alice)).status).toBe(200)
  expect(await memoryBlockOfPage(pool, w.pageId)).toBe('')
})

test('不是成员的全局 admin：读写记忆一律 404（不给救援视角）；唯一写入口 addMemory 拒绝非成员 / 只读成员作为写入人', async () => {
  const w = await world()
  await insertUser('root', 'admin')
  const root = await login('root')
  expect((await call('GET', `/api/spaces/${w.spaceId}/memories`, root)).status).toBe(404)
  expect((await call('POST', `/api/spaces/${w.spaceId}/memories`, root, { text: '管理员写的' })).status).toBe(404)
  expect(await rows(w.spaceId)).toBe(0)
  const added = await addMemory(pool, w.spaceId, '成员写的', w.id.bob, null)
  expect(added.ok).toBe(true)
  if (!added.ok) return
  expect((await call('DELETE', `/api/spaces/${w.spaceId}/memories/${added.memory.id}`, root)).status).toBe(404)
  // 写入人必须是该空间的 owner / member：提议上点「记住」的人走同一个入口
  const rootId = await userIdOf('root')
  for (const by of [rootId, w.id.dave, w.id.carol]) {
    const res = await addMemory(pool, w.spaceId, `不该写进去 ${by}`, by, w.pageId)
    expect(res.ok ? 'ok' : res.reason).toBe('forbidden')
  }
  expect(await rows(w.spaceId)).toBe(1)
})
