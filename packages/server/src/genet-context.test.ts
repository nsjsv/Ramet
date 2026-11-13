// Genet 跨空间上下文（agents/genet-context.ts、space-context.ts，接在 turn.ts）：真库 + test-kit 的完整服务，模型是假的，看它每一轮收到的输入。
//   新会话：空间清单 → 个人记忆 → 眼前的空间的约定 → 文档；Genet 页所在空间的公共记忆不带。
//   同一会话：带过没变的不再带；空间记忆变了重带；个人记忆变了带「有更新」的全部；换到另一个空间带那个空间的。
//   眼前的空间的收集与上限（单元）：ctx、提到的页、非成员 / Genet 子树排除、最近 3 个、放不下的写一行且不记为已带。
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { insertConnection } from './ai-connections.js'
import { ASSISTANT_ID } from './agents/assistant-agent.js'
import { genetContext, MAX_SPACES, spacesHere } from './agents/genet-context.js'
import { say, script as fakeModel, type GenetCall, type Step } from './agents/drivers/assistant/test-model.js'
import { assistantModel, assistantSecret, connectDoc, continuePage, pool, postJson, settled, setupPage, SSECollector, userMessage } from './agents/test-kit.js'

function script(...steps: Step[]): GenetCall[] {
  const fake = fakeModel(...steps)
  assistantModel.script = fake.stream
  return fake.calls
}

/** 这一轮发给模型的输入（最后一条用户消息的文字） */
function input(c: GenetCall | undefined): string {
  const m = [...(c?.messages ?? [])].reverse().find((x) => x.role === 'user')
  const content = m?.content as unknown
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map((p: { text?: string }) => p.text ?? '').join('\n') : ''
}

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T
}

type Home = { cookie: string; userId: string; pageId: string; teamSpace: string; teamPage: string; doc: HocuspocusProvider; sse: SSECollector; turns: number }

