/* ---------- agent 核心链路集成测试（假 ACP agent） ----------
 * fake-agent.mjs 是说最小 ACP 协议的子进程，行为由 prompt 文本驱动（触发词见它的文件头）。 */

import { expect, test } from 'vitest'
import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { applyRunEvent, entrySid, mergeStep, type RunEntry, type RunState, type Step } from '@ramet/shared/run-model'
import { serializeDoc } from './agents/doc.js'
import { reapUnreferencedRuns } from './agents/reap-runs.js'
import type { AgentEvent } from './agents/types.js'
import { loadDocFromDb } from './collab.js'
import { textOf } from './updates.js'
import {
  agentSession,
  base,
  connectDoc,
  continuePage,
  docText,
  editFirstUserMessage,
  insertUser,
  login,
  pool,
  postJson,
  replyAgent,
  replyAttr,
  setupPage,
  SSECollector,
  userMessage,
  waitFor,
} from './agents/test-kit.js'


test('continue:流式追加进文档(双客户端可见),done 更新 agent_session;再 continue 走增量同 session', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  const b = await connectDoc(pageId, cookie)
  userMessage(a.document, '第一问')
  const sse = new SSECollector()
  await sse.start(pageId, cookie)

  expect(await continuePage(pageId, cookie)).toBe(202)
  await sse.wait((ev) => ev.type === 'status' && ev.state === 'done')
  sse.stop()

  // 回复以 agent_reply 块追加(提示词里仍是 '> ' 行),双客户端都可见
  const textA = docText(a)
  expect(textA).toContain('> turn:full')
  expect(docText(b)).toContain('> turn:full')
  expect(replyAgent(a)).toBe('fake') // AI 块带产出者 id(前端据它渲染 icon/名字)

  const sess = await agentSession(pageId)
  expect(sess?.fake?.sessionId).toMatch(/^sess-\d+$/)
  expect(sess?.fake?.lastSyncedHash).toBeTruthy()

  // 不编辑,再 continue:hash 相等 → session/load + 增量(假 agent 回 delta),sessionId 不变
  const sse2 = new SSECollector()
  await sse2.start(pageId, cookie)
  userMessage(a.document, '第二问')
  expect(await continuePage(pageId, cookie)).toBe(202)
  await sse2.wait((ev) => ev.type === 'status' && ev.state === 'done')
  sse2.stop()
  expect(docText(a)).toContain('> turn:delta')
  expect((await agentSession(pageId))?.fake?.sessionId).toBe(sess?.fake?.sessionId)

  a.destroy()
  b.destroy()
})

