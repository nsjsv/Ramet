/* ---------- 续跑（全栈：本机 fake agent）----------
 *   - 失败 / 停止的最后一块回复：同一个会话收到续跑说明，同一块回复接着写，过程页 id 不变、步骤接着记，
 *     中断时写到一半的正文挪进过程（一条说明），文档里不出现新的用户消息
 *   - 适配器重启后先加载原会话再续；加载不上就新建会话，提示词 = 回复之前的文档 + 失败那次的过程摘要 + 续跑说明
 *   - 不是最后一块 / 没有失败或停止 → 409 not-resumable（这类走重新生成）
 * 假 agent 的触发词：「中途断开」= 一步工具 + 「写到一半」后出错；「进程退出」= 一步工具 + 「退出前」后进程直接退出；
 * 续跑说明（[Ramet 续跑]）= 一步工具后回 `resumed@<会话 id> load:<恢复自|no>`，另含「回显提示词」再回显提示词。 */
import './resume-env.js'
import { expect, test } from 'vitest'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import type { RunEntry } from '@ramet/shared/run-model'
import type { RunRecordV1 } from './agents/run-record.js'
import {
  agentSession,
  connectDoc,
  continuePage,
  errorCode,
  pool,
  postJson,
  replyAttr,
  replyBlocks,
  serverReplies,
  settled,
  setupPage,
  SSECollector,
  userMessage,
  waitFor,
} from './agents/test-kit.js'

type Ctx = { cookie: string; pageId: string; a: HocuspocusProvider; sse: SSECollector }

async function start(): Promise<Ctx> {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  return { cookie, pageId, a, sse }
}

function stop(c: Ctx): void {
  c.sse.stop()
  c.a.destroy()
}

const resume = (pageId: string, cookie: string, replyId: string) => postJson(`/api/pages/${pageId}/replies/${replyId}/resume`, cookie)

/** 发一条消息跑一轮，等它收尾（第 n 轮） */
async function turn(c: Ctx, text: string, n: number, agent = 'fake'): Promise<void> {
  userMessage(c.a.document, text)
  expect(await continuePage(c.pageId, c.cookie, { agent })).toBe(202)
  await settled(c.sse, n)
  await waitFor(() => (replyBlocks(c.a)[n - 1]?.outcome ?? 'run') !== 'run')
}

async function runRecord(runPageId: string): Promise<RunRecordV1> {
  const { rows } = await pool.query<{ record: RunRecordV1 }>('SELECT record FROM runs WHERE page_id = $1', [runPageId])
  if (!rows[0]) throw new Error(`没有过程页 ${runPageId} 的档案`)
  return rows[0].record
}

/** 过程页正文里的步骤块：sid 与那一行字 */
async function runSteps(runPageId: string, cookie: string): Promise<Array<{ sid: string; text: string }>> {
  const p = await connectDoc(runPageId, cookie)
  const out: Array<{ sid: string; text: string }> = []
  p.document.getXmlFragment('prosemirror').forEach((c) => {
    if (c instanceof Y.XmlElement && c.nodeName === 'run_step') {
      out.push({ sid: String(c.getAttribute('sid') ?? ''), text: c.toArray().map((x) => (x instanceof Y.XmlText ? x.toString() : '')).join('') })
    }
  })
  p.destroy()
  return out
}

function userMessages(p: HocuspocusProvider): number {
  let n = 0
  p.document.getXmlFragment('prosemirror').forEach((c) => {
    if (c instanceof Y.XmlElement && c.nodeName === 'user_message') n++
  })
  return n
}

const toolIds = (entries: RunEntry[]) => entries.flatMap((e) => (e.k === 'tool' ? [e.id] : []))
const says = (entries: RunEntry[]) => entries.flatMap((e) => (e.k === 'say' ? [e.text] : []))

