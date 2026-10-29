/* ---------- 一轮 run 的端到端不变量（假 ACP agent） ----------
 * 运行中正文只走 SSE、文档里只有占位;收尾一次写入最后一段的块结构 + stats + 过程页;
 * 过程页是 runs 表里的 record(读接口 + 权限);服务关停也收尾。关停用例必须放最后(它关掉了本文件的服务)。 */
import { expect, test } from 'vitest'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { decodeStats } from '@ramet/shared/reply-stats'
import { decodePlan } from '@ramet/shared/run-model'
import { ReplyWriter } from './agents/doc.js'
import { loadDocFromDb } from './collab.js'
import {
  base,
  connectDoc,
  continuePage,
  insertUser,
  login,
  pool,
  s,
  setupPage,
  SSECollector,
  userMessage,
  waitFor,
} from './agents/test-kit.js'

function lastReply(doc: Y.Doc): Y.XmlElement | null {
  let found: Y.XmlElement | null = null
  doc.getXmlFragment('prosemirror').forEach((c) => {
    if (c instanceof Y.XmlElement && c.nodeName === 'agent_reply') found = c
  })
  return found
}

function textOfReply(reply: Y.XmlElement): string {
  const walk = (n: Y.XmlElement | Y.XmlText): string =>
    n instanceof Y.XmlText
      ? (n.toDelta() as Array<{ insert?: unknown }>).map((d) => (typeof d.insert === 'string' ? d.insert : '')).join('')
      : n.toArray().map((c) => walk(c as Y.XmlElement)).join('')
  return walk(reply)
}

const replyOf = (p: HocuspocusProvider): Y.XmlElement | null => lastReply(p.document)

test('ACP 计划:实时整份替换走 SSE;收尾落到回复块的 plan 属性与过程页 record;重新生成会清掉', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '计划验收')
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  expect(await continuePage(pageId, cookie)).toBe(202)
  const done = await sse.wait((e) => e.type === 'status' && e.state === 'done')
  sse.stop()

  // 两次 plan 事件都是整份(第二份替换第一份,不是追加);不是工具步骤
  const plans = sse.events.filter((e) => e.type === 'plan')
  expect(plans).toHaveLength(2)
  expect(plans[1]).toMatchObject({
    entries: [
      { content: '读代码', status: 'completed', priority: 'high' },
      { content: '写测试', status: 'in_progress', priority: 'medium' },
    ],
  })
  expect(sse.events.some((e) => e.type === 'step')).toBe(false)

  // 收尾:回复块带 plan 属性(最后一份),不进提示词文字
  await waitFor(() => decodeStats(replyOf(a)?.getAttribute('stats')).o === 'end')
  const reply = replyOf(a)!
  expect(decodePlan(reply.getAttribute('plan'))).toEqual([
    { content: '读代码', status: 'completed', priority: 'high' },
    { content: '写测试', status: 'in_progress', priority: 'medium' },
  ])
  expect(textOfReply(reply)).toBe('计划好了')

  // 过程页 record 同样带着(只列计划的回合也归档了)
  const runPageId = done.type === 'status' ? done.runPageId : undefined
  expect(runPageId).toBeTruthy()
  const res = await fetch(`${base}/api/runs/${runPageId}`, { headers: { cookie } })
  const body = await res.json() as { record: { plan?: unknown } }
  expect(body.record.plan).toEqual(decodePlan(reply.getAttribute('plan')))

  // 重新生成(同一块复位)时旧计划立刻清掉,不会带到下一轮开头
  const writer = ReplyWriter.bind(a.document, String(reply.getAttribute('id')))!
  writer.reset()
  expect(replyOf(a)!.getAttribute('plan')).toBeUndefined()
  // 没有计划的收尾不留属性(也不留空串)
  writer.finalize('只有文字', 'o:end', null)
  expect(replyOf(a)!.getAttribute('plan')).toBeUndefined()
  writer.finalize('又有了', 'o:end', null, [{ content: '一件事', status: 'pending' }])
  expect(decodePlan(replyOf(a)!.getAttribute('plan'))).toEqual([{ content: '一件事', status: 'pending' }])
})

