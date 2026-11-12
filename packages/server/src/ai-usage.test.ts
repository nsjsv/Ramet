/* ---------- AI 使用量：记账点与汇总（真库；模型都是假的） ----------
 * 记账：空间 AI 一轮记在空间 owner 名下、带叫它的人和空间；Genet 一轮记在主人名下；⌘J 站点通道一次、AI 属性一次各一行；
 *   上游没报用量（全 0）不记。
 * 汇总：我的用量只看花我连接的（成员叫空间 AI 不算成员的）；按天每天一行、窗口外的不算；按来源 / 模型分。
 *   空间 AI 用量只给 owner（成员 403、非成员 / 个人空间 404），按叫它的成员分。 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertConnection } from './ai-connections.js'
import { generateText } from './ai-gen.js'
import { recordUsage } from './ai-usage.js'
import { ASSISTANT_ID } from './agents/assistant-agent.js'
import { AssistantDriver } from './agents/drivers/assistant/driver.js'
import { runOnce } from './agents/drivers/assistant/run-once.js'
import { say, script } from './agents/drivers/assistant/test-model.js'
import { SPACE_AI_ID } from './agents/space-ai.js'
import { assistantSecret, base, insertUser, joinPageSpace, login, pool, setupPage } from './agents/test-kit.js'
import { startServer } from './index.js'
import { mintPageToken } from './page-read.js'
import type { ModelChunk, QuickModelCall } from './quick.js'

// ⌘J 走自己的假调用：吐一段字，再报这一次的用量
const quickCall: QuickModelCall = async function* (): AsyncGenerator<ModelChunk> {
  yield { type: 'delta', text: '改好了' }
  yield { type: 'usage', usage: { input: 40, output: 8, cacheRead: 0, cacheWrite: 0 } }
  yield { type: 'stop', reason: 'end_turn' }
}
let quick: Awaited<ReturnType<typeof startServer>>
beforeAll(async () => {
  quick = await startServer(pool, 0, { quick: { call: quickCall, secretKey: assistantSecret, resolve: async () => [{ address: '93.184.216.34', family: 4 }] } })
})
afterAll(async () => {
  await quick.close()
})

const get = async (cookie: string, path: string): Promise<{ status: number; json: any }> => {
  const res = await fetch(`${base}${path}`, { headers: { cookie } })
  return { status: res.status, json: await res.json() }
}

/** alice 的团队空间（启用空间 AI，用她的连接）+ 一页；bob 是成员 */
async function world() {
  const { cookie, pageId } = await setupPage()
  const aliceId = (await pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'alice'")).rows[0]!.id
  const spaceId = (await pool.query<{ space_id: string }>('SELECT space_id FROM pages WHERE id = $1', [pageId])).rows[0]!.space_id
  const conn = await insertConnection(pool, aliceId, { name: 'a', protocol: 'anthropic', baseUrl: null, model: 'claude-opus-5-5' }, 'sk-ant-test-usage-1111', assistantSecret)
  await pool.query('INSERT INTO space_ai (space_id, connection_id, name) VALUES ($1, $2, $3)', [spaceId, conn.id, '小助手'])
  const bobCookie = await joinPageSpace(pageId, 'bob')
  const bobId = (await pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'bob'")).rows[0]!.id
  return { cookie, pageId, aliceId, spaceId, bobCookie, bobId }
}

type Row = { payer_id: string; actor_id: string | null; space_id: string | null; source: string; model: string; requests: number; input: string; output: string }
const rows = async (): Promise<Row[]> =>
  (await pool.query<Row>('SELECT payer_id, actor_id, space_id, source, model, requests, input, output FROM ai_usage ORDER BY id')).rows

describe('记账', () => {
  it('空间 AI 一轮记在 owner 名下（带叫它的人与空间）；Genet 一轮记在主人名下', async () => {
    const w = await world()
    const space = new AssistantDriver({ pool, stream: script(say('答', { input: 100, output: 20 })).stream, secretKey: assistantSecret, catalog: null, mode: 'space' })
    const token = mintPageToken(w.bobId, SPACE_AI_ID, { pageId: w.pageId, agentId: SPACE_AI_ID, space: w.spaceId, readOnly: true })
    await runOnce(space, { url: base, token, blocks: [{ type: 'text', text: '问' }] })
    space.kill()
    const genet = new AssistantDriver({ pool, stream: script(say('好', { input: 7, output: 3 })).stream, secretKey: assistantSecret, catalog: null })
    await runOnce(genet, { url: base, token: mintPageToken(w.aliceId, ASSISTANT_ID, { pageId: w.pageId }), blocks: [{ type: 'text', text: '在吗' }] })
    genet.kill()
    expect(await rows()).toEqual([
      { payer_id: w.aliceId, actor_id: w.bobId, space_id: w.spaceId, source: 'space_ai', model: 'claude-opus-5-5', requests: 1, input: '100', output: '20' },
      { payer_id: w.aliceId, actor_id: w.aliceId, space_id: null, source: 'genet', model: 'claude-opus-5-5', requests: 1, input: '7', output: '3' },
    ])
  })

  it('⌘J 站点通道一次、AI 属性一次各一行；上游没报用量不记', async () => {
    const w = await world()
    const res = await fetch(`http://127.0.0.1:${quick.port}/api/quick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: w.cookie },
      body: JSON.stringify({ kind: 'rewrite', instruction: '改短', text: '一段字' }),
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('event: done')
    await generateText({ pool, stream: script(say('属性值', { input: 12, output: 4 })).stream, secretKey: assistantSecret }, w.aliceId, 'ai_prop', '系统', '要求')
    // 假模型不报用量（全 0）：不记
    await generateText({ pool, stream: script(say('没有用量')).stream, secretKey: assistantSecret }, w.aliceId, 'ai_gen', '系统', '要求')
    expect((await rows()).map((r) => [r.source, r.payer_id, r.input, r.output])).toEqual([
      ['quick', w.aliceId, '40', '8'],
      ['ai_prop', w.aliceId, '12', '4'],
    ])
  })
})

describe('汇总', () => {
  it('我的用量：只算花我连接的；每天一行，窗口外的不算；按来源 / 模型分', async () => {
    const w = await world()
    const rec = (source: 'space_ai' | 'quick', actor: string, input: number, model = 'claude-opus-5-5') =>
      recordUsage(pool, { payerId: w.aliceId, actorId: actor, spaceId: source === 'space_ai' ? w.spaceId : null, source, model, requests: 2, input, output: 10, cacheRead: 5, cacheWrite: 0 })
    await rec('space_ai', w.bobId, 100)
    await rec('quick', w.aliceId, 50, 'glm-4.6')
    await rec('quick', w.aliceId, 30, 'glm-4.6')
    // 40 天前的：窗口外
    await pool.query("INSERT INTO ai_usage (payer_id, actor_id, source, model, input, output, at) VALUES ($1, $1, 'quick', 'old', 999, 999, now() - interval '40 days')", [w.aliceId])
    const mine = await get(w.cookie, '/api/me/ai-usage')
    expect(mine.status).toBe(200)
    expect(mine.json.days).toBe(30)
    expect(mine.json.byDay).toHaveLength(30)
    expect(mine.json.byDay.at(-1)).toMatchObject({ calls: 3, requests: 6, input: 180, output: 30, cacheRead: 15 })
    expect(mine.json.byDay.slice(0, -1).every((d: { calls: number }) => d.calls === 0)).toBe(true)
    expect(mine.json.totals).toEqual({ calls: 3, requests: 6, input: 180, output: 30, cacheRead: 15, cacheWrite: 0 })
    expect(mine.json.bySource.map((s: { source: string; calls: number }) => [s.source, s.calls])).toEqual([['space_ai', 1], ['quick', 2]])
    expect(mine.json.byModel.map((s: { model: string; input: number }) => [s.model, s.input])).toEqual([['claude-opus-5-5', 100], ['glm-4.6', 80]])
    // bob 叫了空间 AI，但花的不是他的连接
    expect((await get(w.bobCookie, '/api/me/ai-usage')).json.totals.calls).toBe(0)
    // days 超出范围按 30；合法值照用
    expect((await get(w.cookie, '/api/me/ai-usage?days=500')).json.days).toBe(30)
    expect((await get(w.cookie, '/api/me/ai-usage?days=7')).json.byDay).toHaveLength(7)
  })

  it('空间 AI 用量：只给 owner，按叫它的成员分；成员 403，非成员 / 个人空间 404', async () => {
    const w = await world()
    for (const [actor, input] of [[w.bobId, 100], [w.bobId, 50], [w.aliceId, 30]] as const) {
      await recordUsage(pool, { payerId: w.aliceId, actorId: actor, spaceId: w.spaceId, source: 'space_ai', model: 'm', requests: 1, input, output: 0, cacheRead: 0, cacheWrite: 0 })
    }
    // 别的来源不算进空间 AI
    await recordUsage(pool, { payerId: w.aliceId, actorId: w.aliceId, source: 'quick', model: 'm', requests: 1, input: 1, output: 0, cacheRead: 0, cacheWrite: 0 })
    const own = await get(w.cookie, `/api/spaces/${w.spaceId}/ai/usage`)
    expect(own.status).toBe(200)
    expect(own.json.totals).toMatchObject({ calls: 3, input: 180 })
    expect(own.json.byMember.map((m: { name: string; calls: number; input: number }) => [m.name, m.calls, m.input])).toEqual([
      ['bob', 2, 150],
      ['alice', 1, 30],
    ])
    expect((await get(w.bobCookie, `/api/spaces/${w.spaceId}/ai/usage`)).status).toBe(403)
    await insertUser('carol')
    const carol = await login('carol')
    expect((await get(carol, `/api/spaces/${w.spaceId}/ai/usage`)).status).toBe(404)
    const personal = (await pool.query<{ id: string }>('SELECT id FROM spaces WHERE owner_id = $1 AND is_personal', [w.aliceId])).rows[0]!.id
    expect((await get(w.cookie, `/api/spaces/${personal}/ai/usage`)).status).toBe(404)
  })
})
