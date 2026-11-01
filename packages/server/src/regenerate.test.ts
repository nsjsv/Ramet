/* ---------- 重新生成 / 重试（全栈：本机 fake agent）----------
 *   - 块 id 不变、内容原地换掉（引用 / 收藏跟着新回答走）；动手前写一张快照，旧回答在历史里
 *   - 重做的视图是目标回复之前的全部内容，一律新建会话全文重放（会话不能分叉）；新会话看到的是目标回复为止。
 *     下一轮接着这个新会话：回复在页尾只发新消息，在页中间则把它之后的内容带署名补发 + 新消息
 *   - 失败 / 停止的最后一块回复的「重试 / 继续」是续跑（resume.test.ts），不走这里 */
import { expect, test } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import {
  agentSession,
  connectDoc,
  continuePage,
  errorCode,
  joinPageSpace,
  postJson,
  replyBlocks,
  savedConfigs,
  serverReplies,
  settled,
  setupPage,
  snapshotTexts,
  SSECollector,
  userMessage,
  waitFor,
} from './agents/test-kit.js'

const regenerate = (pageId: string, cookie: string, replyId: string) =>
  postJson(`/api/pages/${pageId}/replies/${replyId}/regenerate`, cookie)

/** 手写一块 agent_reply 进文档（测入口校验：没有用户消息在前、agent 已不可用） */
function handWrittenReply(p: HocuspocusProvider, id: string, agent: string): void {
  const reply = new Y.XmlElement('agent_reply')
  reply.setAttribute('id', id)
  reply.setAttribute('agent', agent)
  reply.insert(0, [new Y.XmlElement('paragraph')])
  const frag = p.document.getXmlFragment('prosemirror')
  frag.insert(frag.length, [reply])
}

test('重新生成（页尾）：块 id 不变、内容原地换掉、新会话全文重放、旧回答在历史里；下一轮照常增量', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)

  userMessage(a.document, '第一问')
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  await settled(sse, 1)
  const [first] = await serverReplies(pageId, cookie)
  expect(first?.text).toContain('model=m1')
  const firstSession = (await agentSession(pageId))!.fake!.sessionId

  // 页面级改模型：重新生成要是真的重跑了一遍，新回答里就看得到 m2
  expect((await postJson(`/api/pages/${pageId}/agent-config`, cookie, { agent: 'fake', configId: 'model', value: 'm2' })).status).toBe(200)
  expect((await regenerate(pageId, cookie, first!.id)).status).toBe(202)
  await settled(sse, 2)

  const after = await serverReplies(pageId, cookie)
  expect(after).toHaveLength(1) // 原地换，不是再插一块
  expect(after[0]).toMatchObject({ id: first!.id, outcome: 'end' })
  expect(after[0]!.text).toContain('model=m2')
  expect(after[0]!.text).not.toContain('model=m1')
  // 会话不能分叉，旧会话已经看过旧回答：重做一律新会话、全文重放
  expect(after[0]!.text).toContain('turn:full')
  expect((await agentSession(pageId))!.fake!.sessionId).not.toBe(firstSession)
  // 旧回答在历史里：动手前写的那张快照（不靠 5 分钟去重窗口或 agent 写入的时机）
  expect((await snapshotTexts(pageId)).some((t) => t.includes('model=m1'))).toBe(true)

  // 回复在页尾、视图没变：下一轮照常增量（同一会话，只发最后一问）
  await waitFor(() => replyBlocks(a)[0]?.text.includes('model=m2') === true)
  userMessage(a.document, '第二问')
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  await settled(sse, 3)
  const last = (await serverReplies(pageId, cookie)).at(-1)
  expect(last?.text).toContain('turn:delta')
  expect(last?.text).toContain('model=m2')
  sse.stop()
  a.destroy()
})

