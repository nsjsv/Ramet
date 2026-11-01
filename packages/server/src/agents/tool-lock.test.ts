/* ---------- 一页一种工具（真库 + 本机假 agent fake / claude：两个不同的工具）----------
 * 页面第一块回复用的工具锁定这一页：接着对话的那一轮（continue / 消息 attrs / 重新生成 / 排队派发）换成别的工具 → 409 tool-locked；
 * 同一工具换机器照常。混用过的老页面按第一块回复锁。显式 @ 点名（与它产出的回复的重新生成）、run_agent 的被叫各用自己的会话，不受限。
 * SSE 首帧带 tool_lock，第一块回复的占位块建好时再广播一次。 */
import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { encodeStats } from '@ramet/shared/reply-stats'
import { mintPageToken } from '../page-read.js'
import {
  base,
  connectDoc,
  continuePage,
  errorCode,
  pageOwnership,
  postJson,
  replyAgent,
  replyBlocks,
  serverReplies,
  settled,
  setupPage,
  SSECollector,
  startConnector,
  userMessage,
  waitFor,
} from './test-kit.js'
import type { AgentEvent } from './types.js'

type Ctx = { cookie: string; pageId: string; a: HocuspocusProvider; sse: SSECollector; n: number }

async function start(): Promise<Ctx> {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  return { cookie, pageId, a, sse, n: 0 }
}

function stop(c: Ctx): void {
  c.sse.stop()
  c.a.destroy()
}

/** 发一条消息跑完一轮（期望 202） */
async function turn(c: Ctx, text: string, agent: string, attrs: Record<string, string> = {}): Promise<void> {
  userMessage(c.a.document, text, attrs)
  expect(await continuePage(c.pageId, c.cookie, { agent })).toBe(202)
  const n = ++c.n
  await settled(c.sse, n)
  await waitFor(() => (replyBlocks(c.a)[n - 1]?.outcome ?? 'run') !== 'run')
}

/** 一条只 @ 了某个 agent 的用户消息（与前端落的形状一致：段落里的 agent_mention 元素） */
function mentionMessage(doc: Y.Doc, agentId: string): void {
  const frag = doc.getXmlFragment('prosemirror')
  const msg = new Y.XmlElement('user_message')
  const p = new Y.XmlElement('paragraph')
  msg.insert(0, [p])
  frag.insert(frag.length, [msg])
  const m = new Y.XmlElement('agent_mention')
  m.setAttribute('agentId', agentId)
  m.setAttribute('label', agentId)
  p.insert(0, [m])
}

const locks = (events: AgentEvent[]): string[] => events.flatMap((e) => (e.type === 'tool_lock' ? [e.tool] : []))

/** 新订阅者首帧里的 tool_lock */
async function firstFrameLock(pageId: string, cookie: string): Promise<string> {
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  const ev = await sse.wait((e) => e.type === 'tool_lock')
  sse.stop()
  return ev.type === 'tool_lock' ? ev.tool : ''
}

function continueRes(pageId: string, cookie: string, body: Record<string, unknown>): Promise<Response> {
  return postJson(`/api/pages/${pageId}/continue`, cookie, body)
}

async function expectLocked(res: Response, tool: string): Promise<void> {
  expect(res.status).toBe(409)
  const body = (await res.json()) as { error?: string; message?: string }
  expect(body).toEqual({ error: 'tool-locked', message: `这个对话用的是 ${tool}，换工具请新开一页` })
}

test('没有回复不锁；第一轮跑完 SSE 推 tool_lock，新订阅者首帧就是锁定的工具', async () => {
  const c = await start()
  await c.sse.wait((e) => e.type === 'tool_lock')
  expect(locks(c.sse.events)).toEqual([''])
  await turn(c, '第一问', 'claude')
  await waitFor(() => locks(c.sse.events).length === 2)
  expect(locks(c.sse.events)).toEqual(['', 'claude'])
  expect(await firstFrameLock(c.pageId, c.cookie)).toBe('claude')
  // 第二轮不再广播（锁已经定了）
  await turn(c, '第二问', 'claude')
  expect(locks(c.sse.events)).toEqual(['', 'claude'])
  stop(c)
})