test('@/[[ 引用不整页粘贴:提示词里只有文本块,引用页正文不再作为 resource 块塞进 prompt', async () => {
  const { cookie, pageId } = await setupPage()
  // 引用页：标题能被 @ 语法命中，正文含一段可辨识文字（整页粘贴会把它贴进 prompt）
  const ref = await (await fetch(`${base}/api/pages`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}',
  })).json() as { id: string }
  await fetch(`${base}/api/pages/${ref.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ title: '被引用页' }),
  })
  // 直接写好正文索引：整页粘贴按 title 命中后贴的就是 content_text，保证该路径若还在必会命中
  await pool.query('UPDATE pages SET content_text = $2 WHERE id = $1', [ref.id, '整页正文不该出现'])

  const a = await connectDoc(pageId, cookie)
  // @标题 / [[标题]] 两种触发语法都给上
  userMessage(a.document, '@被引用页 和 [[被引用页]] 然后报引用')
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  expect(await continuePage(pageId, cookie)).toBe(202)
  await sse.wait((ev) => ev.type === 'status' && ev.state === 'done')
  sse.stop()

  expect(docText(a)).toContain('> res:0') // 没有 resource 块，说明不会整页粘贴
  expect(docText(a)).not.toContain('整页正文不该出现')

  a.destroy()
})

test('编辑后 continue:hash 失配 → 新 session 全文重放', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '第一问')
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  await continuePage(pageId, cookie)
  await sse.wait((ev) => ev.type === 'status' && ev.state === 'done')
  const first = (await agentSession(pageId))?.fake?.sessionId

  userMessage(a.document, '第二问')
  editFirstUserMessage(a.document, '第一问(改)')
  await continuePage(pageId, cookie)
  await sse.wait(() => {
    // 第一轮 done 已收过;等第二个 done(status done 出现两次)
    const dones = sse.events.filter((e) => e.type === 'status' && e.state === 'done')
    return dones.length >= 2
  })
  sse.stop()

  const second = (await agentSession(pageId))?.fake?.sessionId
  expect(second).not.toBe(first)
  // 全文重放包含两问文本 → 假 agent 判 full
  expect(docText(a)).toContain('> turn:full')
  expect(docText(a)).toContain('第一问(改)')
  a.destroy()
})

test('permission:SSE 收到审批请求(带 agentId),POST 应答后 agent 收到结果,resolved 广播移除', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '请写文件,需要权限')
  const sse = new SSECollector()
  await sse.start(pageId, cookie)

  await continuePage(pageId, cookie)
  const perm = await sse.wait((ev) => ev.type === 'permission')
  if (perm.type !== 'permission') throw new Error('不是审批事件')
  expect(perm.options.some((o) => o.optionId === 'allow_once')).toBe(true)
  expect(perm.agentId).toBe('fake')
  // 没带 agentId：400（requestId 只在单个进程内唯一，必须带 agent 才认得出是哪一条）
  expect((await postJson(`/api/pages/${pageId}/permission`, cookie, { requestId: perm.requestId, optionId: 'allow_once' })).status).toBe(400)
  // 审批应答后 agent 收到结果,回显 granted:<optionId>
  const res = await postJson(`/api/pages/${pageId}/permission`, cookie, {
    agentId: perm.agentId,
    requestId: perm.requestId,
    optionId: 'allow_once',
  })
  expect(res.status).toBe(200)
  await sse.wait((ev) => ev.type === 'permission_resolved' && ev.requestId === perm.requestId && ev.agentId === 'fake')
  await sse.wait((ev) => ev.type === 'status' && ev.state === 'done')
  sse.stop()
  await waitFor(() => docText(a).includes('> granted:allow_once'))
  // 已经结束的审批再答：404
  expect((await postJson(`/api/pages/${pageId}/permission`, cookie, { agentId: 'fake', requestId: perm.requestId, optionId: 'allow_once' })).status).toBe(404)
  a.destroy()
})

test('stop:生成中途取消,agent 以 cancelled 收尾,锁释放', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '慢慢来')
  const sse = new SSECollector()
  await sse.start(pageId, cookie)

  await continuePage(pageId, cookie)
  // 等第一片输出推到前端再停(运行中正文只走 SSE,不进文档)
  await sse.wait((ev) => ev.type === 'reply' && ev.d.includes('piece0'))
  expect(docText(a)).not.toContain('piece0')
  expect(await (await fetch(`${base}/api/pages/${pageId}/stop`, { method: 'POST', headers: { cookie } })).status).toBe(200)
  await sse.wait((ev) => ev.type === 'status' && ev.state === 'done', 10_000)
  // 停止也收尾:已说的那段落进文档
  await waitFor(() => docText(a).includes('piece0'))
  expect(docText(a)).not.toContain('piece9')

  // 互斥锁已释放:可以再次 continue
  userMessage(a.document, '第二问')
  expect(await continuePage(pageId, cookie)).toBe(202)
  await sse.wait(() => {
    const dones = sse.events.filter((e) => e.type === 'status' && e.state === 'done')
    return dones.length >= 2
  }, 15_000)
  sse.stop()
  a.destroy()
})

test('互斥:生成中第二个 continue 409;未配置 agent 400;事件流初始状态', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '慢慢来')
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  await continuePage(pageId, cookie)
  await sse.wait((ev) => ev.type === 'reply' && ev.d.includes('piece0'))
  expect(await continuePage(pageId, cookie)).toBe(409)

  const agents = await (await fetch(`${base}/api/agents`, { headers: { cookie } })).json()
  expect(Array.isArray(agents) && agents[0].id === 'fake').toBe(true)

  await fetch(`${base}/api/pages/${pageId}/stop`, { method: 'POST', headers: { cookie } })
  await sse.wait((ev) => ev.type === 'status' && ev.state === 'done', 10_000)
  sse.stop()
  a.destroy()
})

// ---------- session config options ----------

async function prepareAgent(pageId: string, cookie: string, agent: string): Promise<number> {
  const res = await fetch(`${base}/api/pages/${pageId}/agent-prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ agent }),
  })
  return res.status
}