test('重新生成（页中间）：agent 只看到目标回复之前的内容；下一轮接着重做建的会话，补发它之后的内容', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)

  // 报视图：让 agent 回显它看到的用户消息行数、回复行数和会话 id
  userMessage(a.document, '报视图 第一问')
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  await settled(sse, 1)
  await waitFor(() => replyBlocks(a)[0]?.outcome === 'end')
  userMessage(a.document, '第二问')
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  await settled(sse, 2)
  const [r1, r2] = await serverReplies(pageId, cookie)
  expect(r1!.text).toMatch(/^view:1:0@/)
  expect(r2!.text).toContain('turn:delta')

  // 重做第一条回复：视图是它之前的内容（只有第一问），不是整页（整页会是 2:1）
  expect((await regenerate(pageId, cookie, r1!.id)).status).toBe(202)
  await settled(sse, 3)
  const mid = await serverReplies(pageId, cookie)
  expect(mid.map((r) => r.id)).toEqual([r1!.id, r2!.id])
  expect(mid[0]!.text).toMatch(/^view:1:0@/)
  expect(mid[0]!.text).not.toBe(r1!.text) // 会话 id 变了，即新会话
  expect(mid[1]).toEqual(r2) // 它之后的回复不动
  const redoSession = (await agentSession(pageId))!.fake!
  expect(redoSession.seen).toBe(r1!.id) // 新会话看到的是被重做的那一块为止

  // 下一轮：接着重做建的会话，目标回复之后的内容（第二问与它的回复）带署名补发，再加新消息。
  // 只发新消息就漏了第二问；全文重放就白丢了会话
  await waitFor(() => replyBlocks(a)[0]?.text === mid[0]!.text)
  userMessage(a.document, '回显提示词 第三问')
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  await settled(sse, 4)
  const prompt = (await serverReplies(pageId, cookie)).at(-1)!.text
  expect((await agentSession(pageId))!.fake!.sessionId).toBe(redoSession.sessionId)
  expect(prompt.startsWith('<ramet-catch-up>\n')).toBe(true)
  expect(prompt).toContain('[用户的消息]\n>> 第二问')
  expect(prompt).toContain(`[Fake 的回复]\n> ${r2!.text.split('\n')[0]}`)
  expect(prompt.endsWith('</ramet-catch-up>\n\n回显提示词 第三问')).toBe(true)
  expect(prompt).not.toContain('第一问')
  sse.stop()
  a.destroy()
})

test('重新生成沿用那条用户消息的 cwd / 配置覆盖（优先级同 continue），覆盖不落成页面级', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  const dir = await mkdtemp(join(tmpdir(), 'ramet-regen-'))

  userMessage(a.document, '报目录 第一问', { cwd: dir, opts: 'model=m2' })
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  await settled(sse, 1)
  const [first] = await serverReplies(pageId, cookie)
  expect(first?.text).toContain(`cwd:${dir}`)
  expect(first?.text).toContain('model=m2')
  const firstSession = (await agentSession(pageId))!.fake!.sessionId

  expect((await regenerate(pageId, cookie, first!.id)).status).toBe(202)
  await settled(sse, 2)
  const [again] = await serverReplies(pageId, cookie)
  expect(again).toMatchObject({ id: first!.id, outcome: 'end' })
  expect(again!.text).toContain(`cwd:${dir}`)
  expect(again!.text).toContain('model=m2')
  const session = (await agentSession(pageId))!.fake!
  expect(session.sessionId).not.toBe(firstSession)
  expect(session.cwd).toBe(dir)
  // 临时覆盖（含轮末还原）不能把一个页面从没设过的 model 钉成页面级意图
  expect((await savedConfigs(pageId)).fake?.model).toBeUndefined()
  sse.stop()
  a.destroy()
})

test('入口校验：找不到回复 404；之前没有用户消息 / agent 已不可用 400；旁观者 404', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  expect((await regenerate(pageId, cookie, 'nope')).status).toBe(404)

  // 一块前面没有用户消息的回复
  handWrittenReply(a, 'orphan', 'fake')
  await waitFor(async () => (await regenerate(pageId, cookie, 'orphan')).status !== 404)
  const noMessage = await regenerate(pageId, cookie, 'orphan')
  expect(noMessage.status).toBe(400)
  expect(await errorCode(noMessage)).toBe('no user message')

  // 前面有用户消息，但这块回复的 agent 已经不可用
  userMessage(a.document, '你好')
  handWrittenReply(a, 'ghost', 'ghost-agent')
  await waitFor(async () => (await regenerate(pageId, cookie, 'ghost')).status !== 404)
  const unknown = await regenerate(pageId, cookie, 'ghost')
  expect(unknown.status).toBe(400)
  expect(await errorCode(unknown)).toBe('unknown agent')

  const viewer = await joinPageSpace(pageId, 'viewer1', { role: 'viewer' })
  expect((await regenerate(pageId, viewer, 'ghost')).status).toBe(404)
  a.destroy()
})

test('页面忙时重新生成 → 409（和 continue 同一把锁）', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)

  userMessage(a.document, '第一问')
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  await settled(sse, 1)
  const [first] = await serverReplies(pageId, cookie)
  await waitFor(() => replyBlocks(a)[0]?.outcome === 'end')

  userMessage(a.document, '慢慢来')
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  await sse.wait((e) => e.type === 'reply' && e.d.includes('piece0'))
  const busy = await regenerate(pageId, cookie, first!.id)
  expect(busy.status).toBe(409)
  expect(await errorCode(busy)).toBe('busy')

  expect((await postJson(`/api/pages/${pageId}/stop`, cookie)).status).toBe(200)
  await settled(sse, 2)
  sse.stop()
  a.destroy()
})