test('多段回复:实时走 SSE、文档只收最后一段;说明/思考/工具进过程页;用量进 stats', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '多段')
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  expect(await continuePage(pageId, cookie)).toBe(202)

  // 运行开始:快照指明正在写的占位块
  const start = await sse.wait((e) => e.type === 'run')
  const replyId = start.type === 'run' ? start.replyId : ''
  expect(replyId).toBeTruthy()
  const done = await sse.wait((e) => e.type === 'status' && e.state === 'done')
  sse.stop()

  // 换段:said 在第二段的正文之前;只吐空白的那次不触发
  const types = sse.events.map((e) => e.type)
  expect(types.filter((t) => t === 'said')).toHaveLength(1)
  const secondReply = sse.events.findIndex((e) => e.type === 'reply' && e.d.includes('结论'))
  expect(types.indexOf('said')).toBeLessThan(secondReply)
  expect(types).not.toContain('steps')

  // 文档:同一个块(id 不变),内容只有最后一段的块结构,stats 是终态
  await waitFor(() => decodeStats(replyOf(a)?.getAttribute('stats')).o === 'end')
  const reply = replyOf(a)!
  expect(reply.getAttribute('id')).toBe(replyId)
  expect(reply.toArray().map((c) => (c as Y.XmlElement).nodeName)).toEqual(['heading', 'paragraph'])
  expect(textOfReply(reply)).toBe('结论好了')
  const stats = decodeStats(reply.getAttribute('stats'))
  expect(stats).toMatchObject({ o: 'end', st: 2, tk: 1500, in: 1000, out: 200, cr: 300, cu: 38000, cs: 200000 })
  expect('cw' in stats).toBe(false)

  // 过程页:runs record(思考 → 说明 → 工具 → 思考 → 失败工具带一行摘要)
  const runPageId = done.type === 'status' ? done.runPageId : undefined
  expect(reply.getAttribute('run')).toBe(runPageId)
  const res = await fetch(`${base}/api/runs/${runPageId}`, { headers: { cookie } })
  expect(res.status).toBe(200)
  const body = await res.json() as {
    record: { outcome: string; replyId: string; entries: Array<{ k: string; text?: string; status?: string; note?: string }> }
    parent: { id: string } | null
  }
  expect(body.record.replyId).toBe(replyId)
  expect(body.parent?.id).toBe(pageId)
  expect(body.record.entries.map((e) => e.k)).toEqual(['thought', 'say', 'tool', 'thought', 'tool'])
  expect(body.record.entries[1]).toMatchObject({ k: 'say', text: '我先看看' })
  expect(body.record.entries[4]).toMatchObject({ status: 'failed', note: '2 failed · doc.test.ts' })
  const { rows } = await pool.query<{ content_text: string }>('SELECT content_text FROM pages WHERE id = $1', [runPageId])
  expect(rows[0]!.content_text).toContain('我先看看')

  // 非成员看不到
  await insertUser('mallory')
  const other = await login('mallory')
  expect((await fetch(`${base}/api/runs/${runPageId}`, { headers: { cookie: other } })).status).toBe(404)
  a.destroy()
}, 20_000)

test('运行中文档里只有空占位(o:run),不收任何正文', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '慢慢来')
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  await continuePage(pageId, cookie)
  await sse.wait((e) => e.type === 'reply' && e.d.includes('piece2'))
  await waitFor(() => replyOf(a) !== null)
  expect(decodeStats(replyOf(a)!.getAttribute('stats')).o).toBe('run')
  expect(textOfReply(replyOf(a)!)).toBe('')
  await fetch(`${base}/api/pages/${pageId}/stop`, { method: 'POST', headers: { cookie } })
  await sse.wait((e) => e.type === 'status' && e.state === 'done')
  await waitFor(() => decodeStats(replyOf(a)?.getAttribute('stats')).o === 'cancelled')
  expect(textOfReply(replyOf(a)!)).toContain('piece0')
  sse.stop()
  a.destroy()
}, 20_000)

test('服务关停:在跑的一轮也收尾(回复写进文档、结果记 error)', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '慢慢来')
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  await continuePage(pageId, cookie)
  await sse.wait((e) => e.type === 'reply' && e.d.includes('piece0'))
  a.destroy()
  sse.stop()
  await s.close()
  const reply = lastReply(await loadDocFromDb(pool, `page:${pageId}`))
  expect(reply).not.toBeNull()
  expect(decodeStats(reply!.getAttribute('stats')).o).toBe('error')
  expect(textOfReply(reply!)).toContain('piece0')
}, 20_000)
