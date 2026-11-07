// Genet 驱动：假模型（test-model.ts，按 pi 的事件流回放）+ 真 MCP 进程（mcp/ramet.mjs 回打 test-kit 起的中心）+ pi 的循环。
// 覆盖文字、思考、工具调用、停止、步数上限、没有模型连接时的引导、模型失败的文案、会话落库与重载（新实例 = 重启）、
// 认不出的历史形状、会话只给凭证的主人。
import { afterEach, describe, expect, it } from 'vitest'
import { assistantSecret, base, insertUser, pool, setupPage, waitFor } from '../../test-kit.js'
import { deleteConnection, insertConnection, saveSettings } from '../../../ai-connections.js'
import { ModelCatalog } from '../../../model-catalog.js'
import { writeDocState } from '../../../collab.js'
import { mintPageToken, type PageTool } from '../../../page-read.js'
import { parseNew } from '../../../page-write.js'
import type { PiStream } from '../../../pi-models.js'
import { ASSISTANT_ID } from '../../assistant-agent.js'
import { newPageDoc } from '../../markdown.js'
import type { AgentEvent } from '../../types.js'
import { ASSISTANT_MAX_STEPS, AssistantDriver, NO_CONNECTION } from './driver.js'
import { brief, callTool, fail, hang, replay, say, script, think } from './test-model.js'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import type { Message } from '@earendil-works/pi-ai'

const API_KEY = 'sk-ant-test-secret-9999'
const drivers: AssistantDriver[] = []
afterEach(() => {
  for (const d of drivers.splice(0)) d.kill()
})

function driver(stream: PiStream): { d: AssistantDriver; events: AgentEvent[] } {
  const d = new AssistantDriver({ pool, stream, secretKey: assistantSecret, catalog: null })
  drivers.push(d)
  const events: AgentEvent[] = []
  d.on((ev) => events.push(ev))
  return { d, events }
}

