/* ---------- 运行中排队发送（真库 + 假 agent，agents/send-queue.ts）----------
 * 排着的消息存在服务端；这一轮正常结束后服务端以排队的人的身份写进文档并发起下一轮。
 * 出错 / 手动停止 → 暂停不发；立即发送 = 插队（停下当前这一轮后马上发）；页面空着时入队直接发；
 * 撤回 / 立即发送只有排的人自己能做；排的人失权 → 派发时丢掉并广播原因。
 * 「慢慢来」让假 agent 跑约 1.5 秒（10 片），够在它跑着时入队。 */
import { expect, test } from 'vitest'
import { base, connectDoc, continuePage, docText, joinPageSpace, postJson, setupPage, SSECollector, userMessage, waitFor } from './agents/test-kit.js'
import type { AgentEvent } from './agents/types.js'

type QueueEv = Extract<AgentEvent, { type: 'queue' }>

const queue = (pageId: string, cookie: string, body: Record<string, unknown>) => postJson(`/api/pages/${pageId}/queue`, cookie, body)
const lastQueue = (sse: SSECollector): QueueEv | undefined => [...sse.events].reverse().find((e): e is QueueEv => e.type === 'queue')

/** 开跑一轮「慢慢来」，等到它真的在吐字 */
async function startSlow(pageId: string, cookie: string, sse: SSECollector, doc: Parameters<typeof userMessage>[0]): Promise<void> {
  userMessage(doc, '慢慢来')
  expect(await continuePage(pageId, cookie)).toBe(202)
  await sse.wait((ev) => ev.type === 'reply' && ev.d.includes('piece0'))
}

test('跑着时入队：不进文档；这一轮正常结束后服务端写进文档并发起下一轮', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  await startSlow(pageId, cookie, sse, a.document)

  const res = await queue(pageId, cookie, { agent: 'fake', kind: 'message', text: '排着的那句话' })
  expect(res.status).toBe(201)
  await sse.wait((ev) => ev.type === 'queue' && ev.items.length === 1)
  expect(docText(a)).not.toContain('排着的那句话')

  // 第一轮结束 → 排着的写进文档、第二轮开跑并跑完
  await waitFor(() => docText(a).includes('>> 排着的那句话'))
  await waitFor(() => sse.events.filter((e) => e.type === 'status' && e.state === 'done').length >= 2, 20_000)
  expect(lastQueue(sse)?.items).toEqual([])
  sse.stop()
  a.destroy()
})

test('手动停止 → 暂停不发；立即发送把它发出去', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  await startSlow(pageId, cookie, sse, a.document)
  const { item } = (await (await queue(pageId, cookie, { agent: 'fake', kind: 'message', text: '停了也别发' })).json()) as { item: { id: string } }
  expect((await fetch(`${base}/api/pages/${pageId}/stop`, { method: 'POST', headers: { cookie } })).status).toBe(200)
  await sse.wait((ev) => ev.type === 'queue' && ev.paused && ev.items.length === 1)
  expect(docText(a)).not.toContain('停了也别发')

  expect((await postJson(`/api/pages/${pageId}/queue/${item.id}/now`, cookie)).status).toBe(200)
  await waitFor(() => docText(a).includes('>> 停了也别发'))
  sse.stop()
  a.destroy()
})

test('立即发送 = 插队：停下当前这一轮后马上发', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  await startSlow(pageId, cookie, sse, a.document)
  await queue(pageId, cookie, { agent: 'fake', kind: 'message', text: '先排的' })
  const { item } = (await (await queue(pageId, cookie, { agent: 'fake', kind: 'message', text: '插队的' })).json()) as { item: { id: string } }
  expect((await postJson(`/api/pages/${pageId}/queue/${item.id}/now`, cookie)).status).toBe(200)
  await waitFor(() => docText(a).includes('>> 插队的'))
  expect(docText(a)).not.toContain('>> 先排的')
  sse.stop()
  a.destroy()
})

test('页面空着时入队直接发；撤回只有本人能做；排的人用不了这台机器 → 派发时丢掉并给原因', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  // 空着：直接发
  expect((await queue(pageId, cookie, { agent: 'fake', kind: 'message', text: '空着就直接发' })).status).toBe(201)
  await waitFor(() => docText(a).includes('>> 空着就直接发'))
  await sse.wait((ev) => ev.type === 'status' && ev.state === 'done')

  // 别人排的：我撤不回
  const bob = await joinPageSpace(pageId, 'bob', { role: 'member' })
  await startSlow(pageId, cookie, sse, a.document)
  const { item } = (await (await queue(pageId, bob, { agent: 'fake', kind: 'message', text: 'bob 的话' })).json()) as { item: { id: string } }
  const del = await fetch(`${base}/api/pages/${pageId}/queue/${item.id}`, { method: 'DELETE', headers: { cookie } })
  expect(del.status).toBe(403)
  // bob 不是本机 agent 的主人（只有 admin 是）：轮到他时被丢掉，原因广播出来，文档里没有他的话
  await sse.wait((ev) => ev.type === 'queue_dropped' && ev.id === item.id, 20_000)
  expect(docText(a)).not.toContain('bob 的话')
  sse.stop()
  a.destroy()
})
