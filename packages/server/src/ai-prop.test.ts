/* ---------- AI 属性：属性设置里的「填充」与规则的「填 AI 属性」 ----------
 * 填空白的行只填空的、全部重新生成全覆盖；资料是这一行的标题与别的属性；没模型连接 409、只读 403、要求空 400、正在填 409；
 * 自动更新的规则（属性改了 → 填 AI 属性，事件所在的行）只刷新改了的那一行，AI 自己写的不再触发。 */
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { insertConnection } from './ai-connections.js'
import { brief, say, script } from './agents/drivers/assistant/test-model.js'
import { assistantModel, assistantSecret, base, connectDoc, joinPageSpace, pool, postJson, setupPage, userIdOf, waitFor } from './agents/test-kit.js'

const AI = 'aiprop1'
const NOTE = 'noteprp'

function req(method: string, path: string, cookie: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** 集合文档里加一个属性（结构同 collections/init-doc.ts） */
function addProp(doc: HocuspocusProvider, id: string, json: Record<string, unknown>): void {
  doc.document.transact(() => {
    const prop = new Y.Map<unknown>()
    ;(doc.document.getMap<unknown>('collection').get('props') as Y.Map<unknown>).set(id, prop)
    for (const [k, v] of Object.entries(json)) prop.set(k, v)
  })
}

async function world() {
  const { cookie, pageId } = await setupPage()
  const alice = await userIdOf('alice')
  await insertConnection(pool, alice, { name: 'c', protocol: 'anthropic', baseUrl: null, model: 'claude-opus-5-5' }, 'sk-ant-test-secret-9999', assistantSecret)
  const space = (await pool.query<{ space_id: string }>('SELECT space_id FROM pages WHERE id = $1', [pageId])).rows[0]!.space_id
  const made = await postJson('/api/collections', cookie, { space_id: space, title: '任务' })
  const cid = ((await made.json()) as { id: string }).id
  const doc = await connectDoc(cid, cookie)
  addProp(doc, NOTE, { name: '备注', type: 'text', pos: 5 })
  addProp(doc, AI, { name: '摘要', type: 'ai', pos: 6, cfg: { prompt: '用一句话总结' } })
  await waitFor(async () => {
    const res = await req('GET', `/api/collections/${cid}/schema`, cookie)
    return ((await res.json()) as { schema: { props: Array<{ id: string }> } }).schema.props.some((p) => p.id === AI)
  })
  const row = async (title: string, set?: Record<string, unknown>) =>
    ((await (await postJson(`/api/collections/${cid}/rows`, cookie, { title, ...(set ? { set } : {}) })).json()) as { id: string }).id
  return { cookie, cid, doc, page: pageId, row }
}

async function value(rowId: string): Promise<unknown> {
  return (await pool.query<{ props: Record<string, unknown> }>('SELECT props FROM collection_rows WHERE page_id = $1', [rowId])).rows[0]?.props?.[AI]
}

describe('AI 属性', () => {
  it('填空白的行只填空的、资料是这一行；全部重新生成全覆盖；换行压成一行', async () => {
    const w = await world()
    const a = await w.row('写报告', { [NOTE]: '周五前交' })
    const b = await w.row('订机票', { [AI]: '手填的' })
    const model = script(say((c) => (brief(c.messages[0]!).text.includes('写报告') ? '报告要\n周五交' : '机票')))
    assistantModel.script = model.stream
    const res = await req('POST', `/api/collections/${w.cid}/ai-props/${AI}/fill`, w.cookie, { scope: 'empty' })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true, count: 1 })
    await waitFor(async () => (await value(a)) === '报告要 周五交')
    expect(await value(b)).toBe('手填的')
    const asked = brief(model.calls[0]!.messages[0]!).text
    expect(asked).toContain('名称：写报告')
    expect(asked).toContain('备注：周五前交')
    expect(asked).toContain('这一列（摘要）的要求：用一句话总结')
    expect(asked).not.toContain('摘要：')

    await waitFor(async () => (await req('POST', `/api/collections/${w.cid}/ai-props/${AI}/fill`, w.cookie, { scope: 'all' })).status === 202)
    await waitFor(async () => (await value(b)) === '机票')
    w.doc.destroy()
  }, 60_000)

  it('没模型连接 409、只读 403、不是 AI 属性 404、要求空 400', async () => {
    const w = await world()
    await w.row('一行')
    const viewer = await joinPageSpace(w.page, 'bob', { role: 'viewer' })
    const member = await joinPageSpace(w.page, 'carol')
    const fill = (cookie: string, prop = AI) => req('POST', `/api/collections/${w.cid}/ai-props/${prop}/fill`, cookie, { scope: 'empty' })
    expect((await fill(viewer)).status).toBe(403)
    expect((await fill(w.cookie, NOTE)).status).toBe(404)
    const none = await fill(member)
    expect(none.status).toBe(409)
    expect(((await none.json()) as { error: string }).error).toContain('还没配模型连接')
    w.doc.document.transact(() => {
      const prop = (w.doc.document.getMap<unknown>('collection').get('props') as Y.Map<Y.Map<unknown>>).get(AI)!
      prop.set('cfg', { prompt: '' })
    })
    await waitFor(async () => (await fill(w.cookie)).status === 400)
    w.doc.destroy()
  }, 60_000)

  it('自动更新：「属性改了 → 填 AI 属性（事件所在的行）」只刷新改了的那一行，AI 写的值不再触发', async () => {
    const w = await world()
    const a = await w.row('甲')
    const b = await w.row('乙')
    let n = 0
    assistantModel.script = script(say(() => `第 ${++n} 次`)).stream
    const made = await req('POST', '/api/me/automations', w.cookie, {
      name: 'AI 属性自动更新',
      source: 'collection',
      config: { collection: w.cid, on: 'edited' },
      actions: [{ type: 'ai_prop', collection: w.cid, prop: AI, row: 'event' }],
    })
    expect(made.status).toBe(201)
    const rule = ((await made.json()) as { automation: { id: string; actionsText: string[] } }).automation
    expect(rule.actionsText).toEqual(['填《任务》的 AI 属性（事件所在行）'])
    expect((await req('PATCH', `/api/collections/${w.cid}/rows/${a}`, w.cookie, { set: { [NOTE]: '改了' } })).status).toBe(200)
    await waitFor(async () => (await value(a)) === '第 1 次', 20_000)
    await new Promise((r) => setTimeout(r, 800))
    expect(await value(b)).toBeUndefined()
    const events = (await pool.query<{ status: string; ai: boolean }>('SELECT status, ai FROM trigger_events WHERE trigger_id = $1', [rule.id])).rows
    expect(events).toEqual([{ status: 'delivered', ai: true }])
    w.doc.destroy()
  }, 60_000)
})
