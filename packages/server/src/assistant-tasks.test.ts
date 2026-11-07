/* ---------- Genet 派出去的任务：做完回报 + wait_task（真库 + test-kit 的完整服务；模型是假的，任务交给本机假 agent）----------
 * 派出去的那一轮正常结束 / 失败 → Genet 页末尾写一条通知块（带 notice 的 user_message：任务链接、结局、agent、最后的回复），Genet 自动接着跑一轮；
 * 被手动停止 → 不回报。Genet 正忙时通知照写、只多跑一轮，那一轮看得到全部通知。
 * wait_task：等到结局就把结果交给 Genet、不再另发通知；任务在等审批时提前返回，之后做完照常回报；停掉 Genet 这一轮等待作废，做完照常回报。
 * 端点只认 Genet 页上的 Genet 凭证，只能等自己 Genet 页下的任务页。 */
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { insertConnection } from './ai-connections.js'
import { mintPageToken } from './page-read.js'
import { textOf } from './updates.js'
import { ASSISTANT_ID } from './agents/assistant-agent.js'
import { after, brief, callTool, lastResult, say, script as fakeModel, type GenetCall, type Step } from './agents/drivers/assistant/test-model.js'
import {
  answerPermission,
  assistantModel,
  assistantSecret,
  base,
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
} from './agents/test-kit.js'

function script(...steps: Step[]): GenetCall[] {
  const fake = fakeModel(...steps)
  assistantModel.script = fake.stream
  return fake.calls
}

type Home = { cookie: string; userId: string; pageId: string; otherPage: string; doc: HocuspocusProvider; sse: SSECollector }