test('失败后续跑：同一个会话、同一块回复、过程页 id 不变，步骤接着记，半截正文进了过程，没有新的用户消息', async () => {
  const c = await start()
  await turn(c, '中途断开 第一问', 1)
  const [failed] = replyBlocks(c.a)
  expect(failed).toMatchObject({ outcome: 'error', text: '写到一半' })
  await waitFor(() => replyAttr(c.a, 'run') !== null)
  const runPage = replyAttr(c.a, 'run')!
  const before = await runRecord(runPage)
  const session = (await agentSession(c.pageId))!.fake!
  // 档案带上了续跑要的会话、目录与失败原因
  expect(before).toMatchObject({ sessionId: session.sessionId, cwd: session.cwd, outcome: 'error', output: '写到一半' })
  expect(before.error).toContain('假 agent 中途断开')
  expect(toolIds(before.entries)).toEqual(['mid-tool'])

  const res = await resume(c.pageId, c.cookie, failed!.id)
  expect(res.status).toBe(202)
  await settled(c.sse, 2)
  // 续跑一开跑就发快照：前端立刻看到中断前的步骤与半截正文
  expect(
    c.sse.events.some((e) => e.type === 'run' && e.replyId === failed!.id && e.state.text === '写到一半' && toolIds(e.state.entries).join() === 'mid-tool'),
  ).toBe(true)

  const after = await serverReplies(c.pageId, c.cookie)
  expect(after).toHaveLength(1)
  expect(after[0]).toMatchObject({ id: failed!.id, outcome: 'end' })
  // 同一个会话（本进程里还加载着，不必 load），回复正文只留续跑后的回答
  expect(after[0]!.text.startsWith(`resumed@${session.sessionId} load:no`)).toBe(true)
  expect(after[0]!.text).not.toContain('写到一半')
  await waitFor(() => replyBlocks(c.a)[0]?.outcome === 'end')
  expect(userMessages(c.a)).toBe(1)
  expect(replyAttr(c.a, 'run')).toBe(runPage)

  // 过程页还是那一页：档案 = 中断前 + 续跑后，半截正文成了一条说明
  const merged = await runRecord(runPage)
  expect(toolIds(merged.entries)).toEqual(['mid-tool', 'resume-tool'])
  expect(says(merged.entries)).toEqual(['写到一半'])
  expect(merged).toMatchObject({ replyId: failed!.id, sessionId: session.sessionId, outcome: 'end' })
  expect(merged.error).toBeUndefined()
  const steps = await runSteps(runPage, c.cookie)
  expect(steps.map((s) => s.sid)).toEqual(['mid-tool', 'say:1', 'resume-tool'])
  expect(steps[1]!.text).toBe('写到一半')
  // 没有另建过程页
  const { rows } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM pages WHERE parent_id = $1 AND kind = 'run'", [c.pageId])
  expect(Number(rows[0]!.n)).toBe(1)
  // 会话记录：看到的是这块回复，下一轮接着这个会话
  expect((await agentSession(c.pageId))!.fake).toMatchObject({ sessionId: session.sessionId, seen: failed!.id })
  stop(c)
})

test('停止后继续：同上，停下前的正文挪进过程', async () => {
  const c = await start()
  userMessage(c.a.document, '慢慢来')
  expect(await continuePage(c.pageId, c.cookie, { agent: 'fake' })).toBe(202)
  await c.sse.wait((e) => e.type === 'reply' && e.d.includes('piece0'))
  expect((await postJson(`/api/pages/${c.pageId}/stop`, c.cookie)).status).toBe(200)
  await settled(c.sse, 1)
  await waitFor(() => replyBlocks(c.a)[0]?.outcome === 'cancelled')
  const [stopped] = replyBlocks(c.a)
  expect(stopped!.text).toContain('piece0')
  await waitFor(() => replyAttr(c.a, 'run') !== null)
  const runPage = replyAttr(c.a, 'run')!
  const session = (await agentSession(c.pageId))!.fake!

  expect((await resume(c.pageId, c.cookie, stopped!.id)).status).toBe(202)
  await settled(c.sse, 2)
  const after = await serverReplies(c.pageId, c.cookie)
  expect(after).toHaveLength(1)
  expect(after[0]).toMatchObject({ id: stopped!.id, outcome: 'end' })
  expect(after[0]!.text.startsWith(`resumed@${session.sessionId} load:no`)).toBe(true)
  expect(after[0]!.text).not.toContain('piece0')
  await waitFor(() => replyBlocks(c.a)[0]?.outcome === 'end')
  expect(replyAttr(c.a, 'run')).toBe(runPage)
  expect(userMessages(c.a)).toBe(1)
  const merged = await runRecord(runPage)
  expect(says(merged.entries).some((t) => t.includes('piece0'))).toBe(true)
  expect(toolIds(merged.entries)).toEqual(['resume-tool'])
  stop(c)
})

test('失败一次后续跑（没有过程档案）：按会话记录接着原会话，块 id 不变，结果从出错变成功', async () => {
  const c = await start()
  userMessage(c.a.document, '失败一次 重试用例') // fake：同一段提示词只失败第一次
  expect(await continuePage(c.pageId, c.cookie, { agent: 'fake' })).toBe(202)
  const failure = await c.sse.wait((e) => e.type === 'error')
  await settled(c.sse, 1)
  const [failed] = await serverReplies(c.pageId, c.cookie)
  expect(failed?.outcome).toBe('error')
  // 失败原因只有一个落点：带上失败的那块回复的 id，前端把原因放进它的失败条
  if (failure.type !== 'error') throw new Error('不是错误事件')
  expect(failure.replyId).toBe(failed!.id)
  // 什么都没收到就失败了：没有过程页；会话记录在发出提示词前就记着这块
  const session = (await agentSession(c.pageId))!.fake!
  expect(session.seen).toBe(failed!.id)

  expect((await resume(c.pageId, c.cookie, failed!.id)).status).toBe(202)
  await settled(c.sse, 2)
  const after = await serverReplies(c.pageId, c.cookie)
  expect(after).toHaveLength(1)
  expect(after[0]).toMatchObject({ id: failed!.id, outcome: 'end' })
  expect(after[0]!.text.startsWith(`resumed@${session.sessionId} load:no`)).toBe(true)
  stop(c)
})

