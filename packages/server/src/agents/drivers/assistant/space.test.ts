// 空间 AI 模式的驱动：会话属于凭证上的空间（同空间的另一个成员加载得上、别的空间加载不上），连接现读空间配置（没有配置项），
// 没启用就报「这个空间还没有启用 AI」；runOnce 收下一轮的文字、用完把会话连库里的历史一起删掉。
import { afterEach, describe, expect, it } from 'vitest'
import { assistantSecret, base, insertUser, pool, setupPage } from '../../test-kit.js'
import { deleteConnection, insertConnection } from '../../../ai-connections.js'
import { mintPageToken, type PageTool } from '../../../page-read.js'
import type { PiStream } from '../../../pi-models.js'
import { SPACE_AI_ID, SPACE_AI_OFF } from '../../space-ai.js'
import { AssistantDriver } from './driver.js'
import { runOnce } from './run-once.js'
import { say, script } from './test-model.js'

const OWNER_KEY = 'sk-ant-test-owner-3333'
const drivers: AssistantDriver[] = []
afterEach(() => {
  for (const d of drivers.splice(0)) d.kill()
})

function driver(stream: PiStream): AssistantDriver {
  const d = new AssistantDriver({ pool, stream, secretKey: assistantSecret, catalog: null, mode: 'space' })
  drivers.push(d)
  return d
}

/** alice 的团队空间（启用空间 AI）+ 一页；bob 是成员 */
async function setup(): Promise<{ spaceId: string; pageId: string; aliceId: string; bobId: string; connectionId: string }> {
  const { pageId } = await setupPage()
  const aliceId = (await pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'alice'")).rows[0]!.id
  const spaceId = (await pool.query<{ space_id: string }>('SELECT space_id FROM pages WHERE id = $1', [pageId])).rows[0]!.space_id
  const conn = await insertConnection(pool, aliceId, { name: 'a', protocol: 'anthropic', baseUrl: null, model: 'claude-opus-5-5' }, OWNER_KEY, assistantSecret)
  await pool.query('INSERT INTO space_ai (space_id, connection_id, name) VALUES ($1, $2, $3)', [spaceId, conn.id, '小助手'])
  const bobId = await insertUser('bob')
  await pool.query("INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'member')", [spaceId, bobId])
  return { spaceId, pageId, aliceId, bobId, connectionId: conn.id }
}

const grant = (userId: string, pageId: string, space: string, readOnly = false): PageTool => ({
  mcp: { url: base, token: mintPageToken(userId, SPACE_AI_ID, { pageId, agentId: SPACE_AI_ID, canDispatch: false, space, ...(readOnly ? { readOnly: true } : {}) }) },
})

describe('空间 AI 模式', () => {
  it('会话属于空间：没有配置项；同空间的另一个成员加载得上，别的空间 / Genet 的凭证加载不上；库里记 space_id', async () => {
    const t = await setup()
    const d = driver(script(say('好')).stream)
    const { sessionId, configOptions } = await d.newSession('', [grant(t.aliceId, t.pageId, t.spaceId)])
    expect(configOptions).toEqual([])
    const row = (await pool.query<{ user_id: string | null; space_id: string | null }>('SELECT user_id, space_id FROM assistant_sessions WHERE id = $1', [sessionId])).rows[0]
    expect(row).toEqual({ user_id: null, space_id: t.spaceId })
    await expect(d.loadSession(sessionId, '', [grant(t.bobId, t.pageId, t.spaceId)])).resolves.toEqual({ configOptions: [] })
    await expect(d.loadSession(sessionId, '', [grant(t.bobId, t.pageId, 'other-space')])).rejects.toThrow(/没有这个 空间 AI 会话/)
    // 新实例 = 重启：从库里读回来，同样按空间认
    const again = driver(script(say('好')).stream)
    await expect(again.loadSession(sessionId, '', [grant(t.bobId, t.pageId, t.spaceId)])).resolves.toEqual({ configOptions: [] })
    await expect(again.setConfigOption(sessionId, 'provider', t.connectionId)).rejects.toThrow(/没有「provider」这一项/)
    // 不带空间的凭证（签给空间 AI、却没收窄）不认
    const loose: PageTool = { mcp: { url: base, token: mintPageToken(t.bobId, SPACE_AI_ID, { pageId: t.pageId }) } }
    await expect(d.newSession('', [loose])).rejects.toThrow(/凭证已经失效/)
  })

  it('runOnce：用空间 owner 的连接与空间 AI 的提示词，收下文字；会话用完连库里的历史一起删掉', async () => {
    const t = await setup()
    const fake = script(say('这是答案'))
    const d = driver(fake.stream)
    const out = await runOnce(d, { url: base, token: grant(t.bobId, t.pageId, t.spaceId, true).mcp.token, blocks: [{ type: 'text', text: '问一句' }] })
    expect(out).toEqual({ text: '这是答案', stopReason: 'end_turn' })
    expect(fake.calls[0]!.apiKey).toBe(OWNER_KEY)
    expect(fake.calls[0]!.system).toContain('团队空间共用的 AI')
    // 只读凭证：工具里只有读的
    const names = fake.calls[0]!.tools.map((x) => x.name)
    expect(names).toEqual(expect.arrayContaining(['read_page', 'search_pages']))
    expect(names).not.toContain('edit_page')
    expect((await pool.query('SELECT 1 FROM assistant_sessions WHERE space_id = $1', [t.spaceId])).rowCount).toBe(0)
    expect(d.knownSessions()).toEqual([])
  })

  it('没启用 / owner 删了连接：这一轮失败，原因是「这个空间还没有启用 AI」', async () => {
    const t = await setup()
    await deleteConnection(pool, t.aliceId, t.connectionId)
    const d = driver(script(say('不该到这里')).stream)
    await expect(runOnce(d, { url: base, token: grant(t.bobId, t.pageId, t.spaceId).mcp.token, blocks: [{ type: 'text', text: '在吗' }] })).rejects.toThrow(SPACE_AI_OFF)
    expect((await pool.query('SELECT 1 FROM assistant_sessions WHERE space_id = $1', [t.spaceId])).rowCount).toBe(0)
  })
})