async function home(): Promise<Home> {
  const { cookie, pageId: teamPage } = await setupPage()
  const userId = (await pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'alice'")).rows[0]!.id
  await insertConnection(pool, userId, { name: 'c', protocol: 'anthropic', baseUrl: null, model: 'claude-opus-5-5' }, 'sk-ant-test-secret-9999', assistantSecret)
  const teamSpace = (await pool.query<{ space_id: string }>('SELECT space_id FROM pages WHERE id = $1', [teamPage])).rows[0]!.space_id
  const pageId = (await json<{ pageId: string }>(postJson('/api/me/assistant', cookie))).pageId
  const doc = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  return { cookie, userId, pageId, teamSpace, teamPage, doc, sse, turns: 0 }
}

async function ask(h: Home, text: string, ctx?: string): Promise<void> {
  userMessage(h.doc.document, text, { agent: ASSISTANT_ID, ...(ctx ? { ctx } : {}) })
  expect(await continuePage(h.pageId, h.cookie, { agent: ASSISTANT_ID })).toBe(202)
  await settled(h.sse, ++h.turns)
}

const addSpaceMemory = (h: Home, space: string, text: string) => postJson(`/api/spaces/${space}/memories`, h.cookie, { text })

describe('Genet 每一轮的跨空间上下文', () => {
  it('新会话按序带清单、个人记忆、眼前的空间；同一会话不重带，变了再带；Genet 页所在空间的公共记忆不带', async () => {
    const h = await home()
    expect((await addSpaceMemory(h, h.teamSpace, '提交信息用英文')).status).toBe(201)
    expect((await postJson('/api/me/memories', h.cookie, { text: '回复用中文' })).status).toBe(201)
    const own = (await pool.query<{ space_id: string }>('SELECT space_id FROM pages WHERE id = $1', [h.pageId])).rows[0]!.space_id
    expect((await addSpaceMemory(h, own, 'Genet 所在空间的约定')).status).toBe(201)
    const calls = script(say('好'), say('好'), say('好'), say('好'), say('好'))

    await ask(h, '第一问', h.teamPage)
    const first = input(calls[0])
    const order = ['[Ramet 空间清单：用户所在的空间]', '[Ramet 个人记忆', '回复用中文', '[Ramet 空间上下文：「s」', '提交信息用英文', '第一问'].map((t) => first.indexOf(t))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(first).not.toContain('Genet 所在空间的约定')

    await ask(h, '第二问', h.teamPage)
    const second = input(calls[1])
    expect(second).toContain('第二问')
    expect(second).not.toContain('[Ramet 空间清单')
    expect(second).not.toContain('[Ramet 个人记忆')
    expect(second).not.toContain('[Ramet 空间上下文')

    await addSpaceMemory(h, h.teamSpace, '周报周五交')
    await ask(h, '第三问', h.teamPage)
    expect(input(calls[2])).toContain('提交信息用英文')
    expect(input(calls[2])).toContain('周报周五交')

    // Genet 页上 /记住：进个人记忆，下一轮带上「有更新」的全部
    const remembered = await json<{ target: unknown }>(postJson(`/api/pages/${h.pageId}/memories`, h.cookie, { text: '先说结论' }))
    expect(remembered.target).toBe('personal')
    await ask(h, '第四问', h.teamPage)
    const fourth = input(calls[3])
    expect(fourth).toContain('有更新')
    expect(fourth).toContain('回复用中文')
    expect(fourth).toContain('先说结论')
    expect(fourth).not.toContain('[Ramet 空间上下文')

    // 换到另一个空间的页：带那个空间的
    const other = await json<{ id: string }>(postJson('/api/spaces', h.cookie, { name: '另一个组' }))
    await addSpaceMemory(h, other.id, '另一个组的约定')
    const otherPage = await json<{ id: string }>(postJson('/api/pages', h.cookie, { space_id: other.id }))
    await ask(h, '第五问', otherPage.id)
    const fifth = input(calls[4])
    expect(fifth).toContain('[Ramet 空间清单') // 多了一个空间
    expect(fifth).toContain('另一个组的约定')
    expect(fifth).not.toContain('提交信息用英文')
    h.sse.stop()
    h.doc.destroy()
  })
})

describe('眼前的空间（单元）', () => {
  /** 一页用户消息：文字 + 提到的页 + ctx */
  function docWith(messages: Array<{ mentions?: string[]; ctx?: string; id?: string; reply?: string }>): Y.XmlFragment {
    const doc = new Y.Doc()
    const frag = doc.getXmlFragment('prosemirror')
    for (const m of messages) {
      const msg = new Y.XmlElement('user_message')
      if (m.ctx) msg.setAttribute('ctx', m.ctx)
      if (m.id) msg.setAttribute('id', m.id)
      const p = new Y.XmlElement('paragraph')
      for (const pageId of m.mentions ?? []) {
        const chip = new Y.XmlElement('page_mention')
        chip.setAttribute('pageId', pageId)
        p.insert(p.length, [chip])
      }
      msg.insert(0, [p])
      frag.insert(frag.length, [msg])
      if (m.reply) {
        const r = new Y.XmlElement('agent_reply')
        r.setAttribute('id', m.reply)
        frag.insert(frag.length, [r])
      }
    }
    return frag
  }

  it('ctx 与提到的页、只算成员空间、跳过 Genet 子树、最近的在前；增量只看 seen 之后', async () => {
    const h = await home()
    const spaces: Array<{ id: string; page: string }> = []
    for (const name of ['a', 'b', 'c', 'd']) {
      const sp = await json<{ id: string }>(postJson('/api/spaces', h.cookie, { name }))
      const page = await json<{ id: string }>(postJson('/api/pages', h.cookie, { space_id: sp.id }))
      spaces.push({ id: sp.id, page: page.id })
    }
    const outsider = await pool.query<{ id: string }>("INSERT INTO spaces (id, name, owner_id, is_personal) VALUES (gen_random_uuid()::text, 'x', $1, false) RETURNING id", [h.userId])
    const hidden = await pool.query<{ id: string }>("INSERT INTO pages (id, owner_id, space_id, in_page_tree) VALUES (gen_random_uuid()::text, $1, $2, true) RETURNING id", [h.userId, outsider.rows[0]!.id])
    const [a, b, c, d] = spaces as [typeof spaces[0], typeof spaces[0], typeof spaces[0], typeof spaces[0]]
    const frag = docWith([
      { mentions: [a.page], reply: 'r1' },
      { mentions: [b.page, hidden.rows[0]!.id, h.pageId], ctx: c.page },
      { mentions: [d.page, b.page] },
    ])
    const ids = async (seen: string | null) => (await spacesHere(pool, h.userId, frag, frag.length, seen)).map((s) => s.id)
    // 全文重放：只看最后一条
    expect(await ids(null)).toEqual([b.id, d.id])
    // 增量：r1 之后的两条，最近的在前；不是成员的空间、Genet 页不算
    expect(await ids('r1')).toEqual([b.id, d.id, c.id])
    // 4 个空间：前 MAX_SPACES 个带上并记下，第 4 个只有一行
    const four = docWith([{ mentions: [a.page, b.page, c.page, d.page] }])
    const ctx = await genetContext(pool, { user: { id: h.userId }, fragment: four, viewEnd: four.length, seen: null, prior: {} })
    expect(MAX_SPACES).toBe(3)
    expect(ctx.record[`space:${a.id}`]).toBeUndefined()
    expect(Object.keys(ctx.record).filter((k) => k.startsWith('space:'))).toHaveLength(3)
    expect(ctx.text).toContain(`「a」space:${a.id} 的约定这轮没带上`)
    // 下一轮只提到 a：带上它
    const next = await genetContext(pool, { user: { id: h.userId }, fragment: docWith([{ mentions: [a.page] }]), viewEnd: 1, seen: null, prior: ctx.record })
    expect(next.text).toContain(`[Ramet 空间上下文：「a」space:${a.id}`)
    expect(next.record[`space:${a.id}`]).toBeDefined()
    h.sse.stop()
    h.doc.destroy()
  })
})