async function setup(opts: { connection?: boolean } = {}): Promise<{ userId: string; pageId: string; tool: PageTool }> {
  const { pageId } = await setupPage()
  const userId = (await pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'alice'")).rows[0]!.id
  if (opts.connection !== false) {
    await insertConnection(pool, userId, { name: 'c', protocol: 'anthropic', baseUrl: null, model: 'claude-opus-5-5' }, API_KEY, assistantSecret)
  }
  await writeDocState(pool, `page:${pageId}`, newPageDoc('读书笔记', parseNew('第一行正文\n\n第二段')))
  return { userId, pageId, tool: grant(userId, pageId) }
}

const grant = (userId: string, pageId: string): PageTool => ({
  mcp: { url: base, token: mintPageToken(userId, ASSISTANT_ID, { pageId, agentId: ASSISTANT_ID, canDispatch: true }) },
})

async function stored(sessionId: string): Promise<Message[]> {
  return (await pool.query<{ messages: Message[] }>('SELECT messages FROM assistant_sessions WHERE id = $1', [sessionId])).rows[0]!.messages
}

describe('Genet 驱动', () => {
  it('一轮文字：流式发出、用量合计；key 每轮现解密交给模型，不进历史；工具表是 Ramet 工具 + dispatch_task，没有 run_agent', async () => {
    const { tool } = await setup()
    const fake = script(say('你好呀', { input: 10, output: 5, cacheRead: 3 }))
    const { d, events } = driver(fake.stream)
    const { sessionId } = await d.newSession('', [tool])
    const res = await d.prompt(sessionId, [{ type: 'text', text: '你好' }])
    expect(res).toEqual({ stopReason: 'end_turn', usage: { total: 18, input: 10, output: 5, cacheRead: 3 } })
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta)).toEqual(['你好呀'])
    expect(events.every((e) => !('sessionId' in e) || e.sessionId === sessionId)).toBe(true)
    const req = fake.calls[0]!
    expect(req.apiKey).toBe(API_KEY)
    expect(req.system).toContain('Genet')
    const names = req.tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['read_page', 'search_pages', 'edit_page', 'trash_page', 'dispatch_task']))
    expect(names).not.toContain('run_agent')
    const messages = await stored(sessionId)
    expect(messages.map(brief)).toEqual([
      { role: 'user', text: '你好' },
      { role: 'assistant', text: '你好呀' },
    ])
    expect(JSON.stringify(messages)).not.toContain(API_KEY)
    expect(d.busy).toBe(false)
  })

  it('工具调用经 MCP 回打中心：结果回给模型，过程里是一步 read（输入 / 结果在视图里）', async () => {
    const { tool, pageId } = await setup()
    const fake = script(callTool('toolu_1', 'read_page', { pageId }), say('读完了'))
    const { d, events } = driver(fake.stream)
    const { sessionId } = await d.newSession('', [tool])
    expect((await d.prompt(sessionId, [{ type: 'text', text: `总结 page:${pageId}` }])).stopReason).toBe('end_turn')
    const second = fake.calls[1]!.messages
    const result = second[second.length - 1]
    expect(result).toMatchObject({ role: 'toolResult', toolCallId: 'toolu_1', isError: false })
    expect(JSON.stringify(result)).toContain('第一行正文')
    const steps = events.filter((e) => e.type === 'tool') as Array<Extract<AgentEvent, { type: 'tool' }>>
    expect(steps[0]).toMatchObject({ id: 'toolu_1', kind: 'read', title: pageId, status: 'in_progress', view: { tool: 'read_page', raw: { input: { pageId } } } })
    expect(steps[1]).toMatchObject({ id: 'toolu_1', status: 'completed' })
    expect(steps[1]!.view?.result).toContain('第一行正文')
  })

  it('停止：模型的流被中止，这一轮以 cancelled 收尾，说出去的半截话留在历史里', async () => {
    const { tool } = await setup()
    const { d, events } = driver(script(hang('写到一半')).stream)
    const { sessionId } = await d.newSession('', [tool])
    const running = d.prompt(sessionId, [{ type: 'text', text: '慢慢写' }])
    await waitFor(() => events.some((e) => e.type === 'text'))
    expect(d.busy).toBe(true)
    d.cancel(sessionId)
    expect((await running).stopReason).toBe('cancelled')
    expect((await stored(sessionId)).map(brief)).toEqual([
      { role: 'user', text: '慢慢写' },
      { role: 'assistant', text: '写到一半' },
    ])
  })

  it('步数上限：连着调工具到上限就停，告诉用户可以接着说；每一步在过程里各自一个 id', async () => {
    const { tool } = await setup()
    // 有的服务每一步都从 call_0 编起
    const fake = script(callTool('call_0', 'search_pages', { query: '笔记' }))
    const { d, events } = driver(fake.stream)
    const { sessionId } = await d.newSession('', [tool])
    const res = await d.prompt(sessionId, [{ type: 'text', text: '一直搜' }])
    expect(res.stopReason).toBe('max_turn_requests')
    expect(fake.calls).toHaveLength(ASSISTANT_MAX_STEPS)
    const ids = new Set(events.filter((e) => e.type === 'tool').map((e) => (e as { id: string }).id))
    expect(ids.size).toBe(ASSISTANT_MAX_STEPS)
    expect(ids.has('call_0') && ids.has('call_0#2')).toBe(true)
    const texts = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta)
    expect(texts.at(-1)).toContain('先停在这里')
    // 历史以这句说明收尾：下一轮接着说，请求照样合法（每个工具调用都有结果）
    const history = await stored(sessionId)
    expect(brief(history.at(-1)!)).toEqual({ role: 'assistant', text: expect.stringContaining('先停在这里') })
    expect(history.filter((m) => m.role === 'toolResult')).toHaveLength(ASSISTANT_MAX_STEPS)
  }, 60_000)

  it('没有模型连接：这一轮以引导文案失败，消息仍进了会话（配好后续跑接得上）', async () => {
    const { tool } = await setup({ connection: false })
    const fake = script(say('不该到这里'))
    const { d } = driver(fake.stream)
    const { sessionId } = await d.newSession('', [tool])
    await expect(d.prompt(sessionId, [{ type: 'text', text: '在吗' }])).rejects.toThrow(NO_CONNECTION)
    expect(fake.calls).toHaveLength(0)
    expect((await stored(sessionId)).map(brief)).toEqual([{ role: 'user', text: '在吗' }])
  })

  it('模型侧失败：给出能看懂的原因（不带 key），已经说出去的话留着', async () => {
    const { tool } = await setup()
    const { d } = driver(script(fail('先说一句', { status: 401, body: `bad key ${API_KEY}` }, `401 bad key ${API_KEY}`)).stream)
    const { sessionId } = await d.newSession('', [tool])
    const err = await d.prompt(sessionId, [{ type: 'text', text: 'hi' }]).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err?.message).toContain('API key 无效')
    expect(err?.message).not.toContain(API_KEY)
    expect((await stored(sessionId)).map(brief)).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: '先说一句' },
    ])
  })

  it('模型拒绝：说了话就以 refusal 收尾，一个字没说就失败', async () => {
    const { tool } = await setup()
    const refuse = (text: string) => () => replay({ ...fauxAssistantMessage(text, { stopReason: 'error' }), errorMessage: 'refused', rawStopReason: 'refusal' })
    const { d } = driver(script(refuse('这个我不能做'), refuse('')).stream)
    const { sessionId } = await d.newSession('', [tool])
    expect((await d.prompt(sessionId, [{ type: 'text', text: '一' }])).stopReason).toBe('refusal')
    await expect(d.prompt(sessionId, [{ type: 'text', text: '二' }])).rejects.toThrow('模型拒绝了这个请求')
  })

  it('思考过程以 thought 事件发出，正文照常', async () => {
    const { tool } = await setup()
    const { d, events } = driver(script(think('先想想', '想好了')).stream)
    const { sessionId } = await d.newSession('', [tool])
    expect((await d.prompt(sessionId, [{ type: 'text', text: '想一想' }])).stopReason).toBe('end_turn')
    expect(events.filter((e) => e.type === 'thought').map((e) => (e as { delta: string }).delta)).toEqual(['先想想'])
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta)).toEqual(['想好了'])
  })

  it('上游报错原文回显了 key（含被截断在 key 中间）：交出去的失败原因里没有 key', async () => {
    const { tool } = await setup()
    const bodies = [
      JSON.stringify({ error: { message: `invalid api key: ${API_KEY} (check your gateway)` } }),
      `${'x'.repeat(290)}${API_KEY}`, // 截到前 300 字时正好切在 key 中间
    ]
    for (const body of bodies) {
      const { d } = driver(script(fail('', { status: 400, body: body.slice(0, 300) })).stream)
      const { sessionId } = await d.newSession('', [tool])
      const err = await d.prompt(sessionId, [{ type: 'text', text: 'hi' }]).then(
        () => null,
        (e: unknown) => e as Error,
      )
      expect(err?.message).toContain('模型服务返回了错误（400）')
      expect(err?.message).not.toContain(API_KEY.slice(0, 10))
    }
  })

  it('自定义地址每一轮开头重新校验：保存时没问题、之后域名改解析到内网，这一轮不发请求、给出原因', async () => {
    const { tool, userId } = await setup({ connection: false })
    await insertConnection(pool, userId, { name: 'gw', protocol: 'openai', baseUrl: 'https://llm.example.com/v1', model: 'deepseek-chat' }, API_KEY, assistantSecret)
    const fake = script(say('不该到这里'))
    const d = new AssistantDriver({ pool, stream: fake.stream, secretKey: assistantSecret, catalog: null, resolve: async () => [{ address: '10.0.0.8', family: 4 }] })
    drivers.push(d)
    const { sessionId } = await d.newSession('', [tool])
    const err = await d.prompt(sessionId, [{ type: 'text', text: 'hi' }]).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err?.message).toMatch(/供应商的地址现在不能用/)
    expect(err?.message).not.toContain(API_KEY)
    expect(fake.calls).toHaveLength(0)
  })

  it('供应商 / 思考程度（没有目录，内置规则）：会话建立时定成设置里的当前连接、之后听 chip 的，思考档交给模型；设置里换当前连接不牵动它；连接被删立刻发 config 并回落', async () => {
    const { tool, userId } = await setup()
    const official = (await pool.query<{ id: string }>('SELECT id FROM user_ai_connections WHERE user_id = $1', [userId])).rows[0]!.id
    const compat = (await insertConnection(pool, userId, { name: 'ds', protocol: 'openai', baseUrl: 'https://llm.example.com/v1', model: 'deepseek-chat' }, API_KEY, assistantSecret)).id
    const fake = script(say('一'), say('二'), say('三'))
    const d = new AssistantDriver({ pool, stream: fake.stream, secretKey: assistantSecret, catalog: null, resolve: async () => [{ address: '93.184.216.34', family: 4 }] })
    drivers.push(d)
    const events: AgentEvent[] = []
    d.on((ev) => events.push(ev))
    const { sessionId, configOptions } = await d.newSession('', [tool])
    expect(configOptions.map((o) => [o.id, o.category, o.currentValue])).toEqual([
      ['provider', 'model', official],
      ['effort', 'thought_level', 'low'],
    ])
    expect(configOptions[0]!.options.map((v) => v.name)).toEqual(['c', 'ds'])

    await d.setConfigOption(sessionId, 'effort', 'high')
    await d.prompt(sessionId, [{ type: 'text', text: '一' }])
    expect(fake.calls[0]).toMatchObject({ model: 'claude-opus-5-5', thinking: { effort: 'high' }, maxTokens: 64000 })

    // 设置里的当前连接只管 ⌘J
    await saveSettings(pool, userId, { activeConnectionId: compat })
    await d.prompt(sessionId, [{ type: 'text', text: '二' }])
    expect(fake.calls[1]).toMatchObject({ model: 'claude-opus-5-5', thinking: { effort: 'high' } })

    // chip 换到 openai 兼容：思考档回到那边的默认（不指定），「高」不带过去
    const switched = await d.setConfigOption(sessionId, 'provider', compat)
    expect(switched.find((o) => o.id === 'effort')?.currentValue).toBe('default')
    await d.prompt(sessionId, [{ type: 'text', text: '三' }])
    expect(fake.calls[2]).toMatchObject({ protocol: 'openai', model: 'deepseek-chat' })
    expect(fake.calls[2]).not.toHaveProperty('thinking')

    await expect(d.setConfigOption(sessionId, 'effort', 'max')).rejects.toThrow(/没有这个选项/)
    await expect(d.setConfigOption(sessionId, 'provider', 'no-such')).rejects.toThrow(/没有这个选项/)
    await expect(d.setConfigOption(sessionId, 'mode', 'plan')).rejects.toThrow(/没有「mode」/)

    // 正在用的连接在设置里被删：不等下一轮就发 config，回落到设置里的当前连接
    events.length = 0
    await deleteConnection(pool, userId, compat)
    await waitFor(() => events.some((e) => e.type === 'config'))
    const cfg = events.find((e) => e.type === 'config') as Extract<AgentEvent, { type: 'config' }>
    expect(cfg.options.map((o) => [o.id, o.currentValue])).toEqual([
      ['provider', official],
      ['effort', 'low'],
    ])
    expect(cfg.options[0]!.options.map((v) => v.name)).toEqual(['c'])
  })

  it('公开模型目录：档位 / 上下文按目录里这个模型的，每次请求后报上下文占用；目录重拉到了立刻发 config，选过的档没了回到默认', async () => {
    const { tool, userId } = await setup({ connection: false })
    await insertConnection(pool, userId, { name: 'ds', protocol: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro' }, API_KEY, assistantSecret)
    let t = 0
    let efforts = ['low', 'high', 'max']
    const catalog = new ModelCatalog(
      async () => ({
        deepseek: {
          api: 'https://api.deepseek.com',
          models: { 'deepseek-v4-pro': { reasoning: true, reasoning_options: [{ type: 'effort', values: efforts }], limit: { context: 1_048_576, output: 393_216 } } },
        },
      }),
      () => t,
    )
    const fake = script(say('好', { input: 10, output: 5, cacheRead: 3 }))
    const d = new AssistantDriver({ pool, stream: fake.stream, secretKey: assistantSecret, catalog, resolve: async () => [{ address: '93.184.216.34', family: 4 }] })
    drivers.push(d)
    const events: AgentEvent[] = []
    d.on((ev) => events.push(ev))
    const { sessionId, configOptions } = await d.newSession('', [tool])
    expect(configOptions[0]!.options[0]!.description).toBe('deepseek-v4-pro · 1M 上下文')
    expect(configOptions[1]!.options.map((v) => v.value)).toEqual(['default', 'low', 'high', 'max'])

    await d.setConfigOption(sessionId, 'effort', 'max')
    await d.prompt(sessionId, [{ type: 'text', text: '想深一点' }])
    expect(fake.calls[0]).toMatchObject({ thinking: { effort: 'max' }, maxTokens: 64000 })
    // 上下文占用 = 这次请求的输入 + 缓存 + 输出（say 报的是 10 + 3 + 5）
    expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', used: 18, size: 1_048_576, sessionId })

    events.length = 0
    efforts = ['low']
    t = 25 * 3_600_000
    await catalog.get()
    await waitFor(() => events.some((e) => e.type === 'config'))
    const cfg = events.find((e) => e.type === 'config') as Extract<AgentEvent, { type: 'config' }>
    expect(cfg.options[1]).toMatchObject({ currentValue: 'default', options: [{ value: 'default' }, { value: 'low' }] })
  })

  it('会话落库与重载：新实例（= 重启 / 适配器被回收）load 之后，历史从库里读回来接着用', async () => {
    const { tool, userId, pageId } = await setup()
    const first = driver(script(say('第一答')).stream)
    const { sessionId } = await first.d.newSession('', [tool])
    await first.d.prompt(sessionId, [{ type: 'text', text: '第一问' }])
    first.d.kill()

    const fake = script(say('第二答'))
    const second = driver(fake.stream)
    await expect(second.d.prompt(sessionId, [{ type: 'text', text: '没 load' }])).rejects.toThrow(/Unsupported session/)
    await second.d.loadSession(sessionId, '', [grant(userId, pageId)])
    await second.d.prompt(sessionId, [{ type: 'text', text: '第二问' }])
    expect(fake.calls[0]!.messages.map(brief)).toEqual([
      { role: 'user', text: '第一问' },
      { role: 'assistant', text: '第一答' },
      { role: 'user', text: '第二问' },
    ])
  })

  it('每一轮输入最前面是当前时间与用户的时区（上报过的用它，没上报过用服务器的）；进会话历史', async () => {
    const { tool, userId } = await setup()
    await pool.query("UPDATE users SET time_zone = 'America/New_York' WHERE id = $1", [userId])
    const fake = script(say('好'))
    const { d } = driver(fake.stream)
    const { sessionId } = await d.newSession('', [tool])
    await d.prompt(sessionId, [{ type: 'text', text: '几点了' }])
    const first = (await stored(sessionId))[0]!
    const text = typeof first.content === 'string' ? first.content : first.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
    expect(text).toMatch(/^\[现在：\d{4}-\d{2}-\d{2} 周. \d{2}:\d{2}（America\/New_York）\]\n\n几点了$/)
    expect(fake.calls[0]!.system).toContain('[现在：')
  })

  it('库里的历史认不出（中性格式 {role, text}）：load 当作没有这个会话，调用方据此新建、全文重放', async () => {
    const { tool, userId, pageId } = await setup()
    const first = driver(script(say('x')).stream)
    const { sessionId } = await first.d.newSession('', [tool])
    first.d.kill()
    await pool.query('UPDATE assistant_sessions SET messages = $2::jsonb WHERE id = $1', [sessionId, JSON.stringify([{ role: 'user', text: '旧' }, { role: 'assistant', text: '旧答' }])])
    const second = driver(script(say('x')).stream)
    await expect(second.d.loadSession(sessionId, '', [grant(userId, pageId)])).rejects.toThrow(/没有这个 Genet 会话/)
  })

  it('会话只给凭证的主人：别人的凭证按 id 加载不上；不存在的会话加载不上；没有凭证（工具档位「无」）建不了', async () => {
    const { tool, pageId } = await setup()
    const { d } = driver(script(say('x')).stream)
    const { sessionId } = await d.newSession('', [tool])
    const bobId = await insertUser('bob')
    const other = driver(script(say('x')).stream)
    await expect(other.d.loadSession(sessionId, '', [grant(bobId, pageId)])).rejects.toThrow(/没有这个 Genet 会话/)
    await expect(d.loadSession(sessionId, '', [grant(bobId, pageId)])).rejects.toThrow(/没有这个 Genet 会话/)
    await expect(other.d.loadSession('no-such-session', '', [grant(bobId, pageId)])).rejects.toThrow(/没有这个 Genet 会话/)
    await expect(d.newSession('', [])).rejects.toThrow(/工具档位/)
    // 签给别的适配器的凭证不认
    const foreign = { mcp: { url: base, token: mintPageToken(bobId, 'fake', { pageId }) } }
    await expect(d.newSession('', [foreign])).rejects.toThrow(/凭证/)
  })
})