async function postConfig(pageId: string, cookie: string, body: Record<string, unknown>): Promise<{ status: number; json: { options?: Array<{ id: string; category?: string | null; currentValue: string }>; message?: string } }> {
  const res = await fetch(`${base}/api/pages/${pageId}/agent-config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as { options?: Array<{ id: string; category?: string | null; currentValue: string }>; message?: string } }
}

test('config:continue 后 SSE 收到 config 事件(model+thinking)', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '第一问')
  const sse = new SSECollector()
  await sse.start(pageId, cookie)

  await continuePage(pageId, cookie)
  const ev = await sse.wait((e) => e.type === 'config')
  sse.stop()
  expect(ev.type === 'config' && ev.agentId === 'fake').toBe(true)
  if (ev.type !== 'config') return
  const model = ev.options.find((o) => o.id === 'model')
  const thinking = ev.options.find((o) => o.id === 'thinking')
  expect(model?.category).toBe('model')
  expect(model?.currentValue).toBe('m1')
  expect(model?.options.map((v) => v.value)).toEqual(['m1', 'm2'])
  expect(thinking?.category).toBe('thought_level')
  expect(thinking?.currentValue).toBe('low')
  a.destroy()
})

test('config:POST agent-config 改模型;未知 configId 400', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '第一问')
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  await continuePage(pageId, cookie)
  await sse.wait((ev) => ev.type === 'status' && ev.state === 'done')

  const r = await postConfig(pageId, cookie, { agent: 'fake', configId: 'model', value: 'm2' })
  expect(r.status).toBe(200)
  expect(r.json.options?.find((o) => o.id === 'model')?.currentValue).toBe('m2')

  const bad = await postConfig(pageId, cookie, { agent: 'fake', configId: 'nope', value: 'x' })
  expect(bad.status).toBe(400)
  expect(bad.json.message).toBeTruthy()

  const unknown = await postConfig(pageId, cookie, { agent: 'ghost', configId: 'model', value: 'm2' })
  expect(unknown.status).toBe(400)

  // 改配置事件也经 SSE 广播
  await sse.wait((ev) => ev.type === 'config' && ev.options.find((o) => o.id === 'model')?.currentValue === 'm2')
  sse.stop()
  a.destroy()
})

test('config:改配置后同 session 继续,agent 输出新值', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '第一问')
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  await continuePage(pageId, cookie)
  await sse.wait((ev) => ev.type === 'status' && ev.state === 'done')
  const first = (await agentSession(pageId))?.fake?.sessionId

  expect((await postConfig(pageId, cookie, { agent: 'fake', configId: 'model', value: 'm2' })).status).toBe(200)

  userMessage(a.document, '第二问')
  await continuePage(pageId, cookie)
  await sse.wait(() => sse.events.filter((e) => e.type === 'status' && e.state === 'done').length >= 2)
  sse.stop()
  // 同一 session(增量),但输出带上新模型值
  expect((await agentSession(pageId))?.fake?.sessionId).toBe(first)
  await waitFor(() => docText(a).includes('> turn:delta model=m2'))
  a.destroy()
})

test('config:编辑后新 session 全文重放,配置持久化仍生效', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '第一问')
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  await continuePage(pageId, cookie)
  await sse.wait((ev) => ev.type === 'status' && ev.state === 'done')

  expect((await postConfig(pageId, cookie, { agent: 'fake', configId: 'thinking', value: 'high' })).status).toBe(200)

  userMessage(a.document, '第二问')
  editFirstUserMessage(a.document, '第一问(改)')
  await continuePage(pageId, cookie)
  await sse.wait(() => sse.events.filter((e) => e.type === 'status' && e.state === 'done').length >= 2)
  sse.stop()
  // 新 session 全文重放,但 agent 拿到的 thinking 仍是持久化的 high
  await waitFor(() => {
    const t = docText(a)
    return t.includes('> turn:full') && t.includes('thinking=high')
  })
  a.destroy()
})

test('config:从未跑过 agent 的页面 POST agent-config 409', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '第一问')
  const r = await postConfig(pageId, cookie, { agent: 'fake', configId: 'model', value: 'm2' })
  expect(r.status).toBe(409)
  a.destroy()
})

test('prepare:选 agent 即建会话并推配置项;会话被首次生成复用(不留孤儿),准备期改的配置也生效', async () => {
  const { cookie, pageId } = await setupPage()
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  expect(await prepareAgent(pageId, cookie, 'fake')).toBe(202)
  const ev = await sse.wait((e) => e.type === 'config')
  if (ev.type !== 'config') return
  expect(ev.agentId).toBe('fake')
  expect(ev.options.find((o) => o.id === 'model')?.currentValue).toBe('m1')
  const prepared = await agentSession(pageId)
  expect(prepared?.fake?.lastSyncedHash).toBeNull() // 准备会话:建了但没喂过文档
  const preparedId = prepared!.fake!.sessionId

  // 再选一次不会另建会话(准备会话可重复消费)
  expect(await prepareAgent(pageId, cookie, 'fake')).toBe(202)
  expect((await agentSession(pageId))?.fake?.sessionId).toBe(preparedId)

  // 还没跑过也能改配置(有会话了)
  const cfg = await postConfig(pageId, cookie, { agent: 'fake', configId: 'model', value: 'm2' })
  expect(cfg.status).toBe(200)
  expect(cfg.json.options?.find((o) => o.id === 'model')?.currentValue).toBe('m2')

  // 第一次生成复用准备会话(不是新建),并且因为还没喂过文档而走全文重放
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '第一问')
  await continuePage(pageId, cookie)
  await waitFor(() => docText(a).includes('turn:full'))
  sse.stop()
  expect(docText(a)).toContain('model=m2') // 准备阶段改的配置在这次生成里生效
  expect((await agentSession(pageId))?.fake?.sessionId).toBe(preparedId)
  a.destroy()
})

test('prepare:未知 agent 400;非成员 404', async () => {
  const { cookie, pageId } = await setupPage()
  expect(await prepareAgent(pageId, cookie, 'nope')).toBe(400)
  await insertUser('bob')
  const otherCookie = await login('bob')
  expect(await prepareAgent(pageId, otherCookie, 'fake')).toBe(404)
})

/* ---------- 工具调用过程：实时事件 + 归档为过程页 ---------- */

/** SSE 里收到的过程事件（成品 step；合并已在服务端完成） */
function stepEvents(events: AgentEvent[]): Array<Extract<AgentEvent, { type: 'step' }>> {
  return events.filter((e): e is Extract<AgentEvent, { type: 'step' }> => e.type === 'step')
}

test('过程:步骤逐步到达且增量合并保留原字段;结束归档为 kind=run 子页并写进回复块 run 属性', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '用工具查一下')

  // 第二个订阅在中途接上:快照必须带已收集的步骤(离开/刷新回来重建面板的依据)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  expect(await continuePage(pageId, cookie)).toBe(202)
  await sse.wait((e) => e.type === 'step')
  const late = new SSECollector()
  await late.start(pageId, cookie)
  const snapshot = await late.wait((e) => e.type === 'run')
  if (snapshot.type === 'run') {
    const tools = snapshot.state.entries.filter((e) => e.k === 'tool')
    expect(tools.map((s) => s.k === 'tool' && s.id)).toContain('call-1')
    expect(tools.find((s) => s.k === 'tool' && s.id === 'call-1')).toMatchObject({ kind: 'read' })
  }

  const done = await sse.wait((e) => e.type === 'status' && e.state === 'done')
  sse.stop()
  late.stop()

  // 合并：只有 status 的 tool_call_update 不能把 kind/title/detail/原始载荷抹成默认值，状态只前进。
  // step 事件是增量（StepDelta），用共享的 applyRunEvent 逐条重放，不另写合并逻辑
  const replay: RunState = { entries: [], text: '', textAt: null, textEnd: null, textSlot: null, thoughtChars: 0 }
  for (const e of stepEvents(sse.events)) applyRunEvent(replay, e)
  const tool = (id: string): Step | undefined => {
    const hit = replay.entries.find((x) => x.k === 'tool' && x.id === id)
    return hit?.k === 'tool' ? hit : undefined
  }
  expect(tool('call-1')).toMatchObject({
    id: 'call-1',
    kind: 'read',
    title: '读 acp.ts',
    status: 'completed',
    detail: 'packages/server/src/agents/acp.ts',
  })
  expect(tool('call-1')!.acp).toMatchObject({ locations: [{ path: 'packages/server/src/agents/acp.ts' }] })
  expect(tool('call-2')).toMatchObject({ kind: 'execute', status: 'completed' })
  // 增量合并本身也验一次共享 mergeStep:acp 显式 [] 覆盖对应键
  expect(mergeStep(tool('call-1'), { id: 'call-1', acp: { locations: [] } })!.acp).toMatchObject({ locations: [] })

  // 归档:run 结束事件带过程页 id;库里多出一个挂在本文档下的 kind='run' 页面,内容就是这轮步骤
  const runPageId = done.type === 'status' ? done.runPageId : undefined
  expect(runPageId).toBeTruthy()
  const { rows } = await pool.query<{ kind: string; parent_id: string; space_id: string; title: string }>(
    'SELECT kind, parent_id, space_id, title FROM pages WHERE id = $1',
    [runPageId],
  )
  expect(rows[0]).toMatchObject({ kind: 'run', parent_id: pageId })
  expect(rows[0]!.title.startsWith('过程 · ')).toBe(true)
  // record 仍是这一轮的事实;正文是协同文档,打开就能改
  const run = (await pool.query<{ record: { outcome: string; entries: Array<Record<string, unknown>> } }>(
    'SELECT record FROM runs WHERE page_id = $1',
    [runPageId],
  )).rows[0]!.record
  expect(run.outcome).toBe('end')
  expect(run.entries.filter((e) => e.k === 'tool').map((e) => [e.kind, e.title, e.status])).toEqual([
    ['read', '读 acp.ts', 'completed'],
    ['execute', '跑测试', 'completed'],
  ])
  // 步骤是正文里的块：每步一个 run_step、带块 id，sid 与 record 的条目一一对上；末尾留一个空段落给用户笔记。
  // 详情（工具输入输出）只在 record，块里只有这一行的字
  const seededDoc = await loadDocFromDb(pool, `page:${runPageId}`)
  const seededBody = seededDoc.getXmlFragment('prosemirror')
  const blocks: Y.XmlElement[] = []
  seededBody.forEach((c) => {
    if (c instanceof Y.XmlElement) blocks.push(c)
  })
  const stepEls = blocks.filter((b) => b.nodeName === 'run_step')
  expect(stepEls.map((b) => [b.getAttribute('k'), b.getAttribute('sid')])).toEqual(
    run.entries.map((e, i) => [e.k, entrySid(e as RunEntry, i)]),
  )
  expect(stepEls.every((b) => typeof b.getAttribute('id') === 'string' && b.getAttribute('id'))).toBe(true)
  const readStep = stepEls.find((b) => b.getAttribute('sid') === 'call-1')!
  expect(textOf(readStep)).toBe('读 acp.ts')
  expect(readStep.getAttribute('kind')).toBe('read')
  expect(readStep.getAttribute('status')).toBe('completed')
  const tail = blocks[blocks.length - 1]!
  expect(tail.nodeName).toBe('paragraph')
  expect(textOf(tail)).toBe('')
  expect(tail.getAttribute('id')).toBeTruthy()
  // 搜索索引 = 正文（步骤的字 + 笔记）+ 最终输出
  const indexed = await pool.query<{ content_text: string }>('SELECT content_text FROM pages WHERE id = $1', [runPageId])
  expect(indexed.rows[0]!.content_text).toContain('读 acp.ts')

  // 过程页一建出来就有一条 AI 的历史；父文档上这轮回复也记成这个 agent，不并进用户那 5 分钟
  const runSnap = await pool.query<{ actor: string; actor_agent: string | null }>(
    'SELECT actor, actor_agent FROM page_snapshots WHERE page_id = $1',
    [runPageId],
  )
  expect(runSnap.rows).toEqual([{ actor: 'agent', actor_agent: 'fake' }])
  const runFeed = (await (await fetch(`${base}/api/pages/${runPageId}/updates?limit=5`, { headers: { cookie } })).json()) as Array<{
    actor: string
    actor_agent: string | null
    summary: Array<{ kind: string; text: string }>
  }>
  expect(runFeed[0]).toMatchObject({ actor: 'agent', actor_agent: 'fake' })
  expect(runFeed[0]!.summary).toEqual([{ kind: 'create', text: '' }])
  await waitFor(async () => {
    const { rows } = await pool.query<{ actor_agent: string | null }>(
      "SELECT actor_agent FROM page_snapshots WHERE page_id = $1 AND actor = 'agent' ORDER BY created_at DESC LIMIT 1",
      [pageId],
    )
    return rows[0]?.actor_agent === 'fake'
  })

  const runDoc = await connectDoc(runPageId!, cookie)
  const note = new Y.XmlElement('paragraph')
  const body = runDoc.document.getXmlFragment('prosemirror')
  body.insert(body.length, [note])
  const noteText = new Y.XmlText()
  note.insert(0, [noteText])
  noteText.insert(0, '我补的一句')
  await waitFor(async () =>
    textOf((await loadDocFromDb(pool, `page:${runPageId}`)).getXmlFragment('prosemirror')).includes('我补的一句'),
  )
  runDoc.destroy()

  // 回复块上的 run 属性 = 前端「过程」入口(只进 attrs,不进 markdown/DOM/agent 上下文)
  await waitFor(() => replyAttr(a, 'run') !== null)
  expect(replyAttr(a, 'run')).toBe(runPageId)

  // 过程页自成一类:不可单独公开(身份由 kind 表达,DB 约束兜底)
  const publish = await fetch(`${base}/api/pages/${runPageId}/publish`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ published: true }),
  })
  expect(publish.status).toBe(400)

  // 搜索默认不搜过程页;显式 include=agent 才回来(标题里带「过程」)
  const searchDefault = await (
    await fetch(`${base}/api/search?q=${encodeURIComponent('过程')}`, { headers: { cookie } })
  ).json() as Array<{ id: string }>
  expect(searchDefault.some((h) => h.id === runPageId)).toBe(false)
  const searchAgent = await (
    await fetch(`${base}/api/search?q=${encodeURIComponent('过程')}&include=agent`, { headers: { cookie } })
  ).json() as Array<{ id: string }>
  expect(searchAgent.some((h) => h.id === runPageId)).toBe(true)

  // 公开:过程页跟着父文档的 publish_includes_runs 走,默认不外泄;勾上后匿名可读
  const setPublish = (body: Record<string, unknown>) =>
    fetch(`${base}/api/pages/${pageId}/publish`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    })
  expect((await setPublish({ published: true })).status).toBe(200)
  expect((await fetch(`${base}/api/public/pages/${runPageId}`)).status).toBe(404)
  const treeHidden = await (await fetch(`${base}/api/public/pages/${pageId}`)).json() as {
    children: Array<{ id: string }>
  }
  expect(treeHidden.children.some((c) => c.id === runPageId)).toBe(false)

  expect((await setPublish({ published: true, includeRuns: true })).status).toBe(200)
  expect((await fetch(`${base}/api/public/pages/${runPageId}`)).status).toBe(200)
  const treeShown = await (await fetch(`${base}/api/public/pages/${pageId}`)).json() as {
    children: Array<{ id: string }>
  }
  expect(treeShown.children.some((c) => c.id === runPageId)).toBe(true)
  const pub = (await (await fetch(`${base}/api/public/pages/${runPageId}/doc`)).json()) as {
    data?: string
    run?: { entries?: Array<{ title?: string }> }
  }
  expect(pub.run?.entries?.some((e) => e.title === '读 acp.ts')).toBe(true)
  const pubDoc = new Y.Doc()
  Y.applyUpdate(pubDoc, Buffer.from(pub.data ?? '', 'base64'))
  expect(textOf(pubDoc.getXmlFragment('prosemirror'))).toContain('我补的一句')
  // 步骤是正文里的真块，公开的过程页正文里就有它们；工具详情只在 record 里
  expect(textOf(pubDoc.getXmlFragment('prosemirror'))).toContain('读 acp.ts')

  // 回复还在：过程页留着。删掉 AI 块之后，挂在本文档下的过程页一起物理删除
  expect(await reapUnreferencedRuns(pool, pageId, a.document)).toEqual([])
  expect((await pool.query('SELECT 1 FROM pages WHERE id = $1', [runPageId])).rows.length).toBe(1)
  a.document.transact(() => {
    const frag = a.document.getXmlFragment('prosemirror')
    for (let i = frag.length - 1; i >= 0; i--) {
      const el = frag.get(i)
      if (el instanceof Y.XmlElement && el.nodeName === 'agent_reply') frag.delete(i, 1)
    }
  })
  expect(await reapUnreferencedRuns(pool, pageId, a.document)).toContain(runPageId)
  expect((await pool.query('SELECT 1 FROM pages WHERE id = $1', [runPageId])).rows.length).toBe(0)
  expect((await pool.query('SELECT 1 FROM runs WHERE page_id = $1', [runPageId])).rows.length).toBe(0)
  expect((await pool.query('SELECT 1 FROM yjs_updates WHERE doc_name = $1', [`page:${runPageId}`])).rows.length).toBe(0)

  a.destroy()
})

test('过程:一次工具调用都没有的纯文本回合也归档(最终回复有详情入口)', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '第一问')
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  await continuePage(pageId, cookie)
  const done = await sse.wait((e) => e.type === 'status' && e.state === 'done')
  sse.stop()

  // 没有工具/思考条目,但有最终回复 → 归档一份记录(output 保留全文),不产生「纯噪声」页
  expect(stepEvents(sse.events)).toEqual([])
  const runPageId = done.type === 'status' ? done.runPageId : undefined
  expect(runPageId).toBeTruthy()
  const { rows } = await pool.query<{ record: { output?: string; entries: unknown[] } }>('SELECT record FROM runs WHERE page_id = $1', [runPageId])
  expect(rows[0]!.record.entries).toEqual([])
  expect(rows[0]!.record.output).toContain('turn:full')
  await waitFor(() => docText(a).includes('turn:full'))
  expect(replyAttr(a, 'run')).toBe(runPageId)
  a.destroy()
})

/* ---------- AI 回复的 markdown → 块结构 ---------- */

/** 最后一个 agent_reply 块的子节点（Yjs 层直接看结构） */
function replyChildren(p: HocuspocusProvider): Y.XmlElement[] {
  const frag = p.document.getXmlFragment('prosemirror')
  const replies: Y.XmlElement[] = []
  frag.forEach((c) => {
    if (c instanceof Y.XmlElement && c.nodeName === 'agent_reply') replies.push(c)
  })
  const reply = replies.at(-1)
  if (!reply) throw new Error('没有 agent_reply 块')
  const out: Y.XmlElement[] = []
  reply.forEach((c) => {
    if (c instanceof Y.XmlElement) out.push(c)
  })
  return out
}

function yTextOf(node: Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) return node.toString()
  let s = ''
  node.forEach((c) => {
    s += yTextOf(c as Y.XmlElement | Y.XmlText)
  })
  return s
}

test('markdown 回复:轮次结束后重写成块结构(标题/单条目列表/行内 marks/代码块),且 hash 落在结构上', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '用 markdown 回我')
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  await continuePage(pageId, cookie)
  await sse.wait((ev) => ev.type === 'status' && ev.state === 'done')
  sse.stop()

  const blocks = replyChildren(a)
  expect(blocks.map((b) => b.nodeName)).toEqual([
    'heading', 'bullet_list', 'bullet_list', 'paragraph', 'paragraph', 'code_block',
  ])

  // 标题级别、列表形状（每个条目一个单条目 list —— 与前端顶层 list 不变式一致）
  expect(blocks[0]!.getAttribute('level')).toBe(1)
  expect(blocks[0]!.toArray().map((c) => yTextOf(c as Y.XmlElement)).join('')).toBe('标题')
  const items = blocks.slice(1, 3).map((list) => {
    expect(list.getAttribute('spread')).toBe(false)
    const item = list.get(0) as Y.XmlElement
    return { name: item.nodeName, label: item.getAttribute('label'), text: yTextOf(item) }
  })
  expect(items).toEqual([
    { name: 'list_item', label: '•', text: '第一项' },
    { name: 'list_item', label: '•', text: '第二项' },
  ])

  // 行内 marks：Yjs 侧是 Y.XmlText 的格式属性（y-prosemirror 的 marksToAttributes 形状）。
  // 每个「格式变化」是一段独立 Y.XmlText（前端 PM 会合并相邻同格式文本），所以按段落收集全部 delta
  const para = blocks[3]!
  const ops = para
    .toArray()
    .filter((c): c is Y.XmlText => c instanceof Y.XmlText)
    .flatMap((t) => t.toDelta() as Array<{ insert?: unknown; attributes?: Record<string, unknown> }>)
  expect(ops).toEqual([
    { insert: '加粗', attributes: { strong: { marker: '*' } } },
    { insert: '与' },
    { insert: '代码', attributes: { inlineCode: {} } },
  ])

  // 相邻两个链接必须各自带自己的 href（只看 mark 名字合并会把地址写错）
  const links = blocks[4]!
  const linkOps = links
    .toArray()
    .filter((c): c is Y.XmlText => c instanceof Y.XmlText)
    .flatMap((t) => t.toDelta() as Array<{ insert?: unknown; attributes?: Record<string, unknown> }>)
  expect(linkOps).toEqual([
    { insert: '甲', attributes: { link: { href: 'https://a.dev', title: null } } },
    { insert: '乙', attributes: { link: { href: 'https://b.dev', title: null } } },
  ])

  expect(blocks[5]!.getAttribute('language')).toBe('ts')
  expect(yTextOf(blocks[5]!)).toBe('const a = 1')

  // 提示词/搜索口径：语法字符被吃掉，行由 hardbreak 还原（'> ' 前缀逐行加）
  const docText = serializeDoc(a.document.getXmlFragment('prosemirror'))
  expect(docText).toContain('> # 标题')
  expect(docText).toContain('> - 第一项')
  expect(docText).toContain('> 加粗与代码')
  expect(docText).toContain('> 甲乙')
  expect(docText).toContain('> ```ts\n> const a = 1\n> ```')
  expect(docText).not.toContain('**加粗**')

  // 纯文本回复同样在收尾时按解析结果落块（只有段落）。
  // 先等新消息的 Yjs 增量到服务端再 continue：继续路由走 HTTP，与 ws 写入是两条通道，
  // 抢跑会让服务端读到旧文档（lastUserMessage 取错 → hash 失配走全文重放）
  userMessage(a.document, '第二问')
  await new Promise((r) => setTimeout(r, 300))
  const sse2 = new SSECollector()
  await sse2.start(pageId, cookie)
  await continuePage(pageId, cookie)
  await sse2.wait((ev) => ev.type === 'status' && ev.state === 'done')
  sse2.stop()
  const after = docTextOf(a)
  expect(after).toContain('turn:delta')
  const plain = replyChildren(a)
  expect(plain.length).toBeGreaterThan(0)
  expect(plain.every((b) => b.nodeName === 'paragraph')).toBe(true)
  // 增量轮：hash 落在重写后的结构上才对得上
  expect(yTextOf(plain[0]!)).toContain('turn:delta')
  a.destroy()
}, 20_000)

const docTextOf = (p: HocuspocusProvider) => serializeDoc(p.document.getXmlFragment('prosemirror'))

/* ---------- 工作区（cwd）覆盖 + 选择器的目录列举 ----------
 * 覆盖按 (页面, agent) 落库；改了工作区旧会话作废，下一轮新 session（全文重放）且 agent 收到新目录；
 * 恢复默认回落执行端默认。目录列举与工作区同源（都是执行端回答）。 */

async function setWorkspace(
  pageId: string,
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: { cwd?: string; message?: string } }> {
  const res = await fetch(`${base}/api/pages/${pageId}/agent-cwd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => ({}))) as { cwd?: string; message?: string } }
}

