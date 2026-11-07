/* ---------- 会话里的凭证一直是活的（真库 + test-kit；凭证寿命调到很短）----------
 * 凭证有寿命，适配器池里的会话却可能活得更久（全站共用的 Genet 几乎不被闲置回收；别的 agent 长时间连着用也一样）。
 * 过期之后的下一轮：缓存里的凭证不再复用、签新的，已加载的会话按新凭证重新加载，agent 侧的 MCP 拿到新凭证，
 * 照常调得动 Ramet 工具（死凭证的工具清单只剩兜底的三个、读页面 401）。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { insertConnection } from '../ai-connections.js'
import { writeDocState } from '../collab.js'
import { parseNew } from '../page-write.js'
import { ASSISTANT_ID } from './assistant-agent.js'
import { callTool, lastResult, say, script } from './drivers/assistant/test-model.js'
import { newPageDoc } from './markdown.js'
import {
  agentSession,
  assistantModel,
  assistantSecret,
  connectDoc,
  continuePage,
  pool,
  postJson,
  replyBlocks,
  settled,
  setupPage,
  SSECollector,
  userMessage,
  waitFor,
} from './test-kit.js'

const TTL_MS = 2000
let savedTtl: string | undefined
beforeEach(() => {
  savedTtl = process.env.RAMET_PAGE_TOKEN_TTL_MS
  process.env.RAMET_PAGE_TOKEN_TTL_MS = String(TTL_MS)
})
afterEach(() => {
  if (savedTtl === undefined) delete process.env.RAMET_PAGE_TOKEN_TTL_MS
  else process.env.RAMET_PAGE_TOKEN_TTL_MS = savedTtl
})

const expire = () => new Promise((r) => setTimeout(r, TTL_MS + 300))

describe('凭证过期后的下一轮', () => {
  for (const agent of ['fake', 'claude']) {
    it(`${agent}：同一个会话接着用，MCP 换上新凭证，工具清单还是完整的`, async () => {
      const { cookie, pageId } = await setupPage()
      const doc = await connectDoc(pageId, cookie)
      const sse = new SSECollector()
      await sse.start(pageId, cookie)
      const turn = async (n: number) => {
        userMessage(doc.document, `报工具 第${n}次`, { agent })
        expect(await continuePage(pageId, cookie, { agent })).toBe(202)
        await settled(sse, n)
        await waitFor(() => replyBlocks(doc)[n - 1]?.outcome === 'end')
        return replyBlocks(doc)[n - 1]!.text
      }
      expect(await turn(1)).toContain('search_pages')
      const session = (await agentSession(pageId))?.[agent]?.sessionId
      await expire()
      const second = await turn(2)
      // 死凭证问不到工具清单，MCP 只剩兜底的三个基础工具
      expect(second).toContain('search_pages')
      expect((await agentSession(pageId))?.[agent]?.sessionId).toBe(session)
      sse.stop()
      doc.destroy()
    }, 30_000)
  }

  it('Genet：全站共用的适配器不被回收，过期之后的下一轮照样调得动工具', async () => {
    const { cookie } = await setupPage()
    const userId = (await pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'alice'")).rows[0]!.id
    await insertConnection(pool, userId, { name: 'c', protocol: 'anthropic', baseUrl: null, model: 'claude-opus-5-5' }, 'sk-ant-test-secret-9999', assistantSecret)
    const notes = ((await (await postJson('/api/pages', cookie, {})).json()) as { id: string }).id
    await writeDocState(pool, `page:${notes}`, newPageDoc('读书笔记', parseNew('第一行正文')))
    const home = ((await (await postJson('/api/me/assistant', cookie)).json()) as { pageId: string }).pageId

    const read = say((c) => (lastResult(c).includes('第一行正文') ? '读到了' : '没读到'))
    const fake = script(callTool('t1', 'read_page', { pageId: notes }), read, callTool('t3', 'read_page', { pageId: notes }), read)
    assistantModel.script = fake.stream
    const requests = fake.calls

    const doc = await connectDoc(home, cookie)
    const sse = new SSECollector()
    await sse.start(home, cookie)
    const turn = async (n: number) => {
      userMessage(doc.document, `读一下 page:${notes}`, { agent: ASSISTANT_ID })
      expect(await continuePage(home, cookie, { agent: ASSISTANT_ID })).toBe(202)
      await settled(sse, n)
      await waitFor(() => replyBlocks(doc)[n - 1]?.outcome !== undefined && replyBlocks(doc)[n - 1]?.outcome !== 'run')
      return replyBlocks(doc)[n - 1]!
    }
    expect((await turn(1)).text).toContain('读到了')
    await expire()
    const second = await turn(2)
    expect(second.outcome).toBe('end')
    expect(second.text).toContain('读到了')
    // 第二轮接着同一个会话（只发了新消息），不是失败后新建
    expect(requests[2]!.messages.filter((m) => m.role === 'user')).toHaveLength(2)
    sse.stop()
    doc.destroy()
  }, 30_000)
})
