/* ---------- 原生会话优先（真库 + 本机 / connector 上的假 agent）----------
 * 同一个 agent 在同一页一直接着它自己的会话：会话记录记着它看到哪一块（seen = 那一轮的回复块 id），下一轮只发那块之后
 * 新增的内容（带署名）+ 新消息。文档前面的改动、过程页步骤、失败的一轮、记住的那块被删都不让会话作废；
 * 换工作区 / 档位、重新生成才新建会话全文重放（全文里每条回复带一行一步的过程摘要）。
 * 「回显提示词」= 假 agent 把收到的提示词原样回成一个代码块，回复块的文字就是 agent 收到的提示词。 */
import { expect, test } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { promptHash } from './prompt-env.js'
import {
  agentSession,
  base,
  connectDoc,
  continuePage,
  docText,
  editFirstUserMessage,
  grantMachine,
  joinPageSpace,
  pageOwnership,
  pool,
  replyAttr,
  replyBlocks,
  settled,
  setupPage,
  SSECollector,
  startConnector,
  userIdOf,
  userMessage,
  waitFor,
} from './test-kit.js'

type Ctx = { cookie: string; pageId: string; a: HocuspocusProvider; sse: SSECollector; n: number }

async function start(): Promise<Ctx> {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  return { cookie, pageId, a, sse, n: 0 }
}

/** 发一条消息跑一轮，返回这一轮回复块的文字（回显提示词时就是 agent 收到的提示词） */
async function turn(c: Ctx, text: string, agent = 'fake', attrs: Record<string, string> = {}, cookie = c.cookie): Promise<string> {
  userMessage(c.a.document, text, attrs)
  expect(await continuePage(c.pageId, cookie, { agent })).toBe(202)
  const n = ++c.n
  await settled(c.sse, n)
  await waitFor(() => (replyBlocks(c.a)[n - 1]?.outcome ?? 'run') !== 'run')
  return replyBlocks(c.a)[n - 1]!.text
}

const session = async (pageId: string, agent = 'fake') => (await agentSession(pageId))?.[agent]

function stop(c: Ctx): void {
  c.sse.stop()
  c.a.destroy()
}