type ListedDirs = {
  path?: string
  parent?: string | null
  dirs?: Array<{ name: string; path: string }>
  truncated?: boolean
  message?: string
}

async function listDirs(pageId: string, cookie: string, agent: string, path?: string): Promise<{ status: number; json: ListedDirs }> {
  const qs = `agent=${encodeURIComponent(agent)}${path ? `&path=${encodeURIComponent(path)}` : ''}`
  const res = await fetch(`${base}/api/pages/${pageId}/agent-dirs?${qs}`, { headers: { cookie } })
  return { status: res.status, json: (await res.json().catch(() => ({}))) as ListedDirs }
}

async function workspaceOf(pageId: string, agentId: string): Promise<string | null> {
  const { rows } = await pool.query<{ agent_session: { workspaces?: Record<string, string> } | null }>(
    'SELECT agent_session FROM pages WHERE id = $1',
    [pageId],
  )
  return rows[0]?.agent_session?.workspaces?.[agentId] ?? null
}

test('工作区:指定目录 → 新会话在指定目录跑(agent 收到);恢复默认回落;目录列举同源', async () => {
  const { cookie, pageId } = await setupPage()
  const provider = await connectDoc(pageId, cookie)

  // 默认：第一轮跑在执行端默认目录(本机 agent = 中心进程 cwd)
  userMessage(provider.document, '报目录 一')
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  await waitFor(() => docText(provider).includes('turn:full'))
  expect(docText(provider)).toContain(`cwd:${process.cwd()}`)
  const firstSession = (await agentSession(pageId))!.fake!.sessionId

  // 指定工作区：只落"用户指定"这一层；目录存在与否由 agent 侧建会话时见分晓
  const dir = await mkdtemp(join(tmpdir(), 'ramet-ws-'))
  await mkdir(join(dir, 'sub-a'))
  const set = await setWorkspace(pageId, cookie, { agent: 'fake', cwd: dir })
  expect(set).toEqual({ status: 200, json: { cwd: dir } })
  expect(await workspaceOf(pageId, 'fake')).toBe(dir)

  // 下一轮：旧会话在别的目录 → 新 session + 全文重放，且 agent 真的收到新目录
  userMessage(provider.document, '报目录 二')
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  await waitFor(() => docText(provider).includes(`cwd:${dir}`))
  const second = (await agentSession(pageId))!.fake!
  expect(second.cwd).toBe(dir)
  expect(second.sessionId).not.toBe(firstSession)

  // 恢复默认：覆盖键删掉，再回到执行端默认(又是新会话——目录不同，旧会话不复用)
  expect(await setWorkspace(pageId, cookie, { agent: 'fake', cwd: '' })).toEqual({
    status: 200,
    json: { cwd: process.cwd() },
  })
  expect(await workspaceOf(pageId, 'fake')).toBeNull()
  userMessage(provider.document, '报目录 三')
  await continuePage(pageId, cookie, { agent: 'fake' })
  await waitFor(async () => (await agentSession(pageId))?.fake?.cwd === process.cwd())
  expect((await agentSession(pageId))!.fake!.sessionId).not.toBe(second.sessionId)

  // 选择器：列执行端真实目录（本机 agent = 中心进程所在机器），只回目录、带 parent
  const listed = await listDirs(pageId, cookie, 'fake', dir)
  expect(listed.status).toBe(200)
  expect(listed.json.path).toBe(dir)
  expect(listed.json.parent).toBe(dirname(dir))
  expect(listed.json.dirs).toEqual([{ name: 'sub-a', path: join(dir, 'sub-a') }])
  // 省略 path = 当前生效工作区（此刻已恢复默认）
  expect((await listDirs(pageId, cookie, 'fake')).json.path).toBe(await realpath(process.cwd()))
  provider.destroy()
})