async function home(): Promise<Home> {
  const { cookie, pageId: otherPage } = await setupPage()
  const userId = (await pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'alice'")).rows[0]!.id
  await insertConnection(pool, userId, { name: 'c', protocol: 'anthropic', baseUrl: null, model: 'claude-opus-5-5' }, 'sk-ant-test-secret-9999', assistantSecret)
  const pageId = ((await (await postJson('/api/me/assistant', cookie)).json()) as { pageId: string }).pageId
  const doc = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  return { cookie, userId, pageId, otherPage, doc, sse }
}

function close(h: Home): void {
  h.sse.stop()
  h.doc.destroy()
}

/** 在 Genet 页上发一条消息、发起一轮（不等它跑完） */
async function send(h: Home, text: string): Promise<void> {
  userMessage(h.doc.document, text, { agent: ASSISTANT_ID })
  expect(await continuePage(h.pageId, h.cookie, { agent: ASSISTANT_ID })).toBe(202)
}

/** Genet 页上第 n 轮收尾之后，再等一会儿确认没有多跑的轮 */
async function quiet(h: Home, n: number): Promise<void> {
  await settled(h.sse, n)
  await new Promise((r) => setTimeout(r, 1000))
  expect(h.sse.events.filter((e) => e.type === 'status' && (e.state === 'done' || e.state === 'error')).length).toBe(n)
}

/** 文档里的任务通知块 */
function notices(p: HocuspocusProvider): Y.XmlElement[] {
  return p.document
    .getXmlFragment('prosemirror')
    .toArray()
    .filter((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'user_message' && Boolean(n.getAttribute('notice')))
}

async function taskPages(pageId: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM live_pages WHERE parent_id = $1 AND kind = 'doc' ORDER BY created_at", [pageId])
  return rows.map((r) => r.id)
}

async function reported(taskId: string): Promise<boolean> {
  return (await pool.query<{ at: Date | null }>('SELECT reported_at AS at FROM assistant_tasks WHERE page_id = $1', [taskId])).rows[0]?.at != null
}

/** 上一个 dispatch_task 结果里的任务页 */
const taskOf = (c: GenetCall): string => /任务页 page:([\w-]+)/.exec(lastResult(c))?.[1] ?? 'none'

/** 等刚派出去的那个任务 */
const waitTask: Step = (c, req) => callTool('toolu_w', 'wait_task', { page: `page:${taskOf(c)}` })(c, req)

const lastText = (c: GenetCall): string => brief(c.messages.at(-1)!).text

describe('任务做完回报 Genet', () => {
  it('正常结束：Genet 页末尾出现通知块（任务链接、已完成、agent、回复正文），Genet 自动接着跑一轮，读到的是任务通知', async () => {
    const h = await home()
    const requests = script(callTool('toolu_d', 'dispatch_task', { agent: 'fake', title: '查一下', task: '随便查查' }), say('派好了'), say('知道了，做完了'))
    await send(h, '派个活')
    await quiet(h, 2)
    const [task] = await taskPages(h.pageId)
    expect(await reported(task!)).toBe(true)
    await waitFor(() => notices(h.doc).length === 1)
    const n = notices(h.doc)[0]!
    expect(n.getAttribute('notice')).toBe('done')
    expect(n.getAttribute('task')).toBe(task)
    expect(n.getAttribute('agent')).toBe(ASSISTANT_ID)
    expect(n.getAttribute('author')).toBe('')
    const head = n.get(0) as Y.XmlElement
    const chip = head.toArray().find((x) => x instanceof Y.XmlElement && x.nodeName === 'page_mention') as Y.XmlElement | undefined
    expect(chip?.getAttribute('pageId')).toBe(task)
    expect(chip?.getAttribute('title')).toBe('查一下')
    expect(textOf(head)).toContain('已完成 · Fake')
    expect(textOf(n)).toContain('turn:full')
    const woke = lastText(requests[2]!)
    expect(woke.startsWith('[Ramet 任务通知：不是用户发的]')).toBe(true)
    expect(woke).toContain('turn:full')
    await waitFor(() => replyBlocks(h.doc).at(-1)?.text === '知道了，做完了')
    close(h)
  })

  it('失败：通知写「失败了」并带原因，Genet 自动接着跑', async () => {
    const h = await home()
    const requests = script(callTool('toolu_d', 'dispatch_task', { agent: 'fake', title: '会失败', task: '失败' }), say('派好了'), say('看到失败了'))
    await send(h, '派个活')
    await quiet(h, 2)
    await waitFor(() => notices(h.doc).length === 1)
    const n = notices(h.doc)[0]!
    expect(n.getAttribute('notice')).toBe('failed')
    expect(textOf(n)).toContain('失败了 · Fake')
    expect(textOf(n)).toContain('原因：假 agent 按要求失败')
    expect(lastText(requests[2]!)).toContain('原因：假 agent 按要求失败')
    close(h)
  })

  it('任务被手动停止：不回报，Genet 不跑', async () => {
    const h = await home()
    const requests = script(callTool('toolu_d', 'dispatch_task', { agent: 'fake', title: '停掉它', task: '断线续' }), say('派好了'))
    await send(h, '派个活')
    await settled(h.sse, 1)
    const [task] = await taskPages(h.pageId)
    expect((await postJson(`/api/pages/${task}/stop`, h.cookie)).status).toBe(200)
    await waitFor(() => reported(task!))
    await quiet(h, 1)
    expect(notices(h.doc)).toEqual([])
    expect(requests).toHaveLength(2)
    close(h)
  })

  it('Genet 正忙时两个任务先后做完：通知照写、只排一条，Genet 这一轮结束后只多跑一轮，看得到两条通知', async () => {
    const h = await home()
    const gate = Promise.withResolvers<void>()
    const requests = script(
      callTool('toolu_1', 'dispatch_task', { agent: 'fake', title: '一号', task: '一号' }),
      callTool('toolu_2', 'dispatch_task', { agent: 'fake', title: '二号', task: '二号' }),
      after(gate.promise, say('都派好了')),
      say('两个都做完了'),
    )
    await send(h, '派两个活')
    await waitFor(() => notices(h.doc).length === 2, 20_000)
    const queued = await pool.query<{ kind: string }>('SELECT kind FROM send_queue WHERE page_id = $1', [h.pageId])
    expect(queued.rows.map((r) => r.kind)).toEqual(['continue'])
    gate.resolve()
    await quiet(h, 2)
    expect(requests).toHaveLength(4)
    const woke = lastText(requests[3]!)
    expect(woke).toContain('[Ramet 的任务通知]')
    expect(woke.match(/\[Ramet 任务通知：不是用户发的\]/g)).toHaveLength(2)
    close(h)
  })
})

describe('wait_task', () => {
  it('等到结局：结果交给 Genet，不另写通知、不多跑一轮', async () => {
    const h = await home()
    const requests = script(callTool('toolu_d', 'dispatch_task', { agent: 'fake', title: '等我', task: '慢慢来' }), waitTask, say('拿到了'))
    await send(h, '派个活，等它做完')
    await quiet(h, 1)
    expect(lastResult(requests[2]!)).toContain('等我 · 已完成 · Fake')
    expect(lastResult(requests[2]!)).toContain('piece9')
    const [task] = await taskPages(h.pageId)
    expect(await reported(task!)).toBe(true)
    expect(notices(h.doc)).toEqual([])
    expect(requests).toHaveLength(3)
    close(h)
  })

  it('任务在等审批：提前返回「在等用户批准」；批准后做完照常回报', async () => {
    const h = await home()
    const requests = script(
      callTool('toolu_d', 'dispatch_task', { agent: 'fake', title: '要批', task: '需要权限' }),
      waitTask,
      say('在等你批'),
      say('批完做好了'),
    )
    await send(h, '派个活，等它做完')
    await settled(h.sse, 1)
    expect(lastResult(requests[2]!)).toContain('在等用户批准')
    const [task] = await taskPages(h.pageId)
    expect(await reported(task!)).toBe(false)
    const inbox = (await (await fetch(`${base}/api/inbox`, { headers: { cookie: h.cookie } })).json()) as {
      items: Array<{ type: string; pageId?: string; agentId?: string; requestId?: string }>
    }
    const ask = inbox.items.find((i) => i.type === 'approval' && i.pageId === task)!
    expect((await answerPermission(task!, h.cookie, { agentId: ask.agentId!, requestId: ask.requestId! } as never, 'allow')).status).toBe(200)
    await quiet(h, 2)
    await waitFor(() => notices(h.doc).length === 1)
    expect(textOf(notices(h.doc)[0]!)).toContain('granted:allow')
    close(h)
  })

  it('停掉 Genet 这一轮：等待作废，任务做完照常回报', async () => {
    const h = await home()
    const requests = script(callTool('toolu_d', 'dispatch_task', { agent: 'fake', title: '慢活', task: '断线续' }), waitTask, say('醒了'))
    await send(h, '派个活，等它做完')
    await waitFor(() => requests.length === 2)
    await new Promise((r) => setTimeout(r, 300))
    expect((await postJson(`/api/pages/${h.pageId}/stop`, h.cookie)).status).toBe(200)
    await settled(h.sse, 1)
    await quiet(h, 2)
    await waitFor(() => notices(h.doc).length === 1)
    expect(textOf(notices(h.doc)[0]!)).toContain('after')
    // 停止时假模型不认中止信号，可能多答一次工具结果；叫醒的那一轮是最后一次请求
    expect(lastText(requests.at(-1)!)).toContain('[Ramet 任务通知：不是用户发的]')
    close(h)
  }, 30_000)

  it('端点只认 Genet 页上的 Genet 凭证（403），只能等自己 Genet 页下的任务页（404）；工具表里有 wait_task', async () => {
    const h = await home()
    const post = (token: string, body: unknown) =>
      fetch(`${base}/api/ramet/wait-task`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const otherAgent = mintPageToken(h.userId, 'fake', { pageId: h.pageId, agentId: 'fake', canDispatch: true })
    expect((await post(otherAgent, { page: `page:${h.otherPage}` })).status).toBe(403)
    const mine = mintPageToken(h.userId, ASSISTANT_ID, { pageId: h.pageId, agentId: ASSISTANT_ID, canDispatch: true })
    expect((await post(mine, { page: `page:${h.otherPage}` })).status).toBe(404)
    expect((await post(mine, {})).status).toBe(400)
    const listed = (await (await fetch(`${base}/api/ramet/tools`, { headers: { authorization: `Bearer ${mine}` } })).json()) as { tools: string[] }
    expect(listed.tools).toEqual(expect.arrayContaining(['dispatch_task', 'wait_task']))
    close(h)
  })
})