test('用别的工具继续（请求体 / 消息 attrs）→ 409 tool-locked，不建占位块；没指定 agent 时只在锁定的工具里回落', async () => {
  const c = await start()
  await turn(c, '第一问', 'claude')
  userMessage(c.a.document, '换个工具')
  await expectLocked(await continueRes(c.pageId, c.cookie, { agent: 'fake' }), 'claude')
  userMessage(c.a.document, '消息里指定别的工具', { agent: 'fake' })
  await expectLocked(await continueRes(c.pageId, c.cookie, { agent: 'claude' }), 'claude')
  expect(replyBlocks(c.a)).toHaveLength(1)

  // 目录第一个是 fake：没指定时回落到锁定的 claude，而不是目录第一个
  userMessage(c.a.document, '不指定')
  expect(await continuePage(c.pageId, c.cookie, {})).toBe(202)
  await settled(c.sse, 2)
  await waitFor(() => replyBlocks(c.a)[1]?.outcome === 'end')
  const agents: string[] = []
  c.a.document.getXmlFragment('prosemirror').forEach((n) => {
    if (n instanceof Y.XmlElement && n.nodeName === 'agent_reply') agents.push(String(n.getAttribute('agent')))
  })
  expect(agents).toEqual(['claude', 'claude'])
  stop(c)
})

test('@ 点名别的工具照常跑，页面的锁不变；它的回复能重新生成；之后不 @ 的一轮仍只能用锁定的工具', async () => {
  const c = await start()
  await turn(c, '第一问', 'fake')
  mentionMessage(c.a.document, 'claude')
  expect(await continuePage(c.pageId, c.cookie, { agent: 'fake' })).toBe(202)
  await settled(c.sse, 2)
  await waitFor(() => replyBlocks(c.a)[1]?.outcome === 'end')
  expect(replyAgent(c.a)).toBe('claude')
  expect(locks(c.sse.events)).toEqual(['', 'fake'])
  expect(await firstFrameLock(c.pageId, c.cookie)).toBe('fake')

  // @ 出来的回复是合法产生的：重新生成照常（用它自己的工具）
  const mentioned = replyBlocks(c.a)[1]!.id
  expect((await postJson(`/api/pages/${c.pageId}/replies/${mentioned}/regenerate`, c.cookie)).status).toBe(202)
  await settled(c.sse, 3)
  await waitFor(() => replyBlocks(c.a)[1]?.outcome === 'end')
  expect(replyAgent(c.a)).toBe('claude')

  userMessage(c.a.document, '不 @ 了')
  await expectLocked(await continueRes(c.pageId, c.cookie, { agent: 'claude' }), 'fake')
  stop(c)
})

test('同一工具换一台机器：照常', async () => {
  const c = await start()
  const { spaceId, ownerId } = await pageOwnership(c.pageId)
  const box = await startConnector({ spaceId, ownerId, name: 'boxa', cookie: c.cookie })
  await turn(c, '第一问', 'fake')
  await turn(c, '换到 boxa', `c:${box}:fake`)
  expect(replyAgent(c.a)).toBe(`c:${box}:fake`)
  await expectLocked(await continueRes(c.pageId, c.cookie, { agent: `c:${box}:claude` }), 'fake')
  stop(c)
}, 60_000)

/** 直接往文档里放一块已收尾的回复（模拟混用过工具的老页面） */
function oldReply(doc: Y.Doc, agent: string, text: string): string {
  const id = randomUUID()
  const el = new Y.XmlElement('agent_reply')
  el.setAttribute('id', id)
  el.setAttribute('agent', agent)
  el.setAttribute('stats', encodeStats({ o: 'end' }))
  const p = new Y.XmlElement('paragraph')
  const t = new Y.XmlText()
  t.insert(0, text)
  p.insert(0, [t])
  el.insert(0, [p])
  const frag = doc.getXmlFragment('prosemirror')
  frag.insert(frag.length, [el])
  return id
}