async function setWorkspace(c: Ctx, cwd: string, agent = 'fake'): Promise<void> {
  const res = await fetch(`${base}/api/pages/${c.pageId}/agent-cwd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: c.cookie },
    body: JSON.stringify({ agent, cwd }),
  })
  expect(res.status).toBe(200)
}

/** 新连一个客户端，等服务端的文档满足条件（确认改动已经到了中心） */
async function serverHas(pageId: string, cookie: string, pred: (frag: Y.XmlFragment) => boolean): Promise<void> {
  await waitFor(async () => {
    const check = await connectDoc(pageId, cookie)
    const ok = pred(check.document.getXmlFragment('prosemirror'))
    check.destroy()
    return ok
  })
}

function count(frag: Y.XmlFragment, name: string): number {
  let n = 0
  frag.forEach((c) => {
    if (c instanceof Y.XmlElement && c.nodeName === name) n++
  })
  return n
}

test('会话记录：seen = 这一轮的回复块 id，新写入不再带 lastSyncedHash', async () => {
  const c = await start()
  await turn(c, '第一问')
  const saved = await session(c.pageId)
  expect(saved?.seen).toBe(replyBlocks(c.a)[0]!.id)
  expect(saved?.lastSyncedHash).toBeUndefined()
  stop(c)
})

test('新建会话的全文重放带每条回复的过程摘要（用工具 → 换工作区 → 回显提示词）', async () => {
  const c = await start()
  await turn(c, '用工具查一下')
  const runPageId = replyAttr(c.a, 'run')
  expect(runPageId).toBeTruthy()
  const first = (await session(c.pageId))!.sessionId
  // 触发词留在全文重放里会让假 agent 再跑一遍工具：先把它改掉（改旧消息本身不影响会话）
  editFirstUserMessage(c.a.document, '查一下')
  await setWorkspace(c, await mkdtemp(join(tmpdir(), 'ramet-native-')))
  const prompt = await turn(c, '回显提示词 刚才查了什么')
  expect((await session(c.pageId))!.sessionId).not.toBe(first)
  expect(prompt).toMatch(new RegExp(`> 过程 page:${runPageId}（共 \\d+ 步）：`))
  expect(prompt).toContain('> - 读取 packages/server/src/agents/acp.ts') // codex 的读文件步骤以路径作标题
  expect(prompt).toContain('> - 执行 跑测试')
  expect(prompt).toContain('>> 查一下')
  stop(c)
})

test('在过程页删一步再发：会话 id 不变，只发了新消息', async () => {
  const c = await start()
  await turn(c, '用工具查一下')
  const first = (await session(c.pageId))!.sessionId
  const runPageId = replyAttr(c.a, 'run')!
  const runDoc = await connectDoc(runPageId, c.cookie)
  const body = runDoc.document.getXmlFragment('prosemirror')
  const steps = count(body, 'run_step')
  expect(steps).toBeGreaterThan(1)
  let at = -1
  body.forEach((n, i) => {
    if (at < 0 && n instanceof Y.XmlElement && n.nodeName === 'run_step') at = i
  })
  body.delete(at, 1)
  await serverHas(runPageId, c.cookie, (f) => count(f, 'run_step') === steps - 1)
  runDoc.destroy()

  expect(await turn(c, '回显提示词 第二问')).toBe('回显提示词 第二问')
  expect((await session(c.pageId))!.sessionId).toBe(first)
  stop(c)
})

test('一轮失败后发新消息：会话 id 不变，只发了新消息', async () => {
  const c = await start()
  await turn(c, '第一问')
  const first = (await session(c.pageId))!.sessionId
  await turn(c, '这一轮会失败')
  expect(replyBlocks(c.a)[1]!.outcome).toBe('error')
  expect((await session(c.pageId))?.seen).toBe(replyBlocks(c.a)[1]!.id)
  expect(await turn(c, '回显提示词 第三问')).toBe('回显提示词 第三问')
  expect((await session(c.pageId))!.sessionId).toBe(first)
  stop(c)
})

test('记住的那块被删了：会话 id 不变，只发最后一条用户消息', async () => {
  const c = await start()
  await turn(c, '第一问')
  const first = (await session(c.pageId))!.sessionId
  const frag = c.a.document.getXmlFragment('prosemirror')
  let at = -1
  frag.forEach((n, i) => {
    if (n instanceof Y.XmlElement && n.nodeName === 'agent_reply') at = i
  })
  frag.delete(at, 1)
  await serverHas(c.pageId, c.cookie, (f) => count(f, 'agent_reply') === 0)
  // 回复块少了一块：这里按「第一块回复」取，不走 turn() 的计数
  userMessage(c.a.document, '回显提示词 第二问')
  expect(await continuePage(c.pageId, c.cookie, { agent: 'fake' })).toBe(202)
  await settled(c.sse, 2)
  await waitFor(() => replyBlocks(c.a)[0]?.outcome === 'end')
  expect(replyBlocks(c.a)[0]!.text).toBe('回显提示词 第二问')
  expect((await session(c.pageId))!.sessionId).toBe(first)
  stop(c)
})

/** 把会话记录改写成老格式：去掉 seen，只留 lastSyncedHash */
async function legacyRecord(pageId: string, hash: string): Promise<void> {
  const saved = (await session(pageId))!
  const { seen: _seen, ...rest } = saved
  await pool.query(
    `UPDATE pages SET agent_session = jsonb_set(agent_session, '{sessions,fake}', $2::jsonb) WHERE id = $1`,
    [pageId, JSON.stringify({ ...rest, lastSyncedHash: hash })],
  )
}

test('老会话记录（只有 hash）：相等走增量并补记 seen', async () => {
  const c = await start()
  await turn(c, '第一问')
  const first = (await session(c.pageId))!.sessionId
  // 老算法的收尾 hash = 页首到上一轮回复（含）的视图；没有记忆、没有过程步骤时就是 sha256(整页)
  await legacyRecord(c.pageId, promptHash('', docText(c.a)))
  expect(await turn(c, '回显提示词 第二问')).toBe('回显提示词 第二问')
  const saved = (await session(c.pageId))!
  expect(saved.sessionId).toBe(first)
  expect(saved.seen).toBe(replyBlocks(c.a)[1]!.id)
  expect(saved.lastSyncedHash).toBeUndefined()
  stop(c)
})

test('老会话记录（只有 hash）：不等就全文重放一次（新会话）', async () => {
  const c = await start()
  await turn(c, '第一问')
  const first = (await session(c.pageId))!.sessionId
  await legacyRecord(c.pageId, 'stale')
  const prompt = await turn(c, '回显提示词 第二问')
  expect(prompt).toContain('>> 第一问')
  expect(prompt).toContain('>> 回显提示词 第二问')
  const saved = (await session(c.pageId))!
  expect(saved.sessionId).not.toBe(first)
  expect(saved.seen).toBe(replyBlocks(c.a)[1]!.id)
  stop(c)
})

// 同一个人换机器会把会话搬过去（session-move*.test.ts）；这里 Y 上是另一个人发起的一轮：会话记录不是他的，不搬，Y 自己新建会话
test('同一工具两台机器 X → Y → X：Y 上是别人的一轮，回到 X 时 X 的会话 id 不变，收到 Y 那一轮（带署名）+ 新消息', async () => {
  const c = await start()
  const { spaceId, ownerId } = await pageOwnership(c.pageId)
  const boxA = await startConnector({ spaceId, ownerId, name: 'boxa', cookie: c.cookie })
  const boxB = await startConnector({ spaceId, ownerId, name: 'boxb', cookie: c.cookie })
  const x = `c:${boxA}:fake`
  const y = `c:${boxB}:fake`
  const bob = await joinPageSpace(c.pageId, 'bob', { role: 'member' })
  const bobId = await userIdOf('bob')
  await grantMachine(boxB, bobId)

  await turn(c, '第一问', x)
  const xSession = (await session(c.pageId, x))!.sessionId
  const yReply = await turn(c, '在 Y 上问', y, { author: bobId }, bob)
  expect(yReply).toContain('turn:full')
  expect((await session(c.pageId, y))!.sessionId).not.toBe(xSession)

  const prompt = await turn(c, '回显提示词 回到 X', x)
  expect((await session(c.pageId, x))!.sessionId).toBe(xSession)
  expect(prompt.startsWith('<ramet-catch-up>\n你上次回复之后，对话里新增了下面这些内容（来自共享文档，不是你说的，也不一定是当前用户说的）：\n\n')).toBe(true)
  expect(prompt).toContain('[bob 的消息]\n>> 在 Y 上问')
  expect(prompt).toContain(`[Fake（boxb）的回复]\n> ${yReply.split('\n')[0]}`)
  expect(prompt.endsWith('</ramet-catch-up>\n\n回显提示词 回到 X')).toBe(true)
  expect(prompt).not.toContain('第一问') // X 自己看过的不再发
  stop(c)
}, 60_000)