test('工作区:未知 agent 400;非成员 404;坏路径列出可读原因', async () => {
  const { cookie, pageId } = await setupPage()
  expect((await setWorkspace(pageId, cookie, { agent: 'nope', cwd: '/tmp' })).status).toBe(400)
  expect((await setWorkspace(pageId, cookie, { agent: 'fake' })).status).toBe(400)
  await insertUser('carol')
  const otherCookie = await login('carol')
  expect((await setWorkspace(pageId, otherCookie, { agent: 'fake', cwd: '/tmp' })).status).toBe(404)
  expect((await listDirs(pageId, otherCookie, 'fake')).status).toBe(404)
  expect((await listDirs(pageId, cookie, 'nope')).status).toBe(400)
  const bad = await listDirs(pageId, cookie, 'fake', '/no-such-dir-ramet')
  expect(bad.status).toBe(400)
  expect(bad.json.message).toContain('不存在')
})

/* ---------- 消息级调用配置：值在 user_message 节点 attrs ----------
 * attrs.agent/cwd/opts 优先于页面级默认，只作用于它所在的那一轮（下一轮回落）。
 * 前端 chip 见 web/src/editor/message-chips.tsx。 */

test('消息配置:attrs 的 model/cwd 驱动本轮(agent 侧可观测),下一轮回落页面默认', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)

  // 不带 attrs 的第一轮：页面默认（cwd = 执行端默认，model = m1）
  userMessage(a.document, '报目录 第一问')
  await continuePage(pageId, cookie, { agent: 'fake' })
  await waitFor(() => docText(a).includes('> turn:full model=m1'))
  expect(docText(a)).toContain(`cwd:${process.cwd()}`)
  const firstSession = (await agentSession(pageId))!.fake!.sessionId

  // 第二条消息带 attrs：换目录并设 model=m2，本轮两者都必须生效
  const dir = await mkdtemp(join(tmpdir(), 'ramet-msg-'))
  userMessage(a.document, '报目录 第二问', { cwd: dir, opts: 'model=m2' })
  await continuePage(pageId, cookie, { agent: 'fake' })
  await waitFor(() => docText(a).includes(`cwd:${dir}`))
  await waitFor(() => docText(a).includes('model=m2'))
  // 换目录让旧会话作废（saved.cwd !== 生效 cwd）
  const second = (await agentSession(pageId))!.fake!
  expect(second.cwd).toBe(dir)
  expect(second.sessionId).not.toBe(firstSession)
  // 覆盖不落库：页面级 configs 没被这条消息写脏
  const { rows } = await pool.query<{ agent_session: { configs?: Record<string, Record<string, string>> } | null }>(
    'SELECT agent_session FROM pages WHERE id = $1', [pageId],
  )
  expect(rows[0]?.agent_session?.configs?.fake?.model ?? null).toBeNull()

  // 第三条消息不带 attrs：回落页面默认（目录不同，又是新会话）
  userMessage(a.document, '报目录 第三问')
  await continuePage(pageId, cookie, { agent: 'fake' })
  await waitFor(() => docText(a).includes(`cwd:${process.cwd()}`))
  await waitFor(() => docText(a).includes('model=m1'))
  sse.stop()
  a.destroy()
})