test('适配器重启后续跑：先加载原会话（会话 id 不变）再续', async () => {
  const c = await start()
  await turn(c, '进程退出 第一问', 1)
  const [failed] = replyBlocks(c.a)
  expect(failed).toMatchObject({ outcome: 'error', text: '退出前' })
  const session = (await agentSession(c.pageId))!.fake!

  expect((await resume(c.pageId, c.cookie, failed!.id)).status).toBe(202)
  await settled(c.sse, 2)
  const [after] = await serverReplies(c.pageId, c.cookie)
  expect(after).toMatchObject({ id: failed!.id, outcome: 'end' })
  // 新的 agent 进程里没有这个会话：先 load（load:<会话 id>）再发续跑说明
  expect(after!.text.startsWith(`resumed@${session.sessionId} load:${session.sessionId}`)).toBe(true)
  expect((await agentSession(c.pageId))!.fake).toMatchObject({ sessionId: session.sessionId, seen: failed!.id })
  stop(c)
})

test('会话加载不上：新建会话，提示词 = 回复之前的文档 + 失败那次的过程摘要 + 续跑说明', async () => {
  const c = await start()
  await turn(c, '回显提示词 进程退出 第一问', 1, 'noload')
  const [failed] = replyBlocks(c.a)
  expect(failed?.outcome).toBe('error')
  await waitFor(() => replyAttr(c.a, 'run') !== null)
  const runPage = replyAttr(c.a, 'run')!

  expect((await resume(c.pageId, c.cookie, failed!.id)).status).toBe(202)
  await settled(c.sse, 2)
  const [after] = await serverReplies(c.pageId, c.cookie)
  expect(after).toMatchObject({ id: failed!.id, outcome: 'end' })
  const prompt = after!.text
  expect(prompt).toContain('load:no') // 新建的会话，不是加载回来的
  expect(prompt).toContain('>> 回显提示词 进程退出 第一问')
  expect(prompt).toContain(`过程 page:${runPage}（共 1 步）`)
  expect(prompt).toContain('[Ramet 续跑] 上一次执行中途断开了')
  // 半截正文不当成答案发回去（它在过程里留着）
  expect(prompt).not.toContain('退出前')
  const merged = await runRecord(runPage)
  expect(says(merged.entries)).toEqual(['退出前'])
  // 兜底新建的会话也记成这一页这个 agent 的会话，看到的是这块回复
  expect((await agentSession(c.pageId))!.noload).toMatchObject({ sessionId: merged.sessionId, seen: failed!.id })
  stop(c)
})

test('入口校验：不是最后一块 / 没有失败或停止 → 409 not-resumable；找不到回复 404；页面忙 409', async () => {
  const c = await start()
  await turn(c, '中途断开 第一问', 1)
  await turn(c, '第二问', 2)
  const [first, second] = replyBlocks(c.a)
  expect(first!.outcome).toBe('error')
  expect(second!.outcome).toBe('end')

  const notLast = await resume(c.pageId, c.cookie, first!.id)
  expect(notLast.status).toBe(409)
  expect(await errorCode(notLast)).toBe('not-resumable')
  const ended = await resume(c.pageId, c.cookie, second!.id)
  expect(ended.status).toBe(409)
  expect(await errorCode(ended)).toBe('not-resumable')
  expect((await resume(c.pageId, c.cookie, 'nope')).status).toBe(404)

  // 重新生成照旧能对不是最后一块的失败回复用
  expect((await postJson(`/api/pages/${c.pageId}/replies/${first!.id}/regenerate`, c.cookie)).status).toBe(202)
  await settled(c.sse, 3)

  // 页面忙：跑着新一轮时（这块已不是最后一块）也先报 busy，不是 not-resumable
  userMessage(c.a.document, '慢慢来')
  expect(await continuePage(c.pageId, c.cookie, { agent: 'fake' })).toBe(202)
  await c.sse.wait((e) => e.type === 'reply' && e.d.includes('piece0'))
  const busy = await resume(c.pageId, c.cookie, second!.id)
  expect(busy.status).toBe(409)
  expect(await errorCode(busy)).toBe('busy')
  expect((await postJson(`/api/pages/${c.pageId}/stop`, c.cookie)).status).toBe(200)
  await settled(c.sse, 4)
  stop(c)
})
