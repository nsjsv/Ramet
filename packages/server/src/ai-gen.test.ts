/* ---------- AI 块：点「生成」与规则的「刷新 AI 块」 ----------
 * 生成 = 用点的人的模型连接、以这一页（不含块自己）为资料，把输出的 markdown 换进块身，块头记更新时间；
 * 只读 403、块不在 404、提示词空 400、没模型连接 409；模型失败记在块头。规则动作到点刷新、块不在时失败原因清楚。 */
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { insertConnection } from './ai-connections.js'
import { textOf } from './updates.js'
import { brief, fail, say, script } from './agents/drivers/assistant/test-model.js'
import { assistantModel, assistantSecret, base, connectDoc, joinPageSpace, pool, s, setupPage, triggerClock, userIdOf, waitFor } from './agents/test-kit.js'

const BLOCK = 'ai-1'

function req(method: string, path: string, cookie: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function paragraph(text: string, id?: string): Y.XmlElement {
  const p = new Y.XmlElement('paragraph')
  if (id) p.setAttribute('id', id)
  const t = new Y.XmlText()
  t.insert(0, text)
  p.insert(0, [t])
  return p
}

/** 正文：一段资料 + 一个 AI 块（块身里是上一次的旧内容） */
function seed(doc: HocuspocusProvider, prompt: string): void {
  const ai = new Y.XmlElement('ai_gen')
  ai.setAttribute('id', BLOCK)
  ai.setAttribute('prompt', prompt)
  ai.insert(0, [paragraph('上一次生成的旧内容')])
  doc.document.getXmlFragment('prosemirror').push([paragraph('预算是 3 万，风险是汇率', 'p-1'), ai])
}

function aiBlock(doc: HocuspocusProvider): Y.XmlElement {
  return doc.document
    .getXmlFragment('prosemirror')
    .toArray()
    .find((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'ai_gen')!
}

const bodyText = (doc: HocuspocusProvider): string =>
  aiBlock(doc)
    .toArray()
    .map((n) => textOf(n as Y.XmlElement))
    .join('\n')

async function world() {
  const { cookie, pageId } = await setupPage()
  const alice = await userIdOf('alice')
  await insertConnection(pool, alice, { name: 'c', protocol: 'anthropic', baseUrl: null, model: 'claude-opus-5-5' }, 'sk-ant-test-secret-9999', assistantSecret)
  const doc = await connectDoc(pageId, cookie)
  return { cookie, page: pageId, doc }
}

describe('AI 块', () => {
  it('点生成：资料是这一页（不含块自己），输出换进块身、块头记时间；再点整段替换；模型失败记在块头', async () => {
    const w = await world()
    seed(w.doc, '把预算整理成要点')
    const model = script(say('- 预算：3 万\n- 风险：汇率'), say('只剩一条'), fail('', { status: 500 }, 'boom'))
    assistantModel.script = model.stream
    await waitFor(() => aiBlock(w.doc).getAttribute('prompt') === '把预算整理成要点')
    await new Promise((r) => setTimeout(r, 300))

    const res = await req('POST', `/api/pages/${w.page}/ai-gen/${BLOCK}`, w.cookie)
    expect(res.status).toBe(202)
    await waitFor(() => bodyText(w.doc).includes('预算：3 万'))
    const el = aiBlock(w.doc)
    expect(el.getAttribute('state')).toBe('')
    expect(Number.isNaN(Date.parse(String(el.getAttribute('note'))))).toBe(false)
    // 列表每一项各是一个 bullet_list（编辑器的列表就是这样存的）
    expect(el.toArray().map((n) => (n as Y.XmlElement).nodeName)).toEqual(['bullet_list', 'bullet_list'])
    expect(bodyText(w.doc)).not.toContain('旧内容')
    const asked = brief(model.calls[0]!.messages[0]!).text
    expect(asked).toContain('预算是 3 万，风险是汇率')
    expect(asked).toContain('块的要求：把预算整理成要点')
    expect(asked).not.toContain('上一次生成的旧内容')

    // 上一次的写入落到文档时锁还没放（写完才放）：等到收下为止
    const again = () => waitFor(async () => (await req('POST', `/api/pages/${w.page}/ai-gen/${BLOCK}`, w.cookie)).status === 202)
    await again()
    await waitFor(() => bodyText(w.doc) === '只剩一条')
    await again()
    await waitFor(() => aiBlock(w.doc).getAttribute('state') === 'failed')
    expect(String(aiBlock(w.doc).getAttribute('note'))).not.toBe('')
    expect(bodyText(w.doc)).toBe('只剩一条')
    w.doc.destroy()
  }, 60_000)

  it('只读 403、块不在 404、提示词空 400、没模型连接 409', async () => {
    const w = await world()
    seed(w.doc, '')
    await waitFor(() => aiBlock(w.doc) !== undefined)
    await new Promise((r) => setTimeout(r, 300))
    const viewer = await joinPageSpace(w.page, 'bob', { role: 'viewer' })
    const member = await joinPageSpace(w.page, 'carol')
    const post = (cookie: string, block = BLOCK) => req('POST', `/api/pages/${w.page}/ai-gen/${block}`, cookie)
    expect((await post(viewer)).status).toBe(403)
    expect((await post(w.cookie, 'nope')).status).toBe(404)
    const empty = await post(w.cookie)
    expect(empty.status).toBe(400)
    expect(await empty.json()).toEqual({ error: '先写上要 AI 做什么' })
    w.doc.document.transact(() => aiBlock(w.doc).setAttribute('prompt', '总结'))
    await new Promise((r) => setTimeout(r, 300))
    const none = await post(member)
    expect(none.status).toBe(409)
    expect(((await none.json()) as { error: string }).error).toContain('还没配模型连接')
    w.doc.destroy()
  }, 60_000)

  it('规则的「刷新 AI 块」：到点刷新；块不在了动作失败、原因清楚；算 AI 次数', async () => {
    const w = await world()
    seed(w.doc, '一句话总结')
    assistantModel.script = script(say('定时刷新的结果')).stream
    await waitFor(() => aiBlock(w.doc) !== undefined)
    await new Promise((r) => setTimeout(r, 300))
    const t0 = Date.now()
    triggerClock.at = t0
    const make = async (block: string) => {
      const res = await req('POST', '/api/me/automations', w.cookie, {
        name: `刷新 ${block}`,
        source: 'timer',
        config: { kind: 'every', minutes: 60 },
        scopePage: w.page,
        actions: [{ type: 'ai_gen', page: w.page, block }],
      })
      expect(res.status).toBe(201)
      return ((await res.json()) as { automation: { id: string; actionsText: string[] } }).automation
    }
    const good = await make(BLOCK)
    const gone = await make('missing-block')
    expect(good.actionsText).toEqual(['刷新《无标题》里的 AI 块'])
    triggerClock.at = t0 + 61 * 60_000
    await s.triggers.tick()
    await waitFor(() => bodyText(w.doc) === '定时刷新的结果', 20_000)
    const ev = async (id: string) =>
      (await pool.query<{ status: string; reason: string; ai: boolean }>('SELECT status, reason, ai FROM trigger_events WHERE trigger_id = $1', [id])).rows[0]
    await waitFor(async () => (await ev(gone.id))?.status === 'failed')
    expect(await ev(gone.id)).toMatchObject({ reason: '这一页里没有这个 AI 块了', ai: true })
    expect(await ev(good.id)).toMatchObject({ status: 'delivered', ai: true })
    w.doc.destroy()
  }, 60_000)
})