test('消息配置:attrs.agent 指定这一轮由谁跑;失效则回落到可用 agent(不静默跑错人)', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  // 请求体给 fake，消息 attrs 也写 fake（目录里只有 fake）：本轮仍由 fake 跑，reply 块归属是 fake
  userMessage(a.document, '第一问', { agent: 'fake' })
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  await waitFor(() => docText(a).includes('> turn:full'))
  expect(replyAgent(a)).toBe('fake')
  // 消息指定的 agent 失效（目录里没有）而请求体给了可用 agent：回落到请求体那个，不是 400
  userMessage(a.document, '第二问', { agent: 'ghost' })
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  await waitFor(() => docText(a).includes('> turn:delta'))
  expect(replyAgent(a)).toBe('fake') // 跑的是回落后的 fake，不是 ghost
  a.destroy()
})

test('消息配置:attrs 坏值(未知 config id / 空 opts)不影响整轮', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  // opts 里混一个 agent 不认的 id：跳过该条，其余照常（不该让整轮失败）
  userMessage(a.document, '第一问', { opts: 'nope=x;model=m2' })
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  await waitFor(() => docText(a).includes('> turn:full model=m2'))
  a.destroy()
})

/* ---------- 失效 agent 的收敛 ----------
 * 消息 attrs 里的 agent 失效（connector 被撤销 / 改名）时不能硬失败，否则这条消息永远发不出去且没有清除入口；
 * 按没指定回落，与前端 pickAgent 同口径。 */

test('消息配置:attrs 指向失效 agent 时回落(不 400),且不下发旧 agent 的 opts', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)

  userMessage(a.document, '报目录 第一问')
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  await waitFor(() => docText(a).includes('> turn:full'))

  // 模拟 connector 被撤销：attrs 指向不存在的 agent，并带一条属于它的 opts
  userMessage(a.document, '报目录 第二问', { agent: 'c:dead-connector:ghost', opts: 'model=m2' })
  // 请求体给了可用 agent，应回落到它而不是 400
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  // 回落生效：fake 跑起来了，且没有下发失效 agent 的 model=m2
  await waitFor(() => docText(a).includes(`cwd:${process.cwd()}`))
  expect(docText(a)).not.toContain('model=m2')
  a.destroy()
})

test('消息配置:attrs 失效且请求体也没给可用 agent 时,才 400', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '第一问', { agent: 'c:dead:ghost' })
  const res = await fetch(`${base}/api/pages/${pageId}/continue`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ agent: 'c:dead:ghost' }),
  })
  expect(res.status).toBe(400)
  a.destroy()
})