test('混用过的老页面按第一块回复锁：别的工具继续 / 重新生成它留下的回复 → 409；重新生成第一块照常', async () => {
  const c = await start()
  userMessage(c.a.document, '第一问')
  const first = oldReply(c.a.document, 'fake', '旧回答一')
  userMessage(c.a.document, '第二问')
  const second = oldReply(c.a.document, 'claude', '旧回答二')
  await waitFor(async () => (await serverReplies(c.pageId, c.cookie)).length === 2)
  expect(await firstFrameLock(c.pageId, c.cookie)).toBe('fake')

  userMessage(c.a.document, '第三问')
  await expectLocked(await continueRes(c.pageId, c.cookie, { agent: 'claude' }), 'fake')
  await expectLocked(await postJson(`/api/pages/${c.pageId}/replies/${second}/regenerate`, c.cookie), 'fake')

  expect((await postJson(`/api/pages/${c.pageId}/replies/${first}/regenerate`, c.cookie)).status).toBe(202)
  await settled(c.sse, 1)
  await waitFor(() => replyBlocks(c.a)[0]?.outcome === 'end' && replyBlocks(c.a)[0]?.text !== '旧回答一')
  stop(c)
})

test('锁定的工具一台都没有：不指定 agent → 409「现在没有可用的 …」，不回落到别的工具；显式 @ 别的工具照常跑', async () => {
  const c = await start()
  userMessage(c.a.document, '第一问')
  oldReply(c.a.document, 'codex', '旧回答')
  await waitFor(async () => (await serverReplies(c.pageId, c.cookie)).length === 1)
  userMessage(c.a.document, '第二问')
  const res = await continueRes(c.pageId, c.cookie, { agent: '' })
  expect(res.status).toBe(409)
  expect(await res.json()).toEqual({ error: 'tool-locked', message: '这个对话用的是 codex，现在没有可用的 codex' })

  mentionMessage(c.a.document, 'fake')
  expect(await continuePage(c.pageId, c.cookie, { agent: '' })).toBe(202)
  await settled(c.sse, 1)
  await waitFor(() => replyBlocks(c.a)[1]?.outcome === 'end')
  expect(replyAgent(c.a)).toBe('fake')
  stop(c)
})

test('排队派发选到别的工具：丢掉这条并广播原因，消息不写进文档', async () => {
  const c = await start()
  await turn(c, '第一问', 'fake')
  const before = c.a.document.getXmlFragment('prosemirror').length
  const res = await postJson(`/api/pages/${c.pageId}/queue`, c.cookie, { agent: 'claude', kind: 'message', text: '排着的消息' })
  expect(res.status).toBe(201)
  const dropped = await c.sse.wait((e) => e.type === 'queue_dropped')
  expect(dropped).toMatchObject({ reason: '这个对话用的是 fake，换工具请新开一页' })
  expect(c.a.document.getXmlFragment('prosemirror').length).toBe(before)
  expect(await errorCode(await continueRes(c.pageId, c.cookie, { agent: 'claude' }))).toBe('tool-locked')
  stop(c)
})

test('run_agent 的被叫不受锁定：锁定为 fake 的页面里照样能叫 claude', async () => {
  const c = await start()
  await turn(c, '第一问', 'fake')
  const { ownerId } = await pageOwnership(c.pageId)
  const token = mintPageToken(ownerId, 'fake', { pageId: c.pageId, agentId: 'fake', canDispatch: true })
  const res = await fetch(`${base}/api/ramet/run-agent`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'claude', task: '回显提示词 子任务' }),
  })
  expect(res.status).toBe(200)
  const out = JSON.parse((await res.text()).trim()) as { outcome: string; output: string }
  expect(out.outcome).toBe('end')
  expect(out.output).toContain('回显提示词 子任务')
  stop(c)
})
